/**
 * Wire background missions into the control center: register the `missions.*`
 * actions the dashboard calls, and mirror events written by detached mission
 * workers onto this process's bus so the Activity timeline and approval cards
 * stay live. Idempotent per process (reference-counted, safe under concurrent
 * callers); returns a disposer that releases exactly one reference.
 *
 * The dashboard's contract (src/control/dashboard.ts):
 *   missions.list            → [{id, goal, status, progress, updatedAt, liveUrl}]
 *   missions.cancel          {id}
 *   missions.approvals       → [{id, missionId, prompt, options, category}]
 *   missions.resolveApproval {id, answer}   (answered as 'control'; failures throw
 *                                            [APPROVAL_NOT_FOUND] / [APPROVAL_BAD_ANSWER] /
 *                                            [APPROVAL_NOT_PENDING] → HTTP 404 / 400 / 409)
 * plus the richer actions from src/missions (status, events, start, resume,
 * approve, deny, steer).
 */

import { registerControlAction } from './server.js';
import { logger } from '../utils/logger.js';

interface Active { dispose: () => void; refs: number }

let active: Active | null = null;
/** In-flight first registration, so concurrent callers share it (no double bridge). */
let pending: Promise<Active> | null = null;

export async function registerMissionControl(opts: { defaultCwd?: string } = {}): Promise<() => void> {
  if (!active) {
    if (!pending) {
      pending = setup(opts).finally(() => { pending = null; });
    }
    const a = await pending;
    if (!active) active = a;
  }
  const held = active;
  held.refs++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release(held);
  };
}

async function setup(opts: { defaultCwd?: string }): Promise<Active> {
  const missions = await import('../missions/index.js');
  const actions = missions.createMissionControlActions({ defaultCwd: opts.defaultCwd ?? process.cwd() });

  const offs: Array<() => void> = [];
  for (const [name, fn] of Object.entries(actions)) {
    if (name === 'missions.list') continue;
    offs.push(registerControlAction(name, fn));
  }
  offs.push(registerControlAction('missions.list', async (body: unknown) => {
    const list = (await actions['missions.list']!(body)) as Array<Record<string, any>>;
    return list.map(m => ({
      ...m,
      // The dashboard renders `progress` text; MissionSummary carries step counts.
      progress: m.steps && typeof m.steps.total === 'number' && m.steps.total > 0
        ? `${m.steps.done}/${m.steps.total}`
        : undefined,
      steps: undefined,
    }));
  }));
  offs.push(registerControlAction('missions.resolveApproval', async (body: unknown) => {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const id = typeof b.id === 'string' ? b.id.trim() : '';
    const answer = typeof b.answer === 'string' ? b.answer.trim() : '';
    if (!id || !answer) throw new Error('[BAD_REQUEST] "id" and "answer" are required');
    // Always answered as 'control' — the request body never chooses the channel.
    const r = missions.answerApprovalById(id, answer, { by: 'control' });
    if (!r.ok) {
      // A failed answer must not look like success (the dashboard would drop the card).
      const msg = String(r.message ?? 'Could not answer the approval.');
      throw new Error(msg.startsWith('[') ? msg : `[APPROVAL_NOT_PENDING] ${msg}`);
    }
    return r;
  }));

  // Mirror detached workers' events onto the bus. A missions DB that cannot be
  // opened must not take the control center (or /control) down with it: the
  // actions above still answer, each with its own error.
  let stopBridge: () => void = () => {};
  try {
    stopBridge = missions.startMissionEventBridge();
  } catch (e) {
    logger.warn('Mission event bridge unavailable', { err: e instanceof Error ? e.message : String(e) });
  }

  return {
    refs: 0,
    dispose: () => {
      try { stopBridge(); } catch { /* ignore */ }
      for (const off of offs) { try { off(); } catch { /* ignore */ } }
    },
  };
}

function release(held: Active): void {
  if (active !== held) return; // already disposed
  held.refs--;
  if (held.refs <= 0) {
    active = null;
    held.dispose();
  }
}
