import { describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';
import Database from 'better-sqlite3';
import { ScheduleStore } from '../src/schedule/store.js';
import { tick, type SpawnFn } from '../src/schedule/runner.js';
import { continuityPrompt, decideChange, answerFingerprint, keepForContinuity, CONTINUITY_MAX_CHARS } from '../src/schedule/continuity.js';

function fakeChild(stdout: string, code = 0): any {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  setTimeout(() => {
    child.stderr.emit('data', Buffer.from(`log noise ${Math.random()}\n`)); // stderr never counts as the answer
    child.stdout.emit('data', Buffer.from(stdout));
    child.emit('close', code, null);
  }, 5);
  return child;
}

describe('continuity helpers', () => {
  it('carries the previous answer and asks for changes only', () => {
    expect(continuityPrompt('Check the price', null)).toBe('Check the price');
    const p = continuityPrompt('Check the price', 'Price: $19');
    expect(p).toMatch(/^Check the price/);
    expect(p).toMatch(/PREVIOUS_RUN\nPrice: \$19\n/);
    expect(p).toMatch(/No change since the last run\./);
  });

  it('cosmetic differences are not a change; real ones are', () => {
    expect(answerFingerprint('\x1b[32mPrice: $19\x1b[0m\n\n')).toBe(answerFingerprint('  Price: $19'));
    expect(answerFingerprint('Price: $19')).not.toBe(answerFingerprint('Price: $18'));
    const prev = answerFingerprint('Price: $19');
    expect(decideChange('Price: $19', prev, true)).toMatchObject({ notify: false });
    expect(decideChange('Price: $18', prev, true)).toMatchObject({ notify: true });
    expect(decideChange('Price: $19', prev, false)).toMatchObject({ notify: true });
    expect(decideChange('Checked.\nNo change since the last run.', 'other', true)).toMatchObject({ notify: false });
    expect(keepForContinuity('x'.repeat(CONTINUITY_MAX_CHARS + 50)).length).toBe(CONTINUITY_MAX_CHARS + 1);
  });
});

describe('schedule continuity through the real runner', () => {
  it('run 2 sees run 1\'s answer; an unchanged answer is not notified', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-sched-cont-'));
    const dbPath = path.join(dir, 'sessions.db');
    const store = new ScheduleStore(dbPath);
    const e = store.add({ name: 'price', cron: '0 * * * *', prompt: 'Check the price of the mouse', cwd: dir, continuity: true, notifyOnChange: true });
    const db = new Database(dbPath);
    const makeDue = () => db.prepare(`UPDATE schedules SET next_run_at = ? WHERE id = ?`).run(new Date(Date.now() - 60_000).toISOString(), e.id);
    const prompts: string[] = [];
    const answers = ['Price: $19', 'Price: $19', 'Price: $17'];
    const spawnFn: SpawnFn = ((_cmd: string, args: string[]) => { prompts.push(args[args.indexOf('--print') + 1]!); return fakeChild(answers[prompts.length - 1]!); }) as SpawnFn;
    const logDir = path.join(dir, 'logs');
    const opts = { store, lockPath: path.join(dir, 'scheduler.lock'), logDir, spawnFn, cli: { command: 'qodex', prefix: [] }, notify: false };

    for (let i = 0; i < 3; i++) { makeDue(); expect((await tick(opts)).ranIds).toEqual([e.id]); }

    expect(prompts[0]).toBe('Check the price of the mouse');            // nothing to carry yet
    expect(prompts[1]).toMatch(/PREVIOUS_RUN\nPrice: \$19\n/);           // run 2 sees run 1
    expect(prompts[2]).toMatch(/PREVIOUS_RUN\nPrice: \$19\n/);
    const logs = (await fs.readdir(logDir)).sort();
    const texts = await Promise.all(logs.map(f => fs.readFile(path.join(logDir, f), 'utf8')));
    const skipped = texts.filter(t => /# not notifying: same answer/.test(t));
    expect(skipped).toHaveLength(1);                                      // only the unchanged 2nd run
    expect(store.get(e.id)!.last_output).toBe('Price: $17');
    db.close();
  });

  it('plain schedules are unchanged (no continuity, always notify)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-sched-plain-'));
    const store = new ScheduleStore(path.join(dir, 'sessions.db'));
    const e = store.add({ name: 'plain', cron: '* * * * *', prompt: 'hello', cwd: dir });
    expect(e.continuity).toBe(0);
    expect(e.notify_on ?? null).toBeNull();
  });
});
