import { describe, it, expect } from 'vitest';
import { buildMaintainStats, suggestNextScopes } from '../src/cli/maintain-stats.ts';

const R = (scope: string, status: string, filesChanged = 0, when = '1h ago') => ({ scope, status, filesChanged, when });

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
