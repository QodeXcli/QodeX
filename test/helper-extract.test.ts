import { describe, it, expect } from 'vitest';
import { normalizeBody, codeTokens, findSimilarHelpers, formatHelperClusters, proposeParameterizedHelper, formatParamProposal, type FunctionUnit } from '../src/codegraph/helper-extract.ts';

// Two helpers copy-pasted then tweaked: different name, different constant — NEAR, not exact.
const fmtUSD = `function formatUSD(n) {
  const rounded = Math.round(n * 100) / 100;
  const parts = rounded.toFixed(2).split('.');
  parts[0] = parts[0].replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');
  return '$' + parts.join('.');
}`;
const fmtEUR = `function formatEUR(n) {
  const rounded = Math.round(n * 100) / 100;
  const parts = rounded.toFixed(2).split('.');
  parts[0] = parts[0].replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');
  return '€' + parts.join('.');
}`;
// An unrelated function — must not cluster with the formatters.
const parseArgs = `function parseArgs(argv) {
  const out = {};
  for (const a of argv) { const [k, v] = a.split('='); out[k] = v ?? true; }
  return out;
}`;

const units: FunctionUnit[] = [
  { name: 'formatUSD', file: 'src/money.ts', startLine: 1, endLine: 6, body: fmtUSD },
  { name: 'formatEUR', file: 'src/euro.ts', startLine: 10, endLine: 15, body: fmtEUR },
  { name: 'parseArgs', file: 'src/cli.ts', startLine: 1, endLine: 5, body: parseArgs },
];

describe('normalizeBody / codeTokens', () => {
  it('neutralizes name, literals, and comments so near-dupes read as identical', () => {
    const a = normalizeBody(fmtUSD, 'formatUSD');
    const b = normalizeBody(fmtEUR, 'formatEUR');
    expect(a).toBe(b);                        // only differences were the name + the currency literal
    expect(a).toContain('FN');                // own name abstracted
    expect(a).toContain('STR');               // string literals abstracted
    expect(a).not.toContain('formatUSD');
  });
  it('keeps operators/punctuation as tokens (structure matters)', () => {
    expect(codeTokens('a = b + NUM;')).toEqual(['a', '=', 'b', '+', 'NUM', ';']);
  });
});

describe('findSimilarHelpers', () => {
  it('clusters the two near-duplicate formatters and excludes the unrelated function', () => {
    const clusters = findSimilarHelpers(units, { minTokens: 10 });
    expect(clusters).toHaveLength(1);
    const c = clusters[0]!;
    expect(c.members.map(m => m.name).sort()).toEqual(['formatEUR', 'formatUSD']);
    expect(c.members.some(m => m.name === 'parseArgs')).toBe(false);
    expect(c.avgSimilarity).toBeGreaterThan(0.82);
    expect(c.estLinesSaved).toBeGreaterThan(0);
    expect(c.suggestedName).toMatch(/format/i);   // shared word → helper name
  });

  it('ignores trivial functions below the token floor', () => {
    const tiny: FunctionUnit[] = [
      { name: 'getX', file: 'a.ts', startLine: 1, endLine: 1, body: 'const getX = () => this.x;' },
      { name: 'getY', file: 'b.ts', startLine: 1, endLine: 1, body: 'const getY = () => this.y;' },
    ];
    expect(findSimilarHelpers(tiny, { minTokens: 20 })).toHaveLength(0);
  });

  it('tags an exact (post-normalization) cluster so callers can defer to consolidate-dupes', () => {
    const twins: FunctionUnit[] = [
      { name: 'toKebabA', file: 'a.ts', startLine: 1, endLine: 4, body: fmtUSD.replace('formatUSD', 'toKebabA') },
      { name: 'toKebabB', file: 'b.ts', startLine: 1, endLine: 4, body: fmtUSD.replace('formatUSD', 'toKebabB') },
    ];
    const c = findSimilarHelpers(twins, { minTokens: 10 })[0]!;
    expect(c.exact).toBe(true);
  });

  it('ranks the highest-value (most copies × size) cluster first', () => {
    const big = Array.from({ length: 4 }, (_, i) => ({ name: `fmt${i}`, file: `f${i}.ts`, startLine: 1, endLine: 6, body: fmtUSD.replace('formatUSD', `fmt${i}`) }));
    const small = [
      { name: 'wrapA', file: 'x.ts', startLine: 1, endLine: 3, body: 'function wrapA(s){ const t = s.trim(); const u = t.toLowerCase(); return u.padStart(8); }' },
      { name: 'wrapB', file: 'y.ts', startLine: 1, endLine: 3, body: 'function wrapB(s){ const t = s.trim(); const u = t.toLowerCase(); return u.padStart(8); }' },
    ];
    const clusters = findSimilarHelpers([...small, ...big], { minTokens: 10 });
    expect(clusters[0]!.members.length).toBe(4);   // the 4-copy formatter cluster outranks the 2-copy one
  });

  it('does NOT over-cluster structurally-different functions (TF-IDF anti-chaining regression)', () => {
    // Distinct logic that merely shares ubiquitous tokens (const/=/return/./()) must NOT cluster.
    const distinct: FunctionUnit[] = [
      { name: 'sumEvens', file: 'a.ts', startLine: 1, endLine: 5, body: 'function sumEvens(xs){ let total = 0; for (const x of xs) if (x % 2 === 0) total += x; return total; }' },
      { name: 'httpGet', file: 'b.ts', startLine: 1, endLine: 5, body: 'async function httpGet(url){ const res = await fetch(url); const body = await res.text(); return body.trim(); }' },
      { name: 'makeSlug', file: 'c.ts', startLine: 1, endLine: 5, body: 'function makeSlug(title){ const lower = title.toLowerCase(); const clean = lower.replace(/[^a-z0-9]+/g, "-"); return clean; }' },
      { name: 'clampRange', file: 'd.ts', startLine: 1, endLine: 5, body: 'function clampRange(v, lo, hi){ if (v < lo) return lo; if (v > hi) return hi; return v; }' },
    ];
    expect(findSimilarHelpers(distinct, { minTokens: 8, minSim: 0.88 })).toHaveLength(0);
  });

  it('drops a member NESTED inside another member (inner helper vs its parent is not a dupe)', () => {
    // Real case from axios: buildPath is defined INSIDE formDataToJSON — they share most tokens.
    const parent = { name: 'outer', file: 'x.ts', startLine: 10, endLine: 60, body: fmtUSD.replace('formatUSD', 'outer') };
    const child = { name: 'inner', file: 'x.ts', startLine: 15, endLine: 40, body: fmtUSD.replace('formatUSD', 'inner') };
    expect(findSimilarHelpers([parent, child], { minTokens: 10 })).toHaveLength(0);   // cluster collapses to 1 → dropped
    // …but a genuine same-file, NON-overlapping pair still clusters.
    const sibling = { name: 'sib', file: 'x.ts', startLine: 70, endLine: 90, body: fmtUSD.replace('formatUSD', 'sib') };
    expect(findSimilarHelpers([parent, sibling], { minTokens: 10 })).toHaveLength(1);
  });

  it('formats a readable report with the extract-with-review caveat', () => {
    const report = formatHelperClusters(findSimilarHelpers(units, { minTokens: 10 }));
    expect(report).toMatch(/near-duplicate helper cluster/);
    expect(report).toMatch(/lines saved/);
    expect(report).toMatch(/Detection only/);
    expect(formatHelperClusters([])).toMatch(/No near-duplicate/);
  });
});

describe('proposeParameterizedHelper (v2 — parameterize the near-dupes)', () => {
  // The real zod shape: same body, differing only in kind ("min"/"max") and inclusive (false/true).
  const check = (name: string, kind: string, inclusive: string) => ({
    name, file: 'types.ts', startLine: 1, endLine: 8,
    body: `${name}(message) {\n  return this._addCheck({\n    kind: ${kind},\n    value: 0,\n    inclusive: ${inclusive},\n    message: toString(message),\n  });\n}`,
  });
  const members = [check('positive', '"min"', 'false'), check('negative', '"max"', 'false'), check('nonnegative', '"min"', 'true')];

  it('turns each varying token position into a parameter, named from its context', () => {
    const pr = proposeParameterizedHelper(members, 'addRangeCheck');
    expect(pr.ok).toBe(true);
    expect(pr.params.map(p => p.name).sort()).toEqual(['inclusive', 'kind']);   // named from `kind:` / `inclusive:`
    const kind = pr.params.find(p => p.name === 'kind')!;
    expect(kind.values).toEqual(['"min"', '"max"', '"min"']);
    expect(pr.sketch).toContain('kind: kind');                                  // varying token → param in the sketch
    expect(pr.sketch).toContain('inclusive: inclusive');
    expect(pr.sketch).toContain('addRangeCheck(message)');                      // own name neutralized to helper name
    expect(pr.calls[1]).toEqual({ member: 'negative', args: ['"max"', 'false'] });
  });

  it('co-varying positions collapse into ONE parameter', () => {
    const two = [
      { name: 'a', file: 'f.ts', startLine: 1, endLine: 3, body: 'a() { log("x"); send("x"); }' },
      { name: 'b', file: 'f.ts', startLine: 5, endLine: 7, body: 'b() { log("y"); send("y"); }' },
    ];
    const pr = proposeParameterizedHelper(two);
    expect(pr.ok).toBe(true);
    expect(pr.params).toHaveLength(1);                    // "x"/"y" varies in two places, same vector → one param
    expect(pr.calls[0]!.args).toEqual(['"x"']);
  });

  it('declines honestly when structures differ or too many parts vary', () => {
    const divergent = [
      { name: 'a', file: 'f.ts', startLine: 1, endLine: 3, body: 'a() { return 1; }' },
      { name: 'b', file: 'f.ts', startLine: 5, endLine: 9, body: 'b() { for (const x of xs) go(x); return 2; }' },
    ];
    expect(proposeParameterizedHelper(divergent).ok).toBe(false);
    expect(proposeParameterizedHelper(divergent).reason).toMatch(/token counts differ/);
    const identical = [
      { name: 'a', file: 'f.ts', startLine: 1, endLine: 3, body: 'a() { return 1; }' },
      { name: 'b', file: 'g.ts', startLine: 1, endLine: 3, body: 'b() { return 1; }' },
    ];
    expect(proposeParameterizedHelper(identical).reason).toMatch(/consolidate-dupes/);
  });

  it('comment-only differences do NOT block alignment (live dry-run regression)', () => {
    // Dogfooding v8 on QodeX: 100%-similar pairs declined as "structurally divergent" only
    // because their comments tokenized differently. Comments are semantically irrelevant.
    const commented = [
      { name: 'a', file: 'f.ts', startLine: 1, endLine: 4, body: 'a(x) {\n  // clamp to the range\n  return Math.min(x, 10);\n}' },
      { name: 'b', file: 'g.ts', startLine: 1, endLine: 4, body: 'b(x) {\n  /* different words here */\n  return Math.min(x, 20);\n}' },
    ];
    const pr = proposeParameterizedHelper(commented);
    expect(pr.ok).toBe(true);                       // aligns despite different comments
    expect(pr.params).toHaveLength(1);              // only the 10/20 literal varies
    expect(pr.params[0]!.values).toEqual(['10', '20']);
    // …and a // inside a STRING literal is not treated as a comment.
    const url = [
      { name: 'u1', file: 'f.ts', startLine: 1, endLine: 3, body: 'u1() { return fetch("https://a.example/x"); }' },
      { name: 'u2', file: 'g.ts', startLine: 1, endLine: 3, body: 'u2() { return fetch("https://b.example/x"); }' },
    ];
    const pu = proposeParameterizedHelper(url);
    expect(pu.ok).toBe(true);
    expect(pu.params[0]!.values).toEqual(['"https://a.example/x"', '"https://b.example/x"']);
  });

  it('mixed structural variants: parameterizes the LARGEST aligned subset and reports the rest as dropped', () => {
    // The real zod shape: a Number family plus a BigInt variant whose body has extra tokens.
    const bigint = { name: 'positiveBig', file: 'types.ts', startLine: 20, endLine: 27,
      body: 'positiveBig(message) {\n  return this._addCheck({\n    kind: "min",\n    value: BigInt(0),\n    inclusive: false,\n    message: toString(message),\n  });\n}' };
    const pr = proposeParameterizedHelper([...members, bigint], 'addRangeCheck');
    expect(pr.ok).toBe(true);
    expect(pr.calls.map(c => c.member)).toEqual(['positive', 'negative', 'nonnegative']);
    expect(pr.dropped).toEqual(['positiveBig']);
    expect(formatParamProposal(pr)).toContain('not covered — different structure: positiveBig');
  });

  it('formats a reviewable block with the call mapping', () => {
    const out = formatParamProposal(proposeParameterizedHelper(members, 'addRangeCheck'));
    expect(out).toContain('addRangeCheck(kind, inclusive)');
    expect(out).toContain('negative(…) → addRangeCheck("max", false)');
    expect(out).toContain('```');
  });
});
