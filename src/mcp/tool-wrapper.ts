import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../tools/base.js';
import type { ToolSchema } from '../llm/types.js';
import type { MCPClient } from './client.js';
import type { MCPToolDef } from './types.js';
import { logger } from '../utils/logger.js';
import { redactValue } from '../utils/redact.js';

/**
 * Wraps an MCP-exposed tool as a QodeX Tool so the agent loop can call it through the
 * same registry path as built-in tools. The tool name is namespaced as `mcp:<server>:<tool>`
 * to avoid collisions with builtins and across servers.
 */
export class MCPToolWrapper extends Tool<Record<string, unknown>> {
  readonly name: string;
  readonly description: string;
  readonly isReadOnly: boolean;
  readonly isDestructive: boolean;
  readonly argsSchema = z.record(z.any()) as unknown as z.ZodType<Record<string, unknown>>;

  constructor(
    private client: MCPClient,
    private toolDef: MCPToolDef,
    /** When the server is declared non-destructive, allow auto-approval. */
    serverDestructive: boolean = true,
  ) {
    super();
    this.name = `mcp:${client.name}:${toolDef.name}`;
    this.description = `[via MCP/${client.name}] ${toolDef.description ?? toolDef.name}`;
    // Conservative default: treat MCP tools as potentially mutating unless server says otherwise.
    this.isReadOnly = !serverDestructive;
    this.isDestructive = serverDestructive;
  }

  /** Override schema() to use the MCP-provided JSON Schema directly (skip zod conversion). */
  schema(): ToolSchema {
    const inputSchema = this.toolDef.inputSchema ?? { type: 'object', properties: {} };
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: inputSchema as ToolSchema['function']['parameters'],
      },
    };
  }

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (!this.client.isReady()) {
      return {
        content: `[MCP_UNAVAILABLE] MCP server '${this.client.name}' is not ready (state: ${this.client.status.state}, error: ${this.client.status.error ?? 'none'}). The agent cannot use this tool right now.`,
        isError: true,
      };
    }

    // Permission check (MCP tools go through the same engine as builtins)
    const permReq = {
      tool: this.name,
      operation: this.name,
      description: this.description,
    };
    const decision = ctx.permissions.evaluate(permReq);
    if (decision === 'deny') {
      return { content: `[PERMISSION_DENIED] Blocked by policy: ${this.name}`, isError: true };
    }
    if (decision === 'ask') {
      const summary = this.summarizeArgs(args);
      const answer = await ctx.askUser(
        `Run MCP tool ${this.name}${summary ? `\n  args: ${summary}` : ''}?`,
        ['yes', 'no', 'always'],
      );
      if (answer === 'no') {
        return { content: `[USER_REJECTED] User declined MCP tool ${this.name}`, isError: true };
      }
      if (answer === 'always') {
        ctx.permissions.rememberDecision(permReq, 'allow', 'pattern');
      }
    }

    try {
      const result = await this.client.callTool(this.toolDef.name, args, ctx.signal);
      const text = (result.content ?? [])
        .map(b => {
          if (b.type === 'text') return b.text;
          if (b.type === 'image') return `[image ${b.mimeType}, ${b.data.length} chars base64]`;
          if (b.type === 'resource') return `[resource ${b.resource.uri}${b.resource.text ? `: ${b.resource.text.slice(0, 200)}` : ''}]`;
          return JSON.stringify(b);
        })
        .join('\n');
      return {
        content: text || '[empty result]',
        isError: result.isError === true,
        metadata: { mcpServer: this.client.name, mcpTool: this.toolDef.name },
      };
    } catch (e: any) {
      logger.warn('MCP tool call failed', { tool: this.name, err: e.message });
      return {
        content: `[MCP_ERROR] ${this.name}: ${e.message}`,
        isError: true,
      };
    }
  }

  private summarizeArgs(args: Record<string, unknown>): string {
    const keys = Object.keys(args);
    if (keys.length === 0) return '';
    const summary = keys.map(k => {
      const v = redactValue(k, args[k]);
      const display = typeof v === 'string'
        ? (v.length > 40 ? v.slice(0, 40) + '…' : v)
        : JSON.stringify(v).slice(0, 40);
      return `${k}=${display}`;
    }).join(', ');
    return summary.length > 200 ? summary.slice(0, 200) + '…' : summary;
  }
}
