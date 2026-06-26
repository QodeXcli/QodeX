import { describe, it, expect } from 'vitest';
import { splitForStream, type Piece } from '../src/bot/chunk.ts';

const balancedFences = (s: string) => (s.match(/```/g)?.length ?? 0) % 2 === 0;
const totalConsumed = (ps: Piece[]) => ps.reduce((n, p) => n + p.consumed, 0);

describe('splitForStream', () => {
  it('keeps short text in a single piece, consuming all of it', () => {
    const ps = splitForStream('hello world', 100);
    expect(ps).toHaveLength(1);
    expect(ps[0]!.display).toBe('hello world');
    expect(ps[0]!.consumed).toBe('hello world'.length);
  });

  it('Σ consumed === original length (no char lost or duplicated)', () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i} with some words`).join('\n');
    for (const max of [40, 80, 200]) {
      const ps = splitForStream(text, max);
      expect(totalConsumed(ps)).toBe(text.length);
    }
  });

  it('every piece stays within maxLen', () => {
    const text = Array.from({ length: 100 }, (_, i) => `aaaa ${i} bbbb cccc`).join('\n');
    const max = 50;
    for (const p of splitForStream(text, max)) expect(p.display.length).toBeLessThanOrEqual(max);
  });

  it('never leaves a code fence unbalanced across a cut', () => {
    const code = ['intro', '```ts', ...Array.from({ length: 40 }, (_, i) => `const x${i} = ${i};`), '```', 'outro'].join('\n');
    const ps = splitForStream(code, 60);
    expect(ps.length).toBeGreaterThan(1);
    for (const p of ps) expect(balancedFences(p.display)).toBe(true);
  });

  it('re-opens the fence with the SAME language on the next piece', () => {
    const code = ['```python', ...Array.from({ length: 30 }, (_, i) => `x_${i} = ${i}`), '```'].join('\n');
    const ps = splitForStream(code, 50);
    expect(ps.length).toBeGreaterThan(1);
    // pieces after the first (still inside the block) must start by re-opening ```python
    expect(ps[1]!.display.startsWith('```python')).toBe(true);
  });

  it('hard-splits a single line longer than maxLen', () => {
    const long = 'x'.repeat(500);
    const ps = splitForStream(long, 100);
    expect(ps.length).toBeGreaterThan(1);
    expect(totalConsumed(ps)).toBe(500);
    for (const p of ps) expect(p.display.length).toBeLessThanOrEqual(100);
  });

  it('handles empty input', () => {
    expect(splitForStream('', 100)).toEqual([{ display: '', consumed: 0 }]);
  });
});
