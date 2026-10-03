import { describe, it, expect } from 'vitest';
import { extractSymbolHints, codebaseFitScore, fitNote } from '../src/skills/learning/codebase-fit.ts';

describe('skill codebase-fit (Code Graph in the judge)', () => {
  it('extractSymbolHints pulls identifiers from code spans + fenced blocks, drops prose/keywords', () => {
    const md = 'Use `getUserById` and `OrderService`. Run npm test; the const value is fine.\n' +
      '```\nimport { computeTax } from "./tax";\nconst total = computeTax(items);\n```';
    const hints = extractSymbolHints(md);
    expect(hints).toContain('getUserById');   // camelCase
    expect(hints).toContain('OrderService');  // PascalCase
    expect(hints).toContain('computeTax');    // from the fenced block
    expect(hints).not.toContain('npm');       // stopword
    expect(hints).not.toContain('const');     // keyword/stopword
    expect(hints).not.toContain('value');     // plain prose (no case hump / underscore)
  });

  it('codebaseFitScore = matched/total with an injected existence check', () => {
    const exists = (n: string) => ['getUserById', 'OrderService'].includes(n);
    const fit = codebaseFitScore(['getUserById', 'OrderService', 'ghostFn_nope'], exists);
    expect(fit.total).toBe(3);
    expect(fit.matched).toEqual(['getUserById', 'OrderService']);
    expect(fit.score).toBeCloseTo(2 / 3);
    expect(fit.noSignal).toBe(false);
  });

  it('no identifier hints → noSignal, and fitNote stays empty', () => {
    const fit = codebaseFitScore([], () => true);
    expect(fit.noSignal).toBe(true);
    expect(fitNote(fit)).toBe('');
  });

  it('fitNote gives the judge a grounding line', () => {
    const note = fitNote({ score: 0.5, matched: ['a', 'b'], total: 4, noSignal: false });
    expect(note).toContain('2/4');
    expect(note).toContain('50%');
    expect(note).toMatch(/code graph/i);
  });

  it('a throwing existence check is treated as not-found (never crashes judging)', () => {
    const fit = codebaseFitScore(['foo_bar', 'baz_qux'], () => { throw new Error('db gone'); });
    expect(fit.matched).toEqual([]);
    expect(fit.score).toBe(0);
  });
});
