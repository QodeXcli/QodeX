/**
 * Hybrid search — BM25 (keyword) fused with embeddings (semantic).
 *
 * WHY: embedding-only retrieval is great for "code that does X" but weak for
 * exact-token queries — a function name, an error string, a config key. The
 * embedding of "getUserById" and "fetchAccountRecord" can be closer than
 * "getUserById" is to the literal string "getUserById" sitting in the code.
 * Keyword search (BM25) nails the exact-token case but is blind to meaning.
 *
 * Fusing the two gets the best of both: the semantic ranker surfaces
 * conceptually-related code, the lexical ranker guarantees exact matches rank
 * high, and Reciprocal Rank Fusion (RRF) combines them without needing the two
 * score scales to be comparable.
 *
 * Everything here is pure (no I/O, no model) and unit-tested. The embedding
 * vectors are computed elsewhere (retrieval.ts); this module only needs the
 * chunk text for BM25 and the precomputed similarity scores for fusion.
 *
 * BM25 reference: Okapi BM25 with the standard k1=1.5, b=0.75. We build a tiny
 * in-memory inverted index over the chunk corpus at query time — for the corpus
 * sizes QodeX sees (thousands of chunks) this is sub-millisecond and avoids
 * persisting yet another structure.
 */

import type { Chunk, ScoredChunk } from './retrieval.js';

// ── Tokenization for lexical search ─────────────────────────────────────────

/**
 * Split code/text into search tokens. Splits camelCase and snake_case so a
 * query "user id" matches an identifier "getUserById" / "user_id". Lowercased.
 */
export function tokenizeForSearch(text: string): string[] {
  const out: string[] = [];
  // First split on non-alphanumeric, then break camelCase within each piece.
  const rawTokens = text.split(/[^A-Za-z0-9]+/).filter(Boolean);
  for (const raw of rawTokens) {
    out.push(raw.toLowerCase());
    // camelCase / PascalCase → sub-words (getUserById → get, user, by, id)
    const camelParts = raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/\s+/).filter(Boolean);
    if (camelParts.length > 1) {
      for (const p of camelParts) {
        const lower = p.toLowerCase();
        if (lower !== raw.toLowerCase()) out.push(lower);
      }
    }
  }
  return out;
}

// ── BM25 ─────────────────────────────────────────────────────────────────────

const BM25_K1 = 1.5;
const BM25_B = 0.75;

export interface Bm25Index {
  /** chunk index → token-frequency map */
  docTokens: Map<number, Map<string, number>>;
  /** token → number of docs containing it */
  docFreq: Map<string, number>;
  /** chunk index → doc length (token count) */
  docLen: number[];
  avgDocLen: number;
  numDocs: number;
}

export function buildBm25Index(chunks: Chunk[]): Bm25Index {
  const docTokens = new Map<number, Map<string, number>>();
  const docFreq = new Map<string, number>();
  const docLen: number[] = [];
  let totalLen = 0;

  for (let i = 0; i < chunks.length; i++) {
    // Index the chunk text PLUS its symbol name (weighted by repetition) so an
    // exact function-name query scores its declaration highly.
    const symbolBoost = chunks[i]!.symbol ? ` ${chunks[i]!.symbol} ${chunks[i]!.symbol} ${chunks[i]!.symbol}` : '';
    const tokens = tokenizeForSearch(chunks[i]!.text + symbolBoost);
    docLen[i] = tokens.length;
    totalLen += tokens.length;
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    docTokens.set(i, tf);
    for (const term of tf.keys()) docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
  }

  return {
    docTokens,
    docFreq,
    docLen,
    avgDocLen: chunks.length > 0 ? totalLen / chunks.length : 0,
    numDocs: chunks.length,
  };
}

/** Score every doc against the query terms. Returns map docIndex → BM25 score (0 if no overlap). */
export function bm25Scores(index: Bm25Index, query: string): Map<number, number> {
  const qTokens = tokenizeForSearch(query);
  const scores = new Map<number, number>();
  if (qTokens.length === 0 || index.numDocs === 0) return scores;

  // Unique query terms with their IDF.
  const seen = new Set<string>();
  for (const term of qTokens) {
    if (seen.has(term)) continue;
    seen.add(term);
    const df = index.docFreq.get(term);
    if (!df) continue;
    // Okapi IDF with +1 smoothing to stay non-negative.
    const idf = Math.log(1 + (index.numDocs - df + 0.5) / (df + 0.5));
    for (const [docIdx, tf] of index.docTokens) {
      const f = tf.get(term);
      if (!f) continue;
      const len = index.docLen[docIdx] ?? 0;
      const denom = f + BM25_K1 * (1 - BM25_B + BM25_B * (len / (index.avgDocLen || 1)));
      const contribution = idf * ((f * (BM25_K1 + 1)) / (denom || 1));
      scores.set(docIdx, (scores.get(docIdx) ?? 0) + contribution);
    }
  }
  return scores;
}

// ── Reciprocal Rank Fusion ───────────────────────────────────────────────────

/**
 * RRF: given multiple ranked lists, score each item by sum of 1/(k + rank).
 * k=60 is the value from the original RRF paper (Cormack et al.); it damps the
 * contribution of low-ranked items without letting any single list dominate.
 * Score scales of the input lists don't need to match — only their ORDER is used.
 */
const RRF_K = 60;

export interface HybridResult {
  chunkIndex: number;
  rrfScore: number;
  semanticRank: number | null;
  lexicalRank: number | null;
}

export function reciprocalRankFusion(
  semanticRanked: number[], // chunk indices, best-first
  lexicalRanked: number[],  // chunk indices, best-first
): HybridResult[] {
  const semRank = new Map<number, number>();
  semanticRanked.forEach((idx, r) => semRank.set(idx, r));
  const lexRank = new Map<number, number>();
  lexicalRanked.forEach((idx, r) => lexRank.set(idx, r));

  const all = new Set<number>([...semanticRanked, ...lexicalRanked]);
  const fused: HybridResult[] = [];
  for (const idx of all) {
    const sr = semRank.has(idx) ? semRank.get(idx)! : null;
    const lr = lexRank.has(idx) ? lexRank.get(idx)! : null;
    let score = 0;
    if (sr !== null) score += 1 / (RRF_K + sr);
    if (lr !== null) score += 1 / (RRF_K + lr);
    fused.push({ chunkIndex: idx, rrfScore: score, semanticRank: sr, lexicalRank: lr });
  }
  fused.sort((a, b) => b.rrfScore - a.rrfScore);
  return fused;
}

/**
 * Full hybrid rank. Takes the chunks, the per-chunk semantic scores (cosine,
 * already computed against the query embedding), and the raw query string for
 * BM25. Returns the top-K chunks after fusion.
 *
 * `semanticScored` may be a subset (e.g. only chunks that had embeddings); any
 * chunk not in it simply has no semantic rank and relies on its lexical rank.
 */
export function hybridRank(
  chunks: Chunk[],
  semanticScored: ScoredChunk[],
  query: string,
  topK: number,
  bm25Index?: Bm25Index,
): ScoredChunk[] {
  // Semantic ranking → ordered chunk indices.
  const chunkToIndex = new Map<Chunk, number>();
  chunks.forEach((c, i) => chunkToIndex.set(c, i));
  const semanticRanked = semanticScored
    .map(s => chunkToIndex.get(s.chunk))
    .filter((i): i is number => i !== undefined);

  // Lexical ranking via BM25.
  const index = bm25Index ?? buildBm25Index(chunks);
  const lex = bm25Scores(index, query);
  const lexicalRanked = [...lex.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([idx]) => idx);

  // Fuse.
  const fused = reciprocalRankFusion(semanticRanked, lexicalRanked);

  // Map back to ScoredChunk, carrying the RRF score.
  const out: ScoredChunk[] = [];
  for (const f of fused.slice(0, topK)) {
    const chunk = chunks[f.chunkIndex];
    if (chunk) out.push({ chunk, score: f.rrfScore });
  }
  return out;
}
