/**
 * Auto-snapshot service.
 *
 * Wraps a small set of destructive operations with an automatic `git stash` so the user
 * can roll back via `/undo` or `/snapshot restore` if things go wrong.
 *
 * What we snapshot before:
 *   - Bash commands matching the destructive-pattern set below (rm -rf, git reset --hard,
 *     force-push, npm uninstall, drop database, etc.)
 *   - Anything else explicitly tagged via .takeSnapshot()
 *
 * What we DON'T snapshot:
 *   - Non-git directories — git stash is the only mechanism here. We log + skip.
 *   - Working tree with no changes — there's nothing to stash; we log + skip.
 *   - Operations that touch files outside the working tree (e.g. ~/.config edits) — out
 *     of scope. Users should be using transactions for that.
 *
 * Retention:
 *   - Each snapshot is named with a recognisable prefix `qodex-auto/{sessionId}/{N}`
 *     so they're filterable in `git stash list` and not confused with the user's own
 *     stashes.
 *   - Auto-dropped after `snapshotRetentionTurns` turns (default 50) OR at session end.
 *   - Manual restore: `/snapshot restore N` pops a specific snapshot.
 *
 * Failure mode: any error in this layer is non-fatal — we log a warning and let the
 * destructive op proceed. This is a safety net, not a gate.
 */

import { spawnSync } from 'child_process';
import { logger } from '../utils/logger.js';

export interface SnapshotRecord {
  /** Index in `git stash list` at the time of creation. May drift if user runs stash manually. */
  initialIndex: number;
  /** Stash message used (matches our recognisable prefix pattern). */
  message: string;
  /** Wall-clock when taken. */
  createdAt: number;
  /** Turn number when taken — used by retention. */
  turn: number;
  /** Short description of why we took it. */
  reason: string;
}

/** Patterns that should trigger an automatic snapshot before running. Conservative. */
const DESTRUCTIVE_BASH_PATTERNS: Array<{ regex: RegExp; label: string }> = [
  { regex: /\brm\s+(-[rRf]+\s+)+/, label: 'rm -rf' },
  { regex: /\brm\s+-r\s+/, label: 'rm -r' },
  { regex: /\bgit\s+reset\s+--hard\b/, label: 'git reset --hard' },
  { regex: /\bgit\s+clean\s+-[df]/, label: 'git clean -df' },
  { regex: /\bgit\s+checkout\s+(-f|--force)\b/, label: 'git checkout --force' },
  { regex: /\bgit\s+push\s+(-f|--force)/, label: 'git push --force' },
  { regex: /\bgit\s+rebase\s+/, label: 'git rebase' },
  { regex: /\bgit\s+filter-(branch|repo)\b/, label: 'git filter-branch/repo' },
  { regex: /\bnpm\s+uninstall\b/, label: 'npm uninstall' },
  { regex: /\byarn\s+remove\b/, label: 'yarn remove' },
  { regex: /\bpnpm\s+remove\b/, label: 'pnpm remove' },
  { regex: /\b(drop|truncate)\s+(table|database|schema)\b/i, label: 'SQL DROP/TRUNCATE' },
  { regex: /\bdd\s+if=/, label: 'dd' },
  { regex: />\s*\/dev\/sd[a-z]/, label: 'redirect to block device' },
  { regex: /\bmkfs\b/, label: 'mkfs' },
];

/** Whether a given bash command warrants a pre-snapshot. */
export function isDestructiveBash(command: string): { destructive: boolean; label?: string } {
  for (const p of DESTRUCTIVE_BASH_PATTERNS) {
    if (p.regex.test(command)) return { destructive: true, label: p.label };
  }
  return { destructive: false };
}

export class SnapshotService {
  private snapshots: SnapshotRecord[] = [];
  private snapshotCounter = 0;
  private retentionTurns: number;

  constructor(
    private cwd: string,
    private sessionId: string,
    opts: { retentionTurns?: number } = {},
  ) {
    this.retentionTurns = opts.retentionTurns ?? 50;
  }

  /**
   * Take a snapshot of the current working tree.
   *
   * @returns the record if taken, or null if skipped (non-git repo / no changes / git failed).
   */
  takeSnapshot(reason: string, currentTurn: number): SnapshotRecord | null {
    // Verify we're in a git repo
    const inRepo = this.runGit(['rev-parse', '--is-inside-work-tree']);
    if (inRepo.exitCode !== 0 || inRepo.stdout.trim() !== 'true') {
      logger.info('Auto-snapshot skipped (not a git repo)', { reason });
      return null;
    }

    // Verify there are changes to stash; otherwise stash will succeed with nothing
    // captured and we'd accumulate empty noise.
    const dirty = this.runGit(['status', '--porcelain']);
    if (dirty.exitCode !== 0 || dirty.stdout.trim() === '') {
      logger.info('Auto-snapshot skipped (working tree clean)', { reason });
      return null;
    }

    this.snapshotCounter += 1;
    const message = `qodex-auto/${this.sessionId.slice(0, 8)}/${this.snapshotCounter} — ${reason}`;

    // Capture a snapshot (including untracked files) as a restore point WITHOUT
    // leaving the working tree reverted.
    //
    // `git stash push --include-untracked` records everything we want, but it
    // REVERTS the working tree to HEAD (the changes move into the stash and
    // leave the tree). The original code never re-applied it — so every snapshot
    // wiped the user's in-progress edits AND swept unrelated untracked files off
    // disk until /undo. We immediately `stash apply` to put the working tree
    // (and untracked files) back, while keeping the stash entry as the restore
    // point. If the re-apply fails, we pop it back so the user is never left
    // with a silently reverted tree, and report the snapshot as failed.
    const stash = this.runGit(['stash', 'push', '--include-untracked', '-m', message]);
    if (stash.exitCode !== 0) {
      logger.warn('Auto-snapshot failed', { error: stash.stderr.trim(), reason });
      return null;
    }
    const reapply = this.runGit(['stash', 'apply', 'stash@{0}']);
    if (reapply.exitCode !== 0) {
      this.runGit(['stash', 'pop', 'stash@{0}']); // restore tree, drop the broken snapshot
      logger.warn('Auto-snapshot rolled back (could not re-apply working tree)', { error: reapply.stderr.trim(), reason });
      return null;
    }

    // Stash 0 is the newest in git stash list
    const record: SnapshotRecord = {
      initialIndex: 0,
      message,
      createdAt: Date.now(),
      turn: currentTurn,
      reason,
    };
    this.snapshots.push(record);
    logger.info('Auto-snapshot taken', { reason, message });
    return record;
  }

  /**
   * Drop snapshots older than the retention window. Called from the agent loop after each
   * turn. We resolve the CURRENT stash index for each record (since stashes shift when
   * user runs their own commands) before dropping.
   */
  prune(currentTurn: number): void {
    const expired = this.snapshots.filter(s => currentTurn - s.turn >= this.retentionTurns);
    for (const s of expired) {
      const idx = this.findStashIndex(s.message);
      if (idx >= 0) {
        const r = this.runGit(['stash', 'drop', `stash@{${idx}}`]);
        if (r.exitCode === 0) logger.info('Auto-snapshot pruned', { message: s.message });
        else logger.warn('Failed to drop expired snapshot', { message: s.message, err: r.stderr.trim() });
      }
    }
    this.snapshots = this.snapshots.filter(s => !expired.includes(s));
  }

  /** Drop ALL snapshots taken by this session (called at session end). */
  cleanupAll(): void {
    for (const s of this.snapshots) {
      const idx = this.findStashIndex(s.message);
      if (idx >= 0) this.runGit(['stash', 'drop', `stash@{${idx}}`]);
    }
    this.snapshots = [];
  }

  /** Pop the most recent snapshot back onto the working tree. */
  restoreLatest(): { restored: boolean; message: string } {
    if (this.snapshots.length === 0) return { restored: false, message: 'No snapshots to restore.' };
    const latest = this.snapshots[this.snapshots.length - 1]!;
    const idx = this.findStashIndex(latest.message);
    if (idx < 0) return { restored: false, message: `Snapshot not found in stash list: ${latest.message}` };
    const r = this.runGit(['stash', 'pop', `stash@{${idx}}`]);
    if (r.exitCode !== 0) return { restored: false, message: r.stderr.trim() || 'git stash pop failed' };
    this.snapshots = this.snapshots.slice(0, -1);
    return { restored: true, message: `Restored: ${latest.message}` };
  }

  /** List all active snapshots, in oldest→newest order. */
  list(): SnapshotRecord[] {
    return this.snapshots.slice();
  }

  /** Find the CURRENT stash index for a given message — may differ from initialIndex if the user has stashed something themselves since. */
  private findStashIndex(message: string): number {
    const r = this.runGit(['stash', 'list']);
    if (r.exitCode !== 0) return -1;
    const lines = r.stdout.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.includes(message)) return i;
    }
    return -1;
  }

  private runGit(args: string[]): { exitCode: number; stdout: string; stderr: string } {
    try {
      const r = spawnSync('git', ['-C', this.cwd, ...args], { encoding: 'utf-8', timeout: 5000 });
      return {
        exitCode: r.status ?? 1,
        stdout: r.stdout ?? '',
        stderr: r.stderr ?? '',
      };
    } catch {
      return { exitCode: 127, stdout: '', stderr: 'git invocation failed' };
    }
  }
}
