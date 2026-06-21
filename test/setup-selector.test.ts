import { describe, it, expect } from 'vitest';
import { initialIndex, moveSelection, choose, displayWidth, physicalRows } from '../src/setup/prompt.js';

describe('setup selector — wrap-aware redraw math (regression for piled-up menu)', () => {
  it('displayWidth ignores ANSI colour/dim escapes', () => {
    expect(displayWidth('hello')).toBe(5);
    expect(displayWidth('\x1b[36m\x1b[1mOpenRouter\x1b[0m')).toBe(10);
    expect(displayWidth('\x1b[2mdim\x1b[0m')).toBe(3);
  });
  it('physicalRows counts terminal wrapping, not logical lines', () => {
    expect(physicalRows('short', 80)).toBe(1);
    expect(physicalRows('', 80)).toBe(1);
    // a 100-char visible line wraps to 2 rows at 80 cols (the bug: it was counted as 1)
    expect(physicalRows('x'.repeat(100), 80)).toBe(2);
    expect(physicalRows('x'.repeat(161), 80)).toBe(3);
  });
  it('physicalRows uses VISIBLE width — colour codes do not inflate the row count', () => {
    const styled = '\x1b[36m\x1b[1m' + 'x'.repeat(40) + '\x1b[0m'; // 40 visible chars
    expect(physicalRows(styled, 80)).toBe(1);
  });
});

describe('setup selector — initialIndex', () => {
  const opts = [{ value: 'a' }, { value: 'b' }, { value: 'c' }];
  it('returns the index of the default value', () => {
    expect(initialIndex(opts, 'b')).toBe(1);
  });
  it('falls back to 0 when the default is not present', () => {
    expect(initialIndex(opts, 'z' as any)).toBe(0);
  });
});

describe('setup selector — moveSelection (arrow-key navigation)', () => {
  it('moves down and wraps', () => {
    expect(moveSelection(0, 'down', 3)).toBe(1);
    expect(moveSelection(2, 'down', 3)).toBe(0);
  });
  it('moves up and wraps', () => {
    expect(moveSelection(0, 'up', 3)).toBe(2);
    expect(moveSelection(1, 'up', 3)).toBe(0);
  });
  it('supports vim-style j/k', () => {
    expect(moveSelection(1, 'j', 3)).toBe(2);
    expect(moveSelection(1, 'k', 3)).toBe(0);
  });
  it('jumps to a 1-9 number when in range, else no-op', () => {
    expect(moveSelection(0, '3', 3)).toBe(2);
    expect(moveSelection(1, '9', 3)).toBe(1); // out of range → unchanged
  });
  it('ignores unrelated keys (enter/escape/letters)', () => {
    expect(moveSelection(1, 'return', 3)).toBe(1);
    expect(moveSelection(1, 'x', 3)).toBe(1);
    expect(moveSelection(1, undefined, 3)).toBe(1);
  });
});

describe('choose — non-interactive returns the default without touching stdin', () => {
  it('resolves to the default value', async () => {
    const v = await choose(
      'pick',
      [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }],
      'y',
      { interactive: false },
    );
    expect(v).toBe('y');
  });
});
