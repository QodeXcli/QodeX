/**
 * Guardrailed autonomy contract — unit tests for the pure logic in
 * src/agent/autonomy-contract.ts, the Transaction pre-write scope gate, and a REAL
 * smoke of the headless path.
 *
 * The smoke drives the ACTUAL runHeadless() → AgentLoop.run() with the same
 * fake-provider/fake-router pattern as subagent-delegation.test.ts (no LLM, no
 * network). The session store and the transaction-journal singleton are redirected
 * to temp locations via vi.mock, so:
 *   - a file mutated through the REAL journal is REALLY reverted on disk when the
 *     --verify command fails (ROLLED-BACK, exit 1);
 *   - the same run with a passing verify keeps the mutation (GREEN, exit 0).
 * Only the model call itself is fake — everything else (headless orchestration,
 * event plumbing, journal rollback, report, exit codes) is the production path.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import type { StreamEvent, ModelInfo } from '../src/llm/types.js';

// Redirect the session-store singleton to a temp DB (headless records turns).
vi.mock('../src/session/store.js', async (importOriginal) => {
  const mod: any = await importOriginal();
  const os = await import('os');
  const path = await import('path');
  const fs = await import('fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qodex-contract-store-'));
  let store: any = null;
  return {
    ...mod,
    getSessionStore: () => (store ??= new mod.SessionStore(path.join(dir, 'sessions.db'))),
  };
});

// Redirect the transaction-journal singleton to a temp DB + blobs dir, so the smoke
// tests journal/rollback REAL files without touching ~/.qodex/transactions.db.
vi.mock('../src/filesystem/transaction.js', async (importOriginal) => {
  const mod: any = await importOriginal();
  const os = await import('os');
  const path = await import('path');
  const fs = await import('fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qodex-contract-txn-'));
  let journal: any = null;
  return {
    ...mod,
    getJournal: () => (journal ??= new mod.TransactionJournal(path.join(dir, 'txn.db'), path.join(dir, 'blobs'))),
  };
});

// Import AFTER the mocks so every consumer binds the redirected singletons.
const {
  contractFromFlags,
  isPathInScope,
  resolveScopeRoot,
  setWriteScopeRoot,
  getWriteScopeRoot,
  checkWriteScope,
  runVerifyCommand,
  enforceContract,
  buildRunReport,
  exitCodeFor,
} = await import('../src/agent/autonomy-contract.js');
const { getJournal } = await import('../src/filesystem/transaction.js');
const { getSessionStore } = await import('../src/session/store.js');
const { runHeadless } = await import('../src/cli/modes/headless.js');

afterEach(() => setWriteScopeRoot(null)); // module-global — never leak between tests

// ────────────────────────────────────────────────────────────────────────────────
// Flag parsing

describe('contractFromFlags', () => {
  it('returns null when no contract flag is given (plain headless path untouched)', () => {
    expect(contractFromFlags({})).toBeNull();
    expect(contractFromFlags({ budgetTokens: '', scope: '  ' })).toBeNull();
  });

  it('defaults rollback-on-fail ON when --verify is given', () => {
    const c = contractFromFlags({ verify: 'npm test' })!;
    expect(c.verifyCmd).toBe('npm test');
    expect(c.rollbackOnFail).toBe(true);
  });

  it('defaults rollback-on-fail ON when any budget is given', () => {
    expect(contractFromFlags({ budgetTokens: '50000' })!.rollbackOnFail).toBe(true);
    expect(contractFromFlags({ budgetUsd: '0.5' })!.rollbackOnFail).toBe(true);
    expect(contractFromFlags({ maxWall: 120 })!.rollbackOnFail).toBe(true);
  });

  it('scope alone does NOT force rollback-on-fail, explicit flag does', () => {
    expect(contractFromFlags({ scope: 'src/' })!.rollbackOnFail).toBe(false);
    expect(contractFromFlags({ scope: 'src/', rollbackOnFail: true })!.rollbackOnFail).toBe(true);
  });

  it('parses numeric strings and drops garbage/non-positive values', () => {
    const c = contractFromFlags({ budgetTokens: '50000', budgetUsd: 'abc', maxWall: '-5' })!;
    expect(c.budgetTokens).toBe(50_000);
    expect(c.budgetUsd).toBeUndefined();
    expect(c.maxWallSec).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// Scope check

describe('scope check', () => {
  it('is path-boundary aware: /a/b contains /a/b/c but NOT /a/bc', () => {
    expect(isPathInScope('/a/b', '/a/b/c.ts')).toBe(true);
    expect(isPathInScope('/a/b', '/a/b')).toBe(true);
    expect(isPathInScope('/a/b', '/a/bc/evil.ts')).toBe(false);
    expect(isPathInScope('/a/b', '/a/c.ts')).toBe(false);
  });

  it('resolves relative prefixes against cwd and denies out-of-prefix writes', () => {
    const cwd = '/repo';
    setWriteScopeRoot(resolveScopeRoot(cwd, 'src'));
    expect(getWriteScopeRoot()).toBe('/repo/src');
    expect(checkWriteScope('/repo/src/deep/file.ts')).toBeNull();
    expect(checkWriteScope('/repo/test/file.ts')).toMatch(/SCOPE_DENIED/);
    expect(checkWriteScope('/etc/passwd')).toMatch(/SCOPE_DENIED/);
  });

  it('is a no-op when no scope root is registered', () => {
    setWriteScopeRoot(null);
    expect(checkWriteScope('/anywhere/at/all')).toBeNull();
  });

  it('Transaction.write refuses out-of-scope paths BEFORE touching disk', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qodex-scope-gate-'));
    const journal = getJournal();
    setWriteScopeRoot(path.join(dir, 'allowed'));

    const txn = await journal.begin('scope-gate-session');
    const outside = path.join(dir, 'outside.txt');
    await expect(txn.write(outside, 'nope')).rejects.toThrow(/SCOPE_DENIED/);
    expect(fs.existsSync(outside)).toBe(false);

    const inside = path.join(dir, 'allowed', 'in.txt');
    await txn.write(inside, 'yes');
    expect(fs.readFileSync(inside, 'utf-8')).toBe('yes');
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// Verify runner

describe('runVerifyCommand', () => {
  it('captures a failing command with its exit code and output tail', () => {
    const r = runVerifyCommand('echo broken-thing && exit 3', os.tmpdir());
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(3);
    expect(r.outputTail).toContain('broken-thing');
  });

  it('passes on exit 0', () => {
    const r = runVerifyCommand('echo fine', os.tmpdir());
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// Enforcement + verdicts (mock journal, per spec)

function mockJournal(files: string[] = ['/w/a.ts', '/w/b.ts']) {
  return {
    listSessionFiles: vi.fn(() => files),
    rollbackSession: vi.fn(async () => ({ filesRestored: files.length, txnsRolled: 1 })),
  };
}

const usage = { tokens: 12_345, costUsd: 0.0421, wallTimeMs: 34_000, iterations: 5 };

describe('enforceContract', () => {
  it('verify-fail triggers rollback (real false verify cmd + mocked journal)', async () => {
    const journal = mockJournal();
    const outcome = await enforceContract({
      contract: { verifyCmd: 'exit 7', rollbackOnFail: true },
      cwd: os.tmpdir(),
      sessionId: 's1',
      usage,
      budgetExceeded: null,
      agentError: null,
      journal,
    });
    expect(journal.rollbackSession).toHaveBeenCalledWith('s1');
    expect(outcome.verdict).toBe('ROLLED-BACK');
    expect(outcome.verify?.ok).toBe(false);
    expect(outcome.verify?.exitCode).toBe(7);
    expect(exitCodeFor(outcome.verdict)).toBe(1);
  });

  it('budget-exceeded triggers rollback', async () => {
    const journal = mockJournal();
    const outcome = await enforceContract({
      contract: { budgetTokens: 1000, rollbackOnFail: true },
      cwd: os.tmpdir(),
      sessionId: 's2',
      usage,
      budgetExceeded: { type: 'tokens', message: 'Token budget exceeded: 1200/1000' },
      agentError: null,
      journal,
    });
    expect(journal.rollbackSession).toHaveBeenCalledWith('s2');
    expect(outcome.verdict).toBe('ROLLED-BACK');
    expect(outcome.failReasons.join('\n')).toMatch(/budget exceeded \(tokens\)/);
    expect(exitCodeFor(outcome.verdict)).toBe(1);
  });

  it('GREEN when verify passes and no budget blew: keeps changes, exit 0', async () => {
    const journal = mockJournal();
    const outcome = await enforceContract({
      contract: { verifyCmd: 'exit 0', rollbackOnFail: true },
      cwd: os.tmpdir(),
      sessionId: 's3',
      usage,
      budgetExceeded: null,
      agentError: null,
      journal,
    });
    expect(journal.rollbackSession).not.toHaveBeenCalled();
    expect(outcome.verdict).toBe('GREEN');
    expect(exitCodeFor(outcome.verdict)).toBe(0);
  });

  it('FAILED-KEPT when the run fails but rollback is not requested', async () => {
    const journal = mockJournal();
    const outcome = await enforceContract({
      contract: { scopePrefix: 'src', rollbackOnFail: false },
      cwd: os.tmpdir(),
      sessionId: 's4',
      usage,
      budgetExceeded: null,
      agentError: 'stream exploded',
      journal,
    });
    expect(journal.rollbackSession).not.toHaveBeenCalled();
    expect(outcome.verdict).toBe('FAILED-KEPT');
    expect(exitCodeFor(outcome.verdict)).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// Report builder

describe('buildRunReport', () => {
  it('formats a GREEN run', () => {
    const report = buildRunReport({
      verdict: 'GREEN',
      filesChanged: ['/w/a.ts', '/w/b.ts'],
      reverted: false,
      rollback: null,
      verify: { cmd: 'npm test', ok: true, exitCode: 0, outputTail: 'all 42 tests passed' },
      usage,
      failReasons: [],
    });
    expect(report).toContain('RUN REPORT');
    expect(report).toContain('GREEN (changes kept)');
    expect(report).toContain('2 changed');
    expect(report).toContain('/w/a.ts');
    expect(report).toContain('12,345 tokens');
    expect(report).toContain('$0.0421');
    expect(report).toContain('5 iteration(s)');
    expect(report).toContain('PASS (exit 0)');
    expect(report).toContain('all 42 tests passed');
    expect(report).not.toContain('[reverted]');
  });

  it('formats a ROLLED-BACK run with reverted files + verify tail + failures', () => {
    const report = buildRunReport({
      verdict: 'ROLLED-BACK',
      filesChanged: ['/w/a.ts'],
      reverted: true,
      rollback: { filesRestored: 1, txnsRolled: 1 },
      verify: { cmd: 'npm test', ok: false, exitCode: 1, outputTail: '1 test failed: a.test.ts' },
      usage,
      failReasons: ['verify failed (exit 1): npm test'],
    });
    expect(report).toContain('ROLLED-BACK (writes reverted — clean tree)');
    expect(report).toContain('/w/a.ts  [reverted]');
    expect(report).toContain('1 file(s) restored across 1 txn(s)');
    expect(report).toContain('FAIL (exit 1)');
    expect(report).toContain('1 test failed: a.test.ts');
    expect(report).toContain('✗ verify failed (exit 1): npm test');
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// REAL smoke: the actual headless path with a fake provider (no LLM).
// Same fake provider/router pattern as subagent-delegation.test.ts. Resuming a
// pre-seeded session skips buildInitialMessages (which would hit disk/embeddings);
// everything else — runHeadless, AgentLoop.run(), the journal, rollback, the
// report, exit codes — is the real production path.

const MODEL_INFO: ModelInfo = {
  id: 'test-model',
  contextWindow: 128_000,
  maxOutput: 4096,
  inputCostPerMillion: 0,
  outputCostPerMillion: 0,
  supportsToolCalls: true,
  supportsStreaming: true,
};

function fakeProvider(text = 'done') {
  return {
    name: 'ollama',
    isLocal: true,
    async listModels() { return [MODEL_INFO]; },
    async isAvailable() { return true; },
    async *complete(): AsyncGenerator<StreamEvent> {
      yield { type: 'text_delta', delta: text };
      yield { type: 'usage', usage: { input: 10, output: 5 } };
      yield { type: 'done' };
    },
  };
}

function fakeRouter(provider: any) {
  return {
    route: () => ({ provider, model: MODEL_INFO.id, modelInfo: MODEL_INFO, reason: 'test' }),
    resolveModel: () => ({ provider, modelInfo: MODEL_INFO, resolvedId: MODEL_INFO.id }),
    listAvailableModels: () => [{ provider: 'ollama', model: MODEL_INFO.id, info: MODEL_INFO }],
  };
}

function emptyRegistry() {
  return {
    list: () => [],
    getSchemas: () => [],
    isReadOnly: () => true,
  };
}

function baseConfig(): any {
  return {
    defaults: { provider: 'ollama', model: 'test-model', maxIterations: 8 },
    budget: { perTaskLimitUsd: 1, perTaskMaxTokens: 200_000, perTaskMaxWallSeconds: 3600 },
    routing: { planning: 'test-model', toolDecision: 'test-model', reflection: 'test-model', codeGeneration: 'test-model' },
    providers: {},
  };
}

/** Seed a session + a journaled mutation of a real file, returning both. */
async function seedMutatedFile() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'qodex-contract-smoke-'));
  const store = getSessionStore();
  const sessionId = store.createSession(cwd, 'test-model');
  const target = path.join(cwd, 'target.txt');
  fs.writeFileSync(target, 'ORIGINAL');
  const txn = await getJournal().begin(sessionId);
  await txn.write(target, 'MUTATED');
  await txn.commit('smoke mutation');
  expect(fs.readFileSync(target, 'utf-8')).toBe('MUTATED');
  return { cwd, sessionId, target };
}

describe('headless smoke — real runHeadless with a fake provider', () => {
  it('verify-fail: reverts the journaled write, prints ROLLED-BACK, exits 1', async () => {
    const { cwd, sessionId, target } = await seedMutatedFile();
    let printed = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((s: any) => {
      printed += String(s);
      return true;
    }) as any);
    try {
      const code = await runHeadless({
        cwd,
        config: baseConfig(),
        router: fakeRouter(fakeProvider()) as any,
        registry: emptyRegistry() as any,
        permissions: {} as any,
        prompt: 'say hi',
        json: false,
        resumeSessionId: sessionId,
        contract: contractFromFlags({ verify: 'exit 1', scope: '.' })!,
      });
      expect(code).toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(fs.readFileSync(target, 'utf-8')).toBe('ORIGINAL'); // REALLY rolled back
    expect(printed).toContain('RUN REPORT');
    expect(printed).toContain('ROLLED-BACK');
    expect(printed).toContain('target.txt');
    expect(getWriteScopeRoot()).toBeNull(); // scope never leaks past the run
  });

  it('verify-pass: keeps the journaled write, prints GREEN, exits 0', async () => {
    const { cwd, sessionId, target } = await seedMutatedFile();
    let printed = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((s: any) => {
      printed += String(s);
      return true;
    }) as any);
    try {
      const code = await runHeadless({
        cwd,
        config: baseConfig(),
        router: fakeRouter(fakeProvider()) as any,
        registry: emptyRegistry() as any,
        permissions: {} as any,
        prompt: 'say hi',
        json: false,
        resumeSessionId: sessionId,
        contract: contractFromFlags({ verify: 'exit 0' })!,
      });
      expect(code).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(fs.readFileSync(target, 'utf-8')).toBe('MUTATED'); // kept
    expect(printed).toContain('GREEN');
  });
});
