import { describe, it, expect } from 'vitest';
import {
  initManifest, createNextVersion, routeSkillVersion, recordVersionExecution, decideChampion,
  type SkillManifest,
} from '../src/skills/learning/skill-versioning.js';

function withStats(m: SkillManifest, v: string, exec: number, succ: number): SkillManifest {
  let out = m;
  for (let i = 0; i < exec; i++) out = recordVersionExecution(out, v, { success: i < succ });
  return out;
}

describe('createNextVersion — challenger added, others untouched', () => {
  it('first version is v1 champion; a new version becomes the challenger with parent', () => {
    const { manifest } = initManifest('s', 'machine', 70, 't0');
    expect(manifest.activeVersion).toBe('v1');
    const { updatedManifest, nextVersionFileName } = createNextVersion(manifest, 'machine', { confidence: 60, nowIso: 't1' });
    expect(nextVersionFileName).toBe('SKILL.v2.md');
    expect(updatedManifest.challengerVersion).toBe('v2');
    expect(updatedManifest.versions.v2!.parent).toBe('v1');
    expect(updatedManifest.activeVersion).toBe('v1');          // champion untouched
    expect(updatedManifest.versions.v1!.stats.executions).toBe(0);
  });
  it('next tag is robust after a retire (max+1; retired versions stay in history → no tag reuse)', () => {
    let { manifest } = initManifest('s', 'machine', 50, '');
    manifest = createNextVersion(manifest, 'machine').updatedManifest;     // v2 challenger
    // retire v2 the real way (challenger worse): it stays in history, marked retired
    let m = withStats(manifest, 'v1', 20, 18);
    m = withStats(m, 'v2', 20, 4);
    const retired = decideChampion(m, { minExecutions: 8 }).manifest;
    expect(retired.versions.v2!.retired).toBe(true);                        // kept, marked
    expect(createNextVersion(retired, 'machine').nextVersionFileName).toBe('SKILL.v3.md'); // no reuse
  });
});

describe('routeSkillVersion — UCB1 explore/exploit', () => {
  it('no challenger → always the champion', () => {
    const { manifest } = initManifest('s', 'human', 80, '');
    expect(routeSkillVersion(manifest)).toBe('v1');
  });
  it('an UNSAMPLED challenger is explored first (Infinity arm)', () => {
    let m = initManifest('s', 'machine', 50, '').manifest;
    m = createNextVersion(m, 'machine').updatedManifest;     // v2 challenger, 0 execs
    m = withStats(m, 'v1', 5, 4);                            // champion sampled
    expect(routeSkillVersion(m)).toBe('v2');                 // try the unsampled challenger
  });
  it('exploits the champion when the challenger proves much worse', () => {
    let m = initManifest('s', 'machine', 50, '').manifest;
    m = createNextVersion(m, 'machine').updatedManifest;
    m = withStats(m, 'v1', 20, 19);   // champion 95%
    m = withStats(m, 'v2', 20, 4);    // challenger 20%
    expect(routeSkillVersion(m)).toBe('v1');
  });
  it('keeps exploring a challenger that is competitive', () => {
    let m = initManifest('s', 'machine', 50, '').manifest;
    m = createNextVersion(m, 'machine').updatedManifest;
    m = withStats(m, 'v1', 50, 40);   // 80%
    m = withStats(m, 'v2', 5, 5);     // 100% but tiny n → UCB1 bonus keeps it in play
    expect(routeSkillVersion(m)).toBe('v2');
  });
});

describe('recordVersionExecution — pure stat update', () => {
  it('increments executions/successes/tokens', () => {
    let m = initManifest('s', 'machine', 50, '').manifest;
    m = recordVersionExecution(m, 'v1', { success: true, tokens: 100 });
    m = recordVersionExecution(m, 'v1', { success: false, tokens: 50 });
    expect(m.versions.v1!.stats).toEqual({ executions: 2, successes: 1, totalTokensUsed: 150 });
  });
  it('unknown version is a no-op', () => {
    const m = initManifest('s', 'machine', 50, '').manifest;
    expect(recordVersionExecution(m, 'v9', { success: true })).toEqual(m);
  });
});

describe('decideChampion — A/B convergence', () => {
  const base = () => createNextVersion(initManifest('s', 'machine', 50, '').manifest, 'machine').updatedManifest;
  it('below minExecutions → keep testing', () => {
    let m = withStats(base(), 'v2', 3, 3);
    expect(decideChampion(m, { minExecutions: 8 }).action).toBe('keep-testing');
  });
  it('challenger clearly BETTER → promote to active', () => {
    let m = base();
    m = withStats(m, 'v1', 20, 12);  // 60%
    m = withStats(m, 'v2', 20, 18);  // 90%
    const d = decideChampion(m, { minExecutions: 8, margin: 0.1 });
    expect(d.action).toBe('promote');
    expect(d.manifest.activeVersion).toBe('v2');
    expect(d.manifest.challengerVersion).toBeUndefined();
  });
  it('challenger clearly WORSE → retired (dropped)', () => {
    let m = base();
    m = withStats(m, 'v1', 20, 18);  // 90%
    m = withStats(m, 'v2', 20, 6);   // 30%
    const d = decideChampion(m, { minExecutions: 8, margin: 0.1 });
    expect(d.action).toBe('retire');
    expect(d.manifest.versions.v2!.retired).toBe(true);   // kept in history, marked retired
    expect(d.manifest.challengerVersion).toBeUndefined();
    expect(d.manifest.activeVersion).toBe('v1');
  });
  it('no challenger → no-challenger', () => {
    expect(decideChampion(initManifest('s', 'human', 50, '').manifest).action).toBe('no-challenger');
  });
});
