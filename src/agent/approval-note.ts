/**
 * Keeping the model in step with the session's approval mode.
 *
 * The system prompt is built once per conversation (buildInitialMessages), so when the
 * user flips into or out of the autonomous 'auto' mode mid-session (Shift+Tab, /auto, an
 * "always yes" answer, a bot's /auto) the running model would keep behaving as before —
 * asking questions in auto, or never asking after auto was turned off. The agent loop
 * compares what the conversation last told the model with the live mode at every
 * iteration and, on a difference, injects one short note.
 *
 * Only autonomy matters to the model: 'manual' and 'edits' differ in which tool prompts
 * appear, which the tools handle themselves.
 */
import type { Message } from '../session/store.js';
import { AUTONOMOUS_SECTION_TITLE } from '../llm/prompts/system.js';

/** Marker every mode note starts with (also how a later run finds the latest one). */
export const APPROVAL_NOTE_PREFIX = '[APPROVAL MODE:';

/** The note injected when the session switches into / out of auto. PURE. */
export function approvalModeNote(autonomous: boolean, modeLabel: string = autonomous ? 'auto' : 'manual'): string {
  if (autonomous) {
    return (
      `${APPROVAL_NOTE_PREFIX} AUTO] The user switched to auto mode and is not answering questions now. ` +
      'From here on do not ask clarifying or permission questions: pick sensible defaults, note each ' +
      'assumption and list them in your final answer. Only purchases, payments, passwords, sending ' +
      'messages and destructive actions outside the project still stop for the user.'
    );
  }
  return (
    `${APPROVAL_NOTE_PREFIX} ${modeLabel.toUpperCase()}] The user left auto mode. Tools may ask for ` +
    'permission again, and you may ask the user when you are genuinely blocked.'
  );
}

/**
 * Does the conversation tell the model it is autonomous? The LATEST mode note wins; with
 * none, the system prompt's "Autonomous mode" section decides. PURE.
 */
export function conversationSaysAutonomous(messages: readonly Message[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'user' || typeof m.content !== 'string') continue;
    const at = m.content.lastIndexOf(APPROVAL_NOTE_PREFIX);
    if (at < 0) continue;
    return m.content.startsWith(`${APPROVAL_NOTE_PREFIX} AUTO]`, at);
  }
  const sys = messages.find(m => m.role === 'system');
  return typeof sys?.content === 'string' && sys.content.includes(AUTONOMOUS_SECTION_TITLE);
}
