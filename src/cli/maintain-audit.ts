/**
 * Signed maintain audit log — proof-carrying autonomy you can hand to an auditor.
 *
 * Every maintain run already emits a trust receipt (what ran, which checks passed, the PR). This
 * turns the sequence of receipts into a TAMPER-EVIDENT hash chain: each entry commits to the one
 * before it (like a mini transparency log), so altering, reordering, inserting, or deleting any
 * past entry breaks every downstream hash — detectable offline with no secret at all.
 *
 * On top of the chain sits an OPTIONAL HMAC signature over the chain head, for AUTHENTICITY (proof
 * it was exported by a holder of the audit key). The key is read from the environment
 * (QODEX_AUDIT_KEY) and NEVER stored — consistent with the "secrets live in env, not config" rule.
 *
 * All core functions are PURE (deterministic hashing, no I/O, no clock) so the chain build +
 * verification + signature are fully unit-tested.
 */
import { createHash, createHmac, timingSafeEqual } from 'crypto';

export const MAINTAIN_AUDIT_VERSION = 1;
/** Fixed anchor so an empty chain still has a well-defined predecessor (a "genesis" prevHash). */
export const AUDIT_GENESIS = 'qodex-maintain-audit-genesis-v1';

export interface AuditableRun {
  at: string;                 // ISO timestamp of the run
  scope: string;
  status: string;             // opened | blocked | done | failed
  filesChanged: number;
  prUrl?: string;
  verification?: { command: string; passed: boolean }[];
}

export interface AuditEntry {
  seq: number;                // 0-based position in the chain
  at: string;
  scope: string;
  status: string;
  filesChanged: number;
  prUrl: string;              // '' when none
  verification: { command: string; passed: boolean }[];
  prevHash: string;           // hash of the previous entry (AUDIT_GENESIS for seq 0)
  hash: string;               // sha256 over this entry's canonical content + prevHash
}

export interface SignedAuditLog {
  kind: 'qodex-maintain-audit';
  version: number;
  exportedAt: string;
  count: number;
  head: string;               // hash of the last entry (or AUDIT_GENESIS if empty) — signs to this
  entries: AuditEntry[];
  algo: 'sha256-chain' | 'sha256-chain+hmac-sha256';
  keyId?: string;             // non-secret label of the signing key (e.g. its own hash prefix)
  signature?: string;         // hex HMAC-SHA256 over `head` when signed
}

/** Canonical, order-stable content string an entry commits to. PURE. */
function entryContent(e: Omit<AuditEntry, 'hash'>): string {
  return JSON.stringify([e.seq, e.at, e.scope, e.status, e.filesChanged, e.prUrl, e.verification, e.prevHash]);
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Build a tamper-evident chain from runs (chronological, oldest first). PURE. */
export function buildAuditChain(runs: AuditableRun[]): AuditEntry[] {
  const ordered = [...runs].sort((a, b) => Date.parse(a.at || '') - Date.parse(b.at || '') || 0);
  const entries: AuditEntry[] = [];
  let prevHash = AUDIT_GENESIS;
  ordered.forEach((r, seq) => {
    const base = {
      seq, at: r.at || '', scope: r.scope, status: r.status,
      filesChanged: Number.isFinite(r.filesChanged) ? r.filesChanged : 0,
      prUrl: r.prUrl || '',
      verification: (r.verification ?? []).map(v => ({ command: String(v.command), passed: !!v.passed })),
      prevHash,
    };
    const hash = sha256(entryContent(base));
    entries.push({ ...base, hash });
    prevHash = hash;
  });
  return entries;
}

/** The chain head — what a signature commits to. PURE. */
export function chainHead(entries: AuditEntry[]): string {
  return entries.length ? entries[entries.length - 1]!.hash : AUDIT_GENESIS;
}

/**
 * Recompute every hash + link and report the first broken index. PURE. `valid` means the chain is
 * internally consistent — no entry was altered, reordered, inserted, or dropped.
 */
export function verifyAuditChain(entries: AuditEntry[]): { valid: boolean; brokenAt?: number; reason?: string } {
  let prevHash = AUDIT_GENESIS;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.seq !== i) return { valid: false, brokenAt: i, reason: `seq ${e.seq} ≠ position ${i}` };
    if (e.prevHash !== prevHash) return { valid: false, brokenAt: i, reason: 'prevHash does not link to the previous entry' };
    const { hash, ...base } = e;
    if (sha256(entryContent(base)) !== hash) return { valid: false, brokenAt: i, reason: 'content hash mismatch (entry was modified)' };
    prevHash = hash;
  }
  return { valid: true };
}

/** A non-secret label for a key: a short hash prefix, so an exported log says WHICH key signed it. PURE. */
export function keyIdFor(key: string): string {
  return sha256('qodex-audit-key:' + key).slice(0, 12);
}

/** HMAC-SHA256 over the chain head. PURE (deterministic). */
export function signChainHead(head: string, key: string): string {
  return createHmac('sha256', key).update(head).digest('hex');
}

/** Timing-safe verification of a head signature. PURE. */
export function verifyChainSignature(head: string, signature: string, key: string): boolean {
  const expected = signChainHead(head, key);
  if (expected.length !== signature.length) return false;
  try { return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex')); }
  catch { return false; }
}

/** Assemble the exportable log, signing the head when a key is provided. PURE (pass `exportedAt`). */
export function buildSignedAuditLog(runs: AuditableRun[], opts: { exportedAt: string; key?: string }): SignedAuditLog {
  const entries = buildAuditChain(runs);
  const head = chainHead(entries);
  const base: SignedAuditLog = {
    kind: 'qodex-maintain-audit',
    version: MAINTAIN_AUDIT_VERSION,
    exportedAt: opts.exportedAt,
    count: entries.length,
    head,
    entries,
    algo: 'sha256-chain',
  };
  if (opts.key) {
    return { ...base, algo: 'sha256-chain+hmac-sha256', keyId: keyIdFor(opts.key), signature: signChainHead(head, opts.key) };
  }
  return base;
}

/** Serialize to pretty JSON. PURE. */
export function serializeAuditLog(log: SignedAuditLog): string {
  return JSON.stringify(log, null, 2);
}

export interface AuditVerifyResult {
  ok: boolean;
  chainValid: boolean;
  brokenAt?: number;
  reason?: string;
  signaturePresent: boolean;
  signatureValid?: boolean;     // undefined when no signature / no key to check against
  headMatches: boolean;         // does the stored `head` equal the recomputed chain head?
  count: number;
}

/**
 * The auditor-facing one-pager: verification status up top (chain / head / signature), then the
 * full entry chain as a readable table — what ran, when, the outcome, what it touched, and the PR.
 * Feed the blocks to pdf-lite's buildPdf. PURE (pass the verdict computed by verifyAuditLog).
 */
export function buildAuditPdfBlocks(log: SignedAuditLog, verdict: AuditVerifyResult): import('./pdf-lite.js').PdfBlock[] {
  const kv = (k: string, v: string): import('./pdf-lite.js').PdfBlock => ({ text: `${k}:  ${v}`, size: 10, indent: 10 });
  const sigLine = !verdict.signaturePresent ? 'unsigned (integrity only)'
    : verdict.signatureValid === undefined ? `signed (keyId ${log.keyId ?? '?'}) — no key supplied to verify`
    : verdict.signatureValid ? `VALID — HMAC-SHA256, keyId ${log.keyId ?? '?'} (authentic)` : 'INVALID — wrong key or forged';
  const blocks: import('./pdf-lite.js').PdfBlock[] = [
    { text: 'Maintain Audit Log', size: 18, bold: true },
    { text: `Exported ${log.exportedAt} - ${log.count} run(s) - tamper-evident hash chain (each entry commits to the previous; altering, reordering, or dropping any entry breaks every downstream hash).`, size: 9, spaceBefore: 4 },
    { text: 'Verification', size: 13, bold: true, spaceBefore: 12 },
    kv('Chain integrity', verdict.chainValid ? 'INTACT — no entry altered, reordered, or dropped' : `BROKEN at #${verdict.brokenAt} — ${verdict.reason}`),
    kv('Head', `${verdict.headMatches ? 'matches the chain' : 'MISMATCH'}  (${log.head.slice(0, 24)}...)`),
    kv('Signature', sigLine),
    kv('Overall', verdict.ok ? 'PASS — this log is trustworthy' : 'FAIL — do not trust this log'),
    { text: 'Run chain (oldest first)', size: 13, bold: true, spaceBefore: 12 },
  ];
  if (!log.entries.length) blocks.push({ text: 'no runs recorded', size: 10, indent: 10 });
  for (const e of log.entries) {
    const outcome = e.status === 'opened' ? '[OK] opened' : e.status === 'blocked' ? '[BLOCKED]' : e.status;
    const checks = e.verification.length ? ` - checks: ${e.verification.map(v => `${v.passed ? 'v' : 'x'} ${v.command}`).join(', ')}` : '';
    const files = e.filesChanged ? ` - ${e.filesChanged} file(s)` : '';
    blocks.push({ text: `#${e.seq}  ${e.at.slice(0, 10)}  ${e.scope}  ${outcome}${files}${checks}`, size: 9, mono: true, indent: 10 });
    if (e.prUrl) blocks.push({ text: `     PR: ${e.prUrl}`, size: 8, mono: true, indent: 10 });
  }
  blocks.push({ text: 'Verify this log offline anytime: qodex maintain-audit-verify <file>  (exit 1 on tamper - CI-friendly).', size: 8, spaceBefore: 12 });
  return blocks;
}

/**
 * Full audit verification of a parsed log: chain integrity, that the stored head matches the chain,
 * and (when a key is available) the HMAC signature. PURE. `ok` = everything checkable passed.
 */
export function verifyAuditLog(log: SignedAuditLog, key?: string): AuditVerifyResult {
  const entries = Array.isArray(log?.entries) ? log.entries : [];
  const chain = verifyAuditChain(entries);
  const recomputedHead = chainHead(entries);
  const headMatches = recomputedHead === log?.head;
  const signaturePresent = !!log?.signature;
  let signatureValid: boolean | undefined;
  if (signaturePresent && key) signatureValid = verifyChainSignature(log.head, log.signature!, key);
  const ok = chain.valid && headMatches && (!signaturePresent || signatureValid === true);
  return {
    ok,
    chainValid: chain.valid,
    brokenAt: chain.brokenAt,
    reason: chain.reason,
    signaturePresent,
    signatureValid,
    headMatches,
    count: entries.length,
  };
}
