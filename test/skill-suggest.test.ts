import { describe, it, expect } from 'vitest';
import { suggestSkillFromSession, commonArea, proposeSkillName } from '../src/skills/learning/skill-suggest.ts';

describe('commonArea / proposeSkillName', () => {
  it('finds the dominant 2-level area', () => {
    expect(commonArea(['src/auth/login.ts', 'src/auth/session.ts', 'src/utils/x.ts'])).toBe('src/auth');
    expect(commonArea([])).toBe('');
  });
  it('proposes a slug from the task verb + nouns', () => {
    expect(proposeSkillName('Add cursor pagination to the users endpoint')).toBe('add-cursor-pagination-users');
    expect(proposeSkillName('')).toBe('captured-skill');
  });
});

describe('suggestSkillFromSession — code-graph-shaped judgment', () => {
  it('recommends a focused, cohesive, multi-file change with a clear task verb', () => {
    const s = suggestSkillFromSession({
      prompt: 'add JWT auth with a login route',
      changedFiles: ['src/auth/login.ts', 'src/auth/jwt.ts', 'src/auth/middleware.ts'],
      cohesion: 0.9, touchedSymbols: ['verifyJwt', 'loginRoute'],
    });
    expect(s.worth).toBe(true);
    expect(s.score).toBeGreaterThanOrEqual(0.6);
    expect(s.area).toBe('src/auth');
    expect(s.reason).toMatch(/repeatable pattern/);
    expect(s.reason).toContain('verifyJwt');
  });

  it('declines a sprawling change (low cohesion) even if multi-file', () => {
    const s = suggestSkillFromSession({
      prompt: 'add stuff', changedFiles: Array.from({ length: 20 }, (_, i) => `src/x${i}.ts`), cohesion: 0.2,
    });
    expect(s.worth).toBe(false);
  });

  it('declines a one-file edit and an empty change', () => {
    expect(suggestSkillFromSession({ prompt: 'fix typo', changedFiles: ['a.ts'], cohesion: 1 }).worth).toBe(false);
    expect(suggestSkillFromSession({ prompt: 'add x', changedFiles: [], cohesion: 0 }).worth).toBe(false);
  });

  it('a cohesive multi-file change is worth on its own; multi-file-but-scattered is not', () => {
    // multiFile(0.4)+focused(0.3), no verb → 0.7 ≥ 0.6 → worth
    expect(suggestSkillFromSession({ prompt: 'misc tweaks here', changedFiles: ['src/a/x.ts', 'src/a/y.ts'], cohesion: 0.9 }).worth).toBe(true);
    // multiFile(0.4) only — scattered + no verb → 0.4 < 0.6 → not worth
    expect(suggestSkillFromSession({ prompt: 'misc tweaks here', changedFiles: ['src/a/x.ts', 'src/b/y.ts'], cohesion: 0.3 }).worth).toBe(false);
  });
});
