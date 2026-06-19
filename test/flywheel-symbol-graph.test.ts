import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { recordTrajectory, countTrajectories, getTrajectoryDatasetPath } from '../src/agent/trajectory.js';
import { dependencyContextFor, renderDependencyContext } from '../src/context/symbol-graph.js';
import type { ImportGraph } from '../src/context/import-graph.js';

describe('trajectory recorder', () => {
  const proj = path.join(os.tmpdir(), 'traj-proj-' + Date.now());

  afterEach(async () => {
    await fs.rm(getTrajectoryDatasetPath(proj), { force: true });
  });

  it('appends a JSONL record and counts it', async () => {
    await recordTrajectory(proj, {
      prompt: 'add a helper',
      reasoning: ['first I will read the file', 'then edit it'],
      filesChanged: ['src/util.ts'],
      finalSummary: 'added helper()',
      messages: [{ role: 'user', content: 'add a helper' }, { role: 'assistant', content: 'done' }],
    });
    const count = await countTrajectories(proj);
    expect(count).toBe(1);

    // file is valid JSONL
    const content = await fs.readFile(getTrajectoryDatasetPath(proj), 'utf-8');
    const rec = JSON.parse(content.trim());
    expect(rec.prompt).toBe('add a helper');
    expect(rec.filesChanged).toEqual(['src/util.ts']);
    expect(rec.ts).toBeTruthy();
  });

  it('returns 0 for a project with no trajectories', async () => {
    expect(await countTrajectories('/nonexistent/project/xyz')).toBe(0);
  });
});

describe('symbol graph dependency context', () => {
  const graph: ImportGraph = {
    out: new Map([['a.ts', new Set(['b.ts', 'c.ts'])]]),
    in: new Map([['b.ts', new Set(['a.ts', 'd.ts'])]]),
    files: new Set(['a.ts', 'b.ts', 'c.ts', 'd.ts']),
  };

  it('reports imports (downstream) and importedBy (upstream)', () => {
    const deps = dependencyContextFor(graph, ['a.ts', 'b.ts']);
    const a = deps.find(d => d.file === 'a.ts')!;
    expect(a.imports.sort()).toEqual(['b.ts', 'c.ts']);
    const b = deps.find(d => d.file === 'b.ts')!;
    expect(b.importedBy.sort()).toEqual(['a.ts', 'd.ts']);
  });

  it('skips files with no neighbors', () => {
    const deps = dependencyContextFor(graph, ['c.ts']); // no out/in entries
    expect(deps).toHaveLength(0);
  });

  it('renders a non-empty block with ripple wording', () => {
    const deps = dependencyContextFor(graph, ['b.ts']);
    const block = renderDependencyContext(deps);
    expect(block).toMatch(/ripple effect/i);
    expect(block).toMatch(/imported by/);
  });

  it('renders empty string when no deps', () => {
    expect(renderDependencyContext([])).toBe('');
  });
});
