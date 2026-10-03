/**
 * End-to-end: workflows against the REAL QodeX browser manager, the real
 * browser_* tools and the real Sentinel (not adapters / fakes). Catches contract
 * drift between the modules: the action records the browser tools publish, the
 * ElementInfo selectors they describe, the manager's `.first()` locators and
 * `describeSelector`, the persistent context the human capture binds to, and
 * Sentinel's review of replayed steps. Local http server only; skipped when no
 * Chromium is available.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import type { ToolContext } from '../src/tools/base.js';
import { resolveBrowserExecutable } from '../src/tools/browser/launcher.js';
import { QodexBrowserManager } from '../src/tools/browser/session.js';
import { setBrowserManagerForTests } from '../src/tools/browser/types.js';
import { BrowserNavigateTool } from '../src/tools/browser/tools.js';
import { BrowserSnapshotTool, BrowserTypeTool } from '../src/tools/browser/tools-extra.js';
import { Sentinel } from '../src/sentinel/index.js';
import { resolveSentinelConfig } from '../src/config/agent-config.js';
import { WorkflowRecorder } from '../src/workflows/recorder.js';
import { runWorkflow } from '../src/workflows/replay.js';
import { validateWorkflow } from '../src/workflows/store.js';
import type { Workflow } from '../src/workflows/types.js';

let pw: any = null;
try { pw = await import('playwright'); } catch { pw = null; }
let pwExe = '';
try { pwExe = String(pw?.chromium?.executablePath?.() ?? ''); } catch { pwExe = ''; }
const exe = resolveBrowserExecutable({ playwrightExecutablePath: pwExe, headless: true });
const chromium = !!pw && !!(exe.executablePath || exe.channel);

const HOME = `<!doctype html><html><head><title>Tea Shop</title></head><body>
<form id="search" action="/results" method="get"><input name="q" type="search" aria-label="Search"><button>Go</button></form>
</body></html>`;

// A hidden newsletter form comes first; the visible "Submit" posts to a payment gateway.
const CHECKOUT = `<!doctype html><html><head><title>Checkout</title></head><body>
<form action="/newsletter" style="display:none"><button type="submit">Submit</button></form>
<form action="https://www.paypal.com/cgi-bin/webscr" method="post"><button type="submit">Submit</button></form>
</body></html>`;

function refOf(text: string, role: string, name: string): string {
  const m = new RegExp(`- ${role} "${name}"[^\\n]*?\\[ref=([a-z0-9]+)\\]`).exec(text);
  if (!m) throw new Error(`no ${role} "${name}" in snapshot:\n${text}`);
  return m[1]!;
}

describe.skipIf(!chromium)('workflows with the real QodeX browser, tools and Sentinel', () => {
  let server: http.Server;
  let base = '';
  let tmp = '';
  let mgr: QodexBrowserManager;
  const prompts: string[] = [];
  const ctx = {
    cwd: process.cwd(),
    sessionId: 'wf-e2e',
    transaction: {} as any,
    permissions: { evaluate: () => 'ask' } as any,
    askUser: async (p: string) => { prompts.push(p); return 'no'; },
    emit: () => {},
    signal: new AbortController().signal,
  } as ToolContext;
  const sentinel = () => new Sentinel({ audit: null, interactive: () => true, browser: () => mgr, config: () => resolveSentinelConfig({}) });

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-wf-e2e-'));
    server = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://x');
      res.setHeader('content-type', 'text/html; charset=utf-8');
      if (u.pathname === '/') res.end(HOME);
      else if (u.pathname === '/donate') res.end(CHECKOUT);
      else if (u.pathname === '/results') res.end(`<title>Results</title><h1 id="term">${(u.searchParams.get('q') ?? '').replace(/[<>&]/g, '')}</h1>`);
      else { res.statusCode = 404; res.end('nope'); }
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    mgr = new QodexBrowserManager({ profilesDir: path.join(tmp, 'profiles'), downloadsDir: path.join(tmp, 'downloads'), config: { headless: true } });
    setBrowserManagerForTests(mgr);
  }, 60_000);

  afterAll(async () => {
    await mgr?.close().catch(() => {});
    setBrowserManagerForTests(null);
    await new Promise<void>(r => (server ? server.close(() => r()) : r()));
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it('records real browser_* tool calls, then replays them with a new param under Sentinel', async () => {
    const rec = new WorkflowRecorder();
    await rec.start({ name: 'e2e-search', description: 'Search the tea shop', source: 'agent', mgr });
    const nav = new BrowserNavigateTool();
    expect((await nav.execute(nav.argsSchema.parse({ url: base + '/' }), ctx)).isError).toBeFalsy();
    const snapTool = new BrowserSnapshotTool();
    const snap = await snapTool.execute(snapTool.argsSchema.parse({}), ctx);
    const type = new BrowserTypeTool();
    const typed = await type.execute(type.argsSchema.parse({ ref: refOf(snap.content, 'searchbox', 'Search'), text: 'green tea', submit: true }), ctx);
    expect(typed.isError).toBeFalsy();
    const wf = await rec.stop();

    expect(wf.steps.map(s => s.kind)).toEqual(['navigate', 'fill', 'press']);
    expect(wf.steps[1]).toMatchObject({ selector: '#search input[name="q"]', role: 'searchbox', name: 'Search', value: '{{search}}' });
    expect(wf.steps[2]).toMatchObject({ key: 'Enter', selector: '#search input[name="q"]' });
    expect(wf.params).toEqual([{ name: 'search', description: 'Text for searchbox "Search"', example: 'green tea' }]);
    expect(validateWorkflow(wf).ok).toBe(true);

    prompts.length = 0;
    const r = await runWorkflow(wf, [{ name: 'search', value: 'black tea' }], { mgr, ctx, guard: sentinel(), secretFiller: null });
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(prompts).toEqual([]); // nothing consequential
    expect(mgr.activeUrl()).toContain('/results?q=black+tea');
  }, 90_000);

  it('Sentinel reviews the element replay actually clicks — a hidden look-alike first cannot launder a payment', async () => {
    const wf: Workflow = {
      name: 'pay', description: '', version: 1, createdAt: '2026-10-01T00:00:00Z', source: 'agent', params: [],
      // Recorded long ago: the selector and the role are gone, so replay heals via the text "Submit".
      steps: [{ kind: 'navigate', url: base + '/donate' }, { kind: 'click', selector: '#pay-v1', role: 'link', name: 'Submit' }],
    };
    prompts.length = 0;
    const r = await runWorkflow(wf, [], { mgr, ctx, guard: sentinel(), secretFiller: null, actionTimeoutMs: 1500 });
    expect(r.ok).toBe(false);
    expect(r.failedStep).toBe(2);
    expect(r.error).toMatch(/SENTINEL_DENIED/);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatch(/payment/i);
    expect(mgr.activeUrl()).toBe(base + '/donate');
  }, 60_000);

  it('a mixed recording keeps ONE fill + Enter when the agent types with submit (the page capture sees it too)', async () => {
    const page = await mgr.activePage();
    await page.goto(base + '/');
    const rec = new WorkflowRecorder();
    await rec.start({ name: 'mixed-e2e', source: 'mixed', mgr });
    const type = new BrowserTypeTool();
    const res = await type.execute(type.argsSchema.parse({ selector: 'input[name="q"]', text: 'rooibos', submit: true }), ctx);
    expect(res.isError).toBeFalsy();
    await page.waitForURL(/\/results/);
    const { BrowserPressTool } = await import('../src/tools/browser/tools-extra.js');
    await page.goBack();
    await page.waitForLoadState('domcontentloaded');
    await page.fill('input[name="q"]', 'mate');           // the human types…
    const press = new BrowserPressTool();                   // …and the agent presses Enter on the focused field
    expect((await press.execute(press.argsSchema.parse({ key: 'Enter' }), ctx)).isError).toBeFalsy();
    await page.waitForURL(/q=mate/);
    const wf = await rec.stop();
    // No echo of the agent's own fill / Enter, no "navigation" for the result pages
    // its Enter loaded — but the human's Back and typing are kept.
    expect(wf.steps.map(s => `${s.actor}:${s.kind} ${s.url ?? s.key ?? s.value ?? ''}`.trim())).toEqual([
      `agent:navigate ${base}/`,
      'agent:fill {{search}}',
      'agent:press Enter',
      `human:navigate ${base}/`,
      'human:fill {{search_2}}',
      'agent:press Enter',
    ]);
    expect(wf.params.map(p => p.example)).toEqual(['rooibos', 'mate']);
  }, 60_000);

  it('captures a human demonstration through the manager\'s persistent context', async () => {
    const page = await mgr.activePage();
    await page.goto(base + '/');
    const rec = new WorkflowRecorder();
    const st = await rec.start({ name: 'human-e2e', source: 'human', mgr });
    expect(st.capturing).toBe(true);
    await page.fill('input[name="q"]', 'oolong');
    // Enter in a text field fires `change` AND an implicit (synthetic, trusted)
    // click on the form's submit button — neither may become an extra step, or
    // the replay would re-fill / click "Go" on the results page and fail.
    await Promise.all([page.waitForURL(/\/results/), page.press('input[name="q"]', 'Enter')]);
    const wf = await rec.stop();
    expect(wf.steps.map(s => `${s.kind} ${s.selector ?? s.url ?? ''} ${s.value ?? s.key ?? ''}`.trim())).toEqual([
      `navigate ${base}/`,
      'fill input[name="q"] {{search}}',
      'press input[name="q"] Enter',
    ]);
    expect(wf.params[0]).toMatchObject({ name: 'search', example: 'oolong' });

    // ... and it replays cleanly with another value.
    const r = await runWorkflow(wf, [{ name: 'search', value: 'sencha' }], { mgr, ctx, guard: sentinel(), secretFiller: null });
    expect(r.error).toBeUndefined();
    expect(mgr.activeUrl()).toContain('/results?q=sencha');
  }, 60_000);
});
