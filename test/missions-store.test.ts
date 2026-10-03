import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import Database from 'better-sqlite3';
import { MissionStore, isProcessAlive, stepDeps, approvalOptions } from '../src/missions/store.js';

describe('MissionStore', () => {
  let dir: string;
  let dbPath: string;
  let store: MissionStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-missions-store-'));
    dbPath = path.join(dir, 'sessions.db');
    store = new MissionStore(dbPath);
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('creates, gets, resolves by prefix and lists newest first', () => {
    const a = store.create({ goal: 'first goal', cwd: dir, source: 'cli' });
    const b = store.create({ goal: 'second goal', cwd: dir, model: 'm-x', approvalMode: 'auto', costCapUsd: 5 });
    expect(a.id).toMatch(/^m[0-9a-f]{8}$/);
    expect(a.status).toBe('planning');
    expect(a.approval_mode).toBe('ask');
    expect(b.approval_mode).toBe('auto');
    expect(b.cost_cap_usd).toBe(5);
    expect(b.model).toBe('m-x');
    expect(store.get(a.id)?.goal).toBe('first goal');
    expect(store.resolve(a.id.slice(0, 6))?.id).toBe(a.id);
    expect(store.resolve('zz')).toBeUndefined();
    const ids = store.list().map(m => m.id);
    expect(ids).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(store.list({ cwd: dir }).length).toBe(2);
    expect(store.list({ statuses: ['running'] })).toHaveLength(0);
    expect(store.latest(dir)).toBeTruthy();
    expect(() => store.create({ goal: '   ', cwd: dir })).toThrow(/MISSION_INVALID/);
  });

  it('records a created event and appends/reads events since an id', () => {
    const m = store.create({ goal: 'g', cwd: dir });
    const evs = store.events(m.id);
    expect(evs[0]!.type).toBe('created');
    const id1 = store.appendEvent(m.id, 'milestone', { title: 'one' });
    const id2 = store.appendEvent(m.id, 'tool', { name: 'shell' });
    expect(store.events(m.id, id1).map(e => e.id)).toEqual([id2]);
    expect(store.events(m.id, 0, { types: ['milestone'] })[0]!.payload.title).toBe('one');
    expect(store.recentEvents(m.id, 1)[0]!.id).toBe(id2);
    expect(store.lastEventId(m.id)).toBe(id2);
    expect(store.maxEventId()).toBeGreaterThanOrEqual(id2);
    expect(store.eventsAfter(id1).map(e => e.id)).toEqual([id2]);
  });

  it('status transitions stamp started/finished and log a status event', () => {
    const m = store.create({ goal: 'g', cwd: dir });
    store.setStatus(m.id, 'running');
    const r = store.get(m.id)!;
    expect(r.status).toBe('running');
    expect(r.started_at).toBeTruthy();
    expect(r.finished_at).toBeNull();
    store.setStatus(m.id, 'failed', { error: 'boom' });
    expect(store.get(m.id)!.finished_at).toBeTruthy();
    expect(store.get(m.id)!.error).toBe('boom');
    store.setStatus(m.id, 'running', { error: null });
    expect(store.get(m.id)!.finished_at).toBeNull();
    expect(store.get(m.id)!.error).toBeNull();
    expect(store.events(m.id, 0, { types: ['status'] }).length).toBe(3);
  });

  it('updates fields, usage and the cancel flag', () => {
    const m = store.create({ goal: 'g', cwd: dir });
    store.update(m.id, { plan_json: '{"steps":[]}', live_url: 'http://x', pid: 123 });
    store.addUsage(m.id, { costUsd: 0.5, tokensIn: 100, tokensOut: 20 });
    store.addUsage(m.id, { costUsd: 0.25, tokensIn: 1, tokensOut: 1 });
    const r = store.get(m.id)!;
    expect(r.plan_json).toBe('{"steps":[]}');
    expect(r.live_url).toBe('http://x');
    expect(r.pid).toBe(123);
    expect(r.cost_usd).toBeCloseTo(0.75);
    expect(r.tokens_in).toBe(101);
    expect(store.isCancelRequested(m.id)).toBe(false);
    expect(store.requestCancel(m.id)).toBe(true);
    expect(store.isCancelRequested(m.id)).toBe(true);
    store.clearCancel(m.id);
    expect(store.isCancelRequested(m.id)).toBe(false);
  });

  it('steps CRUD, resets and deps parsing', () => {
    const m = store.create({ goal: 'g', cwd: dir });
    store.replaceSteps(m.id, [
      { id: 's1', title: 'one', instruction: 'do one', depends_on: [] },
      { id: 's2', title: 'two', instruction: 'do two', depends_on: ['s1'] },
    ]);
    const steps = store.steps(m.id);
    expect(steps.map(s => s.id)).toEqual(['s1', 's2']);
    expect(stepDeps(steps[1]!)).toEqual(['s1']);
    store.updateStep(m.id, 's1', { status: 'running', attempts: 1, session_id: 'sess' });
    store.updateStep(m.id, 's2', { status: 'failed', attempts: 2, error: 'x' });
    store.addStepCost(m.id, 's1', 0.1);
    expect(store.getStep(m.id, 's1')!.cost_usd).toBeCloseTo(0.1);
    expect(store.resetRunningSteps(m.id)).toBe(1);
    expect(store.getStep(m.id, 's1')!.status).toBe('pending');
    expect(store.resetFailedSteps(m.id)).toBe(1);
    const s2 = store.getStep(m.id, 's2')!;
    expect(s2.status).toBe('pending');
    expect(s2.attempts).toBe(0);
    expect(s2.error).toBeNull();
    // replace is atomic and complete
    store.replaceSteps(m.id, [{ id: 'x', title: 't', instruction: 'i', depends_on: [] }]);
    expect(store.steps(m.id).map(s => s.id)).toEqual(['x']);
  });

  it('approvals: create (idempotent), list, resolve with normalization, first resolver wins', () => {
    const m = store.create({ goal: 'g', cwd: dir });
    store.setStatus(m.id, 'running');
    const a = store.createApproval({ id: 'ap_1', missionId: m.id, stepId: 's1', prompt: 'Run x?', options: ['yes', 'no', 'always'], category: 'other' });
    store.createApproval({ id: 'ap_1', missionId: m.id, prompt: 'dup', options: ['yes'] });
    expect(store.getApproval('ap_1')!.prompt).toBe('Run x?');
    expect(approvalOptions(a)).toEqual(['yes', 'no', 'always']);
    expect(store.listPendingApprovals(m.id)).toHaveLength(1);
    expect(store.listPendingApprovals()).toHaveLength(1);
    expect(store.markAwaitingApproval(m.id)).toBe(true);
    expect(store.get(m.id)!.status).toBe('awaiting_approval');

    const bad = store.resolveApproval('ap_1', 'maybe', 'cli');
    expect(bad.ok).toBe(false);
    expect(bad.reason).toMatch(/APPROVAL_BAD_ANSWER/);

    const ok = store.resolveApproval('ap_1', 'بله', 'telegram');
    expect(ok).toEqual({ ok: true, answer: 'yes', status: 'approved' });
    const again = store.resolveApproval('ap_1', 'no', 'cli');
    expect(again.ok).toBe(false);
    expect(store.getApproval('ap_1')!.resolved_by).toBe('telegram');
    expect(store.clearAwaitingApproval(m.id)).toBe(true);
    expect(store.get(m.id)!.status).toBe('running');

    store.createApproval({ id: 'ap_2', missionId: m.id, prompt: 'Edit file?', options: ['accept', 'edit', 'continue', 'reject'] });
    expect(store.resolveApproval('ap_2', 'no', 'cli')).toMatchObject({ ok: true, answer: 'reject', status: 'denied' });
    store.createApproval({ id: 'ap_3', missionId: m.id, prompt: 'Edit file?', options: ['accept', 'edit', 'continue', 'reject'] });
    expect(store.resolveApproval('ap_3', 'yes', 'cli')).toMatchObject({ ok: true, answer: 'accept', status: 'approved' });
    store.createApproval({ id: 'ap_4', missionId: m.id, prompt: 'Edit?', options: ['accept', 'edit', 'continue', 'reject'] });
    expect(store.resolveApproval('ap_4', 'edit', 'cli')).toMatchObject({ ok: true, answer: 'edit', status: 'answered' });
    expect(store.resolveApprovalId(m.id, 'ap_')).toBeUndefined(); // ambiguous
    expect(store.resolveApprovalId(m.id, 'ap_4')!.id).toBe('ap_4');
  });

  it('expires pending approvals', () => {
    const m = store.create({ goal: 'g', cwd: dir });
    store.createApproval({ id: 'ap_x', missionId: m.id, prompt: 'p', options: ['yes', 'no'] });
    store.createApproval({ id: 'ap_y', missionId: m.id, prompt: 'p', options: ['yes', 'no'] });
    expect(store.expirePendingApprovals(m.id, 'test')).toBe(2);
    expect(store.getApproval('ap_x')!.status).toBe('expired');
    expect(store.listPendingApprovals(m.id)).toHaveLength(0);
  });

  it('isProcessAlive and reconcile of a dead worker', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(null)).toBe(false);
    expect(isProcessAlive(2 ** 22 + 12345)).toBe(false);

    const m = store.create({ goal: 'g', cwd: dir });
    store.replaceSteps(m.id, [{ id: 's1', title: 't', instruction: 'i', depends_on: [] }]);
    store.updateStep(m.id, 's1', { status: 'running' });
    store.setStatus(m.id, 'running');
    store.update(m.id, { pid: 2 ** 22 + 12345 });
    store.createApproval({ id: 'ap_d', missionId: m.id, prompt: 'p', options: ['yes', 'no'] });
    const r = store.reconcile(m.id)!;
    expect(r.status).toBe('paused');
    expect(r.error).toMatch(/exited unexpectedly/);
    expect(store.getStep(m.id, 's1')!.status).toBe('pending');
    expect(store.getApproval('ap_d')!.status).toBe('expired');

    const c = store.create({ goal: 'g2', cwd: dir });
    store.setStatus(c.id, 'running');
    store.update(c.id, { pid: 2 ** 22 + 12345 });
    store.requestCancel(c.id);
    expect(store.reconcile(c.id)!.status).toBe('cancelled');

    // A live worker (this process) is left alone.
    const live = store.create({ goal: 'g3', cwd: dir });
    store.setStatus(live.id, 'running');
    store.update(live.id, { pid: process.pid });
    expect(store.reconcile(live.id)!.status).toBe('running');
  });

  it('removing a mission cascades to steps/events/approvals', () => {
    const m = store.create({ goal: 'g', cwd: dir });
    store.replaceSteps(m.id, [{ id: 's1', title: 't', instruction: 'i', depends_on: [] }]);
    store.createApproval({ id: 'ap_r', missionId: m.id, prompt: 'p', options: ['yes', 'no'] });
    expect(store.remove(m.id)).toBe(true);
    expect(store.steps(m.id)).toHaveLength(0);
    expect(store.events(m.id)).toHaveLength(0);
    expect(store.getApproval('ap_r')).toBeUndefined();
  });

  it('migrations are idempotent and upgrade an older schema without losing rows', async () => {
    // A second instance on the same DB is a no-op migration.
    const again = new MissionStore(dbPath);
    const m = again.create({ goal: 'g', cwd: dir });
    expect(new MissionStore(dbPath).get(m.id)!.goal).toBe('g');

    // An older DB: v1 tables without the late columns.
    const oldPath = path.join(dir, 'old.db');
    const raw = new Database(oldPath);
    raw.exec(`
      CREATE TABLE missions (id TEXT PRIMARY KEY, goal TEXT NOT NULL, cwd TEXT NOT NULL, model TEXT,
        status TEXT NOT NULL DEFAULT 'planning', pid INTEGER, plan_json TEXT, report TEXT, live_url TEXT,
        cancel_requested INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        started_at TEXT, finished_at TEXT, cost_usd REAL NOT NULL DEFAULT 0, tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0, error TEXT);
      CREATE TABLE mission_steps (mission_id TEXT NOT NULL, id TEXT NOT NULL, idx INTEGER NOT NULL, title TEXT NOT NULL,
        instruction TEXT NOT NULL, depends_on_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'pending',
        session_id TEXT, attempts INTEGER NOT NULL DEFAULT 0, result TEXT, started_at TEXT, finished_at TEXT,
        PRIMARY KEY (mission_id, id));
      CREATE TABLE mission_approvals (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, step_id TEXT, prompt TEXT NOT NULL,
        options_json TEXT NOT NULL, category TEXT, status TEXT NOT NULL DEFAULT 'pending', answer TEXT, resolved_by TEXT,
        created_at TEXT NOT NULL, resolved_at TEXT);
      INSERT INTO missions (id, goal, cwd, created_at, updated_at) VALUES ('mold', 'legacy', '/tmp', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
      INSERT INTO mission_steps (mission_id, id, idx, title, instruction) VALUES ('mold', 's1', 0, 't', 'i');
    `);
    raw.close();
    const upgraded = new MissionStore(oldPath);
    const legacy = upgraded.get('mold')!;
    expect(legacy.goal).toBe('legacy');
    expect(legacy.approval_mode).toBe('ask');
    expect(legacy.cost_cap_usd).toBe(0);
    expect(upgraded.getStep('mold', 's1')!.cost_usd).toBe(0);
    upgraded.updateStep('mold', 's1', { error: 'ok' });
    expect(upgraded.getStep('mold', 's1')!.error).toBe('ok');
    // and re-opening it again is still fine
    expect(new MissionStore(oldPath).get('mold')!.goal).toBe('legacy');
  });
});
