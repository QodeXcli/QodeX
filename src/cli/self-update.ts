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
