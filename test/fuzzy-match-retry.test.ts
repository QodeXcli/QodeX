import { describe, it, expect } from 'vitest';
import { findMatch, reindentReplacement } from '../src/tools/filesystem/fuzzy-match.js';
import { isTransientError, statusOf } from '../src/utils/retry.js';

describe('findMatch — exact tier', () => {
  it('finds an exact substring', () => {
    const m = findMatch('const x = 1;\nconst y = 2;', 'const y = 2;');
    expect(m?.tier).toBe('exact');
    expect(m?.occurrences).toBe(1);
  });
  it('counts multiple exact occurrences', () => {
    const m = findMatch('foo\nfoo\nbar', 'foo');
    expect(m?.tier).toBe('exact');
    expect(m?.occurrences).toBe(2);
  });
});

describe('findMatch — whitespace tier', () => {
  it('matches despite leading-indentation drift', () => {
    const content = '    if (x) {\n        return 1;\n    }';
    // model used 2-space indent instead of 4
    const search = '  if (x) {\n    return 1;\n  }';
    const m = findMatch(content, search);
    expect(m?.tier).toBe('whitespace');
    // matched region is the real file text (4-space)
    expect(m?.matched).toContain('    if (x) {');
  });
  it('matches across CRLF vs LF', () => {
    const content = 'line one\r\nline two\r\nline three';
    const search = 'line one\nline two';
    const m = findMatch(content, search);
    expect(m?.tier).toBe('whitespace');
  });
  it('reports ambiguity when the trimmed block repeats', () => {
    const content = '  a\n  b\n\n  a\n  b';
    const m = findMatch(content, 'a\nb');
    expect(m?.occurrences).toBeGreaterThan(1);
  });
});

describe('findMatch — fuzzy tier', () => {
  it('matches a block with a small within-line edit', () => {
    const content = [
      'function calculateTotal(items) {',
      '  return items.reduce((a, b) => a + b.price, 0);',
      '}',
    ].join('\n');
    // model slightly misremembered the reducer var names
    const search = [
      'function calculateTotal(items) {',
      '  return items.reduce((acc, item) => acc + item.price, 0);',
      '}',
    ].join('\n');
    const m = findMatch(content, search, { fuzzyThreshold: 0.6, fuzzyMargin: 0.0 });
    expect(m?.tier).toBe('fuzzy');
    expect(m!.score!).toBeGreaterThan(0.6);
  });
  it('refuses to fuzzy-match a single short line', () => {
    const m = findMatch('const a = 1;', 'const b = 2;');
    expect(m).toBeNull();
  });
  it('returns null when nothing is similar enough', () => {
    const content = 'completely unrelated\ncontent here\nnothing alike';
    const search = 'function foo() {\n  return bar;\n}';
    const m = findMatch(content, search);
    expect(m).toBeNull();
  });
});

describe('reindentReplacement', () => {
  it('shifts replacement to match the file indentation', () => {
    const matched = '    return 1;';   // file: 4-space
    const search = '  return 1;';        // model: 2-space
    const replacement = '  return 2;';
    const out = reindentReplacement(matched, search, replacement);
    expect(out).toBe('    return 2;');
  });
  it('leaves replacement unchanged when indents already match', () => {
    const out = reindentReplacement('  x', '  x', '  y');
    expect(out).toBe('  y');
  });
  it('preserves blank lines', () => {
    const matched = '    a';
    const search = '  a';
    const replacement = '  a\n\n  b';
    const out = reindentReplacement(matched, search, replacement);
    expect(out).toBe('    a\n\n    b');
  });
});

describe('retry classifier', () => {
  it('treats 5xx (except 501) as transient', () => {
    expect(isTransientError({ status: 500 })).toBe(true);
    expect(isTransientError({ status: 503 })).toBe(true);
    expect(isTransientError({ status: 501 })).toBe(false);
  });
  it('treats 429 / 408 as transient, 4xx permanent', () => {
    expect(isTransientError({ status: 429 })).toBe(true);
    expect(isTransientError({ status: 408 })).toBe(true);
    expect(isTransientError({ status: 400 })).toBe(false);
    expect(isTransientError({ status: 401 })).toBe(false);
    expect(isTransientError({ status: 404 })).toBe(false);
  });
  it('treats network-level errors as transient', () => {
    expect(isTransientError(new Error('socket hang up'))).toBe(true);
    expect(isTransientError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' })).toBe(true);
    expect(isTransientError(new Error('fetch failed'))).toBe(true);
  });
  it('does NOT retry a user abort', () => {
    expect(isTransientError(new Error('The operation was aborted'))).toBe(false);
  });
  it('statusOf digs the code out of nested SDK error shapes', () => {
    expect(statusOf({ status: 429 })).toBe(429);
    expect(statusOf({ response: { status: 503 } })).toBe(503);
    expect(statusOf({ error: { status: 500 } })).toBe(500);
  });
});
