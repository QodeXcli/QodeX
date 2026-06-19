/**
 * Mid-task steering (`/btw …`).
 *
 * Lets the user nudge a RUNNING task without stopping it: they type `/btw <note>`
 * while the agent works, the note is queued on the live AgentLoop, and at the top
 * of the next iteration it's injected into the conversation as a framed user
 * message — so the model sees it before its next reasoning step and can adjust
 * course if appropriate. This is advisory, not a command: the model decides
 * whether the note changes what it should do.
 *
 * Pure functions only (no I/O) so the behaviour is unit-testable without a model
 * or a terminal.
 */

/** Matches a leading `/btw` (case-insensitive), with or without trailing text. */
const STEER_PREFIX = /^\/btw\b[ \t]*/i;

/**
 * If `raw` is a steering input (`/btw …`), return the trimmed note (or '' when the
 * user typed just `/btw`). Returns null when it isn't a steering input at all, so
 * the caller can fall through to normal prompt handling.
 */
export function parseSteerInput(raw: string): string | null {
  const m = raw.match(STEER_PREFIX);
  if (!m) return null;
  return raw.slice(m[0].length).trim();
}

/**
 * Frame a steering note as the user message that gets injected mid-task. The
 * framing is deliberate: it tells the model this arrived WHILE it was working,
 * to weigh it now, to adjust course only if it genuinely changes the right next
 * step, and NOT to throw away correct work already done.
 */
export function buildSteerMessage(note: string): string {
  const body = note.trim() || '(the user sent an empty note — ask what they meant only if you were unsure, otherwise continue)';
  return [
    '[STEERING NOTE — the user added this mid-task, without stopping you.]',
    body,
    '[Weigh it now. If it changes what you should do next, adjust course and say so in one line. ' +
      'If it only confirms your current plan, acknowledge briefly and keep going. ' +
      'Do not restart work that is already done correctly.]',
  ].join('\n');
}
