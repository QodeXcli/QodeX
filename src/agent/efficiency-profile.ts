/**
 * Efficiency profile — opt-in aggressive token settings for keeping a long session's
 * context window small. OFF by default (zero change to existing behavior). When a
 * user sets `context.efficient: true` (most useful for a weak LOCAL model on a Mac,
 * where a smaller window means faster prefill and fewer re-sent tokens each turn),
 * QodeX ages large tool results sooner and compacts earlier.
 *
 * Trade-off (honest): a tighter window can make the model occasionally re-read a file
 * it aged out, costing one extra read. On long, exploration-heavy tasks the net is a
 * clear token win; on short tasks it does nothing (nothing gets old enough to age).
 *
 * Explicit user values ALWAYS win over the profile — this only fills in defaults when
 * the user hasn't pinned a number. PURE.
 */

export interface EfficiencyDefaults {
  /** Age tool results after this many assistant turns (lower = sooner). */
  agingMinTurns: number;
  /** Only age results larger than this many chars (lower = age more of them). */
  agingMaxChars: number;
  /** Fraction of the context window that triggers compaction (lower = earlier). */
  compactThreshold: number;
}

const BALANCED: EfficiencyDefaults = { agingMinTurns: 3, agingMaxChars: 8_000, compactThreshold: 0.75 };
const AGGRESSIVE: EfficiencyDefaults = { agingMinTurns: 2, agingMaxChars: 4_000, compactThreshold: 0.60 };

/** Return the default profile values for the given mode. */
export function efficiencyDefaults(efficient: boolean): EfficiencyDefaults {
  return efficient ? { ...AGGRESSIVE } : { ...BALANCED };
}

/**
 * Resolve a single setting: an explicit user value (a finite number) always wins;
 * otherwise fall back to the profile default. Keeps "explicit overrides profile"
 * logic in one tested place.
 */
export function resolveSetting(explicit: unknown, profileDefault: number): number {
  return typeof explicit === 'number' && Number.isFinite(explicit) ? explicit : profileDefault;
}
