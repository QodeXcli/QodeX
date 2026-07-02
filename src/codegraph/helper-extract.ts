/**
 * Near-duplicate helper detection — code-graph-driven refactor opportunities that go BEYOND the
 * exact-duplicate `consolidate-dupes` maintain scope (#82).
 *
 * Exact-dupe detection catches byte-identical functions. This catches the far more common case:
 * functions that were copy-pasted and then tweaked — same shape, a different constant or a renamed
 * variable. Those can be collapsed into one parameterized helper, but doing so changes call sites,
 * so this is DETECTION ONLY: it surfaces the clusters (with an estimate of how many lines a shared
 * helper would save) for a human — or the agent under review — to extract. A plain agent can't find
 * these; it takes the code graph (function bodies) + a structural similarity that ignores the
 * surface differences (names, literals) copy-paste introduces.
 *
 * PURE — string/array in, structured clusters out. Fully unit-tested. The thin tool shell reads
 * function bodies from the code graph and feeds them here.
 */
import { termFreq, cosineSim } from '../skills/learning/similarity.js';

export interface FunctionUnit {
  name: string;
  file: string;
  startLine: number;
  endLine: number;
  body: string;               // raw source of the function
}

export interface HelperMember { name: string; file: string; startLine: number; endLine: number }
export interface HelperCluster {
  suggestedName: string;
  members: HelperMember[];
  avgSimilarity: number;      // average pairwise structural similarity, 0..1
  exact: boolean;             // normalizes identically (already covered by consolidate-dupes)
  linesEach: number;          // approx lines per member
  estLinesSaved: number;      // (members − 1) × linesEach — the collapse value
}

/** Split an identifier into lowercased words (camelCase + snake_case + kebab). PURE. */
function splitWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map(w => w.toLowerCase())
    .filter(Boolean);
}

/**
 * Structural normalization: neutralize the surface differences copy-paste introduces so genuinely
 * similar logic reads as similar. Strips comments, replaces the function's own name with a constant,
 * and abstracts string/number literals — so "same code, different constant/name" clusters. PURE.
 */
export function normalizeBody(body: string, ownName?: string): string {
  let s = body;
  if (ownName) s = s.replace(new RegExp(`\\b${ownName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), 'FN');
  s = s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' '); // block + line comments
  s = s.replace(/(^|\s)#[^\n]*/g, ' ');                                // python/ruby/shell comments
  s = s.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, 'STR'); // string literals
  s = s.replace(/\b\d+(?:\.\d+)?\b/g, 'NUM');                          // number literals
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/** Code-aware tokens: identifiers/keywords AND operators/punctuation (structure matters). PURE. */
export function codeTokens(normalized: string): string[] {
  return normalized.match(/[A-Za-z_$][\w$]*|[+\-*/%<>=!&|^~?:;,.(){}\[\]]/g) ?? [];
}

function round(x: number): number { return Math.round(x * 100) / 100; }

/** A shared-helper name: common words across the member names, else a common prefix, else generic. */
function suggestName(names: string[]): string {
  const wordSets = names.map(splitWords);
  if (wordSets.length && wordSets[0]!.length) {
    const common = wordSets[0]!.filter(w => wordSets.every(set => set.includes(w)));
    if (common.length) {
      const [head, ...rest] = common;
      return head + rest.map(w => w[0]!.toUpperCase() + w.slice(1)).join('');
    }
  }
  return 'extractedHelper';
}

/**
 * Cluster functions into near-duplicate groups by structural similarity. Returns clusters of ≥2,
 * ranked by estimated lines saved (the biggest, most-duplicated first). PURE.
 *
 * `minSim`..`maxSim` bounds the band: default 0.88..1.0 (near-dupes and up). Exact matches are
 * tagged `exact` so callers can down-rank them (they're already handled by consolidate-dupes).
 * `minTokens` filters out trivial / boilerplate-sized functions that aren't worth a helper.
 *
 * Clustering is SEED-BASED, not transitive union-find: a function joins the cluster whose SEED it
 * is most similar to (≥ minSim), else it seeds a new one. This avoids single-linkage "chaining",
 * where A~B and B~C silently merge A and C even though A and C aren't similar — which otherwise
 * collapses a whole codebase of vaguely-alike boilerplate into one meaningless mega-cluster.
 */
export function findSimilarHelpers(
  units: FunctionUnit[],
  opts: { minSim?: number; maxSim?: number; minTokens?: number } = {},
): HelperCluster[] {
  const minSim = opts.minSim ?? 0.88;
  const maxSim = opts.maxSim ?? 1.0;
  const minTokens = opts.minTokens ?? 40;

  const base = units
    .map(u => {
      const norm = normalizeBody(u.body, u.name);
      const tokens = codeTokens(norm);
      return { u, norm, tf: termFreq(tokens), tok: tokens.length };
    })
    .filter(x => x.tok >= minTokens);

  // TF-IDF: weight each token by how DISTINCTIVE it is across the corpus. Ubiquitous structural
  // tokens (`.`, `(`, `const`, `=`) appear in nearly every function → idf≈0 → they stop dominating,
  // so only genuinely-shared logic (specific identifiers + call sequences) drives similarity. Without
  // this, every large function looks ~85% like every other and the whole thing over-clusters.
  const df = new Map<string, number>();
  for (const b of base) for (const t of b.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const N = base.length;
  const idf = (t: string): number => Math.log((N + 1) / ((df.get(t) ?? 0) + 1)); // smoothed; token in all docs → ~0
  const weight = (tf: Map<string, number>): Map<string, number> => {
    const w = new Map<string, number>();
    for (const [t, f] of tf) { const iw = idf(t); if (iw > 0) w.set(t, f * iw); }
    return w;
  };

  const prepared = base
    // Weighted vector; fall back to raw tf if weighting empties it (degenerate all-tokens-universal case).
    .map(x => { const w = weight(x.tf); return { ...x, tf: w.size > 0 ? w : x.tf }; })
    // Larger functions first, so the biggest is the seed a cluster forms around (stable + meaningful).
    .sort((a, b) => b.tok - a.tok);

  // Seed-based clustering: each function joins the seed it's MOST similar to (≥ minSim), else seeds a new cluster.
  const seeded: { seed: number; members: number[] }[] = [];
  for (let i = 0; i < prepared.length; i++) {
    let best = -1, bestSim = -1;
    for (let c = 0; c < seeded.length; c++) {
      const s = cosineSim(prepared[i]!.tf, prepared[seeded[c]!.seed]!.tf);
      if (s >= minSim && s <= maxSim && s > bestSim) { bestSim = s; best = c; }
    }
    if (best >= 0) seeded[best]!.members.push(i);
    else seeded.push({ seed: i, members: [i] });
  }

  const clusters: HelperCluster[] = [];
  for (const { members: rawIdxs } of seeded) {
    // Drop members NESTED inside another member (same file, contained line range): a inner helper
    // shares most of its parent's tokens, so parent+child cluster together — but "extract the child
    // from its parent" is not a duplicate-consolidation opportunity. Keep the outermost.
    const idxs = rawIdxs.filter(i => {
      const a = prepared[i]!.u;
      return !rawIdxs.some(j => {
        if (j === i) return false;
        const b = prepared[j]!.u;
        return a.file === b.file && b.startLine <= a.startLine && a.endLine <= b.endLine
          && (b.endLine - b.startLine) > (a.endLine - a.startLine);
      });
    });
    if (idxs.length < 2) continue;
    let sum = 0, cnt = 0;
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) { sum += cosineSim(prepared[idxs[a]!]!.tf, prepared[idxs[b]!]!.tf); cnt++; }
    }
    const avg = cnt ? sum / cnt : 0;
    const members: HelperMember[] = idxs.map(i => {
      const u = prepared[i]!.u;
      return { name: u.name, file: u.file, startLine: u.startLine, endLine: u.endLine };
    });
    const linesEach = Math.round(idxs.reduce((a, i) => a + (prepared[i]!.u.endLine - prepared[i]!.u.startLine + 1), 0) / idxs.length);
    // Exact = every member normalizes to the SAME string (robust; not dependent on TF-IDF weighting).
    const exact = idxs.every(i => prepared[i]!.norm === prepared[idxs[0]!]!.norm);
    clusters.push({
      suggestedName: suggestName(members.map(m => m.name)),
      members,
      avgSimilarity: round(avg),
      exact,
      linesEach,
      estLinesSaved: (idxs.length - 1) * linesEach,
    });
  }
  return clusters.sort((a, b) => b.estLinesSaved - a.estLinesSaved || b.avgSimilarity - a.avgSimilarity);
}

// ————————————————————————————— v2: parameterized-consolidation proposal —————————————————————————————

export interface ParamProposal {
  ok: boolean;
  reason?: string;
  helperName: string;
  /** One entry per parameter the shared helper needs; values are per-member (same order as input). */
  params: { name: string; values: string[] }[];
  /** The reference member's body with the varying tokens replaced by the parameter names. */
  sketch: string;
  /** How each original function maps to a call of the shared helper. */
  calls: { member: string; args: string[] }[];
  /** Members left out because their body doesn't align with the majority (e.g. a BigInt variant). */
  dropped?: string[];
}

interface RawTok { text: string; start: number }

/** Code tokens WITH literals kept and source offsets (for substitution in the sketch). PURE. */
function rawTokens(body: string): RawTok[] {
  const re = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\d+(?:\.\d+)?|[A-Za-z_$][\w$]*|[^\sA-Za-z0-9_$]/g;
  const out: RawTok[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) out.push({ text: m[0], start: m.index });
  return out;
}

/**
 * Given a cluster of near-duplicate functions, propose ONE parameterized helper: align the bodies
 * token-by-token, turn each varying position into a parameter (positions that always vary together
 * collapse into one), and emit the reference body with those tokens substituted — plus the exact
 * call each original becomes. Mechanical and conservative: if the bodies don't align structurally
 * (different token counts) or vary in too many places (>4 params), it declines with the reason
 * rather than proposing something wrong. PURE.
 */
export function proposeParameterizedHelper(members: FunctionUnit[], helperName = 'extractedHelper'): ParamProposal {
  const decline = (reason: string): ParamProposal => ({ ok: false, reason, helperName, params: [], sketch: '', calls: [] });
  if (members.length < 2) return decline('need at least two functions');

  // Neutralize each function's own name so it never reads as a varying token.
  let bodies = members.map(m => m.body.replace(new RegExp(`\\b${m.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), helperName));
  let toks = bodies.map(b => rawTokens(b));
  let dropped: string[] | undefined;
  if (toks.some(t => t.length !== toks[0]!.length)) {
    // Mixed structural variants in one cluster (e.g. a Number family + a BigInt family): keep the
    // LARGEST same-token-count subset and report the rest as dropped, instead of declining outright.
    const byCount = new Map<number, number[]>();
    toks.forEach((t, i) => { const k = t.length; if (!byCount.has(k)) byCount.set(k, []); byCount.get(k)!.push(i); });
    const best = [...byCount.values()].sort((a, b) => b.length - a.length)[0]!;
    if (best.length < 2) return decline('bodies do not align structurally (token counts differ) — too divergent to parameterize mechanically');
    dropped = members.filter((_, i) => !best.includes(i)).map(m => m.name);
    members = best.map(i => members[i]!);
    bodies = best.map(i => bodies[i]!);
    toks = best.map(i => toks[i]!);
  }

  // Positions where members disagree, grouped by their value-vector (co-varying positions = one param).
  const n = toks[0]!.length;
  const groups = new Map<string, number[]>();
  for (let p = 0; p < n; p++) {
    const values = toks.map(t => t[p]!.text);
    if (values.every(v => v === values[0])) continue;
    const key = JSON.stringify(values);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(p);
  }
  if (groups.size === 0) return decline('bodies are identical — use consolidate-dupes, no parameter needed');
  if (groups.size > 4) return decline(`${groups.size} independently-varying parts — too many to parameterize cleanly`);

  // Name each parameter from context when possible (`kind: "min"` → param `kind`), else p1/p2….
  const used = new Set<string>();
  const params: { name: string; values: string[]; positions: number[] }[] = [];
  for (const [key, positions] of groups) {
    const first = positions[0]!;
    const ref = toks[0]!;
    let name = ref[first - 1]?.text === ':' && /^[A-Za-z_$][\w$]*$/.test(ref[first - 2]?.text ?? '') ? ref[first - 2]!.text : `p${params.length + 1}`;
    while (used.has(name)) name = `${name}_`;
    used.add(name);
    params.push({ name, values: JSON.parse(key), positions });
  }

  // Sketch: reference body with each varying token replaced by its parameter name (right-to-left).
  let sketch = bodies[0]!;
  const subs = params.flatMap(p => p.positions.map(pos => ({ pos, name: p.name })))
    .sort((a, b) => toks[0]![b.pos]!.start - toks[0]![a.pos]!.start);
  for (const s of subs) {
    const t = toks[0]![s.pos]!;
    sketch = sketch.slice(0, t.start) + s.name + sketch.slice(t.start + t.text.length);
  }
  const calls = members.map((m, i) => ({ member: m.name, args: params.map(p => p.values[i]!) }));
  return { ok: true, helperName, params: params.map(({ name, values }) => ({ name, values })), sketch, calls, dropped };
}

/** Render a proposal as a compact, reviewable block. PURE. */
export function formatParamProposal(pr: ParamProposal): string {
  if (!pr.ok) return `No mechanical parameterization: ${pr.reason}`;
  const lines = [
    `Proposed shared helper \`${pr.helperName}(${pr.params.map(p => p.name).join(', ')})\` — the bodies differ ONLY in these ${pr.params.length} spot(s):`,
  ];
  for (const c of pr.calls) lines.push(`  ${c.member}(…) → ${pr.helperName}(${c.args.join(', ')})`);
  if (pr.dropped?.length) lines.push(`  (not covered — different structure: ${pr.dropped.join(', ')})`);
  lines.push('', '```', pr.sketch.split('\n').slice(0, 16).join('\n'), '```');
  return lines.join('\n');
}

/** A concise, agent-readable report of extraction opportunities. PURE. */
export function formatHelperClusters(clusters: HelperCluster[]): string {
  if (!clusters.length) return 'No near-duplicate helper clusters found — nothing worth extracting.';
  const lines = [`Found ${clusters.length} near-duplicate helper cluster(s) — candidates to extract into a shared helper:`, ''];
  clusters.forEach((c, i) => {
    lines.push(`${i + 1}. ~${Math.round(c.avgSimilarity * 100)}% similar${c.exact ? ' (EXACT — use consolidate-dupes)' : ''} · ${c.members.length} copies · ~${c.estLinesSaved} lines saved → helper \`${c.suggestedName}()\``);
    for (const m of c.members) lines.push(`   - ${m.name}  (${m.file}:${m.startLine}-${m.endLine})`);
  });
  lines.push('', 'Detection only — extracting changes call sites. Review, then extract with a verified PR.');
  return lines.join('\n');
}
