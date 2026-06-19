import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parseCron, matches, nextAfter } from '../src/schedule/cron.js';
import { ScheduleStore } from '../src/schedule/store.js';

describe('cron parser', () => {
  it('parses 5 fields', () => {
    const c = parseCron('* * * * *');
    expect(c.fields).toHaveLength(5);
    expect(c.fields[0]!.size).toBe(60);
    expect(c.fields[4]!.size).toBe(7);
  });

  it('parses ranges', () => {
    const c = parseCron('0-5 * * * *');
    expect([...c.fields[0]!].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('parses lists', () => {
    const c = parseCron('0,15,30,45 * * * *');
    expect([...c.fields[0]!].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
  });

  it('parses steps', () => {
    const c = parseCron('*/15 * * * *');
    expect([...c.fields[0]!].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
  });

  it('expands aliases', () => {
    expect(parseCron('@hourly').raw).toBe('@hourly');
    expect(parseCron('@daily').fields[1]!.has(0)).toBe(true);
    expect(parseCron('@weekly').fields[4]!.has(0)).toBe(true);
  });

  it('rejects malformed input', () => {
    expect(() => parseCron('not a cron')).toThrow();
    expect(() => parseCron('60 * * * *')).toThrow();
    expect(() => parseCron('* * * * * *')).toThrow();
  });

  it('matches the right minute', () => {
    const c = parseCron('30 14 * * *');
    expect(matches(c, new Date('2026-05-28T14:30:00'))).toBe(true);
    expect(matches(c, new Date('2026-05-28T14:31:00'))).toBe(false);
    expect(matches(c, new Date('2026-05-28T13:30:00'))).toBe(false);
  });

  it('nextAfter advances correctly', () => {
    const c = parseCron('@hourly');
    const next = nextAfter(c, new Date('2026-05-28T14:30:00'))!;
    expect(next.getHours()).toBe(15);
    expect(next.getMinutes()).toBe(0);
  });

  it('nextAfter handles daily', () => {
    const c = parseCron('@daily');
    const next = nextAfter(c, new Date('2026-05-28T14:30:00'))!;
    expect(next.getDate()).toBe(29);
    expect(next.getHours()).toBe(0);
    expect(next.getMinutes()).toBe(0);
  });

  it('day-of-month OR day-of-week (Vixie semantics)', () => {
    // "0 0 1 * 0" — first of month OR Sunday
    const c = parseCron('0 0 1 * 0');
    expect(matches(c, new Date('2026-06-01T00:00:00'))).toBe(true); // 1st
    expect(matches(c, new Date('2026-06-07T00:00:00'))).toBe(true); // Sunday
    expect(matches(c, new Date('2026-06-02T00:00:00'))).toBe(false); // Tuesday, 2nd
  });
});

describe('ScheduleStore', () => {
  let tmpDb: string;
  let store: ScheduleStore;

  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qodex-schedtest-'));
    tmpDb = path.join(dir, 'sched.db');
    store = new ScheduleStore(tmpDb);
  });

  it('rejects invalid cron on add', () => {
    expect(() => store.add({ name: 'x', cron: 'not-cron', prompt: 'p', cwd: '/tmp' })).toThrow();
  });

  it('adds, lists, removes', () => {
    const e = store.add({ name: 'nightly', cron: '@daily', prompt: 'do work', cwd: '/tmp' });
    expect(e.name).toBe('nightly');
    expect(e.next_run_at).toBeTruthy();
    expect(store.list()).toHaveLength(1);
    expect(store.remove(e.id)).toBe(true);
    expect(store.list()).toHaveLength(0);
  });

  it('resolves by id, prefix, or name', () => {
    const e = store.add({ name: 'foo', cron: '@hourly', prompt: 'p', cwd: '/tmp' });
    expect(store.resolve(e.id)?.id).toBe(e.id);
    expect(store.resolve('foo')?.id).toBe(e.id);
    expect(store.resolve(e.id.slice(0, 6))?.id).toBe(e.id);
  });

  it('enable/disable flips flag and recomputes next', () => {
    const e = store.add({ name: 'x', cron: '@daily', prompt: 'p', cwd: '/tmp' });
    const d = store.setEnabled(e.id, false);
    expect(d?.enabled).toBe(0);
    const e2 = store.setEnabled(e.id, true);
    expect(e2?.enabled).toBe(1);
    expect(e2?.next_run_at).toBeTruthy();
  });

  it('dueAsOf returns only enabled past-due entries', () => {
    const e = store.add({ name: 'now', cron: '@hourly', prompt: 'p', cwd: '/tmp' });
    // Force next_run_at into the past
    (store as any).db.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', e.id);
    const due = store.dueAsOf(new Date());
    expect(due.map(d => d.id)).toContain(e.id);
    store.setEnabled(e.id, false);
    const due2 = store.dueAsOf(new Date());
    expect(due2.map(d => d.id)).not.toContain(e.id);
  });

  it('recordRunFinish bumps counters and recomputes next', () => {
    const e = store.add({ name: 'x', cron: '@hourly', prompt: 'p', cwd: '/tmp' });
    const runId = store.recordRunStart(e.id);
    store.recordRunFinish(runId, e.id, 'success', 0, 'ok', 1234);
    const e2 = store.get(e.id)!;
    expect(e2.run_count).toBe(1);
    expect(e2.last_status).toBe('success');
    expect(e2.last_duration_ms).toBe(1234);
    const runs = store.recentRuns(e.id);
    expect(runs[0]!.status).toBe('success');
  });
});
