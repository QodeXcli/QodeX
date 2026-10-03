import { describe, it, expect } from 'vitest';
import { buildRecipePrompt, MAINTAIN_SCOPES, parseMaintainScope } from '../src/schedule/recipes.ts';
import { parseReceipt } from '../src/schedule/receipt.ts';
import {
  buildMaintainStats, weeklyReport, trendByWeek, projectMonthly, recommendNextScope, forecastTrend,
  type MaintainRun,
} from '../src/cli/maintain-stats.ts';
import { buildDashboardHtml, type DashboardData } from '../src/cli/dashboard.ts';
import { serializeMaintainHistory, deserializeMaintainHistory, mergeRuns } from '../src/cli/maintain-history.ts';

/**
 * End-to-end through the self-improvement loop WITHOUT a model: the agent is "told" a recipe
 * prompt, "emits" the receipts that prompt mandates, and we drive the exact same chain the dashboard
 * does (parseReceipt → MaintainRun → analytics → render). Proves the pieces compose.
 */
describe('maintain self-improvement loop (end-to-end)', () => {
  it('every scope prompt carries its selection AND the non-negotiable verified-PR protocol', () => {
    for (const scope of MAINTAIN_SCOPES) {
      const prompt = buildRecipePrompt('maintain', scope);
      // Scope was understood…
      expect(parseMaintainScope(scope).scope).toBe(scope);
      // …the prompt is conservative + unattended…
      expect(prompt).toMatch(/UNATTENDED/);
      expect(prompt).toMatch(/CONSERVATIVE/i);
      // …and the verify-or-block gate + receipt instruction are always present.
      expect(prompt).toMatch(/PROTOCOL — Autonomous Verified PR/);
      expect(prompt).toMatch(/DECISION GATE/);
      expect(prompt).toContain('qodex-receipt');
    }
  });

  it('--dry-run prompt forbids edits and mandates a blocked preview receipt', () => {
    const prompt = buildRecipePrompt('maintain', 'unused-imports --dry-run');
    expect(parseMaintainScope('unused-imports --dry-run').dryRun).toBe(true);
    expect(prompt).toMatch(/DRY RUN/);
    expect(prompt).toMatch(/do NOT open a PR/i);
  });

  // The receipts an agent would emit at end-of-run, one fenced block each (mixed outcomes/scopes).
  const RECEIPT = (o: object) => '\n```qodex-receipt\n' + JSON.stringify(o) + '\n```\n';
  const NOW = Date.parse('2026-07-01T12:00:00Z');
  const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

  it('drives receipts → MaintainRun → analytics → dashboard, coherently', () => {
    const emitted: { scope: string; output: string; at: string }[] = [
      { scope: 'unused-imports', at: daysAgo(1), output: 'VERIFIED-PR: opened https://h/pr/1' + RECEIPT({ status: 'opened', prUrl: 'https://h/pr/1', filesChanged: ['src/a.ts', 'src/b.ts'], verification: [{ command: 'npm test', passed: true }] }) },
      { scope: 'unused-imports', at: daysAgo(2), output: RECEIPT({ status: 'opened', prUrl: 'https://h/pr/2', filesChanged: ['src/c.ts'] }) },
      { scope: 'unused-locals', at: daysAgo(3), output: 'VERIFIED-PR: blocked — side-effect initializer' + RECEIPT({ status: 'blocked', reason: 'side-effect initializer' }) },
      { scope: 'dead-code', at: daysAgo(10), output: RECEIPT({ status: 'opened', prUrl: 'https://h/pr/3', filesChanged: ['src/old.ts'] }) },
    ];

    // Map EXACTLY as the dashboard gather does: receipt.status + receipt.filesChanged.length.
    const runs: MaintainRun[] = emitted.map(e => {
      const rc = parseReceipt(e.output)!;
      expect(rc).not.toBeNull();
      return { scope: e.scope, status: rc.status, filesChanged: rc.filesChanged?.length ?? 0, when: e.at, at: e.at };
    });

    const stats = buildMaintainStats(runs);
    expect(stats.totalRuns).toBe(4);
    expect(stats.opened).toBe(3);
    expect(stats.blocked).toBe(1);
    expect(stats.filesCleaned).toBe(4);                       // 2 + 1 + 0 + 1
    expect(stats.successRate).toBeCloseTo(0.75, 2);
    expect(stats.byScope.find(s => s.scope === 'unused-imports')!.opened).toBe(2);

    const weekly = weeklyReport(runs, NOW);
    expect(weekly.opened).toBe(2);                            // only the two within 7d (dead-code is 10d old)

    const trend = trendByWeek(runs, NOW);
    expect(trend).toHaveLength(8);
    expect(trend[trend.length - 1]).toBe(2);                  // newest week (last) = 2 opened

    const proj = projectMonthly(runs, NOW);
    expect(proj.cleanupsPerMonth).toBeGreaterThan(0);

    // Never-run scopes should be recommended next (unused-params/lint-fix/dep-bump unused here).
    const next = recommendNextScope(runs, stats, MAINTAIN_SCOPES);
    expect(MAINTAIN_SCOPES).toContain(next!.scope);
    expect(['unused-params', 'lint-fix', 'dep-bump']).toContain(next!.scope);

    // The dashboard renders the SAME numbers the loop produced.
    const data: DashboardData = {
      project: 'qodex', model: 'm', generatedAt: 't', providers: [], sessions: [], facts: [], episodes: [],
      skills: [], controls: [], schedules: [], models: [], candidates: [], runs: [], bot: { running: false },
      health: [], logs: [], userModel: { preferences: [], recentThemes: [], favoriteAreas: [], taskCount: 0, summary: '' },
      maintainStats: stats, maintainWeekly: weekly, maintainNext: next, maintainTrend: trend, maintainProjection: proj,
      totals: { sessions: 0, tokens: 0, cost: 0, facts: 0, episodes: 0, skills: 0 },
    };
    const html = buildDashboardHtml(data, { token: 'tok' });
    expect(html).toContain('Maintain status');
    expect(html).toContain('cleanups shipped');
    expect(html).toContain('Suggested next');
    expect(html).toContain(next!.scope);                     // the recommendation is surfaced
    expect(html).toContain("act('maintain.preview'");        // preview button wired
  });

  it('a malformed receipt does not crash the chain (degrades to a still-renderable panel)', () => {
    const rc = parseReceipt('garbage output, no receipt block');
    expect(rc).toBeNull();                                    // nothing to record → simply no run
    const stats = buildMaintainStats([]);
    expect(stats.totalRuns).toBe(0);
  });

  it('the new code-graph scope flows through the whole loop like any other', () => {
    // consolidate-dupes is told the same protocol and its receipt rolls up identically.
    const prompt = buildRecipePrompt('maintain', 'consolidate-dupes');
    expect(prompt).toMatch(/PROTOCOL — Autonomous Verified PR/);
    const rc = parseReceipt(RECEIPT({ status: 'opened', prUrl: 'https://h/pr/9', filesChanged: ['src/a.ts', 'src/b.ts'] }))!;
    const run: MaintainRun = { scope: 'consolidate-dupes', status: rc.status, filesChanged: rc.filesChanged!.length, when: daysAgo(1), at: daysAgo(1) };
    const stats = buildMaintainStats([run]);
    expect(stats.byScope[0]!.scope).toBe('consolidate-dupes');
    expect(stats.filesCleaned).toBe(2);
  });

  it('export → import → merge preserves the analytics (portable history round-trip)', () => {
    const runs: MaintainRun[] = [
      { scope: 'unused-imports', status: 'opened', filesChanged: 2, when: '', at: daysAgo(1) },
      { scope: 'dead-code', status: 'opened', filesChanged: 1, when: '', at: daysAgo(9) },
      { scope: 'unused-locals', status: 'blocked', filesChanged: 0, when: '', at: daysAgo(3) },
    ];
    const before = buildMaintainStats(runs);

    // Serialize on "machine A", read back on "machine B" — stats identical.
    const snapshot = serializeMaintainHistory(runs, new Date(NOW).toISOString());
    const imported = deserializeMaintainHistory(snapshot).runs;
    expect(buildMaintainStats(imported)).toEqual(before);

    // Re-importing the same snapshot alongside local history doesn't double-count.
    const merged = mergeRuns(runs, imported);
    expect(merged).toHaveLength(runs.length);
    expect(buildMaintainStats(merged).opened).toBe(before.opened);

    // And the forecast is computable over the restored history.
    expect(forecastTrend(imported, NOW).weeks).toBe(8);
  });
});
