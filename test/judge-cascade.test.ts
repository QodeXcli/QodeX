import { describe, it, expect } from 'vitest';
import {
  rubricAverage, rubricStdDev, shouldEscalate, rubricToVerdict, parseRubricScores,
  alignmentDrift, isDriftRising, buildCalibrationBlock, type RubricScores, type DriftRecord,
} from '../src/skills/learning/judge-cascade.js';

const R = (readability: number, efficiency: number, completeness: number, safety: number, justification = ''): RubricScores =>
  ({ readability, efficiency, completeness, safety, justification });

describe('rubric math', () => {
  it('average + stdDev', () => {
    expect(rubricAverage(R(8, 8, 8, 8))).toBe(8);
    expect(rubricStdDev(R(8, 8, 8, 8))).toBe(0);
    expect(rubricStdDev(R(10, 2, 9, 8))).toBeGreaterThan(2.5);
  });
});

describe('shouldEscalate — escalate ONLY when Tier 1 is unsure', () => {
  it('twilight zone (grey middle average) → escalate', () => {
    expect(shouldEscalate(R(6, 7, 6, 7))).toBe(true);   // avg 6.5, low variance
  });
  it('confidently HIGH (clear pass) → do NOT escalate', () => {
    expect(shouldEscalate(R(9, 9, 8, 9))).toBe(false);  // avg 8.75, low variance
  });
  it('confidently LOW (clear reject) → do NOT escalate', () => {
    expect(shouldEscalate(R(2, 3, 2, 2))).toBe(false);  // avg 2.25, low variance
  });
  it('HIGH VARIANCE (dimensions disagree) → escalate even outside twilight', () => {
    expect(shouldEscalate(R(10, 2, 9, 8))).toBe(true);  // confused: safety/efficiency clash
  });
});

describe('rubricToVerdict', () => {
  it('pass only when clearly good AND safe', () => {
    expect(rubricToVerdict(R(9, 8, 8, 9))).toBe(true);
    expect(rubricToVerdict(R(9, 9, 9, 3))).toBe(false);  // unsafe → fail despite high avg
    expect(rubricToVerdict(R(6, 6, 6, 6))).toBe(false);  // mediocre → fail
  });
});

describe('parseRubricScores — clamps, fails closed', () => {
  it('parses + clamps to 1–10', () => {
    expect(parseRubricScores('{"readability":8,"efficiency":7,"completeness":9,"safety":8,"justification":"ok"}'))
      .toEqual(R(8, 7, 9, 8, 'ok'));
    expect(parseRubricScores('{"readability":99,"efficiency":-5,"completeness":9,"safety":8}')!.readability).toBe(10);
    expect(parseRubricScores('{"readability":99,"efficiency":-5,"completeness":9,"safety":8}')!.efficiency).toBe(1);
  });
  it('garbage / missing dimension → null (caller escalates)', () => {
    expect(parseRubricScores('not json')).toBeNull();
    expect(parseRubricScores('{"readability":8}')).toBeNull();
  });
});

describe('feedback alignment drift — self-improvement signal', () => {
  it('alignmentDrift is the mean per-dimension |diff|', () => {
    expect(alignmentDrift(R(8, 8, 8, 8), R(8, 8, 8, 8))).toBe(0);
    expect(alignmentDrift(R(10, 10, 10, 10), R(6, 6, 6, 6))).toBe(4);
  });
  const rec = (drift: number): DriftRecord => ({ ts: '', tier1: R(5, 5, 5, 5), tier2: R(5, 5, 5, 5), drift });
  it('isDriftRising compares recent vs prior window', () => {
    const rising = [...Array(10).fill(0).map(() => rec(1)), ...Array(10).fill(0).map(() => rec(3))];
    expect(isDriftRising(rising, 10)).toBe(true);
    const stable = Array(20).fill(0).map(() => rec(2));
    expect(isDriftRising(stable, 10)).toBe(false);
    expect(isDriftRising([rec(1)], 10)).toBe(false); // not enough data
  });
  it('buildCalibrationBlock surfaces the worst disagreements (Tier-2 scores)', () => {
    const recs: DriftRecord[] = [
      { ts: '', tier1: R(9, 9, 9, 9), tier2: R(3, 3, 3, 3, 'overfit one-off'), drift: 6 },
      { ts: '', tier1: R(7, 7, 7, 7), tier2: R(7, 7, 7, 7), drift: 0 },
    ];
    const block = buildCalibrationBlock(recs, 1);
    expect(block).toContain('CALIBRATION');
    expect(block).toContain('safety 3');           // the Tier-2 correction
    expect(block).toContain('overfit one-off');
    expect(buildCalibrationBlock([], 3)).toBe('');
  });
});
