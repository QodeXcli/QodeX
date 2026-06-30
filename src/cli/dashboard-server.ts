/**
 * Dashboard control server — serves the interactive dashboard and a tiny JSON API that drives
 * the action registry (dashboard-control.ts). This is what makes the dashboard CONTROL, not just
 * view: toggles and buttons POST `{action, params}` and the agent's real stores/config change.
 *
 * Security (this mutates config + memory on your box, so it matters):
 *   - binds to 127.0.0.1 only — never exposed on the network.
 *   - every request must carry a random per-launch token (?k= or x-qodex-token); without it the
 *     server 401s. Stops other local apps / browser tabs from poking the API (CSRF-ish).
 *
 * The route handler is factored out (handleRequest) so it's unit-testable without a real socket.
 */
import * as http from 'http';
import { randomBytes } from 'crypto';
import { dispatchAction } from './dashboard-control.js';

export interface DashboardServer { url: string; port: number; token: string; close: () => Promise<void>; }

export interface RouteResult { status: number; body: string; contentType: string; }

/** Pure-ish request router: (method, pathname, token-ok, json body) → response. Used by the
 *  server and by tests. `renderHtml` / `getState` are injected so this stays decoupled. */
export async function handleRequest(
  opts: {
    method: string; pathname: string; tokenOk: boolean; body: any; cwd: string;
    renderHtml: () => Promise<string>; getState: () => Promise<any>;
  },
): Promise<RouteResult> {
  const json = (status: number, obj: any): RouteResult => ({ status, body: JSON.stringify(obj), contentType: 'application/json' });
  if (!opts.tokenOk) return json(401, { ok: false, message: 'Unauthorized — missing or bad token.' });

  if (opts.method === 'GET' && (opts.pathname === '/' || opts.pathname === '')) {
    return { status: 200, body: await opts.renderHtml(), contentType: 'text/html; charset=utf-8' };
  }
  if (opts.method === 'GET' && opts.pathname === '/api/state') {
    return json(200, { ok: true, state: await opts.getState() });
  }
  if (opts.method === 'POST' && opts.pathname === '/api/action') {
    const name = String(opts.body?.action ?? '');
    if (!name) return json(400, { ok: false, message: 'Missing action.' });
    const result = await dispatchAction(name, opts.body?.params ?? {}, opts.cwd);
    return json(result.ok ? 200 : 400, result);
  }
  return json(404, { ok: false, message: 'Not found.' });
}

/** Start the control server on 127.0.0.1. `renderHtml`/`getState` close over the token so the
 *  page can call the API. Returns a handle with the tokened URL. */
export async function startDashboardServer(opts: {
  cwd: string;
  preferredPort?: number;
  buildHtml: (token: string) => Promise<string>;
  getState: () => Promise<any>;
}): Promise<DashboardServer> {
  const token = randomBytes(16).toString('hex');

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const u = new URL(req.url ?? '/', 'http://127.0.0.1');
        const provided = u.searchParams.get('k') ?? req.headers['x-qodex-token'];
        const tokenOk = provided === token;

        let body: any = undefined;
        if (req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const raw = Buffer.concat(chunks).toString('utf-8');
          try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
        }

        const result = await handleRequest({
          method: req.method ?? 'GET', pathname: u.pathname, tokenOk, body, cwd: opts.cwd,
          renderHtml: () => opts.buildHtml(token), getState: opts.getState,
        });
        res.writeHead(result.status, { 'content-type': result.contentType, 'cache-control': 'no-store' });
        res.end(result.body);
      } catch (e: any) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, message: e?.message ?? 'error' }));
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.preferredPort ?? 0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : (opts.preferredPort ?? 0);
  return {
    port, token,
    url: `http://127.0.0.1:${port}/?k=${token}`,
    close: () => new Promise<void>(r => server.close(() => r())),
  };
}
