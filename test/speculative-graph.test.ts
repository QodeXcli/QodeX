import { describe, it, expect } from 'vitest';
import { suggestDraftFamily, pickDraftModel, recommendedLookahead, SpecDecodeMonitor } from '../src/llm/speculative.js';
import { extractImportSpecifiers, resolveSpecifier, buildImportGraph, expandViaGraph } from '../src/context/import-graph.js';

describe('speculative — draft family', () => {
  it('recognizes qwen coder family', () => {
    const s = suggestDraftFamily('qwen3-coder-30b-instruct');
    expect(s?.family).toBe('qwen-coder');
    expect(s?.draftHints).toContain('0.5b');
  });
  it('returns null for unknown models', () => {
    expect(suggestDraftFamily('some-random-model-x')).toBeNull();
  });
  it('picks the smallest compatible local draft, never the target', () => {
    const target = 'qwen3-coder-30b';
    const available = ['qwen3-coder-30b', 'qwen3-coder-1.5b', 'qwen3-coder-0.5b', 'llama-3-8b'];
    const draft = pickDraftModel(target, available);
    expect(draft).toBe('qwen3-coder-0.5b'); // smallest hint first
    expect(draft).not.toBe(target);
  });
  it('returns null when no compatible draft is available', () => {
    expect(pickDraftModel('qwen3-coder-30b', ['llama-3-8b', 'mistral-7b'])).toBeNull();
  });
  it('recommends deeper lookahead for code than prose', () => {
    expect(recommendedLookahead('code-generation')).toBeGreaterThan(recommendedLookahead('explain'));
  });
});

describe('SpecDecodeMonitor', () => {
  it('flags a regression when draft-on is slower than draft-off', () => {
    const m = new SpecDecodeMonitor();
    for (let i = 0; i < 5; i++) m.record(100, 2000, true);  // 50 tok/s with draft
    for (let i = 0; i < 5; i++) m.record(100, 1000, false); // 100 tok/s without
    expect(m.checkRegression()).toMatch(/counterproductive/i);
  });
  it('stays silent without enough samples', () => {
    const m = new SpecDecodeMonitor();
    m.record(100, 1000, true);
    expect(m.checkRegression()).toBeNull();
  });
  it('warns at most once', () => {
    const m = new SpecDecodeMonitor();
    for (let i = 0; i < 5; i++) { m.record(100, 2000, true); m.record(100, 1000, false); }
    expect(m.checkRegression()).not.toBeNull();
    expect(m.checkRegression()).toBeNull(); // second call silent
  });
});

describe('import-graph — specifier extraction', () => {
  it('extracts JS/TS imports of all shapes', () => {
    const src = `
      import { a } from './a';
      import b from '../b';
      import './side-effect';
      const c = require('./c');
      const d = await import('./d');
    `;
    const specs = extractImportSpecifiers(src, 'js');
    expect(specs).toEqual(expect.arrayContaining(['./a', '../b', './side-effect', './c', './d']));
  });
  it('extracts Python imports', () => {
    const src = 'from .models import User\nimport os\nfrom app.db import session';
    const specs = extractImportSpecifiers(src, 'python');
    expect(specs).toEqual(expect.arrayContaining(['.models', 'os', 'app.db']));
  });
});

describe('import-graph — resolution', () => {
  const fileSet = new Set(['src/cart/Cart.tsx', 'src/store/cartSlice.ts', 'src/api/client.ts', 'src/store/index.ts']);
  const basenameIndex = new Map<string, string[]>([
    ['Cart', ['src/cart/Cart.tsx']],
    ['cartSlice', ['src/store/cartSlice.ts']],
    ['client', ['src/api/client.ts']],
    ['index', ['src/store/index.ts']],
  ]);

  it('resolves a relative import with extension inference', () => {
    const r = resolveSpecifier('../store/cartSlice', 'src/cart/Cart.tsx', fileSet, basenameIndex);
    expect(r).toBe('src/store/cartSlice.ts');
  });
  it('resolves a path alias by basename (e.g. @/api/client)', () => {
    const r = resolveSpecifier('@/api/client', 'src/cart/Cart.tsx', fileSet, basenameIndex);
    expect(r).toBe('src/api/client.ts');
  });
  it('returns null for external npm packages', () => {
    const r = resolveSpecifier('react', 'src/cart/Cart.tsx', fileSet, basenameIndex);
    expect(r).toBeNull();
  });
});

describe('import-graph — build + expand', () => {
  it('builds edges and expands a seed to its dependencies', async () => {
    const files = [
      { rel: 'Cart.tsx', content: "import { addItem } from './cartSlice';\nimport { api } from './client';" },
      { rel: 'cartSlice.ts', content: "import { db } from './db';" },
      { rel: 'client.ts', content: '' },
      { rel: 'db.ts', content: '' },
    ];
    const graph = await buildImportGraph('/proj', files);
    // Cart imports cartSlice and client
    expect(graph.out.get('Cart.tsx')!.has('cartSlice.ts')).toBe(true);
    expect(graph.out.get('Cart.tsx')!.has('client.ts')).toBe(true);

    // Expanding from Cart with 1 hop reaches its direct deps.
    const exp1 = expandViaGraph(graph, ['Cart.tsx'], { hops: 1 });
    const files1 = exp1.map(e => e.file);
    expect(files1).toContain('cartSlice.ts');
    expect(files1).toContain('client.ts');

    // 2 hops reaches db (Cart → cartSlice → db).
    const exp2 = expandViaGraph(graph, ['Cart.tsx'], { hops: 2 });
    expect(exp2.map(e => e.file)).toContain('db.ts');
  });

  it('respects maxFiles cap', async () => {
    const files = Array.from({ length: 20 }, (_, i) => ({
      rel: `f${i}.ts`,
      content: i === 0 ? Array.from({ length: 19 }, (_, j) => `import './f${j + 1}';`).join('\n') : '',
    }));
    const graph = await buildImportGraph('/p', files);
    const exp = expandViaGraph(graph, ['f0.ts'], { hops: 1, maxFiles: 5 });
    expect(exp.length).toBeLessThanOrEqual(5);
  });
});
