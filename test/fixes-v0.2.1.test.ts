import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import { promises as fs } from 'fs';
import { SessionStore } from '../src/session/store.js';
import { redactValue, redactObject } from '../src/utils/redact.js';
import { expandEnvString, expandEnvObject } from '../src/utils/env-expand.js';

describe('SessionStore turn_count accounting (Fix A)', () => {
  async function makeStore(): Promise<SessionStore> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qodex-session-test-'));
    return new SessionStore(path.join(tmpDir, 'sessions.db'));
  }

  it('only bumps turn_count when a batch contains a user message', async () => {
    const store = await makeStore();
    const sid = store.createSession('/tmp', 'qwen2.5-coder:32b');

    // Simulate one logical turn: user → assistant → tools → assistant
    store.recordTurn(sid, [{ role: 'user', content: 'do X' }], { input: 0, output: 0, costUsd: 0 });
    store.recordTurn(sid, [{ role: 'assistant', content: 'sure' }], { input: 100, output: 50, costUsd: 0.001 });
    store.recordTurn(sid, [{ role: 'tool', tool_call_id: 'c1', content: 'result' }], { input: 0, output: 0, costUsd: 0 });
    store.recordTurn(sid, [{ role: 'assistant', content: 'done' }], { input: 200, output: 100, costUsd: 0.002 });

    const loaded = store.loadSession(sid)!;
    // Only ONE user message → turn_count should be 1, NOT 4
    expect(loaded.meta.turn_count).toBe(1);
    // But token totals should sum correctly across all the recordTurn calls
    expect(loaded.meta.total_input_tokens).toBe(300);
    expect(loaded.meta.total_output_tokens).toBe(150);
  });

  it('bumps turn_count per user message across multiple turns', async () => {
    const store = await makeStore();
    const sid = store.createSession('/tmp', 'qwen2.5-coder:32b');

    for (let i = 0; i < 5; i++) {
      store.recordTurn(sid, [{ role: 'user', content: `turn ${i}` }], { input: 0, output: 0, costUsd: 0 });
      store.recordTurn(sid, [{ role: 'assistant', content: 'ok' }], { input: 10, output: 5, costUsd: 0 });
    }

    const loaded = store.loadSession(sid)!;
    expect(loaded.meta.turn_count).toBe(5);
  });

  it('messages from the same logical turn share the same turn_number', async () => {
    const store = await makeStore();
    const sid = store.createSession('/tmp', 'q');

    store.recordTurn(sid, [{ role: 'user', content: 'do X' }], { input: 0, output: 0, costUsd: 0 });
    store.recordTurn(sid, [{ role: 'assistant', content: 'thinking' }], { input: 0, output: 0, costUsd: 0 });
    store.recordTurn(sid, [{ role: 'tool', tool_call_id: 'c1', content: 'r' }], { input: 0, output: 0, costUsd: 0 });

    const loaded = store.loadSession(sid)!;
    // All 3 messages should appear in order, all under turn 1
    expect(loaded.messages).toHaveLength(3);
  });
});

describe('SessionStore memory scopes (project vs user)', () => {
  async function makeStore(): Promise<SessionStore> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qodex-memscope-test-'));
    return new SessionStore(path.join(tmpDir, 'sessions.db'));
  }

  it('project facts are scoped to their cwd; user facts surface everywhere', async () => {
    const store = await makeStore();
    const sid = store.createSession('/proj/a', 'm');

    store.addFact(sid, '/proj/a', 'A uses Vite', 'project');
    store.addFact(sid, '/proj/b', 'B uses webpack', 'project');
    store.addFact(sid, '/proj/a', 'prefers Persian comments', 'user'); // cwd ignored for user scope

    // In /proj/a: project fact for A + the user fact, but NOT B's project fact.
    const inA = store.getFactsForCwd('/proj/a');
    expect(inA).toContain('A uses Vite');
    expect(inA).toContain('prefers Persian comments');
    expect(inA).not.toContain('B uses webpack');

    // In an unrelated dir: only the global user fact shows.
    const inC = store.getFactsForCwd('/proj/c');
    expect(inC).toEqual(['prefers Persian comments']);
  });

  it('getFactsByScope separates the two scopes', async () => {
    const store = await makeStore();
    const sid = store.createSession('/proj/a', 'm');
    store.addFact(sid, '/proj/a', 'build = npm run build', 'project');
    store.addFact(sid, '/proj/a', 'always run tests before done', 'user');

    expect(store.getFactsByScope('project', '/proj/a')).toEqual(['build = npm run build']);
    expect(store.getFactsByScope('user', '/proj/a')).toEqual(['always run tests before done']);
    // user facts are independent of cwd
    expect(store.getFactsByScope('user', '/somewhere/else')).toEqual(['always run tests before done']);
  });

  it('defaults to project scope when omitted (back-compat)', async () => {
    const store = await makeStore();
    const sid = store.createSession('/proj/a', 'm');
    store.addFact(sid, '/proj/a', 'legacy fact'); // no scope arg
    expect(store.getFactsByScope('project', '/proj/a')).toContain('legacy fact');
    expect(store.getFactsByScope('user', '/proj/a')).toEqual([]);
  });
});

describe('Secret redaction (Fix E)', () => {
  it('redacts common sensitive key names', () => {
    expect(redactValue('api_key', 'sk-abc123xyz789def')).toMatch(/^sk\*\*\*\[redacted/);
    expect(redactValue('token', 'gh_token_secret_value')).toMatch(/^gh\*\*\*\[redacted/);
    expect(redactValue('password', 'hunter2hunter2')).toMatch(/^hu\*\*\*/);
    expect(redactValue('Authorization', 'Bearer xyz')).toMatch(/^Be\*\*\*/);
  });

  it('leaves non-sensitive keys alone', () => {
    expect(redactValue('path', '/tmp/foo')).toBe('/tmp/foo');
    expect(redactValue('command', 'ls -la')).toBe('ls -la');
    expect(redactValue('content', 'function foo() {}')).toBe('function foo() {}');
  });

  it('recursively redacts nested objects', () => {
    const out = redactObject({
      path: '/tmp/x',
      headers: { authorization: 'Bearer s3cr3t', accept: 'json' },
    });
    expect((out.path as string)).toBe('/tmp/x');
    const headers = out.headers as Record<string, unknown>;
    expect(headers.authorization).toMatch(/^Be\*\*\*/);
    expect(headers.accept).toBe('json');
  });

  it('handles short values gracefully', () => {
    expect(redactValue('api_key', '')).toBe('[redacted]');
    expect(redactValue('token', 'x')).toMatch(/^x\*\*\*/);
  });
});

describe('MCP env expansion (Fix D — tests the REAL exported function, not an inline copy)', () => {
  // NB: Previously this block had an inline regex copy of the logic. That meant the test
  // could PASS while the production code regressed (and did, between v0.3.0 and v0.3.1).
  // We now import the actual function used at runtime so regressions can't sneak through.

  it('expands a bare $VAR', () => {
    process.env.TEST_QODEX_VAR = 'hello';
    expect(expandEnvString('$TEST_QODEX_VAR')).toBe('hello');
  });

  it('CRITICAL: expands $VAR within a larger string (the bug that breaks MCP auth headers)', () => {
    process.env.TEST_QODEX_TOKEN = 'abc123';
    expect(expandEnvString('Bearer $TEST_QODEX_TOKEN')).toBe('Bearer abc123');
  });

  it('expands ${VAR} with braces', () => {
    process.env.TEST_QODEX_PREFIX = 'xyz';
    expect(expandEnvString('prefix_${TEST_QODEX_PREFIX}_suffix')).toBe('prefix_xyz_suffix');
  });

  it('preserves literal $$ as a single $', () => {
    expect(expandEnvString('cost $$5')).toBe('cost $5');
  });

  it('returns empty string for unset variables', () => {
    expect(expandEnvString('$DEFINITELY_NOT_SET_QODEX_VAR_123')).toBe('');
  });

  it('expandEnvObject applies to every value in a map', () => {
    process.env.TEST_X = 'X-val';
    process.env.TEST_Y = 'Y-val';
    const out = expandEnvObject({ a: '$TEST_X', b: 'Bearer $TEST_Y', c: 'literal' });
    expect(out).toEqual({ a: 'X-val', b: 'Bearer Y-val', c: 'literal' });
  });
});
