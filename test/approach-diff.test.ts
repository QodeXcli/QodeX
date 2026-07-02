import { describe, it, expect } from 'vitest';
import { termDiff, lineDiff, commonCore, renderApproachDiffs } from '../src/context/approach-diff.ts';
import type { ApproachMatch } from '../src/context/approach-recall.ts';

const M = (kind: 'episode' | 'worklog' | 'fact', text: string, score: number, files?: string[]): ApproachMatch =>
  ({ kind, text, when: '2d ago', score, files });

describe('termDiff', () => {
  it('splits vocabulary into shared / added / missing, comparing by STEM but showing surface words', () => {
    const d = termDiff('add jwt auth login middleware', 'add auth login with refresh token rotation');
    expect(d.shared).toEqual(expect.arrayContaining(['add', 'auth', 'login']));
    expect(d.added).toEqual(expect.arrayContaining(['refresh', 'token', 'rotation']));
    expect(d.missing).toEqual(expect.arrayContaining(['jwt', 'middleware']));
  });
  it('stem-matches different surface forms (pagination ↔ paginate) as SHARED, not different', () => {
    const d = termDiff('cursor pagination endpoint', 'paginate the endpoint');
    expect(d.shared.map(w => w.slice(0, 6))).toEqual(expect.arrayContaining(['pagina', 'endpoi']));
    expect(d.added).not.toEqual(expect.arrayContaining(['paginate']));
    expect(d.missing).not.toEqual(expect.arrayContaining(['pagination']));
  });
});

describe('lineDiff', () => {
  it('produces a unified-style ± diff via LCS', () => {
    const out = lineDiff('keep\nold line\nend', 'keep\nnew line\nend');
    expect(out).toEqual(['  keep', '- old line', '+ new line', '  end']);
  });
  it('handles pure additions and removals at the tail', () => {
    expect(lineDiff('a', 'a\nb')).toEqual(['  a', '+ b']);
    expect(lineDiff('a\nb', 'a')).toEqual(['  a', '- b']);
  });
});

describe('commonCore', () => {
  it('returns terms whose stem appears in EVERY text', () => {
    const core = commonCore([
      'add jwt auth login route',
      'fix the auth login redirect',
      'refactor auth logins for the admin panel',
    ]);
    expect(core).toEqual(expect.arrayContaining(['auth', 'login']));
    expect(core).not.toContain('jwt');   // only in one text
  });
  it('empty input → empty core', () => {
    expect(commonCore([])).toEqual([]);
  });
});

describe('renderApproachDiffs', () => {
  const matches = [
    M('episode', 'add jwt auth login middleware to the api', 0.82, ['src/auth/jwt.ts', 'src/auth/middleware.ts']),
    M('episode', 'add auth login with refresh token rotation', 0.61, ['src/auth/refresh.ts', 'src/auth/jwt.ts']),
    M('worklog', 'fixed the auth login redirect loop', 0.44),
  ];

  it('shows the best match in full with score + files, then diffs the alternatives against it', () => {
    const out = renderApproachDiffs('how did we do auth login?', matches);
    expect(out).toContain('★ Best match');
    expect(out).toContain('82% match');
    expect(out).toContain('src/auth/jwt.ts');
    expect(out).toContain('DIFFERED');
    expect(out).toMatch(/\+ this one adds:.*(refresh|token|rotation)/);
    expect(out).toMatch(/− it lacks:.*(jwt|middleware)/);
  });

  it('marks files the alternative touched that the best match did not with a +', () => {
    const out = renderApproachDiffs('auth', matches);
    expect(out).toContain('+src/auth/refresh.ts');           // new file flagged
    expect(out).toMatch(/files \(\+ = not in best match\):.*src\/auth\/jwt\.ts/); // shared file unflagged
  });

  it('surfaces the stable core across all attempts', () => {
    const out = renderApproachDiffs('auth', matches);
    expect(out).toMatch(/Stable core across all 3:.*auth/);
    expect(out).toMatch(/Stable core across all 3:.*login/);
  });

  it('uses a line diff when both texts are genuinely multi-line', () => {
    const a = M('worklog', 'step one\nstep two\nstep three', 0.9);
    const b = M('worklog', 'step one\nstep 2 revised\nstep three', 0.7);
    const out = renderApproachDiffs('steps', [a, b]);
    expect(out).toContain('```diff');
    expect(out).toContain('- step two');
    expect(out).toContain('+ step 2 revised');
  });

  it('single match → no diff section; empty → friendly message', () => {
    const out = renderApproachDiffs('auth', [matches[0]!]);
    expect(out).toContain('★ Best match');
    expect(out).not.toContain('DIFFERED');
    expect(renderApproachDiffs('xyz', [])).toMatch(/No past work/);
  });

  it('identical vocabulary → "same approach" note instead of empty ± lines', () => {
    const out = renderApproachDiffs('auth', [
      M('episode', 'add auth login', 0.9),
      M('episode', 'add auth login', 0.8),
    ]);
    expect(out).toContain('≈ same approach, different occasion');
  });
});
