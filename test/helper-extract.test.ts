import { describe, it, expect } from 'vitest';
import { normalizeBody, codeTokens, findSimilarHelpers, formatHelperClusters, type FunctionUnit } from '../src/codegraph/helper-extract.ts';

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

  it('formats a readable report with the extract-with-review caveat', () => {
    const report = formatHelperClusters(findSimilarHelpers(units, { minTokens: 10 }));
    expect(report).toMatch(/near-duplicate helper cluster/);
    expect(report).toMatch(/lines saved/);
    expect(report).toMatch(/Detection only/);
    expect(formatHelperClusters([])).toMatch(/No near-duplicate/);
  });
});
