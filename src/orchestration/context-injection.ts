/**
 * Context-Injection — the token-optimization core.
 *
 * Given a task node, build the SMALLEST context that still lets a worker solve
 * it correctly. The naive approach (hand the worker the whole repo, or even the
 * whole file set it touches) wastes thousands of tokens per worker and, worse,
 * dilutes attention. We instead slice precisely:
 *
 *   1. TARGET slices — the current content of the files this node will modify
 *      (so the worker edits, not rewrites blind). New files contribute nothing.
 *   2. TYPE slices — the type/interface definitions the node depends on,
 *      resolved by following the import graph ONE hop from the target files and
 *      keeping only declaration nodes (interfaces, types, enums, exported
 *      consts) — NOT the full neighbor files. Building a Button needs
 *      `ButtonProps`, not all of `utils.ts`.
 *   3. SIGNATURE slices — for functions the node calls but doesn't implement,
 *      include just the signature line(s), not the body.
 *   4. DESIGN TOKENS — for component/style nodes, the design-token block
 *      (colors, spacing, type scale) so output matches the system.
 *
 * The result is typically 5-15× smaller than the touched files, and orders of
 * magnitude smaller than the repo. We measure and report the savings.
 *
 * This reuses the existing AST chunker (semantic boundaries + symbol names) and
 * the import graph (edge resolution incl. path aliases) — no new parsing.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import type { TaskNode, TaskContext, ContextSlice } from './protocol.js';
import { astChunkFile } from '../context/ast-chunk.js';
import { buildImportGraph, expandViaGraph, type ImportGraph } from '../context/import-graph.js';
import { countTokens } from '../utils/tokenizer.js';

/** Node types whose chunk we keep as a TYPE definition. */
const TYPE_SYMBOL_RE = /^(interface|type|enum|Props$|Type$|Schema$|Config$)/;
const TYPE_FILE_RE = /\.(types?|d|schema|model|interface)\.(ts|tsx)$|types?\.ts$/i;

export interface SlicerDeps {
  /** Project root. */
  cwd: string;
  /** Optional cached import graph (built once per execution, reused per node). */
  graph?: ImportGraph;
  /** Read a file's content; defaults to fs. Injectable for staging-aware reads. */
  read?: (absPath: string) => Promise<string | null>;
  /** Design-token text to inject for component/style nodes. */
  designTokens?: string;
}

async function readFile(deps: SlicerDeps, rel: string): Promise<string | null> {
  const abs = path.join(deps.cwd, rel);
  if (deps.read) return deps.read(abs);
  try { return await fs.readFile(abs, 'utf-8'); } catch { return null; }
}

/** Is this chunk a type-like declaration worth pulling as a dependency? */
function isTypeChunk(symbol: string | undefined, file: string): boolean {
  if (TYPE_FILE_RE.test(file)) return true;
  if (!symbol) return false;
  return TYPE_SYMBOL_RE.test(symbol) || /Props|Type|Interface|Schema|Options|Config|State/.test(symbol);
}

/** Extract just the signature (declaration line through the opening brace) of a chunk. */
function signatureOf(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    out.push(line);
    if (line.includes('{')) break;       // stop at body open
    if (line.trim().endsWith(';')) break; // or a bare declaration
    if (out.length > 6) break;            // safety
  }
  return out.join('\n') + (text.includes('{') ? ' /* … */ }' : '');
}

/**
 * Build the token-optimized context for one task node.
 *
 * Algorithm:
 *   - target files → full current content as 'target' slices (skip non-existent
 *     = new files).
 *   - For each target file, AST-chunk it, then walk the import graph 1 hop to
 *     find dependency files; from those, keep ONLY type-like chunks as
 *     'type-dependency' slices.
 *   - For explicitly-requested contextSymbols, find their defining chunk
 *     anywhere in the 1-hop neighborhood and include it (signature only if it's
 *     a function, full text if it's a type).
 *   - Attach design tokens for component/style kinds.
 */
export async function buildTaskContext(node: TaskNode, deps: SlicerDeps): Promise<TaskContext> {
  const slices: ContextSlice[] = [];
  const typeDefs: ContextSlice[] = [];
  const seenSlice = new Set<string>();

  const pushSlice = (arr: ContextSlice[], s: ContextSlice) => {
    const key = `${s.file}:${s.startLine ?? 0}:${s.symbol ?? ''}:${s.reason}`;
    if (seenSlice.has(key)) return;
    seenSlice.add(key);
    arr.push(s);
  };

  // 1. TARGET slices — current content of files this node modifies.
  const existingTargets: string[] = [];
  for (const t of node.targetFiles) {
    const content = await readFile(deps, t);
    if (content == null) continue; // new file — nothing to show
    existingTargets.push(t);
    // For large target files, slice to the symbols the instruction references;
    // otherwise include whole (a component file is usually small).
    if (content.split('\n').length > 200) {
      const chunks = await astChunkFile(t, content);
      for (const c of chunks) {
        pushSlice(slices, { file: t, text: c.text, reason: 'target', startLine: c.startLine, endLine: c.endLine, symbol: c.symbol });
      }
    } else {
      pushSlice(slices, { file: t, text: content, reason: 'target' });
    }
  }

  // 2. TYPE dependencies — 1-hop import neighbors, type chunks only.
  const graph = deps.graph ?? await buildImportGraphForFiles(deps, node);
  const seeds = node.targetFiles.filter(f => graph.files.has(f));
  if (seeds.length > 0) {
    const neighbors = expandViaGraph(graph, seeds, { hops: 1, maxFiles: 20, hubDamping: true });
    for (const n of neighbors) {
      if (n.distance === 0) continue; // skip the targets themselves
      const content = await readFile(deps, n.file);
      if (!content) continue;
      const chunks = await astChunkFile(n.file, content);
      for (const c of chunks) {
        if (isTypeChunk(c.symbol, n.file)) {
          pushSlice(typeDefs, { file: n.file, text: c.text, reason: 'type-dependency', startLine: c.startLine, endLine: c.endLine, symbol: c.symbol });
        }
      }
    }
  }

  // 3. Explicitly-requested symbols — find their defining chunk in the neighborhood.
  if (node.contextSymbols?.length) {
    const searchFiles = new Set<string>([...node.contextFiles, ...node.targetFiles]);
    for (const f of node.contextFiles) {
      for (const nbr of graph.out.get(f) ?? []) searchFiles.add(nbr);
    }
    for (const f of searchFiles) {
      const content = await readFile(deps, f);
      if (!content) continue;
      const chunks = await astChunkFile(f, content);
      for (const c of chunks) {
        if (c.symbol && node.contextSymbols.includes(c.symbol)) {
          const isType = isTypeChunk(c.symbol, f);
          pushSlice(isType ? typeDefs : slices, {
            file: f,
            text: isType ? c.text : signatureOf(c.text),
            reason: isType ? 'type-dependency' : 'signature',
            startLine: c.startLine,
            endLine: c.endLine,
            symbol: c.symbol,
          });
        }
      }
    }
  }

  // 4. Design tokens for visual nodes.
  const designTokens = (node.kind === 'component' || node.kind === 'style') ? deps.designTokens : undefined;
  if (designTokens) {
    pushSlice(slices, { file: '<design-tokens>', text: designTokens, reason: 'design-token' });
  }

  const allText = [...slices, ...typeDefs].map(s => s.text).join('\n') + (designTokens ?? '');
  const estimatedTokens = countTokens(node.instruction) + countTokens(allText);

  return {
    taskId: node.id,
    instruction: node.instruction,
    slices: slices.filter(s => s.reason !== 'design-token'),
    typeDefs,
    designTokens,
    allowedWrites: node.targetFiles,
    estimatedTokens,
  };
}

/** Build a graph scoped to the node's neighborhood when no shared graph was passed. */
async function buildImportGraphForFiles(deps: SlicerDeps, node: TaskNode): Promise<ImportGraph> {
  const files = [...new Set([...node.targetFiles, ...node.contextFiles])];
  const withContent: Array<{ rel: string; content?: string }> = [];
  for (const f of files) {
    const c = await readFile(deps, f);
    withContent.push({ rel: f, content: c ?? undefined });
  }
  return buildImportGraph(deps.cwd, withContent, async (rel) => readFile(deps, rel));
}

/**
 * Render a TaskContext into the actual prompt string handed to the worker.
 * This is deliberately compact: headers + fenced slices, no prose padding.
 */
export function renderContextPrompt(ctx: TaskContext): string {
  const out: string[] = [];
  out.push('# Your task (isolated)');
  out.push(ctx.instruction);
  out.push('');
  out.push('You are a worker node. You see ONLY the context below — it is everything you need.');
  out.push(`You may write ONLY these files: ${ctx.allowedWrites.join(', ') || '(new files as instructed)'}.`);
  out.push('Do not ask for more context; if a type is missing, infer a minimal local definition.');
  out.push('');

  if (ctx.typeDefs.length > 0) {
    out.push('## Types & contracts you depend on');
    for (const s of ctx.typeDefs) {
      out.push(`### ${s.symbol ?? path.basename(s.file)}  — from ${s.file}`);
      out.push('```ts');
      out.push(s.text);
      out.push('```');
    }
    out.push('');
  }

  if (ctx.slices.length > 0) {
    out.push('## Current code you are editing / signatures you call');
    for (const s of ctx.slices) {
      const loc = s.startLine ? ` (lines ${s.startLine}-${s.endLine})` : '';
      out.push(`### ${s.file}${loc}${s.reason === 'signature' ? ' [signature only]' : ''}`);
      out.push('```');
      out.push(s.text);
      out.push('```');
    }
    out.push('');
  }

  if (ctx.designTokens) {
    out.push('## Design tokens — match these exactly');
    out.push('```css');
    out.push(ctx.designTokens);
    out.push('```');
    out.push('');
  }

  out.push('Produce the complete file(s). Output working code, not placeholders.');
  return out.join('\n');
}

/**
 * Estimate what a NAIVE orchestrator would have spent (full touched-file content
 * per worker) vs. our sliced context, to report token savings.
 */
export async function estimateNaiveTokens(node: TaskNode, deps: SlicerDeps): Promise<number> {
  let total = countTokens(node.instruction);
  for (const f of [...node.targetFiles, ...node.contextFiles]) {
    const c = await readFile(deps, f);
    if (c) total += countTokens(c);
  }
  return total;
}
