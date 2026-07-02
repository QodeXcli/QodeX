/**
 * Maintain history export/import — a portable, self-describing snapshot of the self-improvement
 * loop's runs, so analytics can be archived, shared, or moved between machines. The maintain runs
 * live in the schedule store keyed by machine-local schedule ids; this serializes them into a
 * store-independent artifact and reads it back, merging with local history without duplicates.
 *
 * All PURE (string/array in, string/array out) so the round-trip + merge are unit-tested.
 */
import type { MaintainRun } from './maintain-stats.js';
import { buildAuditChain, chainHead, signChainHead, verifyChainSignature, keyIdFor, type AuditableRun } from './maintain-audit.js';

export const MAINTAIN_HISTORY_VERSION = 1;

export interface HistoryAudit {
  algo: 'sha256-chain' | 'sha256-chain+hmac-sha256';
  head: string;
  keyId?: string;
  signature?: string;
}

export interface MaintainHistoryFile {
  kind: 'qodex-maintain-history';
  version: number;
  exportedAt: string;
  count: number;
  runs: MaintainRun[];
  /** Tamper-evidence for the snapshot itself: the audit-chain head over `runs` (+ optional HMAC). */
  audit?: HistoryAudit;
}

const toAuditable = (r: MaintainRun): AuditableRun =>
  ({ at: r.at ?? '', scope: r.scope, status: r.status, filesChanged: r.filesChanged });

/** The audit-chain head over a run list (order-independent — the chain sorts chronologically). PURE. */
export function historyHead(runs: MaintainRun[]): string {
  return chainHead(buildAuditChain(runs.map(toAuditable)));
}

/**
 * Serialize maintain runs into a portable snapshot. PURE (pass `nowIso`). With `opts.key`, the
 * snapshot carries an `audit` block: the hash-chain head over the runs plus an HMAC signature — so
 * the receiver can prove the history wasn't altered in transit and WHO exported it. Without a key
 * it still carries the unsigned head (integrity check, no authenticity).
 */
export function serializeMaintainHistory(runs: MaintainRun[], nowIso: string, opts: { key?: string } = {}): string {
  const clean = runs.map(normalizeRun);
  const head = historyHead(clean);
  const audit: HistoryAudit = opts.key
    ? { algo: 'sha256-chain+hmac-sha256', head, keyId: keyIdFor(opts.key), signature: signChainHead(head, opts.key) }
    : { algo: 'sha256-chain', head };
  const file: MaintainHistoryFile = {
    kind: 'qodex-maintain-history',
    version: MAINTAIN_HISTORY_VERSION,
    exportedAt: nowIso,
    count: clean.length,
    runs: clean,
    audit,
  };
  return JSON.stringify(file, null, 2);
}

export interface HistoryAuditVerdict {
  present: boolean;
  headMatches?: boolean;
  signaturePresent?: boolean;
  signatureValid?: boolean;      // undefined when unsigned or no key supplied
  ok: boolean;                   // everything checkable passed (an unsigned-but-intact snapshot is ok)
}

/** Verify a snapshot's audit block against its own runs. PURE. */
export function verifyHistoryAudit(runs: MaintainRun[], audit: HistoryAudit | undefined, key?: string): HistoryAuditVerdict {
  if (!audit) return { present: false, ok: true };            // legacy snapshot — nothing to check
  const headMatches = historyHead(runs.map(normalizeRun)) === audit.head;
  const signaturePresent = !!audit.signature;
  let signatureValid: boolean | undefined;
  if (signaturePresent && key) signatureValid = verifyChainSignature(audit.head, audit.signature!, key);
  return { present: true, headMatches, signaturePresent, signatureValid, ok: headMatches && (!signaturePresent || signatureValid !== false) };
}

/**
 * Parse a history snapshot back into runs. Tolerant of extra fields and either the wrapped file
 * shape or a bare runs array; throws only when the input is not usable JSON or has no runs field.
 * PURE.
 */
export function deserializeMaintainHistory(text: string): { runs: MaintainRun[]; exportedAt?: string; version?: number; audit?: HistoryAudit } {
  let obj: any;
  try { obj = JSON.parse(text); } catch { throw new Error('not valid JSON'); }
  const rawRuns = Array.isArray(obj) ? obj : obj?.runs;
  if (!Array.isArray(rawRuns)) throw new Error('no maintain runs found in the file');
  const runs = rawRuns.filter(isRunLike).map(normalizeRun);
  const audit = obj?.audit && typeof obj.audit === 'object' && typeof obj.audit.head === 'string' ? obj.audit as HistoryAudit : undefined;
  return { runs, exportedAt: typeof obj?.exportedAt === 'string' ? obj.exportedAt : undefined, version: typeof obj?.version === 'number' ? obj.version : undefined, audit };
}

/** A stable identity for a run, so re-importing the same snapshot doesn't double-count. */
function runKey(r: MaintainRun): string {
  return `${r.at ?? r.when}|${r.scope}|${r.status}|${r.filesChanged}`;
}

/**
 * Merge two run lists into one, dropping duplicates by (timestamp, scope, status, filesChanged).
 * Keeps the FIRST occurrence's fields. Result is sorted newest-first by `at`. PURE.
 */
export function mergeRuns(a: MaintainRun[], b: MaintainRun[]): MaintainRun[] {
  const seen = new Set<string>();
  const out: MaintainRun[] = [];
  for (const r of [...a, ...b].map(normalizeRun)) {
    const k = runKey(r);
    if (seen.has(k)) continue;
    seen.add(k); out.push(r);
  }
  return out.sort((x, y) => Date.parse(y.at ?? '') - Date.parse(x.at ?? '') || 0);
}

function isRunLike(x: any): boolean {
  return x && typeof x === 'object' && typeof x.scope === 'string' && typeof x.status === 'string';
}

function normalizeRun(r: any): MaintainRun {
  return {
    scope: String(r.scope),
    status: String(r.status),
    filesChanged: Number.isFinite(r.filesChanged) ? Number(r.filesChanged) : 0,
    when: typeof r.when === 'string' ? r.when : '',
    at: typeof r.at === 'string' ? r.at : undefined,
  };
}
