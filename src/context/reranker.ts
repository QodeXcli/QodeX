/**
 * Cross-Encoder Reranking (second-stage retrieval).
 *
 * The hybrid search (BM25 + dense embeddings) is a BI-ENCODER: query and
 * document are embedded *independently*, so their vectors can't attend to each
 * other. That's fast and great for a first pass, but it can miss deep relevance —
 * e.g. tying "a specific error in the log" to "the logic of a function at line
 * 400" — because the model never sees the two texts together.
 *
 * A CROSS-ENCODER fixes this: it feeds (query, document) as ONE input so
 * attention runs directly between the query terms and the code lines, producing
 * a far more accurate relevance score. It's too slow to run over a whole repo,
 * so the winning pattern is two-stage:
 *
 *   1. Hybrid search → top-K candidates fast (K ≈ 24-100).
 *   2. Cross-encoder rerank those K → top-N most truly relevant (N ≈ 6-10).
 *
 * This module is the stage-2 reranker. It calls a LOCAL reranker endpoint
 * (Ollama-compatible /api/rerank, or an OpenAI-style /v1/rerank such as a local
 * bge-reranker / cohere-reranker served via LM Studio or a small server). If no
 * reranker is reachable or it errors, we DEGRADE CLEANLY: return the input order
 * unchanged, so retrieval still works exactly as before. Reranking is therefore
 * a strict, optional improvement — never a new failure mode.
 */

import { logger } from '../utils/logger.js';
import { proxyFetch } from '../utils/proxy-fetch.js';

export interface RerankCandidate {
  /** Stable id the caller uses to map back to its own object (file path, chunk id…). */
  id: string;
  /** The text scored against the query (code chunk / doc snippet). */
  text: string;
}

export interface RerankResult {
  id: string;
  score: number;
}

export interface RerankOptions {
  /** Base URL of the reranker server. Default: Ollama at localhost:11434. */
  baseUrl?: string;
  /** Reranker model name, e.g. 'bge-reranker-large', 'bge-reranker-v2-m3'. */
  model?: string;
  /** Return at most this many results (the top-N). Default: all. */
  topN?: number;
  /** Truncate each candidate to this many chars before sending. Default 2000. */
  maxCharsPerDoc?: number;
  signal?: AbortSignal;
}

/**
 * Rerank candidates against the query with a local cross-encoder.
 * Returns results sorted best-first, or null if no reranker was reachable
 * (caller should then fall back to the bi-encoder order).
 */
export async function crossEncoderRerank(
  query: string,
  candidates: RerankCandidate[],
  opts: RerankOptions = {},
): Promise<RerankResult[] | null> {
  if (candidates.length === 0) return [];
  const baseUrl = opts.baseUrl ?? process.env.QODEX_RERANK_URL ?? process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
  const model = opts.model ?? process.env.QODEX_RERANK_MODEL ?? 'bge-reranker-v2-m3';
  const maxChars = opts.maxCharsPerDoc ?? 2000;

  const documents = candidates.map(c =>
    c.text.length > maxChars ? c.text.slice(0, maxChars) : c.text,
  );

  // Try the two common local reranker API shapes in turn. Both take
  // {query, documents[]} and return per-document relevance scores.
  const scores = await tryOllamaRerank(baseUrl, model, query, documents, opts.signal)
    ?? await tryOpenAIRerank(baseUrl, model, query, documents, opts.signal);

  if (!scores) return null; // nothing reachable — caller falls back

  const results: RerankResult[] = candidates.map((c, i) => ({
    id: c.id,
    score: scores[i] ?? 0,
  }));
  results.sort((a, b) => b.score - a.score);
  return typeof opts.topN === 'number' ? results.slice(0, opts.topN) : results;
}

/** Ollama-style reranker: POST /api/rerank {model, query, documents} → {results:[{index,relevance_score}]}. */
async function tryOllamaRerank(
  baseUrl: string,
  model: string,
  query: string,
  documents: string[],
  signal?: AbortSignal,
): Promise<number[] | null> {
  try {
    const res = await proxyFetch(`${baseUrl.replace(/\/$/, '')}/api/rerank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, query, documents }),
      signal,
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const arr = data?.results ?? data?.data;
    if (!Array.isArray(arr)) return null;
    // Map back to input order by index.
    const scores = new Array<number>(documents.length).fill(0);
    for (const r of arr) {
      const idx = r.index ?? r.document?.index;
      const score = r.relevance_score ?? r.score ?? r.relevance;
      if (typeof idx === 'number' && typeof score === 'number') scores[idx] = score;
    }
    return scores;
  } catch (e: any) {
    logger.debug('Ollama rerank not available', { err: e?.message });
    return null;
  }
}

/** OpenAI/Cohere-style reranker: POST /v1/rerank {model, query, documents} → {results:[{index,relevance_score}]}. */
async function tryOpenAIRerank(
  baseUrl: string,
  model: string,
  query: string,
  documents: string[],
  signal?: AbortSignal,
): Promise<number[] | null> {
  try {
    const res = await proxyFetch(`${baseUrl.replace(/\/$/, '')}/v1/rerank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, query, documents, top_n: documents.length }),
      signal,
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const arr = data?.results;
    if (!Array.isArray(arr)) return null;
    const scores = new Array<number>(documents.length).fill(0);
    for (const r of arr) {
      const idx = r.index;
      const score = r.relevance_score ?? r.score;
      if (typeof idx === 'number' && typeof score === 'number') scores[idx] = score;
    }
    return scores;
  } catch (e: any) {
    logger.debug('OpenAI-style rerank not available', { err: e?.message });
    return null;
  }
}
