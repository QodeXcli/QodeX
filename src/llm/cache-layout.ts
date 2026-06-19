/**
 * KV-cache-aware prompt layout + throughput accounting.
 *
 * WHY THIS MATTERS (local-first specific): on llama.cpp / LM Studio / Ollama the
 * single biggest per-turn latency cost is *prompt prefill* — re-reading the whole
 * conversation through the model before a single new token is produced. These servers
 * avoid that by reusing the KV cache for the longest **byte-stable prefix** shared with
 * the previous request. If anything early in the prompt changes between turns (the
 * system block, the tool schemas, an injected notice prepended at the top), the cache
 * is invalidated from that point on and the whole tail is re-prefilled.
 *
 * QodeX already does two things right: the tool schema list is sorted deterministically
 * (registry.getSchemas), and the system message is built once and persists in history.
 * This module makes the property *observable and enforceable*:
 *
 *   - `commonPrefixLength()` / `describeCacheReuse()` — how many leading messages this
 *     turn are identical to last turn (→ how much KV cache the server can reuse).
 *   - `computeThroughput()` — tokens/sec, so a regression in cache reuse shows up as a
 *     throughput drop in the logs instead of a vague "it got slower".
 *
 * All pure functions — no I/O, fully unit-testable, no model required.
 */

import type { Message } from '../session/store.js';

/** Canonical, stable serialization of a single message for prefix comparison.
 *  Includes exactly the fields that go on the wire and affect the KV cache. */
export function serializeMessage(m: Message): string {
  const parts: string[] = [`role:${m.role}`];
  parts.push(`content:${m.content ?? ''}`);
  if (m.tool_call_id) parts.push(`tcid:${m.tool_call_id}`);
  if (m.name) parts.push(`name:${m.name}`);
  if (m.tool_calls && m.tool_calls.length) {
    for (const tc of m.tool_calls) {
      parts.push(`tc:${tc.function.name}(${tc.function.arguments})`);
    }
  }
  return parts.join('');
}

/** Number of leading messages that are byte-identical between two message arrays.
 *  This is the prefix the inference server can serve from KV cache. */
export function commonPrefixLength(a: Message[], b: Message[]): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  for (; i < n; i++) {
    if (serializeMessage(a[i]!) !== serializeMessage(b[i]!)) break;
  }
  return i;
}

/** Approximate character count of the first `n` messages (proxy for cached tokens). */
export function prefixChars(messages: Message[], n: number): number {
  let chars = 0;
  for (let i = 0; i < Math.min(n, messages.length); i++) {
    chars += serializeMessage(messages[i]!).length;
  }
  return chars;
}

export interface CacheReuse {
  /** Leading messages shared with the previous turn. */
  reusedMessages: number;
  /** Total messages dispatched this turn. */
  totalMessages: number;
  /** Index of the first message that differs (=== reusedMessages), or -1 if fully shared. */
  changedAt: number;
  /** Fraction of messages reused (0..1). */
  reuseRatio: number;
  /** Approx chars served from cache. */
  reusedChars: number;
}

/** Compare this turn's prompt against the previous turn's to estimate KV-cache reuse. */
export function describeCacheReuse(prev: Message[] | null, next: Message[]): CacheReuse {
  if (!prev || prev.length === 0) {
    return { reusedMessages: 0, totalMessages: next.length, changedAt: 0, reuseRatio: 0, reusedChars: 0 };
  }
  const reused = commonPrefixLength(prev, next);
  return {
    reusedMessages: reused,
    totalMessages: next.length,
    changedAt: reused < next.length ? reused : -1,
    reuseRatio: next.length === 0 ? 0 : reused / next.length,
    reusedChars: prefixChars(next, reused),
  };
}

/** Output tokens per second. Returns 0 for non-positive latency to avoid Infinity. */
export function computeThroughput(outputTokens: number, latencyMs: number): number {
  if (latencyMs <= 0 || outputTokens <= 0) return 0;
  return (outputTokens / latencyMs) * 1000;
}
