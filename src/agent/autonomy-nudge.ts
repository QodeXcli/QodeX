/**
 * Auto mode's answer to a prose question. There is no prompt for "Should I proceed?" —
 * the model just ends its turn with it, and in auto mode nobody replies (the user turned
 * auto on to walk away; in headless / missions the question would be the final output).
 * The agent loop checks a tool-less final answer once per run and, when it ends by asking
 * the user to decide or confirm, sends AUTONOMY_NUDGE so the model decides and goes on.
 *
 * Deliberately narrow: only the LAST line, only a real question to the user, and never the
 * "Next: …?" follow-up offer the Output Style asks for at the end of a finished task.
 */

/** The note the loop injects (once per run). */
export const AUTONOMY_NUDGE =
  '[AUTONOMOUS_MODE] Auto mode is on and the user is not answering questions. Do not wait for a reply: ' +
  'choose the option you judge best, state that assumption in one line, and continue the task now. ' +
  'If the task is already complete, give your final answer (with any assumptions) without the question.';

const ASKS_USER: readonly RegExp[] = [
  /\b(?:should|shall|can|may) I\b/i,
  /\b(?:do|would) you (?:want|like|prefer)\b/i,
  /\bwant me to\b/i,
  /\b(?:which|what) (?:option|approach|one|version|library|framework|database|name|port|path|format)\b/i,
  /\b(?:please )?confirm\b/i,
  /\bis (?:that|this|it) (?:ok|okay|fine|correct|right|acceptable)\b/i,
  /\bhow (?:would|do) you (?:like|want)\b/i,
  /\b(?:proceed|go ahead|continue)\b/i,
  /(?:آیا|می‌خواهید|میخواهید|می‌خوای|میخوای|ادامه بد[هم]|ادامه دهم|تأیید می‌کنید|تایید می‌کنید|کدام|کدوم)/,
];

/** Does `text` end by asking the user to decide / confirm something? PURE. */
export function endsWithQuestionToUser(text: string | null | undefined): boolean {
  if (!text) return false;
  const lines = String(text)
    .replace(/```[\s\S]*?```/g, '') // a question inside a code block is not one
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return false;
  const last = lines[lines.length - 1]!.replace(/[*_`\s]+$/u, '');
  if (!/[?؟]$/u.test(last)) return false;
  // The Output Style's follow-up offer ("Next: want me to run the tests?") ends a finished task.
  if (/^[*_>\-\s]*(?:next|بعدی|قدم بعدی)\s*[:：]/iu.test(last)) return false;
  return ASKS_USER.some(p => p.test(last));
}
