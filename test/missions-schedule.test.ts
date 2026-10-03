import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';
import Database from 'better-sqlite3';
import { ScheduleStore } from '../src/schedule/store.js';
import { tick, buildScheduleRunArgs, resolveCliCommand, LOCK_STALE_MS, RUN_HARD_KILL_MS, type SpawnFn } from '../src/schedule/runner.js';

function fakeChild(output: string, code = 0): any {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  setTimeout(() => {
    child.stdout.emit('data', Buffer.from(output));
    child.emit('close', code, null);
  }, 5);
  return child;
}

describe('schedule kinds (mission routines)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-missions-sched-'));
    dbPath = path.join(dir, 'sessions.db');
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('migrates an older schedules table with a kind column (idempotently)', () => {
    const raw = new Database(path.join(dir, 'old.db'));
    raw.exec(`CREATE TABLE schedules (id TEXT PRIMARY KEY, name TEXT NOT NULL, cron TEXT NOT NULL, prompt TEXT NOT NULL,
      cwd TEXT NOT NULL, model TEXT, allowed_tools TEXT, enabled INTEGER DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_run_at DATETIME, last_status TEXT, last_message TEXT, last_duration_ms INTEGER, next_run_at DATETIME, run_count INTEGER DEFAULT 0);
      INSERT INTO schedules (id, name, cron, prompt, cwd) VALUES ('old1', 'legacy', '@daily', 'p', '/tmp');`);
    raw.close();
    const s = new ScheduleStore(path.join(dir, 'old.db'));
    expect(s.get('old1')!.kind).toBe('prompt');
    const again = new ScheduleStore(path.join(dir, 'old.db'));
    const e = again.add({ name: 'm', cron: '@hourly', prompt: 'watch prices', cwd: dir, kind: 'mission' });
    expect(e.kind).toBe('mission');
    expect(again.add({ name: 'p', cron: '@hourly', prompt: 'x', cwd: dir }).kind).toBe('prompt');
  });

  it('builds run args per kind', () => {
    expect(buildScheduleRunArgs({ id: 'sch1', prompt: 'do x', cwd: '/w', model: 'm1', kind: 'prompt' }))
      .toEqual(['--print', 'do x', '--yes', '--model', 'm1']);
    expect(buildScheduleRunArgs({ id: 'sch1', prompt: '-check prices', cwd: '/w', kind: 'mission' }))
      .toEqual(['mission', 'start', '--yes', '--cwd', '/w', '--from-schedule', 'sch1', '--', '-check prices']);
    expect(buildScheduleRunArgs({ id: 'sch1', prompt: 'g', cwd: '/w', model: 'big', kind: 'mission' }))
      .toEqual(['mission', 'start', '--yes', '--cwd', '/w', '--from-schedule', 'sch1', '--model', 'big', '--', 'g']);
  });

  it('resolves the CLI command', () => {
    expect(resolveCliCommand({ QODEX_CLI_PATH: '/bin/q' }, ['node', '/x/qodex.mjs'])).toEqual({ command: '/bin/q', prefix: [] });
    expect(resolveCliCommand({}, ['node', '/usr/local/lib/qodex/bin/qodex.mjs'], '/usr/bin/node'))
      .toEqual({ command: '/usr/bin/node', prefix: ['/usr/local/lib/qodex/bin/qodex.mjs'] });
    expect(resolveCliCommand({}, ['node', '/usr/local/bin/qodex'], '/n')).toEqual({ command: '/n', prefix: ['/usr/local/bin/qodex'] });
    expect(resolveCliCommand({}, ['node', '/x/vitest.mjs'])).toEqual({ command: 'qodex', prefix: [] });
  });

  it('a stale lock outlives a hard-killed run (no double fire)', () => {
    expect(LOCK_STALE_MS).toBeGreaterThan(RUN_HARD_KILL_MS);
  });

  it('tick starts a mission for a due mission routine and records the run', async () => {
    const store = new ScheduleStore(dbPath);
    const e = store.add({ name: 'nightly mission', cron: '@hourly', prompt: 'Check the shop and report', cwd: dir, kind: 'mission' });
    (store as any).db.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', e.id);
    const calls: Array<{ command: string; args: string[]; cwd: unknown; env: any }> = [];
    const spawnFn: SpawnFn = (command, args, opts) => {
      calls.push({ command, args, cwd: opts.cwd, env: opts.env });
      return fakeChild('✓ Mission m1234abcd started in the background (worker pid 99).');
    };
    const lockPath = path.join(dir, 'scheduler.lock');
    const r = await tick({ store, lockPath, logDir: path.join(dir, 'logs'), spawnFn, cli: { command: '/usr/bin/node', prefix: ['/q/qodex.mjs'] }, notify: false });
    expect(r).toEqual({ ranIds: [e.id], skipped: [], failed: [], acquired: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('/usr/bin/node');
    expect(calls[0]!.args).toEqual(['/q/qodex.mjs', 'mission', 'start', '--yes', '--cwd', dir, '--from-schedule', e.id, '--', 'Check the shop and report']);
    expect(calls[0]!.env.QODEX_SCHEDULED).toBe('1');
    const run = store.recentRuns(e.id)[0]!;
    expect(run.status).toBe('success');
    expect(run.message).toContain('Mission m1234abcd started');
    expect(store.get(e.id)!.next_run_at! > new Date().toISOString()).toBe(true);
    await expect(fs.stat(lockPath)).rejects.toThrow(); // released
    const logs = await fs.readdir(path.join(dir, 'logs'));
    expect(await fs.readFile(path.join(dir, 'logs', logs[0]!), 'utf8')).toContain('# kind:     mission');
  });

  it('respects a lock held by a live process and steals one from a dead holder or a stale one', async () => {
    const store = new ScheduleStore(dbPath);
    const lockPath = path.join(dir, 'scheduler.lock');
    const opts = { store, lockPath, logDir: path.join(dir, 'logs'), spawnFn: (() => fakeChild('')) as SpawnFn, notify: false };

    await fs.writeFile(lockPath, `pid=${process.pid}\nstarted=now\n`);
    expect((await tick(opts)).acquired).toBe(false);

    await fs.writeFile(lockPath, `pid=${2 ** 22 + 99}\nstarted=then\n`);
    expect((await tick(opts)).acquired).toBe(true);

    await fs.writeFile(lockPath, `pid=${process.pid}\n`);
    const old = new Date(Date.now() - LOCK_STALE_MS - 60_000);
    await fs.utimes(lockPath, old, old);
    expect((await tick(opts)).acquired).toBe(true);

    // A lock in the legacy format (no pid) that is fresh still blocks.
    await fs.writeFile(lockPath, 'legacy\n');
    expect((await tick(opts)).acquired).toBe(false);
  });
});
