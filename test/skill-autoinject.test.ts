import { describe, it, expect } from 'vitest';
import { pickDominantSkill } from '../src/skills/registry.js';

describe('pickDominantSkill', () => {
  it('picks a confident, dominant top match', () => {
    expect(pickDominantSkill([
      { name: 'generative-ui-expert', score: 32 },
      { name: 'ui-ux-pro-max', score: 18 },
    ])).toBe('generative-ui-expert');
  });

  it('injects nothing on an ambiguous near-tie', () => {
    // 13 vs 9 → 13 < 9*1.5 (=13.5) → defer to the model
    expect(pickDominantSkill([
      { name: 'data-collector', score: 13 },
      { name: 'frontend-architect', score: 9 },
    ])).toBeNull();
  });

  it('injects nothing when the top score is too weak', () => {
    expect(pickDominantSkill([{ name: 'taste', score: 3 }])).toBeNull();
  });

  it('picks a strong sole match', () => {
    expect(pickDominantSkill([{ name: 'frontend-architect', score: 12 }])).toBe('frontend-architect');
  });

  it('returns null on no results', () => {
    expect(pickDominantSkill([])).toBeNull();
  });

  it('respects a custom minScore', () => {
    expect(pickDominantSkill([{ name: 'x', score: 5 }], { minScore: 10 })).toBeNull();
    expect(pickDominantSkill([{ name: 'x', score: 12 }], { minScore: 10 })).toBe('x');
  });
});
