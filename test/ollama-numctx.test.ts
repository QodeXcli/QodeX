import { describe, it, expect } from 'vitest';
import { ollamaNumCtxCeiling } from '../src/llm/router.js';

describe('ollamaNumCtxCeiling — right-size the KV cache to the host', () => {
  it('caps small / ≤8GB boxes to 8k (was allocating the full 32k+ window → swap)', () => {
    expect(ollamaNumCtxCeiling({ tier: 'small', ramGb: 8, appleSilicon: false, detectedAt: '' })).toBe(8192);
    expect(ollamaNumCtxCeiling({ tier: 'large', ramGb: 8, appleSilicon: false, detectedAt: '' })).toBe(8192); // RAM wins
  });

  it('caps medium / ≤16GB to 16k', () => {
    expect(ollamaNumCtxCeiling({ tier: 'medium', ramGb: 16, appleSilicon: true, detectedAt: '' })).toBe(16384);
  });

  it('does NOT cap large/xl boxes (use the model full window)', () => {
    expect(ollamaNumCtxCeiling({ tier: 'large', ramGb: 32, appleSilicon: true, detectedAt: '' })).toBeUndefined();
    expect(ollamaNumCtxCeiling({ tier: 'xl', ramGb: 64, appleSilicon: true, detectedAt: '' })).toBeUndefined();
  });

  it('unknown hardware → undefined (no cap, preserves prior behavior)', () => {
    expect(ollamaNumCtxCeiling(undefined)).toBeUndefined();
  });
});
