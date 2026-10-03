/**
 * Self-Improvement Report exporters — the REAL maintain numbers (not the demo story) as:
 *   - Markdown: paste-ready for a PR description / team update / docs.
 *   - PDF blocks: a shareable one-pager via pdf-lite, with the 8-week trend as a real bar chart
 *     (vector rects — sparkline glyphs aren't in the Latin-1 base fonts).
 *
 * PURE (data in, artifact out; caller supplies generatedAt) — both renderers share one data
 * struct so the report can never disagree with itself across formats.
 */
import type { MaintainStats, MaintainWeekly, MaintainForecast } from './maintain-stats.js';
import type { PdfBlock } from './pdf-lite.js';

export interface MaintainReportData {
  generatedAt: string;          // e.g. '2026-07-02'
  project?: string;
  stats: MaintainStats;
  weekly: MaintainWeekly;
  trend: number[];              // opened/week, oldest→newest
  forecast: MaintainForecast;
  projection: { cleanupsPerMonth: number; minutesPerMonth: number };
  next?: { scope: string; why: string } | null;
}

const dirWord = (d: MaintainForecast['direction']): string =>
  d === 'rising' ? 'rising ↑' : d === 'falling' ? 'cooling ↓' : 'steady →';

function sparkline(trend: number[]): string {
  const max = Math.max(1, ...trend);
  const b = '▁▂▃▄▅▆▇█';
  return trend.map(n => b[Math.min(7, Math.round((n / max) * 7))]).join('');
}

/** Markdown report — paste into a PR / issue / team chat. PURE. */
export function buildMaintainReportMarkdown(d: MaintainReportData): string {
  const s = d.stats;
  const lines = [
    `## 🔧 Self-Improvement Report${d.project ? ` — ${d.project}` : ''}`,
    '',
    `*Generated ${d.generatedAt} by [QodeX](https://github.com/QodeXcli/QodeX) \`maintain\` — every number below comes from verified-run receipts, not model claims.*`,
    '',
    '| | |',
    '|---|---|',
    `| **Cleanup PRs shipped** | ${s.opened} |`,
    `| **Safely blocked** (guardrail declined) | ${s.blocked} |`,
    `| **Files cleaned** | ${s.filesCleaned} |`,
    `| **Est. minutes saved** | ~${s.estMinutesSaved} |`,
    `| **Success rate** | ${Math.round(s.successRate * 100)}% of ${s.totalRuns} runs |`,
    '',
    `**This week:** ${d.weekly.opened} PR(s) · ${d.weekly.filesCleaned} files · ${d.weekly.openedDelta >= 0 ? '▲' : '▼'}${Math.abs(d.weekly.openedDelta)} vs last week`,
    `**8-week trend:** \`${sparkline(d.trend)}\` (opened/week)`,
    `**Forecast:** ${dirWord(d.forecast.direction)} · avg ~${d.forecast.weeklyAvg}/wk · next week ≈ ${d.forecast.nextWeek}`,
    `**Projected:** ~${d.projection.cleanupsPerMonth} cleanups/mo · ~${d.projection.minutesPerMonth} min/mo`,
    '',
    `**By scope:** ${s.byScope.map(x => `\`${x.scope}\` ${x.opened}/${x.runs}`).join(' · ') || '—'}`,
  ];
  if (d.next) lines.push('', `**Suggested next:** \`${d.next.scope}\` — ${d.next.why}`);
  return lines.join('\n');
}

/** PDF report blocks (feed to pdf-lite buildPdf). PURE. */
export function buildMaintainReportPdfBlocks(d: MaintainReportData): PdfBlock[] {
  const s = d.stats;
  const kv = (k: string, v: string): PdfBlock => ({ text: `${k}:  ${v}`, size: 11, indent: 10 });
  const blocks: PdfBlock[] = [
    { text: `Self-Improvement Report${d.project ? ` — ${d.project}` : ''}`, size: 18, bold: true },
    { text: `Generated ${d.generatedAt} by QodeX maintain. Every number comes from verified-run receipts — filesChanged from real git diffs, verification from checkers that actually ran.`, size: 9, spaceBefore: 4 },
    { text: 'All time', size: 13, bold: true, spaceBefore: 12 },
    kv('Cleanup PRs shipped', String(s.opened)),
    kv('Safely blocked (guardrail declined)', String(s.blocked)),
    kv('Files cleaned', String(s.filesCleaned)),
    kv('Est. minutes saved', `~${s.estMinutesSaved}`),
    kv('Success rate', `${Math.round(s.successRate * 100)}% of ${s.totalRuns} runs`),
    { text: 'This week', size: 13, bold: true, spaceBefore: 10 },
    kv('Opened', `${d.weekly.opened} PR(s) · ${d.weekly.filesCleaned} file(s) · ${d.weekly.openedDelta >= 0 ? '+' : '-'}${Math.abs(d.weekly.openedDelta)} vs last week`),
    { text: '8-week trend (opened/week)', size: 13, bold: true, spaceBefore: 10 },
    { text: '', bars: d.trend, size: 9 },
    kv('Forecast', `${dirWord(d.forecast.direction)} - avg ~${d.forecast.weeklyAvg}/wk - next week ~ ${d.forecast.nextWeek}`),
    kv('Projected', `~${d.projection.cleanupsPerMonth} cleanups/mo - ~${d.projection.minutesPerMonth} min/mo`),
    { text: 'By scope', size: 13, bold: true, spaceBefore: 10 },
    ...(s.byScope.length ? s.byScope.map(x => kv(x.scope, `${x.opened} opened / ${x.runs} runs`)) : [{ text: 'no runs yet', size: 10, indent: 10 }]),
  ];
  if (d.next) blocks.push({ text: 'Suggested next', size: 13, bold: true, spaceBefore: 10 }, kv(d.next.scope, d.next.why));
  return blocks;
}
