import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { WebSearchBackend, WebSearchError } from './types.js';
import { DuckDuckGoBackend } from './duckduckgo.js';
import { TavilyBackend } from './tavily.js';
import { BraveBackend } from './brave.js';
import { FirecrawlBackend } from './firecrawl.js';
import { logger } from '../../utils/logger.js';

const WebSearchArgs = z.object({
  query: z.string().min(1).describe('Search query. Be specific — agents do better with longer, more targeted queries.'),
  limit: z.number().int().min(1).max(20).optional().describe('Max number of results to return (default 5)'),
});

/** Build a backend instance from a string id. Defaults to duckduckgo on unknown values. */
export function selectBackend(name: string | undefined): WebSearchBackend {
  switch ((name ?? 'duckduckgo').toLowerCase()) {
    case 'tavily':
      return new TavilyBackend();
    case 'brave':
      return new BraveBackend();
    case 'firecrawl':
    case 'fc':
      return new FirecrawlBackend();
    case 'duckduckgo':
    case 'ddg':
    case undefined:
      return new DuckDuckGoBackend();
    default:
      logger.warn(`Unknown web_search backend '${name}', falling back to duckduckgo`);
      return new DuckDuckGoBackend();
  }
}

/**
 * Build the fallback chain. If the primary backend fails or returns nothing,
 * we try the others in order. Order: primary first, then any backend whose
 * auth (if needed) is satisfied via environment variable.
 *
 * Why auto-fallback: real users hit network blocks (DDG from Iran, etc) and
 * having `web_search` silently pivot is dramatically more helpful than 11
 * retries against the same blocked endpoint.
 */
function buildFallbackChain(primaryName: string | undefined): WebSearchBackend[] {
  const all: WebSearchBackend[] = [];
  const primary = selectBackend(primaryName);
  all.push(primary);
  // Add other backends that have credentials available, deduped
  const seen = new Set([primary.name]);
  if (!seen.has('firecrawl') && process.env.FIRECRAWL_API_KEY) {
    all.push(new FirecrawlBackend());
    seen.add('firecrawl');
  }
  if (!seen.has('brave') && process.env.BRAVE_SEARCH_API_KEY) {
    all.push(new BraveBackend());
    seen.add('brave');
  }
  if (!seen.has('tavily') && process.env.TAVILY_API_KEY) {
    all.push(new TavilyBackend());
    seen.add('tavily');
  }
  if (!seen.has('duckduckgo')) {
    all.push(new DuckDuckGoBackend());
  }
  return all;
}

/**
 * `web_search` tool. Pluggable backend, model never sees the choice.
 *
 * Result format (kept compact for the model):
 *
 *   3 results for "ripgrep regex flags":
 *
 *   1. ripgrep — User Guide
 *      https://github.com/BurntSushi/ripgrep/blob/master/GUIDE.md
 *      ripgrep supports the same Rust regex syntax as the regex crate. Common flags...
 *
 *   2. ...
 *
 * Returns a `[NO_RESULTS]` marker when the backend succeeded but found nothing — that's
 * different from an error and the model should adapt rather than retry.
 *
 * Read-only: web search has no side effects (no writes, no purchases, no DMs). Cheap
 * permission-wise.
 */
export class WebSearchTool extends Tool<z.infer<typeof WebSearchArgs>> {
  name = 'web_search';
  description = 'Search the web. Returns title + URL + snippet for each result. Use for current docs, recent issues, library examples, error messages from the wild. Read-only.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = WebSearchArgs;

  // When set (by tests or callers), this backend is used exclusively, bypassing
  // the config-driven fallback chain.
  private injectedBackend: WebSearchBackend | null = null;

  /** Allow tests / callers to inject a stub backend. */
  setBackend(b: WebSearchBackend): void {
    this.injectedBackend = b;
  }

  async execute(args: z.infer<typeof WebSearchArgs>, ctx: ToolContext): Promise<ToolResult> {
    const limit = args.limit ?? 5;

    // Backend choice comes from config — we look it up via the global config getter so the
    // tool stays decoupled from constructor wiring (other tools follow the same pattern).
    const { getActiveConfig } = await import('../../config/loader.js');
    const cfg = getActiveConfig();
    const backendName = (cfg?.defaults as any)?.web_search_backend as string | undefined;

    // Build the fallback chain. An injected backend (tests/callers) is used
    // exclusively; otherwise if the user set a specific backend, try it first and
    // still pivot to anything with credentials on failure.
    const chain = this.injectedBackend ? [this.injectedBackend] : buildFallbackChain(backendName);
    logger.debug('web_search starting', { primary: chain[0]?.name, chainLength: chain.length, query: args.query });

    const failures: string[] = [];
    let anyTransportError = false; // a backend threw (network/HTTP), vs. cleanly returned 0 results
    let anyEmpty = false;          // a backend reached the service and found nothing
    for (const backend of chain) {
      try {
        const results = await backend.search(args.query, { limit, signal: ctx.signal });
        if (results.length === 0) {
          failures.push(`${backend.name}: no results`);
          anyEmpty = true;
          continue; // try next backend
        }
        const lines: string[] = [`${results.length} result${results.length > 1 ? 's' : ''} for "${args.query}" (via ${backend.name}):`];
        results.forEach((r, i) => {
          lines.push('');
          lines.push(`${i + 1}. ${r.title}`);
          lines.push(`   ${r.url}`);
          if (r.snippet) lines.push(`   ${r.snippet.slice(0, 300)}`);
        });
        // Note if we pivoted off the primary
        if (backend.name !== chain[0]?.name) {
          lines.unshift(`(primary backend ${chain[0]?.name} failed; pivoted to ${backend.name})`);
        }
        return {
          content: lines.join('\n'),
          metadata: { count: results.length, backend: backend.name, pivoted: backend.name !== chain[0]?.name },
        };
      } catch (e: any) {
        const msg = e instanceof WebSearchError ? `${e.backend}: ${e.message}` : (e?.message ?? String(e));
        failures.push(msg);
        anyTransportError = true;
        logger.debug(`backend ${backend.name} failed, trying next`, { err: msg });
      }
    }

    // When failing, tell the user EXACTLY how to unlock a content-grade backend — including that
    // they can paste a key in chat and the agent saves it (save_api_key) and retries.
    const { missingWebKeysGuidance } = await import('../../setup/key-guidance.js');
    const guidance = missingWebKeysGuidance(process.env as Record<string, string | undefined>);
    const unlockHint = guidance ? `\n\n${guidance}` : '\n\nRun /network to check connectivity.';

    // Every backend errored at the transport level (and none cleanly returned an
    // empty result set) → this is a real failure, not just "nothing found".
    if (anyTransportError && !anyEmpty) {
      return {
        isError: true,
        content: `[WEB_SEARCH_ERROR] All ${chain.length} backend(s) errored for "${args.query}":\n` +
          failures.map(f => `  - ${f}`).join('\n') + unlockHint,
      };
    }

    // At least one backend reached the service but nothing matched → no results.
    return {
      content: `[NO_RESULTS] All ${chain.length} backend(s) failed for "${args.query}":\n` +
        failures.map(f => `  - ${f}`).join('\n') +
        `\n\nTry a different/more specific query.` + unlockHint,
    };
  }
}
