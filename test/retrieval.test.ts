import { describe, it, expect } from 'vitest';
import {
  cosineSim, rankChunks, aggregateToFiles, formatRetrievalBlock,
  chunkFile, retrieveRelevantFiles,
  type Chunk,
} from '../src/context/retrieval.js';

describe('cosineSim', () => {
  it('is 1 for identical vectors, 0 for orthogonal', () => {
    expect(cosineSim([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSim([1, 0], [0, 1])).toBeCloseTo(0);
  });
  it('handles zero vectors without NaN', () => {
    expect(cosineSim([0, 0], [1, 1])).toBe(0);
  });
});

function chunk(file: string, startLine: number, embedding: number[]): Chunk {
  return { file, startLine, endLine: startLine + 29, text: `code in ${file}`, embedding, hash: `${file}:${startLine}` };
}

describe('rankChunks', () => {
  it('ranks by cosine similarity, best first, capped at topK', () => {
    const q = [1, 0, 0];
    const chunks = [
      chunk('far.ts', 1, [0, 1, 0]),
      chunk('near.ts', 1, [0.9, 0.1, 0]),
      chunk('mid.ts', 1, [0.5, 0.5, 0]),
    ];
    const ranked = rankChunks(q, chunks, 2);
    expect(ranked).toHaveLength(2);
    expect(ranked[0]!.chunk.file).toBe('near.ts');
    expect(ranked[1]!.chunk.file).toBe('mid.ts');
  });
  it('skips chunks without embeddings', () => {
    const chunks: Chunk[] = [{ file: 'a.ts', startLine: 1, endLine: 5, text: 'x', hash: 'h' }];
    expect(rankChunks([1, 0], chunks, 5)).toHaveLength(0);
  });
});

describe('aggregateToFiles', () => {
  it('collapses chunks to files using the best chunk per file', () => {
    const scored = [
      { chunk: chunk('a.ts', 1, []), score: 0.9 },
      { chunk: chunk('a.ts', 30, []), score: 0.5 },
      { chunk: chunk('b.ts', 1, []), score: 0.7 },
    ];
    const files = aggregateToFiles(scored, 10);
    expect(files).toHaveLength(2);
    expect(files[0]).toEqual({ file: 'a.ts', score: 0.9, bestLines: '1-30', text: 'code in a.ts' });
    expect(files[1]!.file).toBe('b.ts');
  });
  it('caps the number of files', () => {
    const scored = [
      { chunk: chunk('a.ts', 1, []), score: 0.9 },
      { chunk: chunk('b.ts', 1, []), score: 0.8 },
      { chunk: chunk('c.ts', 1, []), score: 0.7 },
    ];
    expect(aggregateToFiles(scored, 2)).toHaveLength(2);
  });
});

describe('formatRetrievalBlock', () => {
  it('returns empty string when no files', () => {
    expect(formatRetrievalBlock([])).toBe('');
  });
  it('renders a readable block with paths and lines', () => {
    const block = formatRetrievalBlock([{ file: 'src/cart.ts', score: 0.812, bestLines: '10-40' }]);
    expect(block).toContain('auto-retrieved');
    expect(block).toContain('src/cart.ts');
    expect(block).toContain('10-40');
    expect(block).toContain('0.812');
  });
});

describe('chunkFile', () => {
  it('produces overlapping windows and skips tiny tails', () => {
    const content = Array.from({ length: 70 }, (_, i) => `line ${i}`).join('\n');
    const chunks = chunkFile('big.ts', content, 30, 5);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.startLine).toBe(1);
    expect(chunks[0]!.endLine).toBe(30);
    // second window starts at 26 (30-5 overlap → step 25)
    expect(chunks[1]!.startLine).toBe(26);
  });
});

describe('retrieveRelevantFiles — graceful fallback', () => {
  it('returns null (never throws) when Ollama is unreachable', async () => {
    // Point at a closed port so the reachability probe fails fast.
    const result = await retrieveRelevantFiles(process.cwd(), 'anything', {
      baseUrl: 'http://127.0.0.1:1',
      signal: AbortSignal.timeout(1000),
    });
    expect(result).toBeNull();
  });
});
