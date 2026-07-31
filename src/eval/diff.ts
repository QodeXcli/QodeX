/**
 * Eval core — the A/B primitive.
 *
 * This is the module the whole effort exists for. Running a suite and getting a number
 * tells you almost nothing; running the SAME suite under two harness configurations and
 * seeing WHICH tasks flipped, and what it cost, is what turns a harness change from a
 * guess into a decision.
 *
 * The important output is not `scoreDelta` — it's `regressions`. An aggregate score can
 * stay flat while a change breaks three tasks and fixes three others, and that is a very
 * different situation from "no effect". So flips are enumerated by id, always.
 *
 * Pure and deterministic: no clock, no I/O, stable ordering (by task id).
 */

import type { EvalRun, ScoreSummary, TaskResult, TaskStatus } from './types.js';

/** Regression = pass → fail. Improvement = fail → pass. Everything else is `other`. */
export type FlipKind = 'regression' | 'improvement' | 'other';

export interface TaskFlip {
  id: string;
  name: string;
  category: string;
  before: TaskStatus;
  after: TaskStatus;
  kind: FlipKind;
  /** The `after` run's reason — why it is in its new state. */
  reason?: string;
}

export interface MetricDelta {
  metric: string;
  before: number;
  after: number;
  delta: number;
  /** null when `before` is 0 — a percentage against zero is meaningless, not Infinity. */
  pctChange: number | null;
}

export interface TaskMetricDelta {
  id: string;
  deltas: MetricDelta[];
}

export interface RunSide {
  suite: string;
  summary: ScoreSummary;
}

export interface RunDiff {
  before: RunSide;
  after: RunSide;
  /** after.score0to100 - before.score0to100. Positive is better. */
  scoreDelta: number;
  /** pass → fail. The number that should block a harness change. */
  regressions: TaskFlip[];
  /** fail → pass. */
  improvements: TaskFlip[];
  /**
   * Flips involving `skip`. Broken out because "it stopped being measurable" is NOT the
   * same event as "it broke", and conflating the two is how a harness lies to you.
   */
  otherFlips: TaskFlip[];
  /** Tasks present in both runs whose status did not change. */
  unchanged: string[];
  /** Ids only in `after`. Not counted as improvements — they have no baseline. */
  newTasks: string[];
  /** Ids only in `before`. Not counted as regressions — they were removed, not broken. */
  removedTasks: string[];
  /** Metric totals summed over tasks COMMON to both runs (so adds/removes can't skew it). */
  metricDeltas: MetricDelta[];
  /** Per-task metric movement, for the tasks common to both runs. */
  byTask: TaskMetricDelta[];
  /** Tasks that were flaky in either run — the caller should distrust their flips. */
  flaky: string[];
}

function pct(before: number, after: number): number | null {
  if (before === 0) return null;
  return ((after - before) / Math.abs(before)) * 100;
}

function classify(before: TaskStatus, after: TaskStatus): FlipKind {
  if (before === 'pass' && after === 'fail') return 'regression';
  if (before === 'fail' && after === 'pass') return 'improvement';
  return 'other';
}

function index(results: TaskResult[]): Map<string, TaskResult> {
  const m = new Map<string, TaskResult>();
  for (const r of results) m.set(r.id, r);
  return m;
}

/**
 * Compare two runs of (ideally) the same suite. Tasks are joined by `id`; nothing is
 * inferred from ordering, so a reordered or partially-filtered suite still diffs cleanly.
 */
export function diffRuns(before: EvalRun, after: EvalRun): RunDiff {
  const b = index(before.results);
  const a = index(after.results);

  const regressions: TaskFlip[] = [];
  const improvements: TaskFlip[] = [];
  const otherFlips: TaskFlip[] = [];
  const unchanged: string[] = [];
  const flaky: string[] = [];
  const byTask: TaskMetricDelta[] = [];

  const beforeTotals: Record<string, number> = {};
  const afterTotals: Record<string, number> = {};

  const commonIds = [...a.keys()].filter(id => b.has(id)).sort();

  for (const id of commonIds) {
    const br = b.get(id)!;
    const ar = a.get(id)!;

    if (br.flaky || ar.flaky) flaky.push(id);

    if (br.status === ar.status) {
      unchanged.push(id);
    } else {
      const flip: TaskFlip = {
        id,
        name: ar.name,
        category: ar.category,
        before: br.status,
        after: ar.status,
        kind: classify(br.status, ar.status),
        reason: ar.reason,
      };
      if (flip.kind === 'regression') regressions.push(flip);
      else if (flip.kind === 'improvement') improvements.push(flip);
      else otherFlips.push(flip);
    }

    // Metric movement. `durationMs` is measured by the runner rather than reported by
    // the task, so fold it in explicitly — cost/latency regressions matter as much as
    // correctness ones when judging a harness change.
    const keys = new Set([
      ...Object.keys(br.metrics), ...Object.keys(ar.metrics),
      'durationMs',
    ]);
    const deltas: MetricDelta[] = [];
    for (const key of [...keys].sort()) {
      const bv = key === 'durationMs' && br.metrics[key] === undefined ? br.durationMs : (br.metrics[key] ?? 0);
      const av = key === 'durationMs' && ar.metrics[key] === undefined ? ar.durationMs : (ar.metrics[key] ?? 0);
      beforeTotals[key] = (beforeTotals[key] ?? 0) + bv;
      afterTotals[key] = (afterTotals[key] ?? 0) + av;
      if (bv !== av) deltas.push({ metric: key, before: bv, after: av, delta: av - bv, pctChange: pct(bv, av) });
    }
    if (deltas.length) byTask.push({ id, deltas });
  }

  const metricDeltas: MetricDelta[] = [];
  for (const key of Object.keys(beforeTotals).sort()) {
    const bv = beforeTotals[key];
    const av = afterTotals[key] ?? 0;
    metricDeltas.push({ metric: key, before: bv, after: av, delta: av - bv, pctChange: pct(bv, av) });
  }

  const byId = (x: TaskFlip, y: TaskFlip) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
  regressions.sort(byId);
  improvements.sort(byId);
  otherFlips.sort(byId);

  return {
    before: { suite: before.suite, summary: before.summary },
    after: { suite: after.suite, summary: after.summary },
    scoreDelta: after.summary.score0to100 - before.summary.score0to100,
    regressions,
    improvements,
    otherFlips,
    unchanged,
    newTasks: [...a.keys()].filter(id => !b.has(id)).sort(),
    removedTasks: [...b.keys()].filter(id => !a.has(id)).sort(),
    metricDeltas,
    byTask,
    flaky: flaky.sort(),
  };
}
