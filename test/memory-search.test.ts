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

describe('SessionStore.searchConversations + /retry truncate', () => {
  it('finds a past user turn by keyword and scopes to cwd', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'conv-'));
    try {
      const store = new SessionStore(path.join(dir, 's.db'));
      const a = store.createSession('/work/a', 'm');
      const b = store.createSession('/work/b', 'm');
      store.recordTurn(a, [{ role: 'user', content: 'add cursor pagination to orders' }], { input: 1, output: 1, costUsd: 0 });
      store.recordTurn(a, [{ role: 'assistant', content: 'I added offset-based paging' }], { input: 1, output: 1, costUsd: 0 });
      store.recordTurn(b, [{ role: 'user', content: 'unrelated weather question' }], { input: 1, output: 1, costUsd: 0 });
      const hits = store.searchConversations('pagination orders', { cwd: '/work/a', limit: 8 });
      expect(hits.some(h => /pagination/i.test(h.snippet))).toBe(true);
      expect(hits.every(h => h.cwd === '/work/a')).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('truncateAfterLastUser keeps the last question and drops the answer', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'retry-'));
    try {
      const store = new SessionStore(path.join(dir, 's.db'));
      const id = store.createSession('/work/a', 'm');
      store.recordTurn(id, [{ role: 'user', content: 'first' }], { input: 1, output: 0, costUsd: 0 });
      store.recordTurn(id, [{ role: 'assistant', content: 'answer 1' }], { input: 0, output: 1, costUsd: 0 });
      store.recordTurn(id, [{ role: 'user', content: 'try again with tests' }], { input: 1, output: 0, costUsd: 0 });
      store.recordTurn(id, [{ role: 'assistant', content: 'answer 2' }, { role: 'tool', content: 'ok' }], { input: 0, output: 1, costUsd: 0 });
      const last = store.truncateAfterLastUser(id);
      expect(last).toBe('try again with tests');
      const loaded = store.loadSession(id)!;
      expect(loaded.messages.filter(m => m.role === 'assistant')).toHaveLength(1);
      expect(loaded.messages.at(-1)?.content).toBe('try again with tests');
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
