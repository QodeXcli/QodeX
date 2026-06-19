/**
 * Network connectivity diagnostics.
 *
 * Why this exists: in v0.5.x we kept seeing situations where the model would
 * retry `web_search` 10+ times against a backend that wasn't reachable (ISP
 * blocks, VPN-required endpoints, server down). v0.5.8 added a circuit breaker
 * but doesn't proactively check. v0.6.1 adds proactive probes so:
 *
 *   1. The startup banner can show "internet: ok / blocked / unknown"
 *   2. A new `network_check` tool lets the model self-diagnose before retrying
 *   3. A `/network` slash command lets the user run a full diagnostic any time
 *
 * Design principles:
 *   - All probes time out fast (default 2s) so a single hang doesn't stall QodeX.
 *   - Probes run in parallel where possible.
 *   - Results are STRUCTURED, not log strings — the model gets to reason over them.
 *   - We probe multiple endpoints because one being down doesn't mean offline
 *     (ISP-level blocks, Cloudflare regional outages, etc).
 */

import { logger } from './logger.js';
import { proxyFetch } from './proxy-fetch.js';

export type ProbeStatus = 'ok' | 'timeout' | 'http_error' | 'dns_failed' | 'connection_refused' | 'unknown_error';

export interface ProbeResult {
  /** The endpoint that was probed (e.g. "https://1.1.1.1"). */
  endpoint: string;
  /** Short label for display. */
  label: string;
  /** What happened. */
  status: ProbeStatus;
  /** HTTP status code if we got one. */
  httpCode?: number;
  /** Round-trip in milliseconds (only meaningful on 'ok'). */
  latencyMs?: number;
  /** Raw error message for diagnostic display. */
  error?: string;
}

export interface NetworkDiagnostic {
  /** Overall: is the machine ONLINE at all? Based on Cloudflare 1.1.1.1 reachability. */
  internet: 'ok' | 'blocked' | 'unknown';
  /** Per-endpoint detail. */
  probes: ProbeResult[];
  /** ms since epoch when this run finished. */
  timestamp: number;
}

/**
 * Endpoints we probe for general internet reachability.
 *
 * Why these specifically:
 *   - 1.1.1.1 (Cloudflare DNS): nearly always up worldwide, simple HEAD response
 *   - 8.8.8.8 (Google DNS):     ditto, different anycast network
 *   - github.com:               primary content host for development; often blocked in restrictive ISPs
 *   - duckduckgo.com:           primary web_search backend; known blocked from some regions
 *   - huggingface.co:           model downloads; known throttled from some regions
 *   - api.anthropic.com:        Claude (cloud sub-agent target)
 *   - api.openai.com:           GPT (cloud sub-agent target)
 *
 * We don't probe localhost backends here — those have their own dedicated checks.
 */
const PUBLIC_ENDPOINTS: Array<{ url: string; label: string }> = [
  { url: 'https://1.1.1.1', label: 'Cloudflare (general internet)' },
  { url: 'https://github.com', label: 'GitHub' },
  { url: 'https://duckduckgo.com', label: 'DuckDuckGo (web_search default)' },
  { url: 'https://huggingface.co', label: 'HuggingFace (model downloads)' },
  { url: 'https://api.anthropic.com', label: 'Anthropic API' },
  { url: 'https://api.openai.com', label: 'OpenAI API' },
];

const LOCAL_ENDPOINTS: Array<{ url: string; label: string }> = [
  { url: 'http://localhost:11434/api/tags', label: 'Ollama daemon' },
  { url: 'http://127.0.0.1:1234/v1/models', label: 'LM Studio / llama.cpp' },
];

const DEFAULT_TIMEOUT_MS = 2000;

/**
 * Probe a single endpoint with HEAD (fall back to GET if HEAD is rejected).
 * Returns a structured result. Never throws — failures become statuses.
 */
export async function probeEndpoint(
  endpoint: string,
  label: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ProbeResult> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Try HEAD first (lighter on the server). Many CDNs reject HEAD on some
    // paths, so on 405 fall back to GET.
    let response: Response;
    try {
      response = await proxyFetch(endpoint, { method: 'HEAD', signal: controller.signal, redirect: 'follow' });
      if (response.status === 405) {
        response = await proxyFetch(endpoint, { method: 'GET', signal: controller.signal, redirect: 'follow' });
      }
    } catch (e: any) {
      // Some servers don't speak HEAD at all (close the connection); try GET.
      if (!controller.signal.aborted) {
        response = await proxyFetch(endpoint, { method: 'GET', signal: controller.signal, redirect: 'follow' });
      } else {
        throw e;
      }
    }
    const latencyMs = Date.now() - start;
    return {
      endpoint,
      label,
      status: response.ok || (response.status >= 200 && response.status < 500) ? 'ok' : 'http_error',
      httpCode: response.status,
      latencyMs,
    };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    const aborted = controller.signal.aborted;
    let status: ProbeStatus = 'unknown_error';
    if (aborted) status = 'timeout';
    else if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) status = 'dns_failed';
    else if (/ECONNREFUSED/i.test(msg)) status = 'connection_refused';
    return {
      endpoint,
      label,
      status,
      error: msg,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run probes against all public endpoints in parallel.
 * Result is returned as a structured diagnostic; never throws.
 */
export async function checkPublicConnectivity(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<NetworkDiagnostic> {
  const probes = await Promise.all(
    PUBLIC_ENDPOINTS.map(e => probeEndpoint(e.url, e.label, timeoutMs)),
  );
  // "Internet" = can we reach Cloudflare 1.1.1.1? Other probes can be blocked
  // by ISP without that meaning the machine is offline.
  const cf = probes.find(p => p.endpoint === 'https://1.1.1.1');
  let internet: 'ok' | 'blocked' | 'unknown' = 'unknown';
  if (cf?.status === 'ok') internet = 'ok';
  else if (cf?.status === 'dns_failed' || cf?.status === 'connection_refused') internet = 'blocked';
  else if (probes.some(p => p.status === 'ok')) internet = 'ok'; // CF blocked but something works
  return { internet, probes, timestamp: Date.now() };
}

/**
 * Quick probe of local model backends. Used by startup banner so we can tell
 * the user "Ollama: up, LM Studio: down" before they hit a confusing error.
 */
export async function checkLocalBackends(timeoutMs = 1000): Promise<ProbeResult[]> {
  return Promise.all(LOCAL_ENDPOINTS.map(e => probeEndpoint(e.url, e.label, timeoutMs)));
}

/**
 * Combined check used by the `/network` slash command.
 */
export async function runFullDiagnostic(): Promise<{
  public: NetworkDiagnostic;
  local: ProbeResult[];
}> {
  const [publicDiag, local] = await Promise.all([
    checkPublicConnectivity(),
    checkLocalBackends(),
  ]);
  return { public: publicDiag, local };
}

/**
 * Pretty-format a diagnostic for terminal display. Used by both `/network`
 * and the startup banner.
 */
export function formatDiagnostic(d: { public: NetworkDiagnostic; local: ProbeResult[] }): string {
  const lines: string[] = [];
  const ok = (s: ProbeStatus) => s === 'ok';
  const symbol = (s: ProbeStatus) => ok(s) ? '✓' : s === 'timeout' ? '⏱' : s === 'connection_refused' ? '✗' : s === 'dns_failed' ? '?' : '✗';
  const internetLabel =
    d.public.internet === 'ok' ? 'Online ✓'
    : d.public.internet === 'blocked' ? 'Offline (Cloudflare unreachable)'
    : 'Status unclear';
  lines.push(`Internet: ${internetLabel}`);
  lines.push('');
  lines.push('Public endpoints:');
  for (const p of d.public.probes) {
    const detail = ok(p.status)
      ? `${p.latencyMs}ms${p.httpCode ? ` HTTP ${p.httpCode}` : ''}`
      : p.status;
    lines.push(`  ${symbol(p.status)} ${p.label.padEnd(38)} ${detail}`);
  }
  lines.push('');
  lines.push('Local backends:');
  for (const p of d.local) {
    const detail = ok(p.status) ? `${p.latencyMs}ms` : p.status;
    lines.push(`  ${symbol(p.status)} ${p.label.padEnd(38)} ${detail}`);
  }

  // Suggestions based on what we saw
  const blocked = d.public.probes.filter(p => !ok(p.status));
  if (blocked.length > 0) {
    lines.push('');
    lines.push('Notes:');
    const ddg = d.public.probes.find(p => p.endpoint.includes('duckduckgo'));
    const hf = d.public.probes.find(p => p.endpoint.includes('huggingface'));
    if (ddg && !ok(ddg.status)) {
      lines.push('  • DuckDuckGo unreachable — web_search will return [NO_RESULTS]. ' +
                 'Try a different backend (Tavily, Brave) or enable Cloudflare Warp.');
    }
    if (hf && !ok(hf.status)) {
      lines.push('  • HuggingFace unreachable — model downloads via `hf download` ' +
                 'will be slow or fail. Try `HF_ENDPOINT=https://hf-mirror.com` or Warp.');
    }
  }
  return lines.join('\n');
}

/**
 * Short single-line status for the startup banner.
 * Examples:
 *   "internet: ok · ollama: up · lm-studio: up"
 *   "internet: blocked · ollama: down · lm-studio: down"
 *   "internet: ok · ollama: up · lm-studio: down"
 */
export function formatBannerStatus(d: { public: NetworkDiagnostic; local: ProbeResult[] }): string {
  const parts: string[] = [];
  parts.push(`internet: ${d.public.internet}`);
  const ollama = d.local.find(p => p.endpoint.includes('11434'));
  const lmStudio = d.local.find(p => p.endpoint.includes('1234'));
  if (ollama) parts.push(`ollama: ${ollama.status === 'ok' ? 'up' : 'down'}`);
  if (lmStudio) parts.push(`lm-studio: ${lmStudio.status === 'ok' ? 'up' : 'down'}`);
  return parts.join(' · ');
}

/**
 * Quick non-blocking check used by web_search and similar tools to short-circuit
 * retries when we KNOW the backend isn't reachable. Returns true if the given
 * host is reachable, false otherwise. Caches results for 30s to avoid spamming
 * the network during a single agent turn.
 */
const reachabilityCache = new Map<string, { ok: boolean; expires: number }>();

export async function isHostReachable(url: string, timeoutMs = 1500): Promise<boolean> {
  const host = (() => { try { return new URL(url).hostname; } catch { return url; } })();
  const cached = reachabilityCache.get(host);
  const now = Date.now();
  if (cached && cached.expires > now) return cached.ok;
  const r = await probeEndpoint(url, host, timeoutMs);
  const ok = r.status === 'ok';
  reachabilityCache.set(host, { ok, expires: now + 30_000 });
  if (!ok) logger.debug(`Host unreachable cache: ${host}`, { status: r.status, error: r.error });
  return ok;
}
