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
  /** Total wall-clock across executions (ms) — fuels the time term of the composite reward.
   *  Optional for backward-compat with manifests written before reward weighting. */
  totalDurationMs?: number;
}

export interface RewardWeights {
  /** Weight on the success rate (dominant). */
  success: number;
  /** Weight on token efficiency (cheaper = better). */
  token: number;
  /** Weight on time efficiency (faster = better). */
  time: number;
}
export const DEFAULT_WEIGHTS: RewardWeights = { success: 0.7, token: 0.15, time: 0.15 };

export interface RouteOptions {
  /** UCB1 exploration factor `c` (higher = more exploration). Default √2. */
  explorationFactor?: number;
  /** Force-route a challenger until it has at least this many trials, BEFORE UCB1 can
   *  starve it — so a decision is never made on too little signal. Default 5. */
  minChallengerTrials?: number;
  /** Composite-reward weights. */
  weights?: RewardWeights;
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
  /** 'ucb1' (adaptive bandit), 'static' (~25% challenger), or 'champion-only' (UCB OFF —
   *  always the stable version; for sensitive skills you don't want experimented on). */
  routingStrategy: 'static' | 'ucb1' | 'champion-only';
  versions: Record<string, VersionDetail>;
}

/** A fresh manifest for a brand-new skill (its first version is v1, the champion). */
export function initManifest(skillId: string, author: 'human' | 'machine', confidence = 50, nowIso = ''): { manifest: SkillManifest; fileName: string } {
  const v: VersionDetail = { version: 'v1', createdAt: nowIso, author, confidence, stats: { executions: 0, successes: 0, totalTokensUsed: 0, totalDurationMs: 0 } };
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

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const perExec = (total: number, exec: number) => (exec ? total / exec : 0);

/** The CHAMPION's per-execution cost/latency — the reference everything is normalized
 *  against, so efficiency means "vs the stable version". */
export interface RewardRef { champTokensPerExec: number; champMsPerExec: number }
export function championRef(champion: VersionDetail): RewardRef {
  return {
    champTokensPerExec: perExec(champion.stats.totalTokensUsed, champion.stats.executions),
    champMsPerExec: perExec(champion.stats.totalDurationMs ?? 0, champion.stats.executions),
  };
}

/** Efficiency in [0,1] normalized against the champion: at champion cost → 0.5 (baseline),
 *  free → 1.0, twice the champion's cost → 0.0. Neutral (0.5) when the champion has no scale. */
function efficiency(vPerExec: number, champPerExec: number): number {
  if (champPerExec <= 0) return 0.5;
  return clamp01(1 - 0.5 * (vPerExec / champPerExec));
}

/**
 * COMPOSITE reward in [0,1]: success rate dominates, with token- and time-EFFICIENCY nudges
 * measured RELATIVE TO THE CHAMPION (the stable version is the baseline a challenger must
 * beat). A version cheaper/faster than the champion scores above the 0.5 efficiency
 * baseline; one twice as costly scores 0. PURE.
 */
export function compositeReward(v: VersionDetail, ref: RewardRef, weights: RewardWeights = DEFAULT_WEIGHTS): number {
  if (v.stats.executions === 0) return 0;
  const successRate = v.stats.successes / v.stats.executions;
  const tokScore = efficiency(perExec(v.stats.totalTokensUsed, v.stats.executions), ref.champTokensPerExec);
  const timeScore = efficiency(perExec(v.stats.totalDurationMs ?? 0, v.stats.executions), ref.champMsPerExec);
  const w = weights, denom = w.success + w.token + w.time || 1;
  return (w.success * successRate + w.token * tokScore + w.time * timeScore) / denom;
}

export interface UcbScore { version: string; reward: number; bonus: number; ucb: number; executions: number }

/** Per-arm UCB breakdown (reward + exploration bonus) for the active+challenger — a pure
 *  snapshot for debugging / `qodex skill versions` / analysis. */
export function ucbScores(manifest: SkillManifest, opts: RouteOptions = {}): UcbScore[] {
  const c = opts.explorationFactor ?? Math.sqrt(2);
  const arms = [manifest.activeVersion, manifest.challengerVersion]
    .filter((x): x is string => !!x).map(v => manifest.versions[v]).filter((v): v is VersionDetail => !!v);
  const ref = championRef(manifest.versions[manifest.activeVersion]!);
  const N = arms.reduce((s, v) => s + v.stats.executions, 0);
  return arms.map(v => {
    const reward = compositeReward(v, ref, opts.weights);
    const bonus = v.stats.executions === 0 ? Infinity : c * Math.sqrt(Math.log(Math.max(1, N)) / v.stats.executions);
    return { version: v.version, reward, bonus, ucb: reward + bonus, executions: v.stats.executions };
  });
}

/**
 * Choose which version to inject this turn:
 *   - no challenger / champion-only strategy → the champion (UCB OFF; sensitive skills),
 *   - static → ~25% challenger,
 *   - ucb1 → force-explore the challenger until it clears `minChallengerTrials` (so we never
 *     judge on too little signal), then pick the higher UCB (composite reward + bonus);
 *     ties go to the champion (don't disturb the stable version).
 */
export function routeSkillVersion(manifest: SkillManifest, opts: RouteOptions = {}): string {
  const champ = manifest.activeVersion;
  const chal = manifest.challengerVersion;
  if (!chal || !manifest.versions[chal] || chal === champ) return champ;
  if (manifest.routingStrategy === 'champion-only') return champ;
  if (manifest.routingStrategy === 'static') return deterministicStatic(manifest) ? chal : champ;

  const minTrials = opts.minChallengerTrials ?? 5;
  if (manifest.versions[chal]!.stats.executions < minTrials) return chal; // exploration floor

  const scores = ucbScores(manifest, opts);
  const champU = scores.find(s => s.version === champ)?.ucb ?? -Infinity;
  const chalU = scores.find(s => s.version === chal)?.ucb ?? -Infinity;
  return chalU > champU ? chal : champ;
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
  outcome: { success: boolean; tokens?: number; durationMs?: number },
): SkillManifest {
  const v = manifest.versions[version];
  if (!v) return manifest;
  const updated: VersionDetail = {
    ...v,
    stats: {
      executions: v.stats.executions + 1,
      successes: v.stats.successes + (outcome.success ? 1 : 0),
      totalTokensUsed: v.stats.totalTokensUsed + (outcome.tokens ?? 0),
      totalDurationMs: (v.stats.totalDurationMs ?? 0) + (outcome.durationMs ?? 0),
    },
  };
  return { ...manifest, versions: { ...manifest.versions, [version]: updated } };
}

export interface ChampionDecision {
  manifest: SkillManifest;
  action: 'promote' | 'retire' | 'keep-testing' | 'no-challenger';
  reason: string;
}

/**
 * Converge the A/B test on the COMPOSITE reward (success + token + time), once the
 * challenger has enough samples:
 *   - clearly BETTER than the champion (by `margin`) → PROMOTE it to active.
 *   - clearly WORSE → RETIRE it (kept in history, marked retired).
 *   - otherwise keep testing. Below `minExecutions` we never decide (too little signal).
 * PURE.
 */
export function decideChampion(manifest: SkillManifest, opts: { minExecutions?: number; margin?: number; weights?: RewardWeights } = {}): ChampionDecision {
  const minExec = opts.minExecutions ?? 8;
  const margin = opts.margin ?? 0.1;
  const chal = manifest.challengerVersion;
  if (!chal || !manifest.versions[chal]) return { manifest, action: 'no-challenger', reason: 'no challenger to decide' };

  const champV = manifest.versions[manifest.activeVersion]!;
  const chalV = manifest.versions[chal]!;
  if (chalV.stats.executions < minExec) return { manifest, action: 'keep-testing', reason: `challenger has ${chalV.stats.executions}/${minExec} executions` };

  const ref = championRef(champV);
  const cr = compositeReward(chalV, ref, opts.weights), pr = compositeReward(champV, ref, opts.weights);
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
