import { describe, it, expect } from 'vitest';
import {
  initManifest, createNextVersion, recordVersionExecution, routeSkillVersion, decideChampion,
  compositeReward, ucbScores, type SkillManifest, type VersionDetail,
} from '../src/skills/learning/skill-versioning.js';

const challenger = () => createNextVersion(initManifest('s', 'machine', 50, '').manifest, 'machine').updatedManifest;
function feed(m: SkillManifest, v: string, runs: Array<{ success: boolean; tokens?: number; durationMs?: number }>): SkillManifest {
  for (const r of runs) m = recordVersionExecution(m, v, r);
  return m;
}
const ten = (success: boolean, tokens = 0, durationMs = 0) => Array(10).fill(0).map(() => ({ success, tokens, durationMs }));

describe('#5 champion-only — UCB OFF for sensitive skills', () => {
  it('always routes the champion regardless of a strong challenger', () => {
    let m = challenger();
    m = { ...m, routingStrategy: 'champion-only' };
    m = feed(m, 'v2', ten(true));   // perfect challenger
    expect(routeSkillVersion(m)).toBe(m.activeVersion);
  });
});

describe('#3 minChallengerTrials — force exploration before serious judgment', () => {
  it('routes the challenger until it clears the floor, even if it looks bad early', () => {
    let m = challenger();
    m = feed(m, 'v1', ten(true));            // champion strong
    m = feed(m, 'v2', [{ success: false }, { success: false }]); // 2 bad trials
    expect(routeSkillVersion(m, { minChallengerTrials: 5 })).toBe('v2'); // still forced
    m = feed(m, 'v2', [{ success: false }, { success: false }, { success: false }]); // now 5
    expect(routeSkillVersion(m, { minChallengerTrials: 5 })).toBe(m.activeVersion);   // UCB takes over → champion
  });
});

describe('#1 ucbExplorationFactor — tunes explore vs exploit', () => {
  it('a higher c keeps a barely-tested challenger in play longer', () => {
    let m = challenger();
    m = feed(m, 'v1', ten(true));                              // champion 100% over 10
    m = feed(m, 'v2', [...ten(true).slice(0, 5), { success: false }]); // challenger ~83% over 6
    // tiny c → exploit champion; large c → explore challenger
    expect(routeSkillVersion(m, { explorationFactor: 0.1, minChallengerTrials: 5 })).toBe(m.activeVersion);
    expect(routeSkillVersion(m, { explorationFactor: 5, minChallengerTrials: 5 })).toBe('v2');
  });
});

describe('#2 composite reward — success + token + time efficiency', () => {
  it('between two EQUALLY-successful versions, the cheaper + faster one scores higher', () => {
    let m = challenger();
    m = feed(m, 'v1', ten(true, 1000, 2000));  // champion: 100% but expensive/slow
    m = feed(m, 'v2', ten(true, 200, 400));    // challenger: 100% but cheap/fast
    const champReward = compositeReward(m.versions.v1!, { maxTokensPerExec: 1000, maxMsPerExec: 2000 });
    const chalReward = compositeReward(m.versions.v2!, { maxTokensPerExec: 1000, maxMsPerExec: 2000 });
    expect(chalReward).toBeGreaterThan(champReward);
    // and decideChampion promotes the more efficient one
    expect(decideChampion(m, { minExecutions: 8 }).action).toBe('promote');
  });
  it('success still dominates — a cheap FAILURE never beats an expensive success', () => {
    const norm = { maxTokensPerExec: 1000, maxMsPerExec: 2000 };
    const good: VersionDetail = { version: 'a', createdAt: '', author: 'machine', confidence: 50, stats: { executions: 10, successes: 9, totalTokensUsed: 10000, totalDurationMs: 20000 } };
    const cheapFail: VersionDetail = { version: 'b', createdAt: '', author: 'machine', confidence: 50, stats: { executions: 10, successes: 2, totalTokensUsed: 100, totalDurationMs: 100 } };
    expect(compositeReward(good, norm)).toBeGreaterThan(compositeReward(cheapFail, norm));
  });
});

describe('#4 ucbScores — debugging/analysis snapshot', () => {
  it('exposes reward + bonus + ucb per arm', () => {
    let m = challenger();
    m = feed(m, 'v1', ten(true));
    m = feed(m, 'v2', ten(false));
    const scores = ucbScores(m);
    expect(scores.map(s => s.version).sort()).toEqual(['v1', 'v2']);
    const v1 = scores.find(s => s.version === 'v1')!;
    expect(v1.reward).toBeGreaterThan(0);
    expect(v1.ucb).toBeCloseTo(v1.reward + v1.bonus, 5);
    expect(v1.executions).toBe(10);
  });
});
