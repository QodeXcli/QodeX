import { describe, it, expect } from 'vitest';
import { suggestUninstalledSkill } from '../src/skills/skill-sources.js';

describe('suggestUninstalledSkill', () => {
  it('suggests a curated skill that matches the prompt', () => {
    expect(suggestUninstalledSkill('add shadcn components', [])?.names[0]).toBe('shadcn');
    // "tailwind" is an alias of the anthropics frontend-design skill (the curated home for Tailwind).
    expect(suggestUninstalledSkill('use tailwind for styling', [])?.names).toContain('tailwind');
    expect(suggestUninstalledSkill('like emil kowalski animations', [])?.names[0]).toBe('emil');
  });

  it('does not suggest a skill that is already installed', () => {
    expect(suggestUninstalledSkill('use tailwind', ['tailwind'])).toBeNull();
  });

  it('returns null when nothing curated matches', () => {
    expect(suggestUninstalledSkill('build a normal react form', [])).toBeNull();
  });

  it('matches on whole words only (no substring noise)', () => {
    // "retailwind" should NOT trigger tailwind
    expect(suggestUninstalledSkill('retailwinding the clock', [])).toBeNull();
  });
});
