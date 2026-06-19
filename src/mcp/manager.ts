import { MCPClient, type MCPClientStatus } from './client.js';
import { MCPToolWrapper } from './tool-wrapper.js';
import type { MCPManagerConfig, MCPServerConfig } from './types.js';
import type { ToolRegistry } from '../tools/registry.js';
import { logger } from '../utils/logger.js';

/**
 * Expand `${ENV_VAR}` references throughout an MCP server config so a config
 * that stores `${GITHUB_PAT}` (rather than the literal secret) resolves from
 * process.env at launch. This is what lets `qodex mcp add` write a reference
 * instead of a plaintext token into config.yaml.
 *
 * Expansion covers: env values, every arg, header values, and the url. A
 * reference to a variable that isn't set expands to '' and logs a warning, so
 * a missing credential surfaces as a diagnosable "server failed" rather than a
 * confusing literal-string-passed-as-token bug. Returns a NEW config object;
 * the input is not mutated.
 */
export function expandEnvRefs(config: MCPServerConfig, serverName: string): MCPServerConfig {
  const missing = new Set<string>();
  const expand = (s: string): string =>
    s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, varName: string) => {
      const v = process.env[varName];
      if (v === undefined || v === '') { missing.add(varName); return ''; }
      return v;
    });

  const out: MCPServerConfig = { ...config };

  if (config.args) out.args = config.args.map(a => (typeof a === 'string' ? expand(a) : a));
  if (config.url) out.url = expand(config.url);
  if (config.env) {
    const env: Record<string, string> = {};
    for (const [k, val] of Object.entries(config.env)) {
      env[k] = typeof val === 'string' ? expand(val) : (val as any);
    }
    out.env = env;
  }
  if (config.headers) {
    const headers: Record<string, string> = {};
    for (const [k, val] of Object.entries(config.headers)) {
      headers[k] = typeof val === 'string' ? expand(val) : (val as any);
    }
    out.headers = headers;
  }

  if (missing.size > 0) {
    logger.warn(
      `MCP server '${serverName}': unset env var(s) ${[...missing].join(', ')} — ` +
      `referenced in config but not exported. The server will likely fail to authenticate. ` +
      `Export them (e.g. \`export ${[...missing][0]}=...\`) or re-add with --inline.`,
    );
  }
  return out;
}

/**
 * MCPManager: lifecycle owner for all configured MCP servers.
 *
 * On startup it spawns each enabled server in parallel, performs the JSON-RPC
 * initialize handshake, fetches the tool list, and registers a QodeX Tool wrapper
 * (one per MCP tool) into the registry under the name `mcp:<server>:<tool>`.
 *
 * A failing server doesn't block the others. Servers can be queried, restarted,
 * or shut down individually.
 */
export class MCPManager {
  private clients = new Map<string, MCPClient>();
  /** Per-server: names of tools currently registered in the QodeX registry. */
  private registeredToolsByServer = new Map<string, Set<string>>();

  constructor(
    private config: MCPManagerConfig,
    private registry: ToolRegistry,
  ) {}

  /** Start every enabled server. Returns once all start attempts have finished (success or failure). */
  async startAll(): Promise<void> {
    const entries = Object.entries(this.config.servers ?? {});
    if (entries.length === 0) {
      logger.debug('MCPManager: no servers configured');
      return;
    }

    const startup = entries.map(async ([name, srvConfig]) => {
      if (srvConfig.enabled === false) {
        logger.info(`MCP server '${name}' is disabled, skipping`);
        return;
      }
      try {
        await this.startOne(name, srvConfig);
      } catch (e: any) {
        // Don't propagate — one bad server shouldn't kill QodeX startup
        logger.warn(`MCP server '${name}' failed to start: ${e.message}`);
      }
    });

    await Promise.allSettled(startup);
    const total = Array.from(this.clients.values()).reduce((sum, c) => sum + c.tools.length, 0);
    logger.info(`MCPManager: ${this.clients.size} server(s), ${total} tool(s) total`);
  }

  /** Start a single server and register its tools. */
  async startOne(name: string, config: MCPServerConfig): Promise<void> {
    // If already running, stop first
    const existing = this.clients.get(name);
    if (existing) await existing.stop();

    // Expand ${ENV_VAR} references in env values, args, headers, and url so a
    // config that stores `${GITHUB_PAT}` (not the literal secret) resolves at
    // launch time from the process environment. Missing vars expand to '' and
    // log a warning so the failure is diagnosable.
    const resolved = expandEnvRefs(config, name);

    const client = new MCPClient(name, resolved);
    this.clients.set(name, client);

    client.on('tools-changed', () => {
      // Re-register tools when the server signals a change
      this.registerTools(client, resolved.destructive ?? true);
    });
    client.on('exit', () => {
      // Server died — keep the registry tools but they'll fail with MCP_UNAVAILABLE
      logger.warn(`MCP ${name} exited unexpectedly`);
    });

    await client.start();
    this.registerTools(client, resolved.destructive ?? true);
  }

  /** (Re-)register all of a client's tools in the QodeX registry. Removes stale entries from previous tool lists. */
  private registerTools(client: MCPClient, destructive: boolean): void {
    const previouslyRegistered = this.registeredToolsByServer.get(client.name) ?? new Set<string>();
    const newNames = new Set<string>();

    // Add / overwrite current tools
    for (const toolDef of client.tools) {
      const wrapper = new MCPToolWrapper(client, toolDef, destructive);
      this.registry.register(wrapper);
      newNames.add(wrapper.name);
    }

    // Remove anything that was registered before this round but is not in the new tool list.
    // Critical when a server's tools shrink across a restart or tools/list_changed event —
    // leftover wrappers would point to a stale client and surface to the agent as ghost tools.
    let removed = 0;
    for (const stale of previouslyRegistered) {
      if (!newNames.has(stale)) {
        if (this.registry.unregister(stale)) removed++;
      }
    }

    this.registeredToolsByServer.set(client.name, newNames);
    logger.debug(`MCP ${client.name}: registered ${newNames.size} tool(s)${removed > 0 ? `, removed ${removed} stale` : ''}`);
  }

  /** Stop all servers (called on graceful shutdown). Also clears their tools from the registry. */
  async stopAll(): Promise<void> {
    const stops = Array.from(this.clients.values()).map(c => c.stop().catch(() => {}));
    await Promise.allSettled(stops);
    // Clean up registry entries from all servers
    for (const [, names] of this.registeredToolsByServer) {
      for (const n of names) this.registry.unregister(n);
    }
    this.registeredToolsByServer.clear();
    this.clients.clear();
  }

  status(): MCPClientStatus[] {
    return Array.from(this.clients.values()).map(c => c.status);
  }

  getClient(name: string): MCPClient | undefined {
    return this.clients.get(name);
  }

  async restart(name: string): Promise<void> {
    const config = this.config.servers?.[name];
    if (!config) throw new Error(`No MCP server config named '${name}'`);
    await this.startOne(name, config);
  }
}

let _manager: MCPManager | null = null;
export function setMCPManager(m: MCPManager | null): void {
  _manager = m;
}
export function getMCPManager(): MCPManager | null {
  return _manager;
}
