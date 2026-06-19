/**
 * Brave Search backend (https://search.brave.com).
 *
 * Why include it: DuckDuckGo is the default but is blocked from many networks
 * (Iran ISP, some corporate firewalls). Tavily has a key but costs money.
 * Brave has a free tier (2000 queries/month) and is reachable from regions
 * where DDG isn't.
 *
 * Auth: requires BRAVE_SEARCH_API_KEY in environment.
 * Endpoint: https://api.search.brave.com/res/v1/web/search
 *
 * Result shape (relevant fields):
 *   {
 *     "web": {
 *       "results": [
 *         { "title": "...", "url": "...", "description": "..." }
 *       ]
 *     }
 *   }
 */

import { WebSearchBackend, WebSearchResult, SearchOptions, WebSearchError } from './types.js';
import { proxyFetch } from '../../utils/proxy-fetch.js';

const BRAVE_URL = 'https://api.search.brave.com/res/v1/web/search';

export class BraveBackend implements WebSearchBackend {
  readonly name = 'brave';
  readonly requiresAuth = true;

  async search(query: string, opts: SearchOptions): Promise<WebSearchResult[]> {
    const apiKey = process.env.BRAVE_SEARCH_API_KEY;
    if (!apiKey) {
      throw new WebSearchError(
        'Brave backend selected but BRAVE_SEARCH_API_KEY is not set. ' +
        'Get a key at https://api.search.brave.com (free tier 2000 q/month).',
        this.name,
      );
    }

    const timeoutMs = opts.timeoutMs ?? 20_000;
    const internalAbort = new AbortController();
    const timer = setTimeout(() => internalAbort.abort(), timeoutMs);
    const onOuterAbort = (): void => internalAbort.abort();
    opts.signal?.addEventListener('abort', onOuterAbort);

    try {
      const url = new URL(BRAVE_URL);
      url.searchParams.set('q', query);
      url.searchParams.set('count', String(Math.min(opts.limit, 20)));
      url.searchParams.set('safesearch', 'moderate');

      const res = await proxyFetch(url.toString(), {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'X-Subscription-Token': apiKey,
        },
        signal: internalAbort.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new WebSearchError(`Brave HTTP ${res.status}: ${text.slice(0, 300)}`, this.name);
      }
      const payload = await res.json() as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
      const items = payload.web?.results ?? [];
      return items.slice(0, opts.limit).map(r => ({
        title: r.title ?? '(no title)',
        url: r.url ?? '',
        snippet: (r.description ?? '').replace(/<\/?strong>/g, '').slice(0, 500),
      }));
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
