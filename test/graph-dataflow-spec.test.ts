import { describe, it, expect } from 'vitest';
import { buildImportGraph, expandViaGraph } from '../src/context/import-graph.js';
import { analyzeDataFlow, dependenciesOf } from '../src/context/data-flow.js';
import { AdaptiveLookahead, buildSpecDecodeExtras } from '../src/llm/speculative.js';

describe('hub down-weighting', () => {
  it('demotes a file imported by many others', async () => {
    // utils.ts is imported by f1..f10; cartSlice only by Cart.
    const files = [
      { rel: 'Cart.tsx', content: "import './cartSlice';\nimport './utils';" },
      { rel: 'cartSlice.ts', content: "import './utils';" },
      ...Array.from({ length: 9 }, (_, i) => ({ rel: `f${i}.ts`, content: "import './utils';" })),
      { rel: 'utils.ts', content: '' },
    ];
    const graph = await buildImportGraph('/p', files);
    const exp = expandViaGraph(graph, ['Cart.tsx'], { hops: 1, hubDamping: true });
    const cart = exp.find(e => e.file === 'cartSlice.ts');
    const utils = exp.find(e => e.file === 'utils.ts');
    expect(cart).toBeDefined();
    expect(utils).toBeDefined();
    // cartSlice (in-degree 1) should outweigh utils (in-degree 11) at same distance.
    expect(cart!.weight).toBeGreaterThan(utils!.weight);
  });

  it('hubDamping=false leaves hubs at full weight', async () => {
    const files = [
      { rel: 'A.ts', content: "import './hub';\nimport './leaf';" },
      { rel: 'hub.ts', content: '' },
      { rel: 'leaf.ts', content: '' },
      { rel: 'B.ts', content: "import './hub';" },
      { rel: 'C.ts', content: "import './hub';" },
    ];
    const graph = await buildImportGraph('/p', files);
    const damped = expandViaGraph(graph, ['A.ts'], { hops: 1, hubDamping: true });
    const undamped = expandViaGraph(graph, ['A.ts'], { hops: 1, hubDamping: false });
    const hubDamped = damped.find(e => e.file === 'hub.ts')!.weight;
    const hubUndamped = undamped.find(e => e.file === 'hub.ts')!.weight;
    expect(hubUndamped).toBeGreaterThan(hubDamped);
  });
});

describe('data-flow free variables', () => {
  it('finds external symbols a JS function depends on', async () => {
    const src = `
      import { dispatch } from './store';
      function addToCart(item) {
        const qty = item.quantity;
        dispatch(addItem(item));
        return cartTotal(qty);
      }
    `;
    const flows = await analyzeDataFlow('cart.ts', src);
    const addToCart = flows.find(f => f.name === 'addToCart');
    expect(addToCart).toBeDefined();
    const names = addToCart!.freeVars.map(v => v.name);
    // dispatch, addItem, cartTotal are free; item, qty are local/param
    expect(names).toContain('dispatch');
    expect(names).toContain('cartTotal');
    expect(names).not.toContain('qty');   // local
    expect(names).not.toContain('item');  // param
  });

  it('dependenciesOf returns the free vars for a named function', async () => {
    const src = `function f(a) { return g(a) + GLOBAL_X; }`;
    const deps = await dependenciesOf('x.ts', src, 'f');
    expect(deps).toContain('g');
    expect(deps).toContain('GLOBAL_X');
    expect(deps).not.toContain('a');
  });

  it('returns [] gracefully for unsupported content', async () => {
    const flows = await analyzeDataFlow('readme.txt', 'just some prose');
    expect(Array.isArray(flows)).toBe(true);
  });
});

describe('AdaptiveLookahead (AIMD)', () => {
  it('increases the window when throughput improves', () => {
    const a = new AdaptiveLookahead(4);
    a.update(50);          // sets baseline
    const w = a.update(60); // improved → +1
    expect(w).toBe(5);
  });

  it('cuts the window when throughput regresses', () => {
    const a = new AdaptiveLookahead(6);
    a.update(100);          // baseline
    const w = a.update(50); // big regression → ×0.6
    expect(w).toBeLessThan(6);
  });

  it('clamps to [min,max]', () => {
    const a = new AdaptiveLookahead(8, 2, 8);
    a.update(10);
    for (let i = 0; i < 10; i++) a.update(1000); // keep improving
    expect(a.current()).toBeLessThanOrEqual(8);
  });

  it('retarget resets baseline', () => {
    const a = new AdaptiveLookahead(4);
    a.update(50);
    a.retarget(3);
    expect(a.current()).toBe(3);
  });
});

describe('buildSpecDecodeExtras — multi-server', () => {
  it('LM Studio gets draft_model', () => {
    const e = buildSpecDecodeExtras('qwen-0.5b', 5, 'lmstudio');
    expect(e.draft_model).toBe('qwen-0.5b');
    expect(e.model_draft).toBeUndefined();
  });
  it('llama.cpp gets model_draft + n_draft', () => {
    const e = buildSpecDecodeExtras('qwen-0.5b', 5, 'llamacpp');
    expect(e.model_draft).toBe('qwen-0.5b');
    expect(e.n_draft).toBe(5);
  });
  it('vLLM gets num_speculative_tokens', () => {
    const e = buildSpecDecodeExtras('qwen-0.5b', 5, 'vllm');
    expect(e.num_speculative_tokens).toBe(5);
  });
  it('auto sends the harmless union', () => {
    const e = buildSpecDecodeExtras('qwen-0.5b', 5, 'auto');
    expect(e.draft_model).toBe('qwen-0.5b');
    expect(e.model_draft).toBe('qwen-0.5b');
    expect(e.num_speculative_tokens).toBe(5);
  });
});
