/**
 * Real-browser check of the workflow recorder's in-page capture and of replay
 * (self-healing selectors) against a local HTTP server. Skipped when Playwright
 * or a Chromium executable isn't available. Uses a minimal BrowserManager
 * adapter over a plain Playwright context so it doesn't depend on the full
 * QodeX browser session.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readdirSync } from 'fs';
import * as http from 'http';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { createRequire } from 'module';
import { WorkflowRecorder } from '../src/workflows/recorder.js';
import { runWorkflow } from '../src/workflows/replay.js';
import { validateWorkflow } from '../src/workflows/store.js';
import type { Workflow } from '../src/workflows/types.js';
import type { BrowserActionRecord, BrowserManager, BrowserStatus, ElementInfo, TabInfo } from '../src/tools/browser/types.js';

const require = createRequire(import.meta.url);

function findChromium(): string | null {
  const candidates: string[] = [];
  if (process.env.QODEX_BROWSER_EXECUTABLE) candidates.push(process.env.QODEX_BROWSER_EXECUTABLE);
  candidates.push('/opt/pw-browsers/chromium');
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(process.env.HOME ?? '', '.cache', 'ms-playwright')].filter((x): x is string => !!x);
  for (const root of roots) {
    try {
      for (const d of readdirSync(root).filter(n => /^chromium-\d+$/.test(n)).sort().reverse()) {
        candidates.push(path.join(root, d, 'chrome-linux', 'chrome'), path.join(root, d, 'chrome-linux64', 'chrome'));
      }
    } catch { /* no such root */ }
  }
  return candidates.find(p => { try { return existsSync(p); } catch { return false; } }) ?? null;
}

let playwright: any = null;
try { playwright = require('playwright'); } catch { playwright = null; }
const chromiumPath = playwright ? findChromium() : null;

class RealManager implements BrowserManager {
  active: any = null;
  listeners = new Set<(r: BrowserActionRecord) => void>();
  constructor(private ctx: any) {
    ctx.on('page', (p: any) => { this.active = p; });
  }
  async ensure(): Promise<void> {}
  isRunning(): boolean { return true; }
  status(): BrowserStatus { return { running: true, mode: 'launch', headless: true, profile: 'test', tabs: this.tabs(), takeover: false, downloadsDir: '/tmp' }; }
  async activePage(): Promise<any> {
    if (!this.active || this.active.isClosed()) {
      const pages = this.ctx.pages();
      this.active = pages[pages.length - 1] ?? await this.ctx.newPage();
    }
    return this.active;
  }
  context(): any { return this.ctx; }
  tabs(): TabInfo[] { return this.ctx.pages().map((p: any, i: number) => ({ index: i, id: String(i), url: p.url(), title: '', active: p === this.active })); }
  async newTab(url?: string): Promise<TabInfo> { const p = await this.ctx.newPage(); this.active = p; if (url) await p.goto(url); return this.tabs()[this.tabs().length - 1]!; }
  async switchTab(i: number): Promise<TabInfo> { this.active = this.ctx.pages()[i] ?? this.active; return this.tabs()[i]!; }
  async closeTab(i?: number): Promise<void> { const p = i === undefined ? this.active : this.ctx.pages()[i]; await p?.close(); this.active = null; }
  async close(): Promise<void> {}
  async restart(): Promise<void> {}
  async startScreencast(): Promise<() => Promise<void>> { return async () => {}; }
  async screenshotJpeg(): Promise<Buffer> { return Buffer.alloc(0); }
  setTakeover(): void {}
  isTakeover(): boolean { return false; }
  async waitForTakeoverEnd(): Promise<void> {}
  async dispatchInput(): Promise<void> {}
  async locator(t: { ref?: string; selector?: string }): Promise<any> {
    if (t.ref) throw new Error(`[STALE_REF] ref ${t.ref} not found`);
    return (await this.activePage()).locator(t.selector!);
  }
  activeUrl(): string { return this.active && !this.active.isClosed() ? this.active.url() : ''; }
  async describeRef(): Promise<ElementInfo | null> { return null; }
  async describeSelector(): Promise<ElementInfo | null> { return null; }
  onAction(l: (r: BrowserActionRecord) => void): () => void { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
  recordAction(rec: Omit<BrowserActionRecord, 'ts'> & { ts?: number }): void {
    const full = { ...rec, ts: rec.ts ?? Date.now() } as BrowserActionRecord;
    for (const l of this.listeners) l(full);
  }
}

const V1 = `<!doctype html><html><head><title>Shop</title></head><body>
<form action="/results" method="get" id="search-form">
  <label for="q">Search products</label>
  <input id="q" name="q" type="search">
  <label><input type="checkbox" name="instock" id="instock"> In stock only</label>
  <label for="sort">Sort by</label>
  <select name="sort" id="sort"><option value="relevance">Relevance</option><option value="price">Price</option></select>
  <button type="submit">Search</button>
</form>
<form id="login" onsubmit="return false">
  <label for="pw">Password</label><input type="password" name="pw" id="pw" autocomplete="current-password">
  <button type="button" id="noop">Remember me</button>
</form>
</body></html>`;

// Same page after a "redesign": ids and field names changed, labels kept.
const V2 = `<!doctype html><html><head><title>Shop v2</title></head><body>
<main><form action="/results" method="get" class="s">
  <label for="query">Search products</label>
  <input id="query" name="query" type="search">
  <label><input type="checkbox" name="stock" id="stock"> In stock only</label>
  <label for="order">Sort by</label>
  <select name="order" id="order"><option value="relevance">Relevance</option><option value="price">Price</option></select>
  <button type="submit" class="btn">Search</button>
</form>
<form onsubmit="return false"><label for="secret">Password</label><input type="password" id="secret">
  <button type="button" class="rm">Remember me</button></form></main>
</body></html>`;

// A "show password" toggle flips the field to type=text before it loses focus.
const TOGGLE = `<!doctype html><html><head><title>Login</title></head><body>
<label for="pass">Password</label><input type="password" id="pass">
<button type="button" id="show" onclick="document.getElementById('pass').type='text'">Show</button>
<label for="pin">Card PIN</label><input type="text" id="pin" name="card_pin">
<button type="button" id="done">Done</button>
</body></html>`;

function results(u: URL): string {
  const q = u.searchParams.get('q') ?? u.searchParams.get('query') ?? '';
  const sort = u.searchParams.get('sort') ?? u.searchParams.get('order') ?? '';
  const stock = u.searchParams.get('instock') ?? u.searchParams.get('stock') ?? 'off';
  const esc = (s: string) => s.replace(/[<>&"]/g, c => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><html><head><title>Results</title></head><body><h1>Results for <span id="term">${esc(q)}</span></h1><p id="meta">sort=${esc(sort)} stock=${esc(stock)}</p></body></html>`;
}

describe('workflows on a real Chromium', () => {
  let server: http.Server;
  let base = '';
  let browser: any;
  let recorded: Workflow | null = null;

  beforeAll(async () => {
    if (!chromiumPath) return;
    server = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1');
      res.setHeader('content-type', 'text/html; charset=utf-8');
      if (u.pathname === '/') res.end(V1);
      else if (u.pathname === '/v2') res.end(V2);
      else if (u.pathname === '/results') res.end(results(u));
      else if (u.pathname === '/toggle') res.end(TOGGLE);
      else { res.statusCode = 404; res.end('nope'); }
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await playwright.chromium.launch({ headless: true, executablePath: chromiumPath, args: ['--no-proxy-server'] });
  }, 60_000);

  afterAll(async () => {
    await browser?.close().catch(() => {});
    await new Promise<void>(r => (server ? server.close(() => r()) : r()));
  });

  it.skipIf(!chromiumPath)('captures a human demonstration with stable selectors and no secret values', async () => {
    const ctx = await browser.newContext();
    const mgr = new RealManager(ctx);
    const page = await mgr.activePage();
    await page.goto(base + '/');
    const rec = new WorkflowRecorder();
    const st = await rec.start({ name: 'shop-search', description: 'Search the shop', source: 'human', mgr });
    expect(st.capturing).toBe(true);

    // A "human" (Playwright input = real trusted DOM events) demonstrates.
    await page.fill('#q', 'green tea');
    await page.check('#instock');
    await page.selectOption('#sort', 'price');
    await page.fill('#pw', 'hunter2-secret');
    await page.click('#noop');
    await Promise.all([page.waitForURL(/\/results/), page.getByRole('button', { name: 'Search', exact: true }).click()]);
    await page.waitForLoadState('domcontentloaded');

    const wf = await rec.stop();
    const json = JSON.stringify(wf);
    expect(json).not.toContain('hunter2-secret');
    expect(wf.source).toBe('human');
    expect(wf.startUrl).toBe(base + '/');
    const summary = wf.steps.map(s => `${s.kind} ${s.selector ?? s.url ?? ''} ${s.value ?? s.values?.join(',') ?? ''}`.trim());
    expect(summary).toEqual([
      `navigate ${base}/`,
      'fill #q {{search_products}}',
      'fill #instock true',
      'select #sort price',
      'fill #pw {{password}}',
      'click #noop',
      'click role=button[name="Search"s]',
    ]);
    const fillQ = wf.steps[1]!;
    expect(fillQ).toMatchObject({ role: 'searchbox', name: 'Search products' });
    expect(wf.steps[2]).toMatchObject({ role: 'checkbox', name: 'In stock only' });
    expect(wf.steps[3]).toMatchObject({ role: 'combobox', name: 'Sort by' });
    expect(wf.params).toEqual([
      { name: 'search_products', description: 'Text for searchbox "Search products"', example: 'green tea' },
      { name: 'password', description: 'Secret for textbox "Password"', secret: true, vaultField: 'password' },
    ]);
    expect(validateWorkflow(wf).ok).toBe(true);
    recorded = wf;
    await ctx.close();
  }, 60_000);

  it.skipIf(!chromiumPath)('never captures secret values, even after a show-password toggle or in a type=text PIN field', async () => {
    const ctx = await browser.newContext();
    const mgr = new RealManager(ctx);
    const page = await mgr.activePage();
    await page.goto(base + '/toggle');
    const rec = new WorkflowRecorder();
    await rec.start({ name: 'toggle', source: 'human', mgr });
    await page.type('#pass', 'Sup3rSecret!');
    await page.click('#show'); // now type=text — still secret
    await page.type('#pin', '4321');
    await page.click('#done');
    const wf = await rec.stop();
    const json = JSON.stringify(wf);
    expect(json).not.toContain('Sup3rSecret');
    expect(json).not.toContain('4321');
    expect(wf.params.map(p => [p.name, p.secret])).toEqual([['password', true], ['card_pin', true]]);
    await ctx.close();
  }, 60_000);

  it.skipIf(!chromiumPath)('a mixed recording does not duplicate agent actions the page capture also saw', async () => {
    const ctx = await browser.newContext();
    const mgr = new RealManager(ctx);
    const page = await mgr.activePage();
    await page.goto(base + '/');
    const rec = new WorkflowRecorder();
    await rec.start({ name: 'mixed', source: 'mixed', mgr });
    // Agent tools act through Playwright (real DOM events) and then publish a record.
    await page.fill('#q', 'oolong');
    mgr.recordAction({ tool: 'browser_type', args: { selector: '#q', text: 'oolong' }, url: page.url(), actor: 'agent', element: { selector: '#q', role: 'searchbox', name: 'Search products', tag: 'input', inputType: 'search' } });
    // The human ticks a box.
    await page.check('#instock');
    // The agent clicks.
    await page.click('#noop');
    mgr.recordAction({ tool: 'browser_click', args: { selector: '#noop' }, url: page.url(), actor: 'agent', element: { selector: '#noop', role: 'button', name: 'Remember me' } });
    const wf = await rec.stop();
    expect(wf.steps.map(s => `${s.actor ?? '-'}:${s.kind} ${s.selector ?? s.url}`)).toEqual([
      `agent:navigate ${base}/`,
      'agent:fill #q',
      'human:fill #instock',
      'agent:click #noop',
    ]);
    await ctx.close();
  }, 60_000);

  it.skipIf(!chromiumPath)('replays with new params, then self-heals on a redesigned page', async () => {
    expect(recorded).not.toBeNull();
    const wf: Workflow = { ...recorded!, steps: [...recorded!.steps, { kind: 'extract', selector: '#term' }, { kind: 'extract', selector: '#meta' }] };
    const ctx = await browser.newContext();
    const mgr = new RealManager(ctx);
    const actions: string[] = [];
    mgr.onAction(a => actions.push(a.tool));

    const r1 = await runWorkflow(wf, [{ name: 'search_products', value: 'black tea' }, { name: 'password', value: 'pw-123' }], { mgr, guard: null, secretFiller: null });
    expect(r1.error).toBeUndefined();
    expect(r1.ok).toBe(true);
    expect(r1.steps.every(s => s.strategy === undefined || s.strategy === 'selector')).toBe(true);
    expect(r1.finalUrl).toContain('/results?q=black+tea');
    expect(r1.extracted.map(x => x.text)).toEqual(['black tea', 'sort=price stock=on']);
    expect(actions).toContain('browser_type');

    // Site redesign: same task, new ids / names — targets heal via role / label.
    const moved: Workflow = { ...wf, startUrl: base + '/v2', steps: wf.steps.map((s, i) => (i === 0 ? { ...s, url: base + '/v2' } : s)) };
    const r2 = await runWorkflow(moved, [{ name: 'search_products', value: 'white tea' }, { name: 'password', value: 'pw-123' }], { mgr, guard: null, secretFiller: null, actionTimeoutMs: 1500 });
    expect(r2.error).toBeUndefined();
    expect(r2.ok).toBe(true);
    const strategies = r2.steps.map(s => s.strategy ?? '-');
    // The recorded `role=button[name="Search"s]` selector survives the redesign as-is.
    expect(strategies).toEqual(['-', 'role', 'role', 'role', 'role', 'role', 'selector', 'selector', 'selector']);
    expect(r2.extracted.map(x => x.text)).toEqual(['white tea', 'sort=price stock=on']);
    await ctx.close();
  }, 90_000);
});
