/**
 * `http_request` — REST API testing tool.
 *
 * For when the user is building or debugging an API and needs the agent to
 * actually CALL an endpoint, not just describe what calling it would look
 * like. Common workflows:
 *
 *   - "Is the /api/users endpoint returning 200?"
 *   - "Test the login flow with these credentials"
 *   - "Hit the staging API with this payload and tell me the response"
 *
 * Security:
 *   - SSRF protection: blocks localhost-like hostnames UNLESS the user
 *     explicitly enables `allow_local: true` (very common for dev work).
 *   - File:// and other schemes blocked.
 *   - Response body capped at 1 MB.
 *   - 30 second timeout.
 *
 * Returns: status code, headers (subset), body (text up to cap or "[binary]").
 * Marked as destructive because POST/PUT/DELETE can mutate remote state.
 */

import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { proxyFetch } from '../../utils/proxy-fetch.js';

const HttpRequestArgs = z.object({
  url: z.string().url().describe('Full URL including scheme. http:// or https://.'),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).optional().describe('HTTP method. Default GET.'),
  headers: z.record(z.string()).optional().describe('Request headers as a key-value object.'),
  body: z.string().optional().describe('Request body (string). For JSON, JSON.stringify your object first.'),
  query: z.record(z.string()).optional().describe('Query parameters appended to the URL.'),
  timeout_seconds: z.number().int().min(1).max(120).optional().describe('Default 30.'),
  allow_local: z.boolean().optional().describe('Allow localhost/private-IP destinations. Required for dev API testing. Default false.'),
  max_response_bytes: z.number().int().min(1024).max(10_000_000).optional().describe('Response body download cap. Default 1048576 (1 MB).'),
  follow_redirects: z.boolean().optional().describe('Follow 3xx redirects. Default true.'),
  fullBody: z.boolean().describe('Return the ENTIRE response body in the result instead of the default head+tail excerpt (~6KB). Only set true when you actually need the full body content — status/header checks never need it. Default false.').optional(),
});

/** In-result body excerpt sizes (fullBody: false, the default). Status, headers
 *  and byte counts are ALWAYS reported in full — only the body is excerpted. */
const BODY_EXCERPT_HEAD = 4_000;
const BODY_EXCERPT_TAIL = 2_000;

const PRIVATE_HOST_RE = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|::1$|fc00::|fe80::)|\.local$/i;

export class HttpRequestTool extends Tool<z.infer<typeof HttpRequestArgs>> {
  name = 'http_request';
  description = 'Make an HTTP request to an external or local URL. For local dev APIs pass allow_local=true. Returns status, headers, and a head+tail excerpt (~6KB) of the response body with the total size noted — pass fullBody=true if you genuinely need the whole body (up to 1MB). Destructive when method is POST/PUT/PATCH/DELETE — those mutate remote state.';
  isReadOnly = false; // POST/PUT/DELETE mutate
  isDestructive = true;
  argsSchema = HttpRequestArgs;

  async execute(args: z.infer<typeof HttpRequestArgs>, ctx: ToolContext): Promise<ToolResult> {
    const method = args.method ?? 'GET';
    const timeoutMs = (args.timeout_seconds ?? 30) * 1000;
    const maxBytes = args.max_response_bytes ?? 1_048_576;

    // Build final URL with query string
    let urlStr = args.url;
    if (args.query) {
      const u = new URL(urlStr);
      for (const [k, v] of Object.entries(args.query)) u.searchParams.set(k, v);
      urlStr = u.toString();
    }

    let parsed: URL;
    try { parsed = new URL(urlStr); } catch {
      return { content: `[HTTP_REQUEST_ERROR] Invalid URL: ${urlStr}`, isError: true };
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { content: `[HTTP_REQUEST_ERROR] Only http:/https: allowed. Got: ${parsed.protocol}`, isError: true };
    }

    if (PRIVATE_HOST_RE.test(parsed.hostname) && !args.allow_local) {
      return {
        content: `[HTTP_REQUEST_BLOCKED] Refusing to call private host ${parsed.hostname}. Pass allow_local=true if this is intentional (dev API testing).`,
        isError: true,
      };
    }

    const startTime = Date.now();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort('timeout'), timeoutMs);
    // Cascade outer signal
    if (ctx.signal) {
      if (ctx.signal.aborted) abort.abort('cancelled');
      else ctx.signal.addEventListener('abort', () => abort.abort('cancelled'), { once: true });
    }

    try {
      const resp = await proxyFetch(urlStr, {
        method,
        headers: args.headers,
        body: args.body,
        signal: abort.signal,
        redirect: args.follow_redirects === false ? 'manual' : 'follow',
      });

      // Pick a subset of headers to surface
      const headersOut: Record<string, string> = {};
      const interesting = new Set(['content-type', 'content-length', 'content-encoding', 'cache-control', 'set-cookie', 'location', 'server', 'date', 'etag', 'last-modified', 'access-control-allow-origin', 'x-ratelimit-remaining', 'x-ratelimit-limit', 'x-request-id']);
      resp.headers.forEach((v, k) => { if (interesting.has(k.toLowerCase())) headersOut[k] = v; });

      // Read body up to cap
      const reader = resp.body?.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      let truncated = false;
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            received += value.byteLength;
            if (received > maxBytes) {
              chunks.push(value.slice(0, maxBytes - (received - value.byteLength)));
              truncated = true;
              try { await reader.cancel(); } catch { /* ignore */ }
              break;
            }
            chunks.push(value);
          }
        }
      }
      const buf = Buffer.concat(chunks.map(c => Buffer.from(c)));
      // Try to decode as utf-8 unless content-type says binary
      const ct = (resp.headers.get('content-type') ?? '').toLowerCase();
      const isBinary = /^(image|audio|video|application\/(octet-stream|pdf|zip|gzip|x-tar))/.test(ct);
      const body = isBinary ? `[binary, ${buf.byteLength} bytes${truncated ? ', truncated' : ''}]` : buf.toString('utf-8');

      const elapsed = Date.now() - startTime;

      const out: string[] = [];
      out.push(`# HTTP ${method} ${urlStr}`);
      out.push('');
      out.push(`Status: ${resp.status} ${resp.statusText}`);
      out.push(`Elapsed: ${elapsed}ms`);
      out.push(`Body: ${received.toLocaleString()} bytes${truncated ? ` (truncated at ${maxBytes.toLocaleString()})` : ''}`);
      out.push('');
      out.push(`## Headers`);
      for (const [k, v] of Object.entries(headersOut)) out.push(`  ${k}: ${v}`);
      out.push('');
      out.push(`## Body`);
      // Pretty-print JSON
      let bodyOut = body;
      if (!isBinary && /application\/json|\+json/.test(ct)) {
        try { bodyOut = JSON.stringify(JSON.parse(body), null, 2); }
        catch { /* not valid JSON — keep raw */ }
      }
      // Polite-at-the-source default: a status/header check ("is this URL 404?")
      // never needs 278KB of HTML in context. Unless the model asked for
      // fullBody, keep a head+tail excerpt (~6KB) and say how big the whole
      // thing was. The universal spill guard remains the backstop for the
      // fullBody path and for every other tool.
      const excerptLimit = BODY_EXCERPT_HEAD + BODY_EXCERPT_TAIL;
      if (!args.fullBody && bodyOut.length > excerptLimit) {
        const omitted = bodyOut.length - excerptLimit;
        bodyOut =
          bodyOut.slice(0, BODY_EXCERPT_HEAD) +
          `\n… [http_request body excerpt: ${received.toLocaleString()} bytes total, middle ${omitted.toLocaleString()} chars omitted — re-run with fullBody: true if you need the complete body] …\n` +
          bodyOut.slice(-BODY_EXCERPT_TAIL);
      }
      out.push(bodyOut);

      return {
        content: out.join('\n'),
        metadata: { status: resp.status, elapsedMs: elapsed, bytes: received, truncated, contentType: ct },
      };
    } catch (e: any) {
      const reason = abort.signal.reason === 'timeout' ? `timeout after ${timeoutMs}ms` :
                     abort.signal.reason === 'cancelled' ? 'cancelled by user' :
                     e?.message ?? String(e);
      return { content: `[HTTP_REQUEST_ERROR] ${reason}`, isError: true };
    } finally {
      clearTimeout(timer);
    }
  }
}
