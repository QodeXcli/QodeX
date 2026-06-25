/**
 * Skill versioning + adaptive-bandit routing (Phase 4).
 *
 * A skill keeps its full history in ONE directory behind a flat manifest — no symlinks,
 * no split-brain, identical on macOS / Linux / Windows:
 *
 *   ~/.qodex/skills/<id>/
 *     manifest.json      ← single source of truth (versions, active/challenger, per-version stats)
 *     SKILL.v1.md
 *     SKILL.v2.md        ← challenger
 *
 * Routing between the stable **champion** (activeVersion) and a **challenger** uses the
 * **UCB1** bandit instead of a fixed split, so a bad challenger gets its traffic driven to
 * zero automatically while a good one earns more. `decideChampion` converges the test:
 * promote a challenger that's both well-sampled and better, retire one that's worse.
 *
 * Everything here is PURE (manifest in → manifest/decision out) so the algorithm is
 * unit-tested without disk; the thin JSONL/file I/O lives in versioned-store.ts.
 */

export interface VersionStats {
  executions: number;
  successes: number;
  totalTokensUsed: number;
}

export interface VersionDetail {
  version: string;
  createdAt: string;
  author: 'human' | 'machine';
  confidence: number;
  parent?: string;
  stats: VersionStats;
  /** Set when a challenger lost the A/B test. Kept in history (so tags never collide and
   *  the SKILL.v{N}.md file stays referenced), but never routed to again. */
  retired?: boolean;
}

export interface SkillManifest {
  skillId: string;
  activeVersion: string;          // the stable champion
  challengerVersion?: string;     // the version under test
  routingStrategy: 'static' | 'ucb1';
  versions: Record<string, VersionDetail>;
}

/** A fresh manifest for a brand-new skill (its first version is v1, the champion). */
export function initManifest(skillId: string, author: 'human' | 'machine', confidence = 50, nowIso = ''): { manifest: SkillManifest; fileName: string } {
  const v: VersionDetail = { version: 'v1', createdAt: nowIso, author, confidence, stats: { executions: 0, successes: 0, totalTokensUsed: 0 } };
  return {
    manifest: { skillId, activeVersion: 'v1', routingStrategy: 'ucb1', versions: { v1: v } },
    fileName: 'SKILL.v1.md',
  };
}

/** The next version tag is max(existing numeric tags)+1 — robust to deleted/retired versions
 *  (the spec's `Object.keys().length+1` would collide after a retire). */
function nextVersionTag(manifest: SkillManifest): string {
  let max = 0;
  for (const k of Object.keys(manifest.versions)) {
    const n = parseInt(k.replace(/^v/, ''), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `v${max + 1}`;
}

/**
 * Add a new version as the CHALLENGER without touching any other version's state. The new
 * version's parent is the current champion. PURE.
 */
export function createNextVersion(
  manifest: SkillManifest,
  author: 'human' | 'machine',
  opts: { confidence?: number; nowIso?: string } = {},
): { updatedManifest: SkillManifest; nextVersionFileName: string } {
  const tag = nextVersionTag(manifest);
  const detail: VersionDetail = {
    version: tag,
    createdAt: opts.nowIso ?? '',
    author,
    confidence: opts.confidence ?? 50,
    parent: manifest.activeVersion,
    stats: { executions: 0, successes: 0, totalTokensUsed: 0 },
  };
  return {
    updatedManifest: {
      ...manifest,
      challengerVersion: tag,
      versions: { ...manifest.versions, [tag]: detail },
    },
    nextVersionFileName: `SKILL.${tag}.md`,
  };
}

/** UCB1 score for a version given the total trials N. */
function ucb1(v: VersionDetail, N: number, c: number): number {
  if (v.stats.executions === 0) return Infinity; // always try an unsampled arm first
  const mean = v.stats.successes / v.stats.executions;
  return mean + c * Math.sqrt(Math.log(Math.max(1, N)) / v.stats.executions);
}

/**
 * Choose which version to inject this turn. No challenger → the champion. UCB1 balances
 * exploring the challenger against exploiting the better arm; an unsampled version is
 * tried first (Infinity), and a challenger whose success rate collapses loses traffic.
 */
export function routeSkillVersion(manifest: SkillManifest, c: number = Math.sqrt(2)): string {
  const champ = manifest.activeVersion;
  const chal = manifest.challengerVersion;
  if (!chal || !manifest.versions[chal] || chal === champ) return champ;

  if (manifest.routingStrategy === 'static') {
    return deterministicStatic(manifest) ? chal : champ;
  }
  const v1 = manifest.versions[champ]!;
  const v2 = manifest.versions[chal]!;
  const N = v1.stats.executions + v2.stats.executions;
  // Tie → champion (conservative: don't disturb the stable version on a tie).
  return ucb1(v2, N, c) > ucb1(v1, N, c) ? chal : champ;
}

/** Deterministic ~25% challenger pick for the 'static' strategy (no Math.random — keeps the
 *  module pure/testable; varies by total trials so it still alternates). */
function deterministicStatic(manifest: SkillManifest): boolean {
  const N = (manifest.versions[manifest.activeVersion]?.stats.executions ?? 0)
    + (manifest.challengerVersion ? (manifest.versions[manifest.challengerVersion]?.stats.executions ?? 0) : 0);
  return N % 4 === 0;
}

/** Record one execution outcome against a version. PURE — returns a new manifest. */
export function recordVersionExecution(
  manifest: SkillManifest,
  version: string,
  outcome: { success: boolean; tokens?: number },
): SkillManifest {
  const v = manifest.versions[version];
  if (!v) return manifest;
  const updated: VersionDetail = {
    ...v,
    stats: {
      executions: v.stats.executions + 1,
      successes: v.stats.successes + (outcome.success ? 1 : 0),
      totalTokensUsed: v.stats.totalTokensUsed + (outcome.tokens ?? 0),
    },
  };
  return { ...manifest, versions: { ...manifest.versions, [version]: updated } };
}

export interface ChampionDecision {
  manifest: SkillManifest;
  action: 'promote' | 'retire' | 'keep-testing' | 'no-challenger';
  reason: string;
}

const rate = (v: VersionDetail) => (v.stats.executions ? v.stats.successes / v.stats.executions : 0);

/**
 * Converge the A/B test. Once the challenger has enough samples:
 *   - clearly BETTER than the champion (by `margin`) → PROMOTE it to active.
 *   - clearly WORSE → RETIRE it (drop the challenger, keep the champion).
 *   - otherwise keep testing. Below `minExecutions` we never decide (too little signal).
 * PURE.
 */
export function decideChampion(manifest: SkillManifest, opts: { minExecutions?: number; margin?: number } = {}): ChampionDecision {
  const minExec = opts.minExecutions ?? 8;
  const margin = opts.margin ?? 0.1;
  const chal = manifest.challengerVersion;
  if (!chal || !manifest.versions[chal]) return { manifest, action: 'no-challenger', reason: 'no challenger to decide' };

  const champV = manifest.versions[manifest.activeVersion]!;
  const chalV = manifest.versions[chal]!;
  if (chalV.stats.executions < minExec) return { manifest, action: 'keep-testing', reason: `challenger has ${chalV.stats.executions}/${minExec} executions` };

  const cr = rate(chalV), pr = rate(champV);
  if (cr >= pr + margin) {
    const m: SkillManifest = { ...manifest, activeVersion: chal, challengerVersion: undefined };
    return { manifest: m, action: 'promote', reason: `challenger ${(cr * 100).toFixed(0)}% beat champion ${(pr * 100).toFixed(0)}% by ≥${margin * 100}%` };
  }
  if (cr <= pr - margin) {
    const retiredV: VersionDetail = { ...chalV, retired: true };
    const m: SkillManifest = { ...manifest, challengerVersion: undefined, versions: { ...manifest.versions, [chal]: retiredV } };
    return { manifest: m, action: 'retire', reason: `challenger ${(cr * 100).toFixed(0)}% worse than champion ${(pr * 100).toFixed(0)}% — retired` };
  }
  return { manifest, action: 'keep-testing', reason: 'too close to call yet' };
}

/** The file name for a version tag. */
export function versionFileName(version: string): string {
  return `SKILL.${version}.md`;
}
