import { describe, it, expect } from 'vitest';
import { scoreConfidence, confidenceLabel } from '../src/skills/learning/confidence.js';
import { aggregateStats, type LearningEvent } from '../src/skills/learning/ledger.js';
import { buildCandidateSkill } from '../src/skills/learning/capture.js';

describe('confidence scoring — objective, bounded, correctness-dominant', () => {
  const base = { toolCalls: 6, verifyClean: true, completionHonest: true, toolsUsed: ['a', 'b', 'c'], filesChanged: ['x.ts', 'y.ts'] };
  it('a verified, honest, substantial task scores high', () => {
    const { score } = scoreConfidence(base);
    expect(score).toBeGreaterThanOrEqual(75);
    expect(confidenceLabel(score)).toBe('high');
  });
  it('losing verification or honesty tanks the score (correctness dominates)', () => {
    expect(scoreConfidence({ ...base, verifyClean: false }).score).toBeLessThan(scoreConfidence(base).score - 30);
    expect(scoreConfidence({ ...base, completionHonest: false }).score).toBeLessThan(scoreConfidence(base).score - 15);
  });
  it('stays within [0,100] and volume has diminishing returns', () => {
    const huge = scoreConfidence({ ...base, toolCalls: 1000, toolsUsed: Array.from({ length: 50 }, (_, i) => `t${i}`), filesChanged: Array.from({ length: 50 }, (_, i) => `f${i}.ts`) });
    expect(huge.score).toBeLessThanOrEqual(100);
    // doubling tool calls from 6→12 adds only a little (saturating)
    const a = scoreConfidence({ ...base, toolCalls: 6 }).factors.toolCalls!;
    const b = scoreConfidence({ ...base, toolCalls: 12 }).factors.toolCalls!;
    expect(b - a).toBeLessThan(a); // marginal gain shrinks
  });
  it('confidence lands in the candidate frontmatter', () => {
    const c = buildCandidateSkill({ prompt: 'do a thing', finalSummary: 's', toolsUsed: ['shell'], filesChanged: ['a.ts'] }, { nowIso: '', confidence: 82 });
    expect(c.skillMd).toContain('confidence: 82');
  });
});

describe('learning ledger aggregation — the metrics dashboard', () => {
  const ev = (event: LearningEvent['event'], name: string, extra: Partial<LearningEvent> = {}): LearningEvent =>
    ({ ts: `2026-06-25T00:00:0${name.length}Z`, event, name, ...extra });
  it('aggregates counts, promotion rate, and avg confidence', () => {
    const events: LearningEvent[] = [
      ev('capture', 'a', { confidence: 80 }),
      ev('capture', 'b', { confidence: 60 }),
      ev('merge', 'ab'),
      ev('promote', 'ab'),
      ev('reject', 'c'),
    ];
    const s = aggregateStats(events, 2);
    expect(s.captured).toBe(2);
    expect(s.promoted).toBe(1);
    expect(s.rejected).toBe(1);
    expect(s.merged).toBe(1);
    expect(s.promotionRate).toBeCloseTo(0.5, 5); // 1 promote / (1+1) decisions
    expect(s.avgConfidence).toBe(70);
    expect(s.pendingCandidates).toBe(2);
  });
  it('empty ledger → zeros, no division by zero', () => {
    const s = aggregateStats([], 0);
    expect(s).toMatchObject({ captured: 0, promoted: 0, promotionRate: 0, avgConfidence: null, lastEventAt: null });
  });
});
