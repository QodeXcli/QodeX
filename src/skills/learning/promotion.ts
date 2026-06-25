/**
 * Promotion decision — the gate between a quarantined candidate and an active skill.
 *
 * This is where the self-congratulation failure mode is killed for good. A candidate is
 * promoted ONLY if ALL hold:
 *
 *   1. INDEPENDENT JUDGE. The verdict came from a model DIFFERENT from the one that
 *      authored the task/candidate. A model grading its own work is rejected outright —
 *      no "fall back to the same model" escape hatch (that fallback is exactly the bug
 *      in self-grading loops). If no independent judge is available, the candidate stays
 *      a candidate; it is never promoted on a self-grade.
 *
 *   2. JUDGE PASSED. The independent judge's verdict is `pass`.
 *
 *   3. HUMAN SKILLS ARE IMMUTABLE. If an ACTIVE skill of the same name exists and is
 *      human-authored/edited, promotion is refused — the candidate cannot overwrite it.
 *      (A machine-owned active skill of the same name MAY be replaced — curating its own
 *      earlier capture.)
 *
 * Pure function → the guarantee is unit-tested and lives in one place.
 */
import { isProtected, type ProvenanceLike } from '../provenance.js';
import type { JudgeVerdict, PromotionDecision } from './types.js';

export interface PromotionInput {
  /** The model that authored the task whose trajectory produced this candidate. */
  authorModel: string;
  /** The independent judge's verdict (or null if no independent judge ran). */
  verdict: JudgeVerdict | null;
  /** The currently-active skill of the same name, if any (its provenance fields). */
  activeSameName?: ProvenanceLike | null;
}

export function decidePromotion(input: PromotionInput): PromotionDecision {
  const { authorModel, verdict, activeSameName } = input;

  // 1 + 2: independent, passing judge — no self-grade, no fallback.
  if (!verdict) {
    return { promote: false, reason: 'no independent judge verdict — candidate stays quarantined (self-grade is never accepted)' };
  }
  if (!verdict.judgeModel || verdict.judgeModel === authorModel) {
    return { promote: false, reason: `judge model (${verdict.judgeModel || 'unknown'}) is the same as the author model — self-grade rejected; configure a separate reflection model` };
  }
  if (!verdict.pass) {
    return { promote: false, reason: `independent judge rejected the candidate: ${verdict.reasons.join('; ') || 'no reason given'}` };
  }

  // 3: never overwrite a human-authored/edited skill.
  if (activeSameName && isProtected(activeSameName)) {
    return { promote: false, reason: 'an active human-authored skill of the same name exists — refusing to overwrite it; keep this as a candidate or rename it' };
  }

  return { promote: true, reason: `independent judge (${verdict.judgeModel}) passed it and no protected skill blocks the name` };
}
