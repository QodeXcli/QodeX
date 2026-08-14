import { describe, it, expect } from 'vitest';
import {
  occupancy,
  pressureLevel,
  fitBudget,
  nextRelief,
  DEFAULT_COMPACT_AT,
  DEFAULT_FIT_RATIO,
  KEEP_LADDER,
} from '../src/agent/context-pressure.js';

describe('context pressure policy', () => {
  const W = 10_000;

  it('is ok below 80%', () => {
    expect(pressureLevel(7_999, W)).toBe('ok');
    expect(nextRelief({ tokens: 7_999, window: W })).toBeNull();
  });

  it('compacts at exactly 80% — the window does not have to be full', () => {
    expect(DEFAULT_COMPACT_AT).toBe(0.80);
    expect(pressureLevel(8_000, W)).toBe('soft');
    const step = nextRelief({ tokens: 8_000, window: W });
    expect(step).toEqual({
      kind: 'compact',
      keepLastTurns: KEEP_LADDER[0],
      reason: expect.stringMatching(/80%.*compact/i),
    });
  });

  it('escalates keep-last on later compact passes, then prunes — never returns stop', () => {
    const over = 8_500;
    expect(nextRelief({ tokens: over, window: W, compactPass: 0 })?.kind).toBe('compact');
    expect(nextRelief({ tokens: over, window: W, compactPass: 0 })?.keepLastTurns).toBe(6);
    expect(nextRelief({ tokens: over, window: W, compactPass: 1 })?.keepLastTurns).toBe(4);
    expect(nextRelief({ tokens: over, window: W, compactPass: 2 })?.keepLastTurns).toBe(2);
    const last = nextRelief({ tokens: over, window: W, compactPass: 3 });
    expect(last?.kind).toBe('prune');
    expect(last?.maxTokens).toBe(fitBudget(W));
  });

  it('hard band (≥92%) still starts with compact, not an abort', () => {
    expect(DEFAULT_FIT_RATIO).toBe(0.92);
    expect(pressureLevel(9_200, W)).toBe('hard');
    const step = nextRelief({ tokens: 9_200, window: W });
    expect(step?.kind).toBe('compact');
    expect(step?.reason).toMatch(/emergency/i);
  });

  it('with compaction disabled, over-threshold pressure prunes instead of stopping', () => {
    const step = nextRelief({ tokens: 9_000, window: W, compactEnabled: false });
    expect(step).toEqual({
      kind: 'prune',
      maxTokens: fitBudget(W),
      reason: expect.stringMatching(/prune/i),
    });
  });

  it('occupancy is 0 on a bogus window so we never spuriously relieve', () => {
    expect(occupancy(50_000, 0)).toBe(0);
    expect(nextRelief({ tokens: 50_000, window: 0 })).toBeNull();
  });
});
