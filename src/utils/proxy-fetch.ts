/**
 * Proxy-aware fetch wrapper.
 *
 * Node 20's built-in `fetch` does NOT honor HTTP_PROXY / HTTPS_PROXY / NO_PROXY
 * environment variables. This is a frequent surprise — users running QodeX from
 * networks that require a corporate proxy (or Iran ISPs that need Warp/v2ray
 * exposed over a localhost SOCKS-to-HTTP shim) see fetch() time out against
 * DuckDuckGo, Cloudflare, etc., even though `curl` works fine.
 *
 * Fix: when an HTTP/HTTPS proxy env var is set, route fetch through undici's
 * ProxyAgent. We honor:
 *   - HTTPS_PROXY / https_proxy    — used for https:// targets
 *   - HTTP_PROXY  / http_proxy     — used for http://  targets
 *   - ALL_PROXY  / all_proxy       — fallback for both
 *   - NO_PROXY   / no_proxy        — comma-separated bypass list
 *                                    (supports "*", exact match, and ".suffix")
 *
 * The dispatcher is created lazily on first use and cached. If env vars change
 * mid-process the cache is NOT invalidated — restart QodeX after changing them.
 *
 * Usage:
 *   import { proxyFetch } from '../utils/proxy-fetch.js';
 *   const res = await proxyFetch(url, { signal, headers });
 *
 * Drop-in compatible with global fetch for request/response shape.
 */
import { ProxyAgent, Agent, type Dispatcher } from 'undici';
import { logger } from './logger.js';

interface ProxyConfig {
  httpsProxy?: string;
  httpProxy?: string;
  noProxy: string[];
}

let cachedConfig: ProxyConfig | null = null;
let httpsDispatcher: Dispatcher | null = null;
let httpDispatcher: Dispatcher | null = null;
let noProxyDispatcher: Dispatcher | null = null;

function readConfig(): ProxyConfig {
  if (cachedConfig) return cachedConfig;
  const env = process.env;
  const httpsProxy = env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy;
  const httpProxy = env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy;
  const noProxyRaw = env.NO_PROXY || env.no_proxy || '';
  const noProxy = noProxyRaw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  cachedConfig = { httpsProxy, httpProxy, noProxy };
  if (httpsProxy || httpProxy) {
    logger.info('Proxy env detected', { httpsProxy: redact(httpsProxy), httpProxy: redact(httpProxy), noProxy });
  }
  return cachedConfig;
}

function redact(url: string | undefined): string | undefined {
  if (!url) return url;
  try { const u = new URL(url); if (u.password) u.password = '***'; return u.toString(); } catch { return url; }
}

function shouldBypass(hostname: string, noProxy: string[]): boolean {
  if (noProxy.length === 0) return false;
  const h = hostname.toLowerCase();
  for (const rule of noProxy) {
    if (rule === '*') return true;
    if (rule === h) return true;
    // ".foo.com" or "foo.com" → match exact and suffix
    const stripped = rule.startsWith('.') ? rule.slice(1) : rule;
    if (h === stripped) return true;
    if (h.endsWith('.' + stripped)) return true;
  }
  return false;
}

/**
 * Resolve the right dispatcher for a given URL. Returns:
 *   - a ProxyAgent dispatcher when the proxy env applies (and host isn't in NO_PROXY)
 *   - a plain Agent dispatcher when no proxy applies (so we still get a stable timeout default)
 *   - undefined when there's no proxy config and the caller can use the global default
 */
export function getDispatcherForUrl(targetUrl: string): Dispatcher | undefined {
  const cfg = readConfig();
  let parsed: URL;
  try { parsed = new URL(targetUrl); } catch { return undefined; }

  const candidate = parsed.protocol === 'https:' ? cfg.httpsProxy : cfg.httpProxy;
  if (!candidate) return undefined;
  if (shouldBypass(parsed.hostname, cfg.noProxy)) {
    if (!noProxyDispatcher) noProxyDispatcher = new Agent();
    return noProxyDispatcher;
  }

  if (parsed.protocol === 'https:') {
    if (!httpsDispatcher) httpsDispatcher = new ProxyAgent({ uri: candidate });
    return httpsDispatcher;
  }
  if (!httpDispatcher) httpDispatcher = new ProxyAgent({ uri: candidate });
  return httpDispatcher;
}

/**
 * fetch() drop-in that honors HTTP(S)_PROXY env vars via undici's dispatcher option.
 * Falls through to the global fetch when no proxy applies.
 */
export async function proxyFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input.toString();
  const dispatcher = getDispatcherForUrl(url);
  if (!dispatcher) return fetch(input, init);
  // Node's fetch accepts a `dispatcher` option via the undici-bridge but TypeScript's
  // built-in lib.dom RequestInit doesn't know about it. Cast through any.
  return fetch(input, { ...(init ?? {}), dispatcher } as any);
}

/** Test/debug helper: force-reset the cached config + dispatchers. */
export function _resetProxyCacheForTesting(): void {
  cachedConfig = null;
  httpsDispatcher = null;
  httpDispatcher = null;
  noProxyDispatcher = null;
}
