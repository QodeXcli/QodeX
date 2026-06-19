/**
 * Adaptive thinking control — "the tool programs the model's effort."
 *
 * Hybrid-thinking models (Qwen3 family) emit a reasoning block before every
 * response by default. Thinking is decoded in the SLOW direction (~40-60 tok/s
 * on Apple Silicon for a 100B-class MoE), so a 500–2000-token think before each
 * of ~50 routine tool steps ("read the next chunk", "apply the edit") adds tens
 * of minutes of pure deliberation to tasks that don't need it — while the steps
 * that DO need it (planning, diagnosing a failure, recovering from a steer) are
 * exactly where thinking earns its cost.
 *
 * So QodeX decides per iteration:
 *   THINK on: the first iteration (plan the approach), any iteration right
 *   after a tool error (diagnose, don't thrash), a forced re-think (steering
 *   note arrived / verify-gate repair), and periodically on complex tasks
 *   (every Nth iteration — cheap re-grounding against goal drift).
 *   NO-THINK on: everything else — the routine middle of execution.
 *
 * Mechanism: Qwen3-family models are TRAINED on soft switches (`/no_think`,
 * `/think`) — "the model follows the most recent instruction in multi-turn
 * conversations." We only ever append a tiny `/no_think` user message to the
 * OUTBOUND COPY of the request (never the stored history), and only at the very
 * tail — a pure append, so the prompt prefix stays byte-stable for caching.
 * For 'think' decisions we append nothing: thinking is the model's default.
 * Non-Qwen models: no-op (the switch is family-specific trained behavior).
 *
 * Honest scope: this trades deliberation for speed on steps classified as
 * routine. The classifier is conservative (any error → think), but a
 * misclassified step loses its reasoning pass — the periodic re-think bounds
 * how long that can compound. Live effect is only measurable on the Mac.
 */
import type { Message } from '../session/store.js';

export type ThinkingDecision = 'think' | 'no_think';

export interface ThinkingContext {
  /** 1-based agent-loop iteration. */
  iteration: number;
  /** Task classified as complex/build (plan-gate). */
  taskComplex: boolean;
  /** Count of error results in the trailing tool-result block. */
  recentToolErrors: number;
  /** Steering note injected / verify repair issued — re-orient. */
  forceThink: boolean;
  /** Re-ground every Nth iteration on complex tasks (default 8). */
  rethinkEvery?: number;
}

export function decideThinking(ctx: ThinkingContext): ThinkingDecision {
  const every = ctx.rethinkEvery ?? 8;
  if (ctx.iteration <= 1) return 'think';
  if (ctx.forceThink) return 'think';
  if (ctx.recentToolErrors > 0) return 'think';
  if (ctx.taskComplex && every > 0 && ctx.iteration % every === 0) return 'think';
  return 'no_think';
}

/** Soft switches are trained behavior of the Qwen3 family (incl. 3.5). */
export function modelSupportsSoftSwitch(modelId: string): boolean {
  return /qwen-?3/i.test(modelId);
}

/** Count error results in the contiguous block of tool messages at the tail.
 * QodeX tools conventionally prefix failures with "[ERROR]". Pure. */
export function countTrailingToolErrors(messages: Message[]): number {
  let n = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'tool') break;
    const c = typeof m.content === 'string' ? m.content : '';
    if (/^\s*\[ERROR\]/i.test(c) || /^Error:/m.test(c.slice(0, 200))) n++;
  }
  return n;
}

/**
 * Build the outbound message array for this iteration. Pure — returns a NEW
 * array; the stored history is never touched. Only appends; never rewrites.
 */
export function applyThinkingDecision(
  messages: Message[],
  decision: ThinkingDecision,
  modelId: string,
): Message[] {
  if (decision !== 'no_think') return messages; // thinking is the model default
  if (!modelSupportsSoftSwitch(modelId)) return messages;
  return [...messages, { role: 'user', content: '/no_think' } as Message];
}
