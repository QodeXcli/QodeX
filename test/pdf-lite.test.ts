import { describe, it, expect } from 'vitest';
import { buildPdf, pdfEscape, pdfSanitize } from '../src/cli/pdf-lite.ts';
import { buildMaintainDemoPdfBlocks } from '../src/cli/maintain-demo.ts';

describe('pdfSanitize / pdfEscape', () => {
  it('maps common unicode to Latin-1 and strips what base-14 fonts cannot render', () => {
    expect(pdfSanitize('✅ done — 5 → 6 · “ok”')).toBe('[OK] done - 5 -> 6 - "ok"');
    expect(pdfSanitize('emoji 🧾🎬 gone')).toBe('emoji gone');
  });
  it('escapes PDF string specials', () => {
    expect(pdfEscape('f(x) = \\n')).toBe('f\\(x\\) = \\\\n');
  });
});

describe('buildPdf', () => {
  const pdf = buildPdf([
    { text: 'Title here', size: 18, bold: true },
    { text: 'Body line with (parens) and a backslash \\ inside.', size: 11 },
    { text: 'mono receipt', size: 9, mono: true },
  ]);

  it('emits a structurally valid single-page document', () => {
    expect(pdf.startsWith('%PDF-1.4\n')).toBe(true);
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(pdf).toContain('/Type /Catalog');
    expect((pdf.match(/\/Type \/Page\b(?!s)/g) ?? []).length).toBe(1);
    expect(pdf).toContain('/Count 1');
    expect(pdf).toContain('/BaseFont /Helvetica-Bold');   // bold used
    expect(pdf).toContain('/BaseFont /Courier');          // mono used
  });

  it('streams are uncompressed and carry the (escaped) text', () => {
    expect(pdf).toContain('(Title here) Tj');
    expect(pdf).toContain('\\(parens\\)');
    expect(pdf).toContain('\\\\ inside');
  });

  it('every xref offset points exactly at its "N 0 obj" header', () => {
    const xref = /xref\n0 (\d+)\n([\s\S]*?)trailer/.exec(pdf)!;
    const entries = xref[2]!.trim().split('\n');
    expect(entries).toHaveLength(Number(xref[1]));        // free entry + N objects
    entries.slice(1).forEach((line, i) => {
      const off = parseInt(line.slice(0, 10), 10);
      expect(pdf.slice(off, off + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
    });
    const startxref = parseInt(/startxref\n(\d+)/.exec(pdf)![1]!, 10);
    expect(pdf.slice(startxref, startxref + 4)).toBe('xref');
  });

  it('paginates long content onto multiple pages', () => {
    const long = buildPdf(Array.from({ length: 120 }, (_, i) => ({ text: `line ${i}` })));
    const pageCount = (long.match(/\/Type \/Page\b(?!s)/g) ?? []).length;
    expect(pageCount).toBeGreaterThan(1);
    expect(long).toContain(`/Count ${pageCount}`);
  });

  it('stays pure Latin-1 (writable with Buffer latin1) even with emoji input', () => {
    const p = buildPdf([{ text: '✅ nightly · verify → PR 🧾' }]);
    for (const ch of p) expect(ch.codePointAt(0)!).toBeLessThanOrEqual(0xff);
  });
});

describe('buildMaintainDemoPdfBlocks', () => {
  it('tells the full story from the same source of truth as the HTML/MD demo', () => {
    const pdf = buildPdf(buildMaintainDemoPdfBlocks());
    for (const s of ['QodeX - a codebase that improves itself', 'The nightly loop', 'Code-graph analysis',
      'consolidate-dupes', 'trust receipt', 'safe-block', 'verify-or-block gate']) {
      expect(pdf).toContain(pdfEscape(pdfSanitize(s)).slice(0, 40));
    }
  });
});
