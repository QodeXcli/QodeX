/**
 * Live artifact server — an in-process node:http server that serves an artifact's CURRENT
 * version (rebuilt on the fly) and hot-reloads the browser over SSE when the artifact
 * changes on disk.
 *
 * Why in-process Node (not python3 like artifact_preview): one process can serve the page,
 * watch the artifact dir, and push reloads through a held-open SSE connection — no extra
 * dependency, no external runtime. The source of truth is `manifest.current`, re-read on
 * every request, so version bumps (artifact_update) AND rollbacks both reflect live.
 *
 * The watch → debounce → rebuild → hash → push algorithm:
 *   1. fs.watch the artifact DIRECTORY (atomic-write renames a temp over manifest.json, so
 *      a file-level watch on the old inode would be lost). Filter to manifest.json / new vN.
 *   2. Debounce events (~120ms) — atomic rename double-fires and rapid edits collapse to one.
 *   3. Rebuild the served HTML; hash it. If unchanged from the last push, skip (dedupes the
 *      rename double event and no-op rewrites). Otherwise push a `reload` SSE event.
 *   4. The browser reloads → fresh GET / re-renders current. We push a SIGNAL, not HTML, so
 *      served bytes always match a real request.
 */
import { createServer, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { watch as fsWatch, type FSWatcher } from 'node:fs';
import * as path from 'node:path';
import { getArtifact, artifactsRoot } from './store.js';
import { buildPreviewHtml } from './preview.js';
import { injectLiveReload, renderErrorOverlay, LIVE_CHANNEL_PATH } from './live-reload.js';
import { logger } from '../utils/logger.js';

export interface CreateLiveServerOptions {
  cwd: string;
  id: string;
  /** Preferred port; on EADDRINUSE we fall back to an OS-assigned ephemeral port. */
  port: number;
  channelPath?: string;
  debounceMs?: number;
  host?: string;
}

export interface LiveServerHandle {
  id: string;
  url: string;
  port: number;
  startedAt: number;
  clientCount: () => number;
  close: () => Promise<void>;
}

/** sha1 of the served HTML — the single comparison that correctly dedupes updates,
 *  rollbacks (same source, moved pointer), no-op rewrites, and the error overlay. */
export function hashHtml(html: string): string {
  return createHash('sha1').update(html).digest('hex');
}

/** Pure push decision, extracted for unit testing. */
export function shouldPush(prevHash: string | null, nextHash: string): boolean {
  return prevHash !== nextHash;
}

/** A trailing debouncer: N rapid calls collapse into one invocation after `ms` of quiet.
 *  Returned function exposes `.cancel()` to clear a pending call (used on close). */
export function makeDebouncer(fn: () => void, ms: number): (() => void) & { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const debounced = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(); }, ms);
  };
  debounced.cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  return debounced;
}

/** Build the page served for GET / : current version → preview HTML → live-reload injected.
 *  Any failure becomes a valid error-overlay page (still hashable, still self-recovering). */
async function renderCurrent(cwd: string, id: string, channelPath: string): Promise<string> {
  try {
    const { manifest, content } = await getArtifact(cwd, id);
    return injectLiveReload(buildPreviewHtml(manifest.type, content), channelPath);
  } catch (e: any) {
    return renderErrorOverlay(e?.message ?? String(e), channelPath);
  }
}

export async function createLiveServer(opts: CreateLiveServerOptions): Promise<LiveServerHandle> {
  const { cwd, id } = opts;
  const channelPath = opts.channelPath ?? LIVE_CHANNEL_PATH;
  const debounceMs = opts.debounceMs ?? 120;
  const host = opts.host ?? '127.0.0.1';
  const artifactDir = path.join(artifactsRoot(cwd), id);

  const clients = new Set<ServerResponse>();
  let lastHash: string | null = null;
  let closed = false;

  const pushReload = (hash: string) => {
    const frame = `event: reload\ndata: ${hash}\n\n`;
    for (const res of clients) {
      try { res.write(frame); } catch { /* dropped client; pruned on its 'close' */ }
    }
  };

  const flush = () => {
    void renderCurrent(cwd, id, channelPath).then(html => {
      const h = hashHtml(html);
      if (!shouldPush(lastHash, h)) return; // dedupe rename double-fire / no-op rewrites
      lastHash = h;
      pushReload(h);
    }).catch(err => logger.warn('Live artifact flush failed', { id, err: err?.message ?? String(err) }));
  };
  const debouncedFlush = makeDebouncer(flush, debounceMs);

  // ── HTTP server ──────────────────────────────────────────────────────────
  const server: Server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === channelPath || url.startsWith(channelPath + '?')) {
      // SSE channel: keep open, push reload events.
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
      });
      res.flushHeaders?.();
      res.write('retry: 1000\n\n');
      res.write(': connected\n\n');
      clients.add(res);
      const heartbeat = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { /* ignore */ }
      }, 25_000);
      const cleanup = () => { clearInterval(heartbeat); clients.delete(res); };
      req.on('close', cleanup);
      req.on('error', cleanup);
      return;
    }
    // Everything else → the current page.
    void renderCurrent(cwd, id, channelPath).then(html => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    }).catch(err => {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Live render error: ${err?.message ?? String(err)}`);
    });
  });

  // ── Listen, with EADDRINUSE fallback to an ephemeral port ────────────────
  const listenOn = (port: number) => new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => { server.removeListener('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
  try {
    await listenOn(opts.port);
  } catch (e: any) {
    if (e?.code === 'EADDRINUSE') {
      await listenOn(0); // OS-assigned; we report the real port below
    } else {
      throw e;
    }
  }
  const addr = server.address();
  const actualPort = addr && typeof addr === 'object' ? addr.port : opts.port;
  const url = `http://${host}:${actualPort}/`;

  // ── File watch on the artifact dir ───────────────────────────────────────
  // Watch the DIR (atomic rename swaps manifest.json's inode). Qualify events to the
  // manifest or a new version folder; the manifest is rewritten on every update/rollback.
  let watcher: FSWatcher | null = null;
  try {
    watcher = fsWatch(artifactDir, { persistent: false }, (_event, filename) => {
      if (closed) return;
      const f = filename ? filename.toString() : '';
      if (f === 'manifest.json' || f === '' || /^v\d/.test(f)) debouncedFlush();
    });
    watcher.on('error', err => logger.warn('Live artifact watcher error', { id, err: (err as any)?.message ?? String(err) }));
  } catch (e: any) {
    logger.warn('Live artifact watch could not start (updates will not auto-reload)', { id, err: e?.message ?? String(e) });
  }

  // Seed lastHash so the first real change pushes, but an initial no-op event doesn't.
  lastHash = hashHtml(await renderCurrent(cwd, id, channelPath));

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    debouncedFlush.cancel();
    try { watcher?.close(); } catch { /* ignore */ }
    for (const res of clients) { try { res.end(); } catch { /* ignore */ } }
    clients.clear();
    await new Promise<void>(resolve => server.close(() => resolve()));
  };

  return {
    id,
    url,
    port: actualPort,
    startedAt: Date.now(),
    clientCount: () => clients.size,
    close,
  };
}
