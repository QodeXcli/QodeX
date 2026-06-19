/**
 * Auto-verify gate — the harness-level "you don't get to claim done with broken code"
 * check. This is QodeX's strongest model-agnostic amplifier: it runs AFTER the model
 * thinks it's finished a coding task, type-checks the files the model actually touched,
 * and — if they don't compile — feeds the errors straight back and forces a repair round.
 *
 * Why model-agnostic: it doesn't make the model smarter, it raises the FLOOR of what the
 * model is allowed to ship. A 1.5B local model and a frontier model both get held to
 * "the files you changed must type-check." The weaker the model, the more this lifts it.
 *
 * Split for testability: the decision/format/scoping logic is pure (no I/O, no model) and
 * unit-tested; the single impure entry point `verifyTouchedFiles` does the spawn, reusing
 * the shared checker registry (tools/diagnostics/checkers.ts) so it never drifts from the
 * `diagnostics` tool.
 */

import * as path from 'path';
import {
  CHECKERS, runChecker, checkerText, pickChecker, detectProjectFiles,
  type CheckerSpec,
} from '../tools/diagnostics/checkers.js';
import type { Diagnostic } from '../tools/diagnostics/parsers.js';

export interface VerifyConfig {
  /** Master switch. Default true. */
  auto?: boolean;
  /** How many consecutive auto-repair rounds before we stop forcing and let the model
   *  proceed (so an un-fixable error doesn't loop forever). Default 2. */
  maxRepairAttempts?: number;
  /** Per-run checker timeout (ms). Default 120000. */
  timeoutMs?: number;
}

export interface VerifyResult {
  /** True if a checker actually ran (a relevant checker exists + at least one touched
   *  file is in a language it covers). */
  ran: boolean;
  checker?: string;
  /** Diagnostics scoped to the touched files only. */
  diagnostics: Diagnostic[];
  /** Count of severity==='error' diagnostics in touched files. */
  errorCount: number;
  /** True if the checker binary was missing / failed to spawn (gate then no-ops). */
  unavailable?: boolean;
}

/** Normalize a path to absolute against `cwd` for robust comparison. */
function abs(cwd: string, p: string): string {
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwd, p);
}

/** Keep only the touched source files whose extension a checker can handle. Pure. */
export function relevantTouchedFiles(touched: string[], spec: CheckerSpec): string[] {
  const exts = new Set(spec.exts);
  return touched.filter(f => exts.has(path.extname(f).toLowerCase()));
}

/** Filter diagnostics down to the files the model touched this run. Pure. */
export function filterToTouched(diags: Diagnostic[], touched: string[], cwd: string): Diagnostic[] {
  const set = new Set(touched.map(t => abs(cwd, t)));
  return diags.filter(d => set.has(abs(cwd, d.file)));
}

/**
 * Baseline diff (the PVS-Studio "only flag NEW code" idea). Given the diagnostics
 * that existed BEFORE the agent touched anything (`baseline`) and the ones present
 * now (`current`), return only the genuinely NEW ones. Matched by file+code+message
 * (NOT line number, which shifts when the agent edits above an existing error), and
 * occurrence-counted so 2 pre-existing + 3 now ⇒ 1 new. Pure.
 *
 * Why it matters: without this, editing a file that already had 5 unrelated type
 * errors makes the verify gate report 5 errors and the agent burns repair rounds
 * fixing technical debt it didn't cause. With it, the agent is held to "don't make
 * it worse" — exactly what you want from an automated gate.
 */
function diagSignature(d: Diagnostic): string {
  return `${d.file}|${d.code ?? ''}|${d.message.trim().toLowerCase()}`;
}
export function diffDiagnostics(baseline: Diagnostic[], current: Diagnostic[]): Diagnostic[] {
  const counts = new Map<string, number>();
  for (const d of baseline) {
    const s = diagSignature(d);
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const fresh: Diagnostic[] = [];
  for (const d of current) {
    const s = diagSignature(d);
    const remaining = counts.get(s) ?? 0;
    if (remaining > 0) counts.set(s, remaining - 1); // consume a pre-existing occurrence
    else fresh.push(d);                              // genuinely new
  }
  return fresh;
}

/** Build the corrective message fed back to the model when touched files don't compile.
 *  Pure. `attempt`/`max` let the wording escalate. */
export function buildVerifyRepairMessage(
  diags: Diagnostic[],
  checker: string,
  attempt: number,
  max: number,
  cwd: string,
): string {
  const errors = diags.filter(d => d.severity === 'error');
  const shown = errors.slice(0, 15);
  const lines: string[] = [];
  lines.push(
    `[AUTO-VERIFY] You're not done yet. The ${checker} check found ${errors.length} error(s) ` +
    `in the file(s) you just changed. A coding task is NOT complete while the code you touched ` +
    `fails to type-check. Fix these, then continue. (auto-repair ${attempt}/${max})`,
  );
  lines.push('');
  for (const d of shown) {
    const rel = path.isAbsolute(d.file) ? path.relative(cwd, d.file) : d.file;
    const pos = d.col != null ? `${d.line}:${d.col}` : `${d.line}`;
    const code = d.code ? ` [${d.code}]` : '';
    lines.push(`  ${rel}:${pos}${code}  ${d.message}`);
  }
  if (errors.length > shown.length) lines.push(`  …and ${errors.length - shown.length} more.`);
  lines.push('');
  lines.push('Read each reported line, fix the root cause (don\'t suppress with `any`/`# type: ignore` unless truly warranted), and only stop once the changed files are clean.');
  return lines.join('\n');
}

/** Message used when auto-repair is exhausted — surfaced ONCE, then the model proceeds. */
export function buildVerifyGiveupMessage(errorCount: number, checker: string): string {
  return (
    `[AUTO-VERIFY] After repeated attempts, ${errorCount} ${checker} error(s) remain in the ` +
    `files you changed. I'll stop auto-retrying. In your final reply, tell the user plainly ` +
    `which errors remain and why they're hard to resolve — do not claim the task is fully done.`
  );
}

/**
 * Run the auto-verify check over the touched files. Impure (spawns a checker), but all
 * the decision logic above it is pure. Returns `{ran:false}` whenever verification can't
 * or shouldn't run (no checker, no relevant files, checker binary missing) — the caller
 * treats that as "skip silently, let the model finish".
 */
export async function verifyTouchedFiles(opts: {
  cwd: string;
  touched: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Pre-edit diagnostics (whole-project). When given, only NEW errors are reported. */
  baseline?: Diagnostic[];
}): Promise<VerifyResult> {
  const { cwd, touched } = opts;
  if (touched.length === 0) return { ran: false, diagnostics: [], errorCount: 0 };

  const rootFiles = await detectProjectFiles(cwd);
  const spec = pickChecker(rootFiles);
  if (!spec) return { ran: false, diagnostics: [], errorCount: 0 };

  const relevant = relevantTouchedFiles(touched, spec);
  if (relevant.length === 0) return { ran: false, diagnostics: [], errorCount: 0 };

  let diags: Diagnostic[];
  if (spec.perFile) {
    // Per-file checker (e.g. `php -l`): run once per relevant touched file, append
    // the path to argv each time, merge diagnostics. A missing binary on the FIRST
    // file marks the whole checker unavailable (don't claim a clean pass it can't give).
    diags = [];
    let anyRan = false;
    for (const file of relevant) {
      const r = await runChecker([...spec.argv, file], cwd, opts.timeoutMs ?? 120_000, opts.signal);
      if (r.spawnError || r.code === 127) {
        if (!anyRan) return { ran: false, diagnostics: [], errorCount: 0, unavailable: true };
        continue;
      }
      anyRan = true;
      try { diags.push(...spec.parse(checkerText(spec, r))); } catch { /* skip this file */ }
    }
    if (!anyRan) return { ran: false, diagnostics: [], errorCount: 0, unavailable: true };
  } else {
    const run = await runChecker(spec.argv, cwd, opts.timeoutMs ?? 120_000, opts.signal);
    if (run.spawnError || run.code === 127) {
      return { ran: false, diagnostics: [], errorCount: 0, unavailable: true };
    }
    try {
      diags = spec.parse(checkerText(spec, run));
    } catch {
      // Couldn't parse (the checker itself errored in an unexpected way) — don't block.
      return { ran: false, diagnostics: [], errorCount: 0 };
    }
  }

  let scoped = filterToTouched(diags, relevant, cwd);
  // Baseline subtraction: if we captured the pre-edit state, only hold the model
  // accountable for errors it actually introduced — not the project's prior debt.
  if (opts.baseline) {
    const baseScoped = filterToTouched(opts.baseline, relevant, cwd);
    scoped = diffDiagnostics(baseScoped, scoped);
  }
  return {
    ran: true,
    checker: spec.id,
    diagnostics: scoped,
    errorCount: scoped.filter(d => d.severity === 'error').length,
  };
}

/**
 * Capture a whole-project diagnostic baseline BEFORE the agent edits anything.
 * Returns [] (and ran:false semantics) when no checker applies or it can't run —
 * callers treat a null/empty baseline as "no subtraction". Best-effort: a failed
 * capture must never block the task.
 */
export async function captureBaseline(opts: {
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<Diagnostic[]> {
  try {
    const rootFiles = await detectProjectFiles(opts.cwd);
    const spec = pickChecker(rootFiles);
    if (!spec) return [];
    // Per-file checkers (php -l) would have to lint the ENTIRE project to baseline,
    // which is costly and near-useless (a working project has no syntax errors at
    // baseline; any the agent introduces are by definition new). Skip — every
    // syntax error found post-edit is correctly treated as new.
    if (spec.perFile) return [];
    const run = await runChecker(spec.argv, opts.cwd, opts.timeoutMs ?? 120_000, opts.signal);
    if (run.spawnError || run.code === 127) return [];
    return spec.parse(checkerText(spec, run));
  } catch {
    return [];
  }
}

/** Re-export so callers don't need to import the registry directly. */
export { CHECKERS };
