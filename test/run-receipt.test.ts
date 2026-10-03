import { describe, it, expect } from 'vitest';
import {
  buildReceipt, signReceipt, verifyReceipt, receiptDigest, buildActionChain,
  actionChainHead, formatReceiptVerdict, receiptExitCode, RECEIPT_GENESIS,
  type RunReceipt, type BuildReceiptInput,
} from '../src/agent/run-receipt.js';

const KEY = 'test-audit-key-0123456789';

const base: BuildReceiptInput = {
  runId: 'run-abc123',
  startedAt: '2026-07-31T10:00:00.000Z',
  endedAt: '2026-07-31T10:04:30.000Z',
  cwd: '/repo',
  git: { commit: 'deadbeef', branch: 'main', dirty: false },
  scope: 'src/parser',
  granted: { tokens: 50_000, costUsd: 0.5, wallSec: 600 },
  consumed: { tokens: 41_233, costUsd: 0.37, wallSec: 270, iterations: 12 },
  verify: { command: 'npm test', exitCode: 0, ok: true, outputTail: '42 passing' },
  files: [{ path: 'src/parser/lex.ts', reverted: false }],
  actions: [
    { kind: 'tool', name: 'read_file', detail: 'src/parser/lex.ts', ok: true },
    { kind: 'tool', name: 'edit_text', detail: 'src/parser/lex.ts', ok: true },
    { kind: 'gate', name: 'syntax', detail: 'parsed clean', ok: true },
    { kind: 'verify', name: 'npm test', detail: 'exit 0', ok: true },
  ],
  verdict: 'GREEN',
};

const signed = () => signReceipt(buildReceipt(base), KEY);
/** Deep clone so a mutation in one test can't leak into another. */
const clone = (r: RunReceipt): RunReceipt => JSON.parse(JSON.stringify(r));

describe('buildReceipt — determinism and shape', () => {
  it('is byte-deterministic: identical input yields identical JSON', () => {
    expect(JSON.stringify(buildReceipt(base))).toBe(JSON.stringify(buildReceipt(base)));
  });

  it('reads no clock — the same input built "later" is still identical', async () => {
    const a = buildReceipt(base);
    await new Promise(r => setTimeout(r, 5));
    expect(JSON.stringify(buildReceipt(base))).toBe(JSON.stringify(a));
  });

  it('records the granted-vs-consumed budgets and the verdict', () => {
    const r = buildReceipt(base);
    expect(r.budgets.granted.tokens).toBe(50_000);
    expect(r.budgets.consumed.tokens).toBe(41_233);
    expect(r.verdict).toBe('GREEN');
  });

  it('chains an empty action log to the genesis anchor', () => {
    const r = buildReceipt({ ...base, actions: [] });
    expect(r.actions).toEqual([]);
    expect(r.head).toBe(RECEIPT_GENESIS);
    expect(verifyReceipt(r).chain).toBe('INTACT');
  });

  it('links every action to its predecessor', () => {
    const chain = buildActionChain(base.actions!);
    expect(chain[0]!.prevHash).toBe(RECEIPT_GENESIS);
    for (let i = 1; i < chain.length; i++) expect(chain[i]!.prevHash).toBe(chain[i - 1]!.hash);
    expect(actionChainHead(chain)).toBe(chain[chain.length - 1]!.hash);
  });

  it('captures a ROLLED-BACK run with reverted files', () => {
    const r = buildReceipt({
      ...base, verdict: 'ROLLED-BACK',
      files: [{ path: 'src/parser/lex.ts', reverted: true }],
      failReasons: ['verify failed (exit 1): npm test'],
    });
    expect(r.verdict).toBe('ROLLED-BACK');
    expect(r.files[0]!.reverted).toBe(true);
    expect(r.failReasons).toHaveLength(1);
  });
});

describe('a clean signed receipt verifies', () => {
  it('passes with the right key', () => {
    const v = verifyReceipt(signed(), KEY);
    expect(v.overall).toBe('PASS');
    expect(v.chain).toBe('INTACT');
    expect(v.signature).toBe('valid');
    expect(v.schemaValid).toBe(true);
    expect(receiptExitCode(v)).toBe(0);
  });

  it('fails with the WRONG key', () => {
    const v = verifyReceipt(signed(), 'a-different-key');
    expect(v.signature).toBe('invalid');
    expect(v.overall).toBe('FAIL');
    expect(receiptExitCode(v)).toBe(1);
  });

  it('reports UNSIGNED (never PASS) for an unsigned receipt', () => {
    const v = verifyReceipt(buildReceipt(base), KEY);
    expect(v.signature).toBe('absent');
    expect(v.overall).toBe('UNSIGNED');
    expect(receiptExitCode(v)).toBe(1);
    expect(v.reasons.join(' ')).toMatch(/unsigned/i);
  });

  it('reports no-key (not valid) when a signed receipt is checked without a key', () => {
    const v = verifyReceipt(signed());
    expect(v.signature).toBe('no-key');
    expect(v.overall).toBe('UNSIGNED');
    expect(v.chain).toBe('INTACT'); // the chain is still checkable without a key
  });
});

// The whole point of the artifact: editing ANY material field must be detectable.
describe('field tampering breaks the signature', () => {
  const cases: [string, (r: RunReceipt) => void][] = [
    ['the verdict', r => { r.verdict = 'GREEN'; }],
    ['a consumed budget number', r => { r.budgets.consumed.tokens = 1; }],
    ['a granted budget number', r => { r.budgets.granted.costUsd = 999; }],
    ['a file path', r => { r.files[0]!.path = 'src/evil.ts'; }],
    // The realistic attack on a ROLLED-BACK receipt: hide that the work was reverted.
    ['a file reverted flag', r => { r.files[0]!.reverted = false; }],
    ['the scope', r => { r.scope = '/'; }],
    ['the verify exit code', r => { r.verify!.exitCode = 0; }],
    ['the verify ok flag', r => { r.verify!.ok = true; }],
    ['the cwd', r => { r.cwd = '/somewhere/else'; }],
    ['the git commit', r => { r.git!.commit = 'cafebabe'; }],
    ['the runId', r => { r.runId = 'run-other'; }],
    ['a fail reason', r => { r.failReasons = []; }],
    ['the timestamps', r => { r.endedAt = '2026-01-01T00:00:00.000Z'; }],
  ];

  // Start from a FAILED run so "flip it to look successful" is the realistic attack.
  const failing = () => signReceipt(buildReceipt({
    ...base, verdict: 'ROLLED-BACK',
    verify: { command: 'npm test', exitCode: 1, ok: false, outputTail: '3 failing' },
    files: [{ path: 'src/parser/lex.ts', reverted: true }],
    failReasons: ['verify failed (exit 1): npm test'],
  }), KEY);

  for (const [what, mutate] of cases) {
    it(`detects an edit to ${what}`, () => {
      const r = clone(failing());
      mutate(r);
      const v = verifyReceipt(r, KEY);
      expect(v.signature).toBe('invalid');
      expect(v.overall).toBe('FAIL');
      expect(v.reasons.join(' ')).toMatch(/signature does not match/);
    });
  }

  it('a byte flip in the signature itself does not pass', () => {
    const r = clone(signed());
    r.signature = r.signature!.slice(0, -1) + (r.signature!.endsWith('a') ? 'b' : 'a');
    expect(verifyReceipt(r, KEY).overall).toBe('FAIL');
  });
});

// The chain's job: say WHERE the action log was altered.
describe('action-log tampering breaks the chain at a known index', () => {
  it('detects a MODIFIED action and reports its index', () => {
    const r = clone(signed());
    r.actions[1]!.name = 'write_file';
    const v = verifyReceipt(r, KEY);
    expect(v.chain).toBe('BROKEN');
    expect(v.brokenAt).toBe(1);
    expect(v.chainReason).toMatch(/content hash mismatch/);
    expect(v.overall).toBe('FAIL');
  });

  it('detects a DELETED middle action and reports its index', () => {
    const r = clone(signed());
    r.actions.splice(1, 1);
    const v = verifyReceipt(r, KEY);
    expect(v.chain).toBe('BROKEN');
    expect(v.brokenAt).toBe(1);
    expect(v.overall).toBe('FAIL');
  });

  it('detects an INSERTED action', () => {
    const r = clone(signed());
    r.actions.splice(2, 0, { ...r.actions[1]!, name: 'sneaky' } as any);
    const v = verifyReceipt(r, KEY);
    expect(v.chain).toBe('BROKEN');
    expect(v.overall).toBe('FAIL');
  });

  it('detects REORDERED actions', () => {
    const r = clone(signed());
    [r.actions[0], r.actions[1]] = [r.actions[1]!, r.actions[0]!];
    expect(verifyReceipt(r, KEY).chain).toBe('BROKEN');
  });

  it('detects a rewritten chain whose head no longer matches', () => {
    const r = clone(signed());
    // Re-chain a doctored log properly, so links are self-consistent but head is stale.
    r.actions = buildActionChain([
      { kind: 'tool', name: 'read_file', detail: 'x', ok: true },
    ]);
    const v = verifyReceipt(r, KEY);
    expect(v.chain).toBe('BROKEN');
    expect(v.chainReason).toMatch(/head does not match/);
  });

  it('detects a failed action flipped to ok', () => {
    const r = clone(signReceipt(buildReceipt({
      ...base, verdict: 'FAILED-KEPT',
      actions: [{ kind: 'verify', name: 'npm test', detail: 'exit 1', ok: false }],
    }), KEY));
    r.actions[0]!.ok = true;
    expect(verifyReceipt(r, KEY).chain).toBe('BROKEN');
  });
});

describe('schema validation', () => {
  it('rejects a wrong kind', () => {
    const r = clone(signed()); (r as any).kind = 'something-else';
    const v = verifyReceipt(r, KEY);
    expect(v.schemaValid).toBe(false);
    expect(v.overall).toBe('FAIL');
  });

  it('rejects an unknown verdict', () => {
    const r = clone(signed()); (r as any).verdict = 'TOTALLY-FINE';
    expect(verifyReceipt(r, KEY).schemaValid).toBe(false);
  });

  it('does not throw on garbage input', () => {
    expect(() => verifyReceipt(null as any, KEY)).not.toThrow();
    expect(verifyReceipt({} as any, KEY).overall).toBe('FAIL');
  });
});

describe('receiptDigest', () => {
  it('is stable across rebuilds and changes when content changes', () => {
    const a = buildReceipt(base);
    expect(receiptDigest(a)).toBe(receiptDigest(buildReceipt(base)));
    expect(receiptDigest(buildReceipt({ ...base, verdict: 'FAILED-KEPT' }))).not.toBe(receiptDigest(a));
  });
});

describe('formatReceiptVerdict', () => {
  it('renders a PASS one-screen summary', () => {
    const r = signed();
    const out = formatReceiptVerdict(r, verifyReceipt(r, KEY));
    expect(out).toContain('PASS');
    expect(out).toContain('chain      INTACT');
    expect(out).toContain('signature  valid');
  });

  it('renders the break index and the reasons on failure', () => {
    const r = clone(signed());
    r.actions[1]!.name = 'tampered';
    const out = formatReceiptVerdict(r, verifyReceipt(r, KEY));
    expect(out).toContain('FAIL');
    expect(out).toContain('broken at action 1');
  });
});
