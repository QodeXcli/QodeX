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
import { listPending, decideSentinel } from '../desk/sentinel.js';
import { loadBoard } from '../desk/store.js';
import { readResidentStatus } from '../resident/loop.js';
import { invokeNamed, readUiTree, type UiQuery } from '../tools/computer/access.js';
import { ComputerUseScreenshotTool } from '../tools/computer/use.js';

export interface ShellRoute {
  status: number;
  body: string | Buffer;
  contentType: string;
}

export interface ShellControl {
  app: string;
  role: string;
  name: string;
  enabled: boolean;
  value: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ShellWait {
  id: string;
  kind: string;
  reason: string;
  prompt: string;
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
  controls: ShellControl[];
  capped: boolean;
  waits: ShellWait[];
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '\u0026amp;')
    .replace(/</g, '\u0026lt;')
    .replace(/>/g, '\u0026gt;')
    .replace(/"/g, '\u0026quot;')
    .replace(/'/g, '\u0026#39;');
}

/** verified is success. unverified and errors are not. Empty is idle. */
export function resultTone(result: string): 'ok' | 'bad' | 'idle' {
  if (!result.trim()) return 'idle';
  if (/unverified|COMPUTER_USE_ERROR|refused|not decided|\berror\b/i.test(result)) return 'bad';
  if (/verified:/.test(result)) return 'ok';
  return 'idle';
}

function controlRows(view: ShellView): string {
  if (view.controls.length === 0) {
    return `<div class="empty">
      <p>No controls on screen yet.</p>
      <p class="muted">Read the tree. Rows appear only for names the accessibility backend actually returned.</p>
    </div>`;
  }
  return view.controls.map(c => {
    const hit = escapeHtml(`${c.name} ${c.role} ${c.app}`.toLowerCase());
    const off = c.enabled ? '' : '<span class="chip dim">disabled</span>';
    const value = c.value ? `<span class="val">${escapeHtml(c.value)}</span>` : '';
    return `<article class="row" data-hit="${hit}">
      <div>
        <div class="who"><span class="chip">${escapeHtml(c.role || 'control')}</span>${off}<strong>${escapeHtml(c.name)}</strong></div>
        <div class="where">${escapeHtml(c.app || 'app')} · ${c.x},${c.y} · ${c.w}×${c.h}${value ? ' · ' + value : ''}</div>
      </div>
      <form method="post" action="/act?k=${view.token}">
        <input type="hidden" name="action" value="invoke"/>
        <input type="hidden" name="name" value="${escapeHtml(c.name)}"/>
        <input type="hidden" name="role" value="${escapeHtml(c.role)}"/>
        <input type="hidden" name="app" value="${escapeHtml(c.app)}"/>
        <button>Press</button>
      </form>
    </article>`;
  }).join('');
}

function waitRows(view: ShellView): string {
  if (view.waits.length === 0) {
    return '<p class="muted">Nothing is waiting. The agent is not asking.</p>';
  }
  return view.waits.map(w => `<article class="wait">
    <div class="who"><span class="chip waitchip">${escapeHtml(w.kind)}</span><code>${escapeHtml(w.id)}</code></div>
    <p>${escapeHtml(w.reason)}</p>
    <p class="prompt">${escapeHtml(w.prompt)}</p>
    <div class="pair">
      <form method="post" action="/act?k=${view.token}">
        <input type="hidden" name="action" value="allow"/>
        <input type="hidden" name="id" value="${escapeHtml(w.id)}"/>
        <button>Allow</button>
      </form>
      <form method="post" action="/act?k=${view.token}">
        <input type="hidden" name="action" value="deny"/>
        <input type="hidden" name="id" value="${escapeHtml(w.id)}"/>
        <button class="ghost">Deny</button>
      </form>
    </div>
  </article>`).join('');
}

export function renderShellHtml(view: ShellView): string {
  const tone = resultTone(view.result);
  const shot = view.shot
    ? `<img alt="This machine, just now" src="/shot?k=${view.token}"/>`
    : '<div class="stage-empty">No screenshot yet. Capture shows this screen, not a remote browser.</div>';
  const cap = view.capped ? '<p class="muted">List capped. Narrow it with an app name.</p>' : '';
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>QodeX Desktop</title>
<style>
  :root { color-scheme: dark; --bg:#10110f; --panel:#181a16; --ink:#f4f1ea; --muted:#9c988e; --line:#2e312a; --accent:#e4ff57; --ok:#c8f08a; --bad:#ff8f7a; --wait:#f0c36a; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.45 "Segoe UI", ui-sans-serif, system-ui, sans-serif; }
  header { display:flex; justify-content:space-between; gap:24px; align-items:end; padding:18px 22px 14px; border-bottom:1px solid var(--line); position:sticky; top:0; background:var(--bg); }
  h1 { margin:0; font-size:22px; letter-spacing:-0.04em; font-weight:650; }
  h1 span { color:var(--accent); }
  .sub { margin:4px 0 0; color:var(--muted); max-width:46rem; }
  .pills { display:flex; flex-wrap:wrap; gap:6px; justify-content:flex-end; }
  .pill { border:1px solid var(--line); background:var(--panel); padding:4px 8px; color:var(--muted); }
  main { display:grid; grid-template-columns: 300px minmax(0,1fr) 340px; min-height: calc(100vh - 78px); }
  aside, .stage { border-right:1px solid var(--line); padding:16px; }
  .stage { border-right:0; border-left:1px solid var(--line); }
  h2 { margin:0 0 10px; font-size:12px; letter-spacing:0.14em; text-transform:uppercase; color:var(--muted); font-weight:600; }
  form.stack, .find { display:flex; gap:8px; margin:0 0 12px; }
  input { flex:1; background:#0d0e0c; color:var(--ink); border:1px solid var(--line); padding:8px 10px; }
  button { background:var(--accent); color:#1a1c0c; border:0; padding:8px 12px; font-weight:650; cursor:pointer; }
  button.ghost { background:transparent; color:var(--ink); border:1px solid var(--line); }
  .row, .wait { display:flex; justify-content:space-between; gap:12px; align-items:center; padding:10px 0; border-bottom:1px solid var(--line); }
  .who { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
  .where, .prompt, .muted, .note { color:var(--muted); }
  .chip { font-size:11px; letter-spacing:0.04em; text-transform:uppercase; border:1px solid var(--line); padding:1px 6px; color:var(--muted); }
  .chip.dim { color:var(--bad); }
  .waitchip { color:var(--wait); border-color:var(--wait); }
  .val { color:var(--ink); }
  .pair { display:flex; gap:6px; }
  .empty, .stage-empty { border:1px dashed var(--line); padding:18px; color:var(--muted); }
  .banner { padding:10px 12px; margin:0 0 12px; border:1px solid var(--line); background:var(--panel); white-space:pre-wrap; }
  .banner.ok { border-color:var(--ok); color:var(--ok); }
  .banner.bad { border-color:var(--bad); color:var(--bad); }
  img { width:100%; border:1px solid var(--line); background:#000; display:block; }
  details { margin-top:14px; }
  pre { white-space:pre-wrap; background:var(--panel); border:1px solid var(--line); padding:12px; }
  .note { margin:12px 0 0; }
  @media (max-width: 980px) { main { grid-template-columns: 1fr; } .stage { border-left:0; } }
</style>
<header>
  <div>
    <h1><span>QodeX</span> Desktop</h1>
    <p class="sub">This window is this machine. No cloud browser, no rented VM. پنجره روی همین سیستم است. مدل از این صفحه صدا زده نمی‌شود.</p>
  </div>
  <div class="pills">
    <span class="pill">${escapeHtml(view.gui)} · ${escapeHtml(view.access)}</span>
    <span class="pill">${view.desks} desks</span>
    <span class="pill">${view.waits.length} waiting</span>
    <span class="pill">${escapeHtml(view.resident)}</span>
  </div>
</header>
<main>
  <aside>
    <h2>Waiting</h2>
    ${waitRows(view)}
    <p class="note">${escapeHtml(view.note)}</p>
    <p class="muted">Allow and deny here are you. A press is you. The agent's own press still waits.</p>
  </aside>
  <section style="padding:16px 18px">
    <h2>Controls <span id="shown">${view.controls.length}</span></h2>
    <form class="stack" method="post" action="/act?k=${view.token}">
      <input type="hidden" name="action" value="tree"/>
      <input name="app" placeholder="App name, optional" aria-label="App name"/>
      <button>Read tree</button>
    </form>
    <input class="find" id="find" placeholder="Filter the names on this page" aria-label="Filter controls"/>
    ${cap}
    ${controlRows(view)}
    <details>
      <summary>Raw tree</summary>
      <pre>${escapeHtml(view.tree || 'Nothing read yet.')}</pre>
    </details>
  </section>
  <section class="stage">
    <h2>Screen</h2>
    <p class="banner ${tone}">${escapeHtml(view.result || 'Nothing pressed yet.')}</p>
    ${shot}
    <form method="post" action="/act?k=${view.token}" style="margin-top:12px">
      <input type="hidden" name="action" value="shot"/>
      <button>Screenshot</button>
    </form>
  </section>
</main>
<script>
(function () {
  var q = document.getElementById('find');
  if (!q) return;
  q.addEventListener('input', function () {
    var want = q.value.trim().toLowerCase();
    var rows = document.querySelectorAll('[data-hit]');
    var shown = 0;
    for (var i = 0; i < rows.length; i++) {
      var hit = (rows[i].getAttribute('data-hit') || '').toLowerCase();
      var hide = !!want && hit.indexOf(want) === -1;
      rows[i].hidden = hide;
      if (!hide) shown++;
    }
    var n = document.getElementById('shown');
    if (n) n.textContent = String(shown);
  });
})();
</script>
</html>`;
}

function parseForm(raw: string): Record<string, string> {
  const params = new URLSearchParams(raw);
  const out: Record<string, string> = {};
  for (const [k, v] of params) out[k] = v;
  return out;
}

export interface ShellDeps {
  readTree: (app?: string) => Promise<{ ok: true; text: string; nodes?: ShellControl[]; capped?: boolean } | { ok: false; error: string }>;
  invoke: (query: UiQuery) => Promise<{ content: string; isError?: boolean }>;
  shoot: () => Promise<{ ok: true; file: string } | { ok: false; error: string }>;
  shotFile: () => string | null;
  setShot: (file: string) => void;
  decide: (id: string, allow: boolean) => Promise<{ ok: boolean; error?: string }>;
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
    decide: async (id, allow) => {
      const decided = await decideSentinel(id, allow);
      return { ok: decided.ok, error: decided.error };
    },
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
      view = {
        ...view,
        tree: tree.ok ? tree.text : tree.error,
        controls: tree.ok ? (tree.nodes ?? []) : [],
        capped: tree.ok ? Boolean(tree.capped) : false,
      };
    } else if (form.action === 'invoke') {
      const pressed = await opts.deps.invoke({ name: form.name ?? '', role: form.role, app: form.app });
      view = { ...view, result: pressed.content };
    } else if (form.action === 'shot') {
      const shot = await opts.deps.shoot();
      if (shot.ok) opts.deps.setShot(shot.file);
      view = { ...view, result: shot.ok ? `screenshot ${shot.file}` : shot.error };
    } else if (form.action === 'allow' || form.action === 'deny') {
      const id = form.id ?? '';
      if (!/^[a-f0-9]{8}$/.test(id)) {
        view = { ...view, result: 'refused: bad call id' };
      } else {
        const decided = await opts.deps.decide(id, form.action === 'allow');
        view = {
          ...view,
          result: decided.ok ? `${form.action === 'allow' ? 'allowed' : 'denied'} ${id}` : (decided.error ?? 'not decided'),
        };
      }
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
  const state = { shot: null as string | null, tree: '', result: '', controls: [] as ShellControl[], capped: false };
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
          controls: state.controls,
          capped: state.capped,
          waits: pending.map(p => ({ id: p.id, kind: p.kind, reason: p.reason, prompt: p.prompt })),
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
        state.controls = handled.view.controls;
        state.capped = handled.view.capped;
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
