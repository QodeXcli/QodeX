/**
 * Verifiable run receipt — the proof artifact for an unattended run.
 *
 * The autonomy contract already PRINTS a run report. A printed report cannot be consumed
 * by a CI job, a dashboard, or a reviewer who wasn't watching the terminal — and it cannot
 * be re-checked later. This turns the same facts into a signed, tamper-evident JSON
 * document that a third party can independently verify.
 *
 * Two layers of tamper evidence, because they catch different things:
 *   - The ACTION LOG is hash-chained (each entry commits to the previous). Altering,
 *     reordering, inserting or dropping an action breaks the chain AT A KNOWN INDEX, so
 *     verification says *where*.
 *   - The whole receipt is covered by an HMAC over a canonical digest that includes the
 *     chain head. Editing any material field — a budget number, a file path, the verdict —
 *     invalidates the signature even though the action chain is untouched.
 *
 * Without a key you still get chain integrity, but a field edit is undetectable — so an
 * unsigned receipt verifies as UNSIGNED, never as PASS. Saying "valid" about something we
 * cannot actually vouch for would defeat the point of the artifact.
 *
 * Crypto is reused from the maintain audit log (sha256 chain + HMAC-SHA256 + timing-safe
 * compare); nothing new is invented here.
 */
import { createHash } from 'crypto';
import { keyIdFor, signChainHead, verifyChainSignature } from '../cli/maintain-audit.js';
import type { ContractVerdict } from './autonomy-contract.js';

export const RECEIPT_VERSION = 1;
/** Fixed anchor so an empty action log still has a well-defined predecessor. */
export const RECEIPT_GENESIS = 'qodex-run-receipt-genesis-v1';

/** What kind of thing happened. Kept coarse — the receipt is evidence, not a trace log. */
export type ReceiptActionKind =
  | 'tool'        // a tool call the agent made
  | 'permission'  // a permission decision (granted/denied, and at what scope)
  | 'gate'        // a guardrail gate firing (syntax, completion, preflight, visual…)
  | 'verify'      // the --verify command
  | 'rollback'    // the transactional rollback
  | 'budget';     // a budget limit being hit

export interface ReceiptActionInput {
  kind: ReceiptActionKind;
  /** Tool/gate/command name. Never a secret value. */
  name: string;
  /** Short human detail. Callers MUST pass redacted text — this is written to disk. */
  detail?: string;
  ok: boolean;
}

export interface ReceiptAction extends Required<Omit<ReceiptActionInput, 'detail'>> {
  seq: number;
  detail: string;
  prevHash: string;
  hash: string;
}

export interface ReceiptBudgets {
  tokens?: number;
  costUsd?: number;
  wallSec?: number;
  iterations?: number;
}

export interface ReceiptFile {
  path: string;
  /** True when the transactional rollback restored this file. */
  reverted: boolean;
}

export interface ReceiptVerify {
  command: string;
  exitCode: number | null;
  ok: boolean;
  /** Tail of the verify output, already truncated by the caller. */
  outputTail: string;
}

export interface RunReceipt {
  kind: 'qodex-run-receipt';
  schemaVersion: number;
  runId: string;
  /** Injected by the caller — never read from the clock here, so builds stay deterministic. */
  startedAt: string;
  endedAt: string;
  cwd: string;
  git: { commit: string; branch: string; dirty: boolean } | null;
  /** The scope the run was confined to, or null when unconstrained. */
  scope: string | null;
  budgets: { granted: ReceiptBudgets; consumed: ReceiptBudgets };
  verify: ReceiptVerify | null;
  files: ReceiptFile[];
  actions: ReceiptAction[];
  /** Head of the action chain — what the signature commits to, alongside every other field. */
  head: string;
  verdict: ContractVerdict;
  failReasons: string[];
  algo: 'sha256-chain' | 'sha256-chain+hmac-sha256';
  keyId?: string;
  signature?: string;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Canonical, order-stable content an action commits to. PURE. */
function actionContent(a: Omit<ReceiptAction, 'hash'>): string {
  return JSON.stringify([a.seq, a.kind, a.name, a.detail, a.ok, a.prevHash]);
}

/** Hash-chain the action log. PURE. */
export function buildActionChain(actions: ReceiptActionInput[]): ReceiptAction[] {
  const out: ReceiptAction[] = [];
  let prevHash = RECEIPT_GENESIS;
  actions.forEach((a, seq) => {
    const base = {
      seq,
      kind: a.kind,
      name: String(a.name ?? ''),
      detail: String(a.detail ?? ''),
      ok: !!a.ok,
      prevHash,
    };
    const hash = sha256(actionContent(base));
    out.push({ ...base, hash });
    prevHash = hash;
  });
  return out;
}

/** The action-chain head — AUDIT_GENESIS-style anchor when empty. PURE. */
export function actionChainHead(actions: ReceiptAction[]): string {
  return actions.length ? actions[actions.length - 1]!.hash : RECEIPT_GENESIS;
}

export interface BuildReceiptInput {
  runId: string;
  startedAt: string;
  endedAt: string;
  cwd: string;
  git?: { commit: string; branch: string; dirty: boolean } | null;
  scope?: string | null;
  granted?: ReceiptBudgets;
  consumed?: ReceiptBudgets;
  verify?: ReceiptVerify | null;
  files?: ReceiptFile[];
  actions?: ReceiptActionInput[];
  verdict: ContractVerdict;
  failReasons?: string[];
}

/**
 * Build a receipt. PURE and deterministic: identical input ⇒ byte-identical JSON. All
 * timestamps are injected, key order is fixed, and file/action order is preserved as given
 * (callers pass them in the order they happened, which is itself part of the evidence).
 */
export function buildReceipt(input: BuildReceiptInput): RunReceipt {
  const actions = buildActionChain(input.actions ?? []);
  return {
    kind: 'qodex-run-receipt',
    schemaVersion: RECEIPT_VERSION,
    runId: input.runId,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    cwd: input.cwd,
    git: input.git ?? null,
    scope: input.scope ?? null,
    budgets: { granted: input.granted ?? {}, consumed: input.consumed ?? {} },
    verify: input.verify ?? null,
    files: (input.files ?? []).map(f => ({ path: f.path, reverted: !!f.reverted })),
    actions,
    head: actionChainHead(actions),
    verdict: input.verdict,
    failReasons: input.failReasons ?? [],
    algo: 'sha256-chain',
  };
}

/**
 * Canonical digest over EVERY material field, including the action-chain head. This is what
 * the signature commits to — so editing a budget, a file path, or the verdict invalidates it
 * even though the action chain itself still links correctly. `signature`/`keyId`/`algo` are
 * excluded (they describe the signature, they are not signed content). PURE.
 */
export function receiptDigest(r: RunReceipt): string {
  return sha256(JSON.stringify([
    r.kind, r.schemaVersion, r.runId, r.startedAt, r.endedAt, r.cwd,
    r.git, r.scope, r.budgets, r.verify, r.files, r.head, r.verdict, r.failReasons,
  ]));
}

/** Sign a receipt with QODEX_AUDIT_KEY-style HMAC. Returns a NEW receipt. PURE. */
export function signReceipt(receipt: RunReceipt, key: string): RunReceipt {
  const signed: RunReceipt = { ...receipt, algo: 'sha256-chain+hmac-sha256', keyId: keyIdFor(key) };
  return { ...signed, signature: signChainHead(receiptDigest(signed), key) };
}

export type ChainStatus = 'INTACT' | 'BROKEN';
export type SignatureStatus = 'valid' | 'invalid' | 'absent' | 'no-key';
export type ReceiptOverall = 'PASS' | 'FAIL' | 'UNSIGNED';

export interface ReceiptVerdict {
  overall: ReceiptOverall;
  schemaValid: boolean;
  chain: ChainStatus;
  /** Index of the first broken action, when the chain is broken. */
  brokenAt?: number;
  chainReason?: string;
  signature: SignatureStatus;
  reasons: string[];
}

function schemaProblems(r: any): string[] {
  const p: string[] = [];
  if (!r || typeof r !== 'object') return ['not an object'];
  if (r.kind !== 'qodex-run-receipt') p.push(`kind is "${r.kind}", expected "qodex-run-receipt"`);
  if (r.schemaVersion !== RECEIPT_VERSION) p.push(`schemaVersion ${r.schemaVersion} ≠ ${RECEIPT_VERSION}`);
  if (typeof r.runId !== 'string' || !r.runId) p.push('runId missing');
  if (!['GREEN', 'ROLLED-BACK', 'FAILED-KEPT'].includes(r.verdict)) p.push(`verdict "${r.verdict}" is not a known verdict`);
  if (!Array.isArray(r.actions)) p.push('actions is not an array');
  if (!Array.isArray(r.files)) p.push('files is not an array');
  if (typeof r.head !== 'string') p.push('head missing');
  return p;
}

/**
 * Verify a receipt and report WHAT is wrong, not just that something is. `key` is optional:
 * without it a signed receipt can still have its chain checked, but the signature is reported
 * as `no-key` and the overall result is UNSIGNED — we never claim to have verified something
 * we could not check.
 */
export function verifyReceipt(receipt: RunReceipt, key?: string): ReceiptVerdict {
  const reasons: string[] = [];
  const problems = schemaProblems(receipt);
  const schemaValid = problems.length === 0;
  reasons.push(...problems);

  // Chain: recompute every hash + link, and report the first break with its index.
  let chain: ChainStatus = 'INTACT';
  let brokenAt: number | undefined;
  let chainReason: string | undefined;
  const actions = Array.isArray(receipt?.actions) ? receipt.actions : [];
  let prevHash = RECEIPT_GENESIS;
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i]!;
    if (a.seq !== i) { chain = 'BROKEN'; brokenAt = i; chainReason = `seq ${a.seq} ≠ position ${i} (entry reordered, inserted or dropped)`; break; }
    if (a.prevHash !== prevHash) { chain = 'BROKEN'; brokenAt = i; chainReason = 'prevHash does not link to the previous action'; break; }
    const { hash, ...base } = a;
    if (sha256(actionContent(base)) !== hash) { chain = 'BROKEN'; brokenAt = i; chainReason = 'content hash mismatch (action was modified)'; break; }
    prevHash = hash;
  }
  if (chain === 'INTACT' && schemaValid && receipt.head !== actionChainHead(actions)) {
    chain = 'BROKEN';
    brokenAt = actions.length;
    chainReason = 'head does not match the action chain';
  }
  if (chain === 'BROKEN') reasons.push(`action chain broken at ${brokenAt}: ${chainReason}`);

  // Signature over the whole-receipt digest.
  let signature: SignatureStatus;
  if (!receipt?.signature) {
    signature = 'absent';
    reasons.push('receipt is unsigned — field edits cannot be detected (set QODEX_AUDIT_KEY and re-run to sign)');
  } else if (!key) {
    signature = 'no-key';
    reasons.push('receipt is signed but no key was supplied — cannot check the signature (set QODEX_AUDIT_KEY)');
  } else {
    const { signature: sig, ...unsigned } = receipt;
    const expectedOver = receiptDigest({ ...unsigned, signature: undefined } as RunReceipt);
    signature = verifyChainSignature(expectedOver, sig, key) ? 'valid' : 'invalid';
    if (signature === 'invalid') reasons.push('signature does not match — the receipt was modified after signing, or a different key was used');
  }

  const overall: ReceiptOverall =
    !schemaValid || chain === 'BROKEN' || signature === 'invalid' ? 'FAIL'
      : signature === 'valid' ? 'PASS'
        : 'UNSIGNED';

  return { overall, schemaValid, chain, brokenAt, chainReason, signature, reasons };
}

/** Human-readable one-screen verdict for `qodex receipt verify`. PURE. */
export function formatReceiptVerdict(r: RunReceipt, v: ReceiptVerdict): string {
  const out: string[] = [];
  const mark = v.overall === 'PASS' ? '✓' : v.overall === 'UNSIGNED' ? '○' : '✗';
  out.push(`${mark} ${v.overall} — run ${r?.runId ?? '(unknown)'} · verdict ${r?.verdict ?? '(unknown)'}`);
  out.push(`  chain      ${v.chain}${v.brokenAt !== undefined ? ` (broken at action ${v.brokenAt})` : ''}`);
  out.push(`  signature  ${v.signature}${r?.keyId ? ` · keyId ${r.keyId}` : ''}`);
  out.push(`  schema     ${v.schemaValid ? 'valid' : 'INVALID'}`);
  if (r?.actions?.length !== undefined) out.push(`  actions    ${r.actions.length}`);
  if (r?.files?.length) {
    const reverted = r.files.filter(f => f.reverted).length;
    out.push(`  files      ${r.files.length}${reverted ? ` (${reverted} reverted)` : ''}`);
  }
  if (v.reasons.length) {
    out.push('');
    for (const reason of v.reasons) out.push(`  • ${reason}`);
  }
  return out.join('\n');
}

/** Exit non-zero on anything short of a verified PASS — so CI can gate on it. */
export function receiptExitCode(v: ReceiptVerdict): number {
  return v.overall === 'PASS' ? 0 : 1;
}
