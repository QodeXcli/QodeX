import { describe, it, expect, vi, afterEach } from 'vitest';
import { BudgetTracker } from '../src/agent/budget.ts';

/**
 * The wall-time ceiling is stall-aware: checkpoint() runs right after a completed model
 * call, so a plain ceiling could only ever kill tasks that were actively working (live:
 * "Time budget exceeded: 608s/600s" mid-edit on a local model). These tests pin the fix:
 * over the ceiling + recent progress = keep going; over the ceiling + stalled = stop.
 */
describe('BudgetTracker wall-time', () => {
  afterEach(() => vi.useRealTimers());

  it('does NOT kill an actively-progressing task past the ceiling', () => {
    vi.useFakeTimers();
    const b = new BudgetTracker(0, 0, 600, 0);       // 600s ceiling, no other limits
    vi.advanceTimersByTime(610_000);                  // 610s elapsed…
    b.consume({ tokens: 100 });                       // …but a call JUST completed
    expect(() => b.checkpoint()).not.toThrow();
  });

  it('kills a task past the ceiling once it also stalls (>2min without progress)', () => {
    vi.useFakeTimers();
    const b = new BudgetTracker(0, 0, 600, 0);
    b.consume({ tokens: 100 });
    vi.advanceTimersByTime(610_000);                  // 610s elapsed, no progress since t=0
    expect(() => b.checkpoint()).toThrow(/Time budget exceeded/);
  });

  it('under the ceiling nothing fires regardless of stall', () => {
    vi.useFakeTimers();
    const b = new BudgetTracker(0, 0, 600, 0);
    vi.advanceTimersByTime(500_000);
    expect(() => b.checkpoint()).not.toThrow();
  });

  it('token cap still enforces independently', () => {
    const b = new BudgetTracker(1000, 0, 0, 0);
    b.consume({ tokens: 1500 });
    expect(() => b.checkpoint()).toThrow(/Token budget exceeded/);
  });
});
