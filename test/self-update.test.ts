import { describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findRepoRoot, UPDATE_STEPS } from '../src/cli/self-update.ts';

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
