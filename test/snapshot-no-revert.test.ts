import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SnapshotService } from '../src/safety/snapshot.js';

/**
 * Regression for the auto-snapshot data-loss bug: takeSnapshot used
 * `git stash push --include-untracked`, which REVERTS the working tree (moving
 * changes into the stash) and was never re-applied — so it wiped the user's
 * in-progress edits and swept unrelated untracked files off disk until /undo.
 * A snapshot must be a pure restore POINT: the working tree (and untracked
 * files) must be left exactly as they were.
 */
const dirs: string[] = [];
function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: 'utf-8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).trim();
}
async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-snap-'));
  dirs.push(dir);
  git(dir, 'init -q');
  git(dir, 'config user.email t@t.com');
  git(dir, 'config user.name t');
  git(dir, 'config commit.gpgsign false');
  await fs.writeFile(path.join(dir, 'tracked.txt'), 'original\n');
  git(dir, 'add -A');
  git(dir, 'commit -qm baseline');
  return dir;
}
afterEach(async () => {
  while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true }).catch(() => {});
});

describe('SnapshotService.takeSnapshot — must not revert the working tree', () => {
  it('leaves an uncommitted edit AND an untracked file on disk after snapshotting', async () => {
    const dir = await makeRepo();
    // in-progress work: modify a tracked file + create an untracked one.
    await fs.writeFile(path.join(dir, 'tracked.txt'), 'EDITED BY AGENT\n');
    await fs.writeFile(path.join(dir, 'untracked.log', ), 'precious untracked data\n');

    const svc = new SnapshotService(dir, 'testsess1');
    const rec = svc.takeSnapshot('before destructive op', 1);

    // 1. snapshot was taken
    expect(rec).not.toBeNull();
    // 2. the tracked edit is STILL in the working tree (not reverted to HEAD)
    expect(await fs.readFile(path.join(dir, 'tracked.txt'), 'utf-8')).toBe('EDITED BY AGENT\n');
    // 3. the unrelated untracked file is STILL on disk (not swept into the stash)
    expect(await fs.readFile(path.join(dir, 'untracked.log'), 'utf-8')).toBe('precious untracked data\n');
    // 4. a restore point exists in the stash list
    expect(git(dir, 'stash list')).toContain('qodex-auto');
  });

  it('snapshots an untracked-only tree and keeps the file on disk', async () => {
    const dir = await makeRepo();
    await fs.writeFile(path.join(dir, 'only-untracked.txt'), 'x\n');
    const svc = new SnapshotService(dir, 'testsess2');
    const rec = svc.takeSnapshot('before op', 1);
    // An untracked file is a real change worth snapshotting — and it must stay on disk.
    expect(rec).not.toBeNull();
    expect(await fs.readFile(path.join(dir, 'only-untracked.txt'), 'utf-8')).toBe('x\n');
  });

  it('skips (returns null) outside a git repo', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-nogit-'));
    dirs.push(dir);
    const svc = new SnapshotService(dir, 'testsess3');
    expect(svc.takeSnapshot('x', 1)).toBeNull();
  });
});
