/**
 * Snapshot + rollback of the user skills directory — the curator's safety net.
 *
 * Before the curator promotes/prunes anything, it tars the whole skills dir to a
 * timestamped archive. If a change later proves bad (a promoted candidate regresses
 * quality, a prune removed something wanted), `restoreSkillsSnapshot` puts the exact
 * prior tree back. This mirrors QodeX's existing rollback discipline (transaction
 * journal, artifact versions, git-stash auto-snapshot) for the one tree those don't
 * cover. Uses the system `tar` (present on macOS/Linux/modern Windows); best-effort and
 * never throws into the caller's happy path beyond an explicit Error on hard failure.
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import spawn from 'cross-spawn';
import { logger } from '../../utils/logger.js';
import { userSkillsDir } from '../loader.js';

export function skillSnapshotsDir(): string {
  return path.join(os.homedir(), '.qodex', 'skill-snapshots');
}

function runTar(args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr?.on('data', d => { err += String(d); });
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}: ${err.trim()}`))));
  });
}

/**
 * Snapshot the user skills dir → ~/.qodex/skill-snapshots/<stamp>.tar.gz.
 * `stamp` is passed in (callers stamp time; keeps this testable/deterministic).
 * Returns the archive path, or null if there's nothing to snapshot (no skills dir yet).
 */
export async function snapshotSkills(stamp: string): Promise<string | null> {
  const skillsRoot = userSkillsDir();
  try {
    const st = await fs.stat(skillsRoot);
    if (!st.isDirectory()) return null;
  } catch {
    return null; // no skills dir → nothing to snapshot
  }
  await fs.mkdir(skillSnapshotsDir(), { recursive: true });
  const archive = path.join(skillSnapshotsDir(), `${stamp}.tar.gz`);
  // -C the parent so the archive contains a top-level `skills/` dir (clean restore).
  await runTar(['-czf', archive, '-C', path.dirname(skillsRoot), path.basename(skillsRoot)]);
  logger.info('Skills directory snapshotted', { archive });
  return archive;
}

/** List snapshot archives, newest first (by filename stamp). */
export async function listSkillSnapshots(): Promise<string[]> {
  try {
    const files = await fs.readdir(skillSnapshotsDir());
    return files.filter(f => f.endsWith('.tar.gz')).sort().reverse().map(f => path.join(skillSnapshotsDir(), f));
  } catch {
    return [];
  }
}

/**
 * Restore the skills dir from an archive: the current tree is replaced by the archived
 * one. Destructive by design (that's the point of a rollback) — the caller decides when.
 */
export async function restoreSkillsSnapshot(archive: string): Promise<void> {
  await fs.access(archive); // throws a clear ENOENT if the stamp is wrong
  const skillsRoot = userSkillsDir();
  await fs.rm(skillsRoot, { recursive: true, force: true });
  await fs.mkdir(path.dirname(skillsRoot), { recursive: true });
  await runTar(['-xzf', archive, '-C', path.dirname(skillsRoot)]);
  logger.info('Skills directory restored from snapshot', { archive });
}
