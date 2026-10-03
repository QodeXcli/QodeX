import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { isAutonomousMode } from '../../security/permissions.js';
import { autonomousQuestionReply } from '../../security/autonomy.js';
import type { AskUserFn } from '../../agent/ask-meta.js';

const ArgsSchema = z.object({
  question: z.string().describe('One short, specific question'),
  options: z.array(z.string()).describe('2-6 short answers to pick from; put your recommended default first'),
});

type Args = z.infer<typeof ArgsSchema>;

/** Trimmed, de-duplicated (case-insensitive), non-empty options, at most 6. PURE. */
export function cleanOptions(raw: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const o of raw) {
    const s = String(o ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
    if (out.length >= 6) break;
  }
  return out;
}

/** What the model gets when nobody answered (no human, cancelled, timed out). PURE. */
export function noAnswerReply(question: string): string {
  return (
    `[NO_ANSWER] Nobody answered ("${question.slice(0, 200)}") — no one is available, or the question was cancelled.` +
    ' Decide with your best judgment, state the assumption in your final answer, and continue.'
  );
}

/**
 * ask_user — the agent's own clarifying question, with fixed choices.
 *
 * In the autonomous 'auto' approval mode the user is not answering questions: the tool
 * never prompts and returns autonomousQuestionReply() so the model decides, states its
 * assumption and keeps going. Otherwise the question goes through the normal approval
 * surface (terminal, control center, Telegram) tagged as a question — never a permission —
 * so a mode switch never auto-answers it.
 */
export class AskUserTool extends Tool<Args> {
  name = 'ask_user';
  description = 'Ask the user ONE clarifying question with 2-6 fixed choices and wait for the pick. Only when you are truly blocked on a decision you cannot make yourself; not for permission (tools prompt on their own).';
  isReadOnly = true;
  isDestructive = false;
  /** A human may take a while to answer: no tool timeout (the wait is not run time). */
  timeoutSeconds = 0;
  argsSchema = ArgsSchema;

  async execute(args: Args, ctx: ToolContext): Promise<ToolResult> {
    const question = String(args.question ?? '').trim();
    if (!question) return { content: '[ERROR] ask_user needs a question.', isError: true };
    const options = cleanOptions(Array.isArray(args.options) ? args.options : []);

    if (isAutonomousMode()) {
      return { content: autonomousQuestionReply(question, options), metadata: { autonomous: true } };
    }
    if (options.length < 2) {
      return { content: '[ERROR] ask_user needs 2-6 distinct options for the user to pick from.', isError: true };
    }

    const ask = ctx.askUser as AskUserFn;
    let raw: string;
    try {
      raw = await ask(question, options, { kind: 'question' });
    } catch {
      return { content: noAnswerReply(question), metadata: { answered: false } };
    }
    const picked = options.find(o => o.toLowerCase() === String(raw ?? '').trim().toLowerCase());
    if (!picked) return { content: noAnswerReply(question), metadata: { answered: false } };
    return { content: `The user picked: ${picked}`, metadata: { answered: true, answer: picked } };
  }
}
