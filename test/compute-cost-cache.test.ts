import { describe, it, expect } from 'vitest';
import { computeCost } from '../src/llm/router.ts';

// $3 / Mtok input, $15 / Mtok output (Sonnet-like).
const info: any = { inputCostPerMillion: 3, outputCostPerMillion: 15 };

describe('computeCost — cache-aware pricing', () => {
  it('plain call (no cache fields) = old formula', () => {
    expect(computeCost({ input: 1_000_000, output: 1_000_000 }, info)).toBeCloseTo(3 + 15, 6);
  });

  it('prices cache reads at 0.1× and cache writes at 1.25× of input', () => {
    // 100k fresh input + 900k cache-read + 0 output
    const cost = computeCost({ input: 100_000, output: 0, cacheRead: 900_000 }, info);
    // fresh: 0.1M*3 = 0.3 ; read: 0.9M*3*0.1 = 0.27  → 0.57
    expect(cost).toBeCloseTo(0.3 + 0.27, 6);
    const withWrite = computeCost({ input: 100_000, output: 0, cacheCreation: 900_000 }, info);
    // write: 0.9M*3*1.25 = 3.375 ; +fresh 0.3 → 3.675
    expect(withWrite).toBeCloseTo(0.3 + 3.375, 6);
  });

  it('a cached agentic turn costs FAR less than billing the whole prefix fresh', () => {
    // Same 1M-token context, but 950k served from cache instead of fresh.
    const fresh = computeCost({ input: 1_000_000, output: 5_000 }, info);
    const cached = computeCost({ input: 50_000, output: 5_000, cacheRead: 950_000 }, info);
    expect(cached).toBeLessThan(fresh);
    // cached input portion: 50k*3/1e6 + 950k*3*0.1/1e6 = 0.15 + 0.285 = 0.435 vs fresh 3.0
    expect(cached).toBeLessThan(fresh * 0.25); // >75% cheaper on input
  });

  it('treats missing cache fields as zero', () => {
    expect(computeCost({ input: 10, output: 10, cacheRead: undefined, cacheCreation: undefined } as any, info))
      .toBeCloseTo(computeCost({ input: 10, output: 10 }, info), 9);
  });
});
