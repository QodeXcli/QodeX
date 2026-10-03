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

  it('caps large / 32GB to 32k (was unlimited → 256k KV cache, 30s+ of zeros after a fast load)', () => {
    expect(ollamaNumCtxCeiling({ tier: 'large', ramGb: 32, appleSilicon: true, detectedAt: '' })).toBe(32768);
  });

  it('caps xl / ≥64GB to 64k, not the catalog 256k', () => {
    expect(ollamaNumCtxCeiling({ tier: 'xl', ramGb: 64, appleSilicon: true, detectedAt: '' })).toBe(65536);
  });

  it('unknown hardware still gets a 32k ceiling (no hardware profile ≠ unlimited)', () => {
    expect(ollamaNumCtxCeiling(undefined)).toBe(32768);
  });
});
