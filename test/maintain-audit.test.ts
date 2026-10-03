import { describe, it, expect } from 'vitest';
import {
  buildAuditChain, verifyAuditChain, chainHead, buildSignedAuditLog, serializeAuditLog,
  verifyAuditLog, signChainHead, verifyChainSignature, keyIdFor, buildAuditPdfBlocks, AUDIT_GENESIS,
  type AuditableRun,
} from '../src/cli/maintain-audit.ts';
import { buildPdf } from '../src/cli/pdf-lite.ts';

const RUNS: AuditableRun[] = [
  { at: '2026-06-20T00:00:00Z', scope: 'dead-code', status: 'opened', filesChanged: 1, prUrl: 'https://h/pr/1', verification: [{ command: 'npm test', passed: true }] },
  { at: '2026-06-25T00:00:00Z', scope: 'unused-imports', status: 'opened', filesChanged: 2, prUrl: 'https://h/pr/2' },
  { at: '2026-06-28T00:00:00Z', scope: 'unused-locals', status: 'blocked', filesChanged: 0 },
];

describe('maintain audit — tamper-evident chain', () => {
  it('builds a linked chain, oldest first, genesis-anchored', () => {
    const chain = buildAuditChain(RUNS);
    expect(chain).toHaveLength(3);
    expect(chain[0]!.seq).toBe(0);
    expect(chain[0]!.prevHash).toBe(AUDIT_GENESIS);
    expect(chain[1]!.prevHash).toBe(chain[0]!.hash);      // each links to the prior hash
    expect(chain[2]!.prevHash).toBe(chain[1]!.hash);
    expect(verifyAuditChain(chain).valid).toBe(true);
  });

  it('sorts runs chronologically regardless of input order', () => {
    const shuffled = [RUNS[2]!, RUNS[0]!, RUNS[1]!];
    const chain = buildAuditChain(shuffled);
    expect(chain.map(e => e.scope)).toEqual(['dead-code', 'unused-imports', 'unused-locals']);
  });

  it('detects a MODIFIED entry (content hash mismatch)', () => {
    const chain = buildAuditChain(RUNS);
    const tampered = chain.map((e, i) => i === 1 ? { ...e, filesChanged: 999 } : e); // forge files cleaned
    const r = verifyAuditChain(tampered);
    expect(r.valid).toBe(false);
    expect(r.brokenAt).toBe(1);
    expect(r.reason).toMatch(/content hash mismatch/);
  });

  it('detects a DROPPED entry (broken link / seq gap)', () => {
    const chain = buildAuditChain(RUNS);
    const dropped = [chain[0]!, chain[2]!].map((e, i) => ({ ...e, seq: i })); // remove the middle, renumber
    const r = verifyAuditChain(dropped);
    expect(r.valid).toBe(false);
    expect(r.brokenAt).toBe(1);                            // link no longer matches
  });

  it('detects REORDERING', () => {
    const chain = buildAuditChain(RUNS);
    const reordered = [chain[1]!, chain[0]!, chain[2]!];
    expect(verifyAuditChain(reordered).valid).toBe(false);
  });

  it('an empty chain is valid and heads to genesis', () => {
    expect(verifyAuditChain([]).valid).toBe(true);
    expect(chainHead([])).toBe(AUDIT_GENESIS);
  });
});

describe('maintain audit — HMAC signature (authenticity)', () => {
  const KEY = 'super-secret-audit-key';

  it('signs the head and verifies with the right key; rejects a wrong key', () => {
    const head = chainHead(buildAuditChain(RUNS));
    const sig = signChainHead(head, KEY);
    expect(verifyChainSignature(head, sig, KEY)).toBe(true);
    expect(verifyChainSignature(head, sig, 'wrong-key')).toBe(false);
  });

  it('keyId is a stable non-secret label (does not reveal the key)', () => {
    expect(keyIdFor(KEY)).toBe(keyIdFor(KEY));
    expect(keyIdFor(KEY)).not.toContain(KEY);
    expect(keyIdFor(KEY)).toHaveLength(12);
  });

  it('builds a signed log and verifyAuditLog passes end-to-end', () => {
    const log = buildSignedAuditLog(RUNS, { exportedAt: '2026-07-01T00:00:00Z', key: KEY });
    expect(log.algo).toBe('sha256-chain+hmac-sha256');
    expect(log.signature).toBeTruthy();
    const round = JSON.parse(serializeAuditLog(log));    // survives serialize → parse
    const v = verifyAuditLog(round, KEY);
    expect(v.ok).toBe(true);
    expect(v.chainValid).toBe(true);
    expect(v.headMatches).toBe(true);
    expect(v.signatureValid).toBe(true);
  });

  it('verifyAuditLog fails a tampered signed log, and flags a bad signature', () => {
    const log = buildSignedAuditLog(RUNS, { exportedAt: '2026-07-01T00:00:00Z', key: KEY });
    // Tamper with an entry but keep the old head/signature → chain breaks + head mismatch.
    const forged = { ...log, entries: log.entries.map((e, i) => i === 0 ? { ...e, status: 'opened', filesChanged: 42 } : e) };
    const v = verifyAuditLog(forged, KEY);
    expect(v.ok).toBe(false);
    expect(v.chainValid).toBe(false);

    // Right chain, wrong key → signature invalid.
    const v2 = verifyAuditLog(JSON.parse(serializeAuditLog(log)), 'attacker-key');
    expect(v2.signatureValid).toBe(false);
    expect(v2.ok).toBe(false);
  });

  it('an unsigned log still verifies its chain (integrity without authenticity)', () => {
    const log = buildSignedAuditLog(RUNS, { exportedAt: '2026-07-01T00:00:00Z' });
    expect(log.algo).toBe('sha256-chain');
    expect(log.signature).toBeUndefined();
    const v = verifyAuditLog(log);
    expect(v.ok).toBe(true);                               // chain + head OK, no signature required
    expect(v.signaturePresent).toBe(false);
  });
});

describe('maintain audit — auditor PDF one-pager', () => {
  const KEY = 'audit-key';
  const log = buildSignedAuditLog(RUNS, { exportedAt: '2026-07-01T00:00:00Z', key: KEY });

  it('renders verification status + the full run chain into a valid PDF', () => {
    const pdf = buildPdf(buildAuditPdfBlocks(log, verifyAuditLog(log, KEY)));
    expect(pdf.startsWith('%PDF-1.4\n')).toBe(true);
    expect(pdf).toContain('(Maintain Audit Log) Tj');
    expect(pdf).toContain('INTACT');                       // chain status
    expect(pdf).toContain('VALID');                        // signature status
    expect(pdf).toContain('PASS');                         // overall verdict
    expect(pdf).toContain('dead-code');                    // entries present
    expect(pdf).toContain('unused-locals');
    expect(pdf).toContain('[BLOCKED]');                    // blocked run visible
    expect(pdf).toContain('https://h/pr/1');               // PR link carried
    expect(pdf).toContain('v npm test');                   // verification checks (sanitized ✓ → v)
  });

  it('a failed verdict renders FAIL, and unsigned logs say so', () => {
    const forged = { ...log, entries: log.entries.map((e, i) => i === 0 ? { ...e, filesChanged: 42 } : e) };
    const bad = buildPdf(buildAuditPdfBlocks(forged, verifyAuditLog(forged, KEY)));
    expect(bad).toContain('FAIL - do not trust');
    const unsigned = buildSignedAuditLog(RUNS, { exportedAt: 'x' });
    const updf = buildPdf(buildAuditPdfBlocks(unsigned, verifyAuditLog(unsigned)));
    expect(updf).toContain('unsigned');
  });
});
