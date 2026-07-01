import { describe, it, expect } from 'vitest';
import { parseExtractMetrics } from '../src/tools/web/extract-metrics.ts';
import { capMarkdown, mapFirecrawlResults } from '../src/tools/web/parse.ts';

describe('parseExtractMetrics', () => {
  it('counts modes and computes the semantic hit-rate over TRUNCATED pages only', () => {
    const jsonl = [
      '{"t":1,"mode":"semantic"}',
      '{"t":2,"mode":"semantic"}',
      '{"t":3,"mode":"head-tail"}',
      '{"t":4,"mode":"whole"}',        // whole isn't a truncation → ignored
      'garbage line',                   // tolerated
      '',
    ].join('\n');
    const c = parseExtractMetrics(jsonl);
    expect(c.semantic).toBe(2);
    expect(c.headTail).toBe(1);
    expect(c.truncated).toBe(3);
    expect(c.semanticRate).toBeCloseTo(2 / 3, 5);
  });

  it('empty input → all zero, no divide-by-zero', () => {
    expect(parseExtractMetrics('')).toEqual({ semantic: 0, headTail: 0, truncated: 0, semanticRate: 0 });
  });
});

describe('capMarkdown / mapFirecrawlResults — semantic on the Firecrawl backend', () => {
  const page = ['# Guide', 'intro '.repeat(300), 'set flags.retry=false to turn off retries', 'outro '.repeat(300)].join('\n\n');

  it('capMarkdown returns the query-relevant middle (semantic), not just the head', () => {
    const c = capMarkdown(page, 'how do I turn off retries?', 700);
    expect(c.mode).toBe('semantic');
    expect(c.snippet).toContain('flags.retry=false');
  });

  it('no query → head+tail window (parity with the old head-slice behavior), stays within cap', () => {
    const c = capMarkdown(page, undefined, 700);
    expect(c.mode).toBe('head-tail');
    expect(c.snippet).not.toContain('flags.retry=false');   // mid-doc answer dropped without a query
  });

  it('mapFirecrawlResults applies semantic selection + fires onExtract with the mode', () => {
    const modes: string[] = [];
    const results = mapFirecrawlResults(
      { success: true, data: [{ title: 'G', url: 'https://g.com', markdown: page }] },
      5,
      { query: 'turn off retries', onExtract: (m) => modes.push(m) },
    );
    expect(results[0]!.snippet).toContain('flags.retry=false');
    expect(modes).toEqual(['semantic']);
  });

  it('short markdown returns whole and does not count as a truncation', () => {
    const modes: string[] = [];
    mapFirecrawlResults(
      { success: true, data: [{ title: 'S', url: 'https://s.com', markdown: '# Short\n\ntiny body' }] },
      5,
      { query: 'anything', onExtract: (m) => modes.push(m) },
    );
    expect(modes).toEqual(['whole']);   // onExtract still fires, but recordExtract() will ignore 'whole'
  });
});
