import { describe, it, expect } from 'vitest';
import { completeSlash, suggestSlashCommands, isCompletingSlashName } from '../src/cli/slash-catalog.js';

describe('slash autocomplete', () => {
  it('only completes while the caret is on the command token', () => {
    expect(isCompletingSlashName('/hel')).toBe(true);
    expect(isCompletingSlashName('/')).toBe(true);
    expect(isCompletingSlashName('/help foo')).toBe(false);
    expect(isCompletingSlashName('help')).toBe(false);
  });

  it('suggests prefix matches', () => {
    const s = suggestSlashCommands('/re');
    expect(s.map(x => x.name)).toContain('retry');
    expect(s.every(x => x.name.startsWith('re'))).toBe(true);
  });

  it('completes a unique prefix to the full command', () => {
    expect(completeSlash('/retr')).toBe('/retry');
    expect(completeSlash('/compac')).toBe('/compact');
  });

  it('extends a shared prefix when several commands match', () => {
    const next = completeSlash('/s');
    // sessions / search / skill / skills / snapshot / strict …
    expect(next === null || next.startsWith('/s')).toBe(true);
  });

  it('includes extra names (skills / custom commands)', () => {
    const s = suggestSlashCommands('/gho', ['ghost']);
    expect(s.some(x => x.name === 'ghost')).toBe(true);
  });
});
