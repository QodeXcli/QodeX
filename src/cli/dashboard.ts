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
  providers: { name: string; baseUrl: string; keyEnv?: string; keySet?: boolean; models: string[]; isDefault: boolean }[];
  sessions: { id: string; title: string; model: string; turns: number; tokens: number; cost: number; when: string }[];
  facts: string[];
  episodes: { when: string; prompt: string; summary: string }[];
  skills: { name: string; description: string }[];
  totals: { sessions: number; tokens: number; cost: number; facts: number; episodes: number; skills: number };
}

const esc = (s: string) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const num = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n);

/** Render the dashboard as one self-contained HTML page (PURE). Chart.js via CDN; everything else inline. */
export function buildDashboardHtml(d: DashboardData): string {
  const card = (label: string, value: string, accent: string) =>
    `<div class="card"><div class="v" style="color:${accent}">${value}</div><div class="l">${label}</div></div>`;
  const providerRows = d.providers.map(p => `<tr>
    <td>${p.isDefault ? '⭐ ' : ''}<b>${esc(p.name)}</b></td>
    <td class="mono dim">${esc(p.baseUrl || '—')}</td>
    <td>${p.models.length ? p.models.map(esc).join('<br>') : '<span class="dim">auto-discover</span>'}</td>
    <td>${p.keyEnv ? (p.keySet ? `<span class="ok">✓ ${esc(p.keyEnv)}</span>` : `<span class="warn">set ${esc(p.keyEnv)}</span>`) : '<span class="dim">local</span>'}</td>
  </tr>`).join('');
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
  <div class="panel"><h2>Tokens per recent session</h2><canvas id="chart" height="90"></canvas></div>
  <div class="panel"><h2>Providers &amp; models</h2><table><thead><tr><th>Provider</th><th>Base URL</th><th>Models</th><th>API key</th></tr></thead><tbody>${providerRows}</tbody></table></div>
  <div class="panel"><h2>Recent sessions</h2><table><thead><tr><th>id</th><th>title</th><th>model</th><th class="r">turns</th><th class="r">tokens</th><th class="r">cost</th><th>when</th></tr></thead><tbody>${sessionRows}</tbody></table></div>
  <div class="two">
    <div class="panel"><h2>Memory · learned facts</h2><ul>${factList}</ul></div>
    <div class="panel"><h2>Episodic memory · past tasks</h2><ul>${epList}</ul></div>
  </div>
  <div class="panel"><h2>Skills</h2><ul>${skillList}</ul></div>
  <p class="dim" style="text-align:center">Generated by <b>qodex dashboard</b> — all data is local, under ~/.qodex/.</p>
</div>
<script>
  new Chart(document.getElementById('chart'),{type:'bar',
    data:{labels:${chartLabels},datasets:[{label:'tokens',data:${chartTokens},backgroundColor:'#7c9cff',borderRadius:6}]},
    options:{plugins:{legend:{display:false}},scales:{x:{ticks:{color:'#8a93a6'},grid:{display:false}},y:{ticks:{color:'#8a93a6'},grid:{color:'#222838'}}}}});
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
      isDefault: c.name === defProvider,
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

  return {
    project, model: defModel, generatedAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
    providers, sessions, facts, episodes, skills,
    totals: {
      sessions: sessions.length, tokens: sessions.reduce((a, s) => a + s.tokens, 0),
      cost: sessions.reduce((a, s) => a + s.cost, 0), facts: facts.length, episodes: episodes.length, skills: skills.length,
    },
  };
}

/** Build the dashboard, write it to ~/.qodex/dashboard.html, and open it in the browser. */
export async function runDashboard(cwd: string): Promise<string> {
  const { ensureQodexHome } = await import('../config/loader.js');
  const { QODEX_HOME } = await import('../config/defaults.js');
  await ensureQodexHome().catch(() => {});
  const data = await gatherDashboardData(cwd);
  const out = path.join(QODEX_HOME, 'dashboard.html');
  await fs.writeFile(out, buildDashboardHtml(data));
  try { const { openUrl } = await import('../artifacts/open-browser.js'); await openUrl('file://' + out); } catch { /* best-effort — print the path */ }
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
