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
  items.push({ label: 'Scheduler', ok: true, detail: `${input.schedulesEnabled} task(s) enabled` });
  items.push({ label: 'Bot', ok: true, detail: input.botRunning ? 'running' : 'stopped' });
  if (input.lastRunStatus) {
    items.push({ label: 'Last scheduled run', ok: input.lastRunStatus === 'success', detail: input.lastRunStatus });
  }
  return items;
}
