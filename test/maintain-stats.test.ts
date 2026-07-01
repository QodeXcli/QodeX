import { describe, it, expect } from 'vitest';
import { buildMaintainStats, suggestNextScopes, recommendNextScope, weeklyReport, trendByWeek, projectMonthly, forecastTrend } from '../src/cli/maintain-stats.ts';

const R = (scope: string, status: string, filesChanged = 0, when = '1h ago', at?: string) => ({ scope, status, filesChanged, when, at });

describe('buildMaintainStats', () => {
  it('aggregates opened/blocked/failed, files cleaned, success rate, and by-scope', () => {
    const s = buildMaintainStats([
      R('unused-imports', 'opened', 6, 'now'),
      R('unused-locals', 'opened', 4),
      R('unused-locals', 'blocked'),
      R('dep-bump', 'failed'),
    ]);
    expect(s.totalRuns).toBe(4);
    expect(s.opened).toBe(2);
    expect(s.blocked).toBe(1);
    expect(s.failed).toBe(1);
    expect(s.filesCleaned).toBe(10);              // 6 + 4 (opened only)
    expect(s.successRate).toBeCloseTo(0.5, 5);
    expect(s.estMinutesSaved).toBe(10);           // opened × 5
    expect(s.lastRun).toEqual({ when: 'now', status: 'opened', scope: 'unused-imports' });
    const locals = s.byScope.find(b => b.scope === 'unused-locals')!;
    expect(locals).toEqual({ scope: 'unused-locals', runs: 2, opened: 1 });
  });

  it('treats a blocked run as a GOOD signal (not counted against files), and handles empty', () => {
    expect(buildMaintainStats([R('dead-code', 'blocked')]).filesCleaned).toBe(0);
    const empty = buildMaintainStats([]);
    expect(empty.totalRuns).toBe(0);
    expect(empty.successRate).toBe(0);
    expect(empty.lastRun).toBeUndefined();
  });

  it('suggestNextScopes returns scopes never run', () => {
    const s = buildMaintainStats([R('dead-code', 'opened')]);
    expect(suggestNextScopes(s, ['dead-code', 'unused-imports', 'lint-fix']))
      .toEqual(['unused-imports', 'lint-fix']);
  });
});

describe('recommendNextScope', () => {
  const ALL = ['dead-code', 'unused-imports', 'lint-fix'];
  it('prefers a never-run scope', () => {
    const runs = [R('dead-code', 'opened')];
    expect(recommendNextScope(runs, buildMaintainStats(runs), ALL)).toEqual({ scope: 'unused-imports', why: expect.stringMatching(/never run/) });
  });
  it('when all run, flags a scope that keeps blocking (a backlog)', () => {
    const runs = [R('dead-code', 'opened'), R('unused-imports', 'blocked'), R('unused-imports', 'blocked'), R('lint-fix', 'opened')];
    const rec = recommendNextScope(runs, buildMaintainStats(runs), ALL)!;
    expect(rec.scope).toBe('unused-imports');
    expect(rec.why).toMatch(/blocked 2/);
  });
});

describe('weeklyReport', () => {
  it('buckets opened runs into this-week vs prior-week from timestamps', () => {
    const now = Date.parse('2026-07-01T00:00:00Z');
    const iso = (daysAgo: number) => new Date(now - daysAgo * 86_400_000).toISOString();
    const runs = [
      R('unused-imports', 'opened', 5, '', iso(1)),   // this week
      R('unused-imports', 'opened', 3, '', iso(3)),   // this week
      R('dead-code', 'blocked', 0, '', iso(2)),       // this week
      R('dead-code', 'opened', 2, '', iso(10)),       // prior week
    ];
    const wk = weeklyReport(runs, now);
    expect(wk.opened).toBe(2);
    expect(wk.filesCleaned).toBe(8);
    expect(wk.blocked).toBe(1);
    expect(wk.priorOpened).toBe(1);
    expect(wk.openedDelta).toBe(1);                    // 2 this week vs 1 prior
    expect(wk.minutesSaved).toBe(10);
  });
});

describe('trendByWeek / projectMonthly', () => {
  const now = Date.parse('2026-07-01T00:00:00Z');
  const iso = (d: number) => new Date(now - d * 86_400_000).toISOString();
  const runs = [
    R('unused-imports', 'opened', 1, '', iso(1)),    // week 0 (newest)
    R('unused-imports', 'opened', 1, '', iso(2)),    // week 0
    R('dead-code', 'opened', 1, '', iso(10)),        // ~week 1
    R('dead-code', 'blocked', 0, '', iso(3)),        // not opened — excluded
  ];
  it('buckets opened runs by week, newest at the end', () => {
    const t = trendByWeek(runs, now, 4);
    expect(t).toHaveLength(4);
    expect(t[3]).toBe(2);   // this week
    expect(t[2]).toBe(1);   // last week
    expect(t[0]).toBe(0);   // 3–4 weeks ago
  });
  it('projects the last-28-day opened rate to a monthly figure', () => {
    const p = projectMonthly(runs, now);
    expect(p.cleanupsPerMonth).toBe(3);          // 3 opened within 28d
    expect(p.minutesPerMonth).toBe(15);
  });
});

describe('forecastTrend', () => {
  const now = Date.parse('2026-07-01T00:00:00Z');
  const iso = (weeksAgo: number) => new Date(now - (weeksAgo * 7 + 1) * 86_400_000).toISOString();
  // Build an accelerating series: 1 opened 3 weeks ago, 2 two weeks ago, 3 last week, 4 this week.
  const rising = [
    ...Array.from({ length: 1 }, () => R('dead-code', 'opened', 1, '', iso(3))),
    ...Array.from({ length: 2 }, () => R('dead-code', 'opened', 1, '', iso(2))),
    ...Array.from({ length: 3 }, () => R('dead-code', 'opened', 1, '', iso(1))),
    ...Array.from({ length: 4 }, () => R('dead-code', 'opened', 1, '', iso(0))),
  ];
  it('detects a rising loop and predicts next week from the fitted line', () => {
    const f = forecastTrend(rising, now, 8);
    expect(f.direction).toBe('rising');
    expect(f.slope).toBeGreaterThan(0);
    expect(f.nextWeek).toBeGreaterThanOrEqual(4);   // extrapolated beyond this week's 4
    expect(f.weeks).toBe(8);
  });
  it('a flat/empty history is steady with no false prediction', () => {
    const f = forecastTrend([], now, 8);
    expect(f.direction).toBe('steady');
    expect(f.slope).toBe(0);
    expect(f.nextWeek).toBe(0);
    expect(f.weeklyAvg).toBe(0);
  });
  it('a cooling series (busy early, quiet lately) is reported as falling', () => {
    const cooling = [
      ...Array.from({ length: 5 }, () => R('dead-code', 'opened', 1, '', iso(6))),   // old, high
      ...Array.from({ length: 1 }, () => R('dead-code', 'opened', 1, '', iso(5))),
    ];
    const f = forecastTrend(cooling, now, 8);
    expect(f.direction).toBe('falling');
    expect(f.slope).toBeLessThan(0);
  });
});
