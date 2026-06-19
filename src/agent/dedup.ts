import * as crypto from 'crypto';
import type { Message } from '../session/store.js';

/**
 * Tool-result deduplication.
 *
 * Problem: an agent loop frequently re-reads the same file (read_file, edit + verify,
 * test cycle). Each re-read costs the FULL file body in tokens. If nothing changed,
 * shipping the content twice is pure waste.
 *
 * Strategy: hash the content of every tool result we emit. When a later result hashes
 * to the same value AND comes from the same tool/path combo, replace its body with a
 * back-pointer referencing the earlier turn. The model gets a tiny stable marker
 * instead of N KB of repeated content; if it actually needs the body again, it can
 * call the tool — but at that point the agent is likely confused and a re-read is
 * the right move.
 *
 * Scope: this layer is PURE — it inspects + rewrites messages without I/O. The agent
 * loop calls dedupHistory(messages) right before pruneMessages() so it shrinks before
 * the context-budget check.
 *
 * What we DON'T touch:
 *   - The latest tool result. Always kept full. Dedup only applies to historical results.
 *   - Tool results from `bash` or other tools where the same args may legitimately
 *     produce different output (env mutates, process state changes). We dedup only
 *     read-only file-content tools by default.
 *   - The deduped body is shown to the MODEL only. The session store keeps the
 *     original. So `/undo` and resume aren't affected.
 */

/** Tools whose results we safely dedup. Read-only, content-stable. */
const SAFE_FOR_DEDUP = new Set([
  'read_file',
  'ls',
  'glob',
  'code_graph_find_symbol',
  'code_graph_list_symbols',
  'code_graph_explain_symbol',
  // git_status / git_diff intentionally NOT here — working-tree state changes
]);

export interface DedupOptions {
  /** Min content size in bytes worth deduping. Smaller bodies aren't worth a pointer. */
  minBytes?: number;
  /** Keep the most recent N tool results intact regardless. Default 4 (last ~2 turns). */
  keepRecent?: number;
  /** Optional set of extra tool names safe for dedup. */
  extraSafeTools?: Set<string>;
}

export interface DedupResult {
  messages: Message[];
  replaced: number;
  bytesSaved: number;
}

/**
 * Walk messages, find tool messages whose hash matches an earlier tool message with
 * the same (tool_name + tool_call key). Replace the duplicate body with a back-pointer.
 *
 * Pure: returns a new array; the input is unchanged.
 */
export function dedupHistory(messages: Message[], opts: DedupOptions = {}): DedupResult {
  const minBytes = opts.minBytes ?? 200;
  const keepRecent = opts.keepRecent ?? 4;
  const safeTools = opts.extraSafeTools
    ? new Set([...SAFE_FOR_DEDUP, ...opts.extraSafeTools])
    : SAFE_FOR_DEDUP;

  // First pass: index every tool result by (toolName + contentHash) → first turn index.
  // We need toolName, which is stored on the tool message as `name` (we set this in the
  // agent loop when persisting). Without it, dedup is skipped for that message.
  type Indexed = { index: number; toolName: string; hash: string };
  const firstSeen = new Map<string, Indexed>(); // key = toolName + ':' + hash

  // Locate tool-message indices, in order
  const toolIdxs: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role === 'tool') toolIdxs.push(i);
  }
  // Mark which tool messages are within the "keep recent" tail
  const tailStart = Math.max(0, toolIdxs.length - keepRecent);

  const out = messages.slice(); // shallow copy; we'll replace specific entries
  let replaced = 0;
  let bytesSaved = 0;

  for (let pos = 0; pos < toolIdxs.length; pos++) {
    const i = toolIdxs[pos]!;
    const msg = out[i]!;
    const content = msg.content ?? '';
    const toolName = (msg as any).name as string | undefined;
    if (!toolName || !safeTools.has(toolName)) continue;
    if (content.length < minBytes) continue;
    if (pos >= tailStart) continue; // keep recent results full

    const hash = hashContent(content);
    const key = toolName + ':' + hash;
    const seen = firstSeen.get(key);
    if (seen) {
      // Build a pointer line that's also useful to the model — same toolName + hash
      // means the model knows nothing changed without us saying it changed/didn't.
      const pointer =
        `[DEDUP] Same content as turn earlier in this session ` +
        `(tool=${toolName}, sha=${hash.slice(0, 10)}, ${content.length}B suppressed). ` +
        `Reuse what you already saw; call the tool again if you suspect the file changed.`;
      out[i] = { ...msg, content: pointer };
      replaced += 1;
      bytesSaved += content.length - pointer.length;
    } else {
      firstSeen.set(key, { index: i, toolName, hash });
    }
  }

  return { messages: out, replaced, bytesSaved };
}

function hashContent(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}
