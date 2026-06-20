/**
 * Cross-process advisory file lock.
 *
 * Guards a read-modify-write sequence (load config → mutate → save, merge a
 * provider into .env, bump an artifact version) so two QodeX processes can't
 * interleave and silently lose each other's update. Uses `open(O_CREAT|O_EXCL)`
 * — the same primitive `schedule/runner.ts` already relies on — which is atomic
 * across processes on a local filesystem.
 *
 * The lock is advisory: it only protects code paths that call `withLock`. A
 * stale lock (holder crashed without releasing) is reclaimed after `staleMs`.
 */

import { promises as fs } from 'fs';

export interface LockOptions {
  /** Attempts before giving up. Default 50. */
  retries?: number;
  /** Delay between attempts, ms. Default 100. */
  intervalMs?: number;
  /** A lock file older than this (ms) is treated as stale and reclaimed. Default 30000. */
  staleMs?: number;
}

export interface LockHandle {
  release: () => Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Acquire `lockPath`, retrying while another process holds it. Throws if it
 * can't be acquired within the retry budget.
 */
export async function acquireLock(lockPath: string, opts: LockOptions = {}): Promise<LockHandle> {
  const retries = opts.retries ?? 50;
  const intervalMs = opts.intervalMs ?? 100;
  const staleMs = opts.staleMs ?? 30_000;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const fh = await fs.open(lockPath, 'wx'); // O_CREAT|O_EXCL → fails if held
      try {
        await fh.writeFile(`${process.pid} ${new Date().toISOString()}`);
      } finally {
        await fh.close();
      }
      let released = false;
      return {
        release: async () => {
          if (released) return;
          released = true;
          await fs.unlink(lockPath).catch(() => {});
        },
      };
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
      // Held by someone else — reclaim if stale, else wait and retry.
      try {
        const st = await fs.stat(lockPath);
        if (Date.now() - st.mtimeMs > staleMs) {
          await fs.unlink(lockPath).catch(() => {});
          continue; // retry immediately after reclaiming a stale lock
        }
      } catch {
        /* lock vanished between open and stat — just retry */
      }
      if (attempt < retries) await sleep(intervalMs);
    }
  }
  throw new Error(`Could not acquire lock ${lockPath} after ${retries} retries (held by another process?)`);
}

/** Run `fn` while holding `lockPath`; always releases, even on throw. */
export async function withLock<T>(lockPath: string, fn: () => Promise<T>, opts?: LockOptions): Promise<T> {
  const lock = await acquireLock(lockPath, opts);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}
