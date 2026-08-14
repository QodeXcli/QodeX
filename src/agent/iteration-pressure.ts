/**
 * Iteration pressure — the step cap is a fuse, not a finish line.
 *
 * Hitting `defaults.maxIterations` while the agent is still making progress
 * must NOT kill the task. The user should not have to remember `/unlimited`
 * before a real project. The cap only fires when existing runaway detectors
 * already say the run is stuck (tight tool loop, error loop, read-loop abort,
 * or a streak of empty failures).
 *
 * PURE — the loop decides with this, then either extends the cap or stops.
 */

export const EXTEND_CHUNK = 50;

export type IterationVerdict = 'ok' | 'extend' | 'stop';

export interface IterationSignals {
  /** True when detectStuckLoop fired on the recent-call window. */
  stuckLoop: boolean;
  /** True when detectErrorLoop found the same tool+code repeating. */
  errorLoop: boolean;
  /** True when the read-loop hard cap would abort. */
  readAbort: boolean;
  /** Consecutive empty/error results from the same tool. */
  consecutiveFailures: number;
}

export function decideIterationPressure(
  atCap: boolean,
  signals: IterationSignals,
): IterationVerdict {
  if (!atCap) return 'ok';
  if (signals.readAbort || signals.stuckLoop || signals.errorLoop) return 'stop';
  if (signals.consecutiveFailures >= 4) return 'stop';
  return 'extend';
}

export function nextIterationCap(currentCap: number, chunk = EXTEND_CHUNK): number {
  const base = currentCap > 0 ? currentCap : chunk;
  return base + chunk;
}
