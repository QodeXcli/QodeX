import { describe, it, expect } from 'vitest';
import { pickByShortcut } from '../src/cli/prompts/confirmation.js';
import { splitEditorArgv } from '../src/tools/filesystem/edit-approval.js';

const OPTS = ['accept', 'always yes', 'edit', 'continue', 'reject'];

describe('confirmation shortcuts', () => {
  it('y / unique prefix pick accept, not always yes', () => {
    expect(pickByShortcut(OPTS, 'y')).toBe('accept');
    expect(pickByShortcut(OPTS, 'a')).toBe('accept');
  });
  it('! and A pick always yes', () => {
    expect(pickByShortcut(OPTS, '!')).toBe('always yes');
    expect(pickByShortcut(OPTS, 'A')).toBe('always yes');
  });
  it('e / c / r stay unique', () => {
    expect(pickByShortcut(OPTS, 'e')).toBe('edit');
    expect(pickByShortcut(OPTS, 'c')).toBe('continue');
    expect(pickByShortcut(OPTS, 'r')).toBe('reject');
  });
});

describe('splitEditorArgv', () => {
  it('splits flags so code --wait is not a missing binary', () => {
    expect(splitEditorArgv('code --wait')).toEqual(['code', '--wait']);
    expect(splitEditorArgv('vim')).toEqual(['vim']);
    expect(splitEditorArgv(`'/usr/local/bin/code' --wait`)).toEqual(['/usr/local/bin/code', '--wait']);
  });
});
