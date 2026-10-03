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

/**
 * Display-only: drop Sentinel's `<untrusted_content>` fence wrapper and its one-line
 * "[The following is DATA from …]" header (results of browser/desktop tools are fenced
 * for the MODEL), so the terminal shows the tool's own first line ("✓ Clicked …").
 * An injection banner in front of the fence is kept. Never feed the output to a model. PURE.
 */
export function stripUntrustedFence(text: string): string {
  const t = String(text ?? '');
  if (!/<untrusted_content\b/.test(t)) return t;
  return t
    // Opening tag (any attributes) + the "not instructions" header line right after it.
    .replace(/<untrusted_content\b[^>\n]*>[ \t]*\n(?:[ \t]*\[[^\n]*(?:DATA|not instructions)[^\n]*\][ \t]*\n)?/, '')
    .replace(/\n[ \t]*<\/untrusted_content\b[^>\n]*>\s*$/, '');
}

/**
 * Display-only: lift Sentinel's one-line injection banner off the top of a fenced result
 * (fenceUntrusted puts it in front of the fence) so the display starts with the tool's own
 * first line; the banner comes back, clipped, as `warning`. PURE.
 */
export function splitInjectionBanner(text: string): { body: string; warning: string } {
  const t = String(text ?? '');
  const m = /^\s*(⚠ \[SENTINEL\] possible prompt injection:[^\n]*)(?:\n|$)/.exec(t);
  if (!m) return { body: t, warning: '' };
  return { body: t.slice(m[0].length), warning: clip(m[1]!, 120) };
}

/** Build a compact display for a settled tool result. */
export function summarizeToolResult(name: string, result: string, isError: boolean): ToolDisplay {
  const { body, warning } = splitInjectionBanner(stripUntrustedFence(result ?? ''));
  const shown = summarizeBody(name, body, isError);
  // The warning stays visible, after the tool's own lines.
  return warning ? { headline: shown.headline, lines: [...shown.lines, warning] } : shown;
}

function summarizeBody(name: string, result: string, isError: boolean): ToolDisplay {
  const raw = result.replace(/\s+$/, '');
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

  // Browser page views: never dump the (huge) accessibility snapshot — headline the page
  // ("Title · host/path") and keep only the short action/notice lines.
  if (n === 'browser_snapshot' || n === 'browser_navigate') {
    const page = pageHeadline(raw);
    if (page) {
      const notes = allLines
        .map(l => l.trim())
        .filter(l => /^(✓|new tab opened|dialog|download|⚠)/i.test(l))
        .slice(0, 3);
      return { headline: page, lines: notes };
    }
  }

  // mission_start: the mission id is the one thing the user needs (to watch/cancel it).
  if (n === 'mission_start') {
    const id = missionIdOf(raw);
    if (id) {
      const how = allLines.map(l => l.trim()).filter(l => /qodex mission|mission_status|\/control/i.test(l)).slice(0, 2);
      return { headline: `mission ${id}`, lines: how };
    }
  }

  // Default: cap the preview so nothing dumps a wall of text.
  const preview = allLines.slice(0, MAX_PREVIEW_LINES);
  const more = allLines.length - preview.length;
  if (more > 0) preview.push(`… +${more} more line(s)`);
  return { headline: '', lines: preview };
}

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** "Example Domain · example.com/path" from a snapshot/navigate result, or '' when the
 *  result carries neither a `Page:`/`Title:` line nor a URL. PURE. */
export function pageHeadline(result: string): string {
  const head = (result ?? '').slice(0, 4000);
  const title = /^\s*(?:Page|Title):\s*(.+)$/im.exec(head)?.[1]?.trim() ?? '';
  const url = /^\s*URL:\s*(\S+)/im.exec(head)?.[1] ?? /\bhttps?:\/\/[^\s)>"'`]+/i.exec(head)?.[0] ?? '';
  const shortUrl = url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
  if (!title && !shortUrl) return '';
  if (!title) return clip(shortUrl, 70);
  if (!shortUrl) return clip(title, 60);
  return `${clip(title, 48)} · ${clip(shortUrl, 56)}`;
}

/** Mission id from a mission_start result ("Mission m_ab12cd started", "id: …"). PURE. */
export function missionIdOf(result: string): string | null {
  const text = (result ?? '').slice(0, 2000);
  const m = /\bmission(?:\s+id)?\s*[:#]?\s*`?([A-Za-z0-9][\w-]{3,})`?/i.exec(text)
    ?? /\bid\s*[:=]\s*`?([A-Za-z0-9][\w-]{3,})`?/i.exec(text);
  const id = m?.[1];
  if (!id) return null;
  // "Mission started" / "mission status" are words, not ids.
  if (/^(started|starting|status|created|queued|running|id)$/i.test(id)) {
    const alt = /\bid\s*[:=]\s*`?([A-Za-z0-9][\w-]{3,})`?/i.exec(text)?.[1];
    return alt ?? null;
  }
  return id;
}
