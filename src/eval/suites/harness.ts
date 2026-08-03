/**
 * The FREE deterministic harness suite — layer (a).
 *
 * WHY THIS EXISTS: QodeX's agent harness (prompt tiering, ~125 gated tools, dedup /
 * aging / spill / compaction / pruning, cache-breakpoint layout, loop detectors) had no
 * way to answer "did that change make it better or worse?". Most of that question does
 * NOT need a model to answer. A tool block that grew 8k tokens, a system prompt that
 * names a tool the registry doesn't have, a pruning pass that strands a `tool_calls`
 * without its result, a loop detector that stopped firing — every one of those is a
 * measurable property of the harness, checkable in milliseconds, for free, in CI.
 *
 * That is what lives here. NO LLM is invoked by anything in this file. Every task:
 *   - measures a REAL harness artifact (the actual registry, the actual
 *     `buildSystemPrompt`, the actual `pruneMessages`, the actual detectors), and
 *   - returns a DETAIL string carrying the measured value vs. the budget, so a failure
 *     tells you the number that moved rather than just "assertion failed".
 *
 * FAILABILITY IS THE CONTRACT. A check that cannot fail is decoration. Every probe the
 * suite depends on is injectable (`HarnessProbes`), so `test/eval-harness-suite.test.ts`
 * can hand each task a deliberately broken harness and prove the task goes red — the
 * budgets below are calibrated with headroom against measured values, not set so loose
 * that nothing could ever trip them.
 *
 * HONESTY: a probe that cannot run reports `skip` with a reason (see
 * `history.tool-call-pairing`, which lazily loads the agent loop for the real pruner).
 * Nothing here ever reports `pass` for something it did not measure.
 */

import type { EvalContext, EvalSuite, EvalTask, TaskOutcome } from '../types.js';
import type { Message, ToolSchema } from '../../llm/types.js';
import type { SystemPromptContext } from '../../llm/prompts/system.js';
import type { ToolExecutionMode } from '../../tools/registry.js';

// Pure, side-effect-free modules — safe to import eagerly. The EXPENSIVE thing (building
// the tool registry, which constructs ~125 tools) stays behind `getRegistry()`'s singleton
// and is therefore only paid by the tasks that actually ask for schemas. The agent loop
// (a large import graph) is loaded lazily inside `loadPrune`.
import { getRegistry } from '../../tools/registry.js';
import { buildSystemPrompt } from '../../llm/prompts/system.js';
import { filterSchemasByRelevance } from '../../agent/tool-relevance.js';
import { countTokens, countTokensJson } from '../../utils/tokenizer.js';
import { withCacheBreakpoints } from '../../llm/providers/anthropic.js';
import { ageToolResults } from '../../agent/result-aging.js';
import { dedupHistory } from '../../agent/dedup.js';
import { answerOrphanToolCalls } from '../../llm/providers/openai.js';
import {
  detectErrorLoop, detectStuckLoop, errorCodeOf, looksFutile, readLoopAction,
} from '../../agent/recovery.js';

// ---------------------------------------------------------------------------
// Budgets — the declared numbers a failure is measured against.
// ---------------------------------------------------------------------------

/**
 * Every budget is a TOKEN or RATIO ceiling with deliberate headroom over the value
 * measured on the harness at the time of writing (noted per field). Headroom exists so
 * ordinary growth doesn't cry wolf; it is NOT so wide that a real regression hides. Move
 * a number here only with a reason — that is the whole point of writing them down.
 */
export interface HarnessBudgets {
  /** All tool definitions, `mode: normal`. Measured ~31.8k over 125 tools. */
  toolTokensNormal: number;
  /** Tool definitions after relevance gating on a coding task. Measured ~13.7k / 48 tools. */
  toolTokensGated: number;
  /** Assembled system prompt, COMPRESSED tier (claude/gpt/gemini/≥70B). Measured ~5.6k. */
  promptTokensCompressed: number;
  /** Assembled system prompt, FULL tier (small qwen/deepseek/other). Measured ~7.8k. */
  promptTokensFull: number;
  /**
   * Max Jaccard word-overlap allowed between any two enabled tool DESCRIPTIONS. Two
   * near-identical descriptions make the model pick at random. Measured max ~0.48
   * (background_job_log vs dev_server_log).
   */
  maxDescriptionSimilarity: number;
  /** Anthropic accepts at most 4 `cache_control` markers per request. Hard API limit. */
  maxCacheBreakpoints: number;
}

export const DEFAULT_BUDGETS: HarnessBudgets = {
  toolTokensNormal: 36_000,
  toolTokensGated: 18_000,
  promptTokensCompressed: 6_500,
  promptTokensFull: 9_000,
  maxDescriptionSimilarity: 0.70,
  maxCacheBreakpoints: 4,
};

// ---------------------------------------------------------------------------
// Probes — the seam between "the real harness" and "a broken harness" (tests).
// ---------------------------------------------------------------------------

/** Result of the prune probe, or `null` when the real pruner could not be loaded. */
export type PruneProbe = ((messages: Message[], maxTokens: number) => Message[]) | null;

/**
 * Everything the suite touches, behind one injectable interface. `realProbes()` binds
 * these to the actual QodeX modules; tests swap individual members to prove each task
 * genuinely fails on a broken harness.
 *
 * All probes are lazy: nothing heavy is imported until a task actually runs.
 */
export interface HarnessProbes {
  toolSchemas(mode: ToolExecutionMode): ToolSchema[];
  /** Names the registry can actually dispatch, EXCLUDING aliases. Aliases are forgiving
   *  lookups, not a licence for the prompt to name a tool the model can't see listed. */
  registeredToolNames(): string[];
  buildPrompt(ctx: SystemPromptContext): string;
  /** Relevance gating (`filterSchemasByRelevance`) applied to a signal string. */
  gateSchemas(schemas: ToolSchema[], signal: string): ToolSchema[];
  countTokens(text: string): number;
  countTokensJson(value: unknown): number;
  cacheBreakpoints(
    systemText: string,
    messages: unknown[],
    tools: unknown[] | undefined,
    boundary?: number,
  ): { system: unknown; messages: unknown[]; tools: unknown[] | undefined };
  ageHistory(messages: Message[]): Message[];
  dedupHistory(messages: Message[]): { messages: Message[]; replaced: number };
  /** Resolves to the real `AgentLoop.pruneMessages`, or `null` if it can't be loaded. */
  loadPrune(): Promise<PruneProbe>;
  repairOrphans(messages: Message[]): Message[];
  /** Spill an oversized tool result; returns the in-context replacement content. */
  spillResult(toolName: string, content: string, maxResultChars: number): Promise<string>;
  compact(
    messages: Message[],
    summarize: (msgs: Message[]) => Promise<string>,
  ): Promise<{ messages: Message[]; turnsCompacted: number }>;
  detectStuckLoop(calls: Array<{ name: string; argsHash: string }>): boolean;
  detectErrorLoop(
    errs: Array<{ name: string; code: string }>,
    threshold?: number,
  ): { name: string; code: string; count: number } | null;
  readLoopAction(maxIdenticalReads: number): 'none' | 'summarize' | 'abort';
  looksFutile(content: string): boolean;
  errorCodeOf(content: string): string;
}

/** Bind the suite to the REAL harness. */
export function realProbes(): HarnessProbes {
  return {
    toolSchemas(mode) { return getRegistry().getSchemas(mode); },
    registeredToolNames() { return getRegistry().list().map(t => t.name); },
    buildPrompt(ctx) { return buildSystemPrompt(ctx); },
    gateSchemas(schemas, signal) { return filterSchemasByRelevance(schemas, signal).schemas; },
    countTokens(text) { return countTokens(text); },
    countTokensJson(value) { return countTokensJson(value); },
    cacheBreakpoints(systemText, messages, tools, boundary) {
      return withCacheBreakpoints(systemText, messages as any[], tools as any[] | undefined, boundary);
    },
    ageHistory(messages) { return ageToolResults(messages).messages; },
    dedupHistory(messages) {
      const r = dedupHistory(messages);
      return { messages: r.messages, replaced: r.replaced };
    },
    async loadPrune() {
      try {
        const { AgentLoop } = await import('../../agent/loop.js');
        // Call the REAL private pruner without paying for a full AgentLoop construction
        // (router/permissions/snapshot service). `pruneMessages` reads only `this.config`
        // and `this.estimateTokens`, both satisfied by a bare prototype instance — so this
        // exercises the shipped code path, not a copy of it.
        const inst = Object.create(AgentLoop.prototype) as any;
        inst.config = {};
        return (messages: Message[], maxTokens: number) => inst.pruneMessages(messages, maxTokens);
      } catch {
        return null;
      }
    },
    repairOrphans(messages) { return answerOrphanToolCalls(messages); },
    async spillResult(toolName, content, maxResultChars) {
      const os = await import('node:os');
      const fsp = await import('node:fs/promises');
      const path = await import('node:path');
      const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'qodex-eval-spill-'));
      try {
        const { applySpillGuard } = await import('../../agent/tool-spill.js');
        const out = await applySpillGuard(toolName, 'eval-session', content, {
          maxResultChars, baseDir: base,
        });
        return out.content;
      } finally {
        await fsp.rm(base, { recursive: true, force: true }).catch(() => {});
      }
    },
    async compact(messages, summarize) {
      const { compactMessages } = await import('../../utils/compaction.js');
      const r = await compactMessages(messages, { keepLastTurns: 2, summarize });
      return { messages: r.messages, turnsCompacted: r.turnsCompacted };
    },
    detectStuckLoop(calls) { return detectStuckLoop(calls); },
    detectErrorLoop(errs, threshold) { return detectErrorLoop(errs, threshold); },
    readLoopAction(n) { return readLoopAction(n); },
    looksFutile(c) { return looksFutile(c); },
    errorCodeOf(c) { return errorCodeOf(c); },
  };
}

// ---------------------------------------------------------------------------
// Declared knowledge the checks are measured against.
// ---------------------------------------------------------------------------

/**
 * Representative coding tasks and the tools each PROVABLY needs. If relevance gating
 * ever drops one of these, the agent is structurally unable to do that task — the
 * failure mode is silent ("I can't edit files") and expensive to debug from a
 * transcript. Names here are asserted against the GATED set, not the full registry.
 */
export interface GatingScenario {
  id: string;
  signal: string;
  required: string[];
}

export const GATING_SCENARIOS: GatingScenario[] = [
  {
    id: 'edit',
    signal: 'fix the failing assertion in src/agent/loop.ts — read the file and edit the broken function, then run the tests',
    required: ['read_file', 'edit_text', 'edit_symbol', 'multi_edit', 'write_file', 'shell', 'grep', 'glob', 'ls'],
  },
  {
    id: 'review-and-commit',
    signal: 'review my changes and commit them with a good message',
    required: ['git_status', 'git_diff', 'git_commit', 'review_my_changes', 'read_file', 'shell'],
  },
  {
    id: 'docker-debug',
    signal: 'the docker container keeps crashing on startup — check the container logs',
    required: ['docker_ps', 'docker_logs', 'shell', 'read_file'],
  },
  {
    id: 'web-research',
    signal: 'search the web for the current recommended vite config and fetch the docs page',
    required: ['web_search', 'web_fetch', 'read_file'],
  },
];

/**
 * Known-contradiction pairs. A contradiction is recorded when BOTH patterns match the
 * SAME assembled prompt. Each pair is deliberately literal so it cannot false-fire on
 * today's wording, while a careless future edit that reverses a rule trips it.
 *
 * This is a DECLARED list on purpose: "detect any contradiction" is an LLM problem, and
 * this layer is the free one. Growing the list as real contradictions are found is the
 * intended maintenance path.
 */
export interface ContradictionPair {
  id: string;
  a: RegExp;
  b: RegExp;
  why: string;
}

/** A stub summary shaped like a real one. Compaction refuses anything too short to carry a
 *  goal, a path and a constraint (MIN_SUMMARY_CHARS), so a token-sized stub would make the
 *  compaction stage a silent no-op and these probes would then measure nothing. */
const STUB_SUMMARY =
  '[CTX_SUMMARY]\nGoal: the user asked for the refactor described above. ' +
  'Paths: src/. Decisions: none recorded. Files touched: none. ' +
  'Open todos: continue the task. Standing constraints: none.';

export const CONTRADICTION_PAIRS: ContradictionPair[] = [
  {
    id: 'identity',
    a: /You are QodeX/,
    b: /\bYou are (?!NOT\b)(?:Claude|ChatGPT|GPT-\d|Qwen|DeepSeek|Llama)\b/,
    why: 'the prompt asserts the QodeX identity AND an underlying-LLM identity',
  },
  {
    id: 'read-before-write',
    a: /Never (?:edit|modify) a file you haven'?t read/i,
    b: /(?:you may|it'?s fine to|feel free to) (?:edit|write|modify) (?:a |the )?files? without reading/i,
    why: 'read-before-write is stated as absolute AND waived elsewhere',
  },
  {
    id: 'edit-tool-preference',
    a: /[Pp]refer `edit_symbol`/,
    b: /prefer `edit_text` over `edit_symbol`/i,
    why: 'the structural-over-textual preference is stated in both directions',
  },
  {
    id: 'verify-before-done',
    a: /never say "?done"? (?:without|unverified)|never say "done" without verification/i,
    b: /(?:no need to|don'?t bother to) (?:run|verify with) (?:the )?(?:tests|lints|type checks)/i,
    why: 'verification is mandated AND excused',
  },
  {
    id: 'language-match',
    a: /Match the user'?s language/i,
    b: /(?:always|only) (?:reply|respond|answer) in English/i,
    why: 'the reply language is both "follow the user" and "always English"',
  },
  {
    id: 'delegation',
    a: /`task`/,
    b: /(?:never|do not|don'?t) (?:use|call) the `task` tool/i,
    why: 'delegation via `task` is both encouraged and forbidden',
  },
  {
    id: 'single-final-answer',
    a: /Output your final response exactly ONCE/,
    b: /(?:repeat|restate) your (?:final )?(?:answer|response) (?:at the end|again)/i,
    why: 'the answer must be emitted once AND repeated',
  },
];

/** The four prompt assemblies the prompt checks sweep over. */
interface PromptVariant {
  id: string;
  tier: 'compressed' | 'full';
  ctx: SystemPromptContext;
}

function promptVariants(allToolNames: string[]): PromptVariant[] {
  const base = {
    cwd: '/repo',
    projectInfo: { languages: ['typescript'], testRunner: 'vitest' },
    knowledgeFacts: [],
    directoryTree: '',
    gitBranch: 'main',
  };
  const mk = (
    id: string,
    tier: 'compressed' | 'full',
    over: Partial<SystemPromptContext>,
  ): PromptVariant => ({
    id, tier,
    ctx: {
      ...base,
      mode: 'normal',
      modelFamily: 'claude',
      modelId: 'claude-sonnet-4-6',
      availableToolNames: allToolNames,
      ...over,
    } as SystemPromptContext,
  });
  return [
    mk('normal-compressed', 'compressed', {}),
    mk('normal-full', 'full', { modelFamily: 'qwen', modelId: 'qwen2.5-coder-7b' }),
    mk('plan-compressed', 'compressed', { mode: 'plan' }),
    mk('subagent-compressed', 'compressed', { mode: 'subagent' }),
  ];
}

// ---------------------------------------------------------------------------
// Small assertion helpers — every outcome carries measured-vs-budget in `detail`.
// ---------------------------------------------------------------------------

function verdict(ok: boolean, reason: string, detail: string, metrics: Record<string, number>): TaskOutcome {
  return ok ? { status: 'pass', detail, metrics } : { status: 'fail', reason, detail, metrics };
}

/** Jaccard similarity over the word sets of two descriptions. */
function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function words(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean));
}

/** Longest common byte prefix of two strings. */
function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

/** Count `cache_control` markers anywhere in a value (system blocks, tools, messages). */
function countCacheControls(value: unknown): number {
  if (Array.isArray(value)) return value.reduce<number>((n, v) => n + countCacheControls(v), 0);
  if (value && typeof value === 'object') {
    let n = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'cache_control' && v) n++;
      else n += countCacheControls(v);
    }
    return n;
  }
  return 0;
}

// --- synthetic histories (shared by the history tasks) ----------------------

const GOAL_TEXT = 'GOAL-ANCHOR: migrate the payment webhook in src/api/webhooks/stripe.ts to the v2 signature scheme';

function toolCallMsg(id: string, name: string, args: Record<string, unknown>): Message {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  } as Message;
}

function toolResultMsg(id: string, name: string, content: string): Message {
  return { role: 'tool', tool_call_id: id, name, content } as Message;
}

/**
 * A MULTI-TURN conversation: N user messages, each followed by a tool call, its result,
 * and an assistant reply. Compaction and pruning both group by user message, so a
 * single-user-message history makes those layers no-ops — and a no-op layer would make
 * the assertion vacuously true, which is the dishonest-pass failure mode this whole
 * subsystem exists to prevent. The FIRST user message carries the goal.
 */
function multiTurnHistory(turns: number): Message[] {
  const msgs: Message[] = [{ role: 'system', content: 'SYSTEM PROMPT (stable prefix)' } as Message];
  for (let i = 0; i < turns; i++) {
    msgs.push({ role: 'user', content: i === 0 ? GOAL_TEXT : `follow-up ${i}: also handle the refund path` } as Message);
    const id = `turn_${i}`;
    msgs.push(toolCallMsg(id, i % 2 === 0 ? 'read_file' : 'shell', { path: `src/api/f${i % 3}.ts`, command: `npm test -- ${i}` }));
    msgs.push(toolResultMsg(id, i % 2 === 0 ? 'read_file' : 'shell', `RESULT BODY ${i % 3}\n${'z'.repeat(7_000)}\nFAIL at the tail`));
    msgs.push({ role: 'assistant', content: `step ${i} done` } as Message);
  }
  return msgs;
}

/** A single-goal autonomous history: one user message, then N read/shell turns with big
 *  results. This is the shape `pruneMessages`' phase-2 unit dropping was written for. */
function syntheticHistory(turns: number): Message[] {
  const msgs: Message[] = [
    { role: 'system', content: 'SYSTEM PROMPT (stable prefix)' } as Message,
    { role: 'user', content: GOAL_TEXT } as Message,
  ];
  for (let i = 0; i < turns; i++) {
    const id = `call_${i}`;
    if (i % 2 === 0) {
      msgs.push(toolCallMsg(id, 'read_file', { path: `src/api/webhooks/f${i % 3}.ts` }));
      // Every third read repeats content verbatim -> gives dedup something real to do.
      msgs.push(toolResultMsg(id, 'read_file', `FILE BODY ${i % 3}\n${'x'.repeat(6_000)}`));
    } else {
      msgs.push(toolCallMsg(id, 'shell', { command: `npm test -- case-${i}` }));
      msgs.push(toolResultMsg(id, 'shell', `BUILD LOG ${i}\n${'y'.repeat(9_000)}\nFAIL at the tail`));
    }
  }
  return msgs;
}

interface PairingReport {
  orphanedCalls: string[];
  orphanedResults: string[];
}

/** Every assistant `tool_calls` id must have a following tool result, and every tool
 *  result must belong to an assistant tool_call that precedes it. */
function checkPairing(messages: Message[]): PairingReport {
  const declared = new Set<string>();
  const answered = new Set<string>();
  const orphanedResults: string[] = [];
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      for (const tc of m.tool_calls) declared.add(tc.id);
    } else if (m.role === 'tool') {
      const id = m.tool_call_id ?? '';
      if (!declared.has(id)) orphanedResults.push(id || '(missing tool_call_id)');
      else answered.add(id);
    }
  }
  const orphanedCalls = [...declared].filter(id => !answered.has(id));
  return { orphanedCalls, orphanedResults };
}

// ---------------------------------------------------------------------------
// The suite.
// ---------------------------------------------------------------------------

export interface HarnessSuiteOptions {
  /** Swap individual probes to point the suite at a deliberately broken harness. */
  probes?: Partial<HarnessProbes>;
  /** Override individual budgets. */
  budgets?: Partial<HarnessBudgets>;
}

export function createHarnessSuite(opts: HarnessSuiteOptions = {}): EvalSuite {
  const P: HarnessProbes = { ...realProbes(), ...opts.probes };
  const B: HarnessBudgets = { ...DEFAULT_BUDGETS, ...opts.budgets };

  const det = (
    id: string, name: string, category: string,
    run: (ctx: EvalContext) => Promise<TaskOutcome>,
  ): EvalTask => ({ id, name, category, kind: 'deterministic', run });

  return {
    name: 'harness',
    tasks: [
      // ===================================================================
      // TOOL SURFACE
      // ===================================================================

      det('tools.definition-budget', 'Tool definitions fit the token budget', 'tool-surface', async () => {
        const schemas = P.toolSchemas({ mode: 'normal' });
        const tokens = P.countTokensJson(schemas);
        const detail =
          `tool definitions (mode=normal): ${tokens} tokens over ${schemas.length} tools ` +
          `vs budget ${B.toolTokensNormal} ` +
          `(${((tokens / B.toolTokensNormal) * 100).toFixed(1)}% of budget, ` +
          `${Math.round(tokens / Math.max(1, schemas.length))} tokens/tool avg). ` +
          `This payload is re-sent on EVERY iteration.`;
        return verdict(
          tokens <= B.toolTokensNormal,
          `tool definitions cost ${tokens} tokens, over the ${B.toolTokensNormal} budget`,
          detail,
          { toolTokens: tokens, toolCount: schemas.length, toolTokenBudget: B.toolTokensNormal },
        );
      }),

      det('tools.gating-keeps-essentials', 'Relevance gating keeps what each task needs', 'tool-surface', async ctx => {
        const all = P.toolSchemas({ mode: 'normal' });
        const missing: string[] = [];
        const lines: string[] = [];
        let worstTokens = 0;
        for (const sc of GATING_SCENARIOS) {
          const gated = P.gateSchemas(all, sc.signal);
          const names = new Set(gated.map(s => s.function.name));
          // Only require tools that EXIST in the ungated set — a tool that was removed
          // from the registry is a different failure, caught by other tasks.
          const present = sc.required.filter(n => all.some(s => s.function.name === n));
          const gone = present.filter(n => !names.has(n));
          const tokens = P.countTokensJson(gated);
          worstTokens = Math.max(worstTokens, tokens);
          for (const g of gone) missing.push(`${sc.id}:${g}`);
          lines.push(`${sc.id}: ${gated.length}/${all.length} tools, ${tokens} tok` +
            (gone.length ? ` — MISSING ${gone.join(', ')}` : ' — all required tools present'));
          ctx.log(lines[lines.length - 1]!);
        }
        const overBudget = worstTokens > B.toolTokensGated;
        const detail =
          lines.join('\n') +
          `\nworst gated payload ${worstTokens} tokens vs budget ${B.toolTokensGated}`;
        const ok = missing.length === 0 && !overBudget;
        const reason = missing.length
          ? `relevance gating dropped tools the task needs: ${missing.join(', ')}`
          : `gated tool payload ${worstTokens} tokens exceeds the ${B.toolTokensGated} budget`;
        return verdict(ok, reason, detail, {
          gatedMissing: missing.length,
          gatedWorstTokens: worstTokens,
          gatedTokenBudget: B.toolTokensGated,
        });
      }),

      det('tools.description-ambiguity', 'No two enabled tools describe themselves alike', 'tool-surface', async () => {
        const schemas = P.toolSchemas({ mode: 'normal' });
        const rows = schemas.map(s => ({
          name: s.function.name,
          // First 400 chars: the part the model actually weighs when choosing.
          set: words((s.function.description ?? '').slice(0, 400)),
        }));
        let worst = { a: '-', b: '-', sim: 0 };
        const offenders: string[] = [];
        for (let i = 0; i < rows.length; i++) {
          for (let j = i + 1; j < rows.length; j++) {
            const sim = similarity(rows[i]!.set, rows[j]!.set);
            if (sim > worst.sim) worst = { a: rows[i]!.name, b: rows[j]!.name, sim };
            if (sim > B.maxDescriptionSimilarity) {
              offenders.push(`${rows[i]!.name} ~ ${rows[j]!.name} (${sim.toFixed(3)})`);
            }
          }
        }
        const detail =
          `most similar pair: ${worst.a} ~ ${worst.b} at ${worst.sim.toFixed(3)} ` +
          `vs max ${B.maxDescriptionSimilarity} (${rows.length} tools, ` +
          `${(rows.length * (rows.length - 1)) / 2} pairs compared)` +
          (offenders.length ? `\nover budget: ${offenders.join('; ')}` : '');
        return verdict(
          offenders.length === 0,
          `${offenders.length} tool pair(s) have near-identical descriptions: ${offenders.slice(0, 3).join('; ')}`,
          detail,
          { maxSimilarity: Number(worst.sim.toFixed(4)), ambiguousPairs: offenders.length },
        );
      }),

      // Calibration, not compliance. A tool description that only says WHEN TO USE a tool —
      // with an unconditional imperative and no exit criterion — produces over-use, because
      // the model has no basis to decide "not this time". The reported symptom was
      // todo_write firing on every request including single-line edits; the cause was a
      // description that said "use this to track multi-step work … update frequently" and
      // never said when not to. The negative half is what creates judgement.
      // The gate was keyed on the TOOL's own vocabulary rather than on task INTENT: it kept
      // artifact_* only for the literal word "artifact", and browser_* only for "browser".
      // So "redesign the landing page", "build me a dashboard UI" and "check how the page
      // looks" — the natural ways to ask — lost those tools on the OPENING turn, exactly when
      // the model chooses its approach. The ratchet restores them later, but only if the user
      // happens to say the magic word. Short git asks failed the same way: "commit and open a
      // PR" was judged a trivial turn and got CORE tools only.
      det('tools.gating-follows-intent', 'Gating keys on task intent, not on tool vocabulary', 'tool-surface', async () => {
        const all = P.toolSchemas({ mode: 'normal' });
        const kept = (task: string, tool: string) =>
          P.gateSchemas(all, task).some(s => s.function?.name === tool);
        // Each case is phrased the way a user actually asks — never using the tool's own name.
        const CASES: { task: string; tool: string }[] = [
          { task: 'redesign the landing page to look modern', tool: 'artifact_create' },
          { task: 'build me a dashboard UI', tool: 'artifact_create' },
          { task: 'make the homepage prettier', tool: 'artifact_create' },
          { task: 'check how the page looks', tool: 'browser_navigate' },
          { task: 'does the page look right?', tool: 'browser_navigate' },
          { task: 'commit and open a PR', tool: 'git_create_pr' },
        ];
        const missing = CASES.filter(c => !kept(c.task, c.tool));
        // The other half of the trade: gating must still TRIM. If a fix to the above simply
        // stopped gating, this probe would pass while the real benefit was gone.
        const lean = P.gateSchemas(all, 'who are you?').length;
        const tooLoose = lean > Math.ceil(all.length * 0.4);
        const detail =
          `${CASES.length - missing.length}/${CASES.length} intent phrasings keep their tool; ` +
          `a bare question keeps ${lean}/${all.length} tools` +
          (missing.length ? `\nmissing: ${missing.map(m => `${m.tool} for "${m.task}"`).join('; ')}` : '') +
          (tooLoose ? '\ngating has stopped trimming — a question should not carry the whole toolset' : '');
        return verdict(
          missing.length === 0 && !tooLoose,
          missing.length
            ? `${missing.length} natural phrasing(s) lose the tool they need: ${missing.slice(0, 2).map(m => m.tool).join(', ')}`
            : 'gating stopped trimming — a bare question now carries most of the toolset',
          detail,
          { intentCasesKept: CASES.length - missing.length, questionToolCount: lean },
        );
      }),

      det('tools.usage-calibration', 'Ceremony tools say when NOT to use them', 'tool-surface', async () => {
        // Process/ceremony tools, where over-use is visible and annoying — not action tools.
        const CEREMONY = ['todo_write', 'present_plan', 'project_log', 'remember'];
        // Phrasings that push toward more use with no bound.
        const UNBOUNDED = [
          /update (this )?(frequently|often|regularly)/i,
          /after every (meaningful )?step/i,
          /\balways use\b/i,
          /use (this|it) for (all|any|every)\b/i,
        ];
        // Phrasings that give the model an exit — a threshold or an explicit exclusion.
        const HAS_EXIT = [
          /\bdon'?t use\b/i, /\bdo not use\b/i, /\bskip (this|it)\b/i, /\bavoid\b[^.]*\bwhen\b/i,
          /\bnot (needed|worth it|for)\b/i, /\bunnecessary\b/i, /\bonly (use|when)\b/i,
          /\b\d+\+?\s*(or more\s*)?(distinct\s*)?steps?\b/i, /\bsingle[- ](file|step)\b/i,
          /\btrivial\b/i,
          // Restraint phrased as a budget rather than a prohibition. `remember` says
          // "Use SPARINGLY … transient task details should stay in conversation", which is a
          // genuine exit criterion — an earlier version of this probe missed it and flagged a
          // description that was already correct. A probe that cries wolf gets ignored, so
          // detection is widened rather than the wording churned to satisfy the checker.
          /\bsparingly\b/i, /\bshould stay\b/i, /\brarely\b/i,
        ];
        const schemas = P.toolSchemas({ mode: 'normal' });
        const problems: string[] = [];
        const checked: string[] = [];
        for (const name of CEREMONY) {
          const s = schemas.find(x => x.function?.name === name);
          if (!s) continue; // not registered in this profile — nothing to judge
          checked.push(name);
          const d = s.function.description ?? '';
          const pushes = UNBOUNDED.some(re => re.test(d));
          const exits = HAS_EXIT.some(re => re.test(d));
          if (!exits) {
            problems.push(
              `${name}: no "when NOT to use" guidance${pushes ? ' AND an unconditional "use it more" imperative' : ''}`,
            );
          }
        }
        const detail =
          `checked ${checked.length} ceremony tool(s): ${checked.join(', ') || '(none registered)'}\n` +
          (problems.length ? problems.join('\n') : 'all carry an explicit non-use criterion');
        return verdict(
          problems.length === 0,
          `${problems.length} ceremony tool(s) lack a non-use criterion, which reads as "use me always": ${problems.slice(0, 2).join('; ')}`,
          detail,
          { ceremonyToolsChecked: checked.length, missingExitCriterion: problems.length },
        );
      }),

      det('tools.schema-validity', 'Every tool has a description and a usable schema', 'tool-surface', async () => {
        const schemas = P.toolSchemas({ mode: 'normal' });
        const problems: string[] = [];
        for (const s of schemas) {
          const n = s.function?.name ?? '(unnamed)';
          if (!s.function?.name || !/^[a-zA-Z0-9_-]{1,64}$/.test(s.function.name)) {
            problems.push(`${n}: invalid tool name`);
          }
          const desc = (s.function?.description ?? '').trim();
          if (!desc) problems.push(`${n}: empty description`);
          const p: any = s.function?.parameters;
          if (!p || typeof p !== 'object') { problems.push(`${n}: missing parameters schema`); continue; }
          if (p.type !== 'object') problems.push(`${n}: parameters.type is ${JSON.stringify(p.type)}, expected "object"`);
          if (!p.properties || typeof p.properties !== 'object' || Array.isArray(p.properties)) {
            problems.push(`${n}: parameters.properties is not an object`);
            continue;
          }
          if (p.required !== undefined) {
            if (!Array.isArray(p.required)) problems.push(`${n}: parameters.required is not an array`);
            else {
              const unknown = p.required.filter((k: unknown) => typeof k !== 'string' || !(k in p.properties));
              if (unknown.length) problems.push(`${n}: required names not in properties: ${unknown.join(', ')}`);
            }
          }
          for (const [k, v] of Object.entries(p.properties as Record<string, any>)) {
            if (!v || typeof v !== 'object') problems.push(`${n}.${k}: property is not a schema object`);
          }
        }
        const detail =
          `${schemas.length} tools inspected; ${problems.length} problem(s)` +
          (problems.length ? `\n${problems.slice(0, 10).join('\n')}` : '');
        return verdict(
          problems.length === 0,
          `${problems.length} tool schema problem(s): ${problems.slice(0, 3).join('; ')}`,
          detail,
          { toolsInspected: schemas.length, schemaProblems: problems.length },
        );
      }),

      // ===================================================================
      // PROMPT
      // ===================================================================

      det('prompt.token-budget', 'Both system-prompt tiers fit their budgets', 'prompt', async ctx => {
        const names = P.registeredToolNames();
        const lines: string[] = [];
        const metrics: Record<string, number> = {};
        const over: string[] = [];
        for (const v of promptVariants(names)) {
          const text = P.buildPrompt(v.ctx);
          const tokens = P.countTokens(text);
          const budget = v.tier === 'compressed' ? B.promptTokensCompressed : B.promptTokensFull;
          metrics[`promptTokens_${v.id.replace(/-/g, '_')}`] = tokens;
          const line = `${v.id} (${v.tier}): ${tokens} tokens / ${text.length} chars vs budget ${budget}` +
            ` (${((tokens / budget) * 100).toFixed(1)}%)`;
          lines.push(line);
          ctx.log(line);
          if (tokens > budget) over.push(`${v.id} ${tokens}>${budget}`);
        }
        metrics.promptBudgetCompressed = B.promptTokensCompressed;
        metrics.promptBudgetFull = B.promptTokensFull;
        return verdict(
          over.length === 0,
          `system prompt over budget: ${over.join(', ')}`,
          lines.join('\n'),
          metrics,
        );
      }),

      det('prompt.no-contradiction', 'Assembled prompt trips no declared contradiction', 'prompt', async () => {
        const names = P.registeredToolNames();
        const hits: string[] = [];
        const lines: string[] = [];
        for (const v of promptVariants(names)) {
          const text = P.buildPrompt(v.ctx);
          for (const pair of CONTRADICTION_PAIRS) {
            const a = pair.a.test(text);
            const b = pair.b.test(text);
            if (a && b) hits.push(`${v.id}/${pair.id}: ${pair.why}`);
          }
          lines.push(`${v.id}: ${CONTRADICTION_PAIRS.length} declared pairs checked`);
        }
        const detail =
          lines.join('\n') +
          `\n${CONTRADICTION_PAIRS.length} pairs x ${promptVariants(names).length} variants; ` +
          `${hits.length} contradiction(s)` +
          (hits.length ? `\n${hits.join('\n')}` : '');
        return verdict(
          hits.length === 0,
          `prompt contradicts itself: ${hits.slice(0, 3).join('; ')}`,
          detail,
          { contradictionPairs: CONTRADICTION_PAIRS.length, contradictionsFound: hits.length },
        );
      }),

      det('prompt.no-phantom-tools', 'Prompt names no unregistered tool', 'prompt', async ctx => {
        // The bug class: the prompt instructs the model to call `edit_file`, which does not
        // exist. The model burns a turn on "Unknown tool". This repo shipped that twice.
        //
        // Net: every snake_case token in the prompt whose FIRST segment matches a real
        // tool's first segment is treated as a claimed tool reference. That catches
        // `edit_file` / `read_files` / `git_pull` while ignoring prose like
        // `package_manager`. A stem that prefixes 2+ real tools (`code_graph`) is a family
        // reference, not a phantom.
        const registered = new Set(P.registeredToolNames());
        const stems = new Set([...registered].map(n => n.split('_')[0]!));
        const familyStems = new Set<string>();
        for (const stem of stems) {
          const members = [...registered].filter(n => n === stem || n.startsWith(stem + '_'));
          if (members.length >= 2) familyStems.add(stem);
        }
        const isFamilyPrefix = (tok: string) =>
          [...registered].filter(n => n.startsWith(tok + '_')).length >= 2;

        const phantoms = new Map<string, string[]>(); // token -> variants that named it
        const unavailableInMode = new Map<string, string[]>();
        const names = P.registeredToolNames();
        for (const v of promptVariants(names)) {
          const text = P.buildPrompt(v.ctx);
          const available = new Set(v.ctx.availableToolNames);
          for (const m of text.matchAll(/[a-z][a-z0-9]*(?:_[a-z0-9]+)+/g)) {
            const tok = m[0]!;
            if (registered.has(tok)) {
              if (!available.has(tok)) {
                const arr = unavailableInMode.get(tok) ?? [];
                if (!arr.includes(v.id)) arr.push(v.id);
                unavailableInMode.set(tok, arr);
              }
              continue;
            }
            if (!familyStems.has(tok.split('_')[0]!)) continue; // not tool-shaped prose
            if (isFamilyPrefix(tok)) continue;                  // a family name, e.g. code_graph
            const arr = phantoms.get(tok) ?? [];
            if (!arr.includes(v.id)) arr.push(v.id);
            phantoms.set(tok, arr);
          }
        }
        for (const [tok, vars] of unavailableInMode) {
          ctx.log(`NOTE: \`${tok}\` is registered but NOT in availableToolNames for ${vars.join(', ')}`);
        }
        const list = [...phantoms.entries()].map(([t, v]) => `${t} (in ${v.join(', ')})`);
        const detail =
          `${registered.size} registered tools; ${list.length} phantom reference(s)` +
          (list.length ? `\n${list.join('\n')}` : '') +
          (unavailableInMode.size
            ? `\nregistered but not offered in that mode (reported, not failed): ` +
              [...unavailableInMode.entries()].map(([t, v]) => `${t}@${v.join('/')}`).join(', ')
            : '');
        return verdict(
          list.length === 0,
          `prompt references unregistered tool(s): ${list.slice(0, 3).join('; ')}`,
          detail,
          { phantomToolRefs: list.length, refsUnavailableInMode: unavailableInMode.size },
        );
      }),

      // ===================================================================
      // CONTEXT / CACHE
      // ===================================================================

      det('cache.prefix-byte-stable', 'Identical inputs assemble byte-identical prefixes', 'cache', async () => {
        // Local KV cache and Anthropic prompt cache both key on the longest byte-stable
        // prefix. A single non-determinism (a Set iteration, a Date, an unsorted map)
        // costs a full re-prefill of the whole conversation every turn.
        const names = P.registeredToolNames();
        const problems: string[] = [];
        for (const v of promptVariants(names)) {
          const a = P.buildPrompt(v.ctx);
          const b = P.buildPrompt(v.ctx);
          if (a !== b) {
            problems.push(`${v.id}: prompt differs between two identical builds at byte ${commonPrefix(a, b)}`);
          }
        }
        const s1 = JSON.stringify(P.toolSchemas({ mode: 'normal' }));
        const s2 = JSON.stringify(P.toolSchemas({ mode: 'normal' }));
        if (s1 !== s2) problems.push(`tool schema list differs between two identical builds at byte ${commonPrefix(s1, s2)}`);

        const detail =
          `${promptVariants(names).length} prompt variants + tool schema list rebuilt twice each; ` +
          `${problems.length} instability(ies)` + (problems.length ? `\n${problems.join('\n')}` : '');
        return verdict(
          problems.length === 0,
          `prompt prefix is not byte-stable: ${problems[0]}`,
          detail,
          { prefixInstabilities: problems.length, toolSchemaBytes: s1.length },
        );
      }),

      det('cache.volatile-sections-last', 'Volatile sections sit after the stable prefix', 'cache', async ctx => {
        // The dir tree changes when files change; the task-class/stack addenda change with
        // EVERY user message. If either sits before the instruction body, one classifier
        // flip re-bills the entire prompt. Measured as: how much of the prompt survives as
        // a shared prefix when only the volatile input changes.
        const names = P.registeredToolNames();
        const base = promptVariants(names)[0]!.ctx;

        const withTree = P.buildPrompt({ ...base, directoryTree: 'src/\n  a.ts\n  b.ts' });
        const withOtherTree = P.buildPrompt({ ...base, directoryTree: 'src/\n  a.ts\n  c.ts\n  d.ts' });
        const treeShared = commonPrefix(withTree, withOtherTree);

        const withRefactor = P.buildPrompt({ ...base, directoryTree: 'src/\n  a.ts\n  b.ts', taskClass: 'refactor' });
        const withDebug = P.buildPrompt({ ...base, directoryTree: 'src/\n  a.ts\n  b.ts', taskClass: 'debug' });
        const addendumShared = commonPrefix(withRefactor, withDebug);

        const treeIdx = withRefactor.indexOf('# Directory Tree');
        const problems: string[] = [];
        if (treeIdx < 0) problems.push('directory tree section not found in the assembled prompt');
        // The tree must come after the instruction body...
        const envIdx = withRefactor.indexOf('# Environment');
        if (treeIdx >= 0 && envIdx >= 0 && treeIdx < envIdx) {
          problems.push(`directory tree (byte ${treeIdx}) precedes # Environment (byte ${envIdx})`);
        }
        // ...and the per-message addenda must come after the tree.
        if (treeIdx >= 0 && addendumShared < treeIdx) {
          problems.push(
            `task-class addendum diverges at byte ${addendumShared}, BEFORE the directory tree at ${treeIdx} — ` +
            `a classifier flip re-bills the tree`);
        }
        // Changing only the tree must preserve everything before it.
        if (treeIdx >= 0 && treeShared < treeIdx) {
          problems.push(`a directory-tree change diverges at byte ${treeShared}, before the tree section at ${treeIdx}`);
        }
        const ratio = withRefactor.length ? addendumShared / withRefactor.length : 0;
        ctx.log(`tree@${treeIdx}, tree-change shared prefix ${treeShared}, addendum-change shared prefix ${addendumShared}`);
        const detail =
          `directory tree section at byte ${treeIdx} of ${withRefactor.length}; ` +
          `changing ONLY the tree keeps ${treeShared} bytes of shared prefix; ` +
          `changing ONLY the task class keeps ${addendumShared} bytes ` +
          `(${(ratio * 100).toFixed(1)}% of the prompt)` +
          (problems.length ? `\n${problems.join('\n')}` : '');
        return verdict(
          problems.length === 0,
          `volatile prompt sections are not at the tail: ${problems[0]}`,
          detail,
          {
            treeSectionOffset: treeIdx,
            sharedPrefixOnTreeChange: treeShared,
            sharedPrefixOnTaskClassChange: addendumShared,
            sharedPrefixRatio: Number(ratio.toFixed(4)),
          },
        );
      }),

      det('cache.breakpoint-layout', 'Cache breakpoints follow the declared layout', 'cache', async () => {
        // Anthropic: at most 4 `cache_control` markers, longest-prefix-wins. The layout is
        // (1) last tool -> caches the immutable tools block, (2) system core -> cached,
        // with the volatile tail deliberately UNCACHED, (3) last message -> rolling
        // conversation prefix.
        const core = 'STABLE CORE INSTRUCTIONS. ';
        const volatileTail = 'VOLATILE PER-TURN INJECTIONS.';
        const systemText = core + volatileTail;
        const tools = [
          { name: 'read_file', description: 'r' },
          { name: 'shell', description: 's' },
        ];
        const messages = [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'second' },
        ];
        const out = P.cacheBreakpoints(systemText, messages, tools, core.length);
        const problems: string[] = [];

        const sys: any = out.system;
        if (!Array.isArray(sys) || sys.length !== 2) {
          problems.push(`system should split into 2 blocks at the boundary, got ${Array.isArray(sys) ? sys.length : typeof sys}`);
        } else {
          if (sys[0]?.text !== core) problems.push('system block 0 is not the stable core');
          if (!sys[0]?.cache_control) problems.push('the stable system core carries no cache breakpoint');
          if (sys[1]?.cache_control) problems.push('the VOLATILE system tail is cached — it changes every turn');
        }

        const outTools: any[] = (out.tools as any[]) ?? [];
        const markedTools = outTools.filter(t => t?.cache_control);
        if (markedTools.length !== 1) problems.push(`expected exactly 1 cached tool, got ${markedTools.length}`);
        else if (markedTools[0] !== outTools[outTools.length - 1]) problems.push('the cached tool is not the LAST tool');

        const outMsgs: any[] = (out.messages as any[]) ?? [];
        const lastMsg = outMsgs[outMsgs.length - 1];
        const lastBlocks = Array.isArray(lastMsg?.content) ? lastMsg.content : [];
        if (!lastBlocks.length || !lastBlocks[lastBlocks.length - 1]?.cache_control) {
          problems.push('the last message carries no rolling cache breakpoint');
        }
        if (outMsgs.slice(0, -1).some(m => countCacheControls(m) > 0)) {
          problems.push('a non-final message carries a cache breakpoint (wastes one of the 4 slots)');
        }

        const total = countCacheControls(out.system) + countCacheControls(out.tools) + countCacheControls(out.messages);
        if (total > B.maxCacheBreakpoints) {
          problems.push(`${total} cache breakpoints exceeds the API maximum of ${B.maxCacheBreakpoints}`);
        }

        // No boundary -> the whole system is one cached block (still valid, just coarser).
        const noBoundary: any = P.cacheBreakpoints(systemText, messages, tools).system;
        if (!Array.isArray(noBoundary) || noBoundary.length !== 1 || !noBoundary[0]?.cache_control) {
          problems.push('without a boundary the system should be a single cached block');
        }

        const detail =
          `breakpoints: system=${countCacheControls(out.system)}, tools=${countCacheControls(out.tools)}, ` +
          `messages=${countCacheControls(out.messages)}, total=${total} vs max ${B.maxCacheBreakpoints}` +
          (problems.length ? `\n${problems.join('\n')}` : '');
        return verdict(
          problems.length === 0,
          `cache breakpoint layout violated: ${problems[0]}`,
          detail,
          { cacheBreakpoints: total, cacheBreakpointBudget: B.maxCacheBreakpoints, layoutProblems: problems.length },
        );
      }),

      // ===================================================================
      // HISTORY INVARIANTS
      // ===================================================================

      det('history.tool-call-pairing', 'No layer orphans a tool_call', 'history', async ctx => {
        // THE bug class fixed in bd62ab4: an assistant message carrying tool_calls followed
        // by a message that is not its tool results. Anthropic tolerates it; every
        // OpenAI-format provider 400s with "tool_call_ids did not have response messages".
        // Each context-shrinking layer is a chance to reintroduce it, so each is measured.
        // Multi-turn on purpose: compaction and pruning group by user message, so a
        // single-goal history would make those stages no-ops and the check vacuous.
        const raw = multiTurnHistory(6);
        const stages: Array<{ name: string; messages: Message[] }> = [{ name: 'raw', messages: raw }];

        // 1. spill — oversized results are replaced at the choke point, in place.
        const spilled: Message[] = [];
        for (const m of raw) {
          if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > 5_000) {
            spilled.push({ ...m, content: await P.spillResult(m.name ?? 'tool', m.content, 5_000) });
          } else spilled.push(m);
        }
        stages.push({ name: 'spill', messages: spilled });

        // 2. aging, 3. dedup — both must only ever rewrite content.
        const aged = P.ageHistory(spilled);
        stages.push({ name: 'aging', messages: aged });
        const { messages: deduped } = P.dedupHistory(aged);
        stages.push({ name: 'dedup', messages: deduped });

        // 4. compaction — model-free: the summarizer is a stub.
        const compacted = await P.compact(deduped, async () => STUB_SUMMARY);
        stages.push({ name: 'compaction', messages: compacted.messages });

        // 5. prune — the REAL AgentLoop pruner, squeezed hard enough to drop units.
        const prune = await P.loadPrune();
        if (!prune) {
          return {
            status: 'skip',
            reason: 'could not load AgentLoop.pruneMessages — the prune stage was NOT measured',
            detail: stages.map(s => `${s.name}: ${s.messages.length} messages`).join('\n'),
            metrics: { stagesMeasured: stages.length },
          };
        }
        stages.push({ name: 'prune', messages: prune(compacted.messages, 400) });
        // Squeeze the untouched history too — compaction may have already shrunk it below
        // the budget, which would make the prune stage a no-op and the check vacuous.
        stages.push({ name: 'prune-raw', messages: prune(raw, 400) });
        // ...and the SINGLE-GOAL shape, which is the only one that exercises the pruner's
        // phase-2 unit dropping (phase 1 can't split a one-user-message autonomous run).
        stages.push({ name: 'prune-autonomous', messages: prune(syntheticHistory(10), 400) });

        // 6. provider-side repair — the permanent safety net.
        const last = stages[stages.length - 1]!.messages;
        stages.push({ name: 'orphan-repair', messages: P.repairOrphans(last) });

        const problems: string[] = [];
        const lines: string[] = [];
        for (const st of stages) {
          const rep = checkPairing(st.messages);
          lines.push(
            `${st.name}: ${st.messages.length} msgs, ` +
            `${rep.orphanedCalls.length} orphaned tool_call(s), ${rep.orphanedResults.length} orphaned result(s)`);
          ctx.log(lines[lines.length - 1]!);
          if (rep.orphanedCalls.length) problems.push(`${st.name} orphaned tool_calls: ${rep.orphanedCalls.join(', ')}`);
          if (rep.orphanedResults.length) problems.push(`${st.name} orphaned tool results: ${rep.orphanedResults.join(', ')}`);
        }
        // Vacuity guards: a stage that changed nothing is not evidence that the stage is
        // safe. "It passed because it did nothing" is exactly the dishonest pass this
        // subsystem exists to prevent.
        if (compacted.turnsCompacted === 0) problems.push('compaction folded 0 turns — that stage proved nothing');
        for (const name of ['prune', 'prune-raw', 'prune-autonomous']) {
          const st = stages.find(s => s.name === name)!;
          if (st.messages.length >= raw.length) problems.push(`${name} dropped nothing — that stage proved nothing`);
        }
        return verdict(
          problems.length === 0,
          `history layer orphaned a tool_call: ${problems[0]}`,
          lines.join('\n') +
            `\ncompaction folded ${compacted.turnsCompacted} turn-group(s)` +
            (problems.length ? `\n${problems.join('\n')}` : ''),
          { stagesMeasured: stages.length, orphanProblems: problems.length, turnsCompacted: compacted.turnsCompacted },
        );
      }),

      det('history.orphan-repair', 'The provider-side orphan repair works both ways', 'history', async () => {
        // Exactly the bd62ab4 shape: a loop detector pushed a system message and continued
        // WITHOUT executing the pending tool_calls.
        const broken: Message[] = [
          { role: 'system', content: 'sys' } as Message,
          { role: 'user', content: GOAL_TEXT } as Message,
          toolCallMsg('orphan_a', 'read_file', { path: 'a.ts' }),
          { role: 'system', content: '[LOOP DETECTED] stop repeating that read.' } as Message,
          { role: 'user', content: 'continue' } as Message,
        ];
        const repaired = P.repairOrphans(broken);
        const repRep = checkPairing(repaired);

        const healthy: Message[] = [
          { role: 'system', content: 'sys' } as Message,
          { role: 'user', content: GOAL_TEXT } as Message,
          toolCallMsg('ok_a', 'read_file', { path: 'a.ts' }),
          toolResultMsg('ok_a', 'read_file', 'body'),
          { role: 'assistant', content: 'done' } as Message,
        ];
        const untouched = P.repairOrphans(healthy);

        const problems: string[] = [];
        if (checkPairing(broken).orphanedCalls.length === 0) {
          problems.push('the crafted "broken" history is not actually orphaned — the check is vacuous');
        }
        if (repRep.orphanedCalls.length) problems.push(`repair left ${repRep.orphanedCalls.length} orphaned tool_call(s)`);
        if (repaired.length !== broken.length + 1) {
          problems.push(`repair should insert exactly 1 synthetic result, message count went ${broken.length} -> ${repaired.length}`);
        }
        if (JSON.stringify(untouched) !== JSON.stringify(healthy)) {
          problems.push('repair MUTATED a healthy history — it must be a no-op when nothing is orphaned');
        }
        const detail =
          `broken: ${broken.length} msgs, ${checkPairing(broken).orphanedCalls.length} orphan(s) -> ` +
          `repaired ${repaired.length} msgs, ${repRep.orphanedCalls.length} orphan(s); ` +
          `healthy history ${JSON.stringify(untouched) === JSON.stringify(healthy) ? 'untouched' : 'MUTATED'}` +
          (problems.length ? `\n${problems.join('\n')}` : '');
        return verdict(
          problems.length === 0,
          `orphan repair is broken: ${problems[0]}`,
          detail,
          { repairInserted: repaired.length - broken.length, repairProblems: problems.length },
        );
      }),

      det('history.compaction-preserves-goal', 'Compaction never loses the original goal', 'history', async () => {
        // The failure this guards: after compaction the agent forgets what it was asked to
        // do and restarts, re-reading the same files. Deterministic, model-free version of
        // the property: the goal text must reach the summarizer VERBATIM, the summary must
        // survive into the output, and the kept tail must be byte-identical.
        const raw = multiTurnHistory(5);
        let summarizerSaw = '';
        const compacted = await P.compact(raw, async msgs => {
          summarizerSaw = msgs.map(m => (typeof m.content === 'string' ? m.content : '')).join('\n');
          return STUB_SUMMARY;
        });

        const problems: string[] = [];
        if (compacted.turnsCompacted === 0) {
          problems.push('nothing was compacted — the check would be vacuous');
        }
        if (!summarizerSaw.includes(GOAL_TEXT)) {
          problems.push('the user\'s original goal text was NOT shown to the summarizer — it can only be lost');
        }
        const out = compacted.messages;
        const goalSurvives =
          out.some(m => typeof m.content === 'string' && m.content.includes(GOAL_TEXT)) ||
          summarizerSaw.includes(GOAL_TEXT);
        if (!goalSurvives) problems.push('the goal survives neither verbatim nor via the summary input');
        if (!out.some(m => typeof m.content === 'string' && m.content.includes('[CTX_SUMMARY]'))) {
          problems.push('the summary was not injected into the compacted history');
        }
        if (!out.some(m => m.role === 'system' && m.content === 'SYSTEM PROMPT (stable prefix)')) {
          problems.push('the original system prompt did not survive compaction');
        }
        // The tail must be preserved verbatim — a compacted tail is a silent context loss.
        const tail = out.slice(-4);
        const rawTail = raw.slice(-4);
        if (JSON.stringify(tail) !== JSON.stringify(rawTail)) {
          problems.push('the most recent turns were not preserved verbatim');
        }
        const detail =
          `${raw.length} -> ${out.length} messages, ${compacted.turnsCompacted} turn-group(s) folded; ` +
          `goal text ${summarizerSaw.includes(GOAL_TEXT) ? 'reached' : 'did NOT reach'} the summarizer ` +
          `(${summarizerSaw.length} chars of transcript); recent tail preserved verbatim: ` +
          `${JSON.stringify(tail) === JSON.stringify(rawTail)}` +
          (problems.length ? `\n${problems.join('\n')}` : '');
        return verdict(
          problems.length === 0,
          `compaction lost the goal: ${problems[0]}`,
          detail,
          {
            messagesBefore: raw.length,
            messagesAfter: out.length,
            turnsCompacted: compacted.turnsCompacted,
            summarizerInputChars: summarizerSaw.length,
          },
        );
      }),

      det('history.dedup-rewrites-only', 'Dedup and aging rewrite content, never structure', 'history', async () => {
        // Both layers claim to be structure-preserving. If either ever drops or reorders a
        // message, tool pairing breaks somewhere far downstream and the provider 400s.
        const raw = syntheticHistory(12);
        const { messages: deduped, replaced } = P.dedupHistory(raw);
        const aged = P.ageHistory(raw);

        const problems: string[] = [];
        const shape = (ms: Message[]) =>
          ms.map(m => `${m.role}|${m.tool_call_id ?? ''}|${m.name ?? ''}|${(m.tool_calls ?? []).map(t => t.id).join('+')}`);

        if (deduped.length !== raw.length) problems.push(`dedup changed message count ${raw.length} -> ${deduped.length}`);
        if (JSON.stringify(shape(deduped)) !== JSON.stringify(shape(raw))) {
          problems.push('dedup altered message roles / tool ids');
        }
        if (replaced === 0) problems.push('dedup replaced nothing on a history with repeated identical reads — the check is vacuous');

        if (aged.length !== raw.length) problems.push(`aging changed message count ${raw.length} -> ${aged.length}`);
        if (JSON.stringify(shape(aged)) !== JSON.stringify(shape(raw))) {
          problems.push('aging altered message roles / tool ids');
        }

        const rawBytes = raw.reduce((n, m) => n + (m.content?.length ?? 0), 0);
        const dedupBytes = deduped.reduce((n, m) => n + (m.content?.length ?? 0), 0);
        const agedBytes = aged.reduce((n, m) => n + (m.content?.length ?? 0), 0);
        if (dedupBytes > rawBytes) problems.push('dedup GREW the history');
        if (agedBytes > rawBytes) problems.push('aging GREW the history');
        // Non-tool messages must be untouched by both layers.
        for (let i = 0; i < raw.length; i++) {
          if (raw[i]!.role === 'tool') continue;
          if (deduped[i]!.content !== raw[i]!.content) problems.push(`dedup rewrote a ${raw[i]!.role} message at index ${i}`);
          if (aged[i]!.content !== raw[i]!.content) problems.push(`aging rewrote a ${raw[i]!.role} message at index ${i}`);
        }

        const detail =
          `${raw.length} messages, ${rawBytes}B: dedup replaced ${replaced} result(s) -> ${dedupBytes}B ` +
          `(${(((rawBytes - dedupBytes) / rawBytes) * 100).toFixed(1)}% saved); ` +
          `aging -> ${agedBytes}B (${(((rawBytes - agedBytes) / rawBytes) * 100).toFixed(1)}% saved)` +
          (problems.length ? `\n${problems.join('\n')}` : '');
        return verdict(
          problems.length === 0,
          `a context-shrinking layer changed history structure: ${problems[0]}`,
          detail,
          {
            historyBytes: rawBytes,
            dedupBytes, agedBytes,
            dedupReplaced: replaced,
            structureProblems: problems.length,
          },
        );
      }),

      // ===================================================================
      // RECOVERY
      // ===================================================================

      det('recovery.stuck-loop-detector', 'Stuck-loop detector fires on loops and only on loops', 'recovery', async () => {
        // BOTH directions matter. A detector that always fires kills healthy runs; one that
        // never fires lets a model burn its whole iteration budget re-reading one file.
        const call = (n: string, a: string) => ({ name: n, argsHash: a });
        const shouldFire: Array<[string, Array<{ name: string; argsHash: string }>]> = [
          ['period-1 (same call 3x)', [call('read_file', 'a'), call('read_file', 'a'), call('read_file', 'a')]],
          ['period-2 cycle', [call('read_file', 'a'), call('grep', 'b'), call('read_file', 'a'), call('grep', 'b')]],
          ['period-3 cycle', [
            call('read_file', 'a'), call('read_file', 'b'), call('read_file', 'c'),
            call('read_file', 'a'), call('read_file', 'b'), call('read_file', 'c')]],
        ];
        const shouldNotFire: Array<[string, Array<{ name: string; argsHash: string }>]> = [
          ['empty', []],
          ['two calls', [call('read_file', 'a'), call('read_file', 'a')]],
          ['healthy varied progress', [
            call('read_file', 'a'), call('grep', 'b'), call('edit_text', 'c'),
            call('shell', 'd'), call('read_file', 'e'), call('shell', 'f')]],
          ['same tool, different args', [
            call('read_file', 'a'), call('read_file', 'b'), call('read_file', 'c'), call('read_file', 'd')]],
        ];
        const problems: string[] = [];
        let fired = 0;
        for (const [label, hist] of shouldFire) {
          if (P.detectStuckLoop(hist)) fired++;
          else problems.push(`FALSE NEGATIVE: no detection on ${label}`);
        }
        let quiet = 0;
        for (const [label, hist] of shouldNotFire) {
          if (!P.detectStuckLoop(hist)) quiet++;
          else problems.push(`FALSE POSITIVE: fired on ${label}`);
        }
        const detail =
          `positives ${fired}/${shouldFire.length} detected, negatives ${quiet}/${shouldNotFire.length} left alone` +
          (problems.length ? `\n${problems.join('\n')}` : '');
        return verdict(
          problems.length === 0,
          `stuck-loop detector misbehaved: ${problems[0]}`,
          detail,
          {
            stuckTruePositives: fired, stuckPositiveCases: shouldFire.length,
            stuckTrueNegatives: quiet, stuckNegativeCases: shouldNotFire.length,
          },
        );
      }),

      det('recovery.error-loop-detector', 'Error-loop detector fires at threshold, not before', 'recovery', async () => {
        const e = (name: string, code: string) => ({ name, code });
        const problems: string[] = [];

        const guessing = [e('read_file', 'FILE_NOT_FOUND'), e('read_file', 'FILE_NOT_FOUND'), e('read_file', 'FILE_NOT_FOUND')];
        const hit = P.detectErrorLoop(guessing);
        if (!hit) problems.push('FALSE NEGATIVE: 3 identical (tool, code) errors did not trip the default threshold');
        else if (hit.name !== 'read_file' || hit.code !== 'FILE_NOT_FOUND' || hit.count < 3) {
          problems.push(`detection reported the wrong offender: ${JSON.stringify(hit)}`);
        }

        if (P.detectErrorLoop(guessing.slice(0, 2))) problems.push('FALSE POSITIVE: fired below the threshold (2 errors)');
        if (P.detectErrorLoop([])) problems.push('FALSE POSITIVE: fired on an empty error window');
        const varied = [e('read_file', 'FILE_NOT_FOUND'), e('shell', 'TOOL_ERROR'), e('grep', 'PERMISSION_DENIED')];
        if (P.detectErrorLoop(varied)) problems.push('FALSE POSITIVE: fired on three DIFFERENT (tool, code) failures');
        if (!P.detectErrorLoop(varied.concat(varied), 2)) {
          problems.push('FALSE NEGATIVE: an explicit threshold of 2 did not trip on repeated pairs');
        }

        // Soft failures — exit-0 output that achieved nothing. Missing these was the
        // 90-minute pnpm/vite thrash: every probe "succeeded", so the loop never tripped.
        const futile = ['sh: vite: command not found', 'ls: no such file or directory', 'Unknown tool: edit_file'];
        const healthy = ['ok', 'wrote 42 bytes', 'Test Files 3 passed (3)'];
        for (const c of futile) if (!P.looksFutile(c)) problems.push(`FALSE NEGATIVE: soft failure not recognised: ${c}`);
        for (const c of healthy) if (P.looksFutile(c)) problems.push(`FALSE POSITIVE: healthy output flagged futile: ${c}`);
        if (P.errorCodeOf('[FILE_NOT_FOUND] nope') !== 'FILE_NOT_FOUND') problems.push('errorCodeOf failed to parse a bracketed code');
        if (P.errorCodeOf('something broke') !== 'ERROR') problems.push('errorCodeOf failed to default an unclassified error');

        const detail =
          `threshold-3 detection ${hit ? `fired on ${hit.name}/${hit.code} x${hit.count}` : 'DID NOT FIRE'}; ` +
          `${futile.length} soft failures + ${healthy.length} healthy outputs classified; ` +
          `${problems.length} problem(s)` + (problems.length ? `\n${problems.join('\n')}` : '');
        return verdict(
          problems.length === 0,
          `error-loop detection misbehaved: ${problems[0]}`,
          detail,
          { errorLoopProblems: problems.length, errorLoopCount: hit?.count ?? 0 },
        );
      }),

      det('recovery.read-loop-ladder', 'Read-loop escalation ladder is monotonic', 'recovery', async () => {
        // none -> summarize (3rd identical read) -> abort (5th). The ladder must never
        // regress: a threshold nudged the wrong way either aborts healthy runs or lets a
        // re-read loop burn the whole budget.
        const expected: Array<[number, 'none' | 'summarize' | 'abort']> = [
          [0, 'none'], [1, 'none'], [2, 'none'],
          [3, 'summarize'], [4, 'summarize'],
          [5, 'abort'], [9, 'abort'],
        ];
        const problems: string[] = [];
        const seen: string[] = [];
        for (const [n, want] of expected) {
          const got = P.readLoopAction(n);
          seen.push(`${n}->${got}`);
          if (got !== want) problems.push(`readLoopAction(${n}) = ${got}, expected ${want}`);
        }
        const rank = { none: 0, summarize: 1, abort: 2 } as const;
        for (let n = 1; n <= 10; n++) {
          if (rank[P.readLoopAction(n)] < rank[P.readLoopAction(n - 1)]) {
            problems.push(`escalation regressed between ${n - 1} and ${n}`);
          }
        }
        const detail = `ladder: ${seen.join(', ')}; monotonic over 0..10` +
          (problems.length ? `\n${problems.join('\n')}` : '');
        return verdict(
          problems.length === 0,
          `read-loop ladder wrong: ${problems[0]}`,
          detail,
          { ladderProblems: problems.length, ladderPoints: expected.length },
        );
      }),
    ],
  };
}

/** The suite bound to the real harness. Tasks are lazy — nothing runs at import time. */
export const harnessSuite: EvalSuite = createHarnessSuite();
