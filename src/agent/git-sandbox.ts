/**
 * Git-Backed Sandbox & Safe Backtracking.
 *
 * The fear with an autonomous agent is that it dirties the repo with dead-end
 * experiments. The fix: run a complex task on a hidden throwaway branch
 * (`qodex/sandbox-<id>`). The agent codes, runs tests, hits runtime errors, and
 * — if a line of reasoning is a dead end — can `reset --hard` back to a marked
 * checkpoint and try a different approach, all off the user's working branch.
 * The user only sees the final, test-passing result merged back; the messy
 * trial-and-error stays backstage.
 *
 * Lifecycle:
 *   begin()      → stash any dirty changes, create + checkout the sandbox branch
 *                  from the current HEAD, record the origin branch.
 *   checkpoint() → tag a known-good point (a lightweight commit) the agent can
 *                  return to.
 *   backtrack()  → `git reset --hard` to the last checkpoint (or the sandbox
 *                  base) — the autonomous "this approach is wrong, undo it" lever.
 *   finish(ok)   → if ok: squash the sandbox into ONE commit on the origin branch
 *                  (clean history, user sees a single change); restore the dirty
 *                  stash on top. If !ok: abandon the branch entirely, restore the
 *                  user's original state untouched.
 *
 * Everything is best-effort and reversible: any git failure aborts the sandbox
 * and leaves the user on their original branch. Non-git dirs → sandbox disabled,
 * the agent runs normally (no isolation, same as today).
 *
 * This module owns ONLY git mechanics. The decision of WHEN to sandbox/backtrack
 * lives in the agent loop / orchestration, keeping concerns separated.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { git, isGitRepo } from '../tools/git/git-runner.js';
import { logger } from '../utils/logger.js';
import { acquireLock, type LockHandle } from '../utils/file-lock.js';
import { writeFileAtomic } from '../utils/atomic-write.js';

export interface SandboxState {
  active: boolean;
  branch: string;
  originBranch: string;
  baseCommit: string;
  stashed: boolean;
  /** Message used to stash the user's pre-sandbox WIP; restored by message, not positionally. */
  stashMessage: string | null;
  checkpoints: string[]; // commit SHAs, oldest→newest
}

/**
 * On-disk recovery record written when begin() switches branches and cleared in
 * finish(). If the process is killed mid-task, this lets a later run detect the
 * orphaned sandbox branch + stash and offer to restore.
 */
export interface SandboxRecoveryRecord {
  version: 1;
  taskId: string;
  branch: string;
  originBranch: string;
  baseCommit: string;
  stashed: boolean;
  stashMessage: string | null;
  pid: number;
  startedAt: string; // ISO
}

export interface OrphanedSandbox {
  /** The recovery record from the killed run, if one was persisted. */
  record: SandboxRecoveryRecord | null;
  /** Sandbox branches still present (qodex/sandbox-*). */
  branches: string[];
  /** Any matching pre-sandbox WIP stashes still on the stash list (newest first). */
  stashes: { ref: string; message: string }[];
}

/**
 * Result of finish(). Discriminated so the caller can tell apart a genuine
 * "no committed changes to merge" (empty) from a real failure (the merge threw
 * or conflicted) — the latter must NOT be reported to the user as benign.
 */
export type FinishResult =
  | { merged: true }
  | { merged: false; reason: 'empty' | 'conflict' | 'error'; error?: string };

/** Resolve the repo root (toplevel) for the given cwd, or null if not a repo. */
async function repoToplevel(cwd: string, signal?: AbortSignal): Promise<string | null> {
  const r = await git(['rev-parse', '--show-toplevel'], { cwd, signal, timeoutMs: 5000 });
  const top = r.stdout.trim();
  return r.exitCode === 0 && top ? top : null;
}

/** Path to the per-repo advisory sandbox lock. */
function sandboxLockPath(repoRoot: string): string {
  return path.join(repoRoot, '.qodex', 'sandbox.lock');
}

/** Path to the per-repo recovery record. */
function recoveryRecordPath(repoRoot: string): string {
  return path.join(repoRoot, '.qodex', 'sandbox-recovery.json');
}

export class GitSandbox {
  private state: SandboxState | null = null;
  /** Held across begin()→finish() so two sessions in one repo can't interleave. */
  private lock: LockHandle | null = null;
  /** Repo root resolved in begin(); where the lock + recovery record live. */
  private repoRoot: string | null = null;
  constructor(private cwd: string) {}

  isActive(): boolean {
    return this.state?.active === true;
  }

  get branch(): string | null {
    return this.state?.branch ?? null;
  }

  /** The commit the sandbox branched from — used to diff what the task changed. */
  baseCommitRef(): string | null {
    return this.state?.baseCommit ?? null;
  }

  /** Current branch name, or null if detached/unknown. */
  private async currentBranch(signal?: AbortSignal): Promise<string | null> {
    const r = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: this.cwd, signal });
    const name = r.stdout.trim();
    return (r.exitCode === 0) && name && name !== 'HEAD' ? name : null;
  }

  private async headSha(signal?: AbortSignal): Promise<string | null> {
    const r = await git(['rev-parse', 'HEAD'], { cwd: this.cwd, signal });
    return (r.exitCode === 0) ? r.stdout.trim() : null;
  }

  /**
   * Enter the sandbox. Returns true if isolation is now active, false if it
   * couldn't be set up (non-git, detached HEAD, etc.) — in which case the caller
   * proceeds without isolation.
   */
  async begin(taskId: string, signal?: AbortSignal): Promise<boolean> {
    let lock: LockHandle | null = null;
    try {
      if (!(await isGitRepo(this.cwd, signal))) {
        logger.debug('GitSandbox: not a git repo — running without isolation');
        return false;
      }
      const repoRoot = await repoToplevel(this.cwd, signal);
      if (!repoRoot) {
        logger.debug('GitSandbox: could not resolve repo root — skipping isolation');
        return false;
      }

      // Advisory repo lock: stop two sessions in one repo interleaving HEAD/stash
      // mutations. A short retry budget means a LIVE holder makes us decline (run
      // without isolation) rather than block; a dead holder's stale lock is
      // reclaimed by acquireLock's staleMs path. The lock dir must exist first.
      const lockPath = sandboxLockPath(repoRoot);
      await fs.mkdir(path.dirname(lockPath), { recursive: true }).catch(() => {});
      try {
        lock = await acquireLock(lockPath, { retries: 3, intervalMs: 150, staleMs: 30_000 });
      } catch {
        logger.info('GitSandbox: another session holds the sandbox lock — running without isolation');
        return false;
      }

      const origin = await this.currentBranch(signal);
      if (!origin) {
        logger.debug('GitSandbox: detached HEAD — skipping isolation');
        await lock.release();
        return false;
      }
      const base = await this.headSha(signal);
      if (!base) { await lock.release(); return false; }

      // Stash any uncommitted work so the sandbox starts from a clean tree and
      // the user's WIP is preserved untouched. The message is unique per task so
      // finish() can restore THIS stash by message, never another session's.
      const status = await git(['status', '--porcelain'], { cwd: this.cwd, signal });
      const dirty = (status.exitCode === 0) && status.stdout.trim().length > 0;
      const stashMessage = `qodex-sandbox-wip-${taskId}`;
      let stashed = false;
      if (dirty) {
        const s = await git(['stash', 'push', '-u', '-m', stashMessage], { cwd: this.cwd, signal });
        stashed = (s.exitCode === 0);
        if (!(s.exitCode === 0)) {
          logger.debug('GitSandbox: stash failed — skipping isolation to avoid touching dirty tree');
          await lock.release();
          return false;
        }
      }

      const branch = `qodex/sandbox-${taskId}`;
      const co = await git(['checkout', '-b', branch], { cwd: this.cwd, signal });
      if (!(co.exitCode === 0)) {
        // Roll back the stash if we made one, then bail.
        if (stashed) await this.restoreStashByMessage(stashMessage, signal);
        logger.debug('GitSandbox: branch create failed — no isolation', { err: co.stderr });
        await lock.release();
        return false;
      }

      this.repoRoot = repoRoot;
      this.lock = lock;
      this.state = {
        active: true, branch, originBranch: origin, baseCommit: base,
        stashed, stashMessage: stashed ? stashMessage : null, checkpoints: [],
      };
      // Persist a recovery record so a killed run can be detected/restored later.
      await this.writeRecoveryRecord(taskId, signal).catch(() => {});
      logger.info('GitSandbox active', { branch, origin });
      return true;
    } catch (e: any) {
      logger.debug('GitSandbox.begin failed', { err: e?.message });
      if (lock) await lock.release().catch(() => {});
      return false;
    }
  }

  /** Write the on-disk recovery record (atomic). Best-effort; never fatal. */
  private async writeRecoveryRecord(taskId: string, _signal?: AbortSignal): Promise<void> {
    if (!this.repoRoot || !this.state) return;
    const rec: SandboxRecoveryRecord = {
      version: 1,
      taskId,
      branch: this.state.branch,
      originBranch: this.state.originBranch,
      baseCommit: this.state.baseCommit,
      stashed: this.state.stashed,
      stashMessage: this.state.stashMessage,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    };
    await writeFileAtomic(recoveryRecordPath(this.repoRoot), JSON.stringify(rec, null, 2));
  }

  /**
   * Restore a stash identified by its push MESSAGE (not a positional `stash pop`,
   * which can cross-pop another session's WIP). Finds the matching ref via
   * `git stash list`, applies it, then drops it. Returns:
   *   'ok'       — applied and dropped cleanly,
   *   'missing'  — no stash with that message (nothing to do),
   *   'conflict' — apply hit conflicts (surfaced, NOT swallowed),
   *   'error'    — some other failure.
   */
  private async restoreStashByMessage(
    message: string,
    signal?: AbortSignal,
  ): Promise<'ok' | 'missing' | 'conflict' | 'error'> {
    const list = await git(['stash', 'list', '--format=%gd %gs'], { cwd: this.cwd, signal });
    if (list.exitCode !== 0) return 'error';
    // Lines look like: "stash@{0} On main: qodex-sandbox-wip-<id>"
    const line = list.stdout.split('\n').find((l) => l.includes(message));
    if (!line) return 'missing';
    const ref = line.trim().split(/\s+/)[0]; // e.g. stash@{0}
    if (!ref) return 'error';
    const ap = await git(['stash', 'apply', ref], { cwd: this.cwd, signal });
    if (ap.exitCode !== 0) {
      const out = `${ap.stdout ?? ''}\n${ap.stderr ?? ''}`;
      if (/conflict/i.test(out)) {
        logger.warn('GitSandbox: restoring WIP stash hit conflicts — left for manual resolution', { ref, message });
        return 'conflict';
      }
      logger.warn('GitSandbox: failed to apply WIP stash', { ref, message, err: (ap.stderr || ap.stdout || '').trim() });
      return 'error';
    }
    // Applied cleanly — drop it so it isn't restored twice.
    await git(['stash', 'drop', ref], { cwd: this.cwd, signal }).catch(() => {});
    return 'ok';
  }

  /** Commit current progress as a returnable checkpoint. Returns the SHA or null. */
  async checkpoint(label: string, signal?: AbortSignal): Promise<string | null> {
    if (!this.state?.active) return null;
    try {
      // Guard: only commit if HEAD is still our sandbox branch. If something moved
      // us off it (a concurrent op, a tool that switched branches), committing here
      // would dirty the wrong branch.
      const cur = await this.currentBranch(signal);
      if (cur !== this.state.branch) {
        logger.warn('GitSandbox.checkpoint: HEAD is not the sandbox branch — skipping', { expected: this.state.branch, actual: cur });
        return null;
      }
      await git(['add', '-A'], { cwd: this.cwd, signal });
      // Allow empty so a checkpoint with no changes still marks a return point.
      const c = await git(['commit', '--no-verify', '--allow-empty', '-m', `qodex checkpoint: ${label}`], { cwd: this.cwd, signal });
      if (!(c.exitCode === 0)) return null;
      const sha = await this.headSha(signal);
      if (sha) this.state.checkpoints.push(sha);
      return sha;
    } catch (e: any) {
      logger.debug('GitSandbox.checkpoint failed', { err: e?.message });
      return null;
    }
  }

  /**
   * Autonomous backtrack: hard-reset to the last checkpoint (or the sandbox base
   * if none). This is the "this approach is wrong — undo it" lever. Returns the
   * SHA we reset to, or null on failure.
   *
   * The last checkpoint is RETAINED (not popped): backtracking means "return to
   * the last known-good point", and you may need to return to it more than once
   * while trying different approaches from there. To walk further back, call
   * dropCheckpoint() first.
   */
  async backtrack(signal?: AbortSignal): Promise<string | null> {
    if (!this.state?.active) return null;
    try {
      // Safety: a `reset --hard` blows away the whole working tree of whatever
      // branch HEAD points at. NEVER do that unless HEAD is still our sandbox
      // branch — otherwise we'd destroy the user's real branch state.
      const cur = await this.currentBranch(signal);
      if (cur !== this.state.branch) {
        logger.warn('GitSandbox.backtrack: HEAD is not the sandbox branch — aborting reset --hard', { expected: this.state.branch, actual: cur });
        return null;
      }
      const target = this.state.checkpoints[this.state.checkpoints.length - 1] ?? this.state.baseCommit;
      const r = await git(['reset', '--hard', target], { cwd: this.cwd, signal });
      if (!(r.exitCode === 0)) return null;
      logger.info('GitSandbox backtracked', { to: target.slice(0, 8) });
      return target;
    } catch (e: any) {
      logger.debug('GitSandbox.backtrack failed', { err: e?.message });
      return null;
    }
  }

  /** Discard the most recent checkpoint so the next backtrack walks further back. */
  dropCheckpoint(): void {
    this.state?.checkpoints.pop();
  }

  /**
   * Leave the sandbox.
   *   ok=true  → squash all sandbox work into ONE commit on the origin branch.
   *   ok=false → abandon the sandbox branch; restore the user's original state.
   * Either way we return to the origin branch and pop the WIP stash.
   */
  async finish(ok: boolean, commitMessage: string, signal?: AbortSignal): Promise<FinishResult> {
    if (!this.state?.active) return { merged: false, reason: 'empty' };
    const { branch, originBranch, baseCommit, stashed, stashMessage } = this.state;
    // Distinguish a genuine "nothing to merge" (empty) from a real merge failure
    // (conflict/error). Default to 'empty' for the !ok abandon path; the ok path
    // overrides this when the squash actually fails.
    let merged = false;
    let failReason: 'empty' | 'conflict' | 'error' = 'empty';
    let failError: string | undefined;
    try {
      if (ok) {
        // Stage everything still uncommitted, then commit so squash captures it.
        await git(['add', '-A'], { cwd: this.cwd, signal });
        await git(['commit', '--no-verify', '--allow-empty', '-m', 'qodex sandbox final'], { cwd: this.cwd, signal });
        // Back to origin, squash-merge the diff from base→branch as a single commit.
        await git(['checkout', originBranch], { cwd: this.cwd, signal });
        const sq = await git(['merge', '--squash', branch], { cwd: this.cwd, signal });
        if ((sq.exitCode === 0)) {
          const c = await git(['commit', '--no-verify', '-m', commitMessage], { cwd: this.cwd, signal });
          merged = (c.exitCode === 0);
          if (!merged) {
            // Squash staged nothing → empty commit refused. That's a genuine
            // "no committed changes" case, not a failure.
            const out = `${c.stdout ?? ''}\n${c.stderr ?? ''}`;
            failReason = /nothing to commit|no changes added/i.test(out) ? 'empty' : 'error';
            if (failReason === 'error') failError = (c.stderr || c.stdout || '').trim() || undefined;
          }
        } else {
          // Merge itself failed (e.g. conflict) — surface it as a real failure.
          merged = false;
          const out = `${sq.stdout ?? ''}\n${sq.stderr ?? ''}`;
          failReason = /conflict|CONFLICT/.test(out) ? 'conflict' : 'error';
          failError = (sq.stderr || sq.stdout || '').trim() || undefined;
        }
        if (!merged) {
          // Squash had nothing or failed; ensure we at least left the branch.
          await git(['merge', '--abort'], { cwd: this.cwd, signal }).catch(() => {});
        }
      } else {
        // Abandon: just return to origin; the sandbox branch is left for forensics.
        await git(['checkout', '--force', originBranch], { cwd: this.cwd, signal });
        // Only hard-reset origin once we've confirmed we're actually on it — never
        // blow away whatever branch we happen to be on if the checkout failed.
        const cur = await this.currentBranch(signal);
        if (cur === originBranch) {
          await git(['reset', '--hard', baseCommit], { cwd: this.cwd, signal });
        } else {
          logger.warn('GitSandbox.finish: not on origin after checkout — skipping reset --hard', { expected: originBranch, actual: cur });
        }
      }
      // Delete the throwaway branch (best-effort).
      await git(['branch', '-D', branch], { cwd: this.cwd, signal }).catch(() => {});
      // Restore the user's pre-sandbox WIP via the SPECIFIC stash (by message),
      // never a positional pop that could cross-pop another session's stash. A
      // conflict is surfaced (logged), not silently swallowed.
      if (stashed && stashMessage) {
        await this.restoreStashByMessage(stashMessage, signal);
      }
    } catch (e: any) {
      logger.warn('GitSandbox.finish encountered an error; attempting to restore origin', { err: e?.message });
      await git(['checkout', '--force', originBranch], { cwd: this.cwd, signal }).catch(() => {});
      merged = false;
      failReason = /conflict/i.test(String(e?.message)) ? 'conflict' : 'error';
      failError = e?.message ? String(e.message) : undefined;
    } finally {
      // Clear the recovery record (we've finished cleanly enough to not orphan)
      // and release the repo lock so another session can sandbox.
      if (this.repoRoot) {
        await fs.unlink(recoveryRecordPath(this.repoRoot)).catch(() => {});
      }
      if (this.lock) {
        await this.lock.release().catch(() => {});
        this.lock = null;
      }
      this.repoRoot = null;
      this.state = null;
    }
    return merged ? { merged: true } : { merged: false, reason: failReason, error: failError };
  }
}

/**
 * Startup recovery: detect a leftover sandbox from a prior run that was killed
 * before finish() could clean up. Looks for the persisted recovery record, any
 * `qodex/sandbox-*` branches, and any `qodex-sandbox-wip-*` stashes, and returns
 * what it found so the loop can OFFER to restore (this function does NOT mutate
 * repo state — it only reports). Returns null if nothing orphaned is found.
 *
 * Not wired into the loop here (out of scope); exported for the caller to use.
 */
export async function recoverOrphanedSandbox(
  repoRoot: string,
  signal?: AbortSignal,
): Promise<OrphanedSandbox | null> {
  try {
    if (!(await isGitRepo(repoRoot, signal))) return null;

    // 1. The persisted recovery record, if any.
    let record: SandboxRecoveryRecord | null = null;
    try {
      const raw = await fs.readFile(recoveryRecordPath(repoRoot), 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === 1 && typeof parsed.branch === 'string') {
        record = parsed as SandboxRecoveryRecord;
      }
    } catch {
      /* no record (clean shutdown) or unreadable — fall through to git scan */
    }

    // 2. Leftover sandbox branches.
    const br = await git(['branch', '--list', 'qodex/sandbox-*', '--format=%(refname:short)'], { cwd: repoRoot, signal });
    const branches = br.exitCode === 0
      ? br.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
      : [];

    // 3. Leftover WIP stashes from a killed sandbox.
    const sl = await git(['stash', 'list', '--format=%gd %gs'], { cwd: repoRoot, signal });
    const stashes = sl.exitCode === 0
      ? sl.stdout.split('\n')
          .map((l) => l.trim())
          .filter((l) => l.includes('qodex-sandbox-wip-'))
          .map((l) => {
            const sp = l.split(/\s+/);
            return { ref: sp[0] ?? '', message: l.slice((sp[0] ?? '').length).trim() };
          })
          .filter((s) => s.ref)
      : [];

    if (!record && branches.length === 0 && stashes.length === 0) return null;
    return { record, branches, stashes };
  } catch (e: any) {
    logger.debug('recoverOrphanedSandbox failed', { err: e?.message });
    return null;
  }
}
