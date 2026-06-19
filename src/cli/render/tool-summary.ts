/**
 * Compact tool-result display for the TUI.
 *
 * The model receives the FULL tool result through the agent loop — this module
 * only governs what the human sees scroll past in the terminal. The goal is
 * Claude-Code-style restraint: a one-line metric (how many lines were read, how
 * many matches were found, the shell exit code) plus at most a short preview,
 * instead of dumping an entire 540-line file into the transcript on every read.
 *
 * Pure and dependency-free so it can be unit-tested in the sandbox.
 */

export interface ToolDisplay {
  /** A short metric shown right after the tool name, e.g. "541 lines", "exit 0". */
  headline: string;
  /** Preview lines to show under the header (already capped). May be empty. */
  lines: string[];
}

const MAX_PREVIEW_LINES = 8;

function norm(name: string): string {
  return (name || '').toLowerCase().trim();
}

/** Build a compact display for a settled tool result. */
export function summarizeToolResult(name: string, result: string, isError: boolean): ToolDisplay {
  const raw = (result ?? '').replace(/\s+$/, '');
  const allLines = raw.length ? raw.split('\n') : [];
  const n = norm(name);

  // Errors: surface the message (short), no headline metric.
  if (isError) {
    const lines = allLines.slice(0, 5);
    const more = allLines.length - lines.length;
    if (more > 0) lines.push(`… +${more} more line(s)`);
    return { headline: '', lines };
  }

  // Reads: never echo the file body. The point of the complaint. Just the size.
  if (n === 'read_file' || n === 'pdf_read' || n === 'read') {
    const m = raw.match(/(\d[\d,]*)\s+lines/i); // read_file's own "— 541 lines" header
    const count = m ? m[1] : String(allLines.length);
    return { headline: `${count} lines`, lines: [] };
  }

  // Listings & searches: a count plus a few entries, then "+N more".
  if (
    n === 'ls' || n === 'list_files' || n === 'glob' || n === 'find' ||
    n === 'grep' || n === 'search' || n === 'search_code' || n === 'codebase_search'
  ) {
    const entries = allLines.filter(l => l.trim().length);
    const preview = entries.slice(0, MAX_PREVIEW_LINES);
    const more = entries.length - preview.length;
    if (more > 0) preview.push(`… +${more} more`);
    const noun = (n === 'grep' || n.includes('search')) ? 'match(es)' : 'item(s)';
    return { headline: `${entries.length} ${noun}`, lines: preview };
  }

  // Shell: exit code headline + the tail of the output (where errors live).
  if (n === 'shell' || n === 'bash' || n === 'run_shell' || n === 'run') {
    const exit = raw.match(/\[exit code:\s*(-?\d+)\]/i);
    const body = allLines.filter(l => !/^\s*\[exit code:/i.test(l));
    const tail = body.slice(-MAX_PREVIEW_LINES);
    const more = body.length - tail.length;
    const lines = more > 0 ? [`… +${more} earlier line(s)`, ...tail] : tail;
    return { headline: exit ? `exit ${exit[1]}` : '', lines };
  }

  // Default: cap the preview so nothing dumps a wall of text.
  const preview = allLines.slice(0, MAX_PREVIEW_LINES);
  const more = allLines.length - preview.length;
  if (more > 0) preview.push(`… +${more} more line(s)`);
  return { headline: '', lines: preview };
}
