/**
 * Eval core — deterministic reporting.
 *
 * BYTE-STABILITY IS A FEATURE, not a nicety. If a report changes between two identical
 * runs, you cannot commit it as a baseline, cannot diff it in a PR, and cannot tell a
 * real regression from clock noise. So by default these renderers emit NOTHING that
 * varies run to run: no timestamps, no wall-clock durations, no host details. Timings
 * are opt-in via `includeTimings`, and the timestamp is only printed if the caller
 * injected `startedAt` into the run.
 *
 * Skips are always rendered WITH their reason. A reader must be able to see, at a
 * glance, how much of the suite actually executed — a high score over a mostly-skipped
 * suite is the failure mode this whole subsystem exists to prevent.
 */

import type { EvalRun, ScoreSummary, TaskResult } from './types.js';
import type { MetricDelta, RunDiff, TaskFlip } from './diff.js';

export interface ReportOptions {
  /** Include wall-clock durations. Breaks byte-stability — off by default. */
  includeTimings?: boolean;
  /** Include the injected `startedAt`, when present. Off by default. */
  includeTimestamp?: boolean;
  /** Max reason characters per table cell. */
  maxReasonChars?: number;
}

const DEFAULT_REASON_CHARS = 120;

/** Stable number rendering — integers stay bare, floats get 4 dp with zeros stripped. */
function num(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return String(n);
  // A tiny-but-nonzero value (a fraction-of-a-cent cost, say) must never render as "0" —
  // that reads as "not measured" and understates a real number. Fall back to exponential.
  if (Math.abs(n) < 1e-4) return n.toExponential(2);
  return n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

/** null in a MetricDelta means UNREPORTED, which must never be rendered as 0. */
function numOrNa(n: number | null): string {
  return n === null ? 'unreported' : num(n);
}

function score(n: number): string {
  return n.toFixed(1);
}

function signed(n: number): string {
  const s = num(n);
  return n > 0 ? `+${s}` : s;
}

/** Markdown table cells must not contain raw pipes or newlines. */
function cell(text: string | undefined, max = DEFAULT_REASON_CHARS): string {
  if (!text) return '';
  const flat = text.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function statusLabel(r: TaskResult): string {
  return r.flaky ? `${r.status} (flaky)` : r.status;
}

function summaryLine(s: ScoreSummary): string {
  return `**Score ${score(s.score0to100)}/100** — ${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped of ${s.total} task(s)`;
}

export function formatRunReport(run: EvalRun, options: ReportOptions = {}): string {
  const maxReason = options.maxReasonChars ?? DEFAULT_REASON_CHARS;
  const s = run.summary;
  const out: string[] = [];

  out.push(`# Eval Report — ${run.suite}`);
  out.push('');
  if (options.includeTimestamp && run.startedAt) out.push(`Started: ${run.startedAt}`);
  out.push(summaryLine(s));
  out.push('');
  out.push(`- scored: ${s.scored} (skips excluded from the denominator)`);
  if (s.skipped > 0) out.push(`- skipped: ${s.skipped} — NOT counted as passes`);
  if (run.repeat > 1) out.push(`- repetitions per task: ${run.repeat}`);
  if (s.flaky > 0) out.push(`- flaky: ${s.flaky} task(s) disagreed across repetitions`);
  if (s.scored === 0 && s.total > 0) {
    out.push('- **nothing measurable ran — this score is 0 by construction, not a failure of the code under test**');
  }
  out.push('');

  const cats = Object.keys(s.byCategory);
  if (cats.length > 0) {
    out.push('## By category');
    out.push('');
    out.push('| Category | Score | Pass | Fail | Skip |');
    out.push('|---|---|---|---|---|');
    for (const key of cats) {
      const c = s.byCategory[key];
      out.push(`| ${cell(key)} | ${c.scored === 0 ? 'n/a' : score(c.score0to100)} | ${c.passed} | ${c.failed} | ${c.skipped} |`);
    }
    out.push('');
  }

  out.push('## Tasks');
  out.push('');
  const timings = options.includeTimings === true;
  out.push(`| Task | Status | Category | Kind |${timings ? ' Time |' : ''} Notes |`);
  out.push(`|---|---|---|---|${timings ? '---|' : ''}---|`);
  for (const r of run.results) {
    // Any non-pass row must carry an explanation. A reasonless `fail` with a blank Notes
    // cell is indistinguishable from a rendering bug — say that the task gave no reason.
    const note = r.status === 'pass' && !r.flaky
      ? ''
      : cell(r.reason ?? (r.status === 'pass' ? '' : '(no reason given)'), maxReason);
    const time = timings ? ` ${r.durationMs.toFixed(0)}ms |` : '';
    out.push(`| ${cell(r.id)} | ${statusLabel(r)} | ${cell(r.category)} | ${r.kind} |${time} ${note} |`);
  }
  out.push('');

  const withVariance = run.results.filter(r => Object.values(r.variance).some(v => v.samples > 1 && v.stdev !== 0));
  if (withVariance.length > 0) {
    out.push('## Variance across repetitions');
    out.push('');
    out.push('| Task | Metric | Mean | Min | Max | Stdev |');
    out.push('|---|---|---|---|---|---|');
    for (const r of withVariance) {
      for (const key of Object.keys(r.variance)) {
        const v = r.variance[key];
        if (v.samples <= 1 || v.stdev === 0) continue;
        out.push(`| ${cell(r.id)} | ${cell(key)} | ${num(v.mean)} | ${num(v.min)} | ${num(v.max)} | ${num(v.stdev)} |`);
      }
    }
    out.push('');
  }

  return out.join('\n');
}

function flipTable(title: string, flips: TaskFlip[], maxReason: number): string[] {
  if (flips.length === 0) return [];
  const out: string[] = [`## ${title} (${flips.length})`, '', '| Task | Before | After | Reason |', '|---|---|---|---|'];
  for (const f of flips) {
    out.push(`| ${cell(f.id)} | ${f.before} | ${f.after} | ${cell(f.reason, maxReason)} |`);
  }
  out.push('');
  return out;
}

function metricTable(deltas: MetricDelta[]): string[] {
  if (deltas.length === 0) return [];
  const out: string[] = ['## Metric deltas', '', '| Metric | Before | After | Delta | Change | Note |', '|---|---|---|---|---|---|'];
  for (const d of deltas) {
    const change = d.pctChange === null ? 'n/a' : `${d.pctChange > 0 ? '+' : ''}${d.pctChange.toFixed(1)}%`;
    // A metric that stopped being emitted is a measurement gap, not a saving — say so
    // rather than letting the reader book it as an improvement.
    const note = d.unreportedTasks
      ? `${d.unreportedTasks} task(s) reported this in only one run — excluded, NOT a change`
      : '';
    out.push(`| ${cell(d.metric)} | ${numOrNa(d.before)} | ${numOrNa(d.after)} | ${d.delta === null ? 'n/a' : signed(d.delta)} | ${change} | ${note} |`);
  }
  out.push('');
  return out;
}

export function formatDiffReport(diff: RunDiff, options: ReportOptions = {}): string {
  const maxReason = options.maxReasonChars ?? DEFAULT_REASON_CHARS;
  const out: string[] = [];

  out.push(`# Eval Diff — ${diff.before.suite} → ${diff.after.suite}`);
  out.push('');
  out.push(`**Score ${score(diff.before.summary.score0to100)} → ${score(diff.after.summary.score0to100)} (${diff.scoreDelta > 0 ? '+' : ''}${score(diff.scoreDelta)})**`);
  out.push('');
  // The verdict line: aggregate score can be flat while tasks churn underneath, so the
  // headline is regressions, not the delta.
  if (diff.regressions.length > 0) {
    out.push(`> ${diff.regressions.length} REGRESSION(S) — task(s) that passed before now fail.`);
  } else if (diff.improvements.length > 0) {
    out.push(`> No regressions; ${diff.improvements.length} improvement(s).`);
  } else {
    out.push('> No status changes.');
  }
  out.push('');
  out.push(`- regressions (pass→fail): ${diff.regressions.length}`);
  out.push(`- improvements (fail→pass): ${diff.improvements.length}`);
  out.push(`- other status changes (involving skip): ${diff.otherFlips.length}`);
  out.push(`- unchanged: ${diff.unchanged.length}`);
  out.push(`- new tasks: ${diff.newTasks.length}`);
  out.push(`- removed tasks: ${diff.removedTasks.length}`);
  if (diff.flaky.length > 0) {
    out.push(`- flaky in one or both runs: ${diff.flaky.length} — treat their flips as unproven`);
  }
  out.push('');

  out.push(...flipTable('Regressions', diff.regressions, maxReason));
  out.push(...flipTable('Improvements', diff.improvements, maxReason));
  out.push(...flipTable('Other status changes', diff.otherFlips, maxReason));

  if (diff.newTasks.length > 0) {
    out.push(`## New tasks (${diff.newTasks.length})`, '');
    for (const id of diff.newTasks) out.push(`- ${id}`);
    out.push('');
  }
  if (diff.removedTasks.length > 0) {
    out.push(`## Removed tasks (${diff.removedTasks.length})`, '');
    for (const id of diff.removedTasks) out.push(`- ${id}`);
    out.push('');
  }

  // Timing is inherently noisy; keep it out of the default (byte-stable) rendering.
  const deltas = options.includeTimings === true
    ? diff.metricDeltas
    : diff.metricDeltas.filter(d => d.metric !== 'durationMs');
  out.push(...metricTable(deltas.filter(d => d.delta !== 0)));

  return out.join('\n');
}
