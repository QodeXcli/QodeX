import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
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

  /**
   * REGRESSION GUARD (the timer must stay ref'd).
   *
   * The in-process test above cannot catch the real failure mode: vitest's own event loop
   * keeps the process alive, so an unref'd timeout timer still fires there. In a bare
   * `node script` — exactly how CI runs a suite of deterministic, I/O-free tasks — an
   * unref'd timer is the ONLY pending handle, so Node exits before it fires: runSuite
   * never settles, no report is printed, and the exit code is 0. A green CI over a run
   * that never happened is the worst possible failure for this subsystem, so it is
   * asserted in a real child process.
   */
  it('does not let the process exit before a hung task times out (real child process)', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const dir = mkdtempSync(path.join(tmpdir(), 'qodex-eval-hang-'));
    const script = path.join(dir, 'hang.mts');
    writeFileSync(script, [
      `import { runSuite } from ${JSON.stringify(path.join(root, 'src/eval/index.js'))};`,
      `process.stdout.write('START\\n');`,
      // Deliberately NOT top-level await: with an unref'd timer this process exits 0
      // and silently prints nothing more.
      `runSuite({ name: 'hang', tasks: [`,
      `  { id: 'hang', name: 'hangs', category: 'g', kind: 'deterministic', timeoutMs: 300,`,
      `    run: () => new Promise(() => {}) },`,
      `  { id: 'next', name: 'next', category: 'g', kind: 'deterministic',`,
      `    run: async () => ({ status: 'pass' as const }) },`,
      `] }).then(r => {`,
      `  process.stdout.write('FINISHED ' + r.results.map(x => x.id + ':' + x.status + ':' + (x.reason ?? '')).join(' | ') + '\\n');`,
      `});`,
    ].join('\n'));

    const { stdout } = await promisify(execFile)(
      process.execPath,
      [path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), script],
      { cwd: root, timeout: 60_000, encoding: 'utf-8' },
    );

    expect(stdout).toContain('START');
    // The load-bearing assertion: the run actually finished instead of the process
    // evaporating at exit code 0.
    expect(stdout).toContain('FINISHED');
    expect(stdout).toContain('hang:fail:timed out after 300ms');
    expect(stdout).toContain('next:pass');
  }, 90_000);

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

  it('isolates config: a task cannot rewrite the arm it (or any later task) is running under', async () => {
    const saboteur: EvalTask = {
      id: 'saboteur', name: 'mutates config', category: 'general', kind: 'deterministic',
      async run(ctx) {
        (ctx.config as Record<string, unknown>).compaction = 'HACKED';
        return { status: 'pass' };
      },
    };
    let seenByVictim: unknown = null;
    const victim: EvalTask = {
      id: 'victim', name: 'reads config', category: 'general', kind: 'deterministic',
      async run(ctx) { seenByVictim = ctx.config.compaction; return { status: 'pass' }; },
    };

    const callerConfig = { compaction: 'aggressive' };
    const r = await run(suiteOf('cfg-isolation', [saboteur, victim]), { config: callerConfig });

    // the write throws (frozen + ESM strict mode) => the offending task fails loudly
    expect(r.results[0].status).toBe('fail');
    expect(r.results[0].reason).toMatch(/threw:/);
    // ...and nothing downstream is contaminated
    expect(seenByVictim).toBe('aggressive');
    expect(r.config).toEqual({ compaction: 'aggressive' });
    expect(callerConfig).toEqual({ compaction: 'aggressive' });
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
    // variance is ALWAYS populated, including at repeat: 1 (samples 1, stdev 0) — the
    // schema comment used to claim it was empty here.
    expect(Object.keys(r.results[0].variance)).toEqual(['tokens']);
    expect(r.results[0].variance.tokens.stdev).toBe(0);
    expect(r.results[0].variance.tokens.samples).toBe(1);
    expect(r.results[0].variance.tokens.mean).toBe(42);
    expect(r.results[0].flaky).toBe(false);
  });

  it('does NOT credit a pass when other repetitions were unmeasurable', async () => {
    const partly: EvalTask = {
      id: 'partly', name: 'passes once, skips twice', category: 'e2e', kind: 'e2e',
      async run(ctx) {
        return ctx.repetition === 0
          ? { status: 'pass' }
          : { status: 'skip', reason: 'rate limited' };
      },
    };
    const r = await run(suiteOf('mixed-skip', [partly, task('solid', 'pass')]), { repeat: 3 });

    expect(r.results[0].statusCounts).toEqual({ pass: 1, fail: 0, skip: 2 });
    // 1 pass + 2 skips is NOT a clean pass; it is unmeasurable, so it leaves the score.
    expect(r.results[0].status).toBe('skip');
    expect(r.results[0].flaky).toBe(true);
    // and it says so rather than presenting a bare, unexplained skip
    expect(r.results[0].reason).toContain('unmeasurable in 2/3 repetition(s)');
    expect(r.results[0].reason).toContain('rate limited');
    expect(r.results[0].reason).toContain('1 passed, not counted as a pass');
    // excluded from BOTH numerator and denominator: it neither flatters nor penalises
    expect(r.summary.skipped).toBe(1);
    expect(r.summary.scored).toBe(1);
    expect(r.summary.score0to100).toBe(100);
  });

  it('still reports a clean pass when every repetition passed', async () => {
    const r = await run(suiteOf('clean', [task('a', 'pass')]), { repeat: 3 });
    expect(r.results[0].statusCounts).toEqual({ pass: 3, fail: 0, skip: 0 });
    expect(r.results[0].status).toBe('pass');
    expect(r.summary.score0to100).toBe(100);
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
    // NOTE: the removed/added tasks carry LARGE metrics on purpose — if the diff ever
    // folded non-common tasks into the totals, the numbers below would move visibly.
    task('gone', 'pass', { category: 'tools', metrics: { tokens: 9000, costUsd: 7 } }),
    task('becomes-skip', 'pass', { category: 'ctx' }),
  ]));

  const after = () => run(suiteOf('harness', [
    task('keep-pass', 'pass', { category: 'edit', metrics: { tokens: 80, costUsd: 0.01 } }),
    task('regress', 'fail', { category: 'edit', reason: 'new compaction dropped the file', metrics: { tokens: 150 } }),
    task('improve', 'pass', { category: 'tools', metrics: { tokens: 250 } }),
    task('becomes-skip', 'skip', { category: 'ctx', reason: 'gated off in config B' }),
    task('brand-new', 'pass', { category: 'ctx', metrics: { tokens: 5000, costUsd: 3 } }),
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
    // common tasks: keep-pass 100->80, regress 200->150, improve 300->250.
    // `gone` (9000) and `brand-new` (5000) must NOT appear anywhere in these totals —
    // they carry metrics precisely so that including them would break this assertion.
    expect(tokens.before).toBe(600);
    expect(tokens.after).toBe(480);
    expect(tokens.delta).toBe(-120);
    expect(tokens.pctChange).toBeCloseTo(-20, 6);

    const cost = d.metricDeltas.find(m => m.metric === 'costUsd')!;
    expect(cost.before).toBeCloseTo(0.02, 6); // not 7.02 (gone), not 3.02 (brand-new)
    expect(cost.after).toBeCloseTo(0.01, 6);
    expect(cost.delta).toBeCloseTo(-0.01, 6);
    expect(d.byTask.map(t => t.id)).not.toContain('gone');
    expect(d.byTask.map(t => t.id)).not.toContain('brand-new');
  });

  it('treats a metric that stopped being reported as unreported, never as a drop to zero', async () => {
    const b = await run(suiteOf('s', [task('t', 'pass', { metrics: { tokens: 100 } })]));
    // instrumentation broke in the B arm: the task reports no tokens at all
    const a = await run(suiteOf('s', [task('t', 'pass')]));
    const d = diffRuns(b, a);

    const perTask = d.byTask.find(t => t.id === 't')!.deltas.find(m => m.metric === 'tokens')!;
    expect(perTask.before).toBe(100);
    expect(perTask.after).toBeNull();      // NOT 0
    expect(perTask.delta).toBeNull();      // NOT -100
    expect(perTask.pctChange).toBeNull();  // NOT a phantom -100% "saving"
    expect(perTask.unreported).toBe('after');

    const total = d.metricDeltas.find(m => m.metric === 'tokens')!;
    expect(total.before).toBeNull();
    expect(total.after).toBeNull();
    expect(total.delta).toBeNull();
    expect(total.unreportedTasks).toBe(1);

    const text = formatDiffReport(d);
    expect(text).toContain('| tokens | unreported | unreported | n/a |');
    expect(text).toContain('reported this in only one run');
    expect(text).not.toContain('-100.0%');
  });

  it('excludes a half-reported task from the totals while still summing the rest', async () => {
    const mk = (bothTokens: number, halfTokens: Record<string, number>) => suiteOf('s', [
      task('full', 'pass', { metrics: { tokens: bothTokens } }),
      task('half', 'pass', { metrics: halfTokens }),
    ]);
    const b = await run(mk(100, { tokens: 999 }));
    const a = await run(mk(80, {}));
    const d = diffRuns(b, a);

    const total = d.metricDeltas.find(m => m.metric === 'tokens')!;
    expect(total.before).toBe(100); // 999 is NOT summed against a missing counterpart
    expect(total.after).toBe(80);
    expect(total.delta).toBe(-20);
    expect(total.unreportedTasks).toBe(1);
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

  it('never leaves a failing task with a blank Notes cell', async () => {
    const silent: EvalTask = {
      id: 'silent', name: 'fails quietly', category: 'edit', kind: 'deterministic',
      async run() { return { status: 'fail' }; },
    };
    const text = formatRunReport(await run(suiteOf('s', [silent])));
    expect(text).toContain('| silent | fail | edit | deterministic | (no reason given) |');
  });

  it('never renders a tiny but nonzero metric as 0', async () => {
    const b = await run(suiteOf('s', [task('t', 'pass', { metrics: { costUsd: 0 } })]));
    const a = await run(suiteOf('s', [task('t', 'pass', { metrics: { costUsd: 0.000012 } })]));
    const text = formatDiffReport(diffRuns(b, a));
    // a fraction-of-a-cent cost is small, not absent — "0" would read as "not measured"
    expect(text).toContain('| costUsd | 0 | 1.20e-5 | +1.20e-5 |');
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
