/**
 * Wrap-up allowance — what happens when a budget cap is reached mid-task.
 *
 * Stopping the moment the token / USD / iteration / (stall-aware) wall-clock cap is crossed
 * leaves a half-made change on disk and no report. Instead the run gets ONE fixed allowance
 * (config budget.wrapUp): tokens / USD = max(percent of the cap, minimum), wall clock =
 * max(percent, 60 s), and at most `maxIterations` more model calls — the last of them without
 * tools, so the run always ends with a summary. A system note tells the model to wrap up.
 * Crossing a cap again, or using up the steps, is the hard stop — the existing stop path,
 * its message marked "(wrap-up allowance used)".
 *
 * Opt-in per run (AgentOptions.wrapUpAllowance): the TUI and headless runs pass it; sub-agents
 * and missions keep their caps as hard contracts, and `--strict-budget` turns it off. /stop,
 * Esc, Sentinel blocks and loop-guard stops are not budget caps and never reach it.
 */
import type { Message } from '../session/store.js';

export interface WrapUpConfig {
  enabled: boolean;
  /** Allowance as a percent of the cap that was hit (tokens, USD, wall clock). */
  percent: number;
  minTokens: number;
  minUsd: number;
  /** Model calls the allowance covers (the last one has no tools). */
  maxIterations: number;
}

export const DEFAULT_WRAP_UP: WrapUpConfig = { enabled: true, percent: 10, minTokens: 4000, minUsd: 0.05, maxIterations: 3 };

/** Minimum wall-clock allowance: one more model call plus a quick check. */
export const MIN_WRAP_UP_WALL_SECONDS = 60;

export const WRAP_UP_USED = '(wrap-up allowance used)';

export const WRAP_UP_NOTE =
  'Budget reached: wrap up. Leave the work consistent (finish or revert the half-made change, run the quick ' +
  'check if any), summarize what is done and what is left. Do not start anything new.';

/** config budget.wrapUp with defaults for anything missing or invalid. PURE. */
export function resolveWrapUp(raw?: Partial<WrapUpConfig> | null): WrapUpConfig {
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d);
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: r.enabled !== false,
    percent: num(r.percent, DEFAULT_WRAP_UP.percent),
    minTokens: num(r.minTokens, DEFAULT_WRAP_UP.minTokens),
    minUsd: num(r.minUsd, DEFAULT_WRAP_UP.minUsd),
    maxIterations: Math.max(1, Math.floor(num(r.maxIterations, DEFAULT_WRAP_UP.maxIterations))),
  };
}

export type BudgetKind = 'tokens' | 'cost' | 'time' | 'iterations';

/** What was granted (absent dimension = it has no cap). */
export interface WrapUpGrant {
  /** The cap that was hit, and its stop message ("Token budget exceeded: 210000/200000"). */
  budgetType: BudgetKind;
  message: string;
  /** Iteration the allowance started on (the first wrap-up step). */
  grantedAt: number;
  steps: number;
  tokens?: number;
  usd?: number;
  wallSeconds?: number;
}

/** The system note injected when the allowance starts. PURE. */
export function wrapUpNote(g: Pick<WrapUpGrant, 'message' | 'steps'>): string {
  const steps = g.steps === 1
    ? 'You have one more step, for your summary (no tools).'
    : `You have at most ${g.steps} more steps; the last one is for your summary (no tools).`;
  return `[SYSTEM] ${WRAP_UP_NOTE} (${g.message}.) ${steps}`;
}

/** The UI line when the allowance starts. PURE. */
export function wrapUpNotice(g: Pick<WrapUpGrant, 'message' | 'steps'>): string {
  return `⏳ ${g.message} — wrapping up: up to ${g.steps} more step${g.steps === 1 ? '' : 's'} to leave the work consistent and report.`;
}

/** The hard-stop message after the allowance. PURE. */
export function wrapUpStopMessage(message: string): string {
  return `${message} ${WRAP_UP_USED}`;
}

/**
 * Put a system note into the conversation without two user messages in a row: appended to a
 * trailing user message of this run (mutated in place, like the approval-mode note), else to
 * the turn's prompt on the first iteration (a copy — the caller's array is never mutated),
 * else pushed as a new user message (`added`, for the caller to persist).
 */
export function placeSystemNote(
  messages: Message[], newMessages: Message[], note: string,
): { messages: Message[]; added: Message | null } {
  const lastNew = newMessages[newMessages.length - 1];
  const lastOld = messages[messages.length - 1];
  if (lastNew && lastNew.role === 'user' && typeof lastNew.content === 'string') {
    newMessages[newMessages.length - 1] = { ...lastNew, content: `${lastNew.content}\n\n${note}` };
    return { messages, added: null };
  }
  if (!lastNew && lastOld && lastOld.role === 'user' && typeof lastOld.content === 'string') {
    return { messages: [...messages.slice(0, -1), { ...lastOld, content: `${lastOld.content}\n\n${note}` }], added: null };
  }
  const m: Message = { role: 'user', content: note };
  newMessages.push(m);
  return { messages, added: m };
}
