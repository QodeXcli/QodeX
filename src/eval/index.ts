/**
 * QodeX eval harness — public surface.
 *
 * Layer (a): deterministic tasks — free, offline, CI-fast. The default.
 * Layer (b): e2e tasks — drive a real model. Opt-in, noisy, run occasionally.
 *
 * The whole point is `diffRuns`: run the same suite under two harness configurations
 * and see which tasks flipped. Optimizing a harness without that comparison is the
 * problem this subsystem was built to solve.
 */

export type {
  CategoryScore, EvalContext, EvalRun, EvalSuite, EvalTask,
  MetricStats, ScoreSummary, TaskAttempt, TaskKind, TaskOutcome,
  TaskResult, TaskStatus,
} from './types.js';

export { runSuite } from './runner.js';
export type { EvalFilter, RunSuiteOptions } from './runner.js';

export { scoreResults } from './score.js';

export { diffRuns } from './diff.js';
export type { FlipKind, MetricDelta, RunDiff, RunSide, TaskFlip, TaskMetricDelta } from './diff.js';

export { formatDiffReport, formatRunReport } from './report.js';
export type { ReportOptions } from './report.js';

// Suites. `harness` is layer (a) — free, offline, deterministic; feed it straight to
// `runSuite`. Suites are BUILT on demand so importing this module stays cheap.
export { getSuite, listSuites, SUITES } from './suites/index.js';
export type { SuiteEntry } from './suites/index.js';
export {
  createHarnessSuite, harnessSuite, realProbes,
  CONTRADICTION_PAIRS, DEFAULT_BUDGETS, GATING_SCENARIOS,
} from './suites/harness.js';
export type {
  ContradictionPair, GatingScenario, HarnessBudgets,
  HarnessProbes, HarnessSuiteOptions, PruneProbe,
} from './suites/harness.js';

// Legacy JSON-task harness (eval/run.mjs + eval/tasks/*.json) — still in use.
export { evaluateChecks, formatReport, summarize } from './score.js';
export type {
  CheckResult, CommandCheck, EvalCheck, EvalSummary, FileContentCheck,
  LegacyEvalTask, Outcome, TaskRunResult,
} from './score.js';
