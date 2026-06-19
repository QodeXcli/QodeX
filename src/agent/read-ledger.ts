/**
 * Read-before-write enforcement ("stateful tool gating").
 *
 * The system prompt has always SAID "Read before write" (rule 2), but local
 * models routinely ignore prose rules when they get excited about editing.
 * This module moves the rule from advice into the tool layer: a mutating
 * filesystem tool (edit_text, multi_edit, multi_file_edit, write_file on an
 * EXISTING file, edit_symbol) is physically refused unless the file was
 * successfully read earlier in this session — and refused again if the file
 * changed on disk after the last read (stale knowledge).
 *
 * The refusal is returned as a normal tool-result error (never a throw), so
 * the model receives it as an observation and self-corrects by calling
 * read_file — the same mechanism Claude Code's Edit tool uses.
 *
 * Deliberate design choices:
 *  - grep does NOT satisfy the gate. Grep shows isolated matching lines;
 *    editing from grep output is exactly the "mirror pattern" failure this
 *    gate exists to prevent.
 *  - Creating a NEW file is always allowed (there is nothing to read), and a
 *    successful write/edit marks the file as known (the model authored the
 *    content, so it knows it).
 *  - Staleness is tracked by mtime: if anything (shell, the user, another
 *    process) modified the file after the last read, the edit is refused
 *    with a re-read instruction instead of silently editing blind.
 *
 * Scope honesty: this gate fixes ONE failure mode (mutating unseen/stale
 * files). It does not make a model reason better about code it HAS read.
 */

/** Tools whose successful execution counts as "the model has seen this file". */
export const READ_TOOLS = new Set(['read_file']);

/** Mutating tools gated on prior read. Maps tool name → how to pull paths from parsed args. */
const MUTATION_PATH_EXTRACTORS: Record<string, (args: any) => string[]> = {
  edit_text: (a) => (a?.path ? [String(a.path)] : []),
  multi_edit: (a) => (a?.path ? [String(a.path)] : []),
  write_file: (a) => (a?.path ? [String(a.path)] : []),
  edit_symbol: (a) => (a?.path ? [String(a.path)] : []),
  multi_file_edit: (a) =>
    Array.isArray(a?.files) ? a.files.map((f: any) => String(f?.path ?? '')).filter(Boolean) : [],
};

export function isGatedMutationTool(toolName: string): boolean {
  return Object.prototype.hasOwnProperty.call(MUTATION_PATH_EXTRACTORS, toolName);
}

/** Pure: pull the file paths a mutating tool intends to touch. [] for non-gated tools. */
export function extractMutationPaths(toolName: string, args: unknown): string[] {
  const fn = MUTATION_PATH_EXTRACTORS[toolName];
  if (!fn) return [];
  try {
    return fn(args);
  } catch {
    return [];
  }
}

/** Pure: pull the path a read tool just consumed. null for non-read tools. */
export function extractReadPath(toolName: string, args: unknown): string | null {
  if (!READ_TOOLS.has(toolName)) return null;
  const p = (args as any)?.path;
  return p ? String(p) : null;
}

export type GateVerdict =
  | { ok: true }
  | { ok: false; kind: 'unread' | 'stale'; path: string };

/**
 * Session-scoped ledger of files the model has demonstrably seen.
 * Key: absolute path. Value: file mtimeMs at the moment of the read/write.
 */
export class ReadLedger {
  private seen = new Map<string, number>();

  /** Record a successful read (or a successful write/edit — the model authored it). */
  mark(absPath: string, mtimeMs: number): void {
    this.seen.set(absPath, mtimeMs);
  }

  has(absPath: string): boolean {
    return this.seen.has(absPath);
  }

  mtimeAt(absPath: string): number | undefined {
    return this.seen.get(absPath);
  }

  /**
   * Pure gate decision for ONE existing file about to be mutated.
   * `currentMtimeMs` is the file's mtime on disk right now (caller stats it).
   * Non-existent files never reach this check (creation is always allowed).
   */
  check(absPath: string, currentMtimeMs: number): GateVerdict {
    const recorded = this.seen.get(absPath);
    if (recorded === undefined) return { ok: false, kind: 'unread', path: absPath };
    // Allow a small clock-precision slack (some filesystems round mtime).
    if (currentMtimeMs > recorded + 1) return { ok: false, kind: 'stale', path: absPath };
    return { ok: true };
  }

  size(): number {
    return this.seen.size;
  }
}

/** The observation the model receives when the gate refuses a mutation. */
export function buildGateMessage(relPath: string, kind: 'unread' | 'stale'): string {
  if (kind === 'unread') {
    return (
      `[ACCESS_DENIED] You attempted to modify "${relPath}" without reading it first. ` +
      `Call read_file on this exact path, understand its current contents, then retry the edit. ` +
      `(grep results are NOT sufficient — they show isolated lines, not the file.)`
    );
  }
  return (
    `[ACCESS_DENIED] "${relPath}" changed on disk AFTER you last read it ` +
    `(another tool, command, or the user modified it). Your knowledge of this file is stale. ` +
    `Call read_file on it again, then retry the edit against the current contents.`
  );
}
