import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadProjectRules } from '../src/context/claude-md.js';

/**
 * Edge coverage for src/context/claude-md.ts — the project-rules walk-up.
 * Untested before: the not-found→null path, nearest-file-wins, the priority
 * order of the rule-file names, and that content is trimmed. HOME is pointed
 * at an empty temp dir so the global-rules fallback can't accidentally match
 * a real ~/.qodex/QODEX.md on the test machine.
 */
describe('loadProjectRules', () => {
  let root: string;
  let savedHome: string | undefined;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'qodex-rules-'));
    savedHome = process.env.HOME;
    // Empty, rules-free HOME so the global fallback is a guaranteed miss.
    process.env.HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'qodex-home-'));
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    await fs.rm(root, { recursive: true, force: true });
  });

  it('returns null when no rule file exists anywhere up the tree', async () => {
    const deep = path.join(root, 'a', 'b', 'c');
    await fs.mkdir(deep, { recursive: true });
    expect(await loadProjectRules(deep)).toBeNull();
  });

  it('finds a rule file in the cwd and trims its content', async () => {
    await fs.writeFile(path.join(root, 'QODEX.md'), '\n\n  hello rules  \n\n');
    const res = await loadProjectRules(root);
    expect(res).not.toBeNull();
    expect(res!.content).toBe('hello rules');
    expect(res!.sourcePath).toBe(path.join(root, 'QODEX.md'));
  });

  it('walks UP to an ancestor directory when cwd has no rule file', async () => {
    await fs.writeFile(path.join(root, 'CLAUDE.md'), 'ancestor rules');
    const deep = path.join(root, 'pkg', 'src');
    await fs.mkdir(deep, { recursive: true });
    const res = await loadProjectRules(deep);
    expect(res!.sourcePath).toBe(path.join(root, 'CLAUDE.md'));
    expect(res!.content).toBe('ancestor rules');
  });

  it('nearest directory wins over a more distant ancestor', async () => {
    await fs.writeFile(path.join(root, 'CLAUDE.md'), 'far');
    const near = path.join(root, 'near');
    await fs.mkdir(near, { recursive: true });
    await fs.writeFile(path.join(near, 'CLAUDE.md'), 'close');
    const res = await loadProjectRules(near);
    expect(res!.content).toBe('close');
    expect(res!.sourcePath).toBe(path.join(near, 'CLAUDE.md'));
  });

  it('honors the rule-file priority order (QODEX.md before CLAUDE.md in the same dir)', async () => {
    await fs.writeFile(path.join(root, 'CLAUDE.md'), 'claude');
    await fs.writeFile(path.join(root, 'QODEX.md'), 'qodex');
    const res = await loadProjectRules(root);
    expect(res!.content).toBe('qodex');
  });
});
