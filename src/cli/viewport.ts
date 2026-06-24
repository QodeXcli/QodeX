/**
 * Viewport helpers for the live (non-Static) streaming region.
 *
 * Pure + dependency-free so it can be unit-tested without a TTY.
 */

/**
 * While an answer is still streaming we render only its viewport-bounded TAIL in
 * the live (non-Static) region. If the live region grew past the terminal height,
 * its scrolled-off top would stick in the terminal scrollback and reappear as a
 * truncated "second copy" once the full answer commits to <Static>. Capping the
 * live region to the visible rows means it never scrolls into scrollback at all;
 * the complete answer is printed exactly once, when it commits to history.
 *
 * Height is measured in WRAPPED (visual) rows, not newline-separated lines: a long
 * paragraph with no '\n' (e.g. wrapped Persian/RTL text) still occupies several
 * terminal rows once the terminal soft-wraps it. An earlier '\n'-only count
 * under-measured such answers, so they slipped past the cap, scrolled, and stuck
 * as a truncated duplicate. We walk from the END accumulating each logical line's
 * wrapped height (ceil(len / cols)) until the row budget is spent.
 */
export function tailForViewport(text: string, rows: number, cols: number): string {
  const budget = Math.max(6, (rows || 24) - 10); // room for header, input box, status, margin
  const width = Math.max(20, cols || 80);
  const logical = text.split('\n');
  let used = 0;
  const kept: string[] = [];
  for (let i = logical.length - 1; i >= 0; i--) {
    const line = logical[i];
    const vis = Math.max(1, Math.ceil(line.length / width)); // wrapped rows for this line
    if (used + vis > budget) {
      // This line doesn't fully fit. A SINGLE line can wrap to more rows than the
      // whole budget (a long unbroken line, or wrapped RTL/Persian paragraph). If we
      // kept it whole it would push the live region past the terminal height, scroll
      // into scrollback, and — repainted each token — oscillate. So keep only the
      // TRAILING rows of this top line that still fit; its scrolled-off head is
      // exactly what the terminal would have hidden anyway. (Also covers the case
      // where nothing has been kept yet — the bottom line alone is taller than budget.)
      const rowsLeft = budget - used;
      if (rowsLeft > 0) kept.unshift(line.slice(line.length - rowsLeft * width));
      break;
    }
    used += vis;
    kept.unshift(line);
    if (used >= budget) break;
  }
  return kept.join('\n');
}

/**
 * Did the terminal get SMALLER in either dimension?
 *
 * Growing the terminal is harmless — there's room for the existing frame. But
 * SHRINKING reflows every already-printed line to the narrower width, which throws
 * off Ink's cursor/erase math for the <Static> region and reprints committed
 * history as a duplicate. We detect a shrink so the UI can clear + repaint cleanly.
 */
export function didShrink(
  prev: { cols: number; rows: number },
  next: { cols: number; rows: number },
): boolean {
  return next.cols < prev.cols || next.rows < prev.rows;
}

/** ANSI: clear the entire screen AND the scrollback, home the cursor. Used on a
 *  shrink so the reflowed/duplicated frame is wiped before Ink repaints. */
export const CLEAR_SCREEN = '\x1b[2J\x1b[3J\x1b[H';

/**
 * Format a context-window occupancy indicator like "12.4k/200k ▕████░░░░░░▏ 6%".
 * Shows how full the model's context window currently is — the situational-awareness
 * readout (am I about to trigger compaction / hit the window?). Pure.
 * Returns '' when the window size is unknown (nothing useful to show).
 */
export function formatContextMeter(used: number, window: number, barWidth = 10): string {
  if (!window || window <= 0 || used <= 0) return '';
  const pct = Math.min(100, Math.round((used / window) * 100));
  const filled = Math.min(barWidth, Math.round((pct / 100) * barWidth));
  const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
  return `${k(used)}/${k(window)} ${bar} ${pct}%`;
}
