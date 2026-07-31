/**
 * Eval core — schema.
 *
 * WHY THIS EXISTS: QodeX has a large agent harness (prompt tiering, ~129 gated tools,
 * compaction/aging/dedup, cache layout, verification gates, critic, sub-agents) and,
 * until now, no way to tell whether a harness change made the agent BETTER or WORSE.
 * Every optimization was a guess. This schema is the vocabulary for measuring it.
 *
 * Two kinds of task live in the same schema on purpose:
 *   - `deterministic` — asserts a harness property with NO LLM at all. Free, fast,
 *     CI-able, and where most of the durable value is.
 *   - `e2e` — drives a real model on a real task. Slow, noisy, opt-in.
 * Keeping them in one schema is what lets a single runner, scorer, and A/B diff serve
 * both layers.
 *
 * HONESTY RULE baked into the types: `skip` is a first-class status, distinct from
 * `pass`. A task that could not be measured (no model, missing binary, unsupported
 * platform) MUST report `skip` with a reason — never `pass`. The scorer excludes skips
 * from the denominator so a suite that skipped everything scores 0, not 100.
 */

/** Outcome of a single task. `skip` is NEVER a pass — see the honesty rule above. */
export type TaskStatus = 'pass' | 'fail' | 'skip';

/**
 * `deterministic` = no LLM, runs free in CI.
 * `e2e` = drives a real model; noisy, opt-in, costs money.
 */
export type TaskKind = 'deterministic' | 'e2e';

/** What a task is handed when it runs. */
export interface EvalContext {
  /** Aborted when the per-task timeout elapses. Long-running tasks should honor it. */
  signal: AbortSignal;
  /** 0-based repetition index; > 0 only when the runner was asked to `repeat`. */
  repetition: number;
  /**
   * The knobs being varied. THIS is the A/B primitive at the task level: run the same
   * suite twice with two configs, then `diffRuns` the two `EvalRun`s.
   */
  config: Readonly<Record<string, unknown>>;
  /** Free-form diagnostic sink. Captured per attempt; never affects scoring. */
  log(message: string): void;
}

/** What a task reports back. */
export interface TaskOutcome {
  status: TaskStatus;
  /** Short, one-line why. REQUIRED in spirit for `fail` and `skip`. */
  reason?: string;
  /** Longer evidence (diff, output excerpt, stack). Not used for scoring. */
  detail?: string;
  /** Numeric observations — tokens, cost, bytes, tool calls. Diffed across runs. */
  metrics?: Record<string, number>;
}

export interface EvalTask {
  /** Stable, unique within the suite. This is the join key for A/B diffs. */
  id: string;
  name: string;
  category: string;
  kind: TaskKind;
  /** Overrides the runner's default per-task timeout. */
  timeoutMs?: number;
  run(ctx: EvalContext): Promise<TaskOutcome>;
}

export interface EvalSuite {
  name: string;
  tasks: EvalTask[];
}

/** One execution of a task. With `repeat: N` there are N of these per task. */
export interface TaskAttempt {
  status: TaskStatus;
  reason?: string;
  detail?: string;
  metrics: Record<string, number>;
  durationMs: number;
  /** Lines the task emitted via `ctx.log`. */
  logs: string[];
}

/** Mean/spread for one metric across repetitions. Variance is REPORTED, never hidden. */
export interface MetricStats {
  mean: number;
  min: number;
  max: number;
  /** Population standard deviation. 0 when there is a single sample. */
  stdev: number;
  samples: number;
}

export interface TaskResult {
  id: string;
  name: string;
  category: string;
  kind: TaskKind;
  /**
   * Aggregate across attempts, conservatively:
   *   any attempt failed  -> 'fail'
   *   else any passed     -> 'pass'
   *   else                -> 'skip'
   */
  status: TaskStatus;
  reason?: string;
  detail?: string;
  attempts: TaskAttempt[];
  /** Per-status attempt counts — the honest view of a flaky task. */
  statusCounts: Record<TaskStatus, number>;
  /** True when attempts disagreed. A flaky task is a measurement warning, not a pass. */
  flaky: boolean;
  /** Mean of each metric across attempts that reported it. */
  metrics: Record<string, number>;
  /** Spread of each metric across attempts. Empty when `repeat` is 1. */
  variance: Record<string, MetricStats>;
  /** Mean wall time across attempts. Never included in byte-stable reports. */
  durationMs: number;
}

export interface CategoryScore {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  /** passed + failed — the honest denominator. */
  scored: number;
  score0to100: number;
}

export interface ScoreSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  /** passed + failed. Skips are EXCLUDED — an all-skip suite has scored === 0. */
  scored: number;
  /** 100 * passed / scored, or 0 when nothing was measurable. Never 100 on all-skip. */
  score0to100: number;
  /** Number of tasks whose repetitions disagreed. */
  flaky: number;
  byCategory: Record<string, CategoryScore>;
}

export interface EvalRun {
  suite: string;
  /** Injected, not read from the clock — keeps reports byte-stable when omitted. */
  startedAt?: string;
  /** The configuration this run was executed under. The "A" or the "B". */
  config?: Record<string, unknown>;
  repeat: number;
  results: TaskResult[];
  summary: ScoreSummary;
}
