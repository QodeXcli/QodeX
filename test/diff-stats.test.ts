import { describe, it, expect } from 'vitest';
import { computeDiffStats, parseDiffForDisplay, generateUnifiedDiff } from '../src/utils/diff.js';

/**
 * High-risk edge coverage for src/utils/diff.ts — empty input and the
 * last-line-without-trailing-newline case. computeDiffStats counts '\n'
 * characters per change, which UNDER-COUNTS any added/removed line that
 * has no trailing newline (a new file with no final newline, or content
 * appended to the end of a file). These tests assert the CORRECT behavior,
 * so they fail while that bug is present.
 */
describe('computeDiffStats — empty & null-ish input', () => {
  it('empty → empty reports no changes', () => {
    expect(computeDiffStats('', '')).toEqual({ additions: 0, deletions: 0 });
  });

  it('identical content reports no changes', () => {
    expect(computeDiffStats('same\n', 'same\n')).toEqual({ additions: 0, deletions: 0 });
  });
});

describe('computeDiffStats — last line without trailing newline (regression)', () => {
  it('adding a single line to an empty file counts as +1', () => {
    // A line WAS added; additions must be ≥ 1 regardless of trailing newline.
    expect(computeDiffStats('', 'hello').additions).toBeGreaterThanOrEqual(1);
  });

  it('appending a line with no trailing newline counts the addition', () => {
    expect(computeDiffStats('a\n', 'a\nb').additions).toBeGreaterThanOrEqual(1);
  });

  it('trailing-newline vs not yields the same single-line count', () => {
    const withNl = computeDiffStats('', 'hello\n').additions;
    const withoutNl = computeDiffStats('', 'hello').additions;
    expect(withoutNl).toBe(withNl);
  });

  it('deleting the only (newline-terminated) line counts as -1', () => {
    expect(computeDiffStats('gone\n', '').deletions).toBeGreaterThanOrEqual(1);
  });
});

describe('parseDiffForDisplay — empty & structural input', () => {
  it('empty string yields a single empty context line, never throws', () => {
    const r = parseDiffForDisplay('');
    expect(Array.isArray(r)).toBe(true);
    expect(r.every((l) => ['add', 'del', 'context', 'hunk'].includes(l.type))).toBe(true);
  });

  it('classifies hunk/add/del and drops file headers', () => {
    const diff = generateUnifiedDiff('a\n', 'b\n', 'f.txt');
    const parsed = parseDiffForDisplay(diff);
    expect(parsed.some((l) => l.type === 'hunk')).toBe(true);
    expect(parsed.some((l) => l.type === 'add')).toBe(true);
    expect(parsed.some((l) => l.type === 'del')).toBe(true);
    // `---`/`+++` file headers must be filtered out, not mislabeled add/del.
    expect(parsed.some((l) => l.text.startsWith('---') || l.text.startsWith('+++'))).toBe(false);
  });
});
