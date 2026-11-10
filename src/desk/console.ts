/**
 * Local desk console. 127.0.0.1 only, token on every request — same rule as
 * the control dashboard. This is the desktop surface: desks, held goals, and
 * the audit, in a browser window on your machine. It does not open a port on
 * the LAN and it does not call a model.
 */
import * as http from 'http';
import { randomBytes } from 'crypto';
import * as os from 'os';
import {
  createDesk,
  decideGoal,
  findDesk,
  handoff,
  postGoal,
  teachRoutine,
  type Board,
  type RoutineStep,
} from './board.js';
import { describeDesktop } from './policy.js';
import { appendAudit, loadBoard, readAudit, saveBoard, withDeskLock } from './store.js';

export interface DeskRoute {
  status: number;
  body: string;
  contentType: string;
}

function json(status: number, obj: unknown): DeskRoute {
  return { status, body: JSON.stringify(obj), contentType: 'application/json; charset=utf-8' };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '\u0026amp;')
    .replace(/</g, '\u0026lt;')
    .replace(/>/g, '\u0026gt;')
    .replace(/"/g, '\u0026quot;')
    .replace(/'/g, '\u0026#39;');
}

export function renderDeskHtml(board: Board, token: string): string {
  const desktop = describeDesktop(os.platform());
  const cards = board.desks.map(d => {
    const goals = d.goals.slice(-6).map(g => {
      const hold = g.status === 'needs-approval'
        ? `<form method="post" action="/api/action?k=${token}" class="row">
             <input type="hidden" name="action" value="approve"/>
             <input type="hidden" name="deskId" value="${escapeHtml(d.id)}"/>
             <input type="hidden" name="goalId" value="${escapeHtml(g.id)}"/>
             <button name="allow" value="yes">Allow</button>
             <button name="allow" value="no" class="deny">Deny</button>
           </form>`
        : '';
      return `<li><span class="st ${escapeHtml(g.status)}">${escapeHtml(g.status)}</span> ${escapeHtml(g.text)}${g.result ? `<div class="muted">${escapeHtml(g.result)}</div>` : ''}${hold}</li>`;
    }).join('') || '<li class="muted">No goals yet.</li>';
    const routines = d.routines.map(r => `<li>${escapeHtml(r.name)} · ${r.steps.length} steps</li>`).join('');
    return `<article>
      <header><h2>${escapeHtml(d.name)}</h2><code>${escapeHtml(d.cwd)}</code></header>
      <p>${escapeHtml(d.brief || 'No brief.')}</p>
      <ul>${goals}</ul>
      ${routines ? `<h3>Routines</h3><ul>${routines}</ul>` : ''}
      <form method="post" action="/api/action?k=${token}">
        <input type="hidden" name="action" value="goal"/>
        <input type="hidden" name="deskId" value="${escapeHtml(d.id)}"/>
        <input name="text" placeholder="Goal for ${escapeHtml(d.name)}" required/>
        <button>Assign</button>
      </form>
    </article>`;
  }).join('') || '<p class="muted">No desks yet. Add one below — six is the cap, same idea as a small Bot group.</p>';

  return `<!doctype html>
<html lang="en">
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>QodeX Desk</title>
<style>
  :root { color-scheme: dark; --bg:#10140f; --card:#1a2118; --ink:#e7f0e2; --muted:#8ea08a; --line:#2c3828; --ok:#9dce7c; --hold:#e2b657; --bad:#e07a6a; }
  body { margin:0; font:15px/1.45 ui-sans-serif, system-ui, sans-serif; background:var(--bg); color:var(--ink); }
  main { max-width:980px; margin:0 auto; padding:28px 20px 64px; }
  h1 { font-size:28px; letter-spacing:-0.03em; margin:0 0 4px; }
  .sub { color:var(--muted); margin:0 0 22px; }
  .cap { display:flex; gap:16px; flex-wrap:wrap; border:1px solid var(--line); padding:12px 14px; margin-bottom:22px; }
  article { background:var(--card); border:1px solid var(--line); padding:14px 16px; margin:0 0 12px; }
  article h2 { margin:0; font-size:18px; }
  article header { display:flex; justify-content:space-between; gap:12px; align-items:baseline; }
  code { color:var(--muted); font-size:12px; }
  ul { padding-left:18px; }
  .st { font-size:11px; text-transform:uppercase; letter-spacing:.04em; margin-right:6px; }
  .needs-approval, .running { color:var(--hold); } .denied, .failed { color:var(--bad); } .approved,.queued,.done { color:var(--ok); }
  form.row, article form { display:flex; gap:8px; margin-top:8px; }
  input { flex:1; background:#0e130d; color:var(--ink); border:1px solid var(--line); padding:8px 10px; }
  button { background:var(--ok); color:#12200c; border:0; padding:8px 12px; font-weight:650; cursor:pointer; }
  button.deny { background:transparent; color:var(--bad); border:1px solid var(--bad); }
  .muted { color:var(--muted); }
</style>
<main>
  <h1>QodeX Desk</h1>
  <p class="sub">Local teammates. Nothing is sent, spent, deleted, or published until you allow it. Work runs with <code>qodex desk run</code> — this page only assigns and approves. میز کار روی همین ماشین است، نه یک VM ابری.</p>
  <div class="cap">
    <div><strong>${board.desks.length}/6</strong> desks</div>
    <div>GUI: ${escapeHtml(desktop.gui)}</div>
    <div>${escapeHtml(desktop.note)}</div>
  </div>
  ${cards}
  <article>
    <h2>New desk</h2>
    <form method="post" action="/api/action?k=${token}">
      <input type="hidden" name="action" value="create"/>
      <input name="name" placeholder="Name (research, inbox, repo)" required/>
      <input name="brief" placeholder="What this desk is for"/>
      <button>Add</button>
    </form>
  </article>
</main>
</html>`;
}

async function applyAction(body: Record<string, string>, cwd: string): Promise<{ ok: boolean; message: string }> {
  return withDeskLock(() => applyActionUnlocked(body, cwd));
}

async function applyActionUnlocked(body: Record<string, string>, cwd: string): Promise<{ ok: boolean; message: string }> {
  const action = String(body.action ?? '');
  const board = await loadBoard();
  const now = new Date().toISOString();
  if (action === 'create') {
    const res = createDesk(board, { name: body.name ?? '', brief: body.brief ?? '', cwd, now });
    if (!res.ok) return { ok: false, message: res.error ?? 'failed' };
    await saveBoard(res.state);
    if (res.audit) await appendAudit(res.audit);
    return { ok: true, message: `desk ${res.value?.name}` };
  }
  if (action === 'goal') {
    const desk = findDesk(board, body.deskId ?? '');
    if (!desk) return { ok: false, message: 'no such desk' };
    const res = postGoal(board, { deskId: desk.id, text: body.text ?? '', now });
    if (!res.ok) return { ok: false, message: res.error ?? 'failed' };
    await saveBoard(res.state);
    if (res.audit) await appendAudit(res.audit);
    return { ok: true, message: res.value?.status ?? 'goal' };
  }
  if (action === 'approve') {
    const desk = findDesk(board, body.deskId ?? '');
    if (!desk) return { ok: false, message: 'no such desk' };
    const allow = body.allow === 'yes' || body.allow === 'true';
    const res = decideGoal(board, { deskId: desk.id, goalId: body.goalId ?? '', allow, now });
    if (!res.ok) return { ok: false, message: res.error ?? 'failed' };
    await saveBoard(res.state);
    if (res.audit) await appendAudit(res.audit);
    return { ok: true, message: res.value?.status ?? 'decided' };
  }
  if (action === 'handoff') {
    const from = findDesk(board, body.fromId ?? '');
    const to = findDesk(board, body.toId ?? '');
    if (!from || !to) return { ok: false, message: 'both desks must exist' };
    const res = handoff(board, { fromId: from.id, toId: to.id, note: body.note ?? '', now });
    if (!res.ok) return { ok: false, message: res.error ?? 'failed' };
    await saveBoard(res.state);
    if (res.audit) await appendAudit(res.audit);
    return { ok: true, message: 'handed off' };
  }
  if (action === 'teach') {
    const desk = findDesk(board, body.deskId ?? '');
    if (!desk) return { ok: false, message: 'no such desk' };
    let steps: RoutineStep[] = [];
    try { steps = JSON.parse(body.steps ?? '[]') as RoutineStep[]; } catch { return { ok: false, message: 'steps must be JSON' }; }
    const res = teachRoutine(board, { deskId: desk.id, name: body.name ?? '', steps, now });
    if (!res.ok) return { ok: false, message: res.error ?? 'failed' };
    await saveBoard(res.state);
    if (res.audit) await appendAudit(res.audit);
    return { ok: true, message: `routine ${res.value?.name}` };
  }
  return { ok: false, message: `unknown action ${action}` };
}

function parseForm(raw: string, contentType: string): Record<string, string> {
  if (contentType.includes('application/json')) {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj)) out[k] = typeof v === 'string' ? v : JSON.stringify(v);
      return out;
    } catch { return {}; }
  }
  const params = new URLSearchParams(raw);
  const out: Record<string, string> = {};
  for (const [k, v] of params) out[k] = v;
  return out;
}

/** Route one console request. Exported so tests don't need a socket. */
export async function handleDeskRequest(opts: {
  method: string;
  pathname: string;
  tokenOk: boolean;
  rawBody: string;
  contentType: string;
  cwd: string;
  /** Token stamped into the HTML. Tests omit it. */
  htmlToken?: string;
}): Promise<DeskRoute> {
  if (!opts.tokenOk) return json(401, { ok: false, message: 'Unauthorized — missing or bad token.' });
  if (opts.method === 'GET' && (opts.pathname === '/' || opts.pathname === '')) {
    const board = await loadBoard();
    return { status: 200, body: renderDeskHtml(board, opts.htmlToken ?? 'token'), contentType: 'text/html; charset=utf-8' };
  }
  if (opts.method === 'GET' && opts.pathname === '/api/state') {
    const board = await loadBoard();
    const audit = await readAudit(30);
    return json(200, { ok: true, board, audit, desktop: describeDesktop(os.platform()) });
  }
  if (opts.method === 'POST' && opts.pathname === '/api/action') {
    const body = parseForm(opts.rawBody, opts.contentType);
    const result = await applyAction(body, opts.cwd);
    return json(result.ok ? 200 : 400, result);
  }
  return json(404, { ok: false, message: 'Not found.' });
}

export interface DeskConsole { url: string; port: number; token: string; close: () => Promise<void>; }

export async function startDeskConsole(cwd: string, preferredPort = 0): Promise<DeskConsole> {
  const token = randomBytes(16).toString('hex');
  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const u = new URL(req.url ?? '/', 'http://127.0.0.1');
        const provided = u.searchParams.get('k') ?? req.headers['x-qodex-token'];
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const rawBody = Buffer.concat(chunks).toString('utf-8');
        const rendered = await handleDeskRequest({
          method: req.method ?? 'GET',
          pathname: u.pathname,
          tokenOk: provided === token,
          rawBody,
          contentType: String(req.headers['content-type'] ?? ''),
          cwd,
          htmlToken: token,
        });
        res.writeHead(rendered.status, { 'content-type': rendered.contentType, 'cache-control': 'no-store' });
        res.end(rendered.body);
      } catch (e: any) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, message: e?.message ?? 'error' }));
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
