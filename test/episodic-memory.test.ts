import { describe, it, expect } from 'vitest';
import { rankEpisodes, buildEpisodeBlock, type Episode } from '../src/context/episodic-memory.js';

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

describe('buildEpisodeBlock — concise, bounded', () => {
  it('renders matches with prompt + summary + files; empty when none', () => {
    expect(buildEpisodeBlock([])).toBe('');
    const block = buildEpisodeBlock(rankEpisodes('add pagination cursor endpoint', CORPUS, { topK: 1, minScore: 0.1 }));
    expect(block).toContain('# Similar past work');
    expect(block).toContain('cursor');
    expect(block).toContain('src/users.ts');
  });
});
