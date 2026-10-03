/**
 * Wire background missions into the control center: register the `missions.*`
 * actions the dashboard calls, and mirror events written by detached mission
 * workers onto this process's bus so the Activity timeline and approval cards
 * stay live. Idempotent per process; returns a disposer.
 *
 * The dashboard's contract (src/control/dashboard.ts):
 *   missions.list            → [{id, goal, status, progress, updatedAt, liveUrl}]
 *   missions.cancel          {id}
 *   missions.approvals       → [{id, missionId, prompt, options, category}]
 *   missions.resolveApproval {id, answer, by}
 * plus the richer actions from src/missions (status, events, start, resume,
 * approve, deny, steer).
 */

import { registerControlAction } from './server.js';

let active: { dispose: () => void; refs: number } | null = null;

export async function registerMissionControl(opts: { defaultCwd?: string } = {}): Promise<() => void> {
  if (active) {
    active.refs++;
    return () => release();
  }
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
    return missions.answerApprovalById(id, answer, { by: 'control' });
  }));
  const stopBridge = missions.startMissionEventBridge();

  active = {
    refs: 1,
    dispose: () => {
      stopBridge();
      for (const off of offs) { try { off(); } catch { /* ignore */ } }
    },
  };
  return () => release();
}

function release(): void {
  if (!active) return;
  active.refs--;
  if (active.refs <= 0) {
    const a = active;
    active = null;
    a.dispose();
  }
}
