/**
 * Embedding-based code retrieval — the shared core behind both the `semantic_search`
 * tool and the automatic context pre-pass.
 *
 * WHY THE PRE-PASS MATTERS (local-first specific): `semantic_search` already exists, but
 * it's an *optional tool the model must remember to call* — and weaker local models
 * frequently don't, falling back to blind grep. The model can't reason about code it
 * never pulled into context. `retrieveRelevantFiles()` runs the same ranking
 * automatically before the first turn and injects a "relevant files" hint, so the model
 * starts already pointed at the right part of a large codebase.
 *
 * Design constraints for the pre-pass:
 *   - NEVER block startup: if Ollama is down or no index exists, return null silently.
 *   - Reuse the index `semantic_search` builds (same path/format) — no double work.
 *   - Pure ranking/aggregation split out so it's unit-testable with no model.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import * as os from 'os';
import { logger } from '../utils/logger.js';

export const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', 'vendor', '.cache', 'coverage', '__pycache__', '.venv', 'venv']);
export const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.php', '.rb', '.go', '.java', '.rs', '.vue', '.svelte', '.md', '.mdx']);

export interface Chunk {
  file: string;
  startLine: number;
  endLine: number;
  text: string;
  embedding?: number[];
  hash: string;
  /** Declaration name when the chunk came from an AST boundary (function/class/etc). */
  symbol?: string;
}

export interface Index {
  projectRoot: string;
  embeddingModel: string;
  chunks: Chunk[];
  builtAt: number;
}

export async function walkSource(root: string, maxFiles: number): Promise<{ abs: string; rel: string; content: string }[]> {
  const out: { abs: string; rel: string; content: string }[] = [];
  const stack = [root];
  while (stack.length > 0 && out.length < maxFiles) {
    const dir = stack.pop()!;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (out.length >= maxFiles) break;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        stack.push(path.join(dir, e.name));
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (!SOURCE_EXTS.has(ext)) continue;
        const abs = path.join(dir, e.name);
        try {
          const stat = await fs.stat(abs);
          if (stat.size > 500_000) continue;
          const content = await fs.readFile(abs, 'utf-8');
          out.push({ abs, rel: path.relative(root, abs), content });
        } catch { /* skip */ }
      }
    }
  }
  return out;
}

export function chunkFile(rel: string, content: string, chunkLines: number, overlap: number): Chunk[] {
  const lines = content.split('\n');
  const out: Chunk[] = [];
  for (let i = 0; i < lines.length; i += (chunkLines - overlap)) {
    const start = i;
    const end = Math.min(i + chunkLines, lines.length);
    if (end - start < 5) continue;
    const text = lines.slice(start, end).join('\n');
    const hash = createHash('sha1').update(text).digest('hex').slice(0, 12);
    out.push({ file: rel, startLine: start + 1, endLine: end, text, hash });
    if (end >= lines.length) break;
  }
  return out;
}

export async function ollamaEmbed(baseUrl: string, model: string, texts: string[], signal?: AbortSignal): Promise<number[][]> {
  const r = await fetch(`${baseUrl.replace(/\/$/, '')}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: texts }),
    signal,
  });
  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    throw new Error(`Ollama /api/embed HTTP ${r.status}: ${errText.slice(0, 200)}`);
  }
  const data = await r.json() as any;
  if (!data.embeddings || !Array.isArray(data.embeddings)) {
    throw new Error('Ollama response missing embeddings array');
  }
  return data.embeddings;
}

/**
 * Max characters of a single chunk we send to the embedder. nomic-embed-text has a
 * ~2048-token window; code tokenizes denser than prose, so ~6000 chars is a safe
 * ceiling. A pathological chunk (one huge function, a giant template literal, a
 * minified file) used to return HTTP 400 and — because the error propagated up —
 * abort the ENTIRE index build, leaving auto-retrieval silently disabled on any
 * repo containing even one big file. We now cap instead.
 */
export const EMBED_MAX_CHARS = 6000;

/** Truncate an over-long chunk so it never blows the embedder's context window. Pure. */
export function capTextForEmbedding(text: string, maxChars = EMBED_MAX_CHARS): string {
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

/**
 * Embed chunks resiliently: one oversized or otherwise-unembeddable chunk must never
 * sink the whole index build. We cap each chunk's text first (the common 400 cause),
 * embed in batches, and if a batch still fails we retry it one chunk at a time and skip
 * any individual chunk that won't embed — its `embedding` stays undefined and is filtered
 * out by downstream ranking. Mutates `chunks[].embedding` in place; returns counts.
 *
 * `embed` is injected (the live caller passes an ollamaEmbed closure) so this is
 * unit-testable without a model. Pure aside from the in-place embedding assignment.
 */
export async function embedChunksResilient(
  chunks: Chunk[],
  embed: (texts: string[]) => Promise<number[][]>,
  opts: { batchSize?: number; maxChars?: number; onProgress?: (msg: string) => void } = {},
): Promise<{ embedded: number; skipped: number }> {
  const batchSize = opts.batchSize ?? 32;
  const maxChars = opts.maxChars ?? EMBED_MAX_CHARS;
  let embedded = 0;
  let skipped = 0;
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const texts = batch.map(c => capTextForEmbedding(c.text, maxChars));
    try {
      const embs = await embed(texts);
      for (let j = 0; j < batch.length; j++) {
        if (embs[j] && embs[j]!.length > 0) { batch[j]!.embedding = embs[j]; embedded++; }
        else skipped++;
      }
    } catch {
      // Batch failed (e.g. one chunk still 400s) — degrade to per-chunk so a single
      // bad chunk costs only itself, not every chunk in the batch.
      for (let j = 0; j < batch.length; j++) {
        try {
          const [e] = await embed([capTextForEmbedding(batch[j]!.text, maxChars)]);
          if (e && e.length > 0) { batch[j]!.embedding = e; embedded++; }
          else skipped++;
        } catch { skipped++; }
      }
    }
    if (opts.onProgress && i % 256 === 0) {
      opts.onProgress(`  ${Math.min(i + batchSize, chunks.length)}/${chunks.length}`);
    }
  }
  return { embedded, skipped };
}

export function cosineSim(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function indexPath(projectRoot: string, embeddingModel: string): string {
  const hash = createHash('sha1').update(`${projectRoot}::${embeddingModel}`).digest('hex').slice(0, 16);
  return path.join(os.homedir(), '.qodex', 'embeddings', `${hash}.json`);
}

export async function loadIndex(p: string): Promise<Index | null> {
  try { return JSON.parse(await fs.readFile(p, 'utf-8')); } catch { return null; }
}

export async function saveIndex(p: string, idx: Index): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(idx));
}

/**
 * Persist an index in BOTH formats: the SQLite quantized store (preferred for
 * search — small + fast) and the JSON file (kept as a portable fallback and for
 * the staleness re-index heuristic). SQLite write is best-effort; if
 * better-sqlite3 can't load we still have the JSON.
 */
export async function persistIndex(projectRoot: string, embeddingModel: string, idx: Index): Promise<void> {
  await saveIndex(indexPath(projectRoot, embeddingModel), idx).catch(() => {});
  try {
    const { buildSqliteIndex } = await import('./sqlite-index.js');
    await buildSqliteIndex(projectRoot, embeddingModel, idx.chunks);
  } catch { /* SQLite optional — JSON remains authoritative */ }
}

/**
 * Search the persisted index for a project, preferring the SQLite quantized
 * store and falling back to the in-memory JSON index. Returns hybrid-ranked
 * scored chunks. `idxForFallback` is the already-loaded JSON index (so we don't
 * read it twice); pass null to force SQLite-only.
 */
export async function searchPersisted(
  projectRoot: string,
  embeddingModel: string,
  query: string,
  queryEmbedding: number[],
  topK: number,
  idxForFallback: Index | null,
  semanticOnly = false,
): Promise<ScoredChunk[]> {
  // Try SQLite first.
  try {
    const { openSqliteIndex, searchSqlite, allChunksFromSqlite } = await import('./sqlite-index.js');
    const handle = await openSqliteIndex(projectRoot, embeddingModel);
    if (handle) {
      // Wide semantic pool from the quantized store…
      const semantic = searchSqlite(handle, queryEmbedding, Math.max(topK * 3, 50));
      if (semanticOnly) {
        handle.db.close();
        return semantic.slice(0, topK);
      }
      // …then fuse with BM25 over the full chunk set.
      const allChunks = allChunksFromSqlite(handle);
      const { hybridRank } = await import('./hybrid-search.js');
      const fused = hybridRank(allChunks, semantic, query, topK);
      handle.db.close();
      return fused;
    }
  } catch { /* fall through to JSON */ }

  // JSON fallback.
  if (!idxForFallback) return [];
  if (semanticOnly) return rankChunks(queryEmbedding, idxForFallback.chunks, topK);
  return rankChunksHybrid(queryEmbedding, query, idxForFallback.chunks, topK);
}

export async function buildIndex(
  projectRoot: string,
  embeddingModel: string,
  baseUrl: string,
  maxFiles: number,
  signal: AbortSignal | undefined,
  onProgress: (msg: string) => void,
): Promise<Index> {
  const files = await walkSource(projectRoot, maxFiles);
  onProgress(`Indexing ${files.length} file(s)…`);
  const chunks: Chunk[] = [];
  // AST-aware chunking (semantic boundaries) with line-based fallback per file.
  const { astChunkFile } = await import('./ast-chunk.js');
  for (const f of files) {
    try {
      chunks.push(...await astChunkFile(f.rel, f.content));
    } catch {
      chunks.push(...chunkFile(f.rel, f.content, 40, 8));
    }
  }
  onProgress(`Embedding ${chunks.length} chunk(s) with ${embeddingModel}…`);
  const { skipped } = await embedChunksResilient(
    chunks,
    (texts) => ollamaEmbed(baseUrl, embeddingModel, texts, signal),
    { batchSize: 32, onProgress },
  );
  if (skipped > 0) onProgress(`  (skipped ${skipped} oversized/unembeddable chunk(s))`);
  return { projectRoot, embeddingModel, chunks, builtAt: Date.now() };
}

// ── Pure ranking / aggregation (unit-testable, no model) ────────────────────────

export interface ScoredChunk { chunk: Chunk; score: number; }

/** Rank all embedded chunks against a query embedding, best first. */
export function rankChunks(queryEmbedding: number[], chunks: Chunk[], topK: number): ScoredChunk[] {
  return chunks
    .filter(c => c.embedding && c.embedding.length > 0)
    .map(c => ({ chunk: c, score: cosineSim(queryEmbedding, c.embedding!) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/**
 * Hybrid rank: semantic (cosine over embeddings) fused with lexical (BM25) via
 * Reciprocal Rank Fusion. Strictly better than embedding-only for exact-token
 * queries (function names, error strings) while keeping semantic recall.
 */
export async function rankChunksHybrid(
  queryEmbedding: number[],
  query: string,
  chunks: Chunk[],
  topK: number,
): Promise<ScoredChunk[]> {
  // Semantic candidate pool — take a wide slice so fusion has material to work with.
  const semantic = rankChunks(queryEmbedding, chunks, Math.max(topK * 3, 50));
  const { hybridRank } = await import('./hybrid-search.js');
  return hybridRank(chunks, semantic, query, topK);
}

export interface RankedFile {
  file: string;
  score: number;
  bestLines: string;
  /**
   * The actual code of the file's best-matching chunk. Carried so the stage-2
   * cross-encoder can score query↔CODE (its whole purpose) instead of query↔filename.
   * Optional: graph-expanded neighbors and legacy paths may not have it.
   */
  text?: string;
}

/**
 * Collapse scored chunks to a ranked list of FILES (a file's score = its best chunk),
 * preserving order and capping the count. This is what the pre-pass injects: pointing
 * at files is more useful to the model than pointing at arbitrary 30-line windows.
 */
export function aggregateToFiles(scored: ScoredChunk[], maxFiles: number): RankedFile[] {
  const best = new Map<string, { score: number; startLine: number; endLine: number; text: string }>();
  for (const { chunk, score } of scored) {
    const cur = best.get(chunk.file);
    if (!cur || score > cur.score) {
      best.set(chunk.file, { score, startLine: chunk.startLine, endLine: chunk.endLine, text: chunk.text });
    }
  }
  return [...best.entries()]
    .map(([file, v]) => ({ file, score: v.score, bestLines: `${v.startLine}-${v.endLine}`, text: v.text }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxFiles);
}

/**
 * Expand a ranked file list with import-graph neighbors of the top hits, so the
 * model sees a component together with the files it's wired to. Neighbors are
 * appended below the semantic hits with a discounted score (they're related, not
 * directly matched). The combined list is re-capped at maxFiles.
 *
 * The graph is built over the project's source files (one cheap pass, no
 * embeddings). We seed it with the top 3 semantic hits and expand 1 hop.
 */
export async function expandRankedViaGraph(cwd: string, ranked: RankedFile[], maxFiles: number): Promise<RankedFile[]> {
  const { buildImportGraph, expandViaGraph } = await import('./import-graph.js');
  // Walk project source for the graph (cap to keep it fast).
  const files = await walkSource(cwd, 2000);
  const graph = await buildImportGraph(
    cwd,
    files.map(f => ({ rel: f.rel, content: f.content })),
  );

  const seeds = ranked.slice(0, 3).map(r => r.file);
  const neighbors = expandViaGraph(graph, seeds, { hops: 1, maxFiles: maxFiles + 6, hubDamping: true });

  const seen = new Set(ranked.map(r => r.file));
  const out: RankedFile[] = [...ranked];
  const lowestSemantic = ranked.length ? ranked[ranked.length - 1]!.score : 0.3;
  for (const n of neighbors) {
    if (n.distance === 0 || seen.has(n.file)) continue; // already a semantic hit
    seen.add(n.file);
    // Discounted score: below the lowest semantic hit, scaled by the graph
    // weight (which already accounts for distance, direction, and hub damping).
    out.push({
      file: n.file,
      score: Math.max(0.04, lowestSemantic * 0.5 * n.weight),
      bestLines: 'import-neighbor',
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, maxFiles);
}

/** Render the ranked files as a system-prompt context block (empty string if none). */
export function formatRetrievalBlock(files: RankedFile[]): string {
  if (files.length === 0) return '';
  const lines: string[] = [];
  lines.push('# Likely-relevant files (auto-retrieved by semantic similarity + import-graph)');
  lines.push('Ranked by meaning, then widened along import edges so dependencies (state/db/types) of the top matches are included. Files marked "import-neighbor" are related via imports, not direct matches. Read the top ones with read_file before searching blindly.');
  lines.push('');
  for (const f of files) {
    const tag = f.bestLines === 'import-neighbor' ? 'import-neighbor' : `lines ${f.bestLines}, similarity ${f.score.toFixed(3)}`;
    lines.push(`- ${f.file}  (${tag})`);
  }
  return lines.join('\n');
}

async function ollamaReachable(baseUrl: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const r = await fetch(`${baseUrl.replace(/\/$/, '')}/api/tags`, { signal: signal ?? AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

export interface RetrieveOptions {
  embeddingModel?: string;
  topKChunks?: number;
  maxFiles?: number;
  baseUrl?: string;
  /** Build the index if none is cached yet. Off by default to keep the pre-pass fast. */
  buildIfMissing?: boolean;
  maxFilesToIndex?: number;
  signal?: AbortSignal;
  /**
   * Expand the semantic hits along the import graph (1 hop) so the model sees a
   * component AND the state/db/types files it's wired to, not just the component.
   * Adds graph-neighbor files at a discounted score below the semantic hits.
   * Default true; set false for pure-semantic retrieval.
   */
  graphExpand?: boolean;
  /**
   * Stage-2 cross-encoder reranking. When enabled, the hybrid (bi-encoder) hits
   * are re-scored by a local cross-encoder that sees query+doc together, then
   * narrowed to maxFiles. Degrades cleanly to bi-encoder order if no reranker is
   * reachable. Default off (opt-in: needs a local reranker model).
   */
  rerank?: boolean;
  rerankModel?: string;
  rerankBaseUrl?: string;
  /** How many candidates to feed the reranker before narrowing to maxFiles. */
  rerankCandidates?: number;
}

/**
 * Best-effort automatic retrieval for the pre-pass. Returns a ranked file list, or
 * `null` when retrieval isn't possible (Ollama down, no index, embed failed) — callers
 * MUST treat null as "skip silently", never as an error.
 */
export async function retrieveRelevantFiles(
  cwd: string,
  query: string,
  opts: RetrieveOptions = {},
): Promise<RankedFile[] | null> {
  const baseUrl = opts.baseUrl ?? process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
  const model = opts.embeddingModel ?? 'nomic-embed-text';
  const topKChunks = opts.topKChunks ?? 24;
  const maxFiles = opts.maxFiles ?? 6;

  try {
    if (!(await ollamaReachable(baseUrl, opts.signal))) return null;

    const idxPath = indexPath(cwd, model);
    let idx = await loadIndex(idxPath);

    if (!idx) {
      if (!opts.buildIfMissing) {
        // No JSON index — but a SQLite index might still exist. Probe it.
        try {
          const { openSqliteIndex } = await import('./sqlite-index.js');
          const probe = await openSqliteIndex(cwd, model);
          if (probe) { probe.db.close(); }
          else return null;
        } catch { return null; }
      } else {
        idx = await buildIndex(cwd, model, baseUrl, opts.maxFilesToIndex ?? 1500, opts.signal, () => {});
        await persistIndex(cwd, model, idx);
      }
    }

    const [queryEmbedding] = await ollamaEmbed(baseUrl, model, [query], opts.signal);
    if (!queryEmbedding) return null;

    // Hybrid (BM25 + semantic) ranking over the persisted index (SQLite preferred).
    const scored = await searchPersisted(cwd, model, query, queryEmbedding, topKChunks, idx);
    if (scored.length === 0) return null;

    // Stage-2 cross-encoder rerank (optional). The bi-encoder gives us a fast,
    // wide candidate set; the cross-encoder re-scores query+doc jointly for true
    // relevance, then we narrow to maxFiles. If no reranker is reachable this is
    // a no-op and we keep the bi-encoder order.
    let ranked: RankedFile[];
    if (opts.rerank) {
      const candPool = opts.rerankCandidates ?? 40;
      const wideFiles = aggregateToFiles(scored, candPool); // wide net first
      try {
        const { crossEncoderRerank } = await import('./reranker.js');
        const reranked = await crossEncoderRerank(
          query,
          wideFiles.map(f => ({
            id: f.file,
            // Feed the cross-encoder the REAL code (prefixed with the path for light
            // context). Falling back to the filename+line string only when a candidate
            // has no chunk text — otherwise the reranker scores on path tokens alone,
            // which is what made its scores degenerate.
            text: f.text && f.text.trim()
              ? `${f.file}\n${f.text}`
              : `${f.file}\n${f.bestLines}`,
          })),
          { model: opts.rerankModel, baseUrl: opts.rerankBaseUrl, topN: maxFiles, signal: opts.signal },
        );
        if (reranked && reranked.length > 0) {
          const byId = new Map(wideFiles.map(f => [f.file, f]));
          ranked = reranked
            .map(r => { const f = byId.get(r.id); return f ? { ...f, score: r.score } : null; })
            .filter((f): f is RankedFile => f !== null);
          logger.debug('Cross-encoder rerank applied', { candidates: wideFiles.length, kept: ranked.length });
        } else {
          // No reranker reachable → fall back to bi-encoder top-N.
          ranked = wideFiles.slice(0, maxFiles);
        }
      } catch (e: any) {
        logger.debug('Rerank skipped (error) — using bi-encoder order', { err: e?.message });
        ranked = aggregateToFiles(scored, maxFiles);
      }
    } else {
      ranked = aggregateToFiles(scored, maxFiles);
    }

    // Graph expansion: pull in import-neighbors of the top hits so the model
    // sees the component together with its state/db/types wiring.
    if (opts.graphExpand !== false && ranked.length > 0) {
      try {
        const expanded = await expandRankedViaGraph(cwd, ranked, maxFiles);
        return expanded;
      } catch (e: any) {
        logger.debug('Graph expansion skipped', { err: e?.message });
        return ranked;
      }
    }
    return ranked;
  } catch (e: any) {
    logger.debug('Auto-retrieval skipped', { err: e?.message });
    return null;
  }
}
