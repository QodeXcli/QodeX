/**
 * Types for the skill-learning loop (capture → candidate → independent judge → promote).
 *
 * The whole design exists to capture reusable methodology from successful tasks WITHOUT
 * the self-congratulation failure mode. Two rules are encoded structurally here and in
 * the pure functions that consume these types:
 *   1. Eligibility is gated on OBJECTIVE success (verify/tests clean, completion-claim
 *      passed) — never on the worker model's own "I succeeded".
 *   2. Promotion needs an INDEPENDENT judge (a different model) AND must never overwrite
 *      a human-authored skill.
 */

/** Objective, machine-checkable signals about a finished task. NONE of these is the
 *  model's self-assessment — they come from the verify/completion gates and counters. */
export interface CaptureSignal {
  /** How many tool calls the task took (proxy for "non-trivial, reusable procedure"). */
  toolCalls: number;
  /** Objective verification ran AND found zero NEW errors in touched files. */
  verifyClean: boolean;
  /** The completion-claim gate passed (the model's claims matched session evidence). */
  completionHonest: boolean;
  /** Distinct tool NAMES used — the skill records which tools its procedure needs. */
  toolsUsed: string[];
  /** Files the task created/edited. */
  filesChanged: string[];
}

/** The minimal slice of a recorded trajectory the capture builder needs. */
export interface TrajectorySlice {
  prompt: string;
  finalSummary: string;
  toolsUsed: string[];
  filesChanged: string[];
}

/** A built candidate skill, ready to write to the quarantine dir. */
export interface CandidateSkill {
  /** kebab-case id derived from the task. */
  name: string;
  /** One-line description for the model. */
  description: string;
  /** Full SKILL.md text (frontmatter + body), stamped provenance:machine status:candidate. */
  skillMd: string;
}

/** An independent judge's verdict on a candidate. */
export interface JudgeVerdict {
  pass: boolean;
  /** The model id that produced this verdict — checked against the author to forbid self-grade. */
  judgeModel: string;
  reasons: string[];
}

export interface PromotionDecision {
  promote: boolean;
  reason: string;
}
