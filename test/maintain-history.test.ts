import { describe, it, expect } from 'vitest';
import { serializeMaintainHistory, deserializeMaintainHistory, mergeRuns, MAINTAIN_HISTORY_VERSION } from '../src/cli/maintain-history.ts';
import type { MaintainRun } from '../src/cli/maintain-stats.ts';

const RUNS: MaintainRun[] = [
  { scope: 'unused-imports', status: 'opened', filesChanged: 2, when: '1h ago', at: '2026-06-30T10:00:00Z' },
  { scope: 'unused-locals', status: 'blocked', filesChanged: 0, when: '2d ago', at: '2026-06-28T10:00:00Z' },
];

describe('maintain history export/import', () => {
  it('round-trips runs through serialize → deserialize', () => {
    const json = serializeMaintainHistory(RUNS, '2026-07-01T00:00:00Z');
    const parsed = JSON.parse(json);
    expect(parsed.kind).toBe('qodex-maintain-history');
    expect(parsed.version).toBe(MAINTAIN_HISTORY_VERSION);
    expect(parsed.count).toBe(2);
    const back = deserializeMaintainHistory(json);
    expect(back.runs).toEqual(RUNS);
    expect(back.exportedAt).toBe('2026-07-01T00:00:00Z');
  });

  it('accepts a bare runs array and tolerates junk/extra fields', () => {
    const back = deserializeMaintainHistory(JSON.stringify([
      { scope: 'dead-code', status: 'opened', filesChanged: 1, at: '2026-06-01T00:00:00Z', extra: 'ignored' },
      { nonsense: true },                       // not run-like → filtered out
    ]));
    expect(back.runs).toHaveLength(1);
    expect(back.runs[0]!.scope).toBe('dead-code');
    expect(back.runs[0]!.when).toBe('');        // normalized default
  });

  it('throws a clear error on non-JSON or a file with no runs', () => {
    expect(() => deserializeMaintainHistory('not json{')).toThrow(/valid JSON/);
    expect(() => deserializeMaintainHistory('{"foo":1}')).toThrow(/no maintain runs/);
  });

  it('mergeRuns dedups identical runs and sorts newest-first', () => {
    const imported = deserializeMaintainHistory(serializeMaintainHistory(RUNS, 'x')).runs;
    const local: MaintainRun[] = [
      { scope: 'unused-imports', status: 'opened', filesChanged: 2, when: '', at: '2026-06-30T10:00:00Z' }, // dup of RUNS[0]
      { scope: 'lint-fix', status: 'opened', filesChanged: 3, when: '', at: '2026-07-01T09:00:00Z' },        // newest, unique
    ];
    const merged = mergeRuns(local, imported);
    expect(merged).toHaveLength(3);                 // 2 imported + 1 unique local (1 dup dropped)
    expect(merged[0]!.scope).toBe('lint-fix');      // newest at the front
    expect(merged.filter(r => r.scope === 'unused-imports')).toHaveLength(1); // dup collapsed
  });
});
