/**
 * Escalating cascade judge (Phase 5).
 *
 * Ensembling several heavy models per decision would crawl on local hardware. Instead we
 * cascade: a fast LOCAL model (Tier 1) scores every candidate on a fixed rubric, and we
 * escalate to a heavy CLOUD model (Tier 2) ONLY when Tier 1 is genuinely unsure —
 * detected from the scores themselves:
 *
 *   - Twilight zone: the average lands in the grey middle (5.5–7.5).
 *   - High variance: the rubric dimensions disagree sharply (σ > 2.5) — e.g. safety 10 but
 *     efficiency 2 — which means the local model is confused, not confident.
 *
 * So ~90% of clear-cut cases finish locally in <2s; the cloud is paid only when it matters.
 *
 * A light SELF-IMPROVEMENT loop (Feedback Alignment Drift): whenever we escalate, we log
 * |Tier2 − Tier1| per dimension. If that drift trends UP, the curator injects a few Tier-2
 * corrections as few-shot examples into Tier-1's prompt so the local judge re-calibrates.
 *
 * All scoring math is PURE and unit-tested.
 */
import { tryParseJson } from '../../llm/constrained.js';

export interface RubricScores {
  readability: number;
  efficiency: number;
  completeness: number;
  safety: number;
  justification: string;
}


function dimValues(s: RubricScores): number[] {
  return [s.readability, s.efficiency, s.completeness, s.safety];
}

export function rubricAverage(s: RubricScores): number {
  const v = dimValues(s);
  return v.reduce((a, b) => a + b, 0) / v.length;
}

export function rubricStdDev(s: RubricScores): number {
  const v = dimValues(s);
  const avg = v.reduce((a, b) => a + b, 0) / v.length;
  const variance = v.reduce((a, b) => a + (b - avg) ** 2, 0) / v.length;
  return Math.sqrt(variance);
}

export interface EscalationConfig {
  twilightLow: number;   // default 5.5
  twilightHigh: number;  // default 7.5
  maxStdDev: number;     // default 2.5
}
export const DEFAULT_ESCALATION: EscalationConfig = { twilightLow: 5.5, twilightHigh: 7.5, maxStdDev: 2.5 };

/** Escalate to the heavy model when Tier 1 is in the grey middle OR its dimensions disagree. */
export function shouldEscalate(scores: RubricScores, cfg: EscalationConfig = DEFAULT_ESCALATION): boolean {
  const avg = rubricAverage(scores);
  const inTwilight = avg >= cfg.twilightLow && avg <= cfg.twilightHigh;
  const confused = rubricStdDev(scores) > cfg.maxStdDev;
  return inTwilight || confused;
}

/** Map a rubric to a pass/fail verdict: pass only when clearly good and nothing is unsafe. */
export function rubricToVerdict(scores: RubricScores, passAvg = 7.5, minSafety = 6): boolean {
  return rubricAverage(scores) >= passAvg && scores.safety >= minSafety;
}

// ── prompt + parse ────────────────────────────────────────────────────────────

export function buildRubricPrompt(candidateMd: string, calibrationExamples = '', codebaseFitNote = ''): { system: string; user: string } {
  const system =
    'You are an independent reviewer scoring a machine-captured "skill" (a reusable playbook) ' +
    'on FOUR dimensions, each 1–10:\n' +
    '  - readability: is the playbook clear and well-structured?\n' +
    '  - efficiency: is the approach it prescribes efficient (no needless steps)?\n' +
    '  - completeness: does it cover the task class, not just one instance?\n' +
    '  - safety: would following it avoid destructive / wrong actions?\n' +
    'Be strict and honest; default low when unsure.' +
    // Code-graph signal (QodeX-only): how grounded the skill is in THIS project's real symbols.
    (codebaseFitNote ? `\n\nGROUNDING SIGNAL — ${codebaseFitNote}` : '') +
    (calibrationExamples ? `\n\n${calibrationExamples}` : '') +
    '\n\nRespond with STRICT JSON only:\n' +
    '{"readability":n,"efficiency":n,"completeness":n,"safety":n,"justification":"..."}';
  const user = `## Candidate skill\n\`\`\`\n${candidateMd.slice(0, 8000)}\n\`\`\`\n\nScore it now.`;
  return { system, user };
}

/** Parse rubric scores; clamps to 1–10. Returns null on unparseable output (caller treats
 *  a missing Tier-1 score as "escalate"). */
export function parseRubricScores(text: string): RubricScores | null {
  const p = tryParseJson(text) as any;
  if (!p || typeof p !== 'object') return null;
  const num = (x: any) => (typeof x === 'number' && Number.isFinite(x) ? Math.max(1, Math.min(10, x)) : null);
  const r = num(p.readability), e = num(p.efficiency), c = num(p.completeness), s = num(p.safety);
  if (r === null || e === null || c === null || s === null) return null;
  return { readability: r, efficiency: e, completeness: c, safety: s, justification: typeof p.justification === 'string' ? p.justification : '' };
}

// ── feedback alignment drift (self-improvement) ────────────────────────────────

export interface DriftRecord { ts: string; tier1: RubricScores; tier2: RubricScores; drift: number }

/** Mean absolute per-dimension difference between the two tiers — how far Tier 1 was off. */
export function alignmentDrift(tier1: RubricScores, tier2: RubricScores): number {
  const a = dimValues(tier1), b = dimValues(tier2);
  return a.reduce((sum, x, i) => sum + Math.abs(x - b[i]!), 0) / a.length;
}

/**
 * Is Tier 1 drifting OUT of alignment? Compares the mean drift of the most recent `window`
 * escalations to the prior `window`. Rising drift ⇒ recalibrate Tier 1. PURE.
 */
export function isDriftRising(records: DriftRecord[], window = 10): boolean {
  if (records.length < window * 2) return false;
  const recent = records.slice(-window);
  const prior = records.slice(-window * 2, -window);
  const mean = (rs: DriftRecord[]) => rs.reduce((a, r) => a + r.drift, 0) / rs.length;
  return mean(recent) > mean(prior);
}

/** Build the few-shot calibration block from the worst recent disagreements, to inject into
 *  Tier 1's prompt so it learns to score like Tier 2. Empty when there's nothing to learn. */
export function buildCalibrationBlock(records: DriftRecord[], k = 3): string {
  if (records.length === 0) return '';
  const worst = [...records].sort((a, b) => b.drift - a.drift).slice(0, k);
  if (worst.length === 0) return '';
  const lines = ['CALIBRATION — on these, a senior reviewer scored differently than you tend to; match this calibration:'];
  for (const r of worst) {
    lines.push(`- correct scores: readability ${r.tier2.readability}, efficiency ${r.tier2.efficiency}, completeness ${r.tier2.completeness}, safety ${r.tier2.safety}${r.tier2.justification ? ` — ${r.tier2.justification.slice(0, 100)}` : ''}`);
  }
  return lines.join('\n');
}
