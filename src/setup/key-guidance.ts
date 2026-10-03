/**
 * API-key guidance — turn "it silently can't search" into an actionable next step.
 *
 * The failure mode this removes: a user sets up their models, asks for a task that needs web
 * search / page content, and the keyed backends (Firecrawl / Tavily / Brave) are skipped because
 * no API key is set — the task limps along on the keyless fallback or fails, and the user never
 * learns WHY or what to do. Instead, every key-related failure now tells them exactly:
 *   1. where to get the key (with the free-tier note),
 *   2. how to set it themselves (~/.qodex/.env or a shell export), and
 *   3. that they can simply PASTE it in chat — the agent saves it with the `save_api_key` tool
 *      and continues the task in the same session.
 *
 * PURE (env passed in) — unit-tested. The registry is the single source of truth reused by the
 * backend error messages, the web_search failure summary, and the dashboard health badge.
 */

export interface ServiceKey {
  env: string;
  service: string;
  url: string;          // where to get the key
  unlocks: string;      // what capability it enables, in user terms
  freeTier: boolean;
}

/** Keys that unlock web capabilities. Order = recommendation order. */
export const WEB_SERVICE_KEYS: readonly ServiceKey[] = [
  { env: 'FIRECRAWL_API_KEY', service: 'Firecrawl', url: 'https://www.firecrawl.dev', unlocks: 'search with full-page content + the best page extraction', freeTier: true },
  { env: 'TAVILY_API_KEY', service: 'Tavily', url: 'https://app.tavily.com', unlocks: 'fast LLM-grade web search', freeTier: true },
  { env: 'BRAVE_SEARCH_API_KEY', service: 'Brave Search', url: 'https://api-dashboard.search.brave.com', unlocks: 'independent-index web search', freeTier: true },
] as const;

export function findServiceKey(env: string): ServiceKey | undefined {
  return WEB_SERVICE_KEYS.find(k => k.env === env);
}

/** One-key guidance block: where to get it + the three ways to set it. PURE. */
export function keyGuidance(env: string): string {
  const k = findServiceKey(env);
  const from = k ? `Get a key at ${k.url}${k.freeTier ? ' (free tier available)' : ''} — it unlocks ${k.unlocks}.` : `This needs the ${env} environment variable.`;
  return [
    from,
    'Then any of:',
    `  • paste the key here in chat — I'll store it safely (~/.qodex/.env, chmod 600) and continue your task`,
    `  • add \`${env}=<key>\` to ~/.qodex/.env yourself`,
    `  • or \`export ${env}=<key>\` in your shell`,
  ].join('\n');
}

/** Which web keys are set / missing, given an env-like map. PURE. */
export function webKeyStatus(env: Record<string, string | undefined>): { set: ServiceKey[]; missing: ServiceKey[] } {
  const set: ServiceKey[] = [], missing: ServiceKey[] = [];
  for (const k of WEB_SERVICE_KEYS) (env[k.env] ? set : missing).push(k);
  return { set, missing };
}

/**
 * The "your search is running degraded" message: shown when a web task failed (or fell back to
 * the keyless engine) while content-grade backends sit unused for lack of a key. PURE.
 */
export function missingWebKeysGuidance(env: Record<string, string | undefined>): string | null {
  const { set, missing } = webKeyStatus(env);
  if (set.length > 0 || missing.length === 0) return null;   // at least one content-grade backend works
  const lines = [
    'Web search/extract is limited right now: no search API key is set, so only the keyless fallback is available.',
    'To unlock a content-grade backend (pick ONE — all have free tiers):',
    ...missing.map(k => `  • ${k.service}: ${k.url}  → ${k.env}  (${k.unlocks})`),
    'You can paste a key here in chat and I will store it safely (~/.qodex/.env) and retry — or add it to ~/.qodex/.env yourself.',
  ];
  return lines.join('\n');
}
