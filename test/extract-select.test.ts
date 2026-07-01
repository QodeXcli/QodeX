import { describe, it, expect } from 'vitest';
import { splitPassages, stripBase64Images, headTailWindow, selectRelevantPassages } from '../src/tools/web/extract-select.ts';

// A page whose ANSWER sits in the MIDDLE — the region a head+tail window drops.
const filler = (label: string, n: number) => Array.from({ length: n }, (_, i) => `${label} paragraph ${i} with generic boilerplate navigation footer cookie banner text.`).join('\n\n');
const PAGE = [
  '# Widget API reference',                                   // passage 0 — lede/anchor
  filler('intro', 12),
  'The retry_backoff option controls exponential backoff; set retry_backoff=false to disable retries entirely.', // the answer (middle)
  filler('appendix', 12),
  'Copyright 2026. Terms. Privacy.',                          // tail
].join('\n\n');

describe('splitPassages', () => {
  it('splits on blank lines and records offsets', () => {
    const ps = splitPassages('a\n\nb\n\n\nc');
    expect(ps.map(p => p.text)).toEqual(['a', 'b', 'c']);
    expect(ps[0]!.start).toBe(0);
  });
});

describe('stripBase64Images', () => {
  it('drops base64 blobs to placeholders, keeps real image links', () => {
    const md = '![chart](data:image/png;base64,AAAABBBBCCCCDDDD====) and ![logo](https://x/y.png)';
    const out = stripBase64Images(md);
    expect(out).toContain('[IMAGE: chart]');
    expect(out).not.toContain('base64');
    expect(out).toContain('](https://x/y.png)');            // http image preserved
  });
});

describe('selectRelevantPassages — semantic beats positional', () => {
  const budget = 900; // small enough that head+tail cannot include the middle answer

  it('head+tail (no query) DROPS the mid-document answer — the Hermes failure mode', () => {
    const sel = selectRelevantPassages(PAGE, { budget });
    expect(sel.mode).toBe('head-tail');
    expect(sel.content).not.toContain('retry_backoff option controls'); // answer lost to positional truncation
  });

  it('semantic (with query) SURFACES the mid-document answer within the same budget', () => {
    const sel = selectRelevantPassages(PAGE, { query: 'how do I disable retry_backoff?', budget });
    expect(sel.mode).toBe('semantic');
    expect(sel.content).toContain('retry_backoff=false to disable'); // the answer is returned directly
    expect(sel.content).toContain('# Widget API reference');         // lede anchor kept for context
    expect(sel.content).toMatch(/omitted \(less relevant\)/);        // gap markers show what was skipped
    expect(sel.keptChars).toBeLessThanOrEqual(budget);
  });

  it('never worse than Hermes: no query → identical head+tail behavior', () => {
    const a = selectRelevantPassages(PAGE, { budget }).content;
    const b = headTailWindow(PAGE, budget).content;
    expect(a).toBe(b);
  });

  it('returns the whole page untouched when it fits the budget', () => {
    const small = '# Tiny\n\nJust one short paragraph.';
    const sel = selectRelevantPassages(small, { query: 'anything', budget: 5000 });
    expect(sel.mode).toBe('whole');
    expect(sel.content).toBe(small);
    expect(sel.omittedChars).toBe(0);
  });

  it('falls back to positional when the query matches nothing in the body', () => {
    const sel = selectRelevantPassages(PAGE, { query: 'quantum chromodynamics lattice gauge', budget });
    expect(sel.mode).toBe('head-tail');
  });
});
