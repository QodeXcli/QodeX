/**
 * `semantic_search` — embedding-based code search.
 *
 * Goes beyond grep/regex: finds code by meaning. The query "function that checks if an
 * order can be canceled" matches `validateCancellationEligibility` even with no shared
 * words.
 *
 * The heavy lifting (walk → chunk → embed → cosine rank, plus the on-disk index format)
 * lives in `src/context/retrieval.ts` and is SHARED with the automatic retrieval
 * pre-pass, so both stay in lockstep and reuse the same `~/.qodex/embeddings` index.
 *
 * Requires Ollama running locally + an embedding model (`ollama pull nomic-embed-text`).
 * Falls back gracefully when Ollama isn't reachable.
 */

import { z } from 'zod';
import * as path from 'path';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { logger } from '../../utils/logger.js';
import {
  walkSource, ollamaEmbed,
  indexPath, loadIndex, buildIndex,
  persistIndex, searchPersisted,
  type Index,
} from '../../context/retrieval.js';

const SemanticSearchArgs = z.object({
  query: z.string().min(2).describe('Natural-language description of what to find. Examples: "function that validates emails", "code that handles order cancellation", "loading state for the cart page".'),
  top_k: z.number().int().min(1).max(50).optional().describe('Number of results to return. Default 10.'),
  path: z.string().optional().describe('Restrict search to this subdirectory.'),
  embedding_model: z.string().optional().describe('Ollama embedding model. Default "nomic-embed-text". Other options: "mxbai-embed-large" (more accurate, slower).'),
  rebuild_index: z.boolean().optional().describe('Force re-index. Default false (uses cached index if available).'),
  max_files: z.number().int().min(1).max(50_000).optional().describe('File scan cap for indexing. Default 5000.'),
  semantic_only: z.boolean().optional().describe('Disable BM25 keyword fusion and rank by embedding similarity only. Default false (hybrid). Use when you want pure conceptual matches.'),
});

export class SemanticSearchTool extends Tool<z.infer<typeof SemanticSearchArgs>> {
  name = 'semantic_search';
  description = 'Find code by meaning, not just keywords. Uses Ollama embeddings to match natural-language queries against your codebase. First call builds an index (slow); subsequent calls reuse it. Requires Ollama + an embedding model (default nomic-embed-text). Read-only.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = SemanticSearchArgs;

  async execute(args: z.infer<typeof SemanticSearchArgs>, ctx: ToolContext): Promise<ToolResult> {
    const root = args.path ? path.join(ctx.cwd, args.path) : ctx.cwd;
    const topK = args.top_k ?? 10;
    const model = args.embedding_model ?? 'nomic-embed-text';
    const maxFiles = args.max_files ?? 5000;
    const baseUrl = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';

    // Verify Ollama is reachable
    try {
      const r = await fetch(`${baseUrl}/api/tags`, { signal: ctx.signal });
      if (!r.ok) throw new Error(`Ollama returned HTTP ${r.status}`);
    } catch (e: any) {
      return {
        content: `[SEMANTIC_SEARCH_ERROR] Ollama not reachable at ${baseUrl}: ${e?.message}\n\nInstall: https://ollama.com\nPull embed model: ollama pull nomic-embed-text`,
        isError: true,
      };
    }

    // Load or build index
    const idxPath = indexPath(root, model);
    let idx: Index | null = args.rebuild_index ? null : await loadIndex(idxPath);

    // Re-index if file count changed significantly (heuristic).
    if (idx && !args.rebuild_index) {
      const currentFiles = await walkSource(root, maxFiles);
      const currentChunkCount = currentFiles.reduce((a, f) => a + Math.ceil(f.content.split('\n').length / 25), 0);
      if (Math.abs(currentChunkCount - idx.chunks.length) > idx.chunks.length * 0.15) {
        logger.info('Semantic search index stale (file count drifted >15%); rebuilding');
        idx = null;
      }
    }

    const buildMessages: string[] = [];
    if (!idx) {
      try {
        idx = await buildIndex(root, model, baseUrl, maxFiles, ctx.signal, (msg) => buildMessages.push(msg));
        await persistIndex(root, model, idx);
      } catch (e: any) {
        return {
          content: `[SEMANTIC_SEARCH_ERROR] Index build failed: ${e?.message}\n\nIf the error mentions "model not found", run:\n  ollama pull ${model}`,
          isError: true,
        };
      }
    }

    // Embed query
    let queryEmbedding: number[];
    try {
      const [e] = await ollamaEmbed(baseUrl, model, [args.query], ctx.signal);
      queryEmbedding = e!;
    } catch (e: any) {
      return { content: `[SEMANTIC_SEARCH_ERROR] Query embed failed: ${e?.message}`, isError: true };
    }

    // Hybrid (BM25 + semantic) ranking over the persisted index (SQLite preferred),
    // unless the caller explicitly opts into semantic-only.
    const scored = await searchPersisted(root, model, args.query, queryEmbedding, topK, idx, !!args.semantic_only);

    const out: string[] = [];
    out.push(`# ${args.semantic_only ? 'Semantic' : 'Hybrid'} Search`);
    out.push(`Query: "${args.query}"`);
    if (idx) {
      out.push(`Index: ${idx.chunks.length} chunks, model ${idx.embeddingModel}, built ${new Date(idx.builtAt).toISOString().slice(0, 16).replace('T', ' ')}`);
    } else {
      out.push(`Index: SQLite quantized store, model ${model}`);
    }
    if (buildMessages.length > 0) {
      out.push('');
      for (const m of buildMessages.slice(-3)) out.push(`  ${m}`);
    }
    out.push('');
    out.push(`## Top ${scored.length} matches`);
    out.push('');
    for (let i = 0; i < scored.length; i++) {
      const { chunk, score } = scored[i]!;
      const sym = chunk.symbol ? `  [${chunk.symbol}]` : '';
      out.push(`### ${i + 1}. ${chunk.file}:${chunk.startLine}-${chunk.endLine}${sym}  (score ${score.toFixed(4)})`);
      const preview = chunk.text.split('\n').slice(0, 12).join('\n');
      out.push('```');
      out.push(preview);
      out.push('```');
      out.push('');
    }
    return {
      content: out.join('\n'),
      metadata: { resultCount: scored.length, indexSize: idx?.chunks.length ?? null, model: idx?.embeddingModel ?? model, hybrid: !args.semantic_only },
    };
  }
}
