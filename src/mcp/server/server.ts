/*
 * QodeX — Local-first agentic coding CLI
 * Copyright 2026 7 SEVEN
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
 * QodeX MCP Server — exposes QodeX's tools to any MCP client (Cursor, Zed,
 * VS Code, Claude Desktop, …) over stdio JSON-RPC 2.0.
 *
 * This is the inverse of the existing MCP *client* (which lets QodeX consume
 * other servers' tools). Here QodeX IS the server: editors call into its Hybrid
 * Search, Git Sandbox, Critic, and the rest of its tool registry as a standard
 * MCP endpoint — turning QodeX from a CLI into local infrastructure.
 *
 * Protocol surface (the minimum a host needs):
 *   - initialize                 → capabilities + serverInfo
 *   - notifications/initialized  → (ack, no-op)
 *   - tools/list                 → all exposed tools as MCPToolDef[]
 *   - tools/call                 → run a tool, return MCPToolResult
 *   - ping                       → {} (health)
 *   - shutdown / exit            → graceful stop
 *
 * Reuses, not reinvents:
 *   - JSON-RPC types from ../types.ts
 *   - Tool schemas from the ToolRegistry (schema().function → inputSchema)
 *   - Tool execution from registry.execute() with a minimal server ToolContext
 *
 * Transport is line-delimited JSON over stdin/stdout (one JSON-RPC message per
 * line) — the framing the StdioTransport on the client side already speaks. All
 * logging goes to stderr so it never corrupts the stdout protocol stream.
 */

import type { JsonRpcRequest, JsonRpcResponse, MCPToolDef, MCPToolResult } from '../types.js';
import type { ToolRegistry, ToolExecutionMode } from '../../tools/registry.js';
import type { QodexConfig } from '../../config/defaults.js';
import { buildQodexMcpTools } from './qodex-tools.js';

/** Write a line to stderr (safe — stdout is reserved for the protocol). */
function logErr(msg: string, extra?: unknown): void {
  const line = extra !== undefined ? `${msg} ${JSON.stringify(extra)}` : msg;
  process.stderr.write(`[qodex-mcp] ${line}\n`);
}

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'qodex', version: '2.3.3' };

export interface McpServerDeps {
  registry: ToolRegistry;
  config: QodexConfig;
  cwd: string;
  /** Tool exposure scope: 'safe' (read-only), 'all', or an explicit allowlist.
   *  undefined → fall back to config.mcpServer.expose, then 'safe'. */
  exposeTools?: 'safe' | 'all' | string[];
}

export class QodexMcpServer {
  private buffer = '';
  private specialTools: ReturnType<typeof buildQodexMcpTools>;

  constructor(private deps: McpServerDeps) {
    this.specialTools = buildQodexMcpTools(deps);
  }

  /** Start reading JSON-RPC from stdin and writing responses to stdout. */
  start(): void {
    logErr(`QodeX MCP server starting (cwd=${this.deps.cwd})`);
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string) => this.onData(chunk));
    process.stdin.on('end', () => process.exit(0));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) void this.handleLine(line);
    }
  }

  private send(msg: JsonRpcResponse): void {
    process.stdout.write(JSON.stringify(msg) + '\n');
  }

  private err(id: JsonRpcRequest['id'], code: number, message: string): void {
    this.send({ jsonrpc: '2.0', id, error: { code, message } });
  }

  private async handleLine(line: string): Promise<void> {
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(line);
    } catch {
      logErr('malformed JSON-RPC line', line.slice(0, 200));
      return;
    }
    try {
      const res = await this.handleMessage(req);
      if (res) this.send(res);
    } catch (e: any) {
      logErr('handler threw', e?.message);
      if (req.id !== undefined && req.id !== null) this.err(req.id, -32603, `Internal error: ${e?.message}`);
    }
  }

  /**
   * Handle one JSON-RPC request and RETURN the response (or null for
   * notifications / process-exiting methods). Pure enough to unit-test: no
   * stdout writes happen here. `handleLine` wires it to the transport.
   */
  async handleMessage(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const mkOk = (result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id: req.id, result });
    const mkErr = (code: number, message: string): JsonRpcResponse => ({ jsonrpc: '2.0', id: req.id, error: { code, message } });

    switch (req.method) {
      case 'initialize':
        return mkOk({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        });

      case 'notifications/initialized':
        return null;

      case 'ping':
        return mkOk({});

      case 'tools/list':
        return mkOk({ tools: this.listTools() });

      case 'tools/call': {
        const params = (req.params ?? {}) as { name?: string; arguments?: unknown };
        if (!params.name) return mkErr(-32602, 'Missing tool name');
        const result = await this.callTool(params.name, params.arguments ?? {});
        return mkOk(result);
      }

      case 'shutdown':
        return mkOk({});
      case 'exit':
        process.exit(0);

      default:
        if (req.id !== undefined && req.id !== null) return mkErr(-32601, `Method not found: ${req.method}`);
        return null;
    }
  }

  /** All exposed tools = scoped registry tools + QodeX special tools. */
  private listTools(): MCPToolDef[] {
    const mode: ToolExecutionMode = { mode: 'normal' };

    // Resolve the exposure scope. Explicit constructor list wins; else config
    // mcpServer.expose ('safe' | 'all' | string[]); default 'safe'.
    const scope = this.deps.exposeTools
      ?? (this.deps.config as any).mcpServer?.expose
      ?? 'safe';

    const allSchemas = this.deps.registry.getSchemas(mode);
    let allowed: (s: { function: { name: string } }) => boolean;
    if (scope === 'all') {
      allowed = () => true;
    } else if (Array.isArray(scope)) {
      const set = new Set(scope);
      allowed = (s) => set.has(s.function.name);
    } else {
      // 'safe' — read-only tools only (no host mutations). Editing happens via
      // the qodex_* specials (sandbox_run) or an explicit allowlist.
      allowed = (s) => this.deps.registry.isReadOnly(s.function.name);
    }

    const registryTools: MCPToolDef[] = allSchemas
      .filter(allowed)
      // Don't double-expose anything the special tools already cover.
      .filter(s => !this.specialTools.some(st => st.def.name === s.function.name))
      .map(s => ({
        name: s.function.name,
        description: s.function.description,
        inputSchema: (s.function.parameters as MCPToolDef['inputSchema']) ?? { type: 'object' },
      }));

    const special = this.specialTools.map(st => st.def);
    return [...special, ...registryTools];
  }

  /** Route a tools/call to either a special QodeX tool or the registry. */
  private async callTool(name: string, args: unknown): Promise<MCPToolResult> {
    // Special tools first (qodex_hybrid_search / qodex_sandbox_run / qodex_critic_review).
    const special = this.specialTools.find(st => st.def.name === name);
    if (special) {
      try {
        return await special.handler(args);
      } catch (e: any) {
        return { content: [{ type: 'text', text: `[ERROR] ${e?.message}` }], isError: true };
      }
    }
    // Fall through to the registry.
    return this.callRegistryTool(name, args);
  }

  private async callRegistryTool(name: string, args: unknown): Promise<MCPToolResult> {
    // Enforce the exposure scope on calls too — a client must not invoke a tool
    // that isn't in the advertised list (defense in depth, not just hiding it).
    const exposed = new Set(this.listTools().map(t => t.name));
    if (!exposed.has(name)) {
      return { content: [{ type: 'text', text: `[ERROR] Tool "${name}" is not exposed by this server (scope-restricted).` }], isError: true };
    }
    const { makeServerToolContext } = await import('./tool-context.js');
    const ctx = await makeServerToolContext(this.deps.cwd, this.deps.config);
    try {
      const r = await this.deps.registry.execute(name, args, ctx);
      return {
        content: [{ type: 'text', text: typeof r.content === 'string' ? r.content : JSON.stringify(r.content) }],
        isError: r.isError ?? false,
      };
    } finally {
      await ctx._cleanup?.();
    }
  }
}