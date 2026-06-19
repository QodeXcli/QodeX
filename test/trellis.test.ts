import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadTrellisContext } from '../src/context/trellis.js';

describe('loadTrellisContext', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trellis-test-'));
    await fs.mkdir(path.join(dir, '.trellis', 'spec'), { recursive: true });
    await fs.mkdir(path.join(dir, '.trellis', 'tasks'), { recursive: true });
    await fs.mkdir(path.join(dir, '.trellis', 'workspace'), { recursive: true });
    await fs.writeFile(path.join(dir, '.trellis', 'spec', 'conventions.md'), '# Rules\nUse tabs.');
    await fs.writeFile(path.join(dir, '.trellis', 'tasks', 'task-1.md'), '# Task 1\nBuild login.');
    await fs.writeFile(path.join(dir, '.trellis', 'workspace', 'journal-1.md'), '# Session 1\nDid setup.');
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns null when there is no .trellis dir', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'no-trellis-'));
    expect(await loadTrellisContext(empty)).toBeNull();
    await fs.rm(empty, { recursive: true, force: true });
  });

  it('loads spec, tasks, and journals', async () => {
    const ctx = await loadTrellisContext(dir);
    expect(ctx).not.toBeNull();
    expect(ctx!.counts).toEqual({ specFiles: 1, taskFiles: 1, journalFiles: 1 });
    expect(ctx!.block).toMatch(/Use tabs/);
    expect(ctx!.block).toMatch(/Build login/);
    expect(ctx!.block).toMatch(/Did setup/);
  });

  it('exposes a spec-only block for focused sub-agents', async () => {
    const ctx = await loadTrellisContext(dir);
    expect(ctx!.specBlock).toMatch(/Use tabs/);
    expect(ctx!.specBlock).not.toMatch(/Build login/); // tasks excluded from spec-only
  });

  it('finds .trellis from a nested subdirectory', async () => {
    const nested = path.join(dir, 'src', 'deep');
    await fs.mkdir(nested, { recursive: true });
    const ctx = await loadTrellisContext(nested);
    expect(ctx).not.toBeNull();
    expect(ctx!.rootDir).toBe(dir);
  });
});
