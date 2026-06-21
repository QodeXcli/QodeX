/**
 * In-process registry of live artifact servers, keyed by artifact id.
 *
 * Mirrors the lifecycle of src/tools/browser/process-registry.ts (start / stop / stopAll /
 * list + process exit/SIGINT cleanup), but holds in-process http.Server handles rather than
 * child processes — process-registry kills PIDs, which doesn't fit a server living in our
 * own process.
 */
import { createLiveServer, type LiveServerHandle, type CreateLiveServerOptions } from './live-server.js';

export interface StartLiveOptions extends CreateLiveServerOptions {
  /** If a server for this id is already running, replace it instead of reusing it. */
  replace?: boolean;
}

export interface LiveInfo {
  id: string;
  url: string;
  port: number;
  uptimeMs: number;
  clientCount: number;
}

const servers = new Map<string, LiveServerHandle>();

function infoFor(h: LiveServerHandle): LiveInfo {
  return { id: h.id, url: h.url, port: h.port, uptimeMs: Date.now() - h.startedAt, clientCount: h.clientCount() };
}

/**
 * Start (or reuse) a live server for an artifact. Reuse keeps the user's open browser tab
 * and its SSE connection alive — nothing about the server is version-bound, so a second
 * `artifact_live` for the same id should NOT drop the existing one.
 */
export async function startLive(opts: StartLiveOptions): Promise<LiveInfo> {
  const existing = servers.get(opts.id);
  if (existing && !opts.replace) return infoFor(existing);
  if (existing) { await existing.close().catch(() => {}); servers.delete(opts.id); }

  const handle = await createLiveServer(opts);
  servers.set(opts.id, handle);
  return infoFor(handle);
}

export async function stopLive(id: string): Promise<boolean> {
  const h = servers.get(id);
  if (!h) return false;
  servers.delete(id);
  await h.close().catch(() => {});
  return true;
}

export async function stopAllLive(): Promise<void> {
  const all = Array.from(servers.values());
  servers.clear();
  await Promise.all(all.map(h => h.close().catch(() => {})));
}

export function listLive(): LiveInfo[] {
  return Array.from(servers.values()).map(infoFor);
}

export function getLive(id: string): LiveServerHandle | undefined {
  return servers.get(id);
}

// Best-effort cleanup so live servers don't linger after QodeX exits. 'exit' must be
// synchronous — fire close() without awaiting; the event loop is already winding down.
function cleanupSync(): void {
  for (const h of servers.values()) {
    try { void h.close(); } catch { /* ignore */ }
  }
  servers.clear();
}
process.on('exit', cleanupSync);
process.on('SIGINT', () => { cleanupSync(); });
