import { describe, it, expect } from 'vitest';
import { initialIndex, moveSelection, choose } from '../src/setup/prompt.js';

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
