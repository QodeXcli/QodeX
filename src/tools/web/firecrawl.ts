/**
 * Firecrawl search backend (https://firecrawl.dev).
 *
 * Why add it: most search APIs (and our DuckDuckGo backend) return a list of links +
 * short snippets, so the agent must follow up with a separate `web_fetch` per result to
 * actually read a page — extra round-trips, extra tokens. Firecrawl's /search can return
 * each result's FULL page body as markdown in one call, so the model often has what it
 * needs without any follow-up fetch. Fewer round-trips → fewer tokens.
 *
 * Two modes (cost/latency trade-off):
 *   - default            : metadata only (title/url/description). Fast, cheap
 *                          (2 credits / 10 results). Behaves like the other backends.
 *   - content mode       : set FIRECRAWL_SCRAPE_CONTENT=1 — Firecrawl scrapes every
 *                          result and returns markdown. Richer (fewer follow-up fetches)
 *                          but slower and adds per-page scrape credits.
 *
 * Auth: requires `FIRECRAWL_API_KEY` in the environment (keys live in the env, never the
 * config file, so they can't leak through git / session exports). Keys look like `fc-...`.
 */
import { WebSearchBackend, WebSearchResult, SearchOptions, WebSearchError } from './types.js';
import { proxyFetch } from '../../utils/proxy-fetch.js';
import { mapFirecrawlResults } from './parse.js';

const FIRECRAWL_URL = 'https://api.firecrawl.dev/v1/search';

export class FirecrawlBackend implements WebSearchBackend {
  readonly name = 'firecrawl';
  readonly requiresAuth = true;

  async search(query: string, opts: SearchOptions): Promise<WebSearchResult[]> {
    const apiKey = process.env.FIRECRAWL_API_KEY;
    if (!apiKey) {
      throw new WebSearchError(
        'Firecrawl backend selected but FIRECRAWL_API_KEY is not set in the environment. ' +
        'Export FIRECRAWL_API_KEY=fc-... or switch to another backend in your config.',
        this.name,
      );
    }

    const scrapeContent = process.env.FIRECRAWL_SCRAPE_CONTENT === '1';
    const timeoutMs = opts.timeoutMs ?? (scrapeContent ? 40_000 : 20_000); // scraping is slower
    const internalAbort = new AbortController();
    const timer = setTimeout(() => internalAbort.abort(), timeoutMs);
    const onOuterAbort = (): void => internalAbort.abort();
    opts.signal?.addEventListener('abort', onOuterAbort);

    try {
      const body: Record<string, unknown> = { query, limit: Math.min(opts.limit, 20) };
      if (scrapeContent) body.scrapeOptions = { formats: ['markdown'] };

      const res = await proxyFetch(FIRECRAWL_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: internalAbort.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new WebSearchError(`Firecrawl HTTP ${res.status}: ${text.slice(0, 300)}`, this.name);
      }
      const payload = await res.json() as { success?: boolean; data?: Array<{ title?: string; url?: string; description?: string; markdown?: string }>; error?: string };
      if (payload.success === false) {
        throw new WebSearchError(`Firecrawl error: ${payload.error ?? 'unknown'}`, this.name);
      }
      return mapFirecrawlResults(payload, opts.limit);
    } catch (e: any) {
      if (e instanceof WebSearchError) throw e;
      if (e?.name === 'AbortError') throw new WebSearchError('Request aborted (timeout or cancellation)', this.name, e);
      throw new WebSearchError(`Network error: ${e?.message ?? e}`, this.name, e);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onOuterAbort);
    }
  }
}
