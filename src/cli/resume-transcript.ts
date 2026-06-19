/**
 * Repaint a resumed session's prior conversation onto the visible transcript.
 *
 * On resume, the agent's `messages` (its context) are rehydrated so the model remembers
 * everything — but the on-screen `history` started empty, so the user saw a blank screen
 * with just a "Resumed N turns" note. This maps the stored messages back into the readable
 * Q&A the user expects to see when they pick up where they left off.
 *
 * We intentionally show only the human turns and the assistant's text replies — the actual
 * conversation. Tool calls / tool results / internal system messages are omitted: they're
 * machinery, they're already in the model's context, and replaying every one would bury the
 * conversation in noise. Pure and unit-tested (no Ink import) so it can be verified directly.
 */

import type { Message } from '../session/store.js';

/** A subset of ui.tsx's HistoryItem — assignable to HistoryItem[]. */
export interface ResumeHistoryItem {
  type: 'user' | 'assistant';
  text: string;
  id: string;
}

export function messagesToHistory(messages: Message[]): ResumeHistoryItem[] {
  const out: ResumeHistoryItem[] = [];
  let i = 0;
  for (const m of messages) {
    if ((m.role === 'user' || m.role === 'assistant')
      && typeof m.content === 'string'
      && m.content.trim().length > 0) {
      out.push({ type: m.role, text: m.content, id: `resume-${i++}` });
    }
  }
  return out;
}
