/**
 * Schedule runner — invoked by the launchd agent / cron line every minute via
 * `qodex schedule tick`. For each due schedule, spawn an isolated child so a
 * hung agent can't block other schedules and so we get process-level isolation:
 *
 *   kind 'prompt'  → `qodex --print <prompt> --yes [--model m]` (headless one-shot;
 *                    a recipe such as verified-pr wraps the goal in an unattended-safe
 *                    protocol, and the child writes a ground-truth receipt)
 *   kind 'mission' → `qodex mission start --yes --cwd <cwd> -- <prompt>`, which
 *                    returns as soon as the detached mission worker is running;
 *                    the mission then plans, runs, asks for approvals and
 *                    notifies on its own (survives this tick).
 *
 * Children are started as `<node> <qodex entry> …` when this tick itself runs
 * from the qodex CLI, so they work without `qodex` on PATH (launchd's PATH is
 * minimal); QODEX_CLI_PATH overrides.
 *
 * File-locking: we hold an exclusive lock on ~/.qodex/scheduler.lock for the
 * duration of the tick. If another tick is already running, we exit silently
 * (this is the common case when overlapping crons fire close together). The lock
 * records our pid and is refreshed every minute; it is only stolen when its
 * holder is dead or it went unrefreshed longer than one run may take (the hard
 * kill), so a long run is never re-fired by an overlapping tick.
 */
import { spawn as crossSpawn } from 'cross-spawn';
import type { ChildProcess, SpawnOptions } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as fsSync from 'fs';
import { QODEX_HOME } from '../config/defaults.js';
import { getScheduleStore, type ScheduleEntry, type ScheduleKind, type ScheduleStore } from './store.js';
import { logger } from '../utils/logger.js';
import { notifyDesktop } from '../utils/notify.js';
import { buildRecipePrompt } from './recipes.js';
import { parseDeliveryTarget, formatRunSummary, deliverRun } from './delivery.js';
import { parseReceipt, formatReceipt, readReceiptFile } from './receipt.js';

const LOCK_PATH = path.join(QODEX_HOME, 'scheduler.lock');
const RUN_LOG_DIR = path.join(QODEX_HOME, 'schedule-logs');

/** Hard cap on one schedule run. */
export const RUN_HARD_KILL_MS = 30 * 60 * 1000;
/** A lock not refreshed for this long is stale — always ≥ the hard kill of a run. */
export const LOCK_STALE_MS = RUN_HARD_KILL_MS + 5 * 60 * 1000;
const LOCK_HEARTBEAT_MS = 60 * 1000;

export interface TickResult {
  ranIds: string[];
  skipped: string[];
  failed: string[];
  acquired: boolean;
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface TickOptions {
  store?: ScheduleStore;
  lockPath?: string;
  logDir?: string;
  /** How to invoke the qodex CLI (default: resolveCliCommand()). */
  cli?: { command: string; prefix: string[] };
  spawnFn?: SpawnFn;
  hardKillMs?: number;
  staleMs?: number;
  heartbeatMs?: number;
  /** Desktop notifications when a run finishes (default true). */
  notify?: boolean;
}

/** argv (after the CLI command) for one run of an entry. PURE. */
export function buildScheduleRunArgs(
  entry: Pick<ScheduleEntry, 'id' | 'prompt' | 'cwd'> & { model?: string | null; kind?: ScheduleKind | null; recipe?: string | null },
): string[] {
  if (entry.kind === 'mission') {
    // `--yes` mirrors prompt routines (they run unattended with --yes); for a
    // mission it only auto-answers ordinary permission prompts — Sentinel-critical
    // actions (purchases, payments, credentials, sending) and the cost cap still
    // wait for a human. `--` keeps a goal that starts with '-' from parsing as a flag.
    const args = ['mission', 'start', '--yes', '--cwd', entry.cwd, '--from-schedule', entry.id];
    if (entry.model) args.push('--model', entry.model);
    args.push('--', entry.prompt);
    return args;
  }
  // We use --yes so permission prompts auto-approve; without it the headless run
  // would deny everything and the schedule would be useless. A recipe (e.g. verified-pr)
  // wraps the goal in an unattended-safe protocol before it's fed to the agent.
  const args = ['--print', buildRecipePrompt(entry.recipe ?? undefined, entry.prompt), '--yes'];
  if (entry.model) args.push('--model', entry.model);
  return args;
}

/**
 * Resolve how to invoke the qodex CLI: QODEX_CLI_PATH, else the node + entry
 * script running this tick (when it is the qodex CLI), else `qodex` on PATH.
 */
export function resolveCliCommand(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv,
  execPath: string = process.execPath,
): { command: string; prefix: string[] } {
  if (env.QODEX_CLI_PATH) return { command: env.QODEX_CLI_PATH, prefix: [] };
  const entry = argv[1];
  if (entry && /(^|[\\/])(qodex(\.m?js)?|index\.js)$/i.test(entry)) {
    return { command: execPath, prefix: [entry] };
  }
  return { command: 'qodex', prefix: [] };
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; }
}

async function readLockPid(lockPath: string): Promise<number | null> {
  try {
    const text = await fs.readFile(lockPath, 'utf8');
    const m = /pid=(\d+)/.exec(text);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** Take the tick lock, stealing it only from a dead or long-silent holder. */
async function acquireLock(lockPath: string, staleMs: number): Promise<fsSync.promises.FileHandle | null> {
  try {
    return await fs.open(lockPath, 'wx');
  } catch (e: any) {
    if (e?.code !== 'EEXIST') return null;
  }
  const stat = await fs.stat(lockPath).catch(() => null);
  const ageMs = stat ? Date.now() - stat.mtimeMs : Infinity;
  const holder = await readLockPid(lockPath);
  const holderDead = holder !== null && holder !== process.pid && !pidAlive(holder);
  if (!holderDead && ageMs < staleMs) return null;
  try { await fs.unlink(lockPath); } catch { /* raced */ }
  return fs.open(lockPath, 'wx').catch(() => null);
}

export async function tick(opts: TickOptions = {}): Promise<TickResult> {
  const lockPath = opts.lockPath ?? LOCK_PATH;
  const logDir = opts.logDir ?? RUN_LOG_DIR;
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  // Run logs hold the prompt and the agent's full output: owner-only.
  await fs.mkdir(logDir, { recursive: true, mode: 0o700 });

  const lockFd = await acquireLock(lockPath, opts.staleMs ?? LOCK_STALE_MS);
  if (!lockFd) {
    return { ranIds: [], skipped: [], failed: [], acquired: false };
  }
  await lockFd.writeFile(`pid=${process.pid}\nstarted=${new Date().toISOString()}\n`);
  // Keep the lock fresh while entries run (each may take up to the hard kill).
  const heartbeat = setInterval(() => {
    const t = new Date();
    void fs.utimes(lockPath, t, t).catch(() => {});
  }, Math.max(10, opts.heartbeatMs ?? LOCK_HEARTBEAT_MS));
  heartbeat.unref?.();

  const result: TickResult = { ranIds: [], skipped: [], failed: [], acquired: true };

  try {
    const store = opts.store ?? getScheduleStore();
    const due = store.dueAsOf(new Date());

    for (const entry of due) {
      try {
        await runOne(entry, { ...opts, logDir });
        result.ranIds.push(entry.id);
      } catch (e: any) {
        logger.warn('schedule run failed', { id: entry.id, name: entry.name, err: e.message });
        result.failed.push(entry.id);
      }
    }
  } finally {
    clearInterval(heartbeat);
    try { await lockFd.close(); } catch {}
    try { await fs.unlink(lockPath); } catch {}
  }

  return result;
}

async function runOne(entry: ScheduleEntry, opts: TickOptions & { logDir: string }): Promise<void> {
  const store = opts.store ?? getScheduleStore();
  const kind: ScheduleKind = entry.kind === 'mission' ? 'mission' : 'prompt';
  const startMs = Date.now();
  const runId = store.recordRunStart(entry.id);
  const logPath = path.join(opts.logDir, `${entry.id}.${runId}.log`);
  const logStream = fsSync.createWriteStream(logPath, { flags: 'w', mode: 0o600 });
  logStream.write(`# schedule: ${entry.name} (${entry.id})\n# kind:     ${kind}\n# cron:     ${entry.cron}\n# cwd:      ${entry.cwd}\n# started:  ${new Date().toISOString()}\n# prompt:   ${entry.prompt.replace(/\n/g, '\n#           ')}\n\n`);

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

  const args = buildScheduleRunArgs({ ...entry, kind });
  const cli = opts.cli ?? resolveCliCommand();
  const spawnFn: SpawnFn = opts.spawnFn ?? (crossSpawn as unknown as SpawnFn);
  const hardKillMs = opts.hardKillMs ?? RUN_HARD_KILL_MS;
  const notify = opts.notify !== false;
  // Ask a prompt run to write a ground-truth receipt here (built by QodeX from the git
  // diff + the checkers it ran, not the model); preferred over parsing stdout.
  const receiptFile = path.join(opts.logDir, `${entry.id}.${runId}.receipt.json`);

  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = async (status: 'success' | 'error', exitCode: number, message: string, notifyAfter: boolean, output = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(hardKill);
      store.recordRunFinish(runId, entry.id, status, exitCode, message, Date.now() - startMs);
      // Proof-carrying autonomy: prefer the GROUND-TRUTH receipt QodeX wrote (git diff + the
      // checkers it ran) over parsing the model's stdout block. Fall back to stdout if absent.
      let receipt: Awaited<ReturnType<typeof readReceiptFile>> = null;
      if (kind === 'prompt') {
        try {
          receipt = (await readReceiptFile(receiptFile)) ?? parseReceipt(output);
          await fs.unlink(receiptFile).catch(() => {});
          if (receipt) store.attachReceipt(runId, JSON.stringify(receipt));
        } catch { /* a receipt is best-effort */ }
      }
      if (!notifyAfter) { resolve(); return; }
      // Let the user know a background task finished — they may have closed the
      // terminal. Fire-and-forget; a failed notification never affects the run.
      const secs = Math.round((Date.now() - startMs) / 1000);
      const desktop = notify
        ? notifyDesktop({
            title: status === 'success' ? `✓ QodeX: ${entry.name}` : `✗ QodeX: ${entry.name}`,
            subtitle: status === 'success' ? `Done in ${secs}s` : `Failed (exit ${exitCode}) after ${secs}s`,
            message: message ? message.slice(0, 180) : (status === 'success' ? 'Task completed.' : 'Task failed — check the log.'),
            sound: true,
          })
        : Promise.resolve();
      // Deliver the result to chat (Telegram/Discord) when the schedule asked for it —
      // this is what makes the scheduler "24/7 to your phone", not just a desktop ping.
      const target = parseDeliveryTarget(entry.deliver);
      const summary = formatRunSummary({ name: entry.name, status, exitCode, durationSec: secs, tail: message, recipe: entry.recipe });
      const text = receipt ? `${summary}\n\n${formatReceipt(receipt)}` : summary;
      const deliver = target
        ? deliverRun(target, text)
            .then(ok => { if (ok) logger.info('schedule result delivered', { id: entry.id, to: `${target.platform}:${target.chatId}` }); })
            .catch(() => {})
        : Promise.resolve();
      void Promise.allSettled([desktop, deliver]).finally(() => resolve());
    };

    let child: ChildProcess;
    try {
      child = spawnFn(cli.command, [...cli.prefix, ...args], {
        cwd: entry.cwd,
        env: { ...process.env, QODEX_SCHEDULED: '1', ...(kind === 'prompt' ? { QODEX_RECEIPT_FILE: receiptFile } : {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e: any) {
      const msg = `spawn failed: ${e.message}`;
      logStream.end('\n' + msg + '\n');
      store.recordRunFinish(runId, entry.id, 'error', 127, msg, Date.now() - startMs);
      resolve();
      return;
    }

    let output = '';
    child.stdout?.on('data', (d: Buffer) => { const s = d.toString(); output += s; logStream.write(s); });
    child.stderr?.on('data', (d: Buffer) => { const s = d.toString(); output += s; logStream.write(s); });

    const hardKill = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
    }, hardKillMs);

    child.on('error', (e: any) => {
      const msg = `spawn failed: ${e.message}`;
      logStream.end('\n' + msg + '\n');
      void finish('error', 127, msg, false);
    });

    child.on('close', (code, signal) => {
      const exitCode = code ?? (signal ? 128 : 1);
      const status: 'success' | 'error' = exitCode === 0 ? 'success' : 'error';
      const tail = output.slice(-500).trim().replace(/\s+/g, ' ');
      logStream.end(`\n# finished: ${new Date().toISOString()} exit=${exitCode} (${status})\n`);
      // A mission routine only STARTS the mission here; the mission notifies when
      // it completes, so only a failure to start is worth a notification now.
      void finish(status, exitCode, tail, kind === 'prompt' || status === 'error', output);
    });
  });
}
