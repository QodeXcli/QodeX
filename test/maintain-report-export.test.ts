import { describe, it, expect } from 'vitest';
import { buildMaintainReportMarkdown, buildMaintainReportPdfBlocks, type MaintainReportData } from '../src/cli/maintain-report-export.ts';
import { buildPdf } from '../src/cli/pdf-lite.ts';

const DATA: MaintainReportData = {
  generatedAt: '2026-07-02',
  project: 'qodex',
  stats: {
    totalRuns: 8, opened: 5, blocked: 2, failed: 1, successRate: 0.625, filesCleaned: 14, estMinutesSaved: 25,
    byScope: [{ scope: 'unused-imports', runs: 4, opened: 3 }, { scope: 'unused-locals', runs: 4, opened: 2 }],
    lastRun: { when: '2h ago', status: 'opened', scope: 'unused-imports' },
  },
  weekly: { opened: 2, blocked: 1, filesCleaned: 5, minutesSaved: 10, priorOpened: 1, openedDelta: 1 },
  trend: [0, 1, 0, 2, 1, 0, 1, 2],
  forecast: { weeklyAvg: 0.88, slope: 0.12, direction: 'steady', nextWeek: 1, weeks: 8 },
  projection: { cleanupsPerMonth: 5, minutesPerMonth: 25 },
  next: { scope: 'extract-helper', why: 'never run here yet — try it' },
};

describe('buildMaintainReportMarkdown', () => {
  const md = buildMaintainReportMarkdown(DATA);
  it('is a paste-ready PR block with the receipt-backed framing and all key numbers', () => {
    expect(md.startsWith('## 🔧 Self-Improvement Report — qodex')).toBe(true);
    expect(md).toContain('verified-run receipts, not model claims');
    expect(md).toContain('| **Cleanup PRs shipped** | 5 |');
    expect(md).toContain('| **Safely blocked** (guardrail declined) | 2 |');
    expect(md).toContain('63% of 8 runs');
    expect(md).toMatch(/`[▁▂▃▄▅▆▇█]{8}`/);                // unicode sparkline is fine in Markdown
    expect(md).toContain('`unused-imports` 3/4');
    expect(md).toContain('**Suggested next:** `extract-helper`');
  });
  it('omits the suggestion line when next is null', () => {
    expect(buildMaintainReportMarkdown({ ...DATA, next: null })).not.toContain('Suggested next');
  });
});

describe('buildMaintainReportPdfBlocks → buildPdf', () => {
  const pdf = buildPdf(buildMaintainReportPdfBlocks(DATA));
  it('renders a structurally valid PDF with the real numbers', () => {
    expect(pdf.startsWith('%PDF-1.4\n')).toBe(true);
    expect(pdf).toContain('(Self-Improvement Report - qodex) Tj');
    expect(pdf).toContain('Cleanup PRs shipped: 5');      // pdfSanitize collapses double spaces
    expect(pdf).toContain('63% of 8 runs');
    expect(pdf).toContain('extract-helper');
  });
  it('draws the 8-week trend as REAL vector bars (re f rects), normalized, gray-scoped with q/Q', () => {
    expect(pdf).toMatch(/q 0\.45 g( \d+ \d+ 14 \d+ re f){8} Q/);   // 8 bars, width 14
    const heights = [...pdf.matchAll(/(\d+) (\d+) 14 (\d+) re f/g)].map(m => Number(m[3]));
    expect(Math.max(...heights)).toBe(36);                          // max value → full BAR_H
    expect(Math.min(...heights)).toBe(1);                           // zero weeks → 1pt floor (visible baseline)
    expect(pdf).not.toContain('▁');                                 // no sparkline glyphs leak into the PDF
  });
  it('all-zero trend does not divide by zero (flat 1pt bars)', () => {
    const flat = buildPdf(buildMaintainReportPdfBlocks({ ...DATA, trend: [0, 0, 0, 0] }));
    const heights = [...flat.matchAll(/\d+ \d+ 14 (\d+) re f/g)].map(m => Number(m[1]));
    expect(heights).toEqual([1, 1, 1, 1]);
  });
});
