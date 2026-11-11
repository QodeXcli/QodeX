/**
 * QodeX Desktop — a local shell on 127.0.0.1.
 * It reads the accessibility tree, presses one named control when you submit
 * the form, and shows sentinel / desk counts. It does not call a model and
 * it does not open a cloud browser.
 */
import * as http from 'http';
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { probeDesktop } from '../desk/policy.js';
import { listPending } from '../desk/sentinel.js';
import { loadBoard } from '../desk/store.js';
import { readResidentStatus } from '../resident/loop.js';
import { invokeNamed, readUiTree, type UiQuery } from '../tools/computer/access.js';
import { ComputerUseScreenshotTool } from '../tools/computer/use.js';

export interface ShellRoute {
  status: number;
  body: string | Buffer;
  contentType: string;
}

export interface ShellView {
  token: string;
  tree: string;
  result: string;
  shot: boolean;
  gui: string;
  access: string;
  note: string;
  desks: number;
  pending: number;
  resident: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '\u0026amp;')
    .replace(/</g, '\u0026lt;')
    .replace(/>/g, '\u0026gt;')
    .replace(/"/g, '\u0026quot;')
    .replace(/'/g, '\u0026#39;');
}

export function renderShellHtml(view: ShellView): string {
  const shot = view.shot
    ? `<img alt="screen" src="/shot?k=${view.token}"/>`
    : '<p class="muted">No screenshot yet.</p>';
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>QodeX Desktop</title>
<style>
  :root { color-scheme: dark; --bg:#0c0f0c; --panel:#161b16; --ink:#e8f2e4; --muted:#8b9b88; --line:#2a3328; --ok:#b6e38a; --bad:#e08b7a; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.45 ui-sans-serif, system-ui, sans-serif; background:var(--bg); color:var(--ink); }
  header { display:flex; justify-content:space-between; gap:16px; padding:16px 20px; border-bottom:1px solid var(--line); }
  h1 { margin:0; font-size:20px; letter-spacing:-0.03em; }
  .sub { color:var(--muted); margin:4px 0 0; }
  .meta { color:var(--muted); text-align:right; }
  main { display:grid; grid-template-columns: 280px 1fr; min-height: calc(100vh - 70px); }
  aside { border-right:1px solid var(--line); padding:16px; }
  section { padding:16px 20px; }
  form { display:flex; flex-direction:column; gap:8px; margin:12px 0; }
  input { background:#0c100c; color:var(--ink); border:1px solid var(--line); padding:8px; }
  button { background:var(--ok); color:#12200c; border:0; padding:8px 12px; font-weight:650; cursor:pointer; }
  pre { white-space:pre-wrap; background:var(--panel); border:1px solid var(--line); padding:12px; min-height:120px; }
  img { max-width:100%; border:1px solid var(--line); background:#000; }
  .muted { color:var(--muted); }
  @media (max-width: 800px) { main { grid-template-columns: 1fr; } }
</style>
<header>
  <div>
    <h1>QodeX Desktop</h1>
    <p class="sub">This window is the machine. No cloud browser, no rented VM. پوسته روی همین سیستم است.</p>
  </div>
  <div class="meta">
    <div>GUI ${escapeHtml(view.gui)} · access ${escapeHtml(view.access)}</div>
    <div>${view.desks} desks · ${view.pending} waiting</div>
    <div>${escapeHtml(view.resident)}</div>
  </div>
</header>
<main>
  <aside>
    <p class="muted">${escapeHtml(view.note)}</p>
    <form method="post" action="/act?k=${view.token}">
      <input type="hidden" name="action" value="tree"/>
      <input name="app" placeholder="App name, optional"/>
      <button>Read controls</button>
    </form>
    <form method="post" action="/act?k=${view.token}">
      <input type="hidden" name="action" value="invoke"/>
      <input name="name" placeholder="Control name" required minlength="2"/>
      <input name="role" placeholder="Role, optional"/>
      <input name="app" placeholder="App, optional"/>
      <button>Press this control</button>
    </form>
    <form method="post" action="/act?k=${view.token}">
      <input type="hidden" name="action" value="shot"/>
      <button>Screenshot</button>
    </form>
    <p class="muted">Pressing here is you. The agent still pauses on the sentinel when it presses by itself.</p>
  </aside>
  <section>
    ${shot}
    <h2>Controls</h2>
    <pre>${escapeHtml(view.tree || 'Read controls to list what the accessibility tree actually names.')}</pre>
    <h2>Last press</h2>
    <pre>${escapeHtml(view.result || 'Nothing pressed.')}</pre>
  </section>
</main>
</html>`;
}

function parseForm(raw: string): Record<string, string> {
  const params = new URLSearchParams(raw);
  const out: Record<string, string> = {};
  for (const [k, v] of params) out[k] = v;
  return out;
}

export interface ShellDeps {
  readTree: (app?: string) => Promise<{ ok: true; text: string } | { ok: false; error: string }>;
  invoke: (query: UiQuery) => Promise<{ content: string; isError?: boolean }>;
  shoot: () => Promise<{ ok: true; file: string } | { ok: false; error: string }>;
  shotFile: () => string | null;
  setShot: (file: string) => void;
}

async function defaultShoot(): Promise<{ ok: true; file: string } | { ok: false; error: string }> {
  const tool = new ComputerUseScreenshotTool();
  const result = await tool.execute({}, {} as never);
  const file = typeof result.metadata?.path === 'string' ? result.metadata.path : '';
  if (result.isError || !file) return { ok: false, error: result.content };
  return { ok: true, file };
}

export function defaultShellDeps(state: { shot: string | null }): ShellDeps {
  return {
    readTree: readUiTree,
    invoke: invokeNamed,
    shoot: defaultShoot,
    shotFile: () => state.shot,
    setShot: file => { state.shot = file; },
  };
}

export async function handleShell(opts: {
  method: string;
  pathname: string;
  tokenOk: boolean;
  rawBody: string;
  view: ShellView;
  deps: ShellDeps;
}): Promise<{ route: ShellRoute; view: ShellView }> {
  if (!opts.tokenOk) {
    return { view: opts.view, route: { status: 401, body: 'unauthorized', contentType: 'text/plain' } };
  }
  let view = opts.view;
  if (opts.method === 'POST' && opts.pathname === '/act') {
    const form = parseForm(opts.rawBody);
    if (form.action === 'tree') {
      const tree = await opts.deps.readTree(form.app || undefined);
      view = { ...view, tree: tree.ok ? tree.text : tree.error, result: view.result };
    } else if (form.action === 'invoke') {
      const pressed = await opts.deps.invoke({ name: form.name ?? '', role: form.role, app: form.app });
      view = { ...view, result: pressed.content };
    } else if (form.action === 'shot') {
      const shot = await opts.deps.shoot();
      if (shot.ok) opts.deps.setShot(shot.file);
      view = { ...view, result: shot.ok ? `screenshot ${shot.file}` : shot.error };
    } else {
      view = { ...view, result: 'unknown action' };
    }
  }
  if (opts.method === 'GET' && opts.pathname === '/shot') {
    const file = opts.deps.shotFile();
    if (!file) return { view, route: { status: 404, body: 'no screenshot', contentType: 'text/plain' } };
    const root = path.resolve(path.join(os.tmpdir(), 'qodex-screenshots'));
    const resolved = path.resolve(file);
    if (!resolved.startsWith(root + path.sep)) {
      return { view, route: { status: 403, body: 'refused', contentType: 'text/plain' } };
    }
    let realFile: string;
    let realRoot: string;
    try {
      realRoot = await fs.realpath(root);
      realFile = await fs.realpath(resolved);
    } catch {
      return { view, route: { status: 404, body: 'missing', contentType: 'text/plain' } };
    }
    if (!realFile.startsWith(realRoot + path.sep)) {
      return { view, route: { status: 403, body: 'refused', contentType: 'text/plain' } };
    }
    try {
      const buf = await fs.readFile(realFile);
      return { view, route: { status: 200, body: buf, contentType: 'image/png' } };
    } catch {
      return { view, route: { status: 404, body: 'missing', contentType: 'text/plain' } };
    }
  }
  if (opts.method === 'GET' && (opts.pathname === '/' || opts.pathname === '')) {
    return { view, route: { status: 200, body: renderShellHtml(view), contentType: 'text/html; charset=utf-8' } };
  }
  if (opts.method === 'POST' && opts.pathname === '/act') {
    return { view, route: { status: 303, body: '', contentType: 'text/plain' } };
  }
  return { view, route: { status: 404, body: 'not found', contentType: 'text/plain' } };
}

export interface DesktopShell { url: string; port: number; token: string; close: () => Promise<void>; }

export async function startDesktopShell(preferredPort = 0): Promise<DesktopShell> {
  const token = randomBytes(16).toString('hex');
  const state = { shot: null as string | null, tree: '', result: '' };
  const deps = defaultShellDeps(state);
  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const u = new URL(req.url ?? '/', 'http://127.0.0.1');
        const provided = u.searchParams.get('k') ?? req.headers['x-qodex-token'];
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const desktop = probeDesktop();
        const board = await loadBoard().catch(() => null);
        const pending = await listPending().catch(() => []);
        const resident = await readResidentStatus().catch(() => null);
        const view: ShellView = {
          token,
          tree: state.tree,
          result: state.result,
          shot: Boolean(state.shot),
          gui: desktop.gui,
          access: desktop.access,
          note: desktop.note,
          desks: board?.desks.length ?? 0,
          pending: pending.length,
          resident: resident ? (resident.running ? `resident pid ${resident.pid}` : 'resident stale') : 'resident off',
        };
        const handled = await handleShell({
          method: req.method ?? 'GET',
          pathname: u.pathname,
          tokenOk: provided === token,
          rawBody: Buffer.concat(chunks).toString('utf-8'),
          view,
          deps,
        });
        state.tree = handled.view.tree;
        state.result = handled.view.result;
        const headers: Record<string, string> = {
          'content-type': handled.route.contentType,
          'cache-control': 'no-store',
          'x-frame-options': 'DENY',
        };
        if (handled.route.status === 303) headers.location = `/?k=${token}`;
        res.writeHead(handled.route.status, headers);
        res.end(handled.route.body);
      } catch (e: any) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(e?.message ?? 'error');
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(preferredPort, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : preferredPort;
  return {
    port,
    token,
    url: `http://127.0.0.1:${port}/?k=${token}`,
    close: () => new Promise(r => server.close(() => r())),
  };
}
