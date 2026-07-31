/**
 * Eval core — the isolating runner.
 *
 * Contract, in priority order:
 *  1. A task can NEVER take the run down. A throw, a rejected promise, a bogus return
 *     value, or a hang all become a `fail` on that task; the suite keeps going.
 *  2. Deterministic ordering — results come back in declared suite order, always.
 *  3. Repetition with honest variance — `repeat: N` runs each task N times and reports
 *     the spread instead of averaging the noise away.
 *  4. No hidden clock. The caller injects `now` and `startedAt`, so a run can be made
 *     byte-reproducible for report snapshots.
 */

import type {
  EvalContext, EvalRun, EvalSuite, EvalTask, MetricStats,
  TaskAttempt, TaskKind, TaskOutcome, TaskResult, TaskStatus,
} from './types.js';
import { scoreResults } from './score.js';

export interface EvalFilter {
  /** Exact task ids to keep. */
  ids?: string[];
  categories?: string[];
  kinds?: TaskKind[];
}

export interface RunSuiteOptions {
  /** Runs per task. Default 1. Values < 1 are clamped to 1. */
  repeat?: number;
  /**
   * Default per-task timeout in ms. Default 30_000. `0`/`Infinity` disables it — and
   * with it disabled a hung task really does hang the run, so that is an explicit
   * caller decision, not the default.
   */
  timeoutMs?: number;
  filter?: EvalFilter;
  /** The configuration under test — echoed into the run so A/B diffs are self-describing. */
  config?: Record<string, unknown>;
  /** Injected timestamp. Omit for a byte-stable run. */
  startedAt?: string;
  /** Injected clock (ms). Defaults to `Date.now`. */
  now?: () => number;
  onTaskStart?(task: EvalTask): void;
  onTaskEnd?(result: TaskResult): void;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const VALID_STATUSES = new Set<TaskStatus>(['pass', 'fail', 'skip']);

function errText(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  try { return JSON.stringify(err); } catch { return String(err); }
}

/** Keep only finite numbers — a NaN metric would poison every downstream mean. */
function sanitizeMetrics(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/**
 * Coerce whatever a task returned into a trustworthy outcome. A task that returns
 * `undefined`, a string, or `{status:'ok'}` is a broken task — that is a FAIL, not a
 * silent pass. Scoring integrity depends on this being strict.
 */
function normalizeOutcome(raw: unknown): TaskOutcome {
  if (!raw || typeof raw !== 'object') {
    return { status: 'fail', reason: `task returned no outcome (got ${raw === undefined ? 'undefined' : typeof raw})` };
  }
  const o = raw as Partial<TaskOutcome>;
  if (!o.status || !VALID_STATUSES.has(o.status)) {
    return { status: 'fail', reason: `task returned invalid status ${JSON.stringify(o.status)}` };
  }
  const out: TaskOutcome = { status: o.status, metrics: sanitizeMetrics(o.metrics) };
  if (typeof o.reason === 'string' && o.reason) out.reason = o.reason;
  if (typeof o.detail === 'string' && o.detail) out.detail = o.detail;
  return out;
}

function applyFilter(tasks: EvalTask[], filter?: EvalFilter): EvalTask[] {
  if (!filter) return tasks.slice();
  const ids = filter.ids && filter.ids.length ? new Set(filter.ids) : null;
  const cats = filter.categories && filter.categories.length ? new Set(filter.categories) : null;
  const kinds = filter.kinds && filter.kinds.length ? new Set<TaskKind>(filter.kinds) : null;
  return tasks.filter(t =>
    (!ids || ids.has(t.id)) &&
    (!cats || cats.has(t.category)) &&
    (!kinds || kinds.has(t.kind)));
}

function statsFor(samples: number[]): MetricStats {
  const n = samples.length;
  const mean = samples.reduce((a, b) => a + b, 0) / n;
  let min = samples[0];
  let max = samples[0];
  for (const s of samples) { if (s < min) min = s; if (s > max) max = s; }
  const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return { mean, min, max, stdev: Math.sqrt(variance), samples: n };
}

/**
 * Run one attempt with a hard timeout. The timeout resolves the race rather than
 * rejecting, so a hung task is recorded as a FAILED task and the suite proceeds —
 * a hang must never be indistinguishable from an infinite wait.
 */
async function runAttempt(
  task: EvalTask,
  ctx: Omit<EvalContext, 'signal'>,
  timeoutMs: number,
  now: () => number,
): Promise<{ outcome: TaskOutcome; durationMs: number }> {
  const controller = new AbortController();
  const start = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  const bounded: Promise<TaskOutcome>[] = [];
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    bounded.push(new Promise<TaskOutcome>(resolve => {
      timer = setTimeout(() => {
        timedOut = true;
        try { controller.abort(); } catch { /* AbortController is best-effort */ }
        resolve({ status: 'fail', reason: `timed out after ${timeoutMs}ms` });
      }, timeoutMs);
      // DO NOT unref() this timer. A deterministic (layer-a) task that hangs has no I/O
      // of its own keeping the event loop alive, so an unref'd timer would let Node exit
      // BEFORE the timeout fires: runSuite never settles, no report is printed, and CI
      // reads the exit code 0 as success. The timer is always cleared in `finally`, so
      // holding the loop open costs at most `timeoutMs`.
    }));
  }

  let outcome: TaskOutcome;
  try {
    // Promise.resolve() inside the try so a SYNCHRONOUS throw from run() is caught too.
    const invoked = Promise.resolve(task.run({ ...ctx, signal: controller.signal }));
    // Swallow a late rejection after a timeout won the race: the attempt is already
    // recorded, and an unhandled rejection would crash the host process.
    invoked.catch(() => { /* handled below or already superseded by the timeout */ });
    outcome = normalizeOutcome(await (bounded.length ? Promise.race([invoked, ...bounded]) : invoked));
  } catch (err) {
    outcome = timedOut
      ? { status: 'fail', reason: `timed out after ${timeoutMs}ms` }
      : { status: 'fail', reason: `threw: ${errText(err)}`, detail: err instanceof Error && err.stack ? err.stack : undefined };
  } finally {
    if (timer) clearTimeout(timer);
  }

  return { outcome, durationMs: Math.max(0, now() - start) };
}

/**
 * Conservative aggregation, in priority order:
 *   1. any attempt failed                 -> 'fail'  (noise is never averaged away)
 *   2. attempts mix 'pass' and 'skip'     -> 'skip'  (see below)
 *   3. any attempt passed                 -> 'pass'
 *   4. otherwise                          -> 'skip'
 *
 * Rule 2 is a deliberate decision, not a fallout of the ordering. "It passed once and was
 * unmeasurable the other two times" is not a trustworthy pass, and crediting it would be
 * the same sin as scoring a skip as a pass. Reporting it as a skip removes it from BOTH
 * the numerator and the denominator, so it neither flatters nor penalises the run; the
 * pass is still fully visible in `statusCounts` and `flaky`.
 */
function aggregateStatus(counts: Record<TaskStatus, number>): TaskStatus {
  if (counts.fail > 0) return 'fail';
  if (counts.pass > 0 && counts.skip > 0) return 'skip';
  if (counts.pass > 0) return 'pass';
  return 'skip';
}

export async function runSuite(suite: EvalSuite, options: RunSuiteOptions = {}): Promise<EvalRun> {
  const now = options.now ?? (() => Date.now());
  const repeat = Math.max(1, Math.floor(options.repeat ?? 1));
  const defaultTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Frozen shallow COPY: `config` is the label that says which A/B arm this run belongs
  // to. Handing tasks the caller's own object let a task mutate it, contaminating every
  // later task, the emitted `run.config`, and the caller's variable — a run could end up
  // self-describing as the wrong arm. Freezing makes the write throw (ESM is strict), so
  // the offending task fails loudly instead of corrupting the comparison.
  const config = Object.freeze({ ...(options.config ?? {}) });

  const seen = new Set<string>();
  for (const t of suite.tasks) {
    if (seen.has(t.id)) throw new Error(`duplicate eval task id: ${t.id}`);
    seen.add(t.id);
  }

  const tasks = applyFilter(suite.tasks, options.filter);
  const results: TaskResult[] = [];

  for (const task of tasks) {
    options.onTaskStart?.(task);
    const attempts: TaskAttempt[] = [];
    const timeoutMs = task.timeoutMs ?? defaultTimeout;

    for (let i = 0; i < repeat; i++) {
      const logs: string[] = [];
      const { outcome, durationMs } = await runAttempt(
        task,
        { repetition: i, config, log: (m: string) => { logs.push(String(m)); } },
        timeoutMs,
        now,
      );
      attempts.push({
        status: outcome.status,
        reason: outcome.reason,
        detail: outcome.detail,
        metrics: outcome.metrics ?? {},
        durationMs,
        logs,
      });
    }

    const statusCounts: Record<TaskStatus, number> = { pass: 0, fail: 0, skip: 0 };
    for (const a of attempts) statusCounts[a.status]++;
    const status = aggregateStatus(statusCounts);

    // Surface the reason from an attempt that matches the aggregate verdict, so a
    // 'fail' result explains the failure rather than quoting a passing repetition.
    const representative = attempts.find(a => a.status === status) ?? attempts[0];

    // A pass/skip mix aggregates to 'skip' (see aggregateStatus). Say so explicitly —
    // a bare 'skip' would hide that the task did pass at least once.
    const partlyUnmeasurable = statusCounts.fail === 0 && statusCounts.pass > 0 && statusCounts.skip > 0;
    const reason = partlyUnmeasurable
      ? `unmeasurable in ${statusCounts.skip}/${attempts.length} repetition(s)${representative?.reason ? `: ${representative.reason}` : ''} — ${statusCounts.pass} passed, not counted as a pass`
      : representative?.reason;

    const metricSamples: Record<string, number[]> = {};
    for (const a of attempts) {
      for (const [k, v] of Object.entries(a.metrics)) (metricSamples[k] ||= []).push(v);
    }
    const metrics: Record<string, number> = {};
    const variance: Record<string, MetricStats> = {};
    for (const key of Object.keys(metricSamples).sort()) {
      const st = statsFor(metricSamples[key]);
      metrics[key] = st.mean;
      variance[key] = st;
    }

    const flaky = attempts.length > 1 && new Set(attempts.map(a => a.status)).size > 1;
    const result: TaskResult = {
      id: task.id,
      name: task.name,
      category: task.category,
      kind: task.kind,
      status,
      reason,
      detail: representative?.detail,
      attempts,
      statusCounts,
      flaky,
      metrics,
      variance,
      durationMs: attempts.reduce((a, b) => a + b.durationMs, 0) / (attempts.length || 1),
    };
    results.push(result);
    options.onTaskEnd?.(result);
  }

  return {
    suite: suite.name,
    startedAt: options.startedAt,
    config,
    repeat,
    results,
    summary: scoreResults(results),
  };
}
