/**
 * Confidence scoring for captured skills — a 0–100 estimate of how trustworthy a
 * candidate is, derived ENTIRELY from objective signals (never a model self-grade,
 * same discipline as captureEligible). It gives the curator a knob beyond pass/fail:
 * auto-promote only above a threshold, sort the review queue, and show it in stats.
 *
 * Pure + deterministic → unit-tested. The weights are intentionally conservative:
 * objective correctness (verified + honest) dominates; volume signals (tool calls,
 * files, tool variety) only nudge, with diminishing returns so a sprawling task can't
 * buy confidence it didn't earn.
 */
import type { CaptureSignal } from './types.js';

export interface ConfidenceBreakdown {
  score: number;                 // 0–100
  factors: Record<string, number>;
}

/** Diminishing-returns curve: 0 at n=0, → cap as n grows. */
function saturate(n: number, cap: number, half: number): number {
  if (n <= 0) return 0;
  return cap * (n / (n + half));
}

export function scoreConfidence(signal: CaptureSignal): ConfidenceBreakdown {
  const factors: Record<string, number> = {};

  // Objective correctness dominates (0 if either fails — a candidate that didn't
  // verify or wasn't honest shouldn't have been captured at all, but score it low).
  factors.verified = signal.verifyClean ? 45 : 0;
  factors.honest = signal.completionHonest ? 25 : 0;

  // Volume signals — diminishing returns, capped, so they only refine.
  factors.toolCalls = saturate(signal.toolCalls, 15, 8);        // ~5 calls → ~5.8, 15 → ~9.8
  factors.toolVariety = saturate(new Set(signal.toolsUsed).size, 8, 4);
  factors.filesTouched = saturate(signal.filesChanged.length, 7, 3);

  const raw = Object.values(factors).reduce((a, b) => a + b, 0);
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  return { score, factors };
}

/** Label for display (review queue / stats). */
export function confidenceLabel(score: number): 'high' | 'medium' | 'low' {
  if (score >= 75) return 'high';
  if (score >= 50) return 'medium';
  return 'low';
}
