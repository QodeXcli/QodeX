/**
 * Tavily search backend (https://tavily.com).
 *
 * Tavily is purpose-built for AI agents: each result already includes an LLM-friendly
 * snippet plus an optional answer summary. Free tier is generous (~1000 searches/month
 * at time of writing).
 *
 * Auth: requires `TAVILY_API_KEY` in the environment. We do NOT read it from the QodeX
 * config file — keeping API keys out of files means they can't accidentally leak through
 * git commits / sessionStore exports.
 */
import { WebSearchBackend, WebSearchResult, SearchOptions, WebSearchError } from './types.js';
import { proxyFetch } from '../../utils/proxy-fetch.js';

const TAVILY_URL = 'https://api.tavily.com/search';

export class TavilyBackend implements WebSearchBackend {
  readonly name = 'tavily';
  readonly requiresAuth = true;

  async search(query: string, opts: SearchOptions): Promise<WebSearchResult[]> {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) {
      throw new WebSearchError(
        'Tavily backend selected but TAVILY_API_KEY is not set. ' +
        'Get a free key at https://app.tavily.com — then paste it in chat (the agent saves it via save_api_key and retries), ' +
        'or add TAVILY_API_KEY=... to ~/.qodex/.env.',
        this.name,
      );
    }

    const timeoutMs = opts.timeoutMs ?? 20_000;
    const internalAbort = new AbortController();
    const timer = setTimeout(() => internalAbort.abort(), timeoutMs);
    const onOuterAbort = (): void => internalAbort.abort();
    opts.signal?.addEventListener('abort', onOuterAbort);

    try {
      const res = await proxyFetch(TAVILY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
          query,
          max_results: Math.min(opts.limit, 20),
          search_depth: 'basic',
          include_answer: false,
        }),
        signal: internalAbort.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new WebSearchError(`Tavily HTTP ${res.status}: ${text.slice(0, 300)}`, this.name);
      }
      const payload = await res.json() as { results?: Array<{ title?: string; url?: string; content?: string }> };
      const items = payload.results ?? [];
      return items.slice(0, opts.limit).map(r => ({
        title: r.title ?? '(no title)',
        url: r.url ?? '',
        snippet: (r.content ?? '').slice(0, 500),
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
