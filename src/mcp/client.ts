import { EventEmitter } from 'events';
import {
  MCP_PROTOCOL_VERSION,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcNotification,
  type MCPInitializeResult,
  type MCPServerCapabilities,
  type MCPToolDef,
  type MCPToolResult,
  type MCPServerConfig,
  MCP_ERROR_CODES,
} from './types.js';
import { Transport, StdioTransport, HttpSseTransport, StreamableHttpTransport } from './transport.js';
import { logger } from '../utils/logger.js';
import { expandEnvObject } from '../utils/env-expand.js';

interface PendingCall {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  method: string;
  timeoutHandle?: ReturnType<typeof setTimeout>;
}

export interface MCPClientStatus {
  name: string;
  state: 'stopped' | 'starting' | 'ready' | 'failed';
  toolCount: number;
  error?: string;
  transport: string;
}

/**
 * One MCP server connection. Transport-agnostic — works with stdio or HTTP+SSE.
 * Manages JSON-RPC framing, request/response correlation, and tool discovery.
 */
export class MCPClient extends EventEmitter {
  private transport: Transport | null = null;
  private nextId = 1;
  private pending = new Map<number | string, PendingCall>();
  private state: MCPClientStatus['state'] = 'stopped';
  private lastError: string | null = null;
  private transportName: string;

  capabilities: MCPServerCapabilities = {};
  tools: MCPToolDef[] = [];

  constructor(
    public readonly name: string,
    private config: MCPServerConfig,
  ) {
    super();
    this.transportName = this.detectTransport();
  }

  get status(): MCPClientStatus {
    return {
      name: this.name,
      state: this.state,
      toolCount: this.tools.length,
      error: this.lastError ?? undefined,
      transport: this.transportName,
    };
  }

  isReady(): boolean {
    return this.state === 'ready';
  }

  async start(): Promise<void> {
    if (this.state !== 'stopped' && this.state !== 'failed') {
      throw new Error(`MCP server ${this.name} is already ${this.state}`);
    }
    this.state = 'starting';
    this.lastError = null;
    this.tools = [];

    this.transport = this.buildTransport();
    this.transport.onMessage((msg) => this.handleMessage(msg));
    this.transport.onError((err) => {
      logger.warn(`MCP server ${this.name} transport error`, { err: err.message });
      this.lastError = err.message;
    });
    this.transport.onClose((info) => {
      logger.info(`MCP server ${this.name} closed`, info);
      this.failAllPending(new Error(`MCP transport closed: ${info.reason ?? 'unknown'}`));
      this.state = 'failed';
      this.lastError = `closed: ${info.reason ?? 'unknown'}`;
      this.emit('exit', info);
    });

    try {
      logger.info(`Starting MCP server ${this.name} via ${this.transportName}`);
      await this.transport.start();
    } catch (e: any) {
      this.state = 'failed';
      this.lastError = `transport start failed: ${e.message}`;
      throw new Error(this.lastError);
    }

    // Initialize handshake (with timeout)
    const startupTimeout = (this.config.startupTimeoutSeconds ?? 10) * 1000;
    try {
      const initResult = await this.requestWithTimeout<MCPInitializeResult>(
        'initialize',
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          clientInfo: { name: 'qodex', version: '0.3.0' },
        },
        startupTimeout,
      );
      this.capabilities = initResult.capabilities ?? {};
      logger.info(`MCP ${this.name} initialized`, {
        serverInfo: initResult.serverInfo,
        capabilities: Object.keys(this.capabilities),
      });

      // Required notification per spec
      this.notify('notifications/initialized');

      // Pull tools list if supported
      if (this.capabilities.tools !== undefined) {
        const toolsResult = await this.requestWithTimeout<{ tools: MCPToolDef[] }>('tools/list', {}, startupTimeout);
        this.tools = toolsResult.tools ?? [];
        logger.info(`MCP ${this.name} loaded ${this.tools.length} tool(s)`, {
          names: this.tools.map(t => t.name),
        });
      }

      this.state = 'ready';
      this.emit('ready');
    } catch (e: any) {
      this.state = 'failed';
      this.lastError = e.message ?? String(e);
      logger.warn(`MCP ${this.name} failed to start`, { err: this.lastError });
      await this.transport?.stop().catch(() => {});
      this.transport = null;
      throw e;
    }
  }

  async stop(): Promise<void> {
    this.failAllPending(new Error(`MCP server ${this.name} stopped`));
    if (this.transport) {
      await this.transport.stop().catch(() => {});
      this.transport = null;
    }
    this.state = 'stopped';
  }

  async callTool(toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<MCPToolResult> {
    if (this.state !== 'ready') {
      throw new Error(`MCP server ${this.name} is ${this.state}, cannot call tool`);
    }
    return this.requestWithTimeout<MCPToolResult>(
      'tools/call',
      { name: toolName, arguments: args },
      120_000,
      signal,
    );
  }

  // ---------- internals ----------

  private detectTransport(): string {
    if ((this.config as any).url) {
      return (this.config as any).streamable ? 'streamable-http' : 'http+sse';
    }
    return 'stdio';
  }

  private buildTransport(): Transport {
    const cfg = this.config as any;
    if (cfg.url) {
      const opts = {
        url: cfg.url,
        headers: this.expandHeaders(cfg.headers ?? {}),
        connectTimeoutMs: (this.config.startupTimeoutSeconds ?? 10) * 1000,
      };
      // Opt-in modern transport for streamable-HTTP servers (Tavily, Higgsfield, …)
      // that hang on the older SSE endpoint-event handshake. Set `streamable: true`.
      return cfg.streamable ? new StreamableHttpTransport(opts) : new HttpSseTransport(opts);
    }
    return new StdioTransport({
      command: this.config.command!,
      args: this.config.args ?? [],
      env: this.expandEnv(this.config.env ?? {}),
    });
  }

  private handleMessage(msg: any): void {
    if (msg.jsonrpc !== '2.0') {
      logger.warn(`MCP ${this.name} sent non-JSON-RPC-2.0 message`, { msg });
      return;
    }

    if ('id' in msg && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pending.get(msg.id);
      if (!pending) {
        logger.debug(`MCP ${this.name} unmatched response`, { id: msg.id });
        return;
      }
      this.pending.delete(msg.id);
      if (pending.timeoutHandle) clearTimeout(pending.timeoutHandle);
      if (msg.error) {
        const err = new Error(`MCP error from ${this.name} (${pending.method}): ${msg.error.message ?? 'unknown'} [code=${msg.error.code}]`);
        (err as any).code = msg.error.code;
        (err as any).data = msg.error.data;
        pending.reject(err);
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    if ('method' in msg && 'id' in msg) {
      // Server-initiated request — reply not implemented
      this.send({
        jsonrpc: '2.0',
        id: msg.id,
        error: {
          code: MCP_ERROR_CODES.MethodNotFound,
          message: `qodex does not implement server-initiated method ${msg.method}`,
        },
      } as JsonRpcResponse).catch(() => {});
      return;
    }

    if ('method' in msg) {
      logger.debug(`MCP ${this.name} notification`, { method: msg.method });
      if (msg.method === 'notifications/tools/list_changed') {
        this.refreshTools().catch(e => logger.warn('Failed to refresh tools', { err: e.message }));
      }
      this.emit('notification', msg);
      return;
    }

    logger.warn(`MCP ${this.name} unrecognized message`, { msg });
  }

  private async refreshTools(): Promise<void> {
    try {
      const r = await this.requestWithTimeout<{ tools: MCPToolDef[] }>('tools/list', {}, 5000);
      this.tools = r.tools ?? [];
      this.emit('tools-changed', this.tools);
    } catch (e: any) {
      logger.warn(`MCP ${this.name} refreshTools failed`, { err: e.message });
    }
  }

  private requestWithTimeout<T>(
    method: string,
    params: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };

    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        if (p.timeoutHandle) clearTimeout(p.timeoutHandle);
        reject(new Error(`MCP request '${method}' aborted`));
      };

      const timeoutHandle = setTimeout(() => {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        signal?.removeEventListener('abort', onAbort);
        reject(new Error(`MCP request '${method}' to ${this.name} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (v: unknown) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(v as T);
        },
        reject: (e: Error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(e);
        },
        method,
        timeoutHandle,
      });

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      this.send(req).catch((e) => {
        this.pending.delete(id);
        clearTimeout(timeoutHandle);
        signal?.removeEventListener('abort', onAbort);
        reject(e);
      });
    });
  }

  private notify(method: string, params?: unknown): void {
    const notif: JsonRpcNotification = { jsonrpc: '2.0', method, params };
    this.send(notif).catch(e => logger.warn(`MCP ${this.name} notify failed`, { method, err: e.message }));
  }

  private async send(msg: object): Promise<void> {
    if (!this.transport) throw new Error(`MCP ${this.name} transport not initialized`);
    await this.transport.send(msg);
  }

  private failAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      if (p.timeoutHandle) clearTimeout(p.timeoutHandle);
      try { p.reject(err); } catch {}
    }
    this.pending.clear();
  }

  private expandEnv(env: Record<string, string>): Record<string, string> {
    // Delegated to a tested utility — see src/utils/env-expand.ts
    // Supports: $VAR, ${VAR}, $$ escape, and partial substitution inside larger strings.
    return expandEnvObject(env);
  }

  private expandHeaders(headers: Record<string, string>): Record<string, string> {
    return this.expandEnv(headers);
  }
}
