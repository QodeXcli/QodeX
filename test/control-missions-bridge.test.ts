/**
 * The missions ↔ control-center bridge (src/control/missions-bridge.ts): action
 * registration is reference-counted and race-free, answering a mission approval
 * reports failures as errors (with the right HTTP status), and a broken missions
 * DB never takes the control center down with it. Uses a temp MissionStore.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerMissionControl } from '../src/control/missions-bridge.js';
import { listControlActions, runControlAction, startControlCenter, stopControlCenter } from '../src/control/server.js';
import { getBus } from '../src/control/bus.js';
import { getApprovalBroker } from '../src/control/approvals.js';
import { MissionStore, setMissionStoreForTests } from '../src/missions/store.js';

const TOKEN = 'bridge-test-token-0123456789';

let dir = '';
let store: MissionStore;
const disposers: Array<() => void> = [];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-ctl-bridge-'));
  store = new MissionStore(path.join(dir, 'sessions.db'));
  setMissionStoreForTests(store);
  getBus().reset();
});

afterEach(async () => {
  while (disposers.length) disposers.pop()!();
  await stopControlCenter();
  getApprovalBroker().reset();
  getBus().reset();
  setMissionStoreForTests(null);
  try { (store as any).close?.(); } catch { /* ignore */ }
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

async function waitUntil(fn: () => boolean, ms = 6000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await new Promise(r => setTimeout(r, 25));
  }
  return fn();
}

describe('missions control bridge', () => {
  it('concurrent registrations share ONE event bridge (no duplicated mission events)', async () => {
    const [a, b] = await Promise.all([registerMissionControl({ defaultCwd: dir }), registerMissionControl({ defaultCwd: dir })]);
    disposers.push(a, b);
    // A mission written by "another process" (no live pid here) emits one milestone.
    const m = store.create({ goal: 'Watch the bridge', cwd: dir });
    store.appendEvent(m.id, 'milestone', { title: 'bridge-probe' });
    const probes = () => getBus().recent(300).filter(e => e.kind === 'mission' && e.type === 'milestone' && (e.data as any)?.title === 'bridge-probe');
    expect(await waitUntil(() => probes().length > 0)).toBe(true);
    await new Promise(r => setTimeout(r, 2600)); // > one more bridge poll interval
    expect(probes()).toHaveLength(1);
  }, 20_000);

  it('a disposer is idempotent: releasing twice never drops another holder\'s registration', async () => {
    const a = await registerMissionControl({ defaultCwd: dir });
    const b = await registerMissionControl({ defaultCwd: dir });
    disposers.push(b);
    a();
    a();
    expect(listControlActions()).toContain('missions.list');
    expect(listControlActions()).toContain('missions.resolveApproval');
    b();
    expect(listControlActions()).not.toContain('missions.list');
  });

  it('missions.resolveApproval reports failures as errors (404/400), and resolves real approvals', async () => {
    disposers.push(await registerMissionControl({ defaultCwd: dir }));
    await expect(runControlAction('missions.resolveApproval', { id: 'ap_nope', answer: 'yes' })).rejects.toThrow(/^\[APPROVAL_NOT_FOUND\]/);
    await expect(runControlAction('missions.resolveApproval', { id: '', answer: 'yes' })).rejects.toThrow(/^\[BAD_REQUEST\]/);

    const m = store.create({ goal: 'Buy coffee', cwd: dir });
    const ap = store.createApproval({ missionId: m.id, prompt: 'Pay $12?', options: ['yes', 'no'], category: 'payment', risk: 'critical' });

    // Over HTTP the dashboard gets a real error status (it used to get 200 + {ok:false}).
    const info = await startControlCenter({ port: 0, token: TOKEN, onSteer: () => false });
    const post = (body: unknown) => fetch(`http://127.0.0.1:${info.port}/api/actions/missions.resolveApproval`, {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    expect((await post({ id: 'ap_missing', answer: 'yes' })).status).toBe(404);
    expect((await post({ id: ap.id, answer: 'perhaps' })).status).toBe(400);
    expect(store.getApproval(ap.id)?.status).toBe('pending');

    const ok = await post({ id: ap.id, answer: 'yes', by: 'someone-else' });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).result).toMatchObject({ ok: true });
    const row = store.getApproval(ap.id) as any;
    expect(row.status).toBe('approved');
    // The answering channel is always 'control' (the body cannot choose it).
    expect(JSON.stringify(row)).toContain('control');
    expect(JSON.stringify(row)).not.toContain('someone-else');
    // Answering it again is a conflict, not a silent success.
    const again = await post({ id: ap.id, answer: 'no' });
    expect(again.status).toBe(409);
    expect(((await again.json()) as any).error).toMatch(/^\[APPROVAL_NOT_PENDING\]/);
    expect(store.getApproval(ap.id)?.status).toBe('approved');
  });

  it('a broken missions DB does not make registration (and so /control) fail', async () => {
    const broken = new Proxy({}, { get: () => () => { throw new Error('SQLITE_CANTOPEN: unable to open database file'); } });
    setMissionStoreForTests(broken as any);
    const dispose = await registerMissionControl({ defaultCwd: dir });
    disposers.push(dispose);
    expect(listControlActions()).toContain('missions.list');
    await expect(runControlAction('missions.list', {})).rejects.toThrow(/SQLITE_CANTOPEN/);
  });

  it('maps mission summaries to the dashboard shape', async () => {
    disposers.push(await registerMissionControl({ defaultCwd: dir }));
    const m = store.create({ goal: 'Plan a trip', cwd: dir });
    const list = await runControlAction('missions.list', { limit: 5 }) as Array<Record<string, unknown>>;
    const row = list.find(x => x.id === m.id)!;
    expect(row).toBeDefined();
    expect(row.goal).toBe('Plan a trip');
    expect(row.steps).toBeUndefined();
    expect(typeof row.updatedAt).toBe('string');
  });
});
