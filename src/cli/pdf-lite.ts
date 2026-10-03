/**
 * pdf-lite — a tiny, dependency-free PDF writer for QodeX's shareable one-pagers (the maintain
 * demo PDF). Deliberately minimal: base-14 fonts (Helvetica / Helvetica-Bold / Courier), plain
 * uncompressed text streams, A4 pages, automatic pagination. No images, no compression, no
 * embedding — which keeps it PURE (string in → PDF bytes out), deterministic, and unit-testable
 * (streams are uncompressed, so tests can grep the text and re-verify every xref offset).
 *
 * Why hand-rolled instead of a library: the whole feature needs ~4 text styles on A4. Pulling in
 * pdfkit (+ font kits) for that would be the single heaviest dependency in the CLI.
 */

export interface PdfBlock {
  text: string;
  /** Point size. Default 11. */
  size?: number;
  bold?: boolean;
  /** Courier (receipts / code). */
  mono?: boolean;
  /** Extra left indent in points. */
  indent?: number;
  /** Extra space above the block, in points. */
  spaceBefore?: number;
  /** Render a mini bar chart (values normalized to the max) instead of text — real vector
   *  rectangles, since sparkline glyphs (▁▂▃…) aren't in the Latin-1 base fonts. `text` is
   *  used as the row label to the left of the bars. */
  bars?: number[];
}

const PAGE_W = 595;   // A4 portrait, points
const PAGE_H = 842;
const MARGIN = 56;

/** Map common Unicode to Latin-1/ASCII so base-14 fonts can render it; strip the rest. PURE. */
export function pdfSanitize(s: string): string {
  const map: Record<string, string> = {
    '✅': '[OK]', '✓': 'v', '⛔': '[BLOCKED]', '❌': '[FAIL]', '🧾': '', '🔍': '', '🎬': '', '★': '*',
    '—': '-', '–': '-', '…': '...', '·': '-', '→': '->', '←': '<-', '↑': '^', '↓': 'v',
    '’': "'", '‘': "'", '“': '"', '”': '"', '≈': '~', '≥': '>=', '≤': '<=', '×': 'x', '€': 'EUR',
  };
  let out = '';
  for (const ch of s) {
    if (map[ch] !== undefined) { out += map[ch]; continue; }
    out += ch.codePointAt(0)! <= 0xff ? ch : '';
  }
  return out.replace(/  +/g, ' ');
}

/** Escape PDF string-literal specials. PURE. */
export function pdfEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** Greedy word-wrap by an approximate per-char width (Helvetica avg ~0.5em; Courier 0.6em). PURE. */
function wrap(text: string, size: number, mono: boolean, widthPts: number): string[] {
  const charW = size * (mono ? 0.6 : 0.5);
  const maxChars = Math.max(8, Math.floor(widthPts / charW));
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    if (raw.length <= maxChars) { out.push(raw); continue; }
    let line = '';
    for (const word of raw.split(' ')) {
      if (line && line.length + 1 + word.length > maxChars) { out.push(line); line = word; }
      else line = line ? `${line} ${word}` : word;
    }
    if (line) out.push(line);
  }
  return out.length ? out : [''];
}

/**
 * Build a complete PDF document from text blocks. Returns the PDF as a LATIN-1 string — write it
 * with `Buffer.from(pdf, 'latin1')`. PURE + deterministic (no clock, no randomness).
 */
export function buildPdf(blocks: PdfBlock[]): string {
  // 1. Lay blocks out into pages of positioned elements (text lines + bar-chart rows).
  interface Line { kind: 'text'; x: number; y: number; size: number; font: 'F1' | 'F2' | 'F3'; text: string }
  interface BarsRow { kind: 'bars'; x: number; y: number; values: number[]; label: string; size: number }
  type El = Line | BarsRow;
  const BAR_H = 36; const BAR_W = 14; const BAR_GAP = 4;
  const pages: El[][] = [[]];
  let y = PAGE_H - MARGIN;
  for (const b of blocks) {
    const size = b.size ?? 11;
    const x = MARGIN + (b.indent ?? 0);
    y -= b.spaceBefore ?? 0;
    if (b.bars) {
      if (y < MARGIN + BAR_H + size) { pages.push([]); y = PAGE_H - MARGIN; }
      y -= BAR_H + Math.round(size * 0.6);
      pages[pages.length - 1]!.push({ kind: 'bars', x, y, values: b.bars, label: pdfSanitize(b.text), size });
      continue;
    }
    const gap = Math.round(size * 1.45);
    const font = b.mono ? 'F3' : b.bold ? 'F2' : 'F1';
    for (const lineText of wrap(pdfSanitize(b.text), size, !!b.mono, PAGE_W - x - MARGIN)) {
      if (y < MARGIN + size) { pages.push([]); y = PAGE_H - MARGIN; }
      y -= gap;
      pages[pages.length - 1]!.push({ kind: 'text', x, y, size, font, text: lineText });
    }
  }

  // 2. Emit objects, tracking byte offsets for the xref table.
  //    Layout: 1 Catalog · 2 Pages · 3 F1 · 4 F2 · 5 F3 · then per page: Page, Contents.
  const objects: string[] = [];
  const firstPageObj = 6;
  const kids = pages.map((_, i) => `${firstPageObj + i * 2} 0 R`).join(' ');
  objects.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  objects.push(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`);
  objects.push(`3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`);
  objects.push(`4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n`);
  objects.push(`5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>\nendobj\n`);
  pages.forEach((lines, i) => {
    // Page-number footer on multi-page documents (a one-pager stays clean).
    if (pages.length > 1) {
      lines.push({ kind: 'text', x: PAGE_W / 2 - 24, y: MARGIN - 24, size: 8, font: 'F1', text: `Page ${i + 1} of ${pages.length}` });
    }
    const pageNum = firstPageObj + i * 2;
    const contentNum = pageNum + 1;
    objects.push(
      `${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${contentNum} 0 R >>\nendobj\n`,
    );
    const stream = lines
      .map(l => {
        if (l.kind === 'text') return `BT /${l.font} ${l.size} Tf 1 0 0 1 ${l.x} ${l.y} Tm (${pdfEscape(l.text)}) Tj ET`;
        // Bar row: label text, then normalized filled rects (q/Q so the gray fill never leaks into text).
        const max = Math.max(1, ...l.values);
        const label = l.label ? `BT /F1 ${l.size} Tf 1 0 0 1 ${l.x} ${l.y + 2} Tm (${pdfEscape(l.label)}) Tj ET\n` : '';
        const bx0 = l.x + (l.label ? Math.min(150, l.label.length * l.size * 0.55 + 12) : 0);
        const rects = l.values.map((v, i) => {
          const h = Math.max(1, Math.round((v / max) * BAR_H));
          return `${bx0 + i * (BAR_W + BAR_GAP)} ${l.y} ${BAR_W} ${h} re f`;
        }).join(' ');
        return `${label}q 0.45 g ${rects} Q`;
      })
      .join('\n');
    objects.push(`${contentNum} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`);
  });

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const obj of objects) { offsets.push(pdf.length); pdf += obj; }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return pdf;
}
