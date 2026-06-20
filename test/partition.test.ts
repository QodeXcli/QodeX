import { describe, it, expect } from 'vitest';
import { partitionWork, toWorkItems, type WorkItem } from '../src/orchestration/partition.js';

function ids(items: WorkItem[]): string[] {
  return items.map((i) => i.id);
}
/** All item ids across every partition, sorted — for "nothing lost/duplicated" checks. */
function allIds(parts: ReturnType<typeof partitionWork>): string[] {
  return parts.flatMap((p) => ids(p.items)).sort();
}

describe('partitionWork — invariants', () => {
  it('returns [] for an empty list', () => {
    expect(partitionWork([])).toEqual([]);
  });

  it('single item → single partition containing it', () => {
    const parts = partitionWork([{ id: 'a' }]);
    expect(parts).toHaveLength(1);
    expect(ids(parts[0]!.items)).toEqual(['a']);
  });

  it('every item appears exactly once across partitions (no loss, no overlap)', () => {
    const items = Array.from({ length: 23 }, (_, i) => ({ id: `f${i}` }));
    const parts = partitionWork(items, { concurrencyCeiling: 5 });
    expect(allIds(parts)).toEqual(items.map((i) => i.id).sort());
    // no id in two partitions
    const seen = new Set<string>();
    for (const p of parts) for (const it of p.items) {
      expect(seen.has(it.id)).toBe(false);
      seen.add(it.id);
    }
  });

  it('never creates more partitions than units or the ceiling', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ id: `f${i}` }));
    expect(partitionWork(items, { concurrencyCeiling: 4 }).length).toBeLessThanOrEqual(4);
    expect(partitionWork(items.slice(0, 3), { concurrencyCeiling: 16 }).length).toBeLessThanOrEqual(3);
  });

  it('produces no empty partitions', () => {
    const items = Array.from({ length: 7 }, (_, i) => ({ id: `f${i}` }));
    for (const p of partitionWork(items, { concurrencyCeiling: 4 })) {
      expect(p.items.length).toBeGreaterThan(0);
    }
  });
});

describe('partitionWork — balance (LPT)', () => {
  it('balances heavily-skewed weights so the makespan is near-optimal', () => {
    // weights: one 100 + ten 10s = 200 total across 2 partitions → optimal max = 100.
    const items: WorkItem[] = [
      { id: 'big', weight: 100 },
      ...Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, weight: 10 })),
    ];
    const parts = partitionWork(items, { maxPartitions: 2, concurrencyCeiling: 2 });
    expect(parts).toHaveLength(2);
    const max = Math.max(...parts.map((p) => p.totalWeight));
    // LPT: 'big' alone (100) in one bin, ten 10s (100) in the other → perfectly balanced.
    expect(max).toBe(100);
  });

  it('spreads equal-weight items roughly evenly', () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ id: `f${i}` }));
    const parts = partitionWork(items, { maxPartitions: 4, concurrencyCeiling: 4 });
    expect(parts).toHaveLength(4);
    const counts = parts.map((p) => p.items.length);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1); // 12/4 = 3 each
  });
});

describe('partitionWork — coupling', () => {
  it('keeps items sharing a coupledKey in the same partition', () => {
    const items: WorkItem[] = [
      { id: 'git-sandbox.ts', coupledKey: 'merge-change' },
      { id: 'loop.ts', coupledKey: 'merge-change' },
      ...Array.from({ length: 8 }, (_, i) => ({ id: `other${i}` })),
    ];
    const parts = partitionWork(items, { concurrencyCeiling: 5 });
    const withSandbox = parts.find((p) => ids(p.items).includes('git-sandbox.ts'))!;
    expect(ids(withSandbox.items)).toContain('loop.ts');
  });

  it('all-coupled-to-one-key collapses to a single partition', () => {
    const items = Array.from({ length: 6 }, (_, i) => ({ id: `f${i}`, coupledKey: 'all' }));
    const parts = partitionWork(items, { concurrencyCeiling: 8 });
    expect(parts).toHaveLength(1);
    expect(parts[0]!.items).toHaveLength(6);
  });

  it('coupled-unit weight is summed when balancing', () => {
    // A coupled pair of 50+50=100 must not be split, and balances against a lone 100.
    const items: WorkItem[] = [
      { id: 'p1', weight: 50, coupledKey: 'pair' },
      { id: 'p2', weight: 50, coupledKey: 'pair' },
      { id: 'solo', weight: 100 },
    ];
    const parts = partitionWork(items, { maxPartitions: 2, concurrencyCeiling: 2 });
    expect(parts).toHaveLength(2);
    expect(parts.map((p) => p.totalWeight).sort()).toEqual([100, 100]);
  });
});

describe('partitionWork — determinism', () => {
  it('same input → identical partitions every time', () => {
    const items = Array.from({ length: 15 }, (_, i) => ({ id: `f${i}`, weight: (i % 4) + 1 }));
    const a = partitionWork(items, { concurrencyCeiling: 4 });
    const b = partitionWork(items, { concurrencyCeiling: 4 });
    expect(a.map((p) => ids(p.items))).toEqual(b.map((p) => ids(p.items)));
  });
});

describe('partitionWork — option clamps & sanitization', () => {
  it('respects maxPartitions as a hard cap', () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ id: `f${i}` }));
    expect(partitionWork(items, { maxPartitions: 3, concurrencyCeiling: 16 })).toHaveLength(3);
  });

  it('treats non-finite / non-positive weights as 1', () => {
    const items: WorkItem[] = [
      { id: 'a', weight: Number.NaN },
      { id: 'b', weight: -5 },
      { id: 'c', weight: 0 },
      { id: 'd' },
    ];
    const parts = partitionWork(items, { maxPartitions: 1 });
    expect(parts[0]!.totalWeight).toBe(4); // all coerced to 1
  });

  it('derives partition count from targetWeightPerPartition', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ id: `f${i}`, weight: 10 })); // total 100
    const parts = partitionWork(items, { targetWeightPerPartition: 25, concurrencyCeiling: 16 });
    expect(parts.length).toBe(4); // ceil(100/25)
  });
});

describe('toWorkItems', () => {
  it('zips ids with optional weights and groups', () => {
    const w = toWorkItems(['a', 'b', 'c'], [3, undefined as any, 5], ['g1', '', 'g1']);
    expect(w[0]).toMatchObject({ id: 'a', weight: 3, coupledKey: 'g1' });
    expect(w[1]!.coupledKey).toBeUndefined();     // empty string → no coupling
    expect(w[1]!.weight).toBeUndefined();          // missing weight → default later
    expect(w[2]).toMatchObject({ id: 'c', weight: 5, coupledKey: 'g1' });
  });
});
