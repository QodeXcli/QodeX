/**
 * In-session operational insights.
 *
 * Accumulates what the loop already observes (provider usage, TTFT, tool wall)
 * in memory — no SQLite, no extra provider call, no startup I/O. `/insights`
 * reads the live snapshot; SessionStore persists a JSON copy at the end of a
 * turn so `qodex sessions show` works after restart.
 */

export interface InsightsTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  costUsd: number;
  llmCalls: number;
}

export interface InsightsLatency {
  thinkMs: number;
  generateMs: number;
  toolMs: number;
}

export interface InsightsToolRow {
  calls: number;
  ok: number;
  fail: number;
  durationMs: number;
}

export interface InsightsSnapshot {
  sessionId: string;
  startedAt: number;
  updatedAt: number;
  tokens: InsightsTokens;
  latency: InsightsLatency;
  tools: Record<string, InsightsToolRow>;
}

export interface LlmInsight {
  input: number;
  output: number;
  cacheRead?: number;
  cacheCreation?: number;
  costUsd: number;
  thinkMs: number;
  generateMs: number;
}

export interface ToolInsight {
  name: string;
  ok: boolean;
  durationMs: number;
}

export class SessionInsights {
  private startedAt: number;
  private updatedAt: number;
  private tokens: InsightsTokens = {
    input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costUsd: 0, llmCalls: 0,
  };
  private latency: InsightsLatency = { thinkMs: 0, generateMs: 0, toolMs: 0 };
  private tools = new Map<string, InsightsToolRow>();

  constructor(private readonly sessionId: string, now: number = Date.now()) {
    this.startedAt = now;
    this.updatedAt = now;
  }

  recordLlm(ev: LlmInsight, now: number = Date.now()): void {
    this.tokens.input += ev.input;
    this.tokens.output += ev.output;
    this.tokens.cacheRead += ev.cacheRead ?? 0;
    this.tokens.cacheCreation += ev.cacheCreation ?? 0;
    this.tokens.costUsd += ev.costUsd;
    this.tokens.llmCalls += 1;
    this.latency.thinkMs += Math.max(0, ev.thinkMs);
    this.latency.generateMs += Math.max(0, ev.generateMs);
    this.updatedAt = now;
  }

  recordTool(ev: ToolInsight, now: number = Date.now()): void {
    const row = this.tools.get(ev.name) ?? { calls: 0, ok: 0, fail: 0, durationMs: 0 };
    row.calls += 1;
    if (ev.ok) row.ok += 1;
    else row.fail += 1;
    row.durationMs += Math.max(0, ev.durationMs);
    this.tools.set(ev.name, row);
    this.latency.toolMs += Math.max(0, ev.durationMs);
    this.updatedAt = now;
  }

  reset(now: number = Date.now()): void {
    this.startedAt = now;
    this.updatedAt = now;
    this.tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costUsd: 0, llmCalls: 0 };
    this.latency = { thinkMs: 0, generateMs: 0, toolMs: 0 };
    this.tools.clear();
  }

  isEmpty(): boolean {
    return this.tokens.llmCalls === 0 && this.tools.size === 0;
  }

  snapshot(): InsightsSnapshot {
    const tools: Record<string, InsightsToolRow> = {};
    for (const [name, row] of this.tools) {
      tools[name] = { ...row };
    }
    return {
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
      tokens: { ...this.tokens },
      latency: { ...this.latency },
      tools,
    };
  }
}

export function parseInsightsSnapshot(raw: unknown): InsightsSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as any;
  if (typeof o.sessionId !== 'string') return null;
  if (!o.tokens || !o.latency || typeof o.tools !== 'object' || !o.tools) return null;
  return {
    sessionId: o.sessionId,
    startedAt: Number(o.startedAt) || 0,
    updatedAt: Number(o.updatedAt) || 0,
    tokens: {
      input: Number(o.tokens.input) || 0,
      output: Number(o.tokens.output) || 0,
      cacheRead: Number(o.tokens.cacheRead) || 0,
      cacheCreation: Number(o.tokens.cacheCreation) || 0,
      costUsd: Number(o.tokens.costUsd) || 0,
      llmCalls: Number(o.tokens.llmCalls) || 0,
    },
    latency: {
      thinkMs: Number(o.latency.thinkMs) || 0,
      generateMs: Number(o.latency.generateMs) || 0,
      toolMs: Number(o.latency.toolMs) || 0,
    },
    tools: o.tools as Record<string, InsightsToolRow>,
  };
}

function fmtN(n: number): string {
  return Math.round(n).toLocaleString();
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

function fmtUsd(n: number): string {
  if (n === 0) return '$0.00';
  if (n < 0.0001) return `$${n.toExponential(2)}`;
  return `$${n.toFixed(4)}`;
}

/** Human report for `/insights` and `qodex sessions show`. PURE. */
export function formatInsights(snap: InsightsSnapshot): string {
  const seen = snap.tokens.input + snap.tokens.cacheRead;
  const hit = seen > 0 ? (100 * snap.tokens.cacheRead / seen) : 0;
  const wall = snap.updatedAt > snap.startedAt ? snap.updatedAt - snap.startedAt : 0;
  const accounted = snap.latency.thinkMs + snap.latency.generateMs + snap.latency.toolMs;
  const toolRows = Object.entries(snap.tools).sort((a, b) => b[1].calls - a[1].calls);

  const lines: string[] = [
    `Session insights  ${snap.sessionId.slice(0, 8)}  ·  ${wall ? fmtMs(wall) : 'this turn'}`,
    '',
    'Tokens',
    `  input          ${fmtN(snap.tokens.input)}`,
    `  output         ${fmtN(snap.tokens.output)}`,
    `  cache read     ${fmtN(snap.tokens.cacheRead)}${seen > 0 ? `   (${hit.toFixed(0)}% of billed input)` : ''}`,
    `  cache write    ${fmtN(snap.tokens.cacheCreation)}`,
    `  cost           ${fmtUsd(snap.tokens.costUsd)}   (${snap.tokens.llmCalls} call${snap.tokens.llmCalls === 1 ? '' : 's'})`,
    '  (catalog/config rate × provider usage — not an invoice)',
    '',
    'Tools',
  ];
  if (toolRows.length === 0) {
    lines.push('  (none yet)');
  } else {
    const nameW = Math.max(12, ...toolRows.map(([n]) => n.length));
    for (const [name, r] of toolRows) {
      lines.push(
        `  ${name.padEnd(nameW)}  ${String(r.ok).padStart(3)} ok / ${String(r.fail).padStart(2)} fail   ${fmtMs(r.durationMs)}   ${r.calls}×`,
      );
    }
  }
  lines.push(
    '',
    'Time',
    `  model wait (TTFT)     ${fmtMs(snap.latency.thinkMs)}`,
    `  model generate        ${fmtMs(snap.latency.generateMs)}`,
    `  tools                 ${fmtMs(snap.latency.toolMs)}`,
    `  accounted             ${fmtMs(accounted)}`,
  );
  return lines.join('\n');
}

/** Markdown for `qodex sessions export`. PURE. */
export function formatInsightsMarkdown(snap: InsightsSnapshot, meta?: { title?: string | null; model?: string; cwd?: string }): string {
  const body = formatInsights(snap);
  const head = [
    `# QodeX session ${snap.sessionId.slice(0, 8)}`,
    '',
    meta?.title ? `- **title:** ${meta.title}` : null,
    meta?.model ? `- **model:** ${meta.model}` : null,
    meta?.cwd ? `- **cwd:** ${meta.cwd}` : null,
    `- **updated:** ${new Date(snap.updatedAt || Date.now()).toISOString()}`,
    '',
    '```',
    body,
    '```',
    '',
  ].filter((x): x is string => x !== null);
  return head.join('\n');
}
