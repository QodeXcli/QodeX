import { describe, it, expect } from 'vitest';
import { decideIterationPressure, nextIterationCap, EXTEND_CHUNK } from '../src/agent/iteration-pressure.js';
import { BudgetTracker } from '../src/agent/budget.js';

const clean = {
  stuckLoop: false,
  errorLoop: false,
  readAbort: false,
  consecutiveFailures: 0,
};

describe('iteration pressure — cap is a fuse, not a finish line', () => {
  it('is ok before the cap', () => {
    expect(decideIterationPressure(false, clean)).toBe('ok');
  });

  it('extends when the cap is hit but the task is still making progress', () => {
    expect(decideIterationPressure(true, clean)).toBe('extend');
  });

  it('stops only when a runaway detector is already firing', () => {
    expect(decideIterationPressure(true, { ...clean, stuckLoop: true })).toBe('stop');
    expect(decideIterationPressure(true, { ...clean, errorLoop: true })).toBe('stop');
    expect(decideIterationPressure(true, { ...clean, readAbort: true })).toBe('stop');
    expect(decideIterationPressure(true, { ...clean, consecutiveFailures: 4 })).toBe('stop');
    expect(decideIterationPressure(true, { ...clean, consecutiveFailures: 3 })).toBe('extend');
  });

  it('extends the fuse in 50-step chunks', () => {
    expect(nextIterationCap(50)).toBe(50 + EXTEND_CHUNK);
    expect(nextIterationCap(100)).toBe(150);
  });
});

describe('BudgetTracker no longer kills a working task at the iteration cap', () => {
  it('checkpoint does not throw when iterations exceed the cap', () => {
    const b = new BudgetTracker(0, 0, 0, 2);
    b.incrementIteration();
    b.incrementIteration();
    b.incrementIteration();
    expect(b.atIterationCap()).toBe(true);
    expect(() => b.checkpoint()).not.toThrow();
  });

  it('extendIterations raises the fuse so atIterationCap clears', () => {
    const b = new BudgetTracker(0, 0, 0, 2);
    b.incrementIteration();
    b.incrementIteration();
    b.incrementIteration();
    expect(b.atIterationCap()).toBe(true);
    b.extendIterations(nextIterationCap(b.getMaxIterations()));
    expect(b.atIterationCap()).toBe(false);
    expect(b.getMaxIterations()).toBe(52);
  });
});
