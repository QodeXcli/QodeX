/**
 * Contract for Sentinel — QodeX's guard for consequential outbound actions.
 *
 * Sentinel sits at the single tool-execution choke point (ToolRegistry.execute),
 * so it covers the main loop, sub-agents, missions and the MCP server alike.
 * Before a tool runs it classifies the action (purchase, payment, send,
 * credential, delete, publish, navigation to a blocked domain, ...) and decides:
 *   allow  — run it;
 *   ask    — get an explicit human answer (terminal, control center, Telegram),
 *            which `/auto on` and `--yes` can NOT short-circuit for critical
 *            categories;
 *   deny   — refuse with a [SENTINEL_BLOCKED] result the model can read.
 * After a tool with `untrustedOutput` runs, Sentinel scans the text for prompt
 * injection and fences it so the model treats it as data, not instructions.
 */

import type { SentinelCategory } from '../config/agent-config.js';
import type { ToolContext, ToolResult } from '../tools/base.js';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface ActionClassification {
  category: SentinelCategory | null;
  risk: RiskLevel;
  /** Human-readable reason, shown in the approval prompt and the audit log. */
  reason: string;
  /** Short description of the action ("click 'Place order' on shop.example"). */
  summary: string;
  /** Domain involved, if any. */
  domain?: string;
}

export type SentinelDecision =
  | { action: 'allow'; classification: ActionClassification }
  | { action: 'ask'; classification: ActionClassification; prompt: string }
  | { action: 'deny'; classification: ActionClassification; message: string };

export interface InjectionFinding {
  id: string;
  detail: string;
  excerpt: string;
}

export interface SentinelGuard {
  /** Pre-execution review. Resolves to null when the call may proceed, or a
   *  ToolResult (isError) that replaces the call when it must not. May prompt a human. */
  beforeTool(toolName: string, args: Record<string, unknown>, ctx: ToolContext, meta: { untrustedOutput?: boolean; isReadOnly?: boolean }): Promise<ToolResult | null>;
  /** Post-execution: scan/fence untrusted output. Returns the (possibly rewritten) result. */
  afterTool(toolName: string, args: Record<string, unknown>, result: ToolResult, meta: { untrustedOutput?: boolean }): ToolResult;
}
