import { describe, it, expect } from 'vitest';
import {
  evaluateChecks, summarize, formatReport,
  type EvalCheck, type Outcome, type TaskRunResult,
} from '../src/eval/score.js';

describe('evaluateChecks', () => {
  it('passes when all conditions hold', () => {
    const check: EvalCheck = {
      filesExist: ['a.txt'],
      fileChecks: [{ path: 'a.txt', contains: 'hello' }],
      command: { command: 'node test.js' },
    };
    const outcome: Outcome = {
      existingFiles: ['a.txt'],
      fileContents: { 'a.txt': 'hello world' },
      commandExitCode: 0,
    };
    const r = evaluateChecks(check, outcome);
    expect(r.passed).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it('fails and explains a missing file', () => {
    const r = evaluateChecks({ filesExist: ['x.txt'] }, { existingFiles: [], fileContents: {} });
    expect(r.passed).toBe(false);
    expect(r.reasons[0]).toContain('expected file missing: x.txt');
  });

  it('fails when content substring is absent', () => {
    const r = evaluateChecks(
      { fileChecks: [{ path: 'a', contains: 'needle' }] },
      { existingFiles: ['a'], fileContents: { a: 'haystack' } },
    );
    expect(r.passed).toBe(false);
    expect(r.reasons[0]).toContain('does not contain');
  });

  it('supports regex matches', () => {
    const ok = evaluateChecks(
      { fileChecks: [{ path: 'b.js', matches: 'a\\s*\\+\\s*b' }] },
      { existingFiles: ['b.js'], fileContents: { 'b.js': 'return a + b;' } },
    );
    expect(ok.passed).toBe(true);
    const bad = evaluateChecks(
      { fileChecks: [{ path: 'b.js', matches: 'a\\s*\\+\\s*b' }] },
      { existingFiles: ['b.js'], fileContents: { 'b.js': 'return a - b;' } },
    );
    expect(bad.passed).toBe(false);
  });

  it('honors expectExitZero=false', () => {
    const r = evaluateChecks(
      { command: { command: 'false', expectExitZero: false } },
      { existingFiles: [], fileContents: {}, commandExitCode: 1 },
    );
    expect(r.passed).toBe(true);
  });

  it('surfaces a run-level error as a failure reason', () => {
    const r = evaluateChecks({ filesExist: ['a'] }, { existingFiles: ['a'], fileContents: {}, error: 'no model available' });
    expect(r.passed).toBe(false);
    expect(r.reasons.some(x => x.includes('no model available'))).toBe(true);
  });
});

describe('summarize', () => {
  const mk = (id: string, passed: boolean, iters: number, tools: number, cost: number, ms: number): TaskRunResult =>
    ({ id, passed, reasons: [], iterations: iters, toolCalls: tools, costUsd: cost, wallMs: ms });

  it('computes pass rate and averages', () => {
    const s = summarize([
      mk('a', true, 4, 6, 0.01, 2000),
      mk('b', false, 8, 10, 0.03, 4000),
    ]);
    expect(s.total).toBe(2);
    expect(s.passed).toBe(1);
    expect(s.passRate).toBe(0.5);
    expect(s.avgIterations).toBe(6);
    expect(s.avgToolCalls).toBe(8);
    expect(s.totalCostUsd).toBeCloseTo(0.04);
    expect(s.avgWallMs).toBe(3000);
  });

  it('handles an empty result set without dividing by zero', () => {
    const s = summarize([]);
    expect(s.passRate).toBe(0);
    expect(s.avgIterations).toBe(0);
  });
});

describe('formatReport', () => {
  it('renders a markdown table with a pass summary', () => {
    const results: TaskRunResult[] = [
      { id: 't1', passed: true, reasons: [], iterations: 3, toolCalls: 4, costUsd: 0, wallMs: 1500 },
      { id: 't2', passed: false, reasons: ['expected file missing: out.txt'], iterations: 9, toolCalls: 12, costUsd: 0, wallMs: 8000 },
    ];
    const report = formatReport(results, summarize(results), { model: 'test-model', when: '2026-05-29' });
    expect(report).toContain('# QodeX Eval Report');
    expect(report).toContain('1/2 passed (50%)');
    expect(report).toContain('| t1 | ✅ pass |');
    expect(report).toContain('| t2 | ❌ fail |');
    expect(report).toContain('expected file missing: out.txt');
    expect(report).toContain('Model: test-model');
  });
});
