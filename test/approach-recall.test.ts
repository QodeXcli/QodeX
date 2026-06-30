import { describe, it, expect } from 'vitest';
import { rankApproaches, formatApproaches, type ApproachSource } from '../src/context/approach-recall.ts';

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
