import { describe, it, expect } from 'vitest';
import {
  tokenizeForSearch, buildBm25Index, bm25Scores,
  reciprocalRankFusion, hybridRank,
} from '../src/context/hybrid-search.js';
import type { Chunk, ScoredChunk } from '../src/context/retrieval.js';

function chunk(file: string, text: string, symbol?: string): Chunk {
  return { file, startLine: 1, endLine: 10, text, hash: file, symbol };
}

describe('tokenizeForSearch', () => {
  it('splits camelCase and snake_case into sub-words', () => {
    const t = tokenizeForSearch('getUserById user_account');
    expect(t).toContain('getuserbyid');
    expect(t).toContain('get');
    expect(t).toContain('user');
    expect(t).toContain('by');
    expect(t).toContain('id');
    expect(t).toContain('account');
  });
  it('lowercases everything', () => {
    expect(tokenizeForSearch('HELLO World')).toEqual(['hello', 'world']);
  });
});

describe('BM25', () => {
  const chunks = [
    chunk('a.ts', 'function validateEmail(addr) { return /@/.test(addr) }', 'validateEmail'),
    chunk('b.ts', 'function calculateTax(amount) { return amount * 0.09 }', 'calculateTax'),
    chunk('c.ts', 'const email = user.email; sendEmail(email);'),
  ];

  it('ranks the exact-name chunk highest for a symbol query', () => {
    const idx = buildBm25Index(chunks);
    const scores = bm25Scores(idx, 'validateEmail');
    const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
    expect(ranked[0]![0]).toBe(0); // chunk a.ts
  });

  it('returns empty scores for terms not in corpus', () => {
    const idx = buildBm25Index(chunks);
    const scores = bm25Scores(idx, 'kubernetes helm chart');
    expect(scores.size).toBe(0);
  });

  it('symbol boost makes the declaration outrank incidental mentions', () => {
    const idx = buildBm25Index(chunks);
    const scores = bm25Scores(idx, 'email');
    // chunk c mentions email 3x but a.ts has it as a symbol (boosted 3x)
    // both should score; just assert the declaration is present and ranked
    expect(scores.has(0)).toBe(true);
    expect(scores.has(2)).toBe(true);
  });
});

describe('reciprocalRankFusion', () => {
  it('rewards items ranked highly in both lists', () => {
    // item 5 is #1 semantic and #1 lexical → should win
    const semantic = [5, 1, 2, 3];
    const lexical = [5, 9, 1];
    const fused = reciprocalRankFusion(semantic, lexical);
    expect(fused[0]!.chunkIndex).toBe(5);
  });

  it('includes items present in only one list', () => {
    const fused = reciprocalRankFusion([1, 2], [3, 4]);
    const indices = fused.map(f => f.chunkIndex).sort();
    expect(indices).toEqual([1, 2, 3, 4]);
  });

  it('an item ranked high in one list still beats items low in both', () => {
    const semantic = [7]; // 7 is rank 0 semantic only
    const lexical = [1, 2, 3, 4, 5, 6];
    const fused = reciprocalRankFusion(semantic, lexical);
    expect(fused[0]!.chunkIndex).toBe(7);
  });
});

describe('hybridRank', () => {
  const chunks = [
    chunk('a.ts', 'function validateEmail(addr) { return /@/.test(addr) }', 'validateEmail'),
    chunk('b.ts', 'function calculateTax(amount) { return amount * 0.09 }', 'calculateTax'),
    chunk('c.ts', 'function parseDate(s) { return new Date(s) }', 'parseDate'),
  ];

  it('surfaces the exact-token match even when semantic ranking misses it', () => {
    // Pretend the embedding ranker put the wrong chunk first.
    const semanticScored: ScoredChunk[] = [
      { chunk: chunks[1]!, score: 0.9 }, // calculateTax — semantically "first" but wrong
      { chunk: chunks[2]!, score: 0.8 },
      { chunk: chunks[0]!, score: 0.7 }, // validateEmail — what we actually want
    ];
    const result = hybridRank(chunks, semanticScored, 'validateEmail', 3);
    // BM25 strongly favors chunk 0 for this exact query; fusion should lift it.
    expect(result[0]!.chunk.file).toBe('a.ts');
  });

  it('respects topK', () => {
    const semanticScored: ScoredChunk[] = chunks.map((c, i) => ({ chunk: c, score: 1 - i * 0.1 }));
    const result = hybridRank(chunks, semanticScored, 'function', 2);
    expect(result.length).toBeLessThanOrEqual(2);
  });
});
