/**
 * `task` tool — sub-agent dispatcher.
 *
 * The model uses this tool to delegate a focused unit of work to a sub-agent. The
 * sub-agent runs an entirely separate AgentLoop with:
 *
 *   - Its own conversation history (clean context, just system + the task prompt).
 *   - A bounded tool set: subagent mode excludes `task` (no recursion) and `present_plan`.
 *   - Its own iteration budget (smaller than parent).
 *   - Its own permission-decision scope: it inherits parent's PermissionEngine, so user
 *     auto-allow rules transfer; it CAN'T grant new always-allow on parent's behalf.
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
import type { AgentLoop } from '../../agent/loop.js';
import type { Message } from '../../session/store.js';

const TaskArgs = z.object({
  description: z.string().min(1).describe('Short title for this sub-task (one line, used for logs and UI).'),
  prompt: z.string().min(1).describe('The full prompt for the sub-agent. Be specific — it has NO prior context from this conversation.'),
  expected_files: z.array(z.string()).optional().describe('Optional list of files the sub-agent is expected to touch. Used as a soft hint.'),
  max_iterations: z.number().int().min(1).max(20).optional().describe('Cap on tool-call rounds for this sub-agent. Default 8.'),
  /**
   * Per-call model override. Useful for routing: "this task is simple, use haiku" or
   * "this task is hard, use sonnet". Without it, sub-agent uses whatever role config
   * matches (or roles.subagent default, or parent model).
   */
  model: z.string().optional().describe('Optional model id to use for THIS sub-agent only. Examples: "qwen2.5-coder:7b", "claude-haiku-4-5", "gpt-4o-mini". Omit to use the configured sub-agent model.'),
  /**
   * Named role for this sub-agent. The role selects which provider/model + system
   * prompt + tool restrictions are used. Built-in roles:
   *   - "subagent"   (default) — general-purpose; uses roles.subagent or parent
   *   - "vision"     — for screenshot / image analysis tasks; requires a vision-capable
   *                    model in roles.vision; allowed tools restricted to vision_analyze
   *                    + read-only browser tools
   * Custom roles defined in config.roles.<name> are also valid.
   */
  role: z.string().optional().describe('Role for this sub-agent. Built-in: "subagent" (default), "vision". Custom roles from config.roles.* also accepted.'),
});

/**
 * The dispatcher is a SINGLETON. We need a factory to inject the parent AgentLoop's
 * dependencies without making `task` aware of them directly. The agent loop sets this
 * via setSubAgentFactory() during bootstrap.
 */
type SubAgentRunner = (
  prompt: string,
  opts: {
    maxIterations: number;
    signal?: AbortSignal;
    sessionId: string;
    modelOverride?: string;
    /** Role name — drives which provider/model + system prompt + allowed tools. */
    role?: string;
  },
) => Promise<{ finalText: string; toolCallsRun: number; ok: boolean; error?: string; modelUsed?: string }>;

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
    'Returns the sub-agent\'s final summary. Not available within a sub-agent (no recursion).';
  isReadOnly = false;
  isDestructive = true; // sub-agent may itself run destructive tools — surface this clearly
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

    const maxIterations = args.max_iterations ?? 8;
    const role = args.role; // undefined => default 'subagent' behavior; the runner resolves it
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
    });
    const elapsedSec = Math.round((Date.now() - start) / 1000);

    if (!result.ok) {
      return {
        content:
          `[SUBAGENT_FAILED] Sub-agent "${args.description}" failed after ${result.toolCallsRun} tool call(s) in ${elapsedSec}s.\n` +
          `Model: ${result.modelUsed ?? 'unknown'}\n` +
          `Error: ${result.error ?? 'unknown'}\n` +
          `Partial output:\n${result.finalText || '(none)'}`,
        isError: true,
        metadata: { subSessionId, toolCallsRun: result.toolCallsRun, elapsedSec, modelUsed: result.modelUsed },
      };
    }

    return {
      content:
        `[SUBAGENT_DONE] "${args.description}" — completed in ${result.toolCallsRun} tool call(s), ${elapsedSec}s` +
        `${result.modelUsed ? ` (model: ${result.modelUsed})` : ''}\n\n` +
        `--- Sub-agent summary ---\n${result.finalText}`,
      metadata: { subSessionId, toolCallsRun: result.toolCallsRun, elapsedSec, ok: true, modelUsed: result.modelUsed },
    };
  }
}
