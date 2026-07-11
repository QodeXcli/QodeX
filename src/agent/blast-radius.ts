/**
 * Blast-radius impact analysis — the code graph pushed INTO the edit loop.
 *
 * The graph tools (find_callers / find_references) only help when the model
 * remembers to call them. This module makes the graph speak up on its own:
 * after every successful code edit, loop.ts appends a compact "[impact]" note
 * to the tool result — which top-level symbols live in the edited file, how
 * many places reference them, which files those are, which test files cover
 * the file, and (cross-checked against the session read-ledger) which caller
 * files the model has NEVER read. Warn-only by design: the note is advisory
 * context, never a block.
 *
 * Deliberate MVP choices:
 *  - "Symbols touched" = the file's top-level symbols (preferring ones whose
 *    signature says `export`). The graph doesn't know which lines the edit hit,
 *    and per-hunk symbol attribution isn't worth the complexity for a note.
 *    Follow-up: intersect edit line-ranges with symbol spans for precision.
 *  - ONE search pass (alternation regex over up to MAX_SYMBOLS_SEARCHED names)
 *    keeps the per-edit cost to a single ripgrep run — cheap even on weak
 *    machines. Falls back to the pure-JS walk when rg is absent.
 *  - Tests "covering" the file = test-looking files that reference any of its
 *    symbols. A heuristic, not a coverage report — good enough to say
 *    "test/foo.test.ts exists, maybe run it".
 *  - Every failure path returns the EMPTY impact (note: ''). A broken or stale
 *    graph must never poison an otherwise-successful edit result.
 */

import * as path from 'path';
import type { CodeGraphDB } from '../codegraph/schema.js';
import { runLineSearch } from '../utils/ripgrep.js';
import { detectLanguage } from '../tools/ast/parser.js';

/** Edit tools whose successful results get an [impact] note appended (see loop.ts). */
export const IMPACT_EDIT_TOOLS = new Set(['edit_text', 'edit_symbol', 'multi_edit']);

/** Default character cap for the appended note. */
export const IMPACT_NOTE_MAX_CHARS = 600;

/** A graph older than this is treated as absent — silence beats stale advice. */
export const DEFAULT_MAX_GRAPH_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Cap the alternation regex so the single search pass stays cheap. */
const MAX_SYMBOLS_SEARCHED = 6;
/** Stop parsing reference matches beyond this many lines. */
const MAX_MATCHES = 300;
/** Max files listed per section of the note (the counts stay exact). */
const MAX_FILES_LISTED = 4;

export interface BlastRadiusOptions {
  /** Project root: search scope + base for relative display paths. */
  cwd: string;
  /** Session read-ledger lookup (absolute path → seen?). When provided, unread
   *  caller files produce the ⚠ warning line; when omitted (CLI mode), no warning. */
  wasRead?: (absPath: string) => boolean;
  /** Restrict the analysis to these symbol names (CLI symbol mode). */
  symbolFilter?: string[];
  /** Character cap for `note` (default IMPACT_NOTE_MAX_CHARS). */
  maxChars?: number;
  /** Freshness window (default DEFAULT_MAX_GRAPH_AGE_MS; Infinity = always use). */
  maxGraphAgeMs?: number;
  signal?: AbortSignal;
}

export interface BlastRadiusImpact {
  /** Ready-to-append note ('' = nothing safe/useful to say — caller appends nothing). */
  note: string;
  /** Top-level symbol names analyzed. */
  symbols: string[];
  /** Non-test files (relative) referencing those symbols, excluding the edited file. */
  callerFiles: string[];
  /** Total reference lines found outside the edited file (incl. tests). */
  refCount: number;
  /** Test-looking files (relative) referencing the symbols. */
  testFiles: string[];
  /** Subset of callerFiles never read this session (empty when wasRead is omitted). */
  unreadCallerFiles: string[];
}

const EMPTY: BlastRadiusImpact = Object.freeze({
  note: '', symbols: [], callerFiles: [], refCount: 0, testFiles: [], unreadCallerFiles: [],
});

/** Is this a source file the code graph can know about? (indexed languages only) */
export function isCodeFile(filePath: string): boolean {
  return detectLanguage(filePath) !== null;
}

/** Heuristic: does this (relative) path look like a test file? */
export function isTestFile(relPath: string): boolean {
  const base = path.basename(relPath);
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(base) ||
    /(^|\/)(tests?|__tests__|spec)\//.test(relPath) ||
    /_test\.(go|py|rs|c|cc|cpp)$/.test(base) ||
    /^test_.*\.py$/.test(base)
  );
}

/** Parse the graph's last-index timestamp (ISO meta or SQLite "YYYY-MM-DD HH:MM:SS" UTC). */
function lastIndexedMs(db: CodeGraphDB): number {
  const meta = db.getMeta('last_full_index');
  let t = meta ? Date.parse(meta) : NaN;
  if (!Number.isFinite(t)) {
    const s = db.stats().lastIndexed;
    t = s ? Date.parse(s.includes('T') ? s : s.replace(' ', 'T') + 'Z') : NaN;
  }
  return t;
}

/** True when the graph was indexed recently enough to trust for an advisory note. */
export function graphIsFresh(db: CodeGraphDB, maxAgeMs: number, nowMs = Date.now()): boolean {
  if (!Number.isFinite(maxAgeMs)) return true; // Infinity → standalone CLI always answers
  try {
    const t = lastIndexedMs(db);
    if (!Number.isFinite(t)) return false;
    return nowMs - t <= maxAgeMs;
  } catch {
    return false;
  }
}

/** "a.ts, b.ts (+3 more)" — exact counts, capped listing. */
function listCapped(items: string[], maxItems = MAX_FILES_LISTED): string {
  const shown = items.slice(0, maxItems);
  const more = items.length - shown.length;
  return shown.join(', ') + (more > 0 ? ` (+${more} more)` : '');
}

/** Cap the note at maxChars, always preserving the ⚠ warning line over the summary. */
function capNote(summary: string, warning: string, maxChars: number): string {
  const joined = warning ? `${summary}\n${warning}` : summary;
  if (joined.length <= maxChars) return joined;
  if (!warning) return summary.slice(0, maxChars - 1) + '…';
  const warn = warning.length >= maxChars ? warning.slice(0, maxChars - 1) + '…' : warning;
  const budget = maxChars - warn.length - 1; // -1 for the newline
  if (budget < 20) return warn; // no room for a meaningful summary — keep the warning
  return summary.slice(0, budget - 1) + '…\n' + warn;
}

/**
 * Compute the blast radius of an edit to `editedFileAbs`.
 * Never throws; every degraded path (no DB, stale graph, unindexed file,
 * search failure) returns the EMPTY impact so callers can blindly append `note`.
 */
export async function computeBlastRadius(
  db: CodeGraphDB | null | undefined,
  editedFileAbs: string,
  opts: BlastRadiusOptions,
): Promise<BlastRadiusImpact> {
  try {
    if (!db) return EMPTY;
    if (!graphIsFresh(db, opts.maxGraphAgeMs ?? DEFAULT_MAX_GRAPH_AGE_MS)) return EMPTY;

    const rows = db.listSymbolsInFile(editedFileAbs);
    if (rows.length === 0) return EMPTY; // graph doesn't know this file — stay silent

    // Symbols to analyze: explicit filter (CLI symbol mode) or the file's top level,
    // preferring exported ones when the signature carries that information.
    let picked = rows.filter(r => r.parent_symbol_id === null);
    if (opts.symbolFilter?.length) {
      const want = new Set(opts.symbolFilter);
      picked = rows.filter(r => want.has(r.name));
    } else {
      const exported = picked.filter(r => r.signature?.includes('export'));
      if (exported.length > 0) picked = exported;
    }
    if (picked.length === 0) return EMPTY;

    const names = [...new Set(picked.map(r => r.name))];
    const searched = names.slice(0, MAX_SYMBOLS_SEARCHED);

    // ONE pass: word-boundary references to any analyzed symbol across the project.
    const escaped = searched.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const pattern = `\\b(${escaped.join('|')})\\b`;
    const rgArgs = ['-n', '--no-heading', '--max-count', String(MAX_MATCHES), '-e', pattern, opts.cwd];
    const search = await runLineSearch(opts.cwd, {
      rgArgs,
      regex: new RegExp(pattern),
      maxCount: MAX_MATCHES,
      signal: opts.signal,
    });
    if ('error' in search) return EMPTY; // advisory feature: silence over noise

    // Group reference lines by file, skipping the edited file and non-code files.
    let refCount = 0;
    const refFiles = new Set<string>(); // absolute
    for (const raw of search.stdout.split('\n')) {
      if (!raw) continue;
      const firstColon = raw.indexOf(':');
      const secondColon = raw.indexOf(':', firstColon + 1);
      if (firstColon === -1 || secondColon === -1) continue;
      const file = raw.slice(0, firstColon);
      if (file === editedFileAbs) continue;
      if (!isCodeFile(file)) continue; // .md/.json/db noise isn't blast radius
      refCount++;
      refFiles.add(file);
      if (refCount >= MAX_MATCHES) break;
    }

    const relFile = path.relative(opts.cwd, editedFileAbs) || editedFileAbs;
    const callerFiles: string[] = [];
    const testFiles: string[] = [];
    const unreadCallerFiles: string[] = [];
    for (const abs of [...refFiles].sort()) {
      const rel = path.relative(opts.cwd, abs);
      if (isTestFile(rel)) {
        testFiles.push(rel);
      } else {
        callerFiles.push(rel);
        if (opts.wasRead && !opts.wasRead(abs)) unreadCallerFiles.push(rel);
      }
    }

    // Compose the note.
    const symWord = `${names.length} top-level symbol${names.length > 1 ? 's' : ''}`;
    const parts = [`[impact] ${relFile} — ${symWord} (${listCapped(names, MAX_SYMBOLS_SEARCHED)})`];
    if (refCount === 0) {
      parts.push('no external references found (leaf file)');
    } else {
      parts.push(`${refCount}${refCount >= MAX_MATCHES ? '+' : ''} ref${refCount > 1 ? 's' : ''} in ${refFiles.size} file${refFiles.size > 1 ? 's' : ''}`);
      if (callerFiles.length > 0) parts.push(`callers: ${listCapped(callerFiles)}`);
      parts.push(testFiles.length > 0 ? `tests: ${listCapped(testFiles)}` : 'no covering tests found');
    }
    const summary = parts.join(' · ');
    const warning = unreadCallerFiles.length > 0
      ? `⚠ ${unreadCallerFiles.length} caller file${unreadCallerFiles.length > 1 ? 's' : ''} not read this session: ${listCapped(unreadCallerFiles)}`
      : '';

    return {
      note: capNote(summary, warning, opts.maxChars ?? IMPACT_NOTE_MAX_CHARS),
      symbols: names,
      callerFiles,
      refCount,
      testFiles,
      unreadCallerFiles,
    };
  } catch {
    return EMPTY;
  }
}
