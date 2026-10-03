/**
 * Web-extract metrics — a tiny, always-on, local counter of how often oversized pages were trimmed
 * SEMANTICALLY (query-aware passage selection) vs POSITIONALLY (head+tail fallback). The dashboard
 * surfaces the hit-rate to show the semantic extraction is actually earning its keep — i.e. that
 * agents pass a `query` and get the relevant middle back instead of a blind window.
 *
 * Deliberately NOT the opt-in telemetry DB: this is a plain append-only JSONL under ~/.qodex, so it
 * works out of the box and never phones home. The aggregator is PURE and unit-tested; the record/read
 * wrappers are best-effort (a metrics write must never break a fetch).
 */
import type { ExtractMode } from './extract-select.js';

export interface ExtractCounts {
  semantic: number;
  headTail: number;
  truncated: number;      // semantic + headTail
  semanticRate: number;   // semantic ÷ truncated, 0..1
}

/** Aggregate JSONL metric lines (`{"t":…,"mode":"semantic|head-tail"}`) into counts. PURE. */
export function parseExtractMetrics(jsonl: string): ExtractCounts {
  let semantic = 0, headTail = 0;
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    try {
      const mode = JSON.parse(line)?.mode;
      if (mode === 'semantic') semantic++;
      else if (mode === 'head-tail') headTail++;
    } catch { /* skip malformed line */ }
  }
  const truncated = semantic + headTail;
  return { semantic, headTail, truncated, semanticRate: truncated ? semantic / truncated : 0 };
}

async function metricsFile(): Promise<string> {
  const { QODEX_HOME } = await import('../../config/defaults.js');
  const path = await import('path');
  return path.join(QODEX_HOME, 'cache', 'web', 'extract-metrics.jsonl');
}

/** Append one extract event. Only the truncation modes are recorded (whole pages aren't interesting). Best-effort. */
export async function recordExtract(mode: ExtractMode): Promise<void> {
  if (mode !== 'semantic' && mode !== 'head-tail') return;
  try {
    const { promises: fs } = await import('fs');
    const path = await import('path');
    const file = await metricsFile();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, JSON.stringify({ t: Date.now(), mode }) + '\n');
  } catch { /* metrics must never break a fetch */ }
}

/** Read + aggregate the metrics file (last 5000 events). Best-effort → zeros if absent. */
export async function readExtractMetrics(): Promise<ExtractCounts> {
  try {
    const { promises: fs } = await import('fs');
    const file = await metricsFile();
    const text = await fs.readFile(file, 'utf-8');
    const lines = text.split('\n');
    return parseExtractMetrics(lines.slice(-5000).join('\n'));
  } catch { return { semantic: 0, headTail: 0, truncated: 0, semanticRate: 0 }; }
}
