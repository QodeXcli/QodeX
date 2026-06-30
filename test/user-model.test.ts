import { describe, it, expect } from 'vitest';
import { buildUserModel, extractThemes, renderUserModel } from '../src/context/user-model.ts';

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

describe('buildUserModel', () => {
  it('combines stated preferences with recent themes', () => {
    const m = buildUserModel({
      userFacts: ['!important prefers Persian comments', 'always run tests before saying done'],
      episodePrompts: ['add pagination here', 'add pagination there'],
    });
    expect(m.preferences).toEqual(['prefers Persian comments', 'always run tests before saying done']); // !important/bullet stripped
    expect(m.recentThemes).toContain('pagination');
    expect(m.taskCount).toBe(2);
    expect(m.summary).toMatch(/2 stated preferences/);
  });
  it('degrades to a friendly empty summary', () => {
    expect(buildUserModel({ userFacts: [], episodePrompts: [] }).summary).toMatch(/Nothing learned/);
  });
});

describe('renderUserModel', () => {
  it('renders preferences + focus, or a prompt to teach it', () => {
    const r = renderUserModel(buildUserModel({ userFacts: ['likes TS'], episodePrompts: ['x', 'x'] }));
    expect(r).toContain('What QodeX knows about you');
    expect(r).toContain('likes TS');
    expect(renderUserModel(buildUserModel({ userFacts: [], episodePrompts: [] }))).toMatch(/No stated preferences/);
  });
});
