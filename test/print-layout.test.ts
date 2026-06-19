import { describe, it, expect } from 'vitest';
import { ean13CheckDigit, normalizeEan13, ean13Modules } from '../src/tools/frontend/print/ean13.js';
import { buildPrintLayoutSvg } from '../src/tools/frontend/print/layout.js';

describe('EAN-13 encoder', () => {
  it('computes known check digits', () => {
    expect(ean13CheckDigit('590123412345')).toBe(7);
    expect(ean13CheckDigit('400638133393')).toBe(1);
    expect(ean13CheckDigit('978020137962')).toBe(4);
  });
  it('normalizes 12 digits (computes) and validates 13', () => {
    expect(normalizeEan13('590123412345').digits).toBe('5901234123457');
    expect(normalizeEan13('5901234123457').checkOk).toBe(true);
    expect(normalizeEan13('5901234123450').checkOk).toBe(false);
  });
  it('rejects wrong-length input', () => {
    expect(() => normalizeEan13('123')).toThrow();
  });
  it('produces a 95-module pattern with correct guards', () => {
    const m = ean13Modules('5901234123457');
    expect(m.modules.length).toBe(95);
    expect(m.modules.slice(0, 3)).toBe('101');     // start
    expect(m.modules.slice(45, 50)).toBe('01010'); // center
    expect(m.modules.slice(92, 95)).toBe('101');   // end
  });
});

describe('print layout SVG', () => {
  const svg = buildPrintLayoutSvg({
    widthMm: 60, heightMm: 25, bleedMm: 3, safeMm: 3,
    title: 'SEVEN — Spearmint',
    legalLines: ['Ingredients: Xylitol.', 'Net Wt 14g'],
    barcode: '628176110014',
  });
  it('declares true physical size in mm (trim + 2×bleed)', () => {
    expect(svg).toContain('width="66mm"');
    expect(svg).toContain('height="31mm"');
    expect(svg).toContain('viewBox="0 0 66 31"');
  });
  it('emits each layer as a separate group', () => {
    for (const id of ['background', 'title', 'legal-text', 'barcode', 'safe-zone', 'die-line']) {
      expect(svg).toContain(`id="${id}"`);
    }
  });
  it('die-line is magenta (the cut)', () => {
    expect(svg).toMatch(/id="die-line"[\s\S]*?#ff00ff/);
  });
  it('computes and embeds the EAN-13 check digit', () => {
    expect(svg).toContain('data-ean="6281761100145"');
    expect(svg).not.toContain('check digit mismatch');
  });
  it('embeds a background image when provided', () => {
    const s2 = buildPrintLayoutSvg({ widthMm: 60, heightMm: 25, backgroundImageHref: 'bg.png' });
    expect(s2).toMatch(/<image href="bg.png"/);
  });
  it('balances group tags (well-formed)', () => {
    expect((svg.match(/<g /g) || []).length).toBe((svg.match(/<\/g>/g) || []).length);
  });
});
