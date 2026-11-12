/**
 * Start one runnable desk goal without holding the board lock across the model.
 * Same claim and settle as `qodex desk run`. A held goal is not claimed.
 * The returned promise resolves when the goal is recorded; callers that only
 * need the button to return should ignore `done`.
 */
import { promises as fs } from 'fs';
import { buildDeskPrompt, claimGoal, findDesk, peekRunnable, settleGoal } from './board.js';
import { probeDesktop } from './policy.js';
import { appendAudit, ensureSharedComputer, loadBoard, saveBoard, withDeskLock } from './store.js';

const inflight = new Set<string>();

export interface DeskLaunchJob {
  deskId: string;
  goalId: string;
  cwd: string;
  prompt: string;
}

export async function launchDesk(
  deskNameOrId: string,
  run: (job: DeskLaunchJob) => Promise<{ code: number; trace: Array<{ tool: string; summary: string }> }> = defaultRun,
): Promise<{ ok: boolean; message: string; done?: Promise<void> }> {
  let job: DeskLaunchJob | undefined;
  const gate = await withDeskLock(async () => {
    const board = await loadBoard();
    const desk = findDesk(board, deskNameOrId);
    if (!desk) return { ok: false as const, message: 'no such desk' };
    if (inflight.has(desk.id) || desk.goals.some(g => g.status === 'running')) {
      return { ok: false as const, message: 'already running' };
    }
    const goal = peekRunnable(desk);
    if (!goal) return { ok: false as const, message: 'nothing runnable — held goals stay held until you allow them' };
    try {
      const st = await fs.stat(desk.cwd);
      if (!st.isDirectory()) throw new Error('not a directory');
    } catch {
      return { ok: false as const, message: `desk cwd does not exist: ${desk.cwd}` };
    }
    const prompt = buildDeskPrompt({
      desk,
      goal,
      teammates: board.desks.filter(d => d.id !== desk.id).map(d => ({ name: d.name, brief: d.brief })),
      desktop: probeDesktop(),
      sharedDir: await ensureSharedComputer(),
    });
    const claimed = claimGoal(board, { deskId: desk.id });
    if (!claimed.ok || !claimed.value) return { ok: false as const, message: claimed.error ?? 'not claimed' };
    await saveBoard(claimed.state);
    if (claimed.audit) await appendAudit(claimed.audit);
    inflight.add(desk.id);
    job = { deskId: desk.id, goalId: claimed.value.id, cwd: desk.cwd, prompt };
    return { ok: true as const, message: `running ${claimed.value.id}` };
  });
  if (!gate.ok || !job) return gate;
  const started = job;
  const done = (async () => {
    let code = 1;
    let summary = 'agent did not start';
    let trace: Array<{ tool: string; summary: string }> = [];
    try {
      const result = await run(started);
      code = result.code;
      trace = result.trace ?? [];
      summary = `agent exit ${code}`;
    } catch (e: any) {
      code = 1;
      summary = e?.message ?? String(e);
    } finally {
      inflight.delete(started.deskId);
    }
    await withDeskLock(async () => {
      const board = await loadBoard();
      const settled = settleGoal(board, {
        deskId: started.deskId,
        goalId: started.goalId,
        ok: code === 0,
        summary,
        trace,
      });
      if (!settled.ok) return;
      await saveBoard(settled.state);
      if (settled.audit) await appendAudit(settled.audit);
    });
  })();
  return { ok: true, message: gate.message, done };
}

async function defaultRun(job: DeskLaunchJob): Promise<{ code: number; trace: Array<{ tool: string; summary: string }> }> {
  const { runDeskAgent } = await import('./dispatch.js');
  return runDeskAgent({
    cwd: job.cwd,
    prompt: job.prompt,
    deskId: job.deskId,
    goalId: job.goalId,
  });
}
