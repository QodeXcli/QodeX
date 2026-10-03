/**
 * Pure parsing/mapping for the web-search backends — no network, no runtime deps, so it
 * unit-tests cleanly and keeps I/O (fetch/auth/timeouts) separate from format handling.
 * Only a TYPE import here (erased at runtime).
 */
import type { WebSearchResult } from './types.js';
import { selectRelevantPassages, stripBase64Images, type ExtractMode } from './extract-select.js';

/** Max chars kept from a scraped markdown body, so one rich result can't flood context. */
const MARKDOWN_CAP = 1500;
/** Max chars kept from a plain description. */
const DESCRIPTION_CAP = 500;

interface FirecrawlItem {
  title?: string;
  url?: string;
  description?: string;
  markdown?: string;
}

/**
 * Cap a scraped markdown body to a budget using the SAME semantic selection as web_fetch: with a
 * query, return the passages most relevant to it (not just the top); without one, a head+tail
 * window. Returns the chosen mode so the caller can record the semantic-vs-positional hit rate. PURE.
 */
export function capMarkdown(md: string, query: string | undefined, cap: number): { snippet: string; mode: ExtractMode } {
  const sel = selectRelevantPassages(stripBase64Images(md), { query, budget: cap });
  return { snippet: sel.content, mode: sel.mode };
}

/**
 * Map a Firecrawl /search payload to our uniform result shape. When markdown is present
 * (content mode) we prefer it — trimmed to the passages most relevant to `query` if given
 * (semantic), else a head+tail window — so the model gets real page content inline. `onExtract`
 * (optional) is called with each capped result's mode so the caller can record metrics.
 */
export function mapFirecrawlResults(
  payload: { success?: boolean; data?: FirecrawlItem[]; error?: string } | null | undefined,
  limit: number,
  opts?: { query?: string; onExtract?: (mode: ExtractMode) => void },
): WebSearchResult[] {
  const items = payload?.data ?? [];
  return items.slice(0, limit).map(r => {
    const md = (r.markdown ?? '').trim();
    const desc = (r.description ?? '').trim();
    let snippet: string;
    if (md) {
      const capped = capMarkdown(md, opts?.query, MARKDOWN_CAP);
      snippet = capped.snippet;
      opts?.onExtract?.(capped.mode);
    } else {
      snippet = desc.slice(0, DESCRIPTION_CAP);
    }
    return { title: r.title ?? '(no title)', url: r.url ?? '', snippet };
  }).filter(r => r.url);
}

/** Parse DuckDuckGo's main HTML results page (result__a / result__snippet). */
export function parseDuckDuckGoHtml(html: string, limit: number): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const titleRegex = /<a[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRegex = /<a[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/g;

  const titles: Array<{ href: string; text: string; offset: number }> = [];
  for (const m of html.matchAll(titleRegex)) {
    titles.push({ href: unwrapDdgRedirect(m[1] ?? ''), text: stripTags(m[2] ?? ''), offset: m.index ?? 0 });
  }
  const snippets: Array<{ text: string; offset: number }> = [];
  for (const m of html.matchAll(snippetRegex)) {
    snippets.push({ text: stripTags(m[1] ?? ''), offset: m.index ?? 0 });
  }

  let sIdx = 0;
  for (const t of titles) {
    if (results.length >= limit) break;
    while (sIdx < snippets.length && snippets[sIdx]!.offset < t.offset) sIdx++;
    const snippetText = sIdx < snippets.length ? snippets[sIdx]!.text : '';
    if (!t.href || !t.text) continue;
    results.push({ title: t.text, url: t.href, snippet: snippetText });
  }
  return results;
}

/** Parse the lite.duckduckgo.com/lite/ table-based results page (result-link / result-snippet). */
export function parseDuckDuckGoLiteHtml(html: string, limit: number): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const linkRegex = /<a[^>]*class="[^"]*\bresult-link\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snipRegex = /<td[^>]*class="[^"]*\bresult-snippet\b[^"]*"[^>]*>([\s\S]*?)<\/td>/g;

  const links: Array<{ href: string; text: string; offset: number }> = [];
  for (const m of html.matchAll(linkRegex)) {
    links.push({ href: unwrapDdgRedirect(m[1] ?? ''), text: stripTags(m[2] ?? ''), offset: m.index ?? 0 });
  }
  const snips: Array<{ text: string; offset: number }> = [];
  for (const m of html.matchAll(snipRegex)) {
    snips.push({ text: stripTags(m[1] ?? ''), offset: m.index ?? 0 });
  }

  let sIdx = 0;
  for (const l of links) {
    if (results.length >= limit) break;
    while (sIdx < snips.length && snips[sIdx]!.offset < l.offset) sIdx++;
    const snippetText = sIdx < snips.length ? snips[sIdx]!.text : '';
    if (!l.href || !l.text) continue;
    results.push({ title: l.text, url: l.href, snippet: snippetText });
  }
  return results;
}

/** Unwrap DuckDuckGo's `//duckduckgo.com/l/?uddg=<encoded>` tracking redirect. */
export function unwrapDdgRedirect(url: string): string {
  const abs = url.startsWith('//') ? 'https:' + url : url;
  try {
    const u = new URL(abs);
    if (u.hostname === 'duckduckgo.com' && u.pathname === '/l/') {
      const real = u.searchParams.get('uddg');
      if (real) return decodeURIComponent(real);
    }
  } catch { /* fall through */ }
  return abs;
}

export function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
