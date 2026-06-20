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

import { git, isGitRepo } from '../tools/git/git-runner.js';
import { logger } from '../utils/logger.js';

export interface SandboxState {
  active: boolean;
  branch: string;
  originBranch: string;
  baseCommit: string;
  stashed: boolean;
  checkpoints: string[]; // commit SHAs, oldest→newest
}

/**
 * Result of finish(). Discriminated so the caller can tell apart a genuine
 * "no committed changes to merge" (empty) from a real failure (the merge threw
 * or conflicted) — the latter must NOT be reported to the user as benign.
 */
export type FinishResult =
  | { merged: true }
  | { merged: false; reason: 'empty' | 'conflict' | 'error'; error?: string };

export class GitSandbox {
  private state: SandboxState | null = null;
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
    try {
      if (!(await isGitRepo(this.cwd, signal))) {
        logger.debug('GitSandbox: not a git repo — running without isolation');
        return false;
      }
      const origin = await this.currentBranch(signal);
      if (!origin) {
        logger.debug('GitSandbox: detached HEAD — skipping isolation');
        return false;
      }
      const base = await this.headSha(signal);
      if (!base) return false;

      // Stash any uncommitted work so the sandbox starts from a clean tree and
      // the user's WIP is preserved untouched.
      const status = await git(['status', '--porcelain'], { cwd: this.cwd, signal });
      const dirty = (status.exitCode === 0) && status.stdout.trim().length > 0;
      let stashed = false;
      if (dirty) {
        const s = await git(['stash', 'push', '-u', '-m', `qodex-sandbox-wip-${taskId}`], { cwd: this.cwd, signal });
        stashed = (s.exitCode === 0);
        if (!(s.exitCode === 0)) {
          logger.debug('GitSandbox: stash failed — skipping isolation to avoid touching dirty tree');
          return false;
        }
      }

      const branch = `qodex/sandbox-${taskId}`;
      const co = await git(['checkout', '-b', branch], { cwd: this.cwd, signal });
      if (!(co.exitCode === 0)) {
        // Roll back the stash if we made one, then bail.
        if (stashed) await git(['stash', 'pop'], { cwd: this.cwd, signal });
        logger.debug('GitSandbox: branch create failed — no isolation', { err: co.stderr });
        return false;
      }

      this.state = { active: true, branch, originBranch: origin, baseCommit: base, stashed, checkpoints: [] };
      logger.info('GitSandbox active', { branch, origin });
      return true;
    } catch (e: any) {
      logger.debug('GitSandbox.begin failed', { err: e?.message });
      return false;
    }
  }

  /** Commit current progress as a returnable checkpoint. Returns the SHA or null. */
  async checkpoint(label: string, signal?: AbortSignal): Promise<string | null> {
    if (!this.state?.active) return null;
    try {
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
    const { branch, originBranch, baseCommit, stashed } = this.state;
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
        await git(['reset', '--hard', baseCommit], { cwd: this.cwd, signal });
      }
      // Delete the throwaway branch (best-effort).
      await git(['branch', '-D', branch], { cwd: this.cwd, signal }).catch(() => {});
      // Restore the user's pre-sandbox WIP.
      if (stashed) await git(['stash', 'pop'], { cwd: this.cwd, signal }).catch(() => {});
    } catch (e: any) {
      logger.warn('GitSandbox.finish encountered an error; attempting to restore origin', { err: e?.message });
      await git(['checkout', '--force', originBranch], { cwd: this.cwd, signal }).catch(() => {});
      merged = false;
      failReason = /conflict/i.test(String(e?.message)) ? 'conflict' : 'error';
      failError = e?.message ? String(e.message) : undefined;
    } finally {
      this.state = null;
    }
    return merged ? { merged: true } : { merged: false, reason: failReason, error: failError };
  }
}
