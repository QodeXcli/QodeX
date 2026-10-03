/**
 * The Telegram ↔ missions bridge (src/missions/telegram-adapter.ts) against a
 * real MissionStore (SQLite in a temp dir): the shapes the bot relies on, the
 * mission-DB approval round trip, and the cross-process event feed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MissionStore, setMissionStoreForTests } from '../src/missions/store.js';
import { setMissionWorkerSpawner, setMissionsDirForTests, type WorkerSpawner } from '../src/missions/daemon.js';
import { createTelegramMissionAdapter } from '../src/missions/telegram-adapter.js';

let dir: string;
let store: MissionStore;
let spawned: Array<{ args: string[]; cwd?: string }>;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-tg-adapter-'));
  store = new MissionStore(path.join(dir, 'sessions.db'));
  setMissionStoreForTests(store);
  setMissionsDirForTests(path.join(dir, 'missions'));
  spawned = [];
  const fake: WorkerSpawner = (_command, args, opts) => {
    spawned.push({ args, cwd: opts.cwd as string | undefined });
    return { pid: process.pid, unref: () => {}, on: () => undefined };
  };
  setMissionWorkerSpawner(fake);
});

afterEach(() => {
  setMissionWorkerSpawner(null);
  setMissionsDirForTests(null);
  setMissionStoreForTests(null);
});

describe('createTelegramMissionAdapter', () => {
  it('starts a mission from Telegram in the configured directory', async () => {
    const ad = createTelegramMissionAdapter({ store, defaultCwd: dir });
    const r = await ad.start('مقایسه قیمت مانیتور');
    expect(r.id).toMatch(/^m/);
    const row = store.get(r.id)!;
    expect(row.source).toBe('telegram');
    expect(row.cwd).toBe(path.resolve(dir));
    expect(spawned).toHaveLength(1);
    const list = await ad.list(5);
    expect(list[0]).toMatchObject({ id: r.id, goal: 'مقایسه قیمت مانیتور' });
    expect(typeof list[0].createdAt).toBe('number');
  });

  it('maps status (by prefix), steps, milestones and approvals', async () => {
    const ad = createTelegramMissionAdapter({ store, defaultCwd: dir });
    const m = store.create({ goal: 'book a table', cwd: dir });
    store.replaceSteps(m.id, [
      { id: 's1', title: 'search', instruction: 'find places', depends_on: [] },
      { id: 's2', title: 'reserve', instruction: 'book one', depends_on: ['s1'] },
    ]);
    store.updateStep(m.id, 's1', { status: 'done' });
    store.appendEvent(m.id, 'milestone', { title: 'found 3 places' });
    store.update(m.id, { live_url: 'http://127.0.0.1:7420/?k=tok' });
    store.createApproval({ id: 'ap_x1', missionId: m.id, prompt: 'Reserve for 2?', options: ['yes', 'no'], category: 'purchase', risk: 'high' });

    const st = (await ad.status(m.id.slice(0, 5)))!;
    expect(st.id).toBe(m.id);
    expect(st.steps).toEqual([{ title: 'search', status: 'done' }, { title: 'reserve', status: 'pending' }]);
    expect(st.progress).toBe('1/2 steps');
    expect(st.milestones).toEqual(['found 3 places']);
    expect(st.pendingApprovals).toBe(1);
    expect(await ad.status('nope-nope')).toBeNull();

    expect(await ad.pendingApprovals()).toEqual([
      { id: 'ap_x1', missionId: m.id, prompt: 'Reserve for 2?', options: ['yes', 'no'], category: 'purchase', risk: 'high' },
    ]);
  });

  it('resolves a mission approval once, recording who answered', async () => {
    const ad = createTelegramMissionAdapter({ store, defaultCwd: dir });
    const m = store.create({ goal: 'pay the bill', cwd: dir });
    store.createApproval({ id: 'ap_pay', missionId: m.id, prompt: 'Pay 120,000 Toman?', options: ['yes', 'no'], category: 'payment' });
    expect(await ad.resolveApproval('ap_pay', 'no', 'telegram:@alice')).toBe(true);
    const row = store.getApproval('ap_pay')!;
    expect(row.status).toBe('denied');
    expect(row.resolved_by).toBe('telegram:@alice');
    // A second answer (another chat, a double tap) does not overwrite the first.
    expect(await ad.resolveApproval('ap_pay', 'yes', 'telegram:@bob')).toBe(false);
    expect(store.getApproval('ap_pay')!.status).toBe('denied');
    expect(await ad.pendingApprovals()).toEqual([]);
    expect(await ad.resolveApproval('ap_unknown', 'yes', 'telegram:@alice')).toBe(false);
  });

  it('feeds milestones and terminal status changes, starting from "now"', async () => {
    const ad = createTelegramMissionAdapter({ store, defaultCwd: dir });
    const m = store.create({ goal: 'old work', cwd: dir });
    store.appendEvent(m.id, 'milestone', { title: 'history' });
    const first = await ad.eventsSince!(null);
    expect(first.events).toEqual([]);
    expect(first.cursor).toBe(store.maxEventId());

    store.appendEvent(m.id, 'milestone', { title: 'logged in', progress: 0.5 });
    store.setStatus(m.id, 'running');
    store.appendEvent(m.id, 'step-start', { title: 'x' });
    store.update(m.id, { report: 'Booked table 4 at 20:00' });
    store.setStatus(m.id, 'completed');
    const next = await ad.eventsSince!(first.cursor);
    expect(next.events.map((e) => e.type)).toEqual(['milestone', 'completed']);
    expect(next.events[0].data).toMatchObject({ title: 'logged in', progress: 0.5 });
    expect(next.events[1].data).toMatchObject({ status: 'completed', report: 'Booked table 4 at 20:00' });
    expect(next.cursor).toBe(store.maxEventId());
    expect((await ad.eventsSince!(next.cursor)).events).toEqual([]);
  });

  it('cancels an active mission and refuses a finished one', async () => {
    const ad = createTelegramMissionAdapter({ store, defaultCwd: dir });
    const m = store.create({ goal: 'long job', cwd: dir });
    expect(await ad.cancel(m.id)).toBe(true);
    const done = store.create({ goal: 'done job', cwd: dir });
    store.setStatus(done.id, 'completed');
    expect(await ad.cancel(done.id)).toBe(false);
    expect(await ad.cancel('m_missing')).toBe(false);
  });
});
