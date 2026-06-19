/**
 * Read-cache (context compaction for file reads).
 *
 * On file-heavy tasks the agent reads the same large files more than once (full
 * file, then a section, then again next turn). Every read drops the file's full
 * text into the model's context, so the window balloons — a single bug-hunt was
 * observed at ~868k tokens. This module shrinks redundant read results WITHOUT
 * losing information the model can't recover:
 *
 *   1. LOSSLESS for the agent's purposes (always on): if a later read of the SAME
 *      path supersedes an earlier one — a later FULL read covers any earlier read
 *      of that path, and a later read of the identical range/symbol covers the
 *      earlier identical one — the earlier result's body is replaced with a
 *      one-line stub. The superseding (later) copy still carries the file's
 *      CURRENT content, which is what a coding agent works against. (Caveat: if the
 *      file was EDITED between the two reads, the earlier pre-edit bytes are
 *      intentionally dropped in favour of the current copy — recover prior bytes
 *      from git/snapshots, not context. So it is lossless w.r.t. current state,
 *      not a byte-for-byte archive of every version seen.)
 *
 *   2. AGING-OUTLINE (default ON since v1.84; opt-out via config.context.readCacheAging:false): a non-superseded
 *      read older than the recent window has its body replaced with an
 *      outline-preserving stub (the OUTLINE block from read_file's own output,
 *      plus a line count) and a note to re-read for exact lines. Lossy, but the
 *      model can always call read_file again to get the body back.
 *
 * It only ever SHRINKS the `content` of an existing `role:'tool'` message — it
 * never adds, removes, or reorders messages — so a tool_call is never severed
 * from its tool_result and the array length is preserved.
 */
import type { Message } from '../session/store.js';

const READ_TOOLS = new Set(['read_file', 'pdf_read']);
const STUB_MARK = '[QodeX context-cache]';

interface ReadTarget {
  path: string;
  full: boolean; // whole-file read (no offset/limit/symbol)
  key: string; // identity for "same slice" matching
}

export interface ReadCacheOptions {
  /** Tool-results within the last N messages are never aged out (superseded
   *  reads are still collapsed — that's lossless). Default 24. */
  recentWindow?: number;
  /** Opt-in: age non-superseded reads older than recentWindow into an
   *  outline-preserving stub. Lossy but re-fetchable. Default true (v1.84+). */
  agingOutline?: boolean;
}

function parseArgs(raw: unknown): any {
  if (!raw) return {};
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function readTargetFor(args: any): ReadTarget | null {
  const path = args?.path ?? args?.file_path ?? args?.filePath;
  if (!path || typeof path !== 'string') return null;
  const { offset, limit, symbol } = args;
  const full = offset == null && limit == null && (symbol == null || symbol === '');
  const key = full
    ? `${path}\u0000FULL`
    : `${path}\u0000o${offset ?? ''}:l${limit ?? ''}:s${symbol ?? ''}`;
  return { path, full, key };
}

/** Extract the structural outline block from a read_file result, if present. */
export function extractOutline(content: string | null): string | null {
  if (!content) return null;
  const idx = content.indexOf('OUTLINE');
  if (idx === -1) return null;
  const tail = content.slice(idx);
  const stop = tail.search(/\n\s*(HEAD\b|---|===|\.\.\.)/);
  const block = (stop === -1 ? tail : tail.slice(0, stop)).trim();
  const lines = block.split('\n').slice(0, 40).join('\n').trim();
  return lines || null;
}

function approxLineCount(content: string | null): number | null {
  if (!content) return null;
  return (content.match(/\n/g)?.length ?? 0) + 1;
}

function supersededStub(path: string): string {
  return `${STUB_MARK} Full content of ${path} elided to save context — this same file is read again later in the conversation (use that copy), or call read_file again if you need it now.`;
}

function agedStub(path: string, content: string | null): string {
  const outline = extractOutline(content);
  const n = approxLineCount(content);
  const meta = n ? ` (~${n} lines)` : '';
  const head = `${STUB_MARK} ${path} was read earlier this session; its body is elided here to save context${meta}.`;
  return outline
    ? `${head}\nOutline:\n${outline}\nCall read_file on this path for exact lines (e.g. to patch).`
    : `${head}\nCall read_file on this path if you need its current contents (e.g. to patch).`;
}

function isStub(content: string | null): boolean {
  return typeof content === 'string' && content.startsWith(STUB_MARK);
}

/**
 * Shrink redundant file-read tool results. Returns a NEW array (input is never
 * mutated); array length and message order are preserved.
 */
export function compactFileReads(messages: Message[], opts: ReadCacheOptions = {}): Message[] {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const recentWindow = opts.recentWindow ?? 24;

  // 1) tool_call_id -> ReadTarget, from assistant tool_calls that name a read tool.
  const targetById = new Map<string, ReadTarget>();
  for (const m of messages) {
    if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
    for (const tc of m.tool_calls) {
      if (!tc?.function || !READ_TOOLS.has(tc.function.name)) continue;
      const t = readTargetFor(parseArgs(tc.function.arguments));
      if (t) targetById.set(tc.id, t);
    }
  }
  if (targetById.size === 0) return messages;

  // 2) read tool-result messages, in order.
  const reads: Array<{ idx: number; t: ReadTarget }> = [];
  messages.forEach((m, idx) => {
    if (m.role === 'tool' && m.tool_call_id && targetById.has(m.tool_call_id)) {
      reads.push({ idx, t: targetById.get(m.tool_call_id)! });
    }
  });
  if (reads.length === 0) return messages;

  // 3) superseded: an earlier read covered by a LATER read of the same path
  //    (later full read, or later identical slice).
  const superseded = new Set<number>();
  for (let i = 0; i < reads.length; i++) {
    for (let j = i + 1; j < reads.length; j++) {
      if (reads[j].t.path !== reads[i].t.path) continue;
      if (reads[j].t.full || reads[j].t.key === reads[i].t.key) {
        superseded.add(reads[i].idx);
        break;
      }
    }
  }

  // 4) rewrite. Superseded → lossless stub (any age). Else, if aging is on and the
  //    read is older than the recent window → outline stub.
  const boundary = messages.length - recentWindow;
  const idxToTarget = new Map(reads.map(r => [r.idx, r.t]));
  let changed = false;
  const out = messages.map((m, idx) => {
    const t = idxToTarget.get(idx);
    if (!t) return m;
    if (isStub(m.content)) return m; // already compacted on a prior pass
    if (superseded.has(idx)) {
      changed = true;
      return { ...m, content: supersededStub(t.path) };
    }
    if (opts.agingOutline && idx < boundary) {
      changed = true;
      return { ...m, content: agedStub(t.path, m.content) };
    }
    return m;
  });
  return changed ? out : messages;
}
