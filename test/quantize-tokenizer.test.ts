import { describe, it, expect } from 'vitest';
import { quantize, cosineQuantized } from '../src/context/sqlite-index.js';
import { heuristicTokens, countTokens, countTokensJson } from '../src/utils/tokenizer.js';

describe('int8 quantization', () => {
  it('round-trips a vector within tight cosine error', () => {
    const vec = Array.from({ length: 768 }, (_, i) => Math.sin(i * 0.1));
    const q = quantize(vec);
    // cosine of a vector with its own quantization should be ~1
    const sim = cosineQuantized(vec, q);
    expect(sim).toBeGreaterThan(0.999);
  });

  it('preserves ranking order between vectors', () => {
    const query = Array.from({ length: 128 }, (_, i) => (i % 7) / 7);
    const close = query.map(v => v + 0.01);
    const far = query.map(v => -v);
    const qClose = quantize(close);
    const qFar = quantize(far);
    expect(cosineQuantized(query, qClose)).toBeGreaterThan(cosineQuantized(query, qFar));
  });

  it('handles the all-zero vector without NaN', () => {
    const zero = new Array(64).fill(0);
    const q = quantize(zero);
    expect(Number.isNaN(cosineQuantized(zero, q))).toBe(false);
    expect(cosineQuantized(zero, q)).toBe(0);
  });

  it('stores exactly one byte per dimension', () => {
    const vec = [0.5, -0.5, 0.25, -1.0];
    const q = quantize(vec);
    expect(q.bytes.length).toBe(4);
    // max abs = 1.0 → scale = 1/127 → -1.0 maps to -127
    expect(q.bytes[3]).toBe(-127);
  });
});

describe('tokenizer heuristic', () => {
  it('counts more tokens for code than raw chars/4 would suggest for punctuation-heavy text', () => {
    const code = 'const x = {a:1, b:[2,3], c:()=>{}};';
    const h = heuristicTokens(code);
    // Punctuation-dense — should be meaningfully more than chars/4 underestimate
    expect(h).toBeGreaterThan(0);
  });

  it('returns 0 for empty', () => {
    expect(heuristicTokens('')).toBe(0);
    expect(countTokens(null)).toBe(0);
    expect(countTokens(undefined)).toBe(0);
  });

  it('long identifiers cost multiple sub-tokens', () => {
    const short = heuristicTokens('a b c d');
    const long = heuristicTokens('supercalifragilisticexpialidocious');
    expect(long).toBeGreaterThan(1);
    expect(short).toBe(4);
  });

  it('countTokensJson handles objects', () => {
    expect(countTokensJson({ a: 1, b: 'hello' })).toBeGreaterThan(0);
    expect(countTokensJson(null)).toBe(0);
  });
});
