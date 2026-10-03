/**
 * Schedule continuity and change-only notifications — for monitors ("check the price of
 * X every hour", "watch this page", "summarize new issues").
 *
 *   - continuity: each run gets the previous run's answer, so it can report only what
 *     changed instead of repeating itself.
 *   - notify on change: the desktop notification / chat delivery is skipped when the
 *     answer is the same as last time (the run is still recorded).
 *
 * PURE helpers; the runner owns the I/O.
 */
import { createHash } from 'crypto';

/** Longest previous answer carried into the next run. */
export const CONTINUITY_MAX_CHARS = 4000;

/** Strip terminal colors and collapse whitespace so cosmetic noise is not a "change". PURE. */
export function normalizeAnswer(text: string): string {
  return String(text ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

/** Fingerprint of an answer for change detection. PURE. */
export function answerFingerprint(text: string): string {
  return createHash('sha256').update(normalizeAnswer(text)).digest('hex').slice(0, 16);
}

/** The answer kept for the next run (its tail when long). PURE. */
export function keepForContinuity(text: string): string {
  const t = normalizeAnswer(text);
  return t.length > CONTINUITY_MAX_CHARS ? '…' + t.slice(-CONTINUITY_MAX_CHARS) : t;
}

/** The prompt of a continuity run: the task plus the previous run's answer. PURE. */
export function continuityPrompt(prompt: string, previousAnswer: string | null | undefined): string {
  const prev = (previousAnswer ?? '').trim();
  if (!prev) return prompt;
  return [
    prompt,
    '',
    '[CONTINUITY] This task runs on a schedule. The previous run reported:',
    '<<<PREVIOUS_RUN',
    prev,
    'PREVIOUS_RUN>>>',
    'Compare with it: report what changed since then. If nothing meaningful changed, say exactly "No change since the last run."',
  ].join('\n');
}

export interface ChangeDecision {
  /** Fingerprint to store for the next comparison. */
  fingerprint: string;
  /** Whether the user should be notified about this run. */
  notify: boolean;
  /** Why a notification was skipped (for the log). */
  skippedBecause?: string;
}

/** Decide whether a finished run is worth a notification. PURE. */
export function decideChange(answer: string, previousFingerprint: string | null | undefined, notifyOnChange: boolean): ChangeDecision {
  const fingerprint = answerFingerprint(answer);
  if (!notifyOnChange) return { fingerprint, notify: true };
  if (previousFingerprint && previousFingerprint === fingerprint) {
    return { fingerprint, notify: false, skippedBecause: 'same answer as the previous run' };
  }
  if (/^no change since the last run\.?$/i.test(normalizeAnswer(answer).split('\n').pop() ?? '')) {
    return { fingerprint, notify: false, skippedBecause: 'the run reported no change' };
  }
  return { fingerprint, notify: true };
}
