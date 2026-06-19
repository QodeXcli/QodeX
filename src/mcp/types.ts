/**
 * Model Context Protocol (MCP) — minimal client types.
 * Spec: https://spec.modelcontextprotocol.io/specification/2024-11-05/
 *
 * We implement the stdio transport with JSON-RPC 2.0, and the tools/* + initialize methods.
 * Resources, prompts, and sampling are not yet wired but the framework supports them.
 */

export const MCP_PROTOCOL_VERSION = '2024-11-05';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

/** What QodeX advertises to MCP servers. */
export interface MCPClientInfo {
  name: string;
  version: string;
}

/** Server's reply to "initialize". */
export interface MCPInitializeResult {
  protocolVersion: string;
  capabilities: MCPServerCapabilities;
  serverInfo?: { name: string; version?: string };
}

export interface MCPServerCapabilities {
  tools?: { listChanged?: boolean };
  resources?: { listChanged?: boolean; subscribe?: boolean };
  prompts?: { listChanged?: boolean };
  logging?: Record<string, never>;
}

/** A tool the MCP server exposes — name + JSON-Schema input spec. */
export interface MCPToolDef {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    [k: string]: unknown;
  };
}

/** Result of tools/call — an array of content blocks. */
export interface MCPToolResult {
  content: Array<MCPContentBlock>;
  isError?: boolean;
}

export type MCPContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; mimeType?: string; text?: string } };

/** Configuration for one MCP server in user config. */
export interface MCPServerConfig {
  // ----- stdio transport (default) -----
  /** Executable to run (e.g. "npx" or "/path/to/server"). Stdio transport. */
  command?: string;
  /** Arguments for the executable. */
  args?: string[];
  /** Environment variables. Values starting with $ are expanded from process.env. */
  env?: Record<string, string>;

  // ----- HTTP+SSE transport -----
  /** SSE endpoint URL. When set, HTTP+SSE transport is used instead of stdio. */
  url?: string;
  /** Static headers added to every request. Values may use $VAR expansion. */
  headers?: Record<string, string>;
  /** Use the modern Streamable-HTTP transport (MCP 2025-03-26) instead of the older
   *  HTTP+SSE endpoint-event handshake. Set true for servers (Tavily, Higgsfield, …)
   *  that hang on the old protocol. Token/header/no-auth only — OAuth servers still
   *  need the mcp-remote stdio bridge. */
  streamable?: boolean;

  // ----- common -----
  /** If false, server is registered but not started. Default true. */
  enabled?: boolean;
  /** If false, this server's tools are treated as read-only and auto-approved. */
  destructive?: boolean;
  /** Seconds to wait for initialize handshake. Default 10. */
  startupTimeoutSeconds?: number;
}

export interface MCPManagerConfig {
  servers: Record<string, MCPServerConfig>;
}

/** Standard JSON-RPC error codes (RFC + MCP additions). */
export const MCP_ERROR_CODES = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  ServerError: -32000,
} as const;
