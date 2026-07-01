/**
 * Maintain history export/import — a portable, self-describing snapshot of the self-improvement
 * loop's runs, so analytics can be archived, shared, or moved between machines. The maintain runs
 * live in the schedule store keyed by machine-local schedule ids; this serializes them into a
 * store-independent artifact and reads it back, merging with local history without duplicates.
 *
 * All PURE (string/array in, string/array out) so the round-trip + merge are unit-tested.
 */
import type { MaintainRun } from './maintain-stats.js';

export const MAINTAIN_HISTORY_VERSION = 1;

export interface MaintainHistoryFile {
  kind: 'qodex-maintain-history';
  version: number;
  exportedAt: string;
  count: number;
  runs: MaintainRun[];
}

/** Serialize maintain runs into a portable snapshot. PURE (pass `nowIso`). */
export function serializeMaintainHistory(runs: MaintainRun[], nowIso: string): string {
  const clean = runs.map(normalizeRun);
  const file: MaintainHistoryFile = {
    kind: 'qodex-maintain-history',
    version: MAINTAIN_HISTORY_VERSION,
    exportedAt: nowIso,
    count: clean.length,
    runs: clean,
  };
  return JSON.stringify(file, null, 2);
}

/**
 * Parse a history snapshot back into runs. Tolerant of extra fields and either the wrapped file
 * shape or a bare runs array; throws only when the input is not usable JSON or has no runs field.
 * PURE.
 */
export function deserializeMaintainHistory(text: string): { runs: MaintainRun[]; exportedAt?: string; version?: number } {
  let obj: any;
  try { obj = JSON.parse(text); } catch { throw new Error('not valid JSON'); }
  const rawRuns = Array.isArray(obj) ? obj : obj?.runs;
  if (!Array.isArray(rawRuns)) throw new Error('no maintain runs found in the file');
  const runs = rawRuns.filter(isRunLike).map(normalizeRun);
  return { runs, exportedAt: typeof obj?.exportedAt === 'string' ? obj.exportedAt : undefined, version: typeof obj?.version === 'number' ? obj.version : undefined };
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
