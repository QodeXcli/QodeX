import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { isDestructiveBash, SnapshotService } from '../src/safety/snapshot.js';

function gitSetup(cwd: string, args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr || r.stdout}`);
}

describe('isDestructiveBash', () => {
  it('flags rm -rf', () => {
    expect(isDestructiveBash('rm -rf /tmp/foo').destructive).toBe(true);
    expect(isDestructiveBash('rm -rf dist').destructive).toBe(true);
    expect(isDestructiveBash('rm -r dist').destructive).toBe(true);
  });

  it('flags destructive git commands', () => {
    expect(isDestructiveBash('git reset --hard HEAD~3').destructive).toBe(true);
    expect(isDestructiveBash('git clean -df').destructive).toBe(true);
    expect(isDestructiveBash('git push --force origin main').destructive).toBe(true);
    expect(isDestructiveBash('git push -f').destructive).toBe(true);
    expect(isDestructiveBash('git rebase main').destructive).toBe(true);
    expect(isDestructiveBash('git filter-branch --tree-filter ...').destructive).toBe(true);
  });

  it('flags package manager removals', () => {
    expect(isDestructiveBash('npm uninstall react').destructive).toBe(true);
    expect(isDestructiveBash('yarn remove react').destructive).toBe(true);
    expect(isDestructiveBash('pnpm remove react').destructive).toBe(true);
  });

  it('flags SQL DROP/TRUNCATE', () => {
    expect(isDestructiveBash('mysql -e "DROP TABLE users"').destructive).toBe(true);
    expect(isDestructiveBash('psql -c "truncate schema cascade"').destructive).toBe(true);
  });

  it('flags disk-level destruction', () => {
    expect(isDestructiveBash('dd if=/dev/zero of=/dev/sda').destructive).toBe(true);
    expect(isDestructiveBash('mkfs.ext4 /dev/sdb1').destructive).toBe(true);
    expect(isDestructiveBash('cat data > /dev/sda').destructive).toBe(true);
  });

  it('does NOT flag safe commands', () => {
    expect(isDestructiveBash('ls -la').destructive).toBe(false);
    expect(isDestructiveBash('git status').destructive).toBe(false);
    expect(isDestructiveBash('npm install').destructive).toBe(false);
    expect(isDestructiveBash('rm file.txt').destructive).toBe(false); // no -r/-f
    expect(isDestructiveBash('echo "rm -rf /" > comment.txt').destructive).toBe(true);
    // ^ The last one IS flagged because pattern matches anywhere. That's the intended
    // conservative behavior — false positive on a comment is fine; user just has to
    // confirm or auto-snapshot runs harmlessly.
  });

  it('returns the matched label for logging', () => {
    const r = isDestructiveBash('rm -rf foo');
    expect(r.destructive).toBe(true);
    expect(r.label).toBe('rm -rf');
  });
});

describe('SnapshotService — using a real temp git repo', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'qodex-snap-'));
    gitSetup(repo, ['init', '-b', 'main']);
    gitSetup(repo, ['config', 'user.email', 'test@qodex.local']);
    gitSetup(repo, ['config', 'user.name', 'QodeX Test']);
    gitSetup(repo, ['config', 'commit.gpgsign', 'false']);
    await fs.writeFile(path.join(repo, 'README.md'), '# initial\n');
    gitSetup(repo, ['add', 'README.md']);
    gitSetup(repo, ['commit', '-m', 'initial']);
  });

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it('returns null when nothing to stash (clean tree)', () => {
    const svc = new SnapshotService(repo, 'test-session');
    const r = svc.takeSnapshot('test reason', 1);
    expect(r).toBeNull();
    expect(svc.list()).toHaveLength(0);
  });

  it('returns null in a non-git directory', async () => {
    const nonRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'qodex-nonrepo-'));
    try {
      const svc = new SnapshotService(nonRepo, 'test-session');
      const r = svc.takeSnapshot('test', 1);
      expect(r).toBeNull();
    } finally {
      await fs.rm(nonRepo, { recursive: true, force: true });
    }
  });

  it('takes a snapshot when there are uncommitted changes', async () => {
    await fs.writeFile(path.join(repo, 'README.md'), '# modified\n');
    const svc = new SnapshotService(repo, 'abcdef01-test');
    const r = svc.takeSnapshot('test stash', 1);
    expect(r).not.toBeNull();
    expect(r!.message).toContain('qodex-auto/abcdef01/');
    expect(r!.message).toContain('test stash');
    // A snapshot is a non-destructive restore POINT: the working tree must be
    // LEFT AS-IS (the old code reverted it to HEAD — a data-loss bug).
    const content = await fs.readFile(path.join(repo, 'README.md'), 'utf-8');
    expect(content).toBe('# modified\n');
    // List shows the record
    expect(svc.list()).toHaveLength(1);
  });

  it('captures untracked files in the snapshot WITHOUT removing them from disk', async () => {
    await fs.writeFile(path.join(repo, 'untracked.txt'), 'will be stashed');
    const svc = new SnapshotService(repo, 'test-session');
    const r = svc.takeSnapshot('include untracked', 1);
    expect(r).not.toBeNull();
    // The untracked file stays on disk (the old code swept it off disk into the
    // stash until /undo — a data-loss bug) AND is captured in the restore point.
    expect(await fs.readFile(path.join(repo, 'untracked.txt'), 'utf-8')).toBe('will be stashed');
    const show = spawnSync('git', ['stash', 'show', '--include-untracked', 'stash@{0}'], { cwd: repo, encoding: 'utf-8' });
    expect(show.stdout).toContain('untracked.txt');
  });

  it('restoreLatest re-applies the snapshot after the tree is damaged', async () => {
    await fs.writeFile(path.join(repo, 'README.md'), '# changed\n');
    const svc = new SnapshotService(repo, 'test-session');
    svc.takeSnapshot('change', 1);
    // Snapshot is non-destructive: the change is still here.
    expect(await fs.readFile(path.join(repo, 'README.md'), 'utf-8')).toBe('# changed\n');
    // Simulate a destructive op wiping the change back to HEAD.
    gitSetup(repo, ['checkout', '--', 'README.md']);
    expect(await fs.readFile(path.join(repo, 'README.md'), 'utf-8')).toBe('# initial\n');
    // Restore brings the snapshotted change back.
    const r = svc.restoreLatest();
    expect(r.restored).toBe(true);
    expect(await fs.readFile(path.join(repo, 'README.md'), 'utf-8')).toBe('# changed\n');
    expect(svc.list()).toHaveLength(0);
  });

  it('restoreLatest returns false when no snapshots exist', () => {
    const svc = new SnapshotService(repo, 'test-session');
    const r = svc.restoreLatest();
    expect(r.restored).toBe(false);
    expect(r.message).toMatch(/no snapshots/i);
  });

  it('prune drops snapshots older than retention window', async () => {
    await fs.writeFile(path.join(repo, 'a.txt'), 'a');
    const svc = new SnapshotService(repo, 'test-session', { retentionTurns: 3 });
    svc.takeSnapshot('snap at turn 1', 1);
    expect(svc.list()).toHaveLength(1);
    // After 4 turns it should be pruned
    svc.prune(5);
    expect(svc.list()).toHaveLength(0);
  });

  it('multiple snapshots accumulate and list in order', async () => {
    const svc = new SnapshotService(repo, 'test-session');
    await fs.writeFile(path.join(repo, 'a.txt'), '1');
    svc.takeSnapshot('a', 1);
    await fs.writeFile(path.join(repo, 'b.txt'), '2');
    svc.takeSnapshot('b', 2);
    await fs.writeFile(path.join(repo, 'c.txt'), '3');
    svc.takeSnapshot('c', 3);
    expect(svc.list()).toHaveLength(3);
    expect(svc.list().map(s => s.reason)).toEqual(['a', 'b', 'c']);
  });
});
