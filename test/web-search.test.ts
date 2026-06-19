import { describe, it, expect } from 'vitest';
import { parseDuckDuckGoHtml, unwrapDdgRedirect } from '../src/tools/web/duckduckgo.js';
import { selectBackend, WebSearchTool } from '../src/tools/web/web-search.js';
import type { WebSearchBackend } from '../src/tools/web/types.js';
import { WebSearchError } from '../src/tools/web/types.js';
import type { ToolContext } from '../src/tools/base.js';

function makeCtx(): ToolContext {
  return {
    cwd: process.cwd(),
    sessionId: 'test',
    transaction: {} as any,
    permissions: { check: () => ({ ok: true }) } as any,
    askUser: async () => 'allow',
    signal: new AbortController().signal,
    emit: () => {},
  } as ToolContext;
}

describe('DuckDuckGo HTML parser', () => {
  // Synthetic but format-accurate fixture. Real DDG markup has more attributes; the
  // class names we anchor on (`result__a`, `result__snippet`) are the stable hooks.
  const fixture = `
<html><body>
  <div class="result">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">Example A — Docs</a>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">Snippet for A with <b>bold</b> tags &amp; entities.</a>
  </div>
  <div class="result">
    <a class="result__a" href="https://direct.example.com/b">Example B — direct link</a>
    <a class="result__snippet" href="https://direct.example.com/b">Snippet for B.</a>
  </div>
  <div class="result">
    <a class="result__a" href="https://example.com/c">Example C — no snippet sibling</a>
  </div>
</body></html>
`;

  it('extracts title + url + snippet for each result', () => {
    const r = parseDuckDuckGoHtml(fixture, 10);
    expect(r).toHaveLength(3);
    expect(r[0]).toEqual({
      title: 'Example A — Docs',
      url: 'https://example.com/a',
      snippet: 'Snippet for A with bold tags & entities.',
    });
    expect(r[1]).toMatchObject({ title: 'Example B — direct link', url: 'https://direct.example.com/b' });
  });

  it('handles results without a snippet — picks up the next available one or empty', () => {
    const r = parseDuckDuckGoHtml(fixture, 10);
    // Third result has no snippet of its own; parser pairs by next-after-offset, so an
    // empty snippet is acceptable.
    expect(r[2]?.title).toContain('no snippet sibling');
    expect(typeof r[2]?.snippet).toBe('string');
  });

  it('respects the limit parameter', () => {
    expect(parseDuckDuckGoHtml(fixture, 2)).toHaveLength(2);
    expect(parseDuckDuckGoHtml(fixture, 1)).toHaveLength(1);
  });

  it('returns empty array for empty input without throwing', () => {
    expect(parseDuckDuckGoHtml('', 5)).toEqual([]);
    expect(parseDuckDuckGoHtml('<html><body>no results yo</body></html>', 5)).toEqual([]);
  });

  it('unwraps DuckDuckGo tracking redirects', () => {
    expect(unwrapDdgRedirect('//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.example.com%2Fpage'))
      .toBe('https://real.example.com/page');
  });

  it('leaves direct URLs alone', () => {
    expect(unwrapDdgRedirect('https://direct.example.com/x'))
      .toBe('https://direct.example.com/x');
    expect(unwrapDdgRedirect('//direct.example.com/x'))
      .toBe('https://direct.example.com/x');
  });

  it('falls back gracefully on malformed redirect URLs', () => {
    // Garbage URL — should return as-is rather than throw
    expect(unwrapDdgRedirect('not://a real url at all'))
      .toBe('not://a real url at all');
  });
});

describe('Backend selection', () => {
  it('selects DuckDuckGo by default', () => {
    expect(selectBackend(undefined).name).toBe('duckduckgo');
  });

  it('selects Tavily when configured', () => {
    expect(selectBackend('tavily').name).toBe('tavily');
  });

  it('accepts ddg alias for duckduckgo', () => {
    expect(selectBackend('ddg').name).toBe('duckduckgo');
  });

  it('falls back to DuckDuckGo for unknown names without throwing', () => {
    expect(selectBackend('bing').name).toBe('duckduckgo');
    expect(selectBackend('').name).toBe('duckduckgo');
  });

  it('matching is case-insensitive', () => {
    expect(selectBackend('TAVILY').name).toBe('tavily');
    expect(selectBackend('DuckDuckGo').name).toBe('duckduckgo');
  });
});

describe('WebSearchTool with injected backend', () => {
  function makeStubBackend(name: string, responses: { results?: any[]; error?: Error }): WebSearchBackend {
    return {
      name,
      requiresAuth: false,
      async search(_q, _o) {
        if (responses.error) throw responses.error;
        return responses.results ?? [];
      },
    };
  }

  it('formats successful results with a numbered listing', async () => {
    const tool = new WebSearchTool();
    tool.setBackend(makeStubBackend('duckduckgo', {
      results: [
        { title: 'Result One', url: 'https://example.com/1', snippet: 'snippet one' },
        { title: 'Result Two', url: 'https://example.com/2', snippet: 'snippet two' },
      ],
    }));
    const r = await tool.execute({ query: 'ripgrep', limit: 5 }, makeCtx());
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('2 results for "ripgrep" (via duckduckgo)');
    expect(r.content).toContain('1. Result One');
    expect(r.content).toContain('https://example.com/1');
    expect(r.content).toContain('snippet one');
    expect((r.metadata as any).count).toBe(2);
  });

  it('returns NO_RESULTS marker on empty (not an error)', async () => {
    const tool = new WebSearchTool();
    tool.setBackend(makeStubBackend('duckduckgo', { results: [] }));
    const r = await tool.execute({ query: 'nothing-here-xyz12345' }, makeCtx());
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('NO_RESULTS');
  });

  it('returns WEB_SEARCH_ERROR on transport-level failure', async () => {
    const tool = new WebSearchTool();
    tool.setBackend(makeStubBackend('duckduckgo', {
      error: new WebSearchError('connection refused', 'duckduckgo'),
    }));
    const r = await tool.execute({ query: 'anything' }, makeCtx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain('WEB_SEARCH_ERROR');
    expect(r.content).toContain('connection refused');
  });

  it('truncates very long snippets to 300 chars in the output', async () => {
    const longSnippet = 'x'.repeat(1000);
    const tool = new WebSearchTool();
    tool.setBackend(makeStubBackend('duckduckgo', {
      results: [{ title: 'T', url: 'https://x', snippet: longSnippet }],
    }));
    const r = await tool.execute({ query: 'q' }, makeCtx());
    // The snippet line should be truncated
    const snippetLine = r.content.split('\n').find(l => l.includes('xxxx'));
    expect(snippetLine).toBeDefined();
    expect(snippetLine!.length).toBeLessThan(350);
  });
});
