/**
 * Constraints for sending content to the Ink UI.
 * Sending mega-strings to React/Ink causes terminal freeze, memory leaks,
 * and excessive diff computation. These caps protect the UI.
 */
export const UI_MAX_DIFF_BYTES = 64 * 1024;      // 64KB total per side
export const UI_MAX_DIFF_LINES = 2000;            // safety cap on line count

export interface DiffPreviewPayload {
  path: string;
  before: string | null;
  after: string;
  /** Set when content was truncated for display only — the actual write uses full content. */
  truncated?: { beforeBytes: number; afterBytes: number };
}

export function prepareDiffPreview(
  path: string,
  before: string | null,
  after: string,
): DiffPreviewPayload {
  const beforeBytes = before?.length ?? 0;
  const afterBytes = after.length;
  const overBudget = beforeBytes > UI_MAX_DIFF_BYTES || afterBytes > UI_MAX_DIFF_BYTES;

  if (!overBudget) {
    return { path, before, after };
  }

  // Truncate each side to UI_MAX_DIFF_BYTES, with a marker
  const truncate = (s: string | null): string | null => {
    if (s === null) return null;
    if (s.length <= UI_MAX_DIFF_BYTES) return s;
    const half = Math.floor(UI_MAX_DIFF_BYTES / 2);
    return s.slice(0, half) +
      `\n\n... [${(s.length - UI_MAX_DIFF_BYTES).toLocaleString()} bytes elided for display — full content will be written] ...\n\n` +
      s.slice(-half);
  };

  return {
    path,
    before: truncate(before),
    after: truncate(after)!,
    truncated: { beforeBytes, afterBytes },
  };
}
