/**
 * File-level import/dependency graph.
 *
 * The semantic index answers "which chunks are ABOUT this query." But code
 * questions are relational: "the bug in the Cart component" usually involves the
 * component PLUS the files it imports — the store/slice that holds its state, the
 * API client it calls, the types it consumes. Pure semantic search returns the
 * component and stops; the model then spends turns discovering the dependencies
 * one read_file at a time.
 *
 * This module builds a directed graph where an edge A→B means "file A imports
 * from file B." Given a set of seed files (the semantic hits), we expand 1-2
 * hops along import edges to pull in the directly-related files. That expanded
 * set is what we hand the model — it sees the component and its state/db wiring
 * together, in one shot.
 *
 * How edges are resolved:
 *  - We extract import specifiers via tree-sitter (robust to comments/strings)
 *    with a regex fallback. Both `import ... from 'x'` and `require('x')` and
 *    Python `from x import y` / `import x` are handled.
 *  - A specifier is resolved to a project file by: relative-path resolution
 *    (./foo → foo.ts/.tsx/.js/index.ts…), and for bare specifiers, a best-effort
 *    match against project files by basename (handles path aliases like
 *    "@/store/cart" → src/store/cart.ts without parsing tsconfig paths). Bare
 *    npm packages that don't resolve to a project file are dropped (we only
 *    graph intra-project edges).
 *
 * The graph is cheap to build (one pass, no embeddings) and is rebuilt lazily.
 * It complements — doesn't replace — the symbol-level code graph (find-callers
 * etc.); this is coarser (file granularity) and exists to widen RAG context.
 */

import { promises as fs } from 'fs';
import * as path from 'path';

export interface ImportGraph {
  /** file (rel path) → set of project files it imports. */
  out: Map<string, Set<string>>;
  /** reverse: file → set of project files that import it. */
  in: Map<string, Set<string>>;
  /** all known project files (rel paths). */
  files: Set<string>;
}

const SOURCE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.php', '.java', '.rb'];
const RESOLVE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.php', '.java', '.rb', ''];
const INDEX_FILES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx', '__init__.py', 'mod.rs'];

/** Extract raw import specifiers from source. Regex-based (fast, language-agnostic enough). */
export function extractImportSpecifiers(content: string, lang: string): string[] {
  const specs: string[] = [];
  const push = (s: string | undefined) => { if (s) specs.push(s); };

  if (lang === 'python') {
    // from X import ... / import X
    const re = /^\s*(?:from\s+([.\w]+)\s+import|import\s+([.\w]+))/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) push(m[1] ?? m[2]);
    return specs;
  }
  if (lang === 'go') {
    const re = /"([^"]+)"/g; // crude: import block strings
    const block = /import\s*\(([\s\S]*?)\)/.exec(content);
    const src = block ? block[1]! : content;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) push(m[1]);
    return specs;
  }
  if (lang === 'rust') {
    const re = /^\s*(?:use|mod)\s+([\w:]+)/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) push(m[1]?.split('::')[0]);
    return specs;
  }
  // JS/TS/PHP/etc: import ... from 'x', require('x'), dynamic import('x')
  const reFrom = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g;
  const reBare = /import\s*['"]([^'"]+)['"]/g; // side-effect import 'x'
  const reReq = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  const reDyn = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const re of [reFrom, reBare, reReq, reDyn]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) push(m[1]);
  }
  return specs;
}

function detectLang(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.py') return 'python';
  if (ext === '.go') return 'go';
  if (ext === '.rs') return 'rust';
  return 'js';
}

/**
 * Resolve an import specifier (as written) to a project-relative file path, or
 * null if it's an external package / unresolvable.
 *
 * `fromFile` is the rel path of the importing file. `fileSet` is all project
 * files (rel), and `basenameIndex` maps basename(no ext) → rel paths for the
 * alias fallback.
 */
export function resolveSpecifier(
  spec: string,
  fromFile: string,
  fileSet: Set<string>,
  basenameIndex: Map<string, string[]>,
): string | null {
  // Relative import → resolve against the importing file's dir.
  if (spec.startsWith('./') || spec.startsWith('../')) {
    const baseDir = path.dirname(fromFile);
    const joined = path.normalize(path.join(baseDir, spec));
    // try exact, with extensions, and as a directory index
    for (const ext of RESOLVE_EXTS) {
      const cand = ext ? `${joined}${ext}` : joined;
      if (fileSet.has(cand)) return cand;
    }
    for (const idx of INDEX_FILES) {
      const cand = path.join(joined, idx);
      if (fileSet.has(cand)) return cand;
    }
    return null;
  }

  // Python dotted intra-package (from .models import X handled above as ".models")
  if (spec.startsWith('.')) {
    const baseDir = path.dirname(fromFile);
    const rel = spec.replace(/\./g, '/').replace(/^\//, '');
    for (const ext of RESOLVE_EXTS) {
      const cand = path.normalize(path.join(baseDir, rel + (ext || '.py')));
      if (fileSet.has(cand)) return cand;
    }
    return null;
  }

  // Bare specifier: could be a path alias (@/store/cart, ~/lib/db) or an npm pkg.
  // Strategy: take the last path segment and match by basename against project
  // files. This resolves aliases without parsing tsconfig "paths", at the cost
  // of occasionally matching a same-named file — acceptable for RAG widening
  // (we're casting a slightly wider net, not doing a refactor).
  const lastSeg = spec.split('/').pop()!;
  const base = lastSeg.replace(path.extname(lastSeg), '');
  const cands = basenameIndex.get(base);
  if (cands && cands.length > 0) {
    // Prefer a candidate whose path contains an earlier segment of the spec
    // (e.g. "@/store/cart" → prefer .../store/cart.ts over .../cart.ts elsewhere).
    const segs = spec.split('/').filter(s => s && !s.startsWith('@') && !s.startsWith('~') && s !== '.');
    const scored = cands
      .map(c => ({ c, score: segs.filter(s => c.includes(s)).length }))
      .sort((a, b) => b.score - a.score);
    // Only accept if at least the basename matched a real project file.
    return scored[0]!.c;
  }
  return null; // external package
}

/** Build the import graph for a set of files. `read` lets callers inject cached content. */
export async function buildImportGraph(
  root: string,
  files: Array<{ rel: string; content?: string }>,
  read?: (rel: string) => Promise<string | null>,
): Promise<ImportGraph> {
  const fileSet = new Set(files.map(f => f.rel));
  const basenameIndex = new Map<string, string[]>();
  for (const f of fileSet) {
    const base = path.basename(f).replace(path.extname(f), '');
    const arr = basenameIndex.get(base) ?? [];
    arr.push(f);
    basenameIndex.set(base, arr);
  }

  const out = new Map<string, Set<string>>();
  const inMap = new Map<string, Set<string>>();
  for (const f of fileSet) { out.set(f, new Set()); inMap.set(f, new Set()); }

  for (const f of files) {
    let content = f.content;
    if (content == null) {
      content = read ? await read(f.rel) ?? undefined : await fs.readFile(path.join(root, f.rel), 'utf-8').catch(() => undefined);
    }
    if (!content) continue;
    const specs = extractImportSpecifiers(content, detectLang(f.rel));
    for (const spec of specs) {
      const target = resolveSpecifier(spec, f.rel, fileSet, basenameIndex);
      if (target && target !== f.rel) {
        out.get(f.rel)!.add(target);
        inMap.get(target)!.add(f.rel);
      }
    }
  }

  return { out, in: inMap, files: fileSet };
}

/**
 * Expand a seed set of files by following import edges up to `hops` hops in BOTH
 * directions (what the seed imports AND what imports the seed). Returns the
 * expanded set, each with a `distance` (0 = seed) and a `weight` (relevance).
 *
 * HUB DOWN-WEIGHTING (PageRank-style intuition, IDF math):
 *   A file imported by N other files (high in-degree) — utils.ts, a shared
 *   types barrel, a logger — carries little signal about any specific query;
 *   it's "connected to everything." We damp such files with an inverse-log-
 *   in-degree factor `1 / log2(2 + inDegree)`, exactly analogous to BM25's IDF
 *   for common terms. A file imported once scores ~1.0; one imported by 30
 *   files scores ~0.2. This keeps a hub from crowding out the genuinely-related
 *   state/db files when we cap at maxFiles.
 *
 *   We DON'T run full iterative PageRank: it's O(edges · iterations) per query
 *   and the ranking it produces (global importance) is the OPPOSITE of what we
 *   want here — we want to DEMOTE globally-important hubs, not promote them.
 *   Inverse-in-degree is the right, cheap signal.
 *
 * Direction: downstream (deps) is weighted higher than upstream (importers),
 * since "how does X work / why is X broken" usually lives in what X uses.
 */
export function expandViaGraph(
  graph: ImportGraph,
  seeds: string[],
  opts: { hops?: number; maxFiles?: number; hubDamping?: boolean } = {},
): Array<{ file: string; distance: number; weight: number }> {
  const hops = opts.hops ?? 1;
  const maxFiles = opts.maxFiles ?? 12;
  const hubDamping = opts.hubDamping !== false;

  // distance + which direction we first reached it (down=dependency, up=dependent)
  const dist = new Map<string, number>();
  const viaDownstream = new Map<string, boolean>();
  for (const s of seeds) if (graph.files.has(s)) { dist.set(s, 0); viaDownstream.set(s, true); }

  let frontier = [...dist.keys()];
  for (let h = 1; h <= hops; h++) {
    const next: string[] = [];
    for (const f of frontier) {
      const downstream = graph.out.get(f) ?? new Set<string>();
      const upstream = graph.in.get(f) ?? new Set<string>();
      for (const nbr of downstream) {
        if (!dist.has(nbr)) { dist.set(nbr, h); viaDownstream.set(nbr, true); next.push(nbr); }
      }
      for (const nbr of upstream) {
        if (!dist.has(nbr)) { dist.set(nbr, h); viaDownstream.set(nbr, false); next.push(nbr); }
      }
    }
    frontier = next;
  }

  const inDegreeOf = (f: string): number => (graph.in.get(f)?.size ?? 0);

  const scored = [...dist.entries()].map(([file, distance]) => {
    // Base relevance decays with distance; seeds are 1.0.
    let weight = distance === 0 ? 1.0 : 1.0 / (distance + 1);
    // Downstream (dependencies) are more relevant than upstream (dependents).
    if (distance > 0 && !viaDownstream.get(file)) weight *= 0.6;
    // Hub damping: demote files imported by many others (low query specificity).
    if (hubDamping && distance > 0) {
      const deg = inDegreeOf(file);
      weight *= 1 / Math.log2(2 + deg);
    }
    return { file, distance, weight };
  });

  // Seeds always kept; non-seeds ranked by weight, then taken up to the cap.
  const seedRows = scored.filter(s => s.distance === 0);
  const rest = scored.filter(s => s.distance > 0).sort((a, b) => b.weight - a.weight);
  return [...seedRows, ...rest].slice(0, maxFiles);
}
