/**
 * Symbol Graph Daemon — proactive dependency awareness.
 *
 * `analyze_impact` is on-demand: the model must decide to call it. Tools like
 * Cursor stay a step ahead by keeping a live dependency graph and surfacing the
 * blast radius BEFORE the model asks. This daemon does that: on first use it
 * builds the project's import/dependency graph once (reusing import-graph.ts),
 * caches it in memory, and exposes a fast lookup that, given the files about to
 * be shown to the model, returns their direct upstream (who imports me) and
 * downstream (what I import) neighbors as Meta-Context. Injected into the prompt,
 * it means the model never forgets that changing a function ripples elsewhere.
 *
 * "Daemon" here is an in-process, lazily-built, cached singleton per project —
 * not a separate OS process. That's the right weight for a CLI: no extra process
 * to manage, no IPC, and it's torn down with the CLI. The graph is rebuilt when
 * it goes stale (TTL) so edits during a long session are eventually reflected.
 *
 * Pure-ish: building does read the filesystem (delegated to import-graph), but
 * the lookup over a built graph is pure. The agent loop decides WHEN to inject.
 */

import { buildImportGraph, type ImportGraph } from './import-graph.js';
import { logger } from '../utils/logger.js';

interface CachedGraph {
  graph: ImportGraph;
  builtAt: number;
}

const _cache = new Map<string, CachedGraph>();
const DEFAULT_TTL_MS = 5 * 60_000; // rebuild at most every 5 min within a session

/**
 * Get (or lazily build) the project's dependency graph. Cached per project root
 * with a TTL so a long session eventually reflects edits without rebuilding on
 * every turn. Returns null if the graph can't be built.
 */
export async function getSymbolGraph(
  projectRoot: string,
  opts: { ttlMs?: number; maxFiles?: number; signal?: AbortSignal } = {},
): Promise<ImportGraph | null> {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const cached = _cache.get(projectRoot);
  if (cached && Date.now() - cached.builtAt < ttl) {
    return cached.graph;
  }
  try {
    const { walkSource } = await import('./retrieval.js');
    const files = await walkSource(projectRoot, opts.maxFiles ?? 2000);
    const graph = await buildImportGraph(
      projectRoot,
      files.map(f => ({ rel: f.rel, content: f.content })),
    );
    _cache.set(projectRoot, { graph, builtAt: Date.now() });
    logger.debug('Symbol graph built', { files: graph.files.size });
    return graph;
  } catch (e: any) {
    logger.debug('Symbol graph build failed', { err: e?.message });
    return null;
  }
}

/** Invalidate the cached graph for a project (e.g. after a big refactor). */
export function invalidateSymbolGraph(projectRoot: string): void {
  _cache.delete(projectRoot);
}

export interface DependencyContext {
  file: string;
  /** Files this file imports (downstream — what it depends on). */
  imports: string[];
  /** Files that import this file (upstream — what breaks if you change it). */
  importedBy: string[];
}

/**
 * For a set of seed files (the ones about to be shown to the model), return each
 * one's direct neighbors from the graph. Bounded per file so a hub file doesn't
 * flood the prompt.
 */
export function dependencyContextFor(
  graph: ImportGraph,
  seedFiles: string[],
  maxPerSide = 8,
): DependencyContext[] {
  const out: DependencyContext[] = [];
  for (const f of seedFiles) {
    const imports = [...(graph.out.get(f) ?? [])].slice(0, maxPerSide);
    const importedBy = [...(graph.in.get(f) ?? [])].slice(0, maxPerSide);
    if (imports.length === 0 && importedBy.length === 0) continue;
    out.push({ file: f, imports, importedBy });
  }
  return out;
}

/** Render dependency context as a compact prompt block, or '' if nothing useful. */
export function renderDependencyContext(deps: DependencyContext[]): string {
  if (deps.length === 0) return '';
  const lines: string[] = [
    '## Dependency map (ripple effect — edit with these in mind)',
    'For the files in context, here is what depends on them and what they depend on:',
  ];
  for (const d of deps) {
    lines.push(`\n**${d.file}**`);
    if (d.importedBy.length > 0) {
      lines.push(`  ← imported by (changing this affects): ${d.importedBy.join(', ')}`);
    }
    if (d.imports.length > 0) {
      lines.push(`  → imports: ${d.imports.join(', ')}`);
    }
  }
  return lines.join('\n');
}
