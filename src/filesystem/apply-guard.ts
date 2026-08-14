/**
 * Workspace apply-guard — process-wide compare-and-swap for file writes.
 *
 * OperatorHub multiplexes operator I/O. It does not own the disk. Main chat and
 * `/background` share a cwd, and the approval queue means the gap between
 * "I read this" and "I write this" can be minutes. A pessimistic lock held
 * across that gap would starve the other session.
 *
 * Instead:
 *   1. OCC at commit — write only if disk still equals the snapshot the edit
 *      was computed from (`base`).
 *   2. A brief exclusive apply (milliseconds) so two approved writes cannot
 *      interleave mid-CAS.
 *   3. Last-writer identity so the refused agent knows who won (`[bg1]`).
 *
 * The lock is NEVER held during LLM thinking or the approval prompt.
 */

import * as path from 'path';

export class FileChangedError extends Error {
  readonly code = 'FILE_CHANGED';
  constructor(
    public readonly fileLabel: string,
    public readonly otherSource: string | null,
  ) {
    const who = otherSource ? ` by [${otherSource}]` : ' by another process';
    super(
      `[FILE_CHANGED] ${fileLabel} was modified${who} since this edit was prepared. ` +
      `Re-read the file and apply your change against the current contents.`,
    );
    this.name = 'FileChangedError';
  }
}

export function isFileChangedError(err: unknown): err is FileChangedError {
  return err instanceof FileChangedError
    || (err instanceof Error && (err as { code?: string }).code === 'FILE_CHANGED');
}

/** Map a session id (`abc/bg1`, `abc/sub-…`) to the operator tag used in errors. */
export function operatorSourceFromSession(sessionId: string): string {
  const bg = sessionId.match(/\/(bg\d+)(?:\/|$)/);
  if (bg) return bg[1]!;
  if (sessionId.includes('/sub-')) return 'sub';
  if (sessionId.includes('/fanout-')) return 'fanout';
  return 'main';
}

export class ApplyGuard {
  private tails = new Map<string, Promise<unknown>>();
  private lastWriter = new Map<string, string>();

  key(absPath: string): string {
    return path.resolve(absPath);
  }

  last(absPath: string): string | undefined {
    return this.lastWriter.get(this.key(absPath));
  }

  noteWriter(absPath: string, source: string): void {
    this.lastWriter.set(this.key(absPath), source);
  }

  /**
   * Run `fn` with exclusive access to `absPath`. Waiters queue FIFO.
   * Previous failure does not poison the next holder.
   */
  async exclusive<T>(absPath: string, fn: () => Promise<T>): Promise<T> {
    const k = this.key(absPath);
    const prev = this.tails.get(k) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>(r => { release = r; });
    this.tails.set(k, done);
    await prev.then(() => undefined, () => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(k) === done) this.tails.delete(k);
    }
  }
}

let _guard: ApplyGuard | null = null;

export function getApplyGuard(): ApplyGuard {
  if (!_guard) _guard = new ApplyGuard();
  return _guard;
}

/** Tests only — a fresh guard so cases cannot leak into each other. */
export function resetApplyGuard(): ApplyGuard {
  _guard = new ApplyGuard();
  return _guard;
}
