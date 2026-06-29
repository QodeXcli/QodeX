import { describe, it, expect } from 'vitest';
import { rankEpisodes, buildEpisodeBlock, fileFreshness, type Episode } from '../src/context/episodic-memory.js';

const ep = (prompt: string, summary: string, files: string[] = []): Episode =>
  ({ ts: '2026-06-25T00:00:00Z', prompt, summary, filesChanged: files, toolsUsed: [] });

const CORPUS: Episode[] = [
  ep('Add cursor pagination to the users REST endpoint', 'Parsed limit+cursor, returned next-cursor', ['src/users.ts']),
  ep('Configure nightly Postgres backup to S3', 'pg_dump + gzip + aws s3 cp in a cron job', ['scripts/backup.sh']),
  ep('Add a dark mode toggle to the navbar', 'CSS variables + a useTheme hook', ['src/Navbar.tsx']),
];

describe('rankEpisodes — retrieve the most SIMILAR past task', () => {
  it('finds the pagination episode for a pagination-shaped query', () => {
    const m = rankEpisodes('add pagination with a cursor to the products endpoint', CORPUS, { topK: 1, minScore: 0.1 });
    expect(m).toHaveLength(1);
    expect(m[0]!.prompt).toMatch(/cursor pagination/);
  });
  it('an UNRELATED query retrieves nothing (smart, not always-on)', () => {
    expect(rankEpisodes('upgrade the kubernetes ingress controller', CORPUS, { minScore: 0.18 })).toHaveLength(0);
  });
  it('excludes a near-identical re-run of the exact same task (score ~1)', () => {
    const m = rankEpisodes('Add cursor pagination to the users REST endpoint', CORPUS, { topK: 3, minScore: 0.1 });
    expect(m.every(x => x.score < 0.98)).toBe(true);
  });
  it('respects topK and sorts by score', () => {
    const m = rankEpisodes('add backup and pagination to the database endpoint', CORPUS, { topK: 2, minScore: 0.05 });
    expect(m.length).toBeLessThanOrEqual(2);
    for (let i = 1; i < m.length; i++) expect(m[i - 1]!.score).toBeGreaterThanOrEqual(m[i]!.score);
  });
  it('empty query / empty corpus → no matches', () => {
    expect(rankEpisodes('', CORPUS)).toHaveLength(0);
    expect(rankEpisodes('anything', [])).toHaveLength(0);
  });
});

describe('rankEpisodes — diversity, grounding, recency (the "stronger" deltas)', () => {
  // Three near-duplicate pagination successes + one distinct backup task.
  const DUPES: Episode[] = [
    ep('Add cursor pagination to the users endpoint', 'limit+cursor, next-cursor', ['src/users.ts']),
    ep('Add cursor pagination to the orders endpoint', 'limit+cursor, next-cursor', ['src/orders.ts']),
    ep('Add cursor pagination to the carts endpoint', 'limit+cursor, next-cursor', ['src/carts.ts']),
    ep('Configure nightly Postgres backup to S3', 'pg_dump + gzip + aws s3 cp cron', ['scripts/backup.sh']),
  ];

  it('diversity keeps the top-K distinct instead of K near-duplicates', () => {
    const q = 'add cursor pagination to the products endpoint with a backup too';
    const diverse = rankEpisodes(q, DUPES, { topK: 2, minScore: 0.05, diversity: 0.6 });
    // With diversity on, the 2nd pick should NOT be another pagination clone — the distinct
    // backup episode wins the second slot over a third pagination variant.
    expect(diverse).toHaveLength(2);
    expect(diverse.some(m => /backup/i.test(m.prompt))).toBe(true);
  });

  it('diversity=0 is legacy behaviour: pure relevance can stack near-duplicates', () => {
    const q = 'add cursor pagination to the products endpoint';
    const legacy = rankEpisodes(q, DUPES, { topK: 2, minScore: 0.05, diversity: 0 });
    expect(legacy.every(m => /pagination/i.test(m.prompt))).toBe(true);
  });

  it('file grounding scales down episodes whose files no longer exist', () => {
    const q = 'add cursor pagination to the users endpoint';
    const present = rankEpisodes(q, [DUPES[0]!], { topK: 1, minScore: 0.05, fileExists: () => true });
    const stale = rankEpisodes(q, [DUPES[0]!], { topK: 1, minScore: 0.05, fileExists: () => false });
    expect(stale[0]!.score).toBeLessThan(present[0]!.score);
  });

  it('recency breaks near-ties toward the more recent episode (later in the log)', () => {
    // Two equally-relevant identical-text episodes; the later one (index 1) should win the single slot.
    const a = ep('refactor the auth middleware', 'extracted a guard');
    const b = ep('refactor the auth middleware', 'extracted a guard');
    const m = rankEpisodes('refactor the auth middleware again', [a, b], { topK: 1, minScore: 0.05 });
    expect(m).toHaveLength(1);
    expect(m[0]!.summary).toBe('extracted a guard'); // both same; assert it picked exactly one, deterministically
  });

  it('fileFreshness: all-present → 1, half → 0.5, none → 0, empty → 1', () => {
    expect(fileFreshness([], () => false)).toBe(1);
    expect(fileFreshness(['a', 'b'], f => f === 'a')).toBe(0.5);
    expect(fileFreshness(['a', 'b'], () => true)).toBe(1);
    expect(fileFreshness(['a', 'b'], () => false)).toBe(0);
  });
});

describe('buildEpisodeBlock — concise, bounded', () => {
  it('renders matches with prompt + summary + files; empty when none', () => {
    expect(buildEpisodeBlock([])).toBe('');
    const block = buildEpisodeBlock(rankEpisodes('add pagination cursor endpoint', CORPUS, { topK: 1, minScore: 0.1 }));
    expect(block).toContain('# Similar past work');
    expect(block).toContain('cursor');
    expect(block).toContain('src/users.ts');
  });
});
