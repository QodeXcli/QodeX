import { describe, it, expect } from 'vitest';
import { buildUserModel, extractThemes, renderUserModel, favoriteAreas } from '../src/context/user-model.ts';

const eps = (prompts: string[], files: string[][] = []) => prompts.map((prompt, i) => ({ prompt, files: files[i] }));

describe('extractThemes', () => {
  it('surfaces recurring content words, dropping stopwords + one-offs', () => {
    const themes = extractThemes([
      'add cursor pagination to the users endpoint',
      'add pagination to the orders endpoint',
      'configure the database backup',
    ]);
    expect(themes).toContain('pagination'); // recurs
    expect(themes).toContain('endpoint');   // recurs
    expect(themes).not.toContain('the');     // stopword
    expect(themes).not.toContain('database'); // one-off (n<2)
  });
  it('returns [] for empty input', () => {
    expect(extractThemes([])).toEqual([]);
  });
});

describe('favoriteAreas', () => {
  it('ranks the 2-level directories the user touches most', () => {
    expect(favoriteAreas([['src/auth/a.ts', 'src/auth/b.ts'], ['src/auth/c.ts', 'src/ui/x.ts']]))
      .toEqual(['src/auth', 'src/ui']);
    expect(favoriteAreas([])).toEqual([]);
  });
});

describe('buildUserModel', () => {
  it('combines preferences, recent themes, and favorite areas from episode files', () => {
    const m = buildUserModel({
      userFacts: ['!important prefers Persian comments', 'always run tests before saying done'],
      episodes: eps(['add pagination here', 'add pagination there'], [['src/api/p.ts'], ['src/api/q.ts']]),
    });
    expect(m.preferences).toEqual(['prefers Persian comments', 'always run tests before saying done']); // !important/bullet stripped
    expect(m.recentThemes).toContain('pagination');
    expect(m.favoriteAreas).toEqual(['src/api']);
    expect(m.taskCount).toBe(2);
    expect(m.summary).toMatch(/2 stated preferences/);
    expect(m.summary).toMatch(/works mostly in src\/api/);
  });
  it('degrades to a friendly empty summary', () => {
    expect(buildUserModel({ userFacts: [], episodes: [] }).summary).toMatch(/Nothing learned/);
  });
});

describe('renderUserModel', () => {
  it('renders preferences + focus + areas, or a prompt to teach it', () => {
    const r = renderUserModel(buildUserModel({ userFacts: ['likes TS'], episodes: eps(['x', 'x'], [['src/a/x.ts'], ['src/a/y.ts']]) }));
    expect(r).toContain('What QodeX knows about you');
    expect(r).toContain('likes TS');
    expect(r).toContain('Works mostly in: src/a');
    expect(renderUserModel(buildUserModel({ userFacts: [], episodes: [] }))).toMatch(/No stated preferences/);
  });
});
