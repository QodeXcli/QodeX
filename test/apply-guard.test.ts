import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import { promises as fs } from 'fs';
import {
  ApplyGuard,
  FileChangedError,
  operatorSourceFromSession,
  resetApplyGuard,
} from '../src/filesystem/apply-guard.js';
import { TransactionJournal } from '../src/filesystem/transaction.js';

describe('operatorSourceFromSession', () => {
  it('tags side runs, nested children, and the parent as main', () => {
    expect(operatorSourceFromSession('abc123')).toBe('main');
    expect(operatorSourceFromSession('abc123/bg1')).toBe('bg1');
    expect(operatorSourceFromSession('abc123/bg2/sub-99')).toBe('bg2');
    expect(operatorSourceFromSession('abc123/sub-171')).toBe('sub');
    expect(operatorSourceFromSession('abc123/fanout-3')).toBe('fanout');
  });
});

describe('ApplyGuard — brief exclusive apply', () => {
  let guard: ApplyGuard;
  beforeEach(() => { guard = resetApplyGuard(); });

  it('serializes two holders of the same path', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstParked = new Promise<void>(r => { releaseFirst = r; });
    let entered!: () => void;
    const firstEntered = new Promise<void>(r => { entered = r; });

    const a = guard.exclusive('/tmp/app.ts', async () => {
      order.push('a-in');
      entered();
      await firstParked;
      order.push('a-out');
      return 'A';
    });
    const b = guard.exclusive('/tmp/app.ts', async () => {
      order.push('b');
      return 'B';
    });

    await firstEntered;
    expect(order).toEqual(['a-in']);
    releaseFirst();
    expect(await Promise.all([a, b])).toEqual(['A', 'B']);
    expect(order).toEqual(['a-in', 'a-out', 'b']);
  });

  it('lets disjoint paths run together', async () => {
    let aStarted = false;
    let releaseA!: () => void;
    const aParked = new Promise<void>(r => { releaseA = r; });

    const a = guard.exclusive('/tmp/a.ts', async () => {
      aStarted = true;
      await aParked;
    });
    const b = guard.exclusive('/tmp/b.ts', async () => {
      expect(aStarted).toBe(true);
    });

    await b;
    releaseA();
    await a;
  });
});

describe('Transaction.write — OCC at commit', () => {
  beforeEach(() => { resetApplyGuard(); });

  async function tmpJournal() {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qodex-cas-'));
    const journal = new TransactionJournal(path.join(tmpDir, 'txn.db'), path.join(tmpDir, 'blobs'));
    return { tmpDir, journal };
  }

  it('writes when disk still matches the snapshot', async () => {
    const { tmpDir, journal } = await tmpJournal();
    const file = path.join(tmpDir, 'app.ts');
    await fs.writeFile(file, 'v1\n');

    const txn = await journal.begin('sess/bg1');
    await txn.write(file, 'v2\n', { base: 'v1\n', label: 'app.ts' });
    expect(await fs.readFile(file, 'utf-8')).toBe('v2\n');
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('refuses a stale snapshot and leaves disk untouched', async () => {
    const { tmpDir, journal } = await tmpJournal();
    const file = path.join(tmpDir, 'app.ts');
    await fs.writeFile(file, 'v1\n');

    const winner = await journal.begin('sess/bg1');
    await winner.write(file, 'from-bg1\n', { base: 'v1\n', label: 'app.ts' });

    const loser = await journal.begin('sess');
    const err = await loser.write(file, 'from-main\n', { base: 'v1\n', label: 'app.ts' }).catch(e => e);
    expect(err).toBeInstanceOf(FileChangedError);
    expect(err.message).toMatch(/\[FILE_CHANGED\]/);
    expect(err.message).toMatch(/\[bg1\]/);
    expect(await fs.readFile(file, 'utf-8')).toBe('from-bg1\n');
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('refuses a create when the file appeared in the meantime', async () => {
    const { tmpDir, journal } = await tmpJournal();
    const file = path.join(tmpDir, 'new.ts');

    await fs.writeFile(file, 'sneak\n');
    const txn = await journal.begin('sess');
    await expect(txn.write(file, 'mine\n', { base: null, label: 'new.ts' }))
      .rejects.toBeInstanceOf(FileChangedError);
    expect(await fs.readFile(file, 'utf-8')).toBe('sneak\n');
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('lets two concurrent same-file applies collide as one win + one FILE_CHANGED', async () => {
    const { tmpDir, journal } = await tmpJournal();
    const file = path.join(tmpDir, 'app.ts');
    await fs.writeFile(file, 'v1\n');

    const a = await journal.begin('sess/bg1');
    const b = await journal.begin('sess');
    const results = await Promise.allSettled([
      a.write(file, 'A\n', { base: 'v1\n', label: 'app.ts' }),
      b.write(file, 'B\n', { base: 'v1\n', label: 'app.ts' }),
    ]);

    const ok = results.filter(r => r.status === 'fulfilled');
    const bad = results.filter(r => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect((bad[0] as PromiseRejectedResult).reason).toBeInstanceOf(FileChangedError);

    const onDisk = await fs.readFile(file, 'utf-8');
    expect(onDisk === 'A\n' || onDisk === 'B\n').toBe(true);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('skips CAS when base is omitted (undo / restore paths)', async () => {
    const { tmpDir, journal } = await tmpJournal();
    const file = path.join(tmpDir, 'app.ts');
    await fs.writeFile(file, 'current\n');

    const txn = await journal.begin('sess');
    await txn.write(file, 'restored\n');
    expect(await fs.readFile(file, 'utf-8')).toBe('restored\n');
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
