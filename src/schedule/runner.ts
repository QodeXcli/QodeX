/**
 * Schedule runner — invoked by the launchd agent / cron line every minute via
 * `qodex schedule tick`. For each due schedule, spawn an isolated `qodex --print`
 * (headless) child so a hung agent can't block other schedules and so we get
 * process-level isolation.
 *
 * File-locking: we hold an exclusive lock on ~/.qodex/scheduler.lock for the
 * duration of the tick. If another tick is already running, we exit silently
 * (this is the common case when overlapping crons fire close together).
 */
import { spawn } from 'cross-spawn';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as fsSync from 'fs';
import { QODEX_HOME } from '../config/defaults.js';
import { getScheduleStore, type ScheduleEntry } from './store.js';
import { logger } from '../utils/logger.js';
import { notifyDesktop } from '../utils/notify.js';
import { buildRecipePrompt } from './recipes.js';
import { parseDeliveryTarget, formatRunSummary, deliverRun } from './delivery.js';

const LOCK_PATH = path.join(QODEX_HOME, 'scheduler.lock');
const RUN_LOG_DIR = path.join(QODEX_HOME, 'schedule-logs');

export interface TickResult {
  ranIds: string[];
  skipped: string[];
  failed: string[];
  acquired: boolean;
}

export async function tick(): Promise<TickResult> {
  await fs.mkdir(QODEX_HOME, { recursive: true });
  await fs.mkdir(RUN_LOG_DIR, { recursive: true });

  // Acquire exclusive lock via O_CREAT|O_EXCL. If it exists and is < 10 minutes
  // old we assume another tick is alive; otherwise it's stale and we steal it.
  let lockFd: fsSync.promises.FileHandle | null = null;
  try {
    lockFd = await fs.open(LOCK_PATH, 'wx');
  } catch (e: any) {
    if (e.code === 'EEXIST') {
      const stat = await fs.stat(LOCK_PATH).catch(() => null);
      const ageMs = stat ? Date.now() - stat.mtimeMs : Infinity;
      if (ageMs < 10 * 60 * 1000) {
        return { ranIds: [], skipped: [], failed: [], acquired: false };
      }
      // Stale — steal it
      try { await fs.unlink(LOCK_PATH); } catch {}
      lockFd = await fs.open(LOCK_PATH, 'wx').catch(() => null);
    }
  }
  if (!lockFd) {
    return { ranIds: [], skipped: [], failed: [], acquired: false };
  }
  await lockFd.writeFile(`pid=${process.pid}\nstarted=${new Date().toISOString()}\n`);

  const result: TickResult = { ranIds: [], skipped: [], failed: [], acquired: true };

  try {
    const store = getScheduleStore();
    const due = store.dueAsOf(new Date());

    for (const entry of due) {
      try {
        await runOne(entry);
        result.ranIds.push(entry.id);
      } catch (e: any) {
        logger.warn('schedule run failed', { id: entry.id, name: entry.name, err: e.message });
        result.failed.push(entry.id);
      }
    }
  } finally {
    try { await lockFd.close(); } catch {}
    try { await fs.unlink(LOCK_PATH); } catch {}
  }

  return result;
}

async function runOne(entry: ScheduleEntry): Promise<void> {
  const store = getScheduleStore();
  const startMs = Date.now();
  const runId = store.recordRunStart(entry.id);
  const logPath = path.join(RUN_LOG_DIR, `${entry.id}.${runId}.log`);
  const logStream = fsSync.createWriteStream(logPath, { flags: 'w' });
  logStream.write(`# schedule: ${entry.name} (${entry.id})\n# cron:     ${entry.cron}\n# cwd:      ${entry.cwd}\n# started:  ${new Date().toISOString()}\n# prompt:   ${entry.prompt.replace(/\n/g, '\n#           ')}\n\n`);

  // cwd must exist; otherwise mark errored and bail (no point retrying every minute)
  try {
    const st = fsSync.statSync(entry.cwd);
    if (!st.isDirectory()) throw new Error(`not a directory`);
  } catch (e: any) {
    const msg = `cwd invalid: ${entry.cwd} (${e.message})`;
    logStream.end(msg + '\n');
    store.recordRunFinish(runId, entry.id, 'error', 1, msg, Date.now() - startMs);
    return;
  }

  // Build child args: qodex --print <prompt> --yes [--model ...]
  // We use --yes so permission prompts auto-approve; without it the headless run
  // would deny everything and the schedule would be useless. A recipe (e.g. verified-pr)
  // wraps the goal in an unattended-safe protocol before it's fed to the agent.
  const runPrompt = buildRecipePrompt(entry.recipe, entry.prompt);
  const args: string[] = ['--print', runPrompt, '--yes'];
  if (entry.model) { args.push('--model', entry.model); }

  // Resolve the qodex CLI path. In production the user runs `npm link` so `qodex`
  // is on PATH; in dev we may need to point at bin/qodex.mjs directly.
  const cliPath = resolveCliPath();

  return new Promise<void>((resolve) => {
    const child = spawn(cliPath, args, {
      cwd: entry.cwd,
      env: { ...process.env, QODEX_SCHEDULED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout?.on('data', (d: Buffer) => { const s = d.toString(); output += s; logStream.write(s); });
    child.stderr?.on('data', (d: Buffer) => { const s = d.toString(); output += s; logStream.write(s); });

    const hardKill = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
    }, 30 * 60 * 1000); // 30 minute hard cap

    child.on('error', (e: any) => {
      clearTimeout(hardKill);
      const msg = `spawn failed: ${e.message}`;
      logStream.end('\n' + msg + '\n');
      store.recordRunFinish(runId, entry.id, 'error', 127, msg, Date.now() - startMs);
      resolve();
    });

    child.on('close', (code, signal) => {
      clearTimeout(hardKill);
      const exitCode = code ?? (signal ? 128 : 1);
      const status: 'success' | 'error' = exitCode === 0 ? 'success' : 'error';
      const tail = output.slice(-500).trim().replace(/\s+/g, ' ');
      logStream.end(`\n# finished: ${new Date().toISOString()} exit=${exitCode} (${status})\n`);
      store.recordRunFinish(runId, entry.id, status, exitCode, tail, Date.now() - startMs);
      // Let the user know a background task finished — they may have closed the
      // terminal. Fire-and-forget; a failed notification never affects the run.
      const secs = Math.round((Date.now() - startMs) / 1000);
      const notify = notifyDesktop({
        title: status === 'success' ? `✓ QodeX: ${entry.name}` : `✗ QodeX: ${entry.name}`,
        subtitle: status === 'success' ? `Done in ${secs}s` : `Failed (exit ${exitCode}) after ${secs}s`,
        message: tail ? tail.slice(0, 180) : (status === 'success' ? 'Task completed.' : 'Task failed — check the log.'),
        sound: true,
      });
      // Deliver the result to chat (Telegram/Discord) when the schedule asked for it —
      // this is what makes the scheduler "24/7 to your phone", not just a desktop ping.
      const target = parseDeliveryTarget(entry.deliver);
      const deliver = target
        ? deliverRun(target, formatRunSummary({ name: entry.name, status, exitCode, durationSec: secs, tail, recipe: entry.recipe }))
            .then(ok => { if (ok) logger.info('schedule result delivered', { id: entry.id, to: `${target.platform}:${target.chatId}` }); })
            .catch(() => {})
        : Promise.resolve();
      void Promise.allSettled([notify, deliver]).finally(() => resolve());
    });
  });
}

function resolveCliPath(): string {
  // Prefer the qodex binary on PATH (works after `npm link`).
  if (process.env.QODEX_CLI_PATH) return process.env.QODEX_CLI_PATH;
  // Fallback: resolve relative to this module so dev mode works.
  // dist/schedule/runner.js is the runtime path; bin/qodex.mjs is two levels up.
  // We don't try to spawn `node bin/qodex.mjs` from here — that's a dev concern,
  // and the launchd installer documents that production needs `npm link`.
  return 'qodex';
}
