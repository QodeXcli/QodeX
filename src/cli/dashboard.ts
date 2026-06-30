/**
 * `qodex dashboard` — a live, visual snapshot of YOUR QodeX: providers & models, sessions, token /
 * cost usage, memory (facts + episodic), and skills. Gathered deterministically from the same stores
 * the agent uses, rendered to a self-contained dark dashboard, and opened in your browser.
 *
 * buildDashboardHtml is PURE (data → HTML) so it's unit-testable; gathering + opening is the thin shell.
 */
import { promises as fs } from 'fs';
import * as path from 'path';

export interface DashboardData {
  project: string;
  model: string;
  generatedAt: string;
  providers: { name: string; baseUrl: string; keyEnv?: string; keySet?: boolean; models: string[]; isDefault: boolean; custom?: boolean }[];
  sessions: { id: string; title: string; model: string; turns: number; tokens: number; cost: number; when: string }[];
  facts: string[];
  episodes: { when: string; prompt: string; summary: string }[];
  skills: { name: string; description: string }[];
  controls: { path: string; label: string; group: string; type: 'bool' | 'enum'; values?: string[]; current: string }[];
  schedules: { id: string; name: string; cron: string; enabled: boolean; recipe?: string }[];
  models: string[];
  candidates: { name: string; description: string; confidence?: number }[];
  runs: { schedule: string; recipe?: string; when: string; status: string; receipt?: { status: string; prUrl?: string; verification?: { command: string; passed: boolean }[] } }[];
  bot: { running: boolean; pid?: number };
  health: { label: string; ok: boolean; detail: string }[];
  logs: string[];
  userModel: { preferences: string[]; recentThemes: string[]; taskCount: number; summary: string };
  maintainStats?: import('./maintain-stats.js').MaintainStats;
  maintainWeekly?: import('./maintain-stats.js').MaintainWeekly;
  maintainNext?: { scope: string; why: string };
  totals: { sessions: number; tokens: number; cost: number; facts: number; episodes: number; skills: number };
}

const esc = (s: string) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const num = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n);

/** Render the dashboard as one self-contained HTML page (PURE). Chart.js via CDN; everything else
 *  inline. When `token` is given the page is a live CONTROL panel (toggles/buttons call the local
 *  API); without it the same page renders read-only. */
export function buildDashboardHtml(d: DashboardData, opts: { token?: string } = {}): string {
  const live = !!opts.token;
  const card = (label: string, value: string, accent: string) =>
    `<div class="card"><div class="v" style="color:${accent}">${value}</div><div class="l">${label}</div></div>`;

  // ── Controls: config toggles/selects grouped, + scheduled tasks with enable/remove ──
  const groups = [...new Set(d.controls.map(c => c.group))];
  const controlPanel = d.controls.length === 0 ? '' : groups.map(g => {
    const rows = d.controls.filter(c => c.group === g).map(c => {
      if (c.type === 'bool') {
        const on = c.current === 'true';
        const btn = live
          ? `<button class="tg ${on ? 'on' : ''}" onclick="act('config.set',{key:'${c.path}',value:${!on}})">${on ? 'ON' : 'OFF'}</button>`
          : `<span class="${on ? 'ok' : 'dim'}">${on ? 'ON' : 'OFF'}</span>`;
        return `<div class="ctl"><span>${esc(c.label)}</span>${btn}</div>`;
      }
      const sel = live
        ? `<select onchange="act('config.set',{key:'${c.path}',value:this.value})">${(c.values ?? []).map(v => `<option${v === c.current ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select>`
        : `<span class="mono">${esc(c.current)}</span>`;
      return `<div class="ctl"><span>${esc(c.label)}</span>${sel}</div>`;
    }).join('');
    return `<div class="panel"><h2>${esc(g)}</h2>${rows}</div>`;
  }).join('');

  const scheduleRows = d.schedules.length ? d.schedules.map(s => `<tr>
    <td>${s.enabled ? '🟢' : '⚪'} <b>${esc(s.name)}</b>${s.recipe ? ` <span class="mono dim">${esc(s.recipe)}</span>` : ''}</td>
    <td class="mono dim">${esc(s.cron)}</td>
    <td class="r">${live ? `<button onclick="act('schedule.setEnabled',{id:'${esc(s.id)}',enabled:${!s.enabled}})">${s.enabled ? 'Disable' : 'Enable'}</button> <button class="danger" onclick="if(confirm('Remove ${esc(s.name)}?'))act('schedule.remove',{id:'${esc(s.id)}'})">Remove</button>` : `<span class="dim">${s.enabled ? 'enabled' : 'disabled'}</span>`}</td>
  </tr>`).join('') : '<tr><td colspan="3" class="dim">No scheduled tasks. Add one with `qodex schedule add`.</td></tr>';
  const addForm = live ? `<div class="addform">
    <input id="s_name" placeholder="name (e.g. nightly-fix)">
    <input id="s_cron" placeholder="cron (@daily, 0 3 * * *)">
    <input id="s_prompt" placeholder="prompt — or maintain: dead-code | unused-imports/locals/params | lint-fix | dep-bump [--dry-run] [path]" style="flex:2">
    <select id="s_recipe"><option value="">plain</option><option value="verified-pr">verified-pr</option><option value="maintain">maintain (self-improving → verified PR)</option></select>
    <input id="s_deliver" placeholder="deliver (telegram:&lt;id&gt;)">
    <button onclick="act('schedule.add',{name:s_name.value,cron:s_cron.value,prompt:s_prompt.value,recipe:s_recipe.value,deliver:s_deliver.value})">Schedule</button>
  </div>` : '';
  const schedulePanel = `<div class="panel"><h2>Scheduled tasks</h2><table><thead><tr><th>task</th><th>cron</th><th class="r">${live ? 'actions' : 'state'}</th></tr></thead><tbody>${scheduleRows}</tbody></table>${addForm}</div>`;

  // Run history + trust receipts (proof-carrying autonomy, surfaced).
  const runRows = d.runs.length ? d.runs.map(r => {
    const rc = r.receipt;
    const verdict = rc ? `<span class="${rc.status === 'opened' || rc.status === 'done' ? 'ok' : rc.status === 'blocked' ? 'warn' : 'dim'}">🧾 ${esc(rc.status)}</span>${rc.prUrl ? ` <a href="${esc(rc.prUrl)}" target="_blank" class="mono">PR</a>` : ''}${rc.verification?.length ? ` <span class="dim mono">${rc.verification.map(v => (v.passed ? '✓' : '✗') + v.command).join(' ')}</span>` : ''}` : '<span class="dim">—</span>';
    return `<tr><td><b>${esc(r.schedule)}</b>${r.recipe ? ` <span class="mono dim">${esc(r.recipe)}</span>` : ''}</td><td class="dim">${esc(r.when)}</td><td>${esc(r.status)}</td><td>${verdict}</td></tr>`;
  }).join('') : '<tr><td colspan="4" class="dim">No runs yet. A verified-pr / maintain schedule produces a 🧾 receipt.</td></tr>';
  const runsPanel = `<div class="panel"><h2>Run history &amp; receipts</h2><table><thead><tr><th>schedule · recipe</th><th>when</th><th>status</th><th>receipt</th></tr></thead><tbody>${runRows}</tbody></table></div>`;

  // Maintain status & analytics (self-improvement loop at a glance).
  const ms = d.maintainStats;
  const maintainPanel = ms && ms.totalRuns > 0 ? `<div class="panel"><h2>Maintain status — self-improvement</h2>
    <div class="cards" style="grid-template-columns:repeat(4,1fr);margin:0 0 14px">
      ${card('cleanups shipped', String(ms.opened), 'var(--green)')}
      ${card('safely blocked', String(ms.blocked), 'var(--amber)')}
      ${card('files cleaned', String(ms.filesCleaned), 'var(--accent)')}
      ${card('~min saved (est)', String(ms.estMinutesSaved), 'var(--green)')}
    </div>
    <div class="ctl"><span>Success rate (opened ÷ runs)</span><b class="${ms.successRate >= 0.5 ? 'ok' : 'dim'}">${Math.round(ms.successRate * 100)}% of ${ms.totalRuns}</b></div>
    ${ms.lastRun ? `<div class="ctl"><span>Last run</span><span class="dim">${esc(ms.lastRun.scope)} · ${esc(ms.lastRun.status)} · ${esc(ms.lastRun.when)}</span></div>` : ''}
    <div class="ctl"><span>By scope</span><span class="mono dim">${ms.byScope.map(s => `${esc(s.scope)} ${s.opened}/${s.runs}`).join(' · ') || '—'}</span></div>
    ${d.maintainWeekly ? `<div class="ctl"><span>This week</span><span class="dim">${d.maintainWeekly.opened} PR(s) · ${d.maintainWeekly.filesCleaned} files · ${d.maintainWeekly.openedDelta >= 0 ? '▲' : '▼'}${Math.abs(d.maintainWeekly.openedDelta)} vs last week</span></div>` : ''}
    ${d.maintainNext ? `<div class="ctl" style="border:0"><span>Suggested next</span><b class="ok">${esc(d.maintainNext.scope)}</b> <span class="dim">— ${esc(d.maintainNext.why)}</span>${live ? ` <button onclick="act('schedule.add',{name:'maintain-${esc(d.maintainNext.scope)}',cron:'0 4 * * *',prompt:'${esc(d.maintainNext.scope)}',recipe:'maintain'})">Schedule it</button>` : ''}</div>` : '<div class="ctl" style="border:0"><span class="dim">All scopes exercised.</span></div>'}
  </div>` : '';

  // Bot lifecycle: status + start/stop (it still needs a token + allowlist in config to connect).
  const botCtl = live
    ? (d.bot.running
      ? `<button class="danger" onclick="act('bot.stop',{})">Stop</button>`
      : `<button onclick="act('bot.start',{})">Start</button>`)
    : `<span class="dim">${d.bot.running ? 'running' : 'stopped'}</span>`;
  const botPanel = `<div class="panel"><div class="ctl"><span>Telegram / Discord / Slack bot — <b class="${d.bot.running ? 'ok' : 'dim'}">${d.bot.running ? `running (pid ${d.bot.pid})` : 'stopped'}</b></span>${botCtl}</div></div>`;

  // Observability: health badges + a tail of the local log.
  const healthBadges = d.health.map(h => `<span class="badge ${h.ok ? 'ok' : 'warn'}">${h.ok ? '✓' : '!'} ${esc(h.label)}: ${esc(h.detail)}</span>`).join('');
  const healthPanel = `<div class="panel"><div class="ctl" style="border:0;padding:0 0 12px"><h2 style="margin:0">Health</h2>${live ? `<button onclick="if(confirm('Pull + rebuild QodeX now?'))act('app.update',{})">⟳ Update QodeX</button>` : ''}</div><div class="badges">${healthBadges}</div></div>`;
  const logsPanel = d.logs.length ? `<div class="panel"><h2>Recent log</h2><pre class="logs">${d.logs.map(esc).join('\n')}</pre></div>` : '';

  // "What QodeX knows about you" — preferences + recent task themes (transparent user model).
  const um = d.userModel;
  const umPanel = `<div class="panel"><h2>About you</h2>${
    um.preferences.length ? `<ul>${um.preferences.map(p => `<li>${esc(p)}</li>`).join('')}</ul>` : '<p class="dim">No stated preferences yet — tell me with “Remember” above.</p>'
  }${um.recentThemes.length ? `<p class="dim">Recent focus: ${um.recentThemes.map(esc).join(' · ')}</p>` : ''}</div>`;

  // Model switcher (live: a dropdown of known models; read-only: just the current one).
  const modelCtl = live && d.models.length
    ? `<select onchange="act('model.set',{model:this.value})">${d.models.map(m => `<option${m === d.model ? ' selected' : ''}>${esc(m)}</option>`).join('')}</select>`
    : `<span class="mono">${esc(d.model)}</span>`;
  const modelPanel = `<div class="panel"><div class="ctl"><span>Default model</span>${modelCtl}</div></div>`;

  // Quarantined skill candidates — promote (independent-judge-passed) or reject from here.
  const candRows = d.candidates.length ? d.candidates.map(c => `<li><b>${esc(c.name)}</b>${c.confidence != null ? ` <span class="dim">conf ${c.confidence}</span>` : ''} — <span class="dim">${esc(c.description)}</span>${live ? ` <button onclick="act('skill.promote',{name:'${esc(c.name)}'})">Promote</button> <button class="danger" onclick="act('skill.reject',{name:'${esc(c.name)}'})">Reject</button>` : ''}</li>`).join('') : '<li class="dim">No candidates in quarantine.</li>';
  const candidatePanel = `<div class="panel"><h2>Skill candidates (quarantine)</h2><ul>${candRows}</ul></div>`;
  const providerRows = d.providers.map(p => `<tr>
    <td>${p.isDefault ? '⭐ ' : ''}<b>${esc(p.name)}</b></td>
    <td class="mono dim">${esc(p.baseUrl || '—')}</td>
    <td>${p.models.length ? p.models.map(esc).join('<br>') : '<span class="dim">auto-discover</span>'}</td>
    <td>${p.keyEnv ? (p.keySet ? `<span class="ok">✓ ${esc(p.keyEnv)}</span>` : `<span class="warn">set ${esc(p.keyEnv)}</span>`) : '<span class="dim">local</span>'}</td>
    ${live ? `<td class="r">${p.baseUrl ? `<button onclick="act('provider.test',{name:'${esc(p.name)}'})">Test</button>` : ''}${p.custom ? ` <button class="danger" onclick="if(confirm('Remove ${esc(p.name)}?'))act('provider.remove',{name:'${esc(p.name)}'})">Remove</button>` : ''}</td>` : ''}
  </tr>`).join('');
  const providerAddForm = live ? `<div class="addform">
    <input id="p_name" placeholder="name (e.g. openrouter)">
    <input id="p_url" placeholder="base URL (https://…/v1)" style="flex:2">
    <input id="p_key" placeholder="key env var (OPENROUTER_API_KEY)">
    <input id="p_model" placeholder="model id (optional)">
    <button onclick="act('provider.add',{name:p_name.value,baseUrl:p_url.value,keyEnv:p_key.value,model:p_model.value})">Add &amp; test</button>
  </div><p class="dim" style="margin:8px 0 0">The key itself goes in <span class="mono">~/.qodex/.env</span> as the named env var — never here.</p>` : '';
  const sessionRows = d.sessions.map(s => `<tr>
    <td class="mono dim">${esc(s.id.slice(0, 8))}</td><td>${esc(s.title)}</td>
    <td class="mono dim">${esc(s.model)}</td><td class="r">${s.turns}</td>
    <td class="r">${num(s.tokens)}</td><td class="r">$${s.cost.toFixed(3)}</td><td class="dim">${esc(s.when)}</td>
  </tr>`).join('') || '<tr><td colspan="7" class="dim">No sessions yet.</td></tr>';
  const factList = d.facts.length ? d.facts.map(f => `<li>${esc(f)}</li>`).join('') : '<li class="dim">Nothing learned yet — the agent saves facts as it works.</li>';
  const epList = d.episodes.length ? d.episodes.map(e => `<li><b>${esc(e.prompt)}</b><br><span class="dim">↳ ${esc(e.summary)} · ${esc(e.when)}</span></li>`).join('') : '<li class="dim">No past tasks recorded here yet.</li>';
  const skillList = d.skills.length ? d.skills.map(s => `<li><b>${esc(s.name)}</b> — <span class="dim">${esc(s.description)}</span></li>`).join('') : '<li class="dim">No skills loaded.</li>';
  const chartLabels = JSON.stringify(d.sessions.slice(0, 12).reverse().map(s => s.title.slice(0, 14)));
  const chartTokens = JSON.stringify(d.sessions.slice(0, 12).reverse().map(s => s.tokens));

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QodeX · ${esc(d.project)}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  :root{--bg:#0b0e14;--panel:#131722;--line:#222838;--ink:#e6e9ef;--dim:#8a93a6;--accent:#7c9cff;--green:#5be3a7;--amber:#ffcf6b}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto}
  .wrap{max-width:1100px;margin:0 auto;padding:28px}
  header{display:flex;align-items:baseline;gap:14px;margin-bottom:22px}
  header h1{margin:0;font-size:26px;letter-spacing:.5px;background:linear-gradient(90deg,#7c9cff,#5be3a7);-webkit-background-clip:text;background-clip:text;color:transparent}
  header .sub{color:var(--dim)}
  .cards{display:grid;grid-template-columns:repeat(6,1fr);gap:12px;margin-bottom:24px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px}
  .card .v{font-size:24px;font-weight:700}.card .l{color:var(--dim);font-size:12px;margin-top:2px}
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px;margin-bottom:18px}
  .panel h2{margin:0 0 12px;font-size:14px;text-transform:uppercase;letter-spacing:1px;color:var(--dim)}
  table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
  th{color:var(--dim);font-weight:600;font-size:12px}.r{text-align:right}.mono{font-family:ui-monospace,Menlo,monospace;font-size:12px}
  .dim{color:var(--dim)}.ok{color:var(--green)}.warn{color:var(--amber)}
  ul{margin:0;padding-left:18px}li{margin:5px 0}
  .two{display:grid;grid-template-columns:1fr 1fr;gap:18px}
  .ctl{display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--line)}
  .ctl:last-child{border-bottom:0}
  button,select{font:inherit;color:var(--ink);background:#1b2233;border:1px solid var(--line);border-radius:8px;padding:5px 12px;cursor:pointer}
  button:hover{border-color:var(--accent)}
  .tg.on{background:rgba(91,227,167,.15);border-color:var(--green);color:var(--green)}
  .tg{min-width:54px}.danger:hover{border-color:#ff6b6b;color:#ff6b6b}
  .badges{display:flex;flex-wrap:wrap;gap:8px}
  .badge{padding:5px 10px;border-radius:20px;font-size:12px;border:1px solid var(--line)}
  .badge.ok{color:var(--green);border-color:rgba(91,227,167,.4)}.badge.warn{color:var(--amber);border-color:rgba(255,207,107,.4)}
  pre.logs{margin:0;max-height:240px;overflow:auto;font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--dim);white-space:pre-wrap;word-break:break-word}
  .addform{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
  .addform input,.addform select{flex:1;min-width:120px;background:#1b2233;border:1px solid var(--line);border-radius:8px;padding:6px 10px;color:var(--ink);font:inherit}
  a{color:var(--accent)}
  #toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--panel);border:1px solid var(--accent);border-radius:10px;padding:10px 18px;opacity:0;transition:opacity .2s;pointer-events:none}
  #toast.show{opacity:1}
  @media(max-width:820px){.cards{grid-template-columns:repeat(3,1fr)}.two{grid-template-columns:1fr}}
</style></head><body><div class="wrap">
  <header><h1>QodeX</h1><div class="sub">${esc(d.project)} · model <span class="mono">${esc(d.model)}</span> · ${esc(d.generatedAt)}</div></header>
  <div class="cards">
    ${card('sessions', String(d.totals.sessions), 'var(--accent)')}
    ${card('tokens', num(d.totals.tokens), 'var(--green)')}
    ${card('cost', '$' + d.totals.cost.toFixed(2), 'var(--amber)')}
    ${card('facts', String(d.totals.facts), 'var(--accent)')}
    ${card('episodes', String(d.totals.episodes), 'var(--green)')}
    ${card('skills', String(d.totals.skills), 'var(--accent)')}
  </div>
  ${healthPanel}
  <div class="panel"><h2>Tokens per recent session</h2><canvas id="chart" height="90"></canvas></div>
  ${live ? '' : '<p class="dim" style="margin:-6px 0 14px">Read-only snapshot. Run <b>qodex dashboard</b> (server mode) for live controls.</p>'}
  ${modelPanel}
  <div class="two">${controlPanel}</div>
  ${schedulePanel}
  ${maintainPanel}
  ${runsPanel}
  <div class="panel"><h2>Providers &amp; models</h2><table><thead><tr><th>Provider</th><th>Base URL</th><th>Models</th><th>API key</th>${live ? '<th class="r">test / remove</th>' : ''}</tr></thead><tbody>${providerRows}</tbody></table>${providerAddForm}</div>
  ${botPanel}
  <div class="panel"><h2>Recent sessions</h2><table><thead><tr><th>id</th><th>title</th><th>model</th><th class="r">turns</th><th class="r">tokens</th><th class="r">cost</th><th>when</th></tr></thead><tbody>${sessionRows}</tbody></table></div>
  <div class="two">
    <div class="panel"><h2>Memory · learned facts</h2><ul>${factList}</ul>${live ? `<div class="ctl" style="border:0;padding-top:10px"><input id="newfact" placeholder="Remember a fact about this project…" style="flex:1;margin-right:8px;background:#1b2233;border:1px solid var(--line);border-radius:8px;padding:6px 10px;color:var(--ink)"><button onclick="const i=document.getElementById('newfact');if(i.value.trim())act('memory.add',{fact:i.value.trim()})">Remember</button></div>` : ''}</div>
    <div class="panel"><h2>Episodic memory · past tasks</h2><ul>${epList}</ul></div>
  </div>
  ${umPanel}
  <div class="panel"><h2>Skills</h2><ul>${skillList}</ul></div>
  ${candidatePanel}
  ${logsPanel}
  <p class="dim" style="text-align:center">Generated by <b>qodex dashboard</b> — all data is local, under ~/.qodex/.</p>
</div>
<div id="toast"></div>
<script>
  new Chart(document.getElementById('chart'),{type:'bar',
    data:{labels:${chartLabels},datasets:[{label:'tokens',data:${chartTokens},backgroundColor:'#7c9cff',borderRadius:6}]},
    options:{plugins:{legend:{display:false}},scales:{x:{ticks:{color:'#8a93a6'},grid:{display:false}},y:{ticks:{color:'#8a93a6'},grid:{color:'#222838'}}}}});
${live ? `
  const TOKEN = ${JSON.stringify(opts.token)};
  function toast(msg, ok){ const t=document.getElementById('toast'); t.textContent=msg; t.style.borderColor=ok?'var(--green)':'#ff6b6b'; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),2600); }
  async function act(action, params){
    try{
      const r = await fetch('/api/action?k='+encodeURIComponent(TOKEN),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,params})});
      const j = await r.json();
      toast(j.message || (j.ok?'Done':'Failed'), j.ok);
      if(j.ok) setTimeout(()=>location.reload(), 700);
    }catch(e){ toast(String(e), false); }
  }
` : ''}
</script></body></html>`;
}

/** Gather the dashboard's data from the live stores + config. Defensive — a missing source is empty. */
export async function gatherDashboardData(cwd: string): Promise<DashboardData> {
  const { loadConfig } = await import('../config/loader.js');
  const { getSessionStore } = await import('../session/store.js');
  const config: any = await loadConfig(cwd).catch(() => ({ defaults: {}, providers: {} }));
  const store = getSessionStore();

  const project = (() => { try { return store.getProject(cwd)?.name || path.basename(cwd); } catch { return path.basename(cwd); } })();
  const defModel = config?.defaults?.model ?? '(unset)';
  const defProvider = config?.defaults?.provider;

  // Providers: built-ins present in config + user customs.
  const providers: DashboardData['providers'] = [];
  const pcfg = config?.providers ?? {};
  for (const [name, v] of Object.entries<any>(pcfg)) {
    if (name === 'custom') continue;
    providers.push({
      name, baseUrl: v?.baseUrl ?? '', keyEnv: v?.apiKeyEnv,
      keySet: v?.apiKeyEnv ? !!process.env[v.apiKeyEnv] : undefined,
      models: (v?.extraModels ?? []).map((m: any) => m.id).filter(Boolean),
      isDefault: name === defProvider,
    });
  }
  for (const c of (pcfg.custom ?? [])) {
    providers.push({
      name: c.name, baseUrl: c.baseUrl ?? '', keyEnv: c.apiKeyEnv,
      keySet: c.apiKeyEnv ? !!process.env[c.apiKeyEnv] : undefined,
      models: (c.models ?? []).map((m: any) => m.id).filter(Boolean),
      isDefault: c.name === defProvider, custom: true,
    });
  }

  const metas = (() => { try { return store.listRecentSessions(20, cwd); } catch { return []; } })();
  const sessions = metas.map(s => ({
    id: s.id, title: (s.title ?? '').trim() || `${s.turn_count} turn${s.turn_count === 1 ? '' : 's'}`,
    model: s.model, turns: s.turn_count, tokens: s.total_input_tokens + s.total_output_tokens,
    cost: s.total_cost_usd, when: relTime(s.updated_at),
  }));

  const facts = (() => { try { return store.getFactsForCwd(cwd, 30); } catch { return []; } })();
  const episodes = await (async () => {
    try { const { readEpisodes } = await import('../context/episodic-memory.js'); return (await readEpisodes(cwd)).slice(-10).reverse().map(e => ({ when: relTime(e.ts), prompt: e.prompt, summary: e.summary })); }
    catch { return []; }
  })();
  const skills = await (async () => {
    try { const { loadSkills } = await import('../skills/loader.js'); return [...(await loadSkills(cwd)).values()].map((s: any) => ({ name: s.name, description: (s.description ?? '').slice(0, 90) })); }
    catch { return []; }
  })();

  // Controllable settings: current value of each whitelisted knob (for the toggles/selects).
  const { CONFIG_KNOBS, getDeep } = await import('./dashboard-control.js');
  const controls = CONFIG_KNOBS.map(k => {
    const cur = getDeep(config, k.path);
    const dflt = k.path === 'providers.anthropic.useCaching' ? true : (k.type === 'enum' ? (k.values?.[0] ?? '') : false);
    const current = cur === undefined ? dflt : cur;
    return { path: k.path, label: k.label, group: k.group, type: k.type, values: k.values, current: String(current) };
  });
  const schedules = await (async () => {
    try { const { getScheduleStore } = await import('../schedule/store.js'); return getScheduleStore().list().map(s => ({ id: s.id, name: s.name, cron: s.cron, enabled: !!s.enabled, recipe: s.recipe })); }
    catch { return []; }
  })();
  // Known models (for the model switcher) = every model the configured providers expose + the current default.
  const models = (() => {
    const set = new Set<string>();
    if (defModel && defModel !== '(unset)') set.add(defModel);
    for (const p of providers) for (const m of p.models) set.add(m);
    return [...set];
  })();
  const candidates = await (async () => {
    try { const { listCandidates } = await import('../skills/learning/candidate-store.js'); return (await listCandidates()).map(c => ({ name: c.name, description: (c.description ?? '').slice(0, 90), confidence: c.confidence })); }
    catch { return []; }
  })();
  // Run history + trust receipts: the most recent runs across all schedules.
  const runs = await (async () => {
    try {
      const { getScheduleStore } = await import('../schedule/store.js');
      const { parseMaintainScope } = await import('../schedule/recipes.js');
      const store = getScheduleStore();
      const all: DashboardData['runs'] = [];
      for (const s of store.list()) {
        const recipeLabel = s.recipe === 'maintain'
          ? `maintain · ${parseMaintainScope(s.prompt).scope}${parseMaintainScope(s.prompt).dryRun ? ' (dry-run)' : ''}`
          : s.recipe;
        for (const r of store.recentRuns(s.id, 3)) {
          let receipt: DashboardData['runs'][number]['receipt'];
          if (r.receipt) { try { const rc = JSON.parse(r.receipt); receipt = { status: rc.status, prUrl: rc.prUrl, verification: rc.verification }; } catch { /* ignore */ } }
          all.push({ schedule: s.name, recipe: recipeLabel, when: relTime(r.started_at), status: r.status ?? 'running', receipt });
        }
      }
      return all.slice(0, 12);
    } catch { return []; }
  })();
  // Maintain analytics: aggregate ALL maintain runs (not just recent 12) into status stats,
  // a week-over-week report, and an auto-recommended next scope.
  const maintain = await (async () => {
    try {
      const { getScheduleStore } = await import('../schedule/store.js');
      const { parseMaintainScope, MAINTAIN_SCOPES } = await import('../schedule/recipes.js');
      const { buildMaintainStats, weeklyReport, recommendNextScope } = await import('./maintain-stats.js');
      const store = getScheduleStore();
      const mruns: import('./maintain-stats.js').MaintainRun[] = [];
      for (const s of store.list().filter(s => s.recipe === 'maintain')) {
        const scope = parseMaintainScope(s.prompt).scope;
        for (const r of store.recentRuns(s.id, 50)) {
          let status = r.status ?? 'running'; let files = 0;
          if (r.receipt) { try { const rc = JSON.parse(r.receipt); status = rc.status ?? status; files = (rc.filesChanged ?? []).length; } catch { /* ignore */ } }
          mruns.push({ scope, status, filesChanged: files, when: relTime(r.started_at), at: r.started_at });
        }
      }
      const stats = buildMaintainStats(mruns);
      return { stats, weekly: weeklyReport(mruns, Date.now()), next: recommendNextScope(mruns, stats, MAINTAIN_SCOPES) };
    } catch { return undefined; }
  })();
  const maintainStats = maintain?.stats;
  const bot = await (async () => {
    try { const { botStatus } = await import('./bot-process.js'); return await botStatus(); }
    catch { return { running: false }; }
  })();
  const { computeHealth, tailLines } = await import('./dashboard-observability.js');
  const health = computeHealth({
    providers, schedulesEnabled: schedules.filter(s => s.enabled).length, botRunning: bot.running,
    modelSet: !!defModel && defModel !== '(unset)', lastRunStatus: runs[0]?.status,
  });
  const logs = await (async () => {
    try { const { QODEX_LOG_FILE } = await import('../config/defaults.js'); return tailLines(await fs.readFile(QODEX_LOG_FILE, 'utf-8'), 40); }
    catch { return []; }
  })();
  const userModel = await (async () => {
    try {
      const { buildUserModel } = await import('../context/user-model.js');
      const userFacts = (() => { try { return store.getFactsByScope('user', cwd, 100); } catch { return []; } })();
      const eps = await (async () => { try { const { readEpisodes } = await import('../context/episodic-memory.js'); return await readEpisodes(cwd); } catch { return []; } })();
      return buildUserModel({ userFacts, episodePrompts: eps.map(e => e.prompt) });
    } catch { return { preferences: [], recentThemes: [], taskCount: 0, summary: '' }; }
  })();

  return {
    project, model: defModel, generatedAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
    providers, sessions, facts, episodes, skills, controls, schedules, models, candidates, runs, bot, health, logs, userModel,
    maintainStats, maintainWeekly: maintain?.weekly, maintainNext: maintain?.next ?? undefined,
    totals: {
      sessions: sessions.length, tokens: sessions.reduce((a, s) => a + s.tokens, 0),
      cost: sessions.reduce((a, s) => a + s.cost, 0), facts: facts.length, episodes: episodes.length, skills: skills.length,
    },
  };
}

/** Start the LIVE control dashboard: a local (127.0.0.1, token-protected) server that serves the
 *  interactive page and the action API, and open it in the browser. Returns the tokened URL.
 *  Runs until the process is stopped. */
export async function runDashboard(cwd: string): Promise<string> {
  const { ensureQodexHome } = await import('../config/loader.js');
  await ensureQodexHome().catch(() => {});
  const { startDashboardServer } = await import('./dashboard-server.js');
  const server = await startDashboardServer({
    cwd,
    buildHtml: async (token) => buildDashboardHtml(await gatherDashboardData(cwd), { token }),
    getState: async () => gatherDashboardData(cwd),
  });
  try { const { openUrl } = await import('../artifacts/open-browser.js'); await openUrl(server.url); } catch { /* best-effort — print the URL */ }
  return server.url;
}

/** Build a static, read-only dashboard file (no server) — kept for `qodex dashboard --static`. */
export async function writeStaticDashboard(cwd: string): Promise<string> {
  const { ensureQodexHome } = await import('../config/loader.js');
  const { QODEX_HOME } = await import('../config/defaults.js');
  await ensureQodexHome().catch(() => {});
  const out = path.join(QODEX_HOME, 'dashboard.html');
  await fs.writeFile(out, buildDashboardHtml(await gatherDashboardData(cwd)));
  try { const { openUrl } = await import('../artifacts/open-browser.js'); await openUrl('file://' + out); } catch { /* best-effort */ }
  return out;
}

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  const m = s / 60; if (m < 60) return `${Math.floor(m)}m ago`;
  const h = m / 60; if (h < 24) return `${Math.floor(h)}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
