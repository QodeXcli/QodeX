/**
 * Transport abstraction for MCP. The client speaks JSON-RPC 2.0; the transport
 * is responsible for delivering messages to/from the server.
 *
 * Two implementations:
 *   - StdioTransport: spawns the server as a child process and exchanges
 *     line-delimited JSON over its stdin/stdout (the default for local MCP servers).
 *   - HttpSseTransport: POSTs requests to an HTTP endpoint and consumes responses
 *     plus server-pushed messages via Server-Sent Events.
 *
 * The MCPClient owns the JSON-RPC logic and is transport-agnostic.
 */

import { EventEmitter } from 'events';
import crossSpawn from 'cross-spawn';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import { logger } from '../utils/logger.js';

export interface Transport {
  /** Open the connection. Resolves once we're ready to exchange messages. */
  start(): Promise<void>;
  /** Send a JSON-RPC message (request, response, or notification). */
  send(msg: object): Promise<void>;
  /** Close the connection and clean up resources. */
  stop(): Promise<void>;
  /** Subscribe to incoming messages (already JSON-parsed). */
  onMessage(handler: (msg: any) => void): void;
  /** Subscribe to fatal/transport-level errors. */
  onError(handler: (err: Error) => void): void;
  /** Subscribe to connection close events. */
  onClose(handler: (info: { code?: number | null; reason?: string }) => void): void;
}

abstract class BaseTransport extends EventEmitter implements Transport {
  abstract start(): Promise<void>;
  abstract send(msg: object): Promise<void>;
  abstract stop(): Promise<void>;
  onMessage(handler: (msg: any) => void): void { this.on('message', handler); }
  onError(handler: (err: Error) => void): void { this.on('error', handler); }
  onClose(handler: (info: { code?: number | null; reason?: string }) => void): void { this.on('close', handler); }

  protected emitLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: any;
    try {
      msg = JSON.parse(trimmed);
    } catch (e: any) {
      logger.warn('Transport: malformed JSON-RPC line', { line: trimmed.slice(0, 200), err: e.message });
      return;
    }
    this.emit('message', msg);
  }
}

// ---------------- stdio ----------------

export interface StdioConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export class StdioTransport extends BaseTransport {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';

  constructor(private config: StdioConfig) { super(); }

  async start(): Promise<void> {
    this.proc = crossSpawn(this.config.command, this.config.args ?? [], {
      env: { ...process.env, ...(this.config.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;

    // Attach error/close handlers FIRST. A failed spawn (e.g. a non-existent
    // command → ENOENT) emits 'error' asynchronously; without a listener already
    // in place, Node re-throws it as an uncaught exception. We must register the
    // handler before the pid check below, which throws synchronously on failure.
    this.proc.on('error', (err: Error) => this.emit('error', err));
    this.proc.on('close', (code, signal) => {
      this.emit('close', { code, reason: signal ?? undefined });
      this.proc = null;
    });

    if (!this.proc.pid) throw new Error(`Failed to spawn ${this.config.command}`);

    this.proc.stdout.setEncoding('utf-8');
    this.proc.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        this.emitLine(line);
      }
    });
    this.proc.stderr.setEncoding('utf-8');
    this.proc.stderr.on('data', (chunk: string) => {
      logger.debug('stdio MCP stderr', { line: chunk.toString().trim().slice(0, 500) });
    });
  }

  async send(msg: object): Promise<void> {
    if (!this.proc?.stdin?.writable) throw new Error('stdio transport not connected');
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;

    // CRITICAL: do NOT return until the child has actually exited (or the grace period elapses).
    // Otherwise SIGINT shutdown handlers can `process.exit(0)` before children are reaped,
    // orphaning them as zombies that keep eating CPU.
    await new Promise<void>(resolve => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        clearTimeout(giveupTimer);
        resolve();
      };
      proc.once('exit', finish);
      proc.once('close', finish);
      proc.once('error', finish);

      try { proc.kill('SIGTERM'); } catch {}
      const killTimer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
      }, 2000);
      // Hard upper bound so a stuck child can't block QodeX shutdown forever
      const giveupTimer = setTimeout(() => {
        proc.removeListener('exit', finish);
        proc.removeListener('close', finish);
        proc.removeListener('error', finish);
        finish();
      }, 5000);
    });
  }
}

// ---------------- HTTP + SSE ----------------

export interface HttpSseConfig {
  /** SSE endpoint URL. Server sends an `endpoint` event giving the URL for POSTs. */
  url: string;
  /** Static headers added to every request. */
  headers?: Record<string, string>;
  /** Connection timeout in ms. Default 10000. */
  connectTimeoutMs?: number;
}

/**
 * MCP HTTP+SSE transport (protocol version 2024-11-05 style).
 *
 * Wire protocol:
 *   1. Client GETs the SSE URL with Accept: text/event-stream.
 *   2. Server's first event is `event: endpoint` carrying the absolute URL for POSTs.
 *   3. Subsequent `event: message` (or unnamed) events carry JSON-RPC payloads.
 *   4. Client POSTs JSON-RPC messages to the endpoint URL given in step 2.
 *      Response is acknowledged via the SSE stream (not the POST response body).
 */
export class HttpSseTransport extends BaseTransport {
  private sseReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private sseAbort = new AbortController();
  private postUrl: string | null = null;
  private postUrlReady: Promise<string> | null = null;
  private postUrlResolve: ((url: string) => void) | null = null;
  private buffer = '';
  private closed = false;

  constructor(private config: HttpSseConfig) { super(); }

  async start(): Promise<void> {
    this.postUrlReady = new Promise<string>((resolve) => {
      this.postUrlResolve = resolve;
    });

    const timeoutMs = this.config.connectTimeoutMs ?? 10_000;
    const timeoutController = new AbortController();
    const timeoutHandle = setTimeout(() => timeoutController.abort('connect-timeout'), timeoutMs);

    // Compose abort signals manually for broad Node compat
    const combinedSignal = composeSignals(this.sseAbort.signal, timeoutController.signal);

    let res: Response;
    try {
      res = await fetch(this.config.url, {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache',
          ...(this.config.headers ?? {}),
        },
        signal: combinedSignal,
      });
    } catch (e: any) {
      clearTimeout(timeoutHandle);
      throw new Error(`HTTP+SSE connect failed: ${e.message}`);
    }
    clearTimeout(timeoutHandle);

    if (!res.ok) {
      throw new Error(`HTTP+SSE server returned ${res.status} ${res.statusText}`);
    }
    if (!res.body) {
      throw new Error('HTTP+SSE server returned no body');
    }

    this.sseReader = res.body.getReader();
    this.consumeSSE().catch(err => {
      if (!this.closed) this.emit('error', err instanceof Error ? err : new Error(String(err)));
    });

    // Wait for the endpoint event (with timeout)
    const endpointTimeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Did not receive endpoint event from MCP server')), timeoutMs);
    });
    this.postUrl = await Promise.race([this.postUrlReady, endpointTimeout]);
  }

  async send(msg: object): Promise<void> {
    if (!this.postUrl) throw new Error('HTTP+SSE transport not ready (no endpoint URL)');
    const res = await fetch(this.postUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.config.headers ?? {}),
      },
      body: JSON.stringify(msg),
    });
    if (!res.ok) {
      throw new Error(`POST ${this.postUrl} failed: ${res.status} ${res.statusText}`);
    }
    // Response payload arrives via SSE; we don't read it from POST body
  }

  async stop(): Promise<void> {
    this.closed = true;
    try { this.sseAbort.abort('close'); } catch {}
    try { await this.sseReader?.cancel(); } catch {}
    this.sseReader = null;
    this.emit('close', { reason: 'stopped' });
  }

  private async consumeSSE(): Promise<void> {
    if (!this.sseReader) return;
    const decoder = new TextDecoder();
    while (!this.closed) {
      const { done, value } = await this.sseReader.read();
      if (done) {
        this.emit('close', { reason: 'server-eof' });
        return;
      }
      this.buffer += decoder.decode(value, { stream: true });
      // SSE events are separated by blank lines
      let sep: number;
      while ((sep = this.buffer.indexOf('\n\n')) !== -1) {
        const block = this.buffer.slice(0, sep);
        this.buffer = this.buffer.slice(sep + 2);
        this.parseSSEBlock(block);
      }
    }
  }

  private parseSSEBlock(block: string): void {
    let event = 'message';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue; // comment
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += (data ? '\n' : '') + line.slice(5).trim();
    }
    if (!data) return;

    if (event === 'endpoint') {
      // Server tells us where to POST. Data is a URL (may be relative).
      const resolved = this.resolveUrl(data);
      logger.info('MCP HTTP+SSE: received endpoint', { url: resolved });
      this.postUrl = resolved;
      this.postUrlResolve?.(resolved);
      return;
    }

    // Default: data is a JSON-RPC payload
    this.emitLine(data);
  }

  private resolveUrl(maybeRelative: string): string {
    try {
      return new URL(maybeRelative, this.config.url).toString();
    } catch {
      return maybeRelative;
    }
  }
}

// ---------------- Streamable HTTP (MCP 2025-03-26) ----------------

export interface StreamableHttpConfig {
  /** The single MCP endpoint URL. Client POSTs JSON-RPC here; the response body is
   *  either application/json (one message) or text/event-stream (a stream of messages). */
  url: string;
  headers?: Record<string, string>;
  connectTimeoutMs?: number;
}

/**
 * Pure SSE line extractor — the bug-prone core, kept pure so it's unit-testable.
 * Feed it the accumulated decoded text; it returns the complete `data:` payloads
 * found and the leftover (incomplete final line) to carry into the next chunk.
 * Multibyte safety is handled upstream by TextDecoderStream; this only deals with
 * line framing. Ignores `event:`/`id:`/comments/blank lines and the `[DONE]` sentinel.
 */
export function extractSseData(buffer: string): { data: string[]; rest: string } {
  const lines = buffer.split('\n');
  const rest = lines.pop() ?? '';
  const data: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (!line.startsWith('data:')) continue; // skip event:/id:/comments/blank
    const payload = line.slice(5).replace(/^ /, '');
    if (!payload || payload === '[DONE]') continue;
    data.push(payload);
  }
  return { data, rest };
}

/**
 * Modern MCP transport (protocol 2025-03-26 "Streamable HTTP"). Unlike the old
 * HTTP+SSE dance (GET → wait for an `endpoint` event → POST), here every client
 * message is a single POST to the one URL, and the response body carries the reply
 * — as application/json (one message) or text/event-stream (a streamed sequence).
 * This is what modern servers (Tavily, Higgsfield, etc.) actually speak, and it
 * doesn't hang waiting for an `endpoint` event that never comes.
 *
 * NOTE: OAuth is NOT handled here. For OAuth servers, use the mcp-remote bridge
 * (stdio) which performs the browser handshake. This transport is for token / header
 * / no-auth streamable servers.
 */
export class StreamableHttpTransport extends BaseTransport {
  private sessionId: string | null = null;
  private closed = false;

  constructor(private config: StreamableHttpConfig) { super(); }

  // No separate handshake — the first POST (initialize) opens the conversation and
  // may return an Mcp-Session-Id we echo on subsequent requests.
  async start(): Promise<void> { /* ready immediately */ }

  async send(msg: object): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(this.config.headers ?? {}),
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;

    let res: Response;
    try {
      res = await fetch(this.config.url, { method: 'POST', headers, body: JSON.stringify(msg) });
    } catch (e: any) {
      throw new Error(`Streamable-HTTP POST failed: ${e.message}`);
    }

    const sid = res.headers.get('Mcp-Session-Id') ?? res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;

    if (res.status === 202) return;             // accepted, no body (notification ack)
    if (!res.ok) throw new Error(`Streamable-HTTP server returned ${res.status} ${res.statusText}`);

    const ctype = (res.headers.get('content-type') ?? '').toLowerCase();
    if (ctype.includes('text/event-stream')) {
      await this.readSseBody(res);
    } else {
      // application/json (or unspecified): one JSON-RPC message in the body.
      const text = await res.text();
      if (text.trim()) this.emitLine(text.trim());
    }
  }

  private async readSseBody(res: Response): Promise<void> {
    if (!res.body) return;
    // Manual TextDecoder with {stream:true} keeps multibyte chars (Persian, emoji)
    // intact across chunk boundaries — same proven approach as HttpSseTransport,
    // and avoids depending on TextDecoderStream being in the TS lib.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { data, rest } = extractSseData(buffer);
        buffer = rest;
        for (const d of data) this.emitLine(d);
      }
      buffer += decoder.decode(); // flush any trailing bytes
      if (buffer.trim()) {
        const { data } = extractSseData(buffer + '\n');
        for (const d of data) this.emitLine(d);
      }
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
  }

  async stop(): Promise<void> {
    this.closed = true;
    this.emit('close', { reason: 'stopped' });
  }
}

function composeSignals(...signals: AbortSignal[]): AbortSignal {
  // Use AbortSignal.any if available (Node 20.3+); otherwise compose manually.
  // @ts-ignore — AbortSignal.any exists in Node 20.3+
  if (typeof (AbortSignal as any).any === 'function') {
    // @ts-ignore
    return (AbortSignal as any).any(signals);
  }
  const ac = new AbortController();
  for (const s of signals) {
    if (s.aborted) { ac.abort(s.reason); break; }
    s.addEventListener('abort', () => ac.abort(s.reason), { once: true });
  }
  return ac.signal;
}
