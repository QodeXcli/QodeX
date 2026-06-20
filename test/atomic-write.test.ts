import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeFileAtomic } from '../src/utils/atomic-write.js';
import { acquireLock, withLock } from '../src/utils/file-lock.js';

const dirs: string[] = [];
async function tmpDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-atomic-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true }).catch(() => {});
});

describe('writeFileAtomic', () => {
  it('writes the full contents', async () => {
    const d = await tmpDir();
    const f = path.join(d, 'config.yaml');
    await writeFileAtomic(f, 'hello: world\n');
    expect(await fs.readFile(f, 'utf-8')).toBe('hello: world\n');
  });

  it('replaces an existing file atomically (old content fully gone)', async () => {
    const d = await tmpDir();
    const f = path.join(d, 'x');
    await fs.writeFile(f, 'OLD');
    await writeFileAtomic(f, 'NEW');
    expect(await fs.readFile(f, 'utf-8')).toBe('NEW');
  });

  it('leaves no temp files behind on success', async () => {
    const d = await tmpDir();
    await writeFileAtomic(path.join(d, 'a'), 'data');
    const leftovers = (await fs.readdir(d)).filter((n) => n.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('applies mode 0o600 to a freshly created file (secrets)', async () => {
    const d = await tmpDir();
    const f = path.join(d, '.env');
    await writeFileAtomic(f, 'KEY=secret', { mode: 0o600 });
    const mode = (await fs.stat(f)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('does not corrupt the original when the write target dir is gone (cleans up, throws)', async () => {
    const d = await tmpDir();
    const f = path.join(d, 'sub', 'missing', 'file'); // parent dirs absent
    await expect(writeFileAtomic(f, 'x')).rejects.toBeTruthy();
    // no temp turds in the existing dir
    expect((await fs.readdir(d)).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });

  it('concurrent atomic writers never yield a partial file (always one full version)', async () => {
    const d = await tmpDir();
    const f = path.join(d, 'race');
    const big = (tag: string) => tag.repeat(100_000);
    await Promise.all([
      writeFileAtomic(f, big('A')),
      writeFileAtomic(f, big('B')),
      writeFileAtomic(f, big('C')),
    ]);
    const final = await fs.readFile(f, 'utf-8');
    // Whichever won, the file is exactly one writer's full content — never spliced.
    expect([big('A'), big('B'), big('C')]).toContain(final);
  });
});

describe('file-lock', () => {
  it('serializes a read-modify-write so no update is lost', async () => {
    const d = await tmpDir();
    const counterFile = path.join(d, 'counter');
    const lock = path.join(d, 'counter.lock');
    await fs.writeFile(counterFile, '0');

    // 20 concurrent increments, each a load→+1→store under the lock.
    await Promise.all(
      Array.from({ length: 20 }, () =>
        withLock(lock, async () => {
          const n = parseInt(await fs.readFile(counterFile, 'utf-8'), 10);
          await new Promise((r) => setTimeout(r, 1)); // widen the race window
          await fs.writeFile(counterFile, String(n + 1));
        }, { retries: 200, intervalMs: 5 }),
      ),
    );
    expect(parseInt(await fs.readFile(counterFile, 'utf-8'), 10)).toBe(20); // no lost updates
  });

  it('a second acquire blocks until the first releases', async () => {
    const d = await tmpDir();
    const lock = path.join(d, 'x.lock');
    const h1 = await acquireLock(lock);
    let got2 = false;
    const p2 = acquireLock(lock, { retries: 100, intervalMs: 5 }).then((h) => { got2 = true; return h; });
    await new Promise((r) => setTimeout(r, 30));
    expect(got2).toBe(false); // still blocked
    await h1.release();
    const h2 = await p2;
    expect(got2).toBe(true);
    await h2.release();
  });

  it('reclaims a stale lock', async () => {
    const d = await tmpDir();
    const lock = path.join(d, 'stale.lock');
    await fs.writeFile(lock, '99999 old'); // orphaned lock
    // staleMs tiny → treated as stale and reclaimed on first retry.
    const h = await acquireLock(lock, { staleMs: 0, retries: 5, intervalMs: 5 });
    await h.release();
    expect(true).toBe(true);
  });
});
