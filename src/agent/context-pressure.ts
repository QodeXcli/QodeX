/**
 * Context pressure — the fuse box for a filling window.
 *
 * The agent must NEVER stop because the context window is full. Pressure is
 * relieved between iterations, in escalating layers:
 *
 *   1. COMPACT  (≥ compactAt, default 80%) — summarize older turns, keep the tail.
 *   2. ESCALATE — still over 80% → compact again with a shorter tail (6 → 4 → 2).
 *   3. FIT      — still over the hard fit line (92%) → prune oldest units.
 *
 * There is no cooldown that can block relief. A just-compacted session that is
 * still over 80% gets another pass immediately. Prune is last-resort, never an
 * abort. PURE — the loop only executes the next step and re-measures.
 */

export const DEFAULT_COMPACT_AT = 0.80;
/** Leave ~8% of the window for the model's reply + tool schemas. */
export const DEFAULT_FIT_RATIO = 0.92;
/** Successive compact passes keep fewer recent turns verbatim. */
export const KEEP_LADDER = [6, 4, 2] as const;

export type PressureLevel = 'ok' | 'soft' | 'hard';

export type ReliefStep =
  | { kind: 'compact'; keepLastTurns: number; reason: string }
  | { kind: 'prune'; maxTokens: number; reason: string };

export function occupancy(tokens: number, window: number): number {
  if (!Number.isFinite(tokens) || !Number.isFinite(window) || window <= 0) return 0;
  return tokens / window;
}

export function pressureLevel(
  tokens: number,
  window: number,
  compactAt = DEFAULT_COMPACT_AT,
): PressureLevel {
  const r = occupancy(tokens, window);
  if (r >= DEFAULT_FIT_RATIO) return 'hard';
  if (r >= compactAt) return 'soft';
  return 'ok';
}

export function fitBudget(window: number, fitRatio = DEFAULT_FIT_RATIO): number {
  if (!Number.isFinite(window) || window <= 0) return 1;
  return Math.max(1, Math.floor(window * fitRatio));
}

/**
 * One next move given current occupancy and how many compact passes already ran
 * this tick. The executor MUST re-call after each step — never run a stale plan.
 */
export function nextRelief(input: {
  tokens: number;
  window: number;
  compactAt?: number;
  /** 0-based count of compact attempts already tried this tick. */
  compactPass?: number;
  /** Compaction is off — skip straight to prune when over the fit line. */
  compactEnabled?: boolean;
}): ReliefStep | null {
  const compactAt = input.compactAt ?? DEFAULT_COMPACT_AT;
  const pass = input.compactPass ?? 0;
  const enabled = input.compactEnabled !== false;
  const level = pressureLevel(input.tokens, input.window, compactAt);
  if (level === 'ok') return null;

  const pct = Math.round(occupancy(input.tokens, input.window) * 100);

  if (enabled && pass < KEEP_LADDER.length) {
    const keep = KEEP_LADDER[pass]!;
    return {
      kind: 'compact',
      keepLastTurns: keep,
      reason: level === 'hard'
        ? `${pct}% full — emergency compact (keep last ${keep} turns)`
        : `${pct}% ≥ ${Math.round(compactAt * 100)}% — compact (keep last ${keep} turns)`,
    };
  }

  if (level === 'hard' || occupancy(input.tokens, input.window) >= compactAt) {
    const maxTokens = fitBudget(input.window);
    return {
      kind: 'prune',
      maxTokens,
      reason: `${pct}% still over the fit line — prune to ${maxTokens} tokens`,
    };
  }
  return null;
}
