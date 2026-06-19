import { describe, it, expect, vi, afterEach } from 'vitest';
import { crossEncoderRerank } from '../src/context/reranker.js';

// The reranker uses proxyFetch internally; we stub global fetch since proxyFetch
// delegates to it when no proxy is set.
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

describe('crossEncoderRerank', () => {
  it('returns empty for no candidates without calling the network', async () => {
    const out = await crossEncoderRerank('q', []);
    expect(out).toEqual([]);
  });

  it('reorders candidates by reranker score (Ollama shape)', async () => {
    globalThis.fetch = (async (url: any) => {
      if (String(url).includes('/api/rerank')) {
        return {
          ok: true,
          json: async () => ({ results: [
            { index: 0, relevance_score: 0.1 },
            { index: 1, relevance_score: 0.9 },
          ] }),
        } as any;
      }
      return { ok: false } as any;
    }) as any;

    const out = await crossEncoderRerank('login bug', [
      { id: 'a.ts', text: 'unrelated' },
      { id: 'b.ts', text: 'login logic' },
    ]);
    expect(out).not.toBeNull();
    expect(out![0].id).toBe('b.ts'); // higher score first
    expect(out![1].id).toBe('a.ts');
  });

  it('respects topN', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ results: [
        { index: 0, relevance_score: 0.5 },
        { index: 1, relevance_score: 0.8 },
        { index: 2, relevance_score: 0.2 },
      ] }),
    } as any)) as any;

    const out = await crossEncoderRerank('q',
      [{ id: '1', text: 'x' }, { id: '2', text: 'y' }, { id: '3', text: 'z' }],
      { topN: 2 });
    expect(out).toHaveLength(2);
    expect(out![0].id).toBe('2');
  });

  it('returns null when no reranker endpoint is reachable', async () => {
    globalThis.fetch = (async () => ({ ok: false } as any)) as any;
    const out = await crossEncoderRerank('q', [{ id: '1', text: 'x' }]);
    expect(out).toBeNull(); // caller falls back to bi-encoder order
  });
});
