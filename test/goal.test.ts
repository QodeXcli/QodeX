import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseGoalCommand, newGoal, checkGoal, nextGoalStep, citedEvidence, describeGoal,
  goalContinuationPrompt, DEFAULT_GOAL_ROUNDS, MAX_GOAL_ROUNDS,
} from '../src/goals/goal.js';

describe('/goal parsing', () => {
  it('objective, quoted check and round cap', () => {
    expect(parseGoalCommand('make the login page pass its tests --check "npm test -- login" --max 5')).toEqual({
      kind: 'set', objective: 'make the login page pass its tests', check: 'npm test -- login', maxRounds: 5,
    });
    expect(parseGoalCommand("fix lint --check='npm run lint'")).toMatchObject({ kind: 'set', objective: 'fix lint', check: 'npm run lint' });
    expect(parseGoalCommand('fix "the flaky" test --check="npm test"')).toMatchObject({ objective: 'fix the flaky test', check: 'npm test' });
    expect(parseGoalCommand('ship it')).toEqual({ kind: 'set', objective: 'ship it', check: undefined, maxRounds: DEFAULT_GOAL_ROUNDS });
    expect(parseGoalCommand('x --max 999')).toMatchObject({ maxRounds: MAX_GOAL_ROUNDS });
  });

  it('status / clear / errors', () => {
    expect(parseGoalCommand('')).toEqual({ kind: 'status' });
    expect(parseGoalCommand('clear')).toEqual({ kind: 'clear' });
    expect(parseGoalCommand('--check "npm test"').kind).toBe('error');
    expect(parseGoalCommand('x --max zero').kind).toBe('error');
    expect(parseGoalCommand('x --check').kind).toBe('error');
  });
});

describe('/goal evidence loop', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qodex-goal-'));

  it('a failing check feeds its output back; a passing one finishes the goal', () => {
    let g = newGoal('make ok.txt exist', 'test -f ok.txt && echo present', 3);
    const v1 = checkGoal(g, 'done!', dir);
    expect(v1.met).toBe(false);
    const n1 = nextGoalStep(g, v1);
    expect(n1.action).toBe('continue');
    if (n1.action !== 'continue') throw new Error('unreachable');
    expect(n1.prompt).toMatch(/round 1 of 3/);
    expect(n1.prompt).toMatch(/test -f ok\.txt/);
    g = n1.goal;
    fs.writeFileSync(path.join(dir, 'ok.txt'), 'x');
    const v2 = checkGoal(g, 'fixed', dir);
    expect(v2.met).toBe(true);
    expect(v2.evidence).toMatch(/present/);
    expect(nextGoalStep(g, v2)).toMatchObject({ action: 'done', goal: { status: 'met' } });
  });

  it('gives up after the round cap', () => {
    let g = newGoal('never', 'exit 1', 2);
    const v = checkGoal(g, '', dir);
    for (let i = 0; i < 2; i++) {
      const n = nextGoalStep(g, v);
      expect(n.action).toBe('continue');
      g = n.goal;
    }
    expect(nextGoalStep(g, v)).toMatchObject({ action: 'give-up', goal: { status: 'gave-up' } });
  });

  it('without a check, only a GOAL_MET line with evidence counts', () => {
    const g = newGoal('write the report', undefined, 3);
    expect(checkGoal(g, 'I think it is done.', dir).met).toBe(false);
    expect(checkGoal(g, 'All good.\nGOAL_MET: ran `npm test` — 42 passed, 0 failed', dir)).toEqual({ met: true, evidence: 'ran `npm test` — 42 passed, 0 failed' });
    expect(citedEvidence('GOAL_MET: yes')).toBeNull(); // too short to be evidence
  });

  it('describes the goal for /goal status', () => {
    expect(describeGoal(null)).toMatch(/No standing goal/);
    expect(describeGoal(newGoal('a', 'npm test', 4))).toBe('Goal (round 0/4): a · check: npm test');
    expect(goalContinuationPrompt(newGoal('a', undefined, 2), 'x'.repeat(5000)).length).toBeLessThan(3500);
  });
});

describe('/goal async check', () => {
  it('matches the sync check and reports timeouts', async () => {
    const { checkGoalAsync } = await import('../src/goals/goal.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qodex-goal-async-'));
    const pass = await checkGoalAsync(newGoal('x', 'echo ok', 2), '', dir);
    expect(pass).toMatchObject({ met: true });
    expect(pass.evidence).toMatch(/exited 0\nok/);
    expect((await checkGoalAsync(newGoal('x', 'echo nope >&2; exit 3', 2), '', dir))).toMatchObject({ met: false, evidence: expect.stringMatching(/exited 3\nnope/) });
    const slow = await checkGoalAsync(newGoal('x', 'sleep 5', 2), '', dir, 200);
    expect(slow.met).toBe(false);
    expect(slow.evidence).toMatch(/timed out/);
    expect((await checkGoalAsync(newGoal('x', undefined, 2), 'GOAL_MET: ran the build, 0 errors', dir)).met).toBe(true);
  });
});
