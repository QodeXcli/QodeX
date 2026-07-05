/**
 * Tool-result aging (context diet for large, old, NON-read results).
 *
 * The gap this fills: dedup.ts handles *identical* repeated results, and
 * read-cache.ts handles *file reads* (supersede + opt-in outline aging). But a
 * large UNIQUE result — a 60KB `shell` build log, a wall of `grep` matches, a
 * `browser_*` page snapshot — is carried IN FULL on every subsequent iteration
 * until the 0.75×ctx auto-compact threshold, which short/medium tasks never
 * reach. One 60KB log emitted at turn 2 of a 10-iteration task costs its ~15k
 * tokens again on every one of the remaining 8 requests (~120k tokens) — the
 * same order as an entire observed 46-minute run.
 *
 * Strategy: once a tool result is older than `minAgeTurns` assistant turns AND
 * larger than `maxChars`, replace its middle with a marker, keeping a head and a
 * generous TAIL (build/test errors live at the end of logs). The model is told
 * to re-run the tool if it needs the full output — which also yields FRESHER
 * output than the stale copy, so this tends to help accuracy too (less
 * lost-in-the-middle distraction from old walls of text).
 *
 * Like dedup/read-cache, this layer is PURE and only ever SHRINKS the `content`
 * of existing `role:'tool'` messages — never adds, removes, or reorders, so
 * tool_call/tool_result pairing and array length are preserved. The session
 * store keeps originals; only the model-facing copy shrinks. Idempotent via a
 * stub marker. Cache note: the one-time rewrite happens `minAgeTurns` back, so
 * only the most recent turns re-prefill once — repaid every following iteration.
 */
import type { Message } from '../session/store.js';

const AGING_MARK = '[QodeX aged-result]';

/** Tools whose old large outputs are safe to age. read_file/pdf_read are owned by
 * read-cache.ts; todo/memory/skill tools are tiny or semantically load-bearing. */
const AGEABLE = new Set([
  'shell',
  'grep',
  'glob',
  'ls',
  'diagnostics',
  'dev_server_start',
  'dev_server_logs',
  'browser_open',
  'browser_snapshot',
  'browser_evaluate',
  'browser_console',
  'http_request',
  'openapi_digest',
  'backend_routemap',
]);

export interface AgingOptions {
  /** Results older than this many assistant turns are eligible. */
  minAgeTurns?: number;
  /** Only results longer than this many chars are aged. */
  maxChars?: number;
  /** Chars kept from the start. */
  keepHead?: number;
  /** Chars kept from the end (bigger: errors live at the tail of logs). */
  keepTail?: number;
}

export interface AgingResult {
  messages: Message[];
  aged: number;
  bytesSaved: number;
}

export function ageToolResults(messages: Message[], opts: AgingOptions = {}): AgingResult {
  const minAgeTurns = opts.minAgeTurns ?? 2;
  const maxChars = opts.maxChars ?? 5_000;
  const keepHead = opts.keepHead ?? 1_500;
  const keepTail = opts.keepTail ?? 2_500;

  // Map each message index to its age in assistant turns counted from the end.
  // A tool result's age = number of assistant messages that come AFTER it.
  const assistantAfter: number[] = new Array(messages.length).fill(0);
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    assistantAfter[i] = seen;
    if (messages[i]!.role === 'assistant') seen++;
  }

  let aged = 0;
  let bytesSaved = 0;
  const out = messages.map((m, i) => {
    if (m.role !== 'tool') return m;
    const name = (m as any).name as string | undefined;
    if (!name || !AGEABLE.has(name)) return m;
    const content = typeof m.content === 'string' ? m.content : '';
    if (content.length <= maxChars) return m;
    if (content.startsWith(AGING_MARK)) return m; // idempotent
    if (assistantAfter[i]! < minAgeTurns) return m; // too recent — model may still need it

    const head = content.slice(0, keepHead);
    const tail = content.slice(-keepTail);
    const omitted = content.length - keepHead - keepTail;
    const stub =
      `${AGING_MARK} Large ${name} output from an earlier turn — middle ${omitted} chars omitted to keep context lean. ` +
      `Re-run the tool if you need the full, fresh output.\n` +
      `--- head ---\n${head}\n--- tail (errors usually live here) ---\n${tail}`;
    if (stub.length >= content.length) return m; // no win — keep original

    aged++;
    bytesSaved += content.length - stub.length;
    return { ...m, content: stub };
  });

  return { messages: out, aged, bytesSaved };
}
