/**
 * Dashboard observability — the "is everything OK?" half of a control panel: a health summary
 * and a tail of the local log. Pure helpers (tailLines, computeHealth) so they're unit-tested;
 * the gather shell reads ~/.qodex/qodex.log.
 */

export interface HealthItem { label: string; ok: boolean; detail: string }

/** Last `n` non-empty lines of a log blob, oldest→newest. PURE. */
export function tailLines(text: string, n = 40): string[] {
  return text.split('\n').filter(l => l.trim()).slice(-n);
}

/** Roll up a few at-a-glance health signals from the gathered dashboard facts. PURE. */
export function computeHealth(input: {
  providers: { keyEnv?: string; keySet?: boolean }[];
  schedulesEnabled: number;
  botRunning: boolean;
  modelSet: boolean;
  lastRunStatus?: string;
  /** Content-grade web-search keys (Firecrawl/Tavily/Brave): how many are set, and the first
   *  missing one to suggest. Omitted → no badge (old callers unaffected). */
  webKeys?: { set: number; total: number; suggest?: { service: string; env: string; url: string } };
}): HealthItem[] {
  const cloud = input.providers.filter(p => p.keyEnv);
  const ready = cloud.filter(p => p.keySet).length;
  const items: HealthItem[] = [];
  items.push({
    label: 'Provider keys',
    ok: cloud.length === 0 || ready === cloud.length,
    detail: cloud.length === 0 ? 'all local' : `${ready}/${cloud.length} cloud keys set`,
  });
  items.push({ label: 'Default model', ok: input.modelSet, detail: input.modelSet ? 'configured' : 'unset — run `qodex setup`' });
  if (input.webKeys) {
    const w = input.webKeys;
    items.push({
      label: 'Web search',
      ok: w.set > 0,
      detail: w.set > 0
        ? `${w.set}/${w.total} content-grade backend(s) keyed`
        : `keyless fallback only — ${w.suggest ? `get a free ${w.suggest.service} key at ${w.suggest.url} (${w.suggest.env})` : 'set a search API key'}`,
    });
  }
  items.push({ label: 'Scheduler', ok: true, detail: `${input.schedulesEnabled} task(s) enabled` });
  items.push({ label: 'Bot', ok: true, detail: input.botRunning ? 'running' : 'stopped' });
  if (input.lastRunStatus) {
    items.push({ label: 'Last scheduled run', ok: input.lastRunStatus === 'success', detail: input.lastRunStatus });
  }
  return items;
}
