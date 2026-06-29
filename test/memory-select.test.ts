import { describe, it, expect } from 'vitest';
import { selectInjectedFacts, isImportantFact, estimateTokens, resolveMemoryMode } from '../src/context/memory-select.ts';

describe('Light Memory Mode — fact selection', () => {
  it('isImportantFact detects the !important marker (case-insensitive, word-boundary)', () => {
    expect(isImportantFact('!important prod DB is read-only')).toBe(true);
    expect(isImportantFact('note: !IMPORTANT do not deploy fridays')).toBe(true);
    expect(isImportantFact('this is important but not tagged')).toBe(false);
    expect(isImportantFact('!importantish')).toBe(false); // word boundary
  });

  it('estimateTokens ≈ chars/4', () => {
    expect(estimateTokens('a'.repeat(40))).toBe(10);
  });

  it('full mode (default) injects every fact unchanged', () => {
    const facts = ['a', 'b', 'c'];
    expect(selectInjectedFacts(facts)).toEqual(facts);
    expect(selectInjectedFacts(facts, { mode: 'full' })).toEqual(facts);
  });

  it('lightweight: keeps all !important facts + recent others within the token budget', () => {
    const imp = '!important keep me always';
    const f1 = 'x'.repeat(40); // ~10 tokens
    const f2 = 'y'.repeat(40); // ~10 tokens
    const f3 = 'z'.repeat(40); // ~10 tokens
    const facts = [imp, f1, f2, f3]; // newest-first
    const got = selectInjectedFacts(facts, { mode: 'lightweight', injectMaxTokens: 15 });
    expect(got).toContain(imp);     // important always in (doesn't draw budget)
    expect(got).toContain(f1);      // first filler fits (10 ≤ 15)
    expect(got).not.toContain(f2);  // 10+10 > 15 → dropped
    expect(got).not.toContain(f3);
    expect(got).toEqual([imp, f1]); // original (newest-first) order preserved
  });

  it('lightweight: important facts are kept even when far over budget', () => {
    const facts = ['!important ' + 'A'.repeat(400), '!important ' + 'B'.repeat(400)];
    expect(selectInjectedFacts(facts, { mode: 'lightweight', injectMaxTokens: 1 })).toEqual(facts);
  });

  it('resolveMemoryMode: auto follows the context window; full/lightweight are explicit', () => {
    expect(resolveMemoryMode('auto', 16_000)).toBe('lightweight'); // small window → light
    expect(resolveMemoryMode('auto', 200_000)).toBe('full');       // roomy window → full
    expect(resolveMemoryMode('lightweight', 200_000)).toBe('lightweight');
    expect(resolveMemoryMode('full', 8_000)).toBe('full');
    expect(resolveMemoryMode(undefined, 8_000)).toBe('full');      // default is full
    expect(resolveMemoryMode('auto', undefined)).toBe('full');     // unknown window → safe default
  });

  it('HARD BUDGET: the injected non-important facts never exceed the token budget', () => {
    const facts = Array.from({ length: 200 }, (_, i) => `fact #${i}: ` + 'w'.repeat(80)); // ~22 tokens each
    const budget = 300;
    const sel = selectInjectedFacts(facts, { mode: 'lightweight', injectMaxTokens: budget });
    const spent = sel.filter(f => !isImportantFact(f)).reduce((a, f) => a + estimateTokens(f), 0);
    expect(spent).toBeLessThanOrEqual(budget);   // never overshoots — prioritised, not truncated
    expect(sel.length).toBeLessThan(facts.length); // and it actually dropped the overflow
  });

  it('HARD BUDGET: important facts ride ON TOP of the budget without breaking it for the rest', () => {
    const facts = ['!important keep-A', '!important keep-B', ...Array.from({ length: 50 }, (_, i) => `f${i} ` + 'x'.repeat(80))];
    const sel = selectInjectedFacts(facts, { mode: 'lightweight', injectMaxTokens: 100 });
    expect(sel).toContain('!important keep-A');
    expect(sel).toContain('!important keep-B');
    const spentOthers = sel.filter(f => !isImportantFact(f)).reduce((a, f) => a + estimateTokens(f), 0);
    expect(spentOthers).toBeLessThanOrEqual(100);
  });
});
