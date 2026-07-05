/**
 * Universal tool-result spill guard (context diet, applied at the choke point).
 *
 * The gap this fills: result-aging.ts shrinks large results *2 assistant turns
 * later* — so a 278KB http_request page or a 2000-line sitemap still enters the
 * context WHOLE, is prefilled at least twice, and only then gets trimmed. For a
 * "check these URLs for 404s" task that needed status codes only, that's ~100k
 * wasted tokens before the diet even starts.
 *
 * The structural fix: never let an oversized result into the context at full
 * size. At the single point where a tool result becomes message content
 * (AgentLoop.executeToolCall), any result whose content exceeds
 * `tools.maxResultChars` is:
 *
 *   1. Written IN FULL to a spill file: ~/.qodex/tool-spill/<sessionId>/<seq>-<tool>.txt
 *   2. Replaced in-context by head (~4000 chars) + a marker carrying the REAL
 *      path and retrieval instructions + tail (~2000 chars).
 *
 * The model keeps the shape of the output (headers/status at the head, errors
 * at the tail) and — crucially — knows exactly HOW to get more: `read_file`
 * with offset/limit on the spill path. Nothing is lost, it's just moved out of
 * the per-iteration token bill.
 *
 * Because this runs at ONE choke point, every tool is covered (http_request,
 * web_fetch, shell, grep, browser_*, MCP tools…) with zero per-tool code.
 * Tools that already cap themselves under the limit are naturally untouched
 * (size check first — no double truncation). `isError` and `metadata` are
 * preserved by the caller; this module only produces replacement content.
 *
 * Housekeeping: best-effort at write time — if the spill root grows past
 * `maxDirBytes` (50MB default), the oldest files are pruned until under budget.
 * Spill files are plain .txt so any session (or the user) can inspect them.
 */

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeFileAtomic } from '../utils/atomic-write.js';
import { logger } from '../utils/logger.js';

export const SPILL_MARK = 'chars spilled — full output:';

export interface SpillGuardOptions {
  /** Results longer than this many chars are spilled. 0 disables the guard entirely. */
  maxResultChars: number;
  /** Chars kept in-context from the start (status lines, headers). Default 4000. */
  keepHead?: number;
  /** Chars kept in-context from the end (errors live at the tail). Default 2000. */
  keepTail?: number;
  /** Spill root. Default ~/.qodex/tool-spill. Overridable for tests. */
  baseDir?: string;
  /** Prune-oldest threshold for the spill root. Default 50MB. */
  maxDirBytes?: number;
}

export interface SpillOutcome {
  /** Replacement content if spilled, otherwise the original string, untouched. */
  content: string;
  spilled: boolean;
  /** Absolute path of the spill file, when spilled. */
  spillPath?: string;
}

export function defaultSpillDir(): string {
  return path.join(os.homedir(), '.qodex', 'tool-spill');
}

/** Monotonic per-process sequence so filenames never collide within a session. */
let spillSeq = 0;

/**
 * Apply the spill guard to one tool result's content. Pure decision + one
 * atomic file write. Never throws for the caller's benefit is NOT guaranteed —
 * callers should try/catch and fall back to the original content (a failed
 * spill must never eat the result).
 */
export async function applySpillGuard(
  toolName: string,
  sessionId: string,
  content: string,
  opts: SpillGuardOptions,
): Promise<SpillOutcome> {
  const max = opts.maxResultChars;
  if (!max || max <= 0) return { content, spilled: false }; // 0 = disabled
  if (content.length <= max) return { content, spilled: false }; // under limit — untouched, no double-truncation
  if (content.includes(SPILL_MARK)) return { content, spilled: false }; // already spilled once — idempotent

  const keepHead = opts.keepHead ?? 4_000;
  const keepTail = opts.keepTail ?? 2_000;
  // Degenerate config (head+tail >= max) would "spill" into something no smaller
  // than the original — skip rather than produce a bigger message.
  if (keepHead + keepTail >= content.length) return { content, spilled: false };

  const baseDir = opts.baseDir ?? defaultSpillDir();
  const sessionDir = path.join(baseDir, sanitize(sessionId));
  await fs.mkdir(sessionDir, { recursive: true });

  const seq = String(++spillSeq).padStart(4, '0');
  const spillPath = path.join(sessionDir, `${seq}-${sanitize(toolName)}.txt`);
  await writeFileAtomic(spillPath, content);

  const head = content.slice(0, keepHead);
  const tail = content.slice(-keepTail);
  const replaced = content.length;
  // Marker format is STABLE — the model must always learn the same way how to
  // retrieve the full output. Keep the phrase `chars spilled — full output:` intact.
  const stub =
    `${head}\n… [${replaced} ${SPILL_MARK} ${spillPath} — read_file with offset/limit for more] …\n${tail}`;

  // Best-effort housekeeping — never let a prune failure break the tool result.
  try {
    await pruneSpillDir(baseDir, opts.maxDirBytes ?? 50 * 1024 * 1024);
  } catch (e: any) {
    logger.debug('Spill-dir prune failed (non-fatal)', { err: e?.message });
  }

  return { content: stub, spilled: true, spillPath };
}

/** Filesystem-safe fragment for session ids / tool names. */
function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'unknown';
}

/**
 * If the spill root exceeds `maxBytes`, delete oldest files (by mtime) until
 * under budget. Walks one level of session subdirectories — the only layout we
 * ever write. Best-effort: callers catch.
 */
export async function pruneSpillDir(baseDir: string, maxBytes: number): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.readdir(baseDir);
  } catch {
    return 0; // no spill dir yet — nothing to prune
  }

  const files: { path: string; size: number; mtimeMs: number }[] = [];
  for (const sub of entries) {
    const subPath = path.join(baseDir, sub);
    let st;
    try { st = await fs.stat(subPath); } catch { continue; }
    if (st.isFile()) {
      files.push({ path: subPath, size: st.size, mtimeMs: st.mtimeMs });
    } else if (st.isDirectory()) {
      let inner: string[] = [];
      try { inner = await fs.readdir(subPath); } catch { /* skip */ }
      for (const f of inner) {
        const fp = path.join(subPath, f);
        try {
          const fst = await fs.stat(fp);
          if (fst.isFile()) files.push({ path: fp, size: fst.size, mtimeMs: fst.mtimeMs });
        } catch { /* skip */ }
      }
    }
  }

  let total = files.reduce((a, f) => a + f.size, 0);
  if (total <= maxBytes) return 0;

  files.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
  let pruned = 0;
  for (const f of files) {
    if (total <= maxBytes) break;
    try {
      await fs.unlink(f.path);
      total -= f.size;
      pruned++;
    } catch { /* file busy/gone — move on */ }
  }
  return pruned;
}
