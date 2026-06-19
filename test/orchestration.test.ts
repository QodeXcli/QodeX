import { describe, it, expect } from 'vitest';
import { DagScheduler, topoSort, type SchedulerHooks } from '../src/orchestration/scheduler.js';
import { StagingArea, extractExports } from '../src/orchestration/staging.js';
import { parsePlanJson, extractFileEdits } from '../src/orchestration/engine.js';
import type { TaskGraph, TaskNode, WorkerResult, QaVerdict } from '../src/orchestration/protocol.js';

function node(id: string, deps: string[] = [], targetFiles: string[] = [`${id}.ts`]): TaskNode {
  return {
    id, kind: 'generic', title: id, instruction: `build ${id}`,
    targetFiles, contextFiles: [], dependsOn: deps,
    status: 'pending', attempts: 0,
  };
}

function graphOf(...nodes: TaskNode[]): TaskGraph {
  const map = new Map(nodes.map(n => [n.id, n]));
  return { nodes: map, goal: 'test', acyclic: true };
}

/** Hooks that record execution order and always succeed. */
function recordingHooks(order: string[]): SchedulerHooks {
  return {
    runNode: async (n) => {
      order.push(n.id);
      return { taskId: n.id, ok: true, fileEdits: [{ path: n.targetFiles[0]!, content: `// ${n.id}`, isNew: true }], summary: '', toolCallsRun: 1 };
    },
    review: async (n): Promise<QaVerdict> => ({ taskId: n.id, passed: true, blockers: [], warnings: [] }),
    dryRunMerge: async () => [],
    commit: async () => {},
  };
}

describe('topoSort', () => {
  it('orders a linear chain', () => {
    const g = graphOf(node('a'), node('b', ['a']), node('c', ['b']));
    expect(topoSort(g)).toEqual(['a', 'b', 'c']);
  });
  it('returns null on a cycle', () => {
    const g = graphOf(node('a', ['c']), node('b', ['a']), node('c', ['b']));
    expect(topoSort(g)).toBeNull();
  });
});

describe('DagScheduler — dependency ordering', () => {
  it('runs dependencies before dependents', async () => {
    const order: string[] = [];
    const g = graphOf(node('types'), node('comp', ['types']), node('wire', ['comp']));
    const s = new DagScheduler(g, recordingHooks(order), { maxConcurrency: 4, maxAttempts: 1 });
    await s.run();
    expect(order.indexOf('types')).toBeLessThan(order.indexOf('comp'));
    expect(order.indexOf('comp')).toBeLessThan(order.indexOf('wire'));
    expect(g.nodes.get('wire')!.status).toBe('committed');
  });

  it('commits all nodes in a diamond DAG', async () => {
    const order: string[] = [];
    // a → b, a → c, (b,c) → d
    const g = graphOf(node('a'), node('b', ['a']), node('c', ['a']), node('d', ['b', 'c']));
    const s = new DagScheduler(g, recordingHooks(order), { maxConcurrency: 4, maxAttempts: 1 });
    await s.run();
    expect([...g.nodes.values()].every(n => n.status === 'committed')).toBe(true);
    // d runs last
    expect(order[order.length - 1]).toBe('d');
  });
});

describe('DagScheduler — parallelism & file locks', () => {
  it('runs independent nodes concurrently', async () => {
    let concurrent = 0, maxConcurrent = 0;
    const g = graphOf(node('a'), node('b'), node('c'));
    const hooks: SchedulerHooks = {
      runNode: async (n) => {
        concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise(r => setTimeout(r, 20));
        concurrent--;
        return { taskId: n.id, ok: true, fileEdits: [{ path: n.targetFiles[0]!, content: 'x', isNew: true }], summary: '', toolCallsRun: 1 };
      },
      review: async (n) => ({ taskId: n.id, passed: true, blockers: [], warnings: [] }),
      dryRunMerge: async () => [],
      commit: async () => {},
    };
    const s = new DagScheduler(g, hooks, { maxConcurrency: 3, maxAttempts: 1 });
    await s.run();
    expect(maxConcurrent).toBeGreaterThan(1); // genuinely parallel
  });

  it('serializes nodes that write the same file', async () => {
    let concurrent = 0, maxConcurrent = 0;
    // Two nodes, no dep edge, but SAME target file → must not run together.
    const g = graphOf(node('a', [], ['shared.ts']), node('b', [], ['shared.ts']));
    const hooks: SchedulerHooks = {
      runNode: async (n) => {
        concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise(r => setTimeout(r, 20));
        concurrent--;
        return { taskId: n.id, ok: true, fileEdits: [{ path: 'shared.ts', content: n.id, isNew: false }], summary: '', toolCallsRun: 1 };
      },
      review: async (n) => ({ taskId: n.id, passed: true, blockers: [], warnings: [] }),
      dryRunMerge: async () => [],
      commit: async () => {},
    };
    const s = new DagScheduler(g, hooks, { maxConcurrency: 4, maxAttempts: 1 });
    await s.run();
    expect(maxConcurrent).toBe(1); // file lock prevented concurrency
  });
});

describe('DagScheduler — failure propagation', () => {
  it('blocks dependents when a node fails', async () => {
    const g = graphOf(node('a'), node('b', ['a']));
    const hooks: SchedulerHooks = {
      runNode: async (n) => ({ taskId: n.id, ok: n.id !== 'a', fileEdits: n.id !== 'a' ? [{ path: `${n.id}.ts`, content: 'x', isNew: true }] : [], summary: '', toolCallsRun: 1, error: n.id === 'a' ? 'boom' : undefined }),
      review: async (n) => ({ taskId: n.id, passed: true, blockers: [], warnings: [] }),
      dryRunMerge: async () => [],
      commit: async () => {},
    };
    const s = new DagScheduler(g, hooks, { maxConcurrency: 2, maxAttempts: 1 });
    await s.run();
    expect(g.nodes.get('a')!.status).toBe('failed');
    expect(g.nodes.get('b')!.status).toBe('blocked');
  });

  it('retries a node that fails QA, then succeeds', async () => {
    let attempts = 0;
    const g = graphOf(node('a'));
    const hooks: SchedulerHooks = {
      runNode: async (n) => { attempts++; return { taskId: n.id, ok: true, fileEdits: [{ path: 'a.ts', content: 'x', isNew: true }], summary: '', toolCallsRun: 1 }; },
      review: async (n): Promise<QaVerdict> => ({ taskId: n.id, passed: attempts >= 2, blockers: attempts < 2 ? ['fix me'] : [], warnings: [] }),
      dryRunMerge: async () => [],
      commit: async () => {},
    };
    const s = new DagScheduler(g, hooks, { maxConcurrency: 1, maxAttempts: 3 });
    await s.run();
    expect(attempts).toBe(2);
    expect(g.nodes.get('a')!.status).toBe('committed');
  });
});

describe('StagingArea — export-diff conflict detection', () => {
  it('extracts exports of all shapes', () => {
    const src = `export const A = 1;\nexport function B() {}\nexport class C {}\nexport type D = number;\nexport { E, F as G };\nexport default function H() {}`;
    const ex = extractExports(src);
    expect(ex).toContain('A'); expect(ex).toContain('B'); expect(ex).toContain('C');
    expect(ex).toContain('D'); expect(ex).toContain('E'); expect(ex).toContain('G');
    expect(ex).toContain('H');
  });

  it('flags import-broken when an edit removes an export a staged file needs', async () => {
    const staging = new StagingArea('/tmp/fake-proj-' + Date.now());
    // Stage a frontend file that imports OrderStatus from the schema.
    const frontend: WorkerResult = {
      taskId: 'frontend', ok: true, summary: '', toolCallsRun: 1,
      fileEdits: [{ path: 'state.ts', content: `import { OrderStatus } from './schema';\nconst s: OrderStatus = 'x';`, isNew: true }],
    };
    await staging.dryRunMerge(node('frontend', [], ['state.ts']), frontend);

    // Now a schema edit that REMOVES OrderStatus (only exports Order now).
    const schema: WorkerResult = {
      taskId: 'schema', ok: true, summary: '', toolCallsRun: 1,
      fileEdits: [{ path: 'schema.ts', content: `export type Order = { id: string };`, isNew: false }],
    };
    // Seed prior schema content on disk-substitute by committing an initial version first.
    const initial: WorkerResult = {
      taskId: 'schema0', ok: true, summary: '', toolCallsRun: 1,
      fileEdits: [{ path: 'schema.ts', content: `export type Order = { id: string };\nexport type OrderStatus = string;`, isNew: true }],
    };
    await staging.commit(node('schema0', [], ['schema.ts']), initial);

    const conflicts = await staging.dryRunMerge(node('schema', [], ['schema.ts']), schema);
    const broken = conflicts.find(c => c.kind === 'import-broken');
    expect(broken).toBeDefined();
    expect(broken!.file).toBe('state.ts');
  });
});

describe('engine — plan parsing', () => {
  it('parses clean JSON', () => {
    const plan = parsePlanJson('{"tasks":[{"id":"t1","kind":"component","title":"Btn","instruction":"build","targetFiles":["Btn.tsx"]}]}');
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0]!.id).toBe('t1');
  });
  it('tolerates markdown fences and leading prose', () => {
    const plan = parsePlanJson('Here is the plan:\n```json\n{"tasks":[{"id":"a","kind":"schema","title":"S","instruction":"x","targetFiles":["s.ts"]}]}\n```');
    expect(plan.tasks[0]!.kind).toBe('schema');
  });
  it('throws on missing tasks array', () => {
    expect(() => parsePlanJson('{"foo":1}')).toThrow(/tasks/);
  });
});

describe('engine — worker output extraction', () => {
  it('extracts a fenced block with path= attribute', async () => {
    const text = 'Done.\n```tsx path=src/Button.tsx\nexport const Button = () => <button/>;\n```';
    const edits = await extractFileEdits(text, node('t', [], ['src/Button.tsx']), '/nonexistent-' + Date.now());
    expect(edits).toHaveLength(1);
    expect(edits[0]!.path).toBe('src/Button.tsx');
    expect(edits[0]!.content).toContain('export const Button');
  });

  it('falls back to single-target + single-block', async () => {
    const text = 'Here:\n```ts\nexport const x = 1;\n```';
    const edits = await extractFileEdits(text, node('t', [], ['only.ts']), '/nonexistent-' + Date.now());
    expect(edits).toHaveLength(1);
    expect(edits[0]!.path).toBe('only.ts');
  });
});
