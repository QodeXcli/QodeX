/**
 * Web search backend abstraction. QodeX ships with two implementations:
 *   - duckduckgo : zero-config HTML-scrape backend, no API key needed. Default.
 *   - tavily     : Tavily API (https://tavily.com), requires TAVILY_API_KEY env var.
 *                  AI-optimized, better quality, but a third-party dependency.
 *
 * Users can pick the backend in their config:
 *   defaults:
 *     web_search_backend: duckduckgo   # or "tavily"
 *
 * The model never sees backend choice. It just calls `web_search(query, limit?)` and gets
 * a uniform list of {title, url, snippet} back.
 */

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchBackend {
  /** Human-readable backend name shown in errors / `qx doctor`. */
  readonly name: string;
  /** Whether this backend needs config (api key) to function. Default false. */
  readonly requiresAuth: boolean;

  /**
   * Run the search. Should throw on transport-level failure (network, parse), not on
   * "zero results" — zero results is a valid empty array.
   */
  search(query: string, opts: SearchOptions): Promise<WebSearchResult[]>;
}

export interface SearchOptions {
  /** Max results to return (backend may cap lower). */
  limit: number;
  /** AbortSignal for cancellation — backends should honor this. */
  signal?: AbortSignal;
  /** Request timeout in ms. Default 15s. */
  timeoutMs?: number;
}

export class WebSearchError extends Error {
  constructor(message: string, public readonly backend: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'WebSearchError';
  }
}
