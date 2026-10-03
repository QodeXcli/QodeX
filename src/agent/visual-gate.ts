/**
 * Completion-time visual gate — the closed loop for UI-affecting work.
 *
 * The other finish gates check that the model's code compiles (auto-verify), reads well
 * (critic), and that its claims match its actions (completion gate). None of them check
 * the thing the user actually SEES: when the session produced an artifact (a page, a
 * component, an SVG), did it render right? This gate closes that loop: right before a
 * run finalizes, if the session created/updated an artifact, it runs ONE Layer-3
 * `artifact_review` round on the latest artifact and acts on the verdict:
 *
 *   LOOKS_GOOD           → pass, and stamp the final message with the verdict.
 *   NEEDS_WORK / BROKEN  → bounce back ONCE with the concrete issues so the model can
 *                          `artifact_update`; the next finish attempt reviews again.
 *                          Still failing after that single retry → pass WITH a warning
 *                          line (bounded by design — never loops).
 *   unverified           → pass with a note (no vision backend / no browser — exactly
 *                          the same graceful degradation `artifact_review` itself has).
 *
 * Pure + injectable: artifact detection reads the message history structurally (same
 * MsgLike duck-typing as the completion gate) and the actual review is an injected
 * `ReviewFn`, so the decision logic unit-tests without a browser, a vision model, or
 * the loop. The gate NEVER blocks finishing: any review failure degrades to a note.
 *
 * Follow-ups (kept out of the MVP deliberately):
 *  - Skip the re-review when the model already ran artifact_review on the latest
 *    version and got LOOKS_GOOD (saves a browser+vision round trip).
 *  - Track artifact_rollback too (it also changes what "current" renders).
 */
import type { MsgLike } from './completion-gate.js';
import type { ReviewVerdict } from '../artifacts/review.js';

/** What the injected reviewer reports back (a distilled artifact_review result). */
export interface VisualReviewOutcome {
  verdict: ReviewVerdict;
  /** Concrete issues found (empty when LOOKS_GOOD / unverified). */
  issues: string[];
  /** Optional degrade note (e.g. why the render couldn't be verified). */
  note?: string;
}

/** Runs one Layer-3 review of an artifact. The loop injects the real tool; tests inject a fake. */
export type VisualReviewFn = (artifactId: string) => Promise<VisualReviewOutcome>;

export interface VisualGateDecision {
  /** skip: nothing to review / gate off · pass: finalize · retry: bounce back one corrective turn. */
  action: 'skip' | 'pass' | 'retry';
  /** One-line verdict to append to the final message (present on every pass). */
  verdictLine?: string;
  /** Corrective message to inject when action === 'retry'. */
  correction?: string;
  /** The artifact the decision is about (absent when no artifact was found). */
  artifactId?: string;
}

// Success outputs of the artifact tools (see artifact-tools.ts). Error results
// ("Missing artifact id…", store errors) never match, so only REAL creates/updates count.
const CREATED_RE = /^Created artifact "([^"]+)"/;
const UPDATED_RE = /^Saved "([^"]+)" v\d+/;

/**
 * Find the most recently created/updated artifact in this session's message history,
 * reading the artifact_create/artifact_update TOOL RESULTS (authoritative: they only
 * carry an id on success). Returns null when the session touched no artifacts.
 */
export function findLatestSessionArtifact(messages: MsgLike[]): string | null {
  let latest: string | null = null;
  for (const m of messages) {
    if (m.role !== 'tool') continue;
    const content = typeof m.content === 'string' ? m.content : '';
    if (m.name === 'artifact_create') {
      const match = CREATED_RE.exec(content);
      if (match?.[1]) latest = match[1];
    } else if (m.name === 'artifact_update') {
      const match = UPDATED_RE.exec(content);
      if (match?.[1]) latest = match[1];
    }
  }
  return latest;
}

/** The corrective turn injected when the review says NEEDS_WORK/BROKEN (one retry only). */
export function buildVisualCorrection(artifactId: string, label: string, issues: string[]): string {
  const list = issues.length
    ? issues.map(i => '  • ' + i).join('\n')
    : '  • (no specific issues listed — re-check the render against the intent)';
  return (
    `[VISUAL_GATE] Your artifact "${artifactId}" was rendered and visually reviewed: ${label}.\n` +
    `Problems found:\n${list}\n` +
    `Fix them now with artifact_update id="${artifactId}" (pass the FULL corrected content), ` +
    `then give your final summary. This is the only visual retry — make it count.`
  );
}

/**
 * Decide what the finish path should do about this session's visual output. Pure apart
 * from the injected `reviewFn`; never throws (a crashing review degrades to a pass with
 * an "unverified" note, because a review failure must not block task completion).
 */
export async function runVisualGate(opts: {
  /** Full session history (messages + this run's new messages), duck-typed. */
  messages: MsgLike[];
  /** Gate switch, already resolved by the caller (config ui.visualGate !== false). */
  enabled: boolean;
  /** Has the single corrective retry already been spent this run? */
  retriedAlready: boolean;
  reviewFn: VisualReviewFn;
}): Promise<VisualGateDecision> {
  if (!opts.enabled) return { action: 'skip' };
  const artifactId = findLatestSessionArtifact(opts.messages);
  if (!artifactId) return { action: 'skip' };

  let outcome: VisualReviewOutcome;
  try {
    outcome = await opts.reviewFn(artifactId);
  } catch (e: any) {
    return {
      action: 'pass',
      artifactId,
      verdictLine: `👁 visual check: unverified — review failed (${e?.message ?? e})`,
    };
  }

  switch (outcome.verdict) {
    case 'looks_good':
      return { action: 'pass', artifactId, verdictLine: '👁 visual check: LOOKS_GOOD' };
    case 'unverified':
      return {
        action: 'pass',
        artifactId,
        verdictLine: `👁 visual check: unverified — ${outcome.note || 'no vision backend (set roles.vision.model)'}`,
      };
    case 'needs_work':
    case 'broken': {
      const label = outcome.verdict === 'broken' ? 'BROKEN' : 'NEEDS_WORK';
      if (!opts.retriedAlready) {
        return {
          action: 'retry',
          artifactId,
          correction: buildVisualCorrection(artifactId, label, outcome.issues),
        };
      }
      // Retry budget spent — finish anyway, but say so honestly (never loop).
      const remain = outcome.issues.length
        ? ` — ${outcome.issues.length} issue(s) remain: ${outcome.issues.slice(0, 3).join('; ')}`
        : '';
      return {
        action: 'pass',
        artifactId,
        verdictLine: `👁 visual check: ⚠ still ${label} after 1 fix attempt${remain}`,
      };
    }
  }
}
