/**
 * G3.4 — project instruction files: 'first' (default, today's walk-up) vs 'all' (every file
 * in the nearest directory that has any, with headers, identical contents once), the
 * `context.projectInstructions` config key and the `/instructions` command.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  getProjectInstructionsMode, loadProjectRules, mergeRuleFiles, setProjectInstructionsMode,
} from '../src/context/claude-md.js';
import { setActiveConfig, getActiveConfig } from '../src/config/loader.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { handleSlashCommand } from '../src/cli/slash-commands.js';
import { SLASH_CATALOG } from '../src/cli/slash-catalog.js';

describe('project instructions', () => {
  let root: string;
  let savedHome: string | undefined;
  const savedConfig = getActiveConfig();

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'qodex-instr-'));
    savedHome = process.env.HOME;
    process.env.HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'qodex-instr-home-'));
    setProjectInstructionsMode(null);
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    setProjectInstructionsMode(null);
    setActiveConfig(savedConfig as any);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('AGENTS.md loads when it is the only instruction file (default mode)', async () => {
    await fs.writeFile(path.join(root, 'AGENTS.md'), 'agents rules\n');
    const res = await loadProjectRules(root);
    expect(res?.content).toBe('agents rules');
    expect(res?.sourcePath).toBe(path.join(root, 'AGENTS.md'));
  });

  it('GEMINI.md is an instruction file too', async () => {
    await fs.writeFile(path.join(root, 'GEMINI.md'), 'gemini rules');
    expect((await loadProjectRules(root))?.content).toBe('gemini rules');
  });

  it("default 'first' keeps today's behavior: one file, priority order", async () => {
    await fs.writeFile(path.join(root, 'AGENTS.md'), 'agents');
    await fs.writeFile(path.join(root, 'CLAUDE.md'), 'claude');
    expect(getProjectInstructionsMode()).toBe('first');
    const res = await loadProjectRules(root);
    expect(res?.content).toBe('claude');
    expect(res?.sources).toEqual([path.join(root, 'CLAUDE.md')]);
  });

  it("'all' concatenates every file of the nearest directory with headers", async () => {
    await fs.writeFile(path.join(root, 'AGENTS.md'), 'far agents');
    const near = path.join(root, 'pkg');
    await fs.mkdir(near);
    await fs.writeFile(path.join(near, 'CLAUDE.md'), 'use pnpm');
    await fs.writeFile(path.join(near, 'AGENTS.md'), 'run the tests');
    const res = await loadProjectRules(near, { mode: 'all' });
    expect(res?.content).toBe('## From CLAUDE.md\n\nuse pnpm\n\n## From AGENTS.md\n\nrun the tests');
    expect(res?.content).not.toContain('far agents');
    expect(res?.sources).toEqual([path.join(near, 'CLAUDE.md'), path.join(near, 'AGENTS.md')]);
  });

  it("'all' loads identical contents once (CLAUDE.md copied from AGENTS.md)", async () => {
    await fs.writeFile(path.join(root, 'AGENTS.md'), 'same rules\n');
    await fs.writeFile(path.join(root, 'CLAUDE.md'), 'same rules');
    const res = await loadProjectRules(root, { mode: 'all' });
    expect(res?.content).toBe('same rules');
    await fs.writeFile(path.join(root, 'QODEX.md'), 'qodex only');
    const three = await loadProjectRules(root, { mode: 'all' });
    expect(three?.content).toBe('## From QODEX.md\n\nqodex only\n\n## From CLAUDE.md (same as AGENTS.md)\n\nsame rules');
  });

  it('mergeRuleFiles skips empty files', () => {
    expect(mergeRuleFiles([{ name: 'A', content: '  ' }, { name: 'B', content: 'b' }])).toBe('b');
  });

  it('config context.projectInstructions picks the mode; the session override wins', async () => {
    await fs.writeFile(path.join(root, 'AGENTS.md'), 'a');
    await fs.writeFile(path.join(root, 'CLAUDE.md'), 'c');
    setActiveConfig({ ...DEFAULT_CONFIG, context: { projectInstructions: 'all' } } as any);
    expect(getProjectInstructionsMode()).toBe('all');
    expect((await loadProjectRules(root))?.content).toContain('## From AGENTS.md');
    setProjectInstructionsMode('first');
    expect((await loadProjectRules(root))?.content).toBe('c');
  });

  it('/instructions shows and switches the mode; it is in the catalog', async () => {
    await fs.writeFile(path.join(root, 'AGENTS.md'), 'a');
    const show = await handleSlashCommand('/instructions', 's', root);
    expect(show.message).toMatch(/^Project instructions: first/);
    expect(show.message).toContain(path.join(root, 'AGENTS.md'));
    const all = await handleSlashCommand('/instructions all', 's', root);
    expect(all.message).toMatch(/^Project instructions: all/);
    expect(all.message).toMatch(/next conversation/);
    expect(getProjectInstructionsMode()).toBe('all');
    const bad = await handleSlashCommand('/instructions maybe', 's', root);
    expect(bad.message).toMatch(/^Usage: \/instructions/);
    expect(SLASH_CATALOG.some(c => c.name === 'instructions')).toBe(true);
    const help = await handleSlashCommand('/help', 's', root);
    expect(help.message).toContain('/instructions');
  });
});
