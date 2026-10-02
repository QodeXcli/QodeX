/**
 * Forward AgentLoop events onto the agent bus in a compact, JSON-safe form so the
 * control center timeline, Telegram notifications and mission attach can follow
 * what an agent is doing. Cheap: one small object per forwarded event.
 *
 * Only the event types a human watching a timeline cares about are forwarded;
 * streaming deltas are dropped and large payloads (tool results, final text) are
 * truncated so a chatty page snapshot never floods SSE viewers.
 */

import { getBus } from './bus.js';

const FORWARDED = new Set([
  'iteration_start',
  'tool_call_start',
  'tool_result',
  'final',
  'error',
  'notice',
  'steer_injected',
  'budget_update',
]);

const MAX_TEXT = 600;

function clip(s: unknown, max = MAX_TEXT): string {
  const t = typeof s === 'string' ? s : s == null ? '' : String(s);
  return t.length > max ? t.slice(0, max) + `… [+${t.length - max} chars]` : t;
}

/** Shrink an AgentEvent payload to what a timeline needs. PURE. */
export function compactAgentEvent(type: string, data: any): unknown {
  switch (type) {
    case 'tool_call_start':
      return { id: data?.id, name: data?.name };
    case 'tool_result':
      return { id: data?.id, name: data?.name, isError: !!data?.isError, result: clip(data?.result, 400) };
    case 'final':
      return { content: clip(data?.content, 1500), usage: data?.usage };
    case 'error':
      return { message: clip(data?.message ?? data?.error, 800) };
    case 'notice':
    case 'steer_injected':
      return { message: clip(data?.message ?? data?.note ?? data) };
    case 'iteration_start':
      return { iteration: data?.iteration ?? data?.n };
    case 'budget_update':
      return data && typeof data === 'object'
        ? { tokens: data.tokens ?? data.totalTokens, costUsd: data.costUsd ?? data.cost, iterations: data.iterations }
        : undefined;
    default:
      return undefined;
  }
}

/** Publish one AgentEvent to the bus. Always lands in the bus's small history ring
 *  so a control center opened mid-task still shows recent activity. */
export function forwardAgentEvent(source: string, event: { type: string; data?: unknown }): void {
  if (!FORWARDED.has(event.type)) return;
  try {
    getBus().publish({ kind: 'agent', source, type: event.type, data: compactAgentEvent(event.type, event.data) });
  } catch { /* never let telemetry break the agent */ }
}
