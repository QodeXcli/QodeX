/**
 * Pure print-layout geometry → an SVG string. No I/O. Deterministic and testable.
 *
 * Everything is in millimetres (SVG width/height carry the `mm` unit and the
 * viewBox is 1 unit = 1 mm), so the file drops into CorelDRAW / Illustrator at
 * true physical size. Layers are separate <g id="..."> groups so a print operator
 * can toggle die-line / safe-zone / barcode independently.
 */

import { ean13Modules } from './ean13.js';

export interface PrintLayoutSpec {
  widthMm: number;            // trim width (final cut size)
  heightMm: number;           // trim height
  bleedMm?: number;           // default 3
  safeMm?: number;            // default 3
  title?: string;             // main label text
  legalLines?: string[];      // ingredients / weight / warnings (small print)
  barcode?: string;           // 12 or 13 digit EAN-13
  backgroundImageHref?: string; // Phase 2: ComfyUI texture embedded as <image>
  bgColor?: string;           // fallback background fill when no image (default light gray)
}

const RTL_RE = /[\u0600-\u06FF\u0750-\u077F]/; // Arabic/Persian block
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const f = (n: number) => Math.round(n * 1000) / 1000; // 3-decimal mm

/** Render an EAN-13 barcode as an SVG group, fitted to a max width AND a band height. */
function barcodeGroup(code: string, cx: number, bottom: number, maxWidthMm: number, bandHeightMm: number): string {
  const { digits, modules, checkOk } = ean13Modules(code);
  const QUIET = 11;                       // quiet-zone modules each side (spec: ≥11 left, ≥7 right)
  const totalModules = modules.length + QUIET * 2; // 95 + margins
  let mw = 0.33;                          // nominal module width (mm)
  if (totalModules * mw > maxWidthMm) mw = maxWidthMm / totalModules; // shrink to fit width
  const digitH = Math.max(2, Math.min(mw * 7, bandHeightMm * 0.25)); // human-readable row
  const barH = Math.max(4, bandHeightMm - digitH);                   // bars fill the rest of the band
  const totalW = totalModules * mw;
  const x0 = cx - totalW / 2 + QUIET * mw; // first module after the left quiet zone
  const top = bottom - barH - digitH;

  const bars: string[] = [];
  for (let i = 0; i < modules.length; i++) {
    if (modules[i] === '1') {
      bars.push(`<rect x="${f(x0 + i * mw)}" y="${f(top)}" width="${f(mw)}" height="${f(barH)}" fill="#000"/>`);
    }
  }
  const fontPx = f(digitH * 0.9);
  const digitsRow = [
    `<text x="${f(cx - totalW / 2 + QUIET * mw / 2)}" y="${f(bottom)}" font-size="${fontPx}" font-family="monospace" text-anchor="middle" fill="#000">${digits[0]}</text>`,
    `<text x="${f(x0 + 24 * mw)}" y="${f(bottom)}" font-size="${fontPx}" font-family="monospace" text-anchor="middle" fill="#000">${digits.slice(1, 7)}</text>`,
    `<text x="${f(x0 + 71 * mw)}" y="${f(bottom)}" font-size="${fontPx}" font-family="monospace" text-anchor="middle" fill="#000">${digits.slice(7, 13)}</text>`,
  ].join('');

  const warn = checkOk ? '' : `<!-- WARNING: EAN-13 check digit mismatch in ${digits} -->`;
  return `<g id="barcode" data-ean="${digits}">${warn}${bars.join('')}${digitsRow}</g>`;
}

export function buildPrintLayoutSvg(spec: PrintLayoutSpec): string {
  const bleed = spec.bleedMm ?? 3;
  const safe = spec.safeMm ?? 3;
  const w = spec.widthMm;
  const h = spec.heightMm;
  const totalW = w + 2 * bleed;
  const totalH = h + 2 * bleed;
  const bg = spec.bgColor ?? '#f0f0f0';

  const layers: string[] = [];

  // Content area = inside the safe zone.
  const cTop = bleed + safe;
  const cBottom = bleed + h - safe;
  const cLeft = bleed + safe;
  const cW = w - 2 * safe;
  const cH = h - 2 * safe;

  // 1) Background fills the FULL bleed area (so no white slivers after cutting).
  if (spec.backgroundImageHref) {
    layers.push(
      `<g id="background"><image href="${esc(spec.backgroundImageHref)}" x="0" y="0" width="${f(totalW)}" height="${f(totalH)}" preserveAspectRatio="xMidYMid slice"/></g>`,
    );
  } else {
    layers.push(`<g id="background"><rect x="0" y="0" width="${f(totalW)}" height="${f(totalH)}" fill="${bg}"/></g>`);
  }

  // ---- Vertical bands, allocated bottom-up so nothing overlaps ----
  // Bottom band: barcode (capped so it never eats a small label).
  let barcodeTop = cBottom;
  if (spec.barcode) {
    const band = Math.min(cH * 0.42, 16); // ≤42% of height, ≤16mm
    layers.push(barcodeGroup(spec.barcode, totalW / 2, cBottom, cW, band));
    barcodeTop = cBottom - band;
  }

  // Legal/small print: stacked just above the barcode band.
  if (spec.legalLines && spec.legalLines.length) {
    const fontPx = Math.max(1.6, Math.min(cW, cH) * 0.04);
    const lh = fontPx * 1.3;
    const blockH = lh * spec.legalLines.length;
    const startY = barcodeTop - 1 - blockH + fontPx; // baseline of first line
    const lines = spec.legalLines.map((ln, i) => {
      const rtl = RTL_RE.test(ln);
      return `<text x="${f(cLeft)}" y="${f(startY + i * lh)}" font-size="${f(fontPx)}" font-family="sans-serif"${rtl ? ' direction="rtl"' : ''} fill="#222">${esc(ln)}</text>`;
    });
    layers.push(`<g id="legal-text">${lines.join('')}</g>`);
  }

  // Title: top band, centered.
  if (spec.title) {
    const rtl = RTL_RE.test(spec.title);
    const fontPx = Math.max(3, Math.min(cW * 0.5, cH * 0.18));
    layers.push(
      `<g id="title"><text x="${f(totalW / 2)}" y="${f(cTop + fontPx)}" font-size="${f(fontPx)}" font-family="sans-serif" font-weight="bold" text-anchor="middle"${rtl ? ' direction="rtl"' : ''} fill="#111">${esc(spec.title)}</text></g>`,
    );
  }

  // Guides on top. Die-line (magenta) = the cut; safe-zone (blue dashed) = keep text inside.
  layers.push(
    `<g id="safe-zone"><rect x="${f(cLeft)}" y="${f(cTop)}" width="${f(cW)}" height="${f(cH)}" fill="none" stroke="#00aaff" stroke-width="0.2" stroke-dasharray="1 1"/></g>`,
  );
  layers.push(
    `<g id="die-line"><rect x="${f(bleed)}" y="${f(bleed)}" width="${f(w)}" height="${f(h)}" fill="none" stroke="#ff00ff" stroke-width="0.25"/></g>`,
  );

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${f(totalW)}mm" height="${f(totalH)}mm" viewBox="0 0 ${f(totalW)} ${f(totalH)}">`,
    `<!-- Print layout: trim ${w}×${h}mm, bleed ${bleed}mm, safe ${safe}mm. Layers: background, title, legal-text, barcode, safe-zone(guide), die-line(cut=magenta). -->`,
    ...layers,
    `</svg>`,
  ].join('\n');
}
