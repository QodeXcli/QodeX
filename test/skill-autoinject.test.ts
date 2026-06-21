import { describe, it, expect } from 'vitest';
import { pickDominantSkill, normalizeFaToken } from '../src/skills/registry.js';

describe('normalizeFaToken (Persian skill-match normalization)', () => {
  it('strips the Ezafe kasra so a word matches its dictionary form', () => {
    expect(normalizeFaToken('کپیِ')).toBe('کپی');       // U+0650 kasra removed
    expect(normalizeFaToken('طراحیِ')).toBe('طراحی');
  });
  it('drops the ZWNJ joiner used in compounds', () => {
    expect(normalizeFaToken('خوش‌سلیقه')).toBe('خوشسلیقه'); // contains "سلیقه" as a substring
    expect(normalizeFaToken('خوش‌سلیقه').includes('سلیقه')).toBe(true);
  });
  it('unifies Arabic letter forms to Persian', () => {
    expect(normalizeFaToken('كپي')).toBe('کپی'); // ك→ک, ي→ی
  });
  it('leaves plain English tokens untouched', () => {
    expect(normalizeFaToken('marketing')).toBe('marketing');
  });
});

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

  // Regression: an obvious NAME/TRIGGER match must not be blocked by a verbose
  // runner-up that only piled up incidental description-word overlaps.
  it('picks a high-signal (name/trigger) match over a noisy runner-up that wins on total', () => {
    // emilkowalski clearly matched on name (strong=10); data-collector only racked up
    // generic word hits (strong=0) yet has a high TOTAL — old logic returned null here.
    expect(pickDominantSkill([
      { name: 'emilkowalski', score: 20, strong: 10 },
      { name: 'data-collector', score: 18, strong: 0 },
    ])).toBe('emilkowalski');
  });

  it('still defers when neither side has a decisive name/trigger signal', () => {
    // Both win only on generic words (strong tie at 3) and totals are a near-tie.
    expect(pickDominantSkill([
      { name: 'data-collector', score: 8, strong: 3 },
      { name: 'enterprise-analyst', score: 7, strong: 3 },
    ])).toBeNull();
  });

  it('a clear total-dominance win still passes without a strong signal', () => {
    expect(pickDominantSkill([
      { name: 'ghost', score: 7, strong: 3 },
      { name: 'data-collector', score: 4, strong: 3 },
    ])).toBe('ghost'); // 7 >= 4*1.5
  });
});
