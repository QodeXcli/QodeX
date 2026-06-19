import { describe, it, expect } from 'vitest';
import {
  capTextForEmbedding,
  embedChunksResilient,
  aggregateToFiles,
  EMBED_MAX_CHARS,
  type Chunk,
  type ScoredChunk,
} from '../src/context/retrieval.js';

function chunk(file: string, text: string, startLine = 1, endLine = 10): Chunk {
  return { file, startLine, endLine, text, hash: text.slice(0, 8) };
}

describe('capTextForEmbedding', () => {
  it('leaves short text untouched', () => {
    expect(capTextForEmbedding('hello')).toBe('hello');
  });
  it('truncates text longer than the cap', () => {
    const big = 'x'.repeat(EMBED_MAX_CHARS + 5000);
    expect(capTextForEmbedding(big).length).toBe(EMBED_MAX_CHARS);
  });
  it('honors a custom cap', () => {
    expect(capTextForEmbedding('abcdef', 3)).toBe('abc');
  });
});

describe('embedChunksResilient', () => {
  // An embedder that mimics nomic-embed-text: HTTP 400 if any input exceeds the window.
  const WINDOW = EMBED_MAX_CHARS;
  const fakeEmbed = async (texts: string[]) => {
    for (const t of texts) if (t.length > WINDOW) throw new Error('HTTP 400 input length exceeds context length');
    return texts.map(() => [0.1, 0.2, 0.3]);
  };

  it('embeds every chunk and assigns embeddings in place', async () => {
    const chunks = [chunk('a.ts', 'aaa'), chunk('b.ts', 'bbb')];
    const res = await embedChunksResilient(chunks, fakeEmbed);
    expect(res).toEqual({ embedded: 2, skipped: 0 });
    expect(chunks[0]!.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(chunks[1]!.embedding).toBeDefined();
  });

  it('caps an oversized chunk so it embeds instead of aborting the whole build', async () => {
    // The exact failure mode the recon hit: one huge chunk used to 400 and kill the build.
    const chunks = [
      chunk('ok.ts', 'small'),
      chunk('huge.test.js', 'B'.repeat(13457)), // the real-repo offender size
      chunk('also.ts', 'fine'),
    ];
    const res = await embedChunksResilient(chunks, fakeEmbed, { batchSize: 32 });
    expect(res.embedded).toBe(3);
    expect(res.skipped).toBe(0);
    expect(chunks.every(c => c.embedding && c.embedding.length > 0)).toBe(true);
  });

  it('skips only the unembeddable chunk when a batch still fails after capping', async () => {
    // A poison chunk that fails even at any length → only it is skipped, the rest survive.
    const poisonEmbed = async (texts: string[]) => {
      for (const t of texts) if (t.includes('POISON')) throw new Error('HTTP 400');
      return texts.map(() => [1, 2, 3]);
    };
    const chunks = [chunk('a.ts', 'good1'), chunk('p.ts', 'POISON'), chunk('b.ts', 'good2')];
    const res = await embedChunksResilient(chunks, poisonEmbed, { batchSize: 32 });
    expect(res).toEqual({ embedded: 2, skipped: 1 });
    expect(chunks[0]!.embedding).toBeDefined();
    expect(chunks[1]!.embedding).toBeUndefined(); // poison skipped
    expect(chunks[2]!.embedding).toBeDefined();
  });

  it('reports a skip when the embedder returns an empty vector', async () => {
    const emptyEmbed = async (texts: string[]) => texts.map((t) => (t === 'bad' ? [] : [9]));
    const chunks = [chunk('a.ts', 'bad'), chunk('b.ts', 'ok')];
    const res = await embedChunksResilient(chunks, emptyEmbed);
    expect(res.embedded).toBe(1);
    expect(res.skipped).toBe(1);
  });
});

describe('aggregateToFiles carries the best chunk code (for reranking)', () => {
  it('includes the actual text of each file\'s best chunk', () => {
    const scored: ScoredChunk[] = [
      { chunk: chunk('a.ts', 'export const pool = makePool();', 5, 7), score: 0.9 },
      { chunk: chunk('a.ts', 'lower scoring chunk', 20, 25), score: 0.3 },
      { chunk: chunk('b.ts', 'unrelated cafeteria menu', 1, 3), score: 0.8 },
    ];
    const ranked = aggregateToFiles(scored, 10);
    const a = ranked.find(r => r.file === 'a.ts')!;
    expect(a.text).toBe('export const pool = makePool();'); // best chunk's code, not the lower one
    expect(a.bestLines).toBe('5-7');
    expect(ranked.find(r => r.file === 'b.ts')!.text).toBe('unrelated cafeteria menu');
  });
});
