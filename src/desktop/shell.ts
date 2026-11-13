/**
 * QodeX Desktop — the local operator window on 127.0.0.1.
 * It assigns a goal, allows a held one, reads the accessibility tree, and
 * presses or fills one named control, or starts the next runnable goal. It does not
 * call a model itself — Run next uses the same desk agent as `qodex desk run`.
 */
import * as http from 'http';
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { probeDesktop } from '../desk/policy.js';
import { applyDeskAction } from '../desk/console.js';
import { launchDesk } from '../desk/launch.js';
import { listPending, decideSentinel } from '../desk/sentinel.js';
import { loadBoard, readAudit } from '../desk/store.js';
import { readResidentStatus } from '../resident/loop.js';
import { invokeNamed, readUiTree, typeNamed, type UiQuery } from '../tools/computer/access.js';
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

export interface ShellDesk {
  id: string;
  name: string;
  runnable: boolean;
  goals: { id: string; text: string; status: string }[];
}

export interface ShellAudit {
  ts: string;
  kind: string;
  detail: string;
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
  team: ShellDesk[];
  audit: ShellAudit[];
}

const LIVE_GOAL = new Set(['running', 'needs-approval', 'approved', 'queued']);

/** What the window shows for each desk: active goals first, otherwise the latest one. Text is clipped. */
export function deskRows(desks: { id: string; name: string; goals: { id: string; text: string; status: string; sensitive?: unknown }[] }[]): ShellDesk[] {
  return desks.slice(0, 6).map(d => {
    const ordered = [...d.goals].reverse();
    const active = ordered.filter(g => LIVE_GOAL.has(g.status)).slice(0, 4);
    const shown = active.length ? active : ordered.slice(0, 1);
    const runnable = d.goals.some(g => g.status === 'approved' || (g.status === 'queued' && !g.sensitive));
    return {
      id: d.id,
      name: d.name,
      runnable,
      goals: shown.map(g => ({
        id: g.id,
        status: g.status,
        text: g.text.replace(/\s+/g, ' ').trim().slice(0, 160),
      })),
    };
  });
}

/** Loopback poll. No token, no screenshot bytes. */
export function liveSnapshot(view: ShellView): { resident: string; pending: number; waits: ShellWait[]; desks: ShellDesk[]; audit: ShellAudit[] } {
  return { resident: view.resident, pending: view.waits.length, waits: view.waits, desks: view.team, audit: view.audit };
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
      <div class="acts">
      <form method="post" action="/act?k=${view.token}">
        <input type="hidden" name="action" value="invoke"/>
        <input type="hidden" name="name" value="${escapeHtml(c.name)}"/>
        <input type="hidden" name="role" value="${escapeHtml(c.role)}"/>
        <input type="hidden" name="app" value="${escapeHtml(c.app)}"/>
        <button>Press</button>
      </form>
      <form class="typeform" method="post" action="/act?k=${view.token}">
        <input type="hidden" name="action" value="type"/>
        <input type="hidden" name="name" value="${escapeHtml(c.name)}"/>
        <input type="hidden" name="role" value="${escapeHtml(c.role)}"/>
        <input type="hidden" name="app" value="${escapeHtml(c.app)}"/>
        <input name="text" maxlength="500" required placeholder="One line" aria-label="Type into ${escapeHtml(c.name)}"/>
        <button class="ghost">Type</button>
      </form>
      </div>
    </article>`;
  }).join('');
}

function deskBlock(view: ShellView): string {
  if (view.team.length === 0) return '<p class="muted">No desks on this machine. Add one with <code>qodex desk add</code>.</p>';
  return view.team.map(d => {
    const goals = d.goals.length
      ? d.goals.map(g => {
        const hold = g.status === 'needs-approval'
          ? `<form method="post" action="/act?k=${view.token}">
              <input type="hidden" name="action" value="approve"/>
              <input type="hidden" name="deskId" value="${escapeHtml(d.id)}"/>
              <input type="hidden" name="goalId" value="${escapeHtml(g.id)}"/>
              <button name="allow" value="yes">Allow</button>
              <button name="allow" value="no" class="ghost">Deny</button>
            </form>`
          : '';
        return `<div class="goal"><span class="chip">${escapeHtml(g.status)}</span> ${escapeHtml(g.text)}${hold}</div>`;
      }).join('')
      : '<p class="muted">No goal.</p>';
    return `<article class="desk"><strong>${escapeHtml(d.name)}</strong>${goals}
      <form method="post" action="/act?k=${view.token}">
        <input type="hidden" name="action" value="goal"/>
        <input type="hidden" name="deskId" value="${escapeHtml(d.id)}"/>
        <input name="text" placeholder="Assign a goal" maxlength="500" required aria-label="Goal for ${escapeHtml(d.name)}"/>
        <button>Assign</button>
      </form>
      ${d.runnable ? `<form method="post" action="/act?k=${view.token}">
        <input type="hidden" name="action" value="run"/>
        <input type="hidden" name="deskId" value="${escapeHtml(d.id)}"/>
        <button>Run next</button>
      </form>` : ''}
    </article>`;
  }).join('');
}

function auditBlock(view: ShellView): string {
  if (view.audit.length === 0) return '<p class="muted">No audit yet.</p>';
  return view.audit.slice(-6).map(a => `<p class="goal"><span class="chip">${escapeHtml(a.kind)}</span> ${escapeHtml(a.detail)}</p>`).join('');
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
  .acts { display:flex; flex-direction:column; gap:6px; align-items:stretch; }
  .typeform { display:flex; gap:6px; }
  .typeform input { width: 9rem; }
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
  .goal { margin:6px 0; }
  .desk form { display:flex; gap:6px; margin-top:8px; }
  .live { font-size:12px; color:var(--muted); margin:0 0 8px; }
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
    <span class="pill" id="wait-pill">${view.waits.length} waiting</span>
    <span class="pill" id="resident-pill">${escapeHtml(view.resident)}</span>
  </div>
</header>
<main>
  <aside>
    <p class="live" id="live">Live on this machine.</p>
    <h2>Desks</h2>
    <div id="desks">${deskBlock(view)}</div>
    <h2>Waiting</h2>
    <div id="waits">${waitRows(view)}</div>
    <p class="note">${escapeHtml(view.note)}</p>
    <p class="muted">Assign, allow, press, type, and Run next are you. Type sets that control's value. It does not send keys to whatever else is focused. A sensitive goal stays held until you allow it.</p>
    <h2>Audit</h2>
    <div id="audit">${auditBlock(view)}</div>
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
    <label class="live" for="live-screen"><input id="live-screen" type="checkbox"/> Live — a new shot of this machine every 2s. Off until you check it.</label>
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
(function () {
  var waits = document.getElementById('waits');
  var desks = document.getElementById('desks');
  var live = document.getElementById('live');
  if (!waits || !desks) return;
  var token = ${JSON.stringify(view.token)};
  function el(tag, text, cls) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function fields(form, pairs) {
    pairs.forEach(function (pair) {
      var input = document.createElement('input');
      input.type = 'hidden';
      input.name = pair[0];
      input.value = pair[1];
      form.appendChild(input);
    });
  }
  function paint(data) {
    desks.textContent = '';
    if (!data.desks || !data.desks.length) desks.appendChild(el('p', 'No desks on this machine. Add one with qodex desk add.', 'muted'));
    (data.desks || []).forEach(function (d) {
      var box = el('article', null, 'desk');
      box.appendChild(el('strong', d.name || 'desk'));
      if (!d.goals || !d.goals.length) box.appendChild(el('p', 'No goal.', 'muted'));
      (d.goals || []).forEach(function (g) {
        var p = el('div', null, 'goal');
        p.appendChild(el('span', g.status || '', 'chip'));
        p.appendChild(document.createTextNode(' ' + (g.text || '')));
        if (g.status === 'needs-approval') {
          var form = document.createElement('form');
          form.method = 'post';
          form.action = '/act?k=' + encodeURIComponent(token);
          fields(form, [['action', 'approve'], ['deskId', d.id || ''], ['goalId', g.id || '']]);
          var yes = document.createElement('button');
          yes.name = 'allow'; yes.value = 'yes'; yes.textContent = 'Allow';
          var no = document.createElement('button');
          no.name = 'allow'; no.value = 'no'; no.className = 'ghost'; no.textContent = 'Deny';
          form.appendChild(yes); form.appendChild(no);
          p.appendChild(form);
        }
        box.appendChild(p);
      });
      var assign = document.createElement('form');
      assign.method = 'post';
      assign.action = '/act?k=' + encodeURIComponent(token);
      fields(assign, [['action', 'goal'], ['deskId', d.id || '']]);
      var text = document.createElement('input');
      text.name = 'text'; text.maxLength = 500; text.required = true; text.placeholder = 'Assign a goal';
      text.setAttribute('aria-label', 'Goal for ' + (d.name || 'desk'));
      var go = document.createElement('button');
      go.textContent = 'Assign';
      assign.appendChild(text); assign.appendChild(go);
      box.appendChild(assign);
      if (d.runnable) {
        var run = document.createElement('form');
        run.method = 'post';
        run.action = '/act?k=' + encodeURIComponent(token);
        fields(run, [['action', 'run'], ['deskId', d.id || '']]);
        var runBtn = document.createElement('button');
        runBtn.textContent = 'Run next';
        run.appendChild(runBtn);
        box.appendChild(run);
      }
      desks.appendChild(box);
    });
    waits.textContent = '';
    if (!data.waits || !data.waits.length) {
      waits.appendChild(el('p', 'Nothing is waiting. The agent is not asking.', 'muted'));
    }
    (data.waits || []).forEach(function (w) {
      var box = el('article', null, 'wait');
      var who = el('div', null, 'who');
      who.appendChild(el('span', w.kind || 'ask', 'chip waitchip'));
      who.appendChild(el('code', w.id || ''));
      box.appendChild(who);
      box.appendChild(el('p', w.reason || ''));
      box.appendChild(el('p', w.prompt || '', 'prompt'));
      var pair = el('div', null, 'pair');
      ['allow', 'deny'].forEach(function (action) {
        var form = document.createElement('form');
        form.method = 'post';
        form.action = '/act?k=' + encodeURIComponent(token);
        var a = document.createElement('input');
        a.type = 'hidden'; a.name = 'action'; a.value = action;
        var id = document.createElement('input');
        id.type = 'hidden'; id.name = 'id'; id.value = w.id || '';
        var button = document.createElement('button');
        button.textContent = action === 'allow' ? 'Allow' : 'Deny';
        if (action === 'deny') button.className = 'ghost';
        form.appendChild(a); form.appendChild(id); form.appendChild(button);
        pair.appendChild(form);
      });
      box.appendChild(pair);
      waits.appendChild(box);
    });
    var pill = document.getElementById('wait-pill');
    if (pill) pill.textContent = String(data.pending || 0) + ' waiting';
    var res = document.getElementById('resident-pill');
    if (res) res.textContent = data.resident || '';
    var audit = document.getElementById('audit');
    if (audit) {
      audit.textContent = '';
      if (!data.audit || !data.audit.length) audit.appendChild(el('p', 'No audit yet.', 'muted'));
      (data.audit || []).slice(-6).forEach(function (a) {
        var p = el('p', null, 'goal');
        p.appendChild(el('span', a.kind || '', 'chip'));
        p.appendChild(document.createTextNode(' ' + (a.detail || '')));
        audit.appendChild(p);
      });
    }
    if (live) live.textContent = 'Live. Updated just now.';
  }
  function tick() {
    fetch('/live?k=' + encodeURIComponent(token), { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('live ' + r.status);
      return r.json();
    }).then(paint).catch(function () {
      if (live) live.textContent = 'Live update failed. The page is still this machine.';
    });
  }
  setInterval(tick, 2000);
  var screen = document.getElementById('live-screen');
  var stage = document.querySelector('.stage');
  if (screen && stage) {
    setInterval(function () {
      if (!screen.checked) return;
      fetch('/act?k=' + encodeURIComponent(token), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'action=shot',
        redirect: 'manual',
      }).then(function () {
        var img = stage.querySelector('img');
        if (!img) {
          img = document.createElement('img');
          img.alt = 'This machine, just now';
          stage.insertBefore(img, screen.parentNode);
        }
        img.src = '/shot?k=' + encodeURIComponent(token) + '&t=' + Date.now();
      }).catch(function () {
        if (live) live.textContent = 'Screenshot failed. The page is still this machine.';
      });
    }, 2000);
  }
})();
document.addEventListener('keydown', function (e) {
  if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
  var t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
  var find = document.getElementById('find');
  if (!find) return;
  e.preventDefault();
  find.focus();
});
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
  typeText: (query: UiQuery, text: string) => Promise<{ content: string; isError?: boolean }>;
  shoot: () => Promise<{ ok: true; file: string } | { ok: false; error: string }>;
  shotFile: () => string | null;
  setShot: (file: string) => void;
  decide: (id: string, allow: boolean) => Promise<{ ok: boolean; error?: string }>;
  board: (body: Record<string, string>) => Promise<{ ok: boolean; message: string }>;
  launch: (deskId: string) => Promise<{ ok: boolean; message: string }>;
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
    typeText: typeNamed,
    shoot: defaultShoot,
    shotFile: () => state.shot,
    setShot: file => { state.shot = file; },
    decide: async (id, allow) => {
      const decided = await decideSentinel(id, allow);
      return { ok: decided.ok, error: decided.error };
    },
    board: body => applyDeskAction(body, process.cwd()),
    launch: async id => {
      const started = await launchDesk(id);
      return { ok: started.ok, message: started.message };
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
    } else if (form.action === 'type') {
      const typed = await opts.deps.typeText({ name: form.name ?? '', role: form.role, app: form.app }, form.text ?? '');
      view = { ...view, result: typed.content };
    } else if (form.action === 'shot') {
      const shot = await opts.deps.shoot();
      if (shot.ok) opts.deps.setShot(shot.file);
      view = { ...view, result: shot.ok ? `screenshot ${shot.file}` : shot.error };
    } else if (form.action === 'goal') {
      const deskId = (form.deskId ?? '').trim();
      const text = (form.text ?? '').trim();
      if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(deskId)) {
        view = { ...view, result: 'refused: bad desk' };
      } else if (!text || text.length > 500) {
        view = { ...view, result: 'refused: a goal needs text' };
      } else {
        const posted = await opts.deps.board({ action: 'goal', deskId, text });
        view = { ...view, result: posted.ok ? `goal ${posted.message}` : (posted.message || 'not posted') };
      }
    } else if (form.action === 'approve') {
      const deskId = (form.deskId ?? '').trim();
      const goalId = (form.goalId ?? '').trim();
      if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(deskId) || !/^[a-f0-9]{8}$/.test(goalId)) {
        view = { ...view, result: 'refused: bad goal' };
      } else {
        const allow = form.allow === 'yes';
        const decided = await opts.deps.board({ action: 'approve', deskId, goalId, allow: allow ? 'yes' : 'no' });
        view = { ...view, result: decided.ok ? `goal ${decided.message}` : (decided.message || 'not decided') };
      }
    } else if (form.action === 'run') {
      const deskId = (form.deskId ?? '').trim();
      if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(deskId)) {
        view = { ...view, result: 'refused: bad desk' };
      } else {
        const started = await opts.deps.launch(deskId);
        view = { ...view, result: started.ok ? started.message : (started.message || 'not started') };
      }
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
  if (opts.method === 'GET' && opts.pathname === '/live') {
    return { view, route: { status: 200, body: JSON.stringify(liveSnapshot(view)), contentType: 'application/json; charset=utf-8' } };
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
        const audit = await readAudit(6).catch(() => []);
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
          team: deskRows(board?.desks ?? []),
          audit: audit.map(a => ({ ts: a.ts, kind: a.kind, detail: a.detail })),
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
