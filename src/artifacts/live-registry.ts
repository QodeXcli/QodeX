/**
 * In-process registry of live artifact servers, keyed by artifact id.
 *
 * Mirrors the lifecycle of src/tools/browser/process-registry.ts (start / stop / stopAll /
 * list + process exit/SIGINT cleanup), but holds in-process http.Server handles rather than
 * child processes — process-registry kills PIDs, which doesn't fit a server living in our
 * own process. Each entry may also own a tunnel child process (closed alongside the server).
 */
import { createLiveServer, type LiveServerHandle, type CreateLiveServerOptions } from './live-server.js';
import { lanUrls, startTunnel, type TunnelHandle } from './live-share.js';

export interface StartLiveOptions extends CreateLiveServerOptions {
  /** If a server for this id is already running, replace it instead of reusing it. */
  replace?: boolean;
  /** Include same-network (LAN) URLs in the result (the server host should be 0.0.0.0). */
  lan?: boolean;
  /** Also open a public tunnel link (cloudflared → ngrok). Best paired with a token. */
  tunnel?: boolean;
}

export interface LiveInfo {
  id: string;
  url: string;            // owner URL (loopback, token-bearing when gated)
  port: number;
  token?: string;
  uptimeMs: number;
  clientCount: number;
  /** All shareable URLs: owner + LAN (if requested) + tunnel (if up). */
  urls: string[];
  tunnelUrl?: string;
  tunnelError?: string;   // set when a tunnel was requested but couldn't start
}

interface Entry {
  handle: LiveServerHandle;
  urls: string[];
  tunnel?: TunnelHandle;
  tunnelUrl?: string;
  tunnelError?: string;
}

const servers = new Map<string, Entry>();

function infoFor(e: Entry): LiveInfo {
  return {
    id: e.handle.id,
    url: e.handle.url,
    port: e.handle.port,
    token: e.handle.token,
    uptimeMs: Date.now() - e.handle.startedAt,
    clientCount: e.handle.clientCount(),
    urls: e.urls,
    tunnelUrl: e.tunnelUrl,
    tunnelError: e.tunnelError,
  };
}

async function closeEntry(e: Entry): Promise<void> {
  try { e.tunnel?.close(); } catch { /* tunnel already gone */ }
  await e.handle.close().catch(() => {});
}

/**
 * Start (or reuse) a live server for an artifact. Reuse keeps the user's open browser tab
 * and its SSE connection alive — nothing about the server is version-bound, so a second
 * `artifact_live` for the same id should NOT drop the existing one.
 */
export async function startLive(opts: StartLiveOptions): Promise<LiveInfo> {
  const existing = servers.get(opts.id);
  if (existing && !opts.replace) return infoFor(existing);
  if (existing) { await closeEntry(existing); servers.delete(opts.id); }

  const handle = await createLiveServer(opts);
  const entry: Entry = { handle, urls: [handle.url] };
  if (opts.lan) entry.urls.push(...lanUrls(handle.port, handle.token));
  if (opts.tunnel) {
    try {
      entry.tunnel = await startTunnel(handle.port);
      entry.tunnelUrl = `${entry.tunnel.url}/${handle.token ? `?k=${handle.token}` : ''}`;
      entry.urls.push(entry.tunnelUrl);
    } catch (e: any) {
      entry.tunnelError = e?.message ?? String(e); // best-effort: LAN/owner URLs still work
    }
  }
  servers.set(opts.id, entry);
  return infoFor(entry);
}

export async function stopLive(id: string): Promise<boolean> {
  const e = servers.get(id);
  if (!e) return false;
  servers.delete(id);
  await closeEntry(e);
  return true;
}

export async function stopAllLive(): Promise<void> {
  const all = Array.from(servers.values());
  servers.clear();
  await Promise.all(all.map(closeEntry));
}

export function listLive(): LiveInfo[] {
  return Array.from(servers.values()).map(infoFor);
}

export function getLive(id: string): LiveServerHandle | undefined {
  return servers.get(id)?.handle;
}

// Best-effort cleanup so live servers + tunnels don't linger after QodeX exits. 'exit' must
// be synchronous — fire close() without awaiting; the event loop is already winding down.
function cleanupSync(): void {
  for (const e of servers.values()) {
    try { e.tunnel?.close(); } catch { /* ignore */ }
    try { void e.handle.close(); } catch { /* ignore */ }
  }
  servers.clear();
}
process.on('exit', cleanupSync);
process.on('SIGINT', () => { cleanupSync(); });
