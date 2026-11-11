/**
 * `qodex desk` — named local teammates that can actually run.
 *
 * Not a cloud VM. Each desk is a role on this machine, with a cwd, a goal
 * queue, and a hard stop before send / spend / delete / publish / secrets.
 * `desk run` claims one runnable goal and hands it to the same agent as `qodex -p`.
 */
import { Command } from 'commander';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import {
  buildDeskPrompt,
  claimGoal,
  createDesk,
  decideGoal,
  findDesk,
  handoff,
  lastTrace,
  peekRunnable,
  postGoal,
  releaseGoal,
  settleGoal,
  teachRoutine,
  type Board,
  type BoardResult,
  type RoutineStep,
} from '../desk/board.js';
import { probeDesktop } from '../desk/policy.js';
import { decideSentinel, listPending } from '../desk/sentinel.js';
import { appendAudit, ensureSharedComputer, loadBoard, readAudit, saveBoard, withDeskLock } from '../desk/store.js';

async function update<T>(
  mut: (board: Board) => BoardResult<T>,
  okLine: (res: BoardResult<T>) => string,
): Promise<void> {
  try {
    await withDeskLock(async () => {
      const res = mut(await loadBoard());
      if (!res.ok) {
        console.error(`✗ ${res.error}`);
        process.exitCode = 1;
        return;
      }
      await saveBoard(res.state);
      if (res.audit) await appendAudit(res.audit);
      console.log(okLine(res));
    });
  } catch (e: any) {
    console.error(`✗ ${e?.message ?? e}`);
    process.exitCode = 1;
  }
}

type DesktopInfo = ReturnType<typeof probeDesktop>;

async function runOne(
  deskName: string | undefined,
  desktop: DesktopInfo,
  sharedDir: string,
  dryRun: boolean,
  timeoutMs: number,
): Promise<void> {
  let picked: { deskId: string; cwd: string; prompt: string; goalId: string } | undefined;
  try {
    await withDeskLock(async () => {
      const board = await loadBoard();
      const desk = deskName ? findDesk(board, deskName) : board.desks.find(d => peekRunnable(d));
      if (!desk) {
        console.error(deskName ? `✗ no desk "${deskName}"` : '✗ no desk has a runnable goal');
        process.exitCode = 1;
        return;
      }
      const goal = peekRunnable(desk);
      if (!goal) {
        console.error(`✗ nothing runnable on ${desk.name} — held goals stay held until you allow them`);
        process.exitCode = 1;
        return;
      }
      try {
        const st = await fs.stat(desk.cwd);
        if (!st.isDirectory()) throw new Error('not a directory');
      } catch {
        console.error(`✗ desk cwd does not exist: ${desk.cwd}`);
        process.exitCode = 1;
        return;
      }
      const prompt = buildDeskPrompt({
        desk,
        goal,
        teammates: board.desks.filter(d => d.id !== desk.id).map(d => ({ name: d.name, brief: d.brief })),
        desktop,
        sharedDir,
      });
      if (dryRun) {
        process.stderr.write(`dry-run: would claim ${goal.id} on ${desk.name} — model not called\n`);
        process.stdout.write(prompt + '\n');
        return;
      }
      const claimed = claimGoal(board, { deskId: desk.id });
      if (!claimed.ok || !claimed.value) {
        console.error(`✗ ${claimed.error}`);
        process.exitCode = 1;
        return;
      }
      await saveBoard(claimed.state);
      if (claimed.audit) await appendAudit(claimed.audit);
      picked = { deskId: desk.id, cwd: desk.cwd, prompt, goalId: claimed.value.id };
    });
  } catch (e: any) {
    console.error(`✗ ${e?.message ?? e}`);
    process.exitCode = 1;
    return;
  }
  if (!picked || dryRun) return;
  const job = picked;
  let code = 1;
  let summary = 'agent did not start';
  let trace: Array<{ tool: string; summary: string }> = [];
  try {
    const { runDeskAgent } = await import('../desk/dispatch.js');
    const result = await runDeskAgent({
      cwd: job.cwd,
      prompt: job.prompt,
      deskId: job.deskId,
      goalId: job.goalId,
      sentinelTimeoutMs: timeoutMs,
    });
    code = result.code;
    trace = result.trace;
    summary = `agent exit ${code}`;
  } catch (e: any) {
    code = 1;
    summary = e?.message ?? String(e);
  }
  try {
    await withDeskLock(async () => {
      const board = await loadBoard();
      const settled = settleGoal(board, {
        deskId: job.deskId,
        goalId: job.goalId,
        ok: code === 0,
        summary,
        trace,
      });
      if (!settled.ok) {
        console.error(`✗ ran, but could not record the result: ${settled.error}`);
        return;
      }
      await saveBoard(settled.state);
      if (settled.audit) await appendAudit(settled.audit);
    });
  } catch (e: any) {
    console.error(`✗ ran, but could not record the result: ${e?.message ?? e}`);
  }
  if (code !== 0) process.exitCode = code;
  console.log(code === 0 ? `✓ ${job.goalId} done` : `✗ ${job.goalId} failed (${code})`);
}

/** Desks in different directories run at once. Same directory is sequential so they don't clobber one checkout. */
async function runAll(desktop: DesktopInfo, sharedDir: string, dryRun: boolean, timeoutMs: number): Promise<void> {
  const board = await loadBoard();
  const jobs = board.desks.filter(d => peekRunnable(d));
  if (jobs.length === 0) {
    console.error('✗ no desk has a runnable goal');
    process.exitCode = 1;
    return;
  }
  if (dryRun) {
    for (const desk of jobs) {
      const goal = peekRunnable(desk)!;
      const prompt = buildDeskPrompt({
        desk,
        goal,
        teammates: board.desks.filter(d => d.id !== desk.id).map(d => ({ name: d.name, brief: d.brief })),
        desktop,
        sharedDir,
      });
      process.stderr.write(`dry-run: would claim ${goal.id} on ${desk.name}\n`);
      process.stdout.write(prompt + '\n');
    }
    return;
  }
  const groups = new Map<string, string[]>();
  for (const desk of jobs) {
    const list = groups.get(desk.cwd) ?? [];
    list.push(desk.name);
    groups.set(desk.cwd, list);
  }
  console.log(`running ${jobs.length} desk(s) across ${groups.size} director${groups.size === 1 ? 'y' : 'ies'}`);
  const codes = await Promise.all([...groups.values()].map(async names => {
    let last = 0;
    for (const name of names) last = await spawnDesk(name, timeoutMs);
    return last;
  }));
  const failed = codes.filter(c => c !== 0).length;
  if (failed) process.exitCode = 1;
  console.log(failed ? `✗ ${failed} desk group(s) failed` : `✓ ${jobs.length} desk(s) finished`);
}

function spawnDesk(name: string, timeoutMs: number): Promise<number> {
  const script = process.argv[1];
  if (!script) return Promise.resolve(1);
  const seconds = String(Math.max(5, Math.round(timeoutMs / 1000)));
  return new Promise(resolve => {
    const child = spawn(process.execPath, [...process.execArgv, script, 'desk', 'run', name, '--sentinel-timeout', seconds], {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('error', () => resolve(1));
    child.on('exit', code => resolve(code ?? 1));
  });
}

export function buildDeskCommand(): Command {
  const cmd = new Command('desk');
  cmd.description('Local desktop teammates: named desks, handoffs, approval, and one real agent run');

  cmd
    .command('list', { isDefault: true })
    .description('Show desks, open goals, and what this machine can drive')
    .action(async () => {
      const board = await loadBoard();
      const desktop = probeDesktop();
      const pending = await listPending();
      console.log(`QodeX Desk · ${board.desks.length}/6 · GUI ${desktop.gui} · sentinel ${pending.length}`);
      console.log(desktop.note);
      if (board.desks.length === 0) {
        console.log('\nNo desks. Add one: qodex desk add research --brief "read and summarize"');
        return;
      }
      const openStatus = new Set(['needs-approval', 'queued', 'approved', 'running', 'failed']);
      for (const d of board.desks) {
        const held = d.goals.filter(g => g.status === 'needs-approval').length;
        const open = d.goals.filter(g => g.status === 'queued' || g.status === 'approved').length;
        const running = d.goals.filter(g => g.status === 'running').length;
        console.log(`\n${d.name}  (${d.id})  ${d.cwd}`);
        if (d.brief) console.log(`  ${d.brief}`);
        console.log(`  open ${open} · waiting approval ${held} · running ${running} · routines ${d.routines.length}`);
        for (const g of d.goals.filter(x => openStatus.has(x.status)).slice(-4)) {
          console.log(`  · [${g.status}] ${g.id} ${g.text}`);
        }
      }
    });

  cmd
    .command('add <name>')
    .description('Create a desk (max 6)')
    .option('--brief <text>', 'What this desk is for')
    .option('--cwd <dir>', 'Working directory for this desk', process.cwd())
    .action(async (name: string, opts: { brief?: string; cwd: string }) => {
      await update(
        board => createDesk(board, { name, brief: opts.brief, cwd: opts.cwd }),
        res => `✓ desk "${res.value?.name}" (${res.value?.id})`,
      );
    });

  cmd
    .command('goal <desk> <text...>')
    .description('Give a desk a goal. Send/spend/delete/publish/secrets wait for approval.')
    .action(async (deskName: string, text: string[]) => {
      await update(board => {
        const desk = findDesk(board, deskName);
        if (!desk) return { ok: false, state: board, error: `no desk "${deskName}"` };
        return postGoal(board, { deskId: desk.id, text: text.join(' ') });
      }, res => {
        const goal = res.value;
        if (goal?.status === 'needs-approval') {
          return `⏸ held ${goal.id} (${goal.sensitive?.kind}) — qodex desk allow ${res.audit?.deskId ?? ''} ${goal.id}`;
        }
        return `✓ queued ${goal?.id}`;
      });
    });

  cmd
    .command('allow <desk> <goalId>')
    .description('Approve a held goal')
    .action(async (deskName: string, goalId: string) => {
      await update(board => {
        const desk = findDesk(board, deskName);
        if (!desk) return { ok: false, state: board, error: `no desk "${deskName}"` };
        return decideGoal(board, { deskId: desk.id, goalId, allow: true });
      }, () => `✓ approved ${goalId}`);
    });

  cmd
    .command('deny <desk> <goalId>')
    .description('Deny a held goal')
    .action(async (deskName: string, goalId: string) => {
      await update(board => {
        const desk = findDesk(board, deskName);
        if (!desk) return { ok: false, state: board, error: `no desk "${deskName}"` };
        return decideGoal(board, { deskId: desk.id, goalId, allow: false });
      }, () => `✓ denied ${goalId}`);
    });

  cmd
    .command('handoff <from> <to> <note...>')
    .description('Pass the open goal (or a note) to another desk. Secrets in the note are stripped.')
    .action(async (fromName: string, toName: string, note: string[]) => {
      await update(board => {
        const from = findDesk(board, fromName);
        const to = findDesk(board, toName);
        if (!from || !to) return { ok: false, state: board, error: 'both desks must exist' };
        return handoff(board, { fromId: from.id, toId: to.id, note: note.join(' ') });
      }, res => `✓ handed to ${toName}: ${res.value?.status} ${res.value?.text}`);
    });

  cmd
    .command('teach <desk> <name>')
    .description('Save a routine from JSON on stdin, or --from-last to use the last run\'s tool trace')
    .option('--from-last', 'Use the tool trace of the last finished goal on this desk')
    .action(async (deskName: string, name: string, opts: { fromLast?: boolean }) => {
      if (opts.fromLast) {
        await update(board => {
          const desk = findDesk(board, deskName);
          if (!desk) return { ok: false, state: board, error: `no desk "${deskName}"` };
          const steps = lastTrace(desk);
          if (!steps) return { ok: false, state: board, error: 'no finished goal has a tool trace yet — run one first' };
          return teachRoutine(board, { deskId: desk.id, name, steps });
        }, res => `✓ routine "${res.value?.name}" from the last run (${res.value?.steps.length} steps)`);
        return;
      }
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(c as Buffer);
      let steps: RoutineStep[];
      try { steps = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '[]'); }
      catch {
        console.error('✗ stdin is not JSON');
        process.exitCode = 1;
        return;
      }
      await update(board => {
        const desk = findDesk(board, deskName);
        if (!desk) return { ok: false, state: board, error: `no desk "${deskName}"` };
        return teachRoutine(board, { deskId: desk.id, name, steps });
      }, res => `✓ routine "${res.value?.name}" (${res.value?.steps.length} steps)`);
    });

  cmd
    .command('run [desk]')
    .description('Run the oldest runnable goal. --all runs every desk that has one, in parallel when their directories differ.')
    .option('--dry-run', 'Print the prompt. Do not claim the goal and do not call a model.')
    .option('--all', 'Run one runnable goal on every desk')
    .option('--sentinel-timeout <sec>', 'How long a paused call waits for allow-call', '600')
    .action(async (deskName: string | undefined, opts: { dryRun?: boolean; all?: boolean; sentinelTimeout?: string }) => {
      if (opts.all && deskName) {
        console.error('✗ pass a desk name or --all, not both');
        process.exitCode = 1;
        return;
      }
      const desktop = probeDesktop();
      const sharedDir = await ensureSharedComputer();
      const timeoutMs = Math.max(5, Number(opts.sentinelTimeout) || 600) * 1000;
      if (opts.all) {
        await runAll(desktop, sharedDir, !!opts.dryRun, timeoutMs);
        return;
      }
      await runOne(deskName, desktop, sharedDir, !!opts.dryRun, timeoutMs);
    });
  cmd
    .command('release <desk> <goalId>')
    .description('Put a killed run back. An approved goal stays approved.')
    .action(async (deskName: string, goalId: string) => {
      await update(board => {
        const desk = findDesk(board, deskName);
        if (!desk) return { ok: false, state: board, error: `no desk "${deskName}"` };
        return releaseGoal(board, { deskId: desk.id, goalId });
      }, res => `✓ released ${goalId} → ${res.value?.status}`);
    });

  cmd
    .command('audit')
    .description('Show the recent desk audit trail')
    .action(async () => {
      const rows = await readAudit(40);
      if (rows.length === 0) { console.log('No desk audit yet.'); return; }
      for (const row of rows) console.log(`${row.ts}  ${row.kind.padEnd(8)}  ${row.deskId}  ${row.detail}`);
    });

  cmd
    .command('calls')
    .description('List tool calls waiting on the sentinel')
    .action(async () => {
      const rows = await listPending();
      if (rows.length === 0) { console.log('No call is waiting.'); return; }
      for (const row of rows) console.log(`${row.id}  ${row.kind.padEnd(12)}  ${row.deskId}  ${row.prompt.slice(0, 120)}`);
    });

  cmd
    .command('allow-call <id>')
    .description('Let a paused tool call run')
    .action(async (id: string) => {
      const res = await decideSentinel(id, true);
      if (!res.ok) { console.error(`✗ ${res.error}`); process.exitCode = 1; return; }
      await appendAudit({ ts: new Date().toISOString(), deskId: res.request!.deskId, kind: 'sentinel-allow', detail: `${id} ${res.request!.kind}` });
      console.log(`✓ allowed ${id} — the desk run will continue`);
    });

  cmd
    .command('deny-call <id>')
    .description('Refuse a paused tool call. The agent is told no.')
    .action(async (id: string) => {
      const res = await decideSentinel(id, false);
      if (!res.ok) { console.error(`✗ ${res.error}`); process.exitCode = 1; return; }
      await appendAudit({ ts: new Date().toISOString(), deskId: res.request!.deskId, kind: 'sentinel-deny', detail: `${id} ${res.request!.kind}` });
      console.log(`✓ denied ${id}`);
    });

  cmd
    .command('serve')
    .description('Open the local desk console (127.0.0.1, token in the URL)')
    .option('--port <n>', 'Preferred port', '0')
    .action(async (opts: { port: string }) => {
      const { startDeskConsole } = await import('../desk/console.js');
      const handle = await startDeskConsole(process.cwd(), Number(opts.port) || 0);
      console.log(`\nQodeX Desk → ${handle.url}`);
      console.log('   This window is the desktop. Ctrl-C to stop. Nothing listens outside 127.0.0.1.');
      console.log('   Allow a paused click or shell call here, or with `qodex desk allow-call`.\n');
      const shutdown = () => { void handle.close().then(() => process.exit(0)); };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      await new Promise<never>(() => {});
    });

  return cmd;
}
