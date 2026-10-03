/**
 * Cross-module follow-ups for the agent-platform channels: the mission event
 * bridge (one bus event per status transition), Telegram pairing registering the
 * approval channel before it says "Paired!", the Telegram mission adapter not
 * forwarding the control center's token, /control's mission-action refcount,
 * the workflow CLI's permission engine, `workflow record --browser-profile`, and
 * root flags written after a subcommand reaching that subcommand (real CLI).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MissionStore, setMissionStoreForTests } from '../src/missions/store.js';
import { startMissionEventBridge } from '../src/missions/index.js';
import { runMission, missionAskUser, type AgentLike } from '../src/missions/runner.js';
import { MissionMilestoneTool } from '../src/missions/tools.js';
import { getBus, type BusEvent } from '../src/control/bus.js';
import { stopControlCenter } from '../src/control/server.js';

const DEAD_PID = 2 ** 22 + 777;

async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise(r => setTimeout(r, 20));
  }
}

let dir: string;
let store: MissionStore;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-followup-ch-'));
  store = new MissionStore(path.join(dir, 'sessions.db'));
  setMissionStoreForTests(store);
  getBus().reset();
});

afterEach(async () => {
  await stopControlCenter();
  setMissionStoreForTests(null);
  getBus().reset();
  try { (store as any).close?.(); } catch { /* ignore */ }
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe('mission event bridge', () => {
  it('publishes ONE bus event per status transition, in the in-process runner\'s shape', async () => {
    const m = store.create({ goal: 'bridged once', cwd: dir });
    store.update(m.id, { pid: DEAD_PID }); // "another process" runs it
    const seen: BusEvent[] = [];
    getBus().subscribe(e => seen.push(e));
    const stop = startMissionEventBridge({ store, intervalMs: 100 });
    try {
      store.setStatus(m.id, 'completed');
      store.appendEvent(m.id, 'milestone', { title: 'after-completion' }); // marks the bridge caught up
      await waitFor(() => seen.some(e => e.kind === 'mission' && e.type === 'milestone'));
      const rows = seen.filter(e => e.kind === 'mission' && e.missionId === m.id && e.type !== 'milestone');
      // A timeline (control-center Activity, notifiers) renders every event: one transition, one row.
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ type: 'status', data: { to: 'completed', status: 'completed' } });
    } finally {
      stop();
    }
  });

  it('a mission run in THIS process reaches the bus once per event, also after it released the mission', async () => {
    const m = store.create({ goal: 'inline once', cwd: dir });
    const seen: BusEvent[] = [];
    getBus().subscribe(e => seen.push(e));
    const stop = startMissionEventBridge({ store, intervalMs: 50 });
    try {
      const agent = (): AgentLike => ({
        buildInitialMessages: async (p) => [{ role: 'user', content: p }],
        pushSteer: () => {},
        run: async function* () {
          // The agent reports a milestone through the tool (it writes AND publishes).
          const tool = new MissionMilestoneTool();
          const res = await tool.execute(tool.argsSchema.parse({ title: 'halfway' }));
          expect(res.isError).toBeFalsy();
          await new Promise(r => setTimeout(r, 150)); // let the bridge tick while the step runs
          yield { type: 'final', data: { content: 'done' } };
        },
      });
      const r = await runMission(m.id, {
        store,
        createAgent: agent,
        complete: async (prompt) => prompt.includes('PLANNER')
          ? JSON.stringify({ steps: [{ id: 's1', title: 'one', instruction: 'do it', depends_on: [] }], success_criteria: 'ok' })
          : 'FINAL REPORT',
        askUserFactory: (stepId, signal) => missionAskUser(m.id, stepId, { signal }),
        sessions: { createSession: () => 'sess-1', recordTurn: () => {}, markStatus: () => {}, addWorklogEntry: () => {} },
        notify: async () => {},
        pollIntervalMs: 20,
        abortGraceMs: 1000,
        config: { maxConcurrency: 1, maxAttempts: 1, stepMaxIterations: 5, stepMaxWallSeconds: 0, maxCostUsd: 0, notify: false },
      });
      expect(r.status).toBe('completed');
      // A foreign row after the run: once the bridge publishes it, it has read every row of the run.
      store.appendEvent(m.id, 'milestone', { title: 'probe' });
      await waitFor(() => seen.some(e => e.kind === 'mission' && (e.data as any)?.title === 'probe'));
      const of = (pred: (e: any) => boolean) => seen.filter(e => e.kind === 'mission' && e.missionId === m.id && pred(e));
      expect(of(e => e.type === 'status' && e.data?.to === 'completed')).toHaveLength(1);
      expect(of(e => e.type === 'completed')).toHaveLength(0);
      expect(of(e => e.type === 'report')).toHaveLength(1);
      expect(of(e => e.type === 'plan')).toHaveLength(1);
      expect(of(e => e.type === 'milestone' && e.data?.title === 'halfway')).toHaveLength(1);
      // The one completion row carries what a timeline / notifier shows.
      expect(of(e => e.type === 'status' && e.data?.to === 'completed')[0]).toMatchObject({ data: { status: 'completed', report: 'FINAL REPORT', stepsDone: 1 } });
    } finally {
      stop();
    }
  });
});
