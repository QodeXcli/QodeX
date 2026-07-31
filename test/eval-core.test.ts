import { describe, it, expect } from 'vitest';
import {
  runSuite, scoreResults, diffRuns, formatRunReport, formatDiffReport,
  type EvalRun, type EvalSuite, type EvalTask, type TaskOutcome, type TaskResult,
} from '../src/eval/index.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function task(
  id: string,
  status: 'pass' | 'fail' | 'skip',
  opts: Partial<Pick<EvalTask, 'category' | 'kind' | 'name' | 'timeoutMs'>> & {
    reason?: string; metrics?: Record<string, number>;
  } = {},
): EvalTask {
  return {
    id,
    name: opts.name ?? `task ${id}`,
    category: opts.category ?? 'general',
    kind: opts.kind ?? 'deterministic',
    timeoutMs: opts.timeoutMs,
    async run(): Promise<TaskOutcome> {
      return { status, reason: opts.reason, metrics: opts.metrics };
    },
  };
}

const suiteOf = (name: string, tasks: EvalTask[]): EvalSuite => ({ name, tasks });

/** A fake monotonic clock so runs are byte-reproducible. */
function fakeClock(step = 5) {
  let t = 1000;
  return () => (t += step);
}

const run = (suite: EvalSuite, opts: Parameters<typeof runSuite>[1] = {}) =>
  runSuite(suite, { now: fakeClock(), ...opts });

// ---------------------------------------------------------------------------
// scoring
// ---------------------------------------------------------------------------

describe('scoreResults — honest scoring', () => {
  it('scores a mixed pass/fail/skip suite with skips excluded from the denominator', async () => {
    const r = await run(suiteOf('mixed', [
      task('a', 'pass', { category: 'edit' }),
      task('b', 'pass', { category: 'edit' }),
      task('c', 'fail', { category: 'edit', reason: 'assert failed' }),
      task('d', 'skip', { category: 'tools', reason: 'no model configured' }),
    ]));

    expect(r.summary.total).toBe(4);
    expect(r.summary.passed).toBe(2);
    expect(r.summary.failed).toBe(1);
    expect(r.summary.skipped).toBe(1);
    // 2 passed / 3 scored — the skipped task is NOT in the denominator...
    expect(r.summary.scored).toBe(3);
    expect(r.summary.score0to100).toBeCloseTo(66.6667, 3);
    // ...and it is not silently a pass either.
    expect(r.summary.passed).not.toBe(3);
  });

  it('does NOT score 100 when every task skipped', async () => {
    const r = await run(suiteOf('all-skip', [
      task('a', 'skip', { reason: 'no API key' }),
      task('b', 'skip', { reason: 'binary missing' }),
      task('c', 'skip', { reason: 'unsupported platform' }),
    ]));

    expect(r.summary.skipped).toBe(3);
    expect(r.summary.passed).toBe(0);
    expect(r.summary.scored).toBe(0);
    expect(r.summary.score0to100).not.toBe(100);
    expect(r.summary.score0to100).toBe(0);
  });

  it('scores an empty result set as 0, not NaN', () => {
    const s = scoreResults([]);
    expect(s.score0to100).toBe(0);
    expect(Number.isNaN(s.score0to100)).toBe(false);
  });

  it('breaks the score down by category with sorted, stable keys', async () => {
    const r = await run(suiteOf('cats', [
      task('z1', 'pass', { category: 'zeta' }),
      task('a1', 'fail', { category: 'alpha' }),
      task('a2', 'pass', { category: 'alpha' }),
      task('m1', 'skip', { category: 'mu', reason: 'skipped' }),
    ]));

    expect(Object.keys(r.summary.byCategory)).toEqual(['alpha', 'mu', 'zeta']);
    expect(r.summary.byCategory.alpha.score0to100).toBe(50);
    expect(r.summary.byCategory.zeta.score0to100).toBe(100);
    // An all-skip category has an empty denominator — 0, never 100.
    expect(r.summary.byCategory.mu.scored).toBe(0);
    expect(r.summary.byCategory.mu.score0to100).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// runner isolation
// ---------------------------------------------------------------------------

describe('runSuite — isolation', () => {
  it('turns a throwing task into a fail and still runs the rest of the suite', async () => {
    const boom: EvalTask = {
      id: 'boom', name: 'explodes', category: 'general', kind: 'deterministic',
      async run() { throw new Error('kaboom'); },
    };
    const r = await run(suiteOf('throws', [task('before', 'pass'), boom, task('after', 'pass')]));

    expect(r.results.map(x => x.id)).toEqual(['before', 'boom', 'after']);
    const failed = r.results.find(x => x.id === 'boom')!;
    expect(failed.status).toBe('fail');
    expect(failed.reason).toContain('kaboom');
    expect(r.summary.passed).toBe(2);
    expect(r.summary.failed).toBe(1);
  });

  it('turns a synchronous throw (before any await) into a fail too', async () => {
    const sync: EvalTask = {
      id: 'sync-boom', name: 'sync throw', category: 'general', kind: 'deterministic',
      run() { throw new Error('sync kaboom'); },
    };
    const r = await run(suiteOf('sync', [sync]));
    expect(r.results[0].status).toBe('fail');
    expect(r.results[0].reason).toContain('sync kaboom');
  });

  it('treats a task that returns garbage as a fail, never a pass', async () => {
    const bad = [
      { id: 'undef', ret: undefined },
      { id: 'str', ret: 'ok' },
      { id: 'badstatus', ret: { status: 'ok' } },
    ].map(({ id, ret }) => ({
      id, name: id, category: 'general', kind: 'deterministic' as const,
      run: async () => ret as unknown as TaskOutcome,
    }));

    const r = await run(suiteOf('garbage', bad));
    expect(r.results.every(x => x.status === 'fail')).toBe(true);
    expect(r.summary.score0to100).toBe(0);
  });

  it('marks a hung task failed rather than hanging the run', async () => {
    const hang: EvalTask = {
      id: 'hang', name: 'never resolves', category: 'general', kind: 'deterministic',
      timeoutMs: 20,
      run: () => new Promise<TaskOutcome>(() => { /* never settles */ }),
    };
    const started = Date.now();
    const r = await run(suiteOf('timeout', [hang, task('next', 'pass')]));
    const elapsed = Date.now() - started;

    expect(r.results[0].status).toBe('fail');
    expect(r.results[0].reason).toContain('timed out after 20ms');
    // the run completed and later tasks still executed
    expect(r.results[1].status).toBe('pass');
    expect(elapsed).toBeLessThan(3000);
  });

  it('aborts the context signal when the timeout fires', async () => {
    let aborted = false;
    const t: EvalTask = {
      id: 'abortable', name: 'watches signal', category: 'general', kind: 'deterministic',
      timeoutMs: 20,
      run: (ctx) => new Promise<TaskOutcome>(() => {
        ctx.signal.addEventListener('abort', () => { aborted = true; });
      }),
    };
    await run(suiteOf('abort', [t]));
    expect(aborted).toBe(true);
  });

  it('rejects a suite with duplicate task ids (ids are the A/B join key)', async () => {
    await expect(run(suiteOf('dupes', [task('same', 'pass'), task('same', 'fail')])))
      .rejects.toThrow(/duplicate eval task id: same/);
  });

  it('filters by id, category and kind, preserving declaration order', async () => {
    const suite = suiteOf('filterable', [
      task('t1', 'pass', { category: 'edit', kind: 'deterministic' }),
      task('t2', 'pass', { category: 'tools', kind: 'deterministic' }),
      task('t3', 'pass', { category: 'edit', kind: 'e2e' }),
    ]);

    expect((await run(suite, { filter: { ids: ['t3', 't1'] } })).results.map(r => r.id)).toEqual(['t1', 't3']);
    expect((await run(suite, { filter: { categories: ['edit'] } })).results.map(r => r.id)).toEqual(['t1', 't3']);
    expect((await run(suite, { filter: { kinds: ['deterministic'] } })).results.map(r => r.id)).toEqual(['t1', 't2']);
  });

  it('passes the config through to tasks — the A/B knob', async () => {
    let seen: unknown = null;
    const probe: EvalTask = {
      id: 'probe', name: 'reads config', category: 'general', kind: 'deterministic',
      async run(ctx) { seen = ctx.config.compaction; return { status: 'pass' }; },
    };
    const r = await run(suiteOf('cfg', [probe]), { config: { compaction: 'aggressive' } });
    expect(seen).toBe('aggressive');
    expect(r.config).toEqual({ compaction: 'aggressive' });
  });

  it('captures ctx.log lines per attempt without affecting the score', async () => {
    const t: EvalTask = {
      id: 'chatty', name: 'logs', category: 'general', kind: 'deterministic',
      async run(ctx) { ctx.log('step one'); ctx.log('step two'); return { status: 'pass' }; },
    };
    const r = await run(suiteOf('logs', [t]));
    expect(r.results[0].attempts[0].logs).toEqual(['step one', 'step two']);
    expect(r.results[0].status).toBe('pass');
  });
});

// ---------------------------------------------------------------------------
// repetition + variance
// ---------------------------------------------------------------------------

describe('runSuite — repetition and variance', () => {
  it('repeat=3 runs each task 3 times and reports metric variance', async () => {
    const values = [10, 20, 30];
    const noisy: EvalTask = {
      id: 'noisy', name: 'noisy metric', category: 'general', kind: 'deterministic',
      async run(ctx) { return { status: 'pass', metrics: { tokens: values[ctx.repetition] } }; },
    };
    const r = await run(suiteOf('rep', [noisy]), { repeat: 3 });

    expect(r.repeat).toBe(3);
    expect(r.results[0].attempts).toHaveLength(3);
    expect(r.results[0].metrics.tokens).toBe(20);
    const v = r.results[0].variance.tokens;
    expect(v.samples).toBe(3);
    expect(v.min).toBe(10);
    expect(v.max).toBe(30);
    expect(v.stdev).toBeCloseTo(Math.sqrt(200 / 3), 6);
    // Deterministic across repeats -> not flaky.
    expect(r.results[0].flaky).toBe(false);
  });

  it('flags a task whose repetitions disagree, and scores it conservatively as a fail', async () => {
    const flip: EvalTask = {
      id: 'flip', name: 'flaky', category: 'general', kind: 'deterministic',
      async run(ctx) {
        return ctx.repetition === 1
          ? { status: 'fail', reason: 'flaked on repetition 2' }
          : { status: 'pass' };
      },
    };
    const r = await run(suiteOf('flaky', [flip]), { repeat: 3 });

    expect(r.results[0].statusCounts).toEqual({ pass: 2, fail: 1, skip: 0 });
    expect(r.results[0].flaky).toBe(true);
    // one failure among N is a failure — noise is surfaced, not averaged away
    expect(r.results[0].status).toBe('fail');
    expect(r.results[0].reason).toBe('flaked on repetition 2');
    expect(r.summary.flaky).toBe(1);
    expect(r.summary.score0to100).toBe(0);
  });

  it('reports zero stdev and no flakiness for a single repetition', async () => {
    const r = await run(suiteOf('single', [task('a', 'pass', { metrics: { tokens: 42 } })]));
    expect(r.results[0].variance.tokens.stdev).toBe(0);
    expect(r.results[0].variance.tokens.samples).toBe(1);
    expect(r.results[0].flaky).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A/B diff
// ---------------------------------------------------------------------------

describe('diffRuns — the A/B primitive', () => {
  const before = () => run(suiteOf('harness', [
    task('keep-pass', 'pass', { category: 'edit', metrics: { tokens: 100, costUsd: 0.02 } }),
    task('regress', 'pass', { category: 'edit', metrics: { tokens: 200 } }),
    task('improve', 'fail', { category: 'tools', reason: 'old harness lost the tool', metrics: { tokens: 300 } }),
    task('gone', 'pass', { category: 'tools' }),
    task('becomes-skip', 'pass', { category: 'ctx' }),
  ]));

  const after = () => run(suiteOf('harness', [
    task('keep-pass', 'pass', { category: 'edit', metrics: { tokens: 80, costUsd: 0.01 } }),
    task('regress', 'fail', { category: 'edit', reason: 'new compaction dropped the file', metrics: { tokens: 150 } }),
    task('improve', 'pass', { category: 'tools', metrics: { tokens: 250 } }),
    task('becomes-skip', 'skip', { category: 'ctx', reason: 'gated off in config B' }),
    task('brand-new', 'pass', { category: 'ctx' }),
  ]));

  it('detects regressions, improvements, new and removed tasks', async () => {
    const d = diffRuns(await before(), await after());

    expect(d.regressions.map(f => f.id)).toEqual(['regress']);
    expect(d.regressions[0].before).toBe('pass');
    expect(d.regressions[0].after).toBe('fail');
    expect(d.regressions[0].reason).toBe('new compaction dropped the file');

    expect(d.improvements.map(f => f.id)).toEqual(['improve']);
    expect(d.newTasks).toEqual(['brand-new']);
    expect(d.removedTasks).toEqual(['gone']);
    expect(d.unchanged).toEqual(['keep-pass']);
  });

  it('separates a pass→skip transition from a real regression', async () => {
    const d = diffRuns(await before(), await after());
    expect(d.otherFlips.map(f => f.id)).toEqual(['becomes-skip']);
    expect(d.otherFlips[0].kind).toBe('other');
    expect(d.regressions.map(f => f.id)).not.toContain('becomes-skip');
  });

  it('computes the score delta', async () => {
    const b = await before(); // 4 pass / 1 fail            => 80
    const a = await after();  // 3 pass / 1 fail (1 skipped) => 75
    expect(b.summary.score0to100).toBe(80);
    expect(a.summary.score0to100).toBe(75);
    expect(a.summary.skipped).toBe(1);
    expect(a.summary.scored).toBe(4); // the skip is out of the denominator
    const d = diffRuns(b, a);
    expect(d.scoreDelta).toBeCloseTo(a.summary.score0to100 - b.summary.score0to100, 6);
    expect(d.scoreDelta).toBeLessThan(0);
  });

  it('sums metric deltas over tasks common to both runs only', async () => {
    const d = diffRuns(await before(), await after());
    const tokens = d.metricDeltas.find(m => m.metric === 'tokens')!;
    // common tasks: keep-pass 100->80, regress 200->150, improve 300->250 (gone/brand-new excluded)
    expect(tokens.before).toBe(600);
    expect(tokens.after).toBe(480);
    expect(tokens.delta).toBe(-120);
    expect(tokens.pctChange).toBeCloseTo(-20, 6);

    const cost = d.metricDeltas.find(m => m.metric === 'costUsd')!;
    expect(cost.delta).toBeCloseTo(-0.01, 6);
  });

  it('reports pctChange as null instead of Infinity when the baseline is zero', async () => {
    const b = await run(suiteOf('s', [task('t', 'pass', { metrics: { tokens: 0 } })]));
    const a = await run(suiteOf('s', [task('t', 'pass', { metrics: { tokens: 50 } })]));
    const d = diffRuns(b, a);
    expect(d.metricDeltas.find(m => m.metric === 'tokens')!.pctChange).toBeNull();
  });

  it('flags tasks that were flaky in either run so their flips are not trusted', async () => {
    const flaky: EvalTask = {
      id: 'f', name: 'f', category: 'general', kind: 'deterministic',
      async run(ctx) { return ctx.repetition === 0 ? { status: 'pass' } : { status: 'fail', reason: 'noise' }; },
    };
    const b = await run(suiteOf('s', [task('f', 'pass')]));
    const a = await run(suiteOf('s', [flaky]), { repeat: 2 });
    expect(diffRuns(b, a).flaky).toEqual(['f']);
  });

  it('produces an empty diff for a run compared against itself', async () => {
    const r = await before();
    const d = diffRuns(r, r);
    expect(d.scoreDelta).toBe(0);
    expect(d.regressions).toEqual([]);
    expect(d.improvements).toEqual([]);
    expect(d.otherFlips).toEqual([]);
    expect(d.newTasks).toEqual([]);
    expect(d.removedTasks).toEqual([]);
    expect(d.metricDeltas.every(m => m.delta === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

describe('reports — deterministic rendering', () => {
  const mixed = () => suiteOf('harness', [
    task('a', 'pass', { category: 'edit', metrics: { tokens: 10 } }),
    task('b', 'fail', { category: 'edit', reason: 'expected 3 tool calls, saw 7' }),
    task('c', 'skip', { category: 'e2e', kind: 'e2e', reason: 'ANTHROPIC_API_KEY not set' }),
  ]);

  it('is byte-stable across two separate runs of the same suite', async () => {
    const r1 = await runSuite(mixed(), { now: fakeClock(3) });
    // different clock cadence => different wall times, identical report
    const r2 = await runSuite(mixed(), { now: fakeClock(97) });
    expect(r1.results[0].durationMs).not.toBe(r2.results[0].durationMs);
    expect(formatRunReport(r1)).toBe(formatRunReport(r2));
  });

  it('omits injected timestamps unless explicitly asked for', async () => {
    const r = await run(mixed(), { startedAt: '2026-07-31T00:00:00Z' });
    expect(formatRunReport(r)).not.toContain('2026-07-31');
    expect(formatRunReport(r, { includeTimestamp: true })).toContain('2026-07-31T00:00:00Z');
  });

  it('shows the skip reason and states that skips are not passes', async () => {
    const text = formatRunReport(await run(mixed()));
    expect(text).toContain('ANTHROPIC_API_KEY not set');
    expect(text).toContain('NOT counted as passes');
    expect(text).toContain('skips excluded from the denominator');
    expect(text).toContain('Score 50.0/100');
  });

  it('calls out an all-skip run instead of dressing it up as a score', async () => {
    const r = await run(suiteOf('all-skip', [task('x', 'skip', { reason: 'no model' })]));
    const text = formatRunReport(r);
    expect(text).toContain('Score 0.0/100');
    expect(text).toContain('nothing measurable ran');
  });

  it('renders a diff report that leads with regressions and is byte-stable', async () => {
    const mk = () => suiteOf('harness', [
      task('a', 'pass', { category: 'edit', metrics: { tokens: 10 } }),
      task('b', 'fail', { category: 'edit', reason: 'baseline failure', metrics: { tokens: 20 } }),
    ]);
    const mkAfter = () => suiteOf('harness', [
      task('a', 'fail', { category: 'edit', reason: 'broke under config B', metrics: { tokens: 12 } }),
      task('b', 'pass', { category: 'edit', metrics: { tokens: 20 } }),
    ]);

    const d1 = diffRuns(await runSuite(mk(), { now: fakeClock(1) }), await runSuite(mkAfter(), { now: fakeClock(1) }));
    const d2 = diffRuns(await runSuite(mk(), { now: fakeClock(64) }), await runSuite(mkAfter(), { now: fakeClock(64) }));
    const text = formatDiffReport(d1);

    expect(text).toBe(formatDiffReport(d2));
    expect(text).toContain('1 REGRESSION(S)');
    expect(text).toContain('broke under config B');
    expect(text).toContain('## Improvements (1)');
    // score is flat (1/2 both sides) yet two tasks churned — exactly the case a bare
    // score would hide
    expect(d1.scoreDelta).toBe(0);
    expect(text).toContain('Score 50.0 → 50.0 (0.0)');
    expect(text).toContain('| tokens | 30 | 32 | +2 |');
  });

  it('surfaces a variance table when repetitions disagree on a metric', async () => {
    const noisy: EvalTask = {
      id: 'n', name: 'n', category: 'general', kind: 'deterministic',
      async run(ctx) { return { status: 'pass', metrics: { tokens: 100 + ctx.repetition * 10 } }; },
    };
    const text = formatRunReport(await run(suiteOf('s', [noisy]), { repeat: 3 }));
    expect(text).toContain('## Variance across repetitions');
    expect(text).toContain('| n | tokens | 110 | 100 | 120 |');
    expect(text).toContain('repetitions per task: 3');
  });
});

// ---------------------------------------------------------------------------
// end-to-end shape check
// ---------------------------------------------------------------------------

describe('EvalRun shape', () => {
  it('carries the suite name, config, repeat count and per-task results', async () => {
    const r: EvalRun = await run(suiteOf('shape', [task('a', 'pass', { category: 'edit', kind: 'e2e' })]), {
      config: { model: 'fake' },
      repeat: 2,
    });
    expect(r.suite).toBe('shape');
    expect(r.config).toEqual({ model: 'fake' });
    expect(r.repeat).toBe(2);
    const t: TaskResult = r.results[0];
    expect(t).toMatchObject({ id: 'a', name: 'task a', category: 'edit', kind: 'e2e', status: 'pass' });
    expect(t.attempts).toHaveLength(2);
  });
});
