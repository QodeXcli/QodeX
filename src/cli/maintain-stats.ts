/**
 * Maintain analytics — roll up the `maintain` recipe's scheduled runs into a status panel:
 * how many cleanups shipped, the safe-decline (block) rate that proves the guardrails work, what
 * was cleaned, by scope, and a rough time-saved estimate. PURE — unit-tested.
 */

export interface MaintainRun {
  scope: string;            // dead-code | unused-imports | … (from the schedule prompt)
  status: string;           // receipt status: opened | blocked | done | failed (or run status)
  filesChanged: number;     // from the receipt
  when: string;             // relative time, newest first expected
  at?: string;              // ISO timestamp (for week-over-week trends)
}

export interface MaintainStats {
  totalRuns: number;
  opened: number;           // PRs opened (cleanups that shipped)
  blocked: number;          // safely declined by a guardrail (a GOOD signal)
  failed: number;
  successRate: number;      // opened ÷ totalRuns, 0–1
  filesCleaned: number;     // Σ filesChanged across opened runs
  estMinutesSaved: number;  // rough: ~5 min of manual find+fix+verify per shipped cleanup
  byScope: { scope: string; runs: number; opened: number }[];
  lastRun?: { when: string; status: string; scope: string };
}

export function buildMaintainStats(runs: MaintainRun[]): MaintainStats {
  const opened = runs.filter(r => r.status === 'opened').length;
  const blocked = runs.filter(r => r.status === 'blocked').length;
  const failed = runs.filter(r => r.status === 'failed' || r.status === 'error').length;
  const filesCleaned = runs.filter(r => r.status === 'opened').reduce((a, r) => a + (r.filesChanged || 0), 0);

  const byScopeMap = new Map<string, { runs: number; opened: number }>();
  for (const r of runs) {
    const e = byScopeMap.get(r.scope) ?? { runs: 0, opened: 0 };
    e.runs++; if (r.status === 'opened') e.opened++;
    byScopeMap.set(r.scope, e);
  }
  const byScope = [...byScopeMap.entries()]
    .map(([scope, v]) => ({ scope, ...v }))
    .sort((a, b) => b.runs - a.runs);

  return {
    totalRuns: runs.length,
    opened, blocked, failed,
    successRate: runs.length ? opened / runs.length : 0,
    filesCleaned,
    estMinutesSaved: opened * 5,
    byScope,
    lastRun: runs[0] ? { when: runs[0].when, status: runs[0].status, scope: runs[0].scope } : undefined,
  };
}

/** Suggest scopes that haven't run yet (so the dashboard can nudge what to schedule next). PURE. */
export function suggestNextScopes(stats: MaintainStats, allScopes: readonly string[]): string[] {
  const seen = new Set(stats.byScope.map(s => s.scope));
  return allScopes.filter(s => !seen.has(s));
}

/** Auto-recommend the next scope to run, with a reason. Prefers a never-run scope; else the scope
 *  blocking most often (a backlog it can't currently clear); else the least-used. PURE. */
export function recommendNextScope(
  runs: MaintainRun[],
  stats: MaintainStats,
  allScopes: readonly string[],
): { scope: string; why: string } | null {
  const never = suggestNextScopes(stats, allScopes);
  if (never.length) return { scope: never[0]!, why: 'never run here yet — try it' };
  // count blocks per scope (a scope that keeps blocking has a backlog worth a look)
  const blocks = new Map<string, number>();
  for (const r of runs) if (r.status === 'blocked') blocks.set(r.scope, (blocks.get(r.scope) ?? 0) + 1);
  const topBlock = [...blocks.entries()].sort((a, b) => b[1] - a[1])[0];
  if (topBlock && topBlock[1] >= 2) return { scope: topBlock[0], why: `blocked ${topBlock[1]}× recently — review the backlog` };
  const leastUsed = [...stats.byScope].sort((a, b) => a.runs - b.runs)[0];
  return leastUsed ? { scope: leastUsed.scope, why: 'least-exercised scope' } : null;
}

export interface MaintainWeekly {
  opened: number; blocked: number; filesCleaned: number; minutesSaved: number;
  priorOpened: number; openedDelta: number;
}

/** Opened-cleanups per week over the last `weeks` (oldest→newest) — a sparkline series. PURE. */
export function trendByWeek(runs: MaintainRun[], nowMs: number, weeks = 8): number[] {
  const DAY = 86_400_000;
  const buckets = new Array(weeks).fill(0);
  for (const r of runs) {
    if (r.status !== 'opened' || !r.at) continue;
    const t = Date.parse(r.at);
    if (!Number.isFinite(t)) continue;
    const weeksAgo = Math.floor((nowMs - t) / (7 * DAY));
    if (weeksAgo >= 0 && weeksAgo < weeks) buckets[weeks - 1 - weeksAgo]++;   // newest at the end
  }
  return buckets;
}

/** Project the going rate forward: cleanups + minutes saved per month, from the last 28 days. PURE. */
export function projectMonthly(runs: MaintainRun[], nowMs: number): { cleanupsPerMonth: number; minutesPerMonth: number } {
  const since = nowMs - 28 * 86_400_000;
  const recent = runs.filter(r => r.status === 'opened' && r.at && Date.parse(r.at) >= since).length;
  return { cleanupsPerMonth: recent, minutesPerMonth: recent * 5 };
}

export interface MaintainForecast {
  weeklyAvg: number;                               // mean opened/week over the window
  slope: number;                                   // OLS slope — Δ cleanups per week (rounded to 0.01)
  direction: 'rising' | 'falling' | 'steady';      // is the loop accelerating, cooling, or level?
  nextWeek: number;                                // predicted opened NEXT week (≥0, from the fitted line)
  weeks: number;                                   // window length used
}

/**
 * Fit an ordinary-least-squares trendline to the weekly opened-cleanups series and predict next
 * week — a stronger, honest signal than a naive "last-28-days" count: it says whether the
 * self-improvement loop is speeding up, cooling off, or holding steady, and where it's headed. PURE.
 */
export function forecastTrend(runs: MaintainRun[], nowMs: number, weeks = 8): MaintainForecast {
  const ys = trendByWeek(runs, nowMs, weeks);      // oldest→newest, length = weeks
  const n = ys.length;
  const weeklyAvg = n ? ys.reduce((a, b) => a + b, 0) / n : 0;
  // OLS over x = 0..n-1.
  const meanX = (n - 1) / 2;
  let num = 0, den = 0;
  for (let x = 0; x < n; x++) { num += (x - meanX) * (ys[x]! - weeklyAvg); den += (x - meanX) ** 2; }
  const slope = den ? num / den : 0;
  const intercept = weeklyAvg - slope * meanX;
  const nextWeek = Math.max(0, Math.round(intercept + slope * n));
  const direction = slope > 0.15 ? 'rising' : slope < -0.15 ? 'falling' : 'steady';
  return { weeklyAvg: Math.round(weeklyAvg * 100) / 100, slope: Math.round(slope * 100) / 100, direction, nextWeek, weeks: n };
}

/** Week-over-week self-improvement report from run timestamps. PURE (pass `nowMs`). */
export function weeklyReport(runs: MaintainRun[], nowMs: number): MaintainWeekly {
  const DAY = 86_400_000;
  const inWindow = (r: MaintainRun, from: number, to: number) => {
    const t = r.at ? Date.parse(r.at) : NaN;
    return Number.isFinite(t) && t >= from && t < to;
  };
  const thisWeek = runs.filter(r => inWindow(r, nowMs - 7 * DAY, nowMs));
  const priorWeek = runs.filter(r => inWindow(r, nowMs - 14 * DAY, nowMs - 7 * DAY));
  const opened = thisWeek.filter(r => r.status === 'opened');
  return {
    opened: opened.length,
    blocked: thisWeek.filter(r => r.status === 'blocked').length,
    filesCleaned: opened.reduce((a, r) => a + (r.filesChanged || 0), 0),
    minutesSaved: opened.length * 5,
    priorOpened: priorWeek.filter(r => r.status === 'opened').length,
    openedDelta: opened.length - priorWeek.filter(r => r.status === 'opened').length,
  };
}
