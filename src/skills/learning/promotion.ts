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
 *      a candidate unless a WITNESS replay passed (rule 4).
 *
 *   2. JUDGE PASSED. The independent judge's verdict is `pass`. An explicit reject is
 *      final — a witness cannot overrule a real second model that said no.
 *
 *   3. HUMAN SKILLS ARE IMMUTABLE. If an ACTIVE skill of the same name exists and is
 *      human-authored/edited, promotion is refused — the candidate cannot overwrite it.
 *      (A machine-owned active skill of the same name MAY be replaced — curating its own
 *      earlier capture.)
 *
 *   4. WITNESSED REPLAY, only when no independent judge exists. The exact diff from the
 *      verified session re-applied cleanly and an objective checker (tsc, ruff, …)
 *      reported zero new errors. That is not a self-grade: the author model is not the
 *      judge. A missing checker is NOT a pass.
 *
 * Pure function → the guarantee is unit-tested and lives in one place.
 */
import { isProtected, type ProvenanceLike } from '../provenance.js';
import type { JudgeVerdict, PromotionDecision } from './types.js';
import type { WitnessVerdict } from './witness.js';

export interface PromotionInput {
  /** The model that authored the task whose trajectory produced this candidate. */
  authorModel: string;
  /** The independent judge's verdict (or null if no independent judge ran). */
  verdict: JudgeVerdict | null;
  /** The currently-active skill of the same name, if any (its provenance fields). */
  activeSameName?: ProvenanceLike | null;
  /**
   * Objective replay of the skill's witness diff. Used ONLY when there is no
   * independent judge (missing, or the same model as the author). Never overrides
   * an independent judge's rejection, and never overrides human-skill protection.
   */
  witness?: WitnessVerdict | null;
}

function witnessPromotes(witness: WitnessVerdict | null | undefined): boolean {
  return witness?.pass === true
    && witness.replay === 'applied'
    && witness.errorCount === 0
    && witness.files > 0
    && !!witness.checker;
}

export function decidePromotion(input: PromotionInput): PromotionDecision {
  const { authorModel, verdict, activeSameName, witness } = input;

  // 3: never overwrite a human-authored/edited skill — not for a judge, not for a witness.
  if (activeSameName && isProtected(activeSameName)) {
    return { promote: false, reason: 'an active human-authored skill of the same name exists — refusing to overwrite it; keep this as a candidate or rename it' };
  }

  const independent = !!verdict?.judgeModel && verdict.judgeModel !== authorModel;
  if (independent && verdict!.pass) {
    return { promote: true, reason: `independent judge (${verdict!.judgeModel}) passed it and no protected skill blocks the name` };
  }
  // An independent "no" is final. A patch replay must not talk over a second model.
  if (independent && !verdict!.pass) {
    return { promote: false, reason: `independent judge rejected the candidate: ${verdict!.reasons.join('; ') || 'no reason given'}` };
  }

  // 4: single-model / no-judge path. The checker is the judge.
  if (witnessPromotes(witness)) {
    return {
      promote: true,
      reason: `witnessed replay (no second model): patch re-applied cleanly, ${witness!.checker} reported 0 new errors on ${witness!.files} file(s)`,
    };
  }

  if (verdict && (!verdict.judgeModel || verdict.judgeModel === authorModel)) {
    return { promote: false, reason: `judge model (${verdict.judgeModel || 'unknown'}) is the same as the author model — self-grade rejected; configure a separate reflection model or run \`qodex skill witness\`` };
  }

  if (witness && witness.replay !== 'absent') {
    return { promote: false, reason: `witness replay did not pass (${witness.replay}${witness.note ? `: ${witness.note}` : ''})` };
  }

  return { promote: false, reason: 'no independent judge verdict — candidate stays quarantined (self-grade is never accepted; a witnessed diff can still promote via `qodex skill witness`)' };
}
