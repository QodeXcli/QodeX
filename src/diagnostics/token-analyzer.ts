/**
 * Token Analyzer — pure measurement, no behavior change.
 *
 * Reads a session from the SessionStore and breaks down token consumption per turn
 * across the major categories. Helps diagnose WHERE tokens are actually being spent
 * before we apply any optimization.
 *
 * Token counting strategy:
 * --------------------------------------------------------------------------------
 * We do NOT depend on a real tokenizer like tiktoken — that adds 200KB+ of binary
 * data and a load-time cost for what's a diagnostic feature. Instead we use the
 * conventional 4-chars-per-token approximation, which is accurate to within ±10%
 * for English code/prose and tracks well enough to spot the BIG offenders.
 *
 * For users who need exact numbers later, we can plug in tiktoken; the interface
 * stays the same.
 *
 * Categories surfaced (per turn):
 *   - system        : the system prompt (estimated from the FIRST occurrence in the
 *                     session — we assume it doesn't materially change turn to turn)
 *   - tool_schemas  : JSON-encoded tool definitions. The biggest single line item
 *                     in most agent loops. We estimate this CURRENTLY using the
 *                     LIVE registry, since tool schemas aren't persisted per turn.
 *                     That's a slight inaccuracy if the user has changed modes mid-session
 *                     but it's a reasonable proxy.
 *   - user          : user input(s) in this turn
 *   - assistant     : assistant text + tool_calls JSON in this turn
 *   - tool_results  : tool output content returned to the model in this turn
 *
 * The output makes it obvious which lever has biggest payoff. For example, if you
 * see tool_schemas = 4200 × 12 turns, you know schema slimming (or KV-caching the
 * schemas) is worth the engineering effort. If tool_results = 8000 in a single turn,
 * you know dedup / truncation is what to chase.
 */

import type { Message } from '../session/store.js';
import { countTokens, countTokensJson } from '../utils/tokenizer.js';
import { logger } from '../utils/logger.js';

export interface TurnBreakdown {
  turnNumber: number;
  system: number;
  toolSchemas: number;
  user: number;
  assistant: number;
  toolResults: number;
  total: number;
}

export interface TokenReport {
  sessionId: string;
  turnCount: number;
  turns: TurnBreakdown[];
  totals: {
    system: number;
    toolSchemas: number;
    user: number;
    assistant: number;
    toolResults: number;
    grandTotal: number;
  };
  /** Top per-tool token consumers, sorted desc. */
  toolHotspots: Array<{ tool: string; calls: number; outputTokens: number; avgPerCall: number }>;
  /** Top per-file consumers (read_file etc.), sorted desc. */
  fileHotspots: Array<{ path: string; reads: number; totalTokens: number }>;
  /** Recommendations derived from the data. */
  recommendations: string[];
}

/**
 * Cheap, dependency-free token estimator.
 * Empirically ~3.8-4.2 chars/token for English code+prose;
 * we round to 4 for a stable baseline.
 */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  return countTokens(text);
}

/** Estimate tokens for any JSON-serializable value (used for tool_calls). */
export function estimateTokensJson(value: unknown): number {
  if (value === undefined || value === null) return 0;
  return countTokensJson(value);
}

/**
 * Group messages into turns. A "turn" starts at each user message and includes the
 * assistant + any tool result messages that follow, until the next user message.
 *
 * This matches how the agent loop actually thinks about turns (user prompt → agent
 * action burst → next user prompt).
 */
export function groupIntoTurns(messages: Message[]): Message[][] {
  const turns: Message[][] = [];
  let current: Message[] = [];
  for (const m of messages) {
    // Start a new turn at each user message — but only once the current turn
    // already contains a user message. This keeps a leading system (or any
    // pre-user preamble) attached to the first user turn instead of orphaning
    // it into a turn of its own, which would inflate the turn count.
    if (m.role === 'user' && current.some(x => x.role === 'user')) {
      turns.push(current);
      current = [];
    }
    current.push(m);
  }
  if (current.length > 0) turns.push(current);
  return turns;
}

export interface AnalyzeOptions {
  /** Tokens consumed by the system prompt; same value applied to every turn. */
  systemTokens: number;
  /** Tokens consumed by tool schemas; same value applied to every turn. */
  toolSchemaTokens: number;
}

/** Run the analysis. Pure function — no I/O. */
export function analyzeMessages(
  sessionId: string,
  messages: Message[],
  opts: AnalyzeOptions,
): TokenReport {
  const turns = groupIntoTurns(messages);
  const breakdowns: TurnBreakdown[] = [];

  // Per-tool aggregation
  const toolStats = new Map<string, { calls: number; tokens: number }>();
  // Per-file aggregation (best-effort: matches tool calls whose args contain a `path`/`file_path`)
  const fileStats = new Map<string, { reads: number; tokens: number }>();

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]!;
    let userTok = 0;
    let assistantTok = 0;
    let resultTok = 0;

    for (const m of turn) {
      if (m.role === 'user') {
        userTok += estimateTokens(m.content);
      } else if (m.role === 'assistant') {
        assistantTok += estimateTokens(m.content);
        if (m.tool_calls) {
          assistantTok += estimateTokensJson(m.tool_calls);
          // Track per-tool / per-file usage from the EMITTED calls (results come in `tool` messages)
          for (const tc of m.tool_calls) {
            const toolName = tc.function?.name ?? '(unknown)';
            const entry = toolStats.get(toolName) ?? { calls: 0, tokens: 0 };
            entry.calls += 1;
            toolStats.set(toolName, entry);
            // Extract file path heuristically
            try {
              const args = JSON.parse(tc.function?.arguments ?? '{}');
              const p = (args?.path ?? args?.file_path ?? args?.filename) as string | undefined;
              if (typeof p === 'string' && p.length < 256) {
                const e = fileStats.get(p) ?? { reads: 0, tokens: 0 };
                e.reads += 1;
                fileStats.set(p, e);
              }
            } catch (err) {
              // Unparseable tool-call args mean this call's file/path attribution is
              // skipped — log so the resulting undercount in diagnostics is traceable.
              logger.debug('token-analyzer: failed to parse tool-call arguments', { tool: toolName, err });
            }
          }
        }
      } else if (m.role === 'tool') {
        const tokens = estimateTokens(m.content);
        resultTok += tokens;
        // Attribute these tokens to the tool that produced them (lookup by tool_call_id is complex,
        // but `name` is set on tool messages when the agent records them).
        if ((m as any).name) {
          const t = (m as any).name as string;
          const entry = toolStats.get(t) ?? { calls: 0, tokens: 0 };
          entry.tokens += tokens;
          toolStats.set(t, entry);
        }
      }
    }

    const breakdown: TurnBreakdown = {
      turnNumber: i + 1,
      system: opts.systemTokens,
      toolSchemas: opts.toolSchemaTokens,
      user: userTok,
      assistant: assistantTok,
      toolResults: resultTok,
      total: opts.systemTokens + opts.toolSchemaTokens + userTok + assistantTok + resultTok,
    };
    breakdowns.push(breakdown);
  }

  const totals = breakdowns.reduce(
    (acc, b) => ({
      system: acc.system + b.system,
      toolSchemas: acc.toolSchemas + b.toolSchemas,
      user: acc.user + b.user,
      assistant: acc.assistant + b.assistant,
      toolResults: acc.toolResults + b.toolResults,
      grandTotal: acc.grandTotal + b.total,
    }),
    { system: 0, toolSchemas: 0, user: 0, assistant: 0, toolResults: 0, grandTotal: 0 },
  );

  const toolHotspots = [...toolStats.entries()]
    .map(([tool, s]) => ({
      tool,
      calls: s.calls,
      outputTokens: s.tokens,
      avgPerCall: s.calls > 0 ? Math.round(s.tokens / s.calls) : 0,
    }))
    .sort((a, b) => b.outputTokens - a.outputTokens);

  const fileHotspots = [...fileStats.entries()]
    .map(([path, s]) => ({ path, reads: s.reads, totalTokens: s.tokens }))
    .sort((a, b) => b.reads - a.reads);

  return {
    sessionId,
    turnCount: turns.length,
    turns: breakdowns,
    totals,
    toolHotspots,
    fileHotspots,
    recommendations: buildRecommendations({ totals, breakdowns, toolHotspots, fileHotspots }),
  };
}

/**
 * Data-driven recommendations. Each one fires only when its threshold is hit, so the
 * advice is calibrated to THIS session, not a generic checklist.
 *
 * Thresholds intentionally on the strict side — we don't want noise.
 */
function buildRecommendations(args: {
  totals: TokenReport['totals'];
  breakdowns: TurnBreakdown[];
  toolHotspots: TokenReport['toolHotspots'];
  fileHotspots: TokenReport['fileHotspots'];
}): string[] {
  const recs: string[] = [];
  const { totals, breakdowns, toolHotspots, fileHotspots } = args;
  const turnCount = breakdowns.length;
  if (turnCount === 0) return ['Session has no turns yet — run a task first.'];

  // 1. Tool schemas dominate? Each turn reships them, so total = perTurn * turnCount
  const schemasShare = totals.grandTotal > 0 ? totals.toolSchemas / totals.grandTotal : 0;
  if (schemasShare > 0.4) {
    recs.push(
      `Tool schemas account for ${Math.round(schemasShare * 100)}% of all tokens ` +
      `(${totals.toolSchemas.toLocaleString()} across ${turnCount} turns). ` +
      `Highest-leverage fix: enable prompt caching (cloud) or KV-cache reuse (local Ollama/MLX), ` +
      `OR slim tool descriptions. This is Lever 1 + Lever 2 in the optimization plan.`,
    );
  }

  // 2. System prompt similar
  const systemShare = totals.grandTotal > 0 ? totals.system / totals.grandTotal : 0;
  if (systemShare > 0.2 && turnCount > 3) {
    recs.push(
      `System prompt is reshipped every turn (${totals.system.toLocaleString()} total = ` +
      `${Math.round(systemShare * 100)}% of session). ` +
      `Same caching strategy applies — system + tools should be a single cached prefix.`,
    );
  }

  // 3. Repeated reads of the same file
  const repeatedFiles = fileHotspots.filter(f => f.reads >= 3);
  if (repeatedFiles.length > 0) {
    const top = repeatedFiles.slice(0, 3).map(f => `${f.path} (${f.reads}×)`).join(', ');
    recs.push(
      `Repeated reads detected: ${top}. ` +
      `Dedup with content hashing (Lever 3) would skip the redundant content. ` +
      `Each repeat costs the full file body in tokens.`,
    );
  }

  // 4. One tool dominates output
  if (toolHotspots.length > 0) {
    const top = toolHotspots[0]!;
    const topShare = totals.toolResults > 0 ? top.outputTokens / totals.toolResults : 0;
    if (topShare > 0.5 && top.outputTokens > 2000) {
      recs.push(
        `'${top.tool}' produced ${top.outputTokens.toLocaleString()} tokens of output ` +
        `(${Math.round(topShare * 100)}% of all tool results), ` +
        `avg ${top.avgPerCall.toLocaleString()} per call. ` +
        `Consider truncation at the tool level (e.g. max bytes) or summarisation of older results in history.`,
      );
    }
  }

  // 5. Total trajectory — is the session about to blow past a typical 32K context?
  const lastTurn = breakdowns[breakdowns.length - 1]!;
  if (lastTurn.total > 25000) {
    recs.push(
      `Latest turn weighs ${lastTurn.total.toLocaleString()} tokens. ` +
      `Local models with 32K context (most Ollama defaults) will be at ~80% capacity — ` +
      `accuracy and speed degrade quickly past this point. Run /clear or wait for auto-compaction.`,
    );
  } else if (lastTurn.total > 12000) {
    recs.push(
      `Latest turn weighs ${lastTurn.total.toLocaleString()} tokens. ` +
      `On Apple Silicon, prefill latency starts being noticeable past ~8K tokens. ` +
      `For interactive feel, prefer keeping turns under 10K via /clear or aggressive pruning.`,
    );
  }

  if (recs.length === 0) {
    recs.push('Session is reasonably well-distributed — no single category dominates. Good shape.');
  }

  return recs;
}

/** Render a TokenReport as a human-readable string for terminal output. */
export function formatReport(r: TokenReport): string {
  const lines: string[] = [];
  lines.push(`Token analysis — session ${r.sessionId.slice(0, 8)}  (${r.turnCount} turn${r.turnCount === 1 ? '' : 's'})`);
  lines.push('');
  lines.push('Per-turn breakdown (estimated tokens):');
  lines.push('');
  lines.push('  Turn   System  Schemas    User  Assist  Results    Total');
  lines.push('  ────  ───────  ───────  ──────  ──────  ───────  ───────');
  for (const t of r.turns) {
    lines.push(
      `  ${pad(String(t.turnNumber), 4)}` +
      `  ${pad(t.system.toLocaleString(), 7)}` +
      `  ${pad(t.toolSchemas.toLocaleString(), 7)}` +
      `  ${pad(t.user.toLocaleString(), 6)}` +
      `  ${pad(t.assistant.toLocaleString(), 6)}` +
      `  ${pad(t.toolResults.toLocaleString(), 7)}` +
      `  ${pad(t.total.toLocaleString(), 7)}`,
    );
  }
  lines.push('  ────  ───────  ───────  ──────  ──────  ───────  ───────');
  lines.push(
    '  TOT ' +
    `  ${pad(r.totals.system.toLocaleString(), 7)}` +
    `  ${pad(r.totals.toolSchemas.toLocaleString(), 7)}` +
    `  ${pad(r.totals.user.toLocaleString(), 6)}` +
    `  ${pad(r.totals.assistant.toLocaleString(), 6)}` +
    `  ${pad(r.totals.toolResults.toLocaleString(), 7)}` +
    `  ${pad(r.totals.grandTotal.toLocaleString(), 7)}`,
  );

  if (r.toolHotspots.length > 0) {
    lines.push('');
    lines.push('Tool hotspots (by output tokens consumed):');
    for (const h of r.toolHotspots.slice(0, 8)) {
      lines.push(`  ${pad(h.tool, 32)}  calls=${pad(String(h.calls), 3)}  tokens=${pad(h.outputTokens.toLocaleString(), 8)}  avg=${h.avgPerCall.toLocaleString()}`);
    }
  }

  if (r.fileHotspots.length > 0) {
    const top = r.fileHotspots.slice(0, 5);
    lines.push('');
    lines.push('File hotspots (most-accessed paths):');
    for (const h of top) {
      lines.push(`  ${pad(h.path, 50)}  reads=${h.reads}`);
    }
  }

  lines.push('');
  lines.push('Recommendations:');
  for (const rec of r.recommendations) {
    // Wrap recommendation text to ~78 chars for readability
    const wrapped = wrapAt(rec, 76);
    lines.push('  • ' + wrapped.replace(/\n/g, '\n    '));
  }

  return lines.join('\n');
}

function pad(s: string, width: number): string {
  if (s.length >= width) return s;
  return ' '.repeat(width - s.length) + s;
}

function wrapAt(s: string, width: number): string {
  const words = s.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur.length === 0) { cur = w; continue; }
    if (cur.length + 1 + w.length > width) {
      lines.push(cur);
      cur = w;
    } else {
      cur += ' ' + w;
    }
  }
  if (cur) lines.push(cur);
  return lines.join('\n');
}
