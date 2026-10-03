/**
 * `task` tool — sub-agent dispatcher.
 *
 * The model uses this tool to delegate a focused unit of work to a sub-agent. The
 * sub-agent runs on a FRESH AgentLoop (no shared mutable state with the parent) with:
 *
 *   - Its own conversation history (clean context, just system + the task prompt).
 *   - A bounded tool set: subagent mode excludes `task` (no recursion) and `present_plan`;
 *     built-in roles narrow it further (vision, scout, browser, computer).
 *   - Its own iteration budget (smaller than parent) and its own session row.
 *   - The parent's approval path: the calling tool's askUser is handed down, so a
 *     permission prompt inside the sub-agent reaches the same human (or remote channel).
 *
 * Modes:
 *   - sequential: sub-agents run one at a time. Same wall clock as inline, but parent
 *                 context stays clean — for batch tasks this is the win.
 *   - parallel:   future. For now also sequential (router falls back when local).
 *
 * Failure mode: sub-agent error or budget exhaustion returns a clear marker; parent
 * sees it and can adapt. We never re-throw from a sub-agent into the parent loop.
 */

import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { logger } from '../../utils/logger.js';

/** Per-run budget override for a sub-agent (0 = unlimited for that dimension). */
export interface SubAgentBudgetOverride {
  maxWallSeconds?: number;
  maxTokens?: number;
  maxCostUsd?: number;
}

/** Options every SubAgentRunner accepts. Only maxIterations + sessionId are required. */
export interface SubAgentRunOptions {
  /** Iteration cap for the sub-agent run (0 = unlimited). */
  maxIterations: number;
  signal?: AbortSignal;
  /** Session id for the sub-agent's transcript (a row is created if missing). */
  sessionId: string;
  modelOverride?: string;
  /** Role name — drives which provider/model + system prompt + allowed tools. */
  role?: string;
  /** Approval asker for the sub-agent's permission prompts. Pass the calling tool's
   *  `ctx.askUser`; when omitted the runner falls back to the parent run's asker. */
  askUser?: (prompt: string, options?: string[]) => Promise<string>;
  /** Wall/token/cost caps for this run (browser/computer roles have sensible defaults). */
  budgetOverride?: SubAgentBudgetOverride;
  /**
   * Operator-owned runs (`/background`) use the full tool surface minus
   * recursion. Model-owned `task` stays on 'subagent'.
   */
  executionMode?: 'subagent' | 'normal';
  /** Live tool UI events (progress, diffs) of the sub-agent, for side-run docks. */
  onToolUI?: (event: import('../base.js').ToolUIEvent) => void;
}

export interface SubAgentResult {
  finalText: string;
  toolCallsRun: number;
  ok: boolean;
  error?: string;
  modelUsed?: string;
}

const TaskArgs = z.object({
  description: z.string().min(1).describe('Short title for this sub-task (one line, used for logs and UI).'),
  prompt: z.string().min(1).describe('The full prompt for the sub-agent. Be specific — it has NO prior context from this conversation.'),
  expected_files: z.array(z.string()).describe('Optional list of files the sub-agent is expected to touch. Used as a soft hint.').optional(),
  max_iterations: z.number().int().min(1).max(60).describe('Cap on tool-call rounds for this sub-agent. Default 8 (25 for the browser/computer roles).').optional(),
  /**
   * Per-call model override. Useful for routing: "this task is simple, use haiku" or
   * "this task is hard, use sonnet". Without it, sub-agent uses whatever role config
   * matches (or roles.subagent default, or parent model).
   */
  model: z.string().describe('Optional model id to use for THIS sub-agent only. Examples: "qwen2.5-coder:7b", "claude-haiku-4-5", "gpt-4o-mini". Omit to use the configured sub-agent model.').optional(),
  /**
   * Named role for this sub-agent. The role selects which provider/model + system
   * prompt + tool restrictions are used. Built-in roles:
   *   - "subagent"   (default) — general-purpose; uses roles.subagent or parent
   *   - "vision"     — screenshot / image analysis; vision_analyze + read-only browser tools
   *   - "browser"    — operates QodeX's dedicated browser (snapshot → act by ref → verify)
   *   - "computer"   — operates the desktop via computer_use_* (screenshot → locate → act)
   * Custom roles defined in config.roles.<name> are also valid.
   */
  role: z.string().describe('Role for this sub-agent. Built-in: "subagent" (default), "vision" (image analysis), "browser" (drives your dedicated browser on a web goal), "computer" (drives the desktop apps). Custom roles from config.roles.* also accepted.').optional(),
});

/**
 * The report of a browser/desktop operator sub-agent is built from page/window text — it
 * is untrusted DATA for the parent, exactly like browser_agent's report: scan it for
 * prompt injection and fence it (Sentinel's own afterTool, so sentinel.enabled /
 * injectionDefense and the audit/bus reporting apply). Our status line stays outside the
 * fence. Best-effort: returns the text unchanged if Sentinel can't be loaded.
 */
async function fenceOperatorReport(text: string, role: string): Promise<string> {
  if (!text) return text;
  try {
    const { getSentinel } = await import('../../sentinel/index.js');
    const r = getSentinel().afterTool(`task:${role}`, { role }, { content: text }, { untrustedOutput: true });
    return typeof r?.content === 'string' ? r.content : text;
  } catch {
    return text;
  }
}

/** Default iteration caps: operator roles need more rounds (observe → act → verify). */
const DEFAULT_MAX_ITERATIONS = 8;
const OPERATOR_ROLE_MAX_ITERATIONS = 25;

/**
 * The dispatcher is a SINGLETON. We need a factory to inject the parent AgentLoop's
 * dependencies without making `task` aware of them directly. The host (TUI, headless,
 * mission worker) sets it via setSubAgentRunner() during bootstrap:
 *   setSubAgentRunner((prompt, opts) => agent.runSubagent(prompt, opts))
 */
export type SubAgentRunner = (prompt: string, opts: SubAgentRunOptions) => Promise<SubAgentResult>;
/** Alias kept for callers written against the operator-plane name. */
export type SubAgentOpts = SubAgentRunOptions;

let subAgentRunner: SubAgentRunner | null = null;
export function setSubAgentRunner(runner: SubAgentRunner | null): void {
  subAgentRunner = runner;
}
/** Returns the currently registered sub-agent runner, or null if not enabled. */
export function getSubAgentRunner(): SubAgentRunner | null {
  return subAgentRunner;
}

export class TaskTool extends Tool<z.infer<typeof TaskArgs>> {
  name = 'task';
  description =
    'Delegate a focused unit of work to an isolated sub-agent. ' +
    'The sub-agent has NO context from this conversation — pass a complete, self-contained prompt. ' +
    'Use for: refactoring across many files, running parallel investigations, anything that would otherwise bloat the main context with intermediate steps. ' +
    'Roles: "browser" runs a web goal on your dedicated browser (log in, fill forms, compare prices, collect data across pages) and reports the result with evidence; ' +
    '"computer" runs a goal on the desktop apps (computer_use_*); "vision" analyzes screenshots/images. ' +
    'Returns the sub-agent\'s final summary. Not available within a sub-agent (no recursion).';
  isReadOnly = false;
  isDestructive = true; // sub-agent may itself run destructive tools — surface this clearly
  /** Sub-agents carry their own wall-clock budget (browser/computer roles: 30 min); don't
   *  kill such a run at the global 300s tool timeout. 40 min (max(global, 2400s)) leaves
   *  the sub-agent's own budget room to stop it gracefully with a partial summary first,
   *  while still bounding a sub-agent whose model stream hangs. */
  timeoutSeconds = 2400;
  argsSchema = TaskArgs;

  async execute(args: z.infer<typeof TaskArgs>, ctx: ToolContext): Promise<ToolResult> {
    if (!subAgentRunner) {
      return {
        content: '[SUBAGENT_DISABLED] Sub-agents are not enabled in this QodeX configuration. ' +
          'Run `qx setup` and select sequential or parallel sub-agent mode, or set ' +
          'subagents.mode: sequential in ~/.qodex/config.yaml.',
        isError: true,
      };
    }

    const role = args.role; // undefined => default 'subagent' behavior; the runner resolves it
    const operatorRole = role === 'browser' || role === 'computer';
    const maxIterations = args.max_iterations ?? (operatorRole ? OPERATOR_ROLE_MAX_ITERATIONS : DEFAULT_MAX_ITERATIONS);
    logger.info('Dispatching sub-agent', {
      description: args.description,
      maxIterations,
      promptChars: args.prompt.length,
      modelOverride: args.model ?? '(default)',
      role: role ?? '(subagent)',
    });

    const subSessionId = `${ctx.sessionId}/sub-${Date.now()}`;
    ctx.emit({ type: 'progress', message: `Sub-agent dispatched: ${args.description}${role ? ` [role: ${role}]` : ''}${args.model ? ` (model: ${args.model})` : ''}` });

    const start = Date.now();
    const result = await subAgentRunner(args.prompt, {
      maxIterations,
      signal: ctx.signal,
      sessionId: subSessionId,
      modelOverride: args.model,
      role,
      askUser: typeof ctx.askUser === 'function' ? ctx.askUser : undefined,
    });
    const elapsedSec = Math.round((Date.now() - start) / 1000);
    const report = operatorRole ? await fenceOperatorReport(result.finalText, role!) : result.finalText;

    if (!result.ok) {
      return {
        content:
          `[SUBAGENT_FAILED] Sub-agent "${args.description}" failed after ${result.toolCallsRun} tool call(s) in ${elapsedSec}s.\n` +
          `Model: ${result.modelUsed ?? 'unknown'}\n` +
          `Error: ${result.error ?? 'unknown'}\n` +
          `Partial output:\n${report || '(none)'}`,
        isError: true,
        metadata: { subSessionId, toolCallsRun: result.toolCallsRun, elapsedSec, modelUsed: result.modelUsed },
      };
    }

    return {
      content:
        `[SUBAGENT_DONE] "${args.description}" — completed in ${result.toolCallsRun} tool call(s), ${elapsedSec}s` +
        `${result.modelUsed ? ` (model: ${result.modelUsed})` : ''}\n\n` +
        `--- Sub-agent summary ---\n${report}`,
      metadata: { subSessionId, toolCallsRun: result.toolCallsRun, elapsedSec, ok: true, modelUsed: result.modelUsed },
    };
  }
}
