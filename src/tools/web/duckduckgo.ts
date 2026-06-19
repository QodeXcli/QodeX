/**
 * DuckDuckGo HTML-scrape backend.
 *
 * Strategy: hit `https://html.duckduckgo.com/html/?q=<query>` — DuckDuckGo's no-JS HTML
 * endpoint specifically designed for scraping/proxies. Parse the result list with regex
 * (not a full HTML parser — we want zero dependencies and the format is stable).
 *
 * Constraints / known gotchas:
 *   - DuckDuckGo aggressively rate-limits IPs that hit them in quick succession. The
 *     model should not be re-spamming the same query, but for safety we expose a `limit`
 *     param that the caller can keep small.
 *   - Result URLs are sometimes wrapped in a tracking redirect like
 *     `//duckduckgo.com/l/?uddg=<encoded>`. We unwrap those.
 *   - HTML format has changed before. If parsing yields zero results AND the page was
 *     200 OK and non-empty, we treat it as a parser drift and throw a clear error.
 */
import { WebSearchBackend, WebSearchResult, SearchOptions, WebSearchError } from './types.js';
import { proxyFetch } from '../../utils/proxy-fetch.js';
import { parseDuckDuckGoHtml, parseDuckDuckGoLiteHtml } from './parse.js';

const DDG_URL = 'https://html.duckduckgo.com/html/';
const DDG_LITE_URL = 'https://lite.duckduckgo.com/lite/';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36';

/** Sleep helper for backoff between retries. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
  });
}

export class DuckDuckGoBackend implements WebSearchBackend {
  readonly name = 'duckduckgo';
  readonly requiresAuth = false;

  async search(query: string, opts: SearchOptions): Promise<WebSearchResult[]> {
    const timeoutMs = opts.timeoutMs ?? 15_000;

    // Robustness: try the primary HTML endpoint, then the `lite` endpoint (a different,
    // even sparser format that often survives when the main one is rate-limited or
    // regionally blocked — e.g. from Iran). Each endpoint gets one retry on a transient
    // failure (429 / 5xx / network) with a short backoff. Only after BOTH endpoints are
    // exhausted do we surface an error, letting the outer fallback chain pivot to another
    // backend (Tavily/Brave/Firecrawl).
    const attempts: Array<{ url: string; parse: (html: string, limit: number) => WebSearchResult[]; lite: boolean }> = [
      { url: DDG_URL, parse: parseDuckDuckGoHtml, lite: false },
      { url: DDG_LITE_URL, parse: parseDuckDuckGoLiteHtml, lite: true },
    ];

    let lastErr: WebSearchError | null = null;
    for (const attempt of attempts) {
      for (let tryNo = 0; tryNo < 2; tryNo++) {
        try {
          const html = await this.fetchOnce(attempt.url, query, timeoutMs, opts.signal);
          if (looksLikeBlockPage(html)) {
            lastErr = new WebSearchError(`DuckDuckGo (${attempt.lite ? 'lite' : 'html'}) returned a rate-limit/block page`, this.name);
            break; // don't retry a block page on the same endpoint — move to the next endpoint
          }
          const results = attempt.parse(html, opts.limit);
          if (results.length > 0) return results;
          // 0 results from a non-empty, non-block page → parser drift; try next endpoint.
          if (html.length > 200) {
            lastErr = new WebSearchError(`Parsed 0 results from a non-empty DuckDuckGo ${attempt.lite ? 'lite' : 'html'} response (format may have drifted)`, this.name);
          }
          break;
        } catch (e: any) {
          lastErr = e instanceof WebSearchError ? e : new WebSearchError(`Network error: ${e?.message ?? e}`, this.name, e);
          // Retry once on transient failures with a short backoff; otherwise move on.
          const transient = /HTTP 429|HTTP 5\d\d|Network error|aborted/i.test(lastErr.message);
          if (tryNo === 0 && transient) {
            try { await delay(600, opts.signal); } catch { /* aborted */ return []; }
            continue;
          }
          break;
        }
      }
    }
    throw lastErr ?? new WebSearchError('DuckDuckGo search failed (no results from any endpoint)', this.name);
  }

  /** One fetch against a DDG endpoint with its own timeout/abort wiring. */
  private async fetchOnce(url: string, query: string, timeoutMs: number, outer?: AbortSignal): Promise<string> {
    const internalAbort = new AbortController();
    const timer = setTimeout(() => internalAbort.abort(), timeoutMs);
    const onOuterAbort = (): void => internalAbort.abort();
    outer?.addEventListener('abort', onOuterAbort);
    try {
      const params = new URLSearchParams({ q: query, kl: 'wt-wt' }); // kl=wt-wt = world, no region bias
      const res = await proxyFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        body: params.toString(),
        signal: internalAbort.signal,
      });
      if (!res.ok) throw new WebSearchError(`DuckDuckGo returned HTTP ${res.status}`, this.name);
      return await res.text();
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onOuterAbort);
    }
  }
}

function looksLikeBlockPage(html: string): boolean {
  // Common DDG anti-abuse / captcha indicators
  return /anomaly|captcha|too many|rate.?limit|blocked/i.test(html);
}
