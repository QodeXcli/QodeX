import { describe, it, expect } from 'vitest';
import { rankApproaches, formatApproaches, stem, type ApproachSource } from '../src/context/approach-recall.ts';

const SOURCES: ApproachSource[] = [
  { kind: 'episode', text: 'add cursor pagination to the users endpoint — limit+cursor', when: '2d ago', files: ['src/users.ts'], detail: 'limit+cursor' },
  { kind: 'worklog', text: 'integrated JWT auth and a login route', when: '5d ago', detail: 'work' },
  { kind: 'episode', text: 'configure nightly postgres backup to S3', when: '9d ago', files: ['scripts/backup.sh'] },
];

describe('rankApproaches', () => {
  it('finds the auth worklog for an auth-shaped query, across both sources', () => {
    const m = rankApproaches('how did we add authentication / jwt login?', SOURCES, { minScore: 0.05 });
    expect(m[0]!.kind).toBe('worklog');
    expect(m[0]!.text).toMatch(/JWT auth/);
  });
  it('searches learned facts too (full history), tagged 🧠', () => {
    const withFact = [...SOURCES, { kind: 'fact' as const, text: 'the deploy key is in .env as DEPLOY_KEY', when: '' }];
    const m = rankApproaches('where is the deploy key?', withFact, { minScore: 0.05 });
    expect(m[0]!.kind).toBe('fact');
    expect(formatApproaches('deploy key', m)).toMatch(/🧠 fact/);
  });

  it('finds the pagination episode (with its files) for a pagination query', () => {
    const m = rankApproaches('add pagination cursor to an endpoint', SOURCES, { topK: 1, minScore: 0.05 });
    expect(m).toHaveLength(1);
    expect(m[0]!.kind).toBe('episode');
    expect(m[0]!.files).toContain('src/users.ts');
  });
  it('an unrelated query returns nothing; empty query returns nothing', () => {
    expect(rankApproaches('upgrade kubernetes ingress', SOURCES, { minScore: 0.2 })).toHaveLength(0);
    expect(rankApproaches('', SOURCES)).toHaveLength(0);
  });

  it('diversity (MMR) spreads distinct approaches instead of near-duplicates filling every slot', () => {
    const sources: ApproachSource[] = [
      { kind: 'episode', text: 'remove unused imports from the auth module', when: 'a' },
      { kind: 'episode', text: 'remove unused imports from the auth module again', when: 'b' },
      { kind: 'episode', text: 'remove unused imports from the auth module once more', when: 'c' },
      { kind: 'episode', text: 'auth module: add a refresh-token rotation flow', when: 'd' },
    ];
    const q = 'work on the auth module';
    // Without diversity: the three near-identical "unused imports" episodes outrank the distinct one.
    const plain = rankApproaches(q, sources, { topK: 2, minScore: 0.05 });
    expect(plain.every(m => /unused imports/.test(m.text))).toBe(true);
    // With diversity: the distinct refresh-token approach is pulled into the top-2.
    const diverse = rankApproaches(q, sources, { topK: 2, minScore: 0.05, diversity: 0.5 });
    expect(diverse[0]!.text).toMatch(/unused imports/);          // top pick unchanged
    expect(diverse.some(m => /refresh-token/.test(m.text))).toBe(true);
  });

  it('semantic stemming matches paginate↔pagination and authenticate↔authentication', () => {
    const sources: ApproachSource[] = [
      { kind: 'episode', text: 'added pagination to the results view', when: 'a' },
      { kind: 'episode', text: 'set up authentication middleware', when: 'b' },
    ];
    // "paginate" (verb) recalls the "pagination" (noun) episode — different surface forms, same root.
    const m1 = rankApproaches('how do I paginate a long list?', sources, { minScore: 0.1, topK: 1 });
    expect(m1[0]!.text).toMatch(/pagination/);
    // "authenticate" recalls the "authentication" episode.
    const m2 = rankApproaches('please authenticate access', sources, { minScore: 0.1, topK: 1 });
    expect(m2[0]!.text).toMatch(/authentication/);
  });

  it('exposes stem() — collapses common suffixes, guards short words', () => {
    expect(stem('pagination')).toBe(stem('paginate'));
    expect(stem('authentication')).toBe(stem('authenticate'));
    expect(stem('backups')).toBe('backup');
    expect(stem('code')).toBe('code');          // ≤4 chars untouched
    expect(stem('categories')).toBe('category');
  });

  it('on near-equal relevance, the more RECENT approach surfaces first', () => {
    const now = Date.parse('2026-07-01T00:00:00Z');
    const iso = (d: number) => new Date(now - d * 86_400_000).toISOString();
    const two = [
      { kind: 'episode' as const, text: 'add login auth flow', when: 'old', at: iso(200) },   // stale
      { kind: 'episode' as const, text: 'add login auth flow', when: 'new', at: iso(2) },      // recent
    ];
    const m = rankApproaches('add login auth flow', two, { topK: 1, minScore: 0.1, nowMs: now });
    expect(m[0]!.when).toBe('new');                 // recency tilt breaks the tie
    expect(m[0]!.score).toBeGreaterThan(0.9);       // displayed score is the honest relevance
  });
});

describe('formatApproaches', () => {
  it('renders tagged matches with files; friendly empty message', () => {
    const block = formatApproaches('pagination', rankApproaches('pagination cursor endpoint', SOURCES, { minScore: 0.05 }));
    expect(block).toContain('How you approached similar work before');
    expect(block).toMatch(/🎯 task|📝/);
    expect(block).toContain('src/users.ts');
    expect(formatApproaches('xyz', [])).toMatch(/No past work/);
  });
});
