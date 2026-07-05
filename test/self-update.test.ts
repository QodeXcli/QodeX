import { describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { findRepoRoot, UPDATE_STEPS, checkForUpdate } from '../src/cli/self-update.ts';

describe('findRepoRoot', () => {
  it('walks up to the QodeX checkout (package.json name + .git)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'upd-'));
    try {
      const root = path.join(dir, 'qodex');
      await fs.mkdir(path.join(root, '.git'), { recursive: true });
      await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: '@qodex/cli' }));
      const deep = path.join(root, 'dist', 'cli');
      await fs.mkdir(deep, { recursive: true });
      expect(await findRepoRoot(deep)).toBe(root);
    } finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
  });

  it('returns null when there is no QodeX checkout above (e.g. npm install)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'upd-'));
    try {
      // a package.json with the WRONG name, and no .git → not our repo
      await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'something-else' }));
      expect(await findRepoRoot(dir)).toBeNull();
    } finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
  });

  it('the pipeline is pull → install → build', () => {
    expect(UPDATE_STEPS.map(s => s.label)).toEqual(['pull', 'install', 'build']);
    expect(UPDATE_STEPS[0]!.args).toContain('--ff-only'); // never a merge-commit surprise
  });
});

describe('checkForUpdate', () => {
  // Build a tiny local "remote → clone" pair so the fetch/behind-count runs against real git
  // without any network. The clone starts one commit behind, so behind === 1.
  async function makeBehindClone(): Promise<{ dir: string; clone: string }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'upd-git-'));
    const remote = path.join(dir, 'remote');
    const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: 'pipe' });
    await fs.mkdir(remote, { recursive: true });
    g(remote, 'init', '-q', '-b', 'main');
    g(remote, 'config', 'user.email', 't@t.co'); g(remote, 'config', 'user.name', 't');
    await fs.writeFile(path.join(remote, 'package.json'), JSON.stringify({ name: '@qodex/cli', version: '2.5.0' }));
    g(remote, 'add', '-A'); g(remote, 'commit', '-q', '-m', 'v1');
    const clone = path.join(dir, 'clone');
    g(dir, 'clone', '-q', remote, clone);
    await fs.mkdir(path.join(clone, '.git'), { recursive: true }); // findRepoRoot marker (already present)
    // advance the remote by one commit so the clone is 1 behind
    await fs.writeFile(path.join(remote, 'x.txt'), 'hi');
    g(remote, 'add', '-A'); g(remote, 'commit', '-q', '-m', 'v2');
    return { dir, clone };
  }

  it('reports updateAvailable + behind count against a real upstream (no network)', async () => {
    const { dir, clone } = await makeBehindClone();
    const prev = process.env.QODEX_SRC_DIR;
    process.env.QODEX_SRC_DIR = clone;
    try {
      const s = await checkForUpdate();               // fetches from the local file:// remote
      expect(s.ok).toBe(true);
      expect(s.updateAvailable).toBe(true);
      expect(s.behind).toBe(1);
      expect(s.version).toBe('2.5.0');
    } finally {
      if (prev === undefined) delete process.env.QODEX_SRC_DIR; else process.env.QODEX_SRC_DIR = prev;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('fetchRemote:false skips the network step and still reads the local state', async () => {
    const { dir, clone } = await makeBehindClone();
    const prev = process.env.QODEX_SRC_DIR;
    process.env.QODEX_SRC_DIR = clone;
    try {
      const s = await checkForUpdate({ fetchRemote: false }); // no fetch → clone hasn't seen v2 yet
      expect(s.ok).toBe(true);
      expect(s.behind).toBe(0);                              // local-only view: still even with known origin/main
    } finally {
      if (prev === undefined) delete process.env.QODEX_SRC_DIR; else process.env.QODEX_SRC_DIR = prev;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
