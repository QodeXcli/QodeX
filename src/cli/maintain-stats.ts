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
