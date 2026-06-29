import { describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionStore, buildFtsMatch, factTokens } from '../src/session/store.ts';

describe('buildFtsMatch / factTokens (pure)', () => {
  it('tokenizes to alphanumeric words of length ≥ 2, lowercased', () => {
    expect(factTokens('Build the PROD bundle: npm run build:prod')).toEqual(
      ['build', 'the', 'prod', 'bundle', 'npm', 'run', 'build', 'prod']);
    expect(factTokens('a $ # !')).toEqual([]); // nothing searchable
  });

  it('quotes + OR-joins tokens (neutralizes FTS operators), dedupes', () => {
    expect(buildFtsMatch('deploy key')).toBe('"deploy" OR "key"');
    expect(buildFtsMatch('build build')).toBe('"build"');         // deduped
    expect(buildFtsMatch('AND OR NEAR')).toBe('"and" OR "or" OR "near"'); // operators become literals
    expect(buildFtsMatch('   ')).toBe('');
  });
});

describe('SessionStore.searchFacts (FTS5 end-to-end on a temp store)', () => {
  it('finds a specific old fact by relevance, scoped correctly', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-'));
    try {
      const store = new SessionStore(path.join(dir, 's.db'));
      const proj = '/work/app';
      store.addFact('s', proj, 'the prod build is `npm run build:prod`', 'project');
      store.addFact('s', proj, 'auth lives in src/auth and uses JWT', 'project');
      store.addFact('s', proj, 'the staging deploy key is in .env as DEPLOY_KEY', 'project');
      store.addFact('s', '*', 'prefers Persian comments', 'user');

      // relevance search pulls the right project fact out of many
      const deploy = store.searchFacts('deploy key', 'project', proj, 10);
      expect(deploy.some(f => /DEPLOY_KEY/.test(f))).toBe(true);
      expect(deploy.some(f => /JWT/.test(f))).toBe(false);

      // a build query finds the build fact
      expect(store.searchFacts('build prod', 'project', proj, 10).some(f => /build:prod/.test(f))).toBe(true);

      // scope isolation: a project search never returns user facts, and vice-versa
      expect(store.searchFacts('persian', 'project', proj, 10)).toHaveLength(0);
      expect(store.searchFacts('persian comments', 'user', proj, 10).some(f => /Persian/.test(f))).toBe(true);

      // a different cwd shares no project facts
      expect(store.searchFacts('build', 'project', '/work/other', 10)).toHaveLength(0);

      // empty / no-match queries
      expect(store.searchFacts('   ', 'project', proj, 10)).toEqual([]);
      expect(store.searchFacts('kubernetes', 'project', proj, 10)).toHaveLength(0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('reflects deletions (FTS stays in sync via triggers)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-'));
    try {
      const store = new SessionStore(path.join(dir, 's.db'));
      const proj = '/work/x';
      store.addFact('s', proj, 'the secret token is ABC123', 'project');
      expect(store.searchFacts('secret token', 'project', proj, 10)).toHaveLength(1);
      // delete via the same path the forget tool uses
      (store as any).db.prepare(`DELETE FROM session_facts WHERE fact LIKE ?`).run('%ABC123%');
      expect(store.searchFacts('secret token', 'project', proj, 10)).toHaveLength(0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
