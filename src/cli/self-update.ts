/**
 * `qodex update` — self-update a git checkout in place: git pull → npm install → npm run build.
 * Closes the "in-app self-update" gap vs a packaged app. Best-effort and explicit: it tells you
 * each step's result and reminds you to restart, since the running process keeps the old `dist/`
 * until it exits.
 *
 * findRepoRoot is the only tricky bit and is unit-tested against a temp tree; the rest is spawning.
 */
import { spawnSync } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

/** The fixed update pipeline. Exported so it's inspectable/testable. */
export const UPDATE_STEPS: { label: string; cmd: string; args: string[] }[] = [
  { label: 'pull', cmd: 'git', args: ['pull', '--ff-only'] },
  { label: 'install', cmd: 'npm', args: ['install', '--no-audit', '--no-fund'] },
  { label: 'build', cmd: 'npm', args: ['run', 'build'] },
];

/** Does this dir look like the QodeX source checkout? (package.json name + a .git). */
async function looksLikeRepo(dir: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf-8'));
    await fs.access(path.join(dir, '.git'));
    return pkg?.name === '@qodex/cli';
  } catch { return false; }
}

/** Walk up from `startDir` (≤8 levels) to the QodeX git checkout, or null if not found. */
export async function findRepoRoot(startDir: string): Promise<string | null> {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 8; i++) {
    if (await looksLikeRepo(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export interface UpdateResult { ok: boolean; message: string; log: string[]; root?: string }

export interface UpdateStatus {
  /** A QodeX git checkout was found and its remote could be queried. */
  ok: boolean;
  /** True when the remote tracking branch is ahead of local HEAD. */
  updateAvailable: boolean;
  /** How many commits local HEAD is behind the remote (0 when up to date). */
  behind: number;
  /** Short local HEAD sha, and the remote's, for display. */
  local?: string;
  remote?: string;
  /** package.json version string (unchanged until the update actually builds). */
  version?: string;
  /** Human summary for the CLI / dashboard. */
  message: string;
  root?: string;
}

/** Best-effort `git` reader that never throws — returns trimmed stdout or ''. */
function git(root: string, args: string[], timeoutMs = 20_000): string {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf-8', timeout: timeoutMs });
  return r.status === 0 ? (r.stdout ?? '').trim() : '';
}

/**
 * Check whether newer commits exist on the remote WITHOUT touching the working tree.
 * A `git fetch` updates remote-tracking refs (no merge, no checkout), then we count how
 * many commits HEAD is behind its upstream. This is what powers "update available" in the
 * dashboard badge and `qodex update --check` — the pull itself stays a separate, explicit step.
 */
export async function checkForUpdate(opts: { fetchRemote?: boolean } = {}): Promise<UpdateStatus> {
  const fetchRemote = opts.fetchRemote !== false; // default true; false = instant local-only (dashboard render)
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = process.env.QODEX_SRC_DIR ?? (await findRepoRoot(here));
  if (!root) {
    return { ok: false, updateAvailable: false, behind: 0, message: 'Not a git checkout — reinstall with install.sh (or set QODEX_SRC_DIR).' };
  }
  let version: string | undefined;
  try { version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf-8'))?.version; } catch { /* keep undefined */ }

  // Resolve the upstream ref; fall back to origin/<current-branch> when no @{u} is set.
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']) || 'HEAD';
  const upstream = git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']) || (branch !== 'HEAD' ? `origin/${branch}` : '');
  if (!upstream) {
    return { ok: false, updateAvailable: false, behind: 0, version, root, message: 'No upstream tracking branch — can\'t check for updates.' };
  }
  // Network step: refresh remote-tracking refs only (no merge/checkout). Skipped for the
  // dashboard's instant render, which reports against whatever the last fetch already knew.
  if (fetchRemote) {
    const fetch = spawnSync('git', ['fetch', '--quiet', 'origin'], { cwd: root, encoding: 'utf-8', timeout: 45_000 });
    if (fetch.status !== 0) {
      return { ok: false, updateAvailable: false, behind: 0, version, root, message: `Couldn't reach the remote (${(fetch.stderr ?? '').trim().slice(-120) || 'offline?'}).` };
    }
  }
  const local = git(root, ['rev-parse', '--short', 'HEAD']);
  const remote = git(root, ['rev-parse', '--short', upstream]);
  const behindStr = git(root, ['rev-list', '--count', `HEAD..${upstream}`]);
  const behind = Number.parseInt(behindStr, 10) || 0;
  return {
    ok: true,
    updateAvailable: behind > 0,
    behind,
    local, remote, version, root,
    message: behind > 0
      ? `Update available — ${behind} commit${behind === 1 ? '' : 's'} behind ${upstream} (${local} → ${remote}). Run \`qodex update\`.`
      : `${fetchRemote ? 'Up to date' : 'Up to date (local check)'} with ${upstream} (${local}).`,
  };
}

/** Run the update pipeline in the QodeX checkout. `onLog` streams progress (for the CLI). */
export async function selfUpdate(onLog: (line: string) => void = () => {}): Promise<UpdateResult> {
  const here = path.dirname(fileURLToPath(import.meta.url)); // dist/cli or src/cli
  const root = process.env.QODEX_SRC_DIR ?? (await findRepoRoot(here));
  if (!root) {
    return { ok: false, message: 'Not a git checkout — reinstall with install.sh (or set QODEX_SRC_DIR).', log: [] };
  }
  const log: string[] = [];
  for (const step of UPDATE_STEPS) {
    onLog(`→ ${step.label}: ${step.cmd} ${step.args.join(' ')}`);
    const r = spawnSync(step.cmd, step.args, { cwd: root, encoding: 'utf-8', timeout: 300_000 });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    if (out) log.push(`[${step.label}] ${out.slice(-400)}`);
    if (r.status !== 0) {
      return { ok: false, message: `Update failed at "${step.label}" (exit ${r.status ?? '—'}).`, log, root };
    }
  }
  return { ok: true, message: 'Updated. Restart qodex to load the new version.', log, root };
}
