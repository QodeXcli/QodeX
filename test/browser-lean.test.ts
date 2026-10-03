/**
 * Lean browser mode (browser.lean): images / fonts / media are skipped while nobody needs
 * the pixels, the HTTP cache keeps working, and it switches itself off for good on a
 * screenshot, a takeover or the live view. Real Chromium against a local server; the
 * server stands in for a public site through the leanExempt hook (loopback pages are
 * exempt by default — that rule has its own pure test).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ToolContext } from '../src/tools/base.js';
import { resolveBrowserConfig } from '../src/config/agent-config.js';
import { resolveBrowserExecutable } from '../src/tools/browser/launcher.js';
import { QodexBrowserManager, leanExemptPage } from '../src/tools/browser/session.js';
import { leanEnabled, LEAN_FAILURE_TEXT } from '../src/tools/browser/lean.js';
import { setBrowserManagerForTests } from '../src/tools/browser/types.js';
import { BrowserNavigateTool, BrowserScreenshotTool, BrowserGetTextTool } from '../src/tools/browser/tools.js';
import { BrowserStatusTool, BrowserPdfTool } from '../src/tools/browser/tools-extra.js';

describe('browser.lean config', () => {
  it('resolves true / false / auto / garbage and the env override', () => {
    expect(resolveBrowserConfig({}).lean).toBe('auto');
    expect(resolveBrowserConfig({ browser: { lean: true } }, {}).lean).toBe('on');
    expect(resolveBrowserConfig({ browser: { lean: false } }, {}).lean).toBe('off');
    expect(resolveBrowserConfig({ browser: { lean: 'on' } }, {}).lean).toBe('on');
    expect(resolveBrowserConfig({ browser: { lean: 'sometimes' } }, {}).lean).toBe('auto');
    expect(resolveBrowserConfig({ browser: { lean: true } }, { QODEX_BROWSER_LEAN: '0' }).lean).toBe('off');
    expect(resolveBrowserConfig({ browser: { lean: false } }, { QODEX_BROWSER_LEAN: '1' }).lean).toBe('on');
  });

  it('auto = only a headless browser QodeX launched; never your own Chrome', () => {
    expect(leanEnabled({ lean: 'auto', headless: true }, 'launch')).toBe(true);
    expect(leanEnabled({ lean: 'auto', headless: false }, 'launch')).toBe(false);
    expect(leanEnabled({ lean: 'on', headless: false }, 'launch')).toBe(true);
    expect(leanEnabled({ lean: 'off', headless: true }, 'launch')).toBe(false);
    expect(leanEnabled({ lean: 'on', headless: true }, 'cdp')).toBe(false);
  });

  it('never touches dev servers, LAN hosts or non-web pages', () => {
    for (const u of ['http://localhost:3000/', 'http://127.0.0.1:5173/x', 'http://192.168.1.4/', 'http://[::1]:8080/', 'http://app.localhost/', 'file:///tmp/a.html', 'about:blank', 'data:text/html,hi', 'not a url']) {
      expect(leanExemptPage(u), u).toBe(true);
    }
    for (const u of ['https://example.com/signup', 'http://news.example.org/a?b=1']) {
      expect(leanExemptPage(u), u).toBe(false);
    }
  });
});

let pw: any = null;
try { pw = await import('playwright'); } catch { pw = null; }
let pwExe = '';
try { pwExe = String(pw?.chromium?.executablePath?.() ?? ''); } catch { pwExe = ''; }
const exe = resolveBrowserExecutable({ playwrightExecutablePath: pwExe, headless: true });
const chromium = !!pw && !!(exe.executablePath || exe.channel);

function makeCtx(cwd: string): ToolContext {
  return {
    cwd,
    sessionId: 'lean-test',
    transaction: {} as any,
    permissions: { evaluate: () => 'allow' } as any,
    askUser: async () => 'yes',
    signal: new AbortController().signal,
    emit: () => {},
  } as any;
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

describe.skipIf(!chromium)('lean mode (real Chromium)', () => {
  let tmp = '';
  let server: http.Server;
  let base = '';
  let mgr: QodexBrowserManager;
  let ctx: ToolContext;
  let exemptAll = false;
  const hits: Record<string, number> = {};
  const hit = (p: string) => hits[p] ?? 0;
  const reset = () => { for (const k of Object.keys(hits)) delete hits[k]; };

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-lean-'));
    server = http.createServer((req, res) => {
      const p = new URL(req.url ?? '/', 'http://x').pathname;
      hits[p] = (hits[p] ?? 0) + 1;
      if (p === '/app.js') { res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'max-age=3600' }); res.end('window.appLoaded = true;'); return; }
      if (p.startsWith('/img')) { res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG); return; }
      if (p === '/f.woff2') { res.writeHead(200, { 'content-type': 'font/woff2' }); res.end(Buffer.alloc(64)); return; }
      if (p === '/clip.mp4') { res.writeHead(200, { 'content-type': 'video/mp4' }); res.end(Buffer.alloc(64)); return; }
      if (p === '/favicon.ico') { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><html><head><title>Shop ${p}</title>
<style>@font-face{font-family:qx;src:url(/f.woff2)} body{font-family:qx,sans-serif}</style>
<script src="/app.js"></script></head><body>
<h1>Products</h1><img src="/img1.png" alt="one"><img src="/img2.png" alt="two"><video src="/clip.mp4" preload="auto"></video>
<form><label for="e">Email</label><input id="e" name="email"></form><a href="/p2">next</a></body></html>`);
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
    mgr = new QodexBrowserManager({
      profilesDir: path.join(tmp, 'profiles'),
      downloadsDir: path.join(tmp, 'downloads'),
      config: { headless: true, lean: 'auto', snapshotAfterAction: false, hostPacingMs: 0, challengeAutoWaitSec: 0 },
      // The local server plays a public site; flip exemptAll to play a dev server.
      leanExempt: () => exemptAll,
    });
    setBrowserManagerForTests(mgr);
    ctx = makeCtx(tmp);
  }, 60_000);

  afterAll(async () => {
    await mgr?.close();
    setBrowserManagerForTests(null);
    await new Promise<void>(r => server?.close(() => r()));
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  it('skips images, fonts and media, keeps scripts, the DOM and the HTTP cache', async () => {
    reset();
    for (const p of ['/', '/p2', '/']) {
      const r = await new BrowserNavigateTool().execute({ url: base + p } as any, ctx);
      expect(r.isError, String(r.content)).toBeFalsy();
    }
    expect(hit('/img1.png') + hit('/img2.png') + hit('/f.woff2') + hit('/clip.mp4')).toBe(0);
    expect(hit('/app.js')).toBe(1); // cached across the three loads: interception did not turn the cache off
    const page = await mgr.activePage();
    expect(await page.evaluate(() => (window as any).appLoaded)).toBe(true);
    const text = await new BrowserGetTextTool().execute({} as any, ctx);
    expect(String(text.content)).toContain('Products');
    const st = mgr.status();
    expect(st.lean?.on).toBe(true);
    expect(st.lean?.blocked).toBeGreaterThanOrEqual(6);
    expect(String((await new BrowserStatusTool().execute({} as any, ctx)).content)).toMatch(/Lean mode: on/);
  }, 60_000);

  it('a dev server / exempt page loads everything while lean mode is on', async () => {
    exemptAll = true;
    try {
      reset();
      await new BrowserNavigateTool().execute({ url: `${base}/dev` } as any, ctx);
      const page = await mgr.activePage();
      await page.waitForFunction(() => Array.from(document.images).every(i => i.complete), null, { timeout: 10_000 });
      expect(hit('/img1.png')).toBe(1);
      expect(mgr.status().lean?.on).toBe(true);
    } finally {
      exemptAll = false;
    }
  }, 60_000);

  it('a screenshot turns it off for the session and says what to reload', async () => {
    await new BrowserNavigateTool().execute({ url: `${base}/shot` } as any, ctx);
    const shot = await new BrowserScreenshotTool().execute({} as any, ctx);
    expect(shot.isError, String(shot.content)).toBeFalsy();
    expect(String(shot.content)).toMatch(/Lean mode skipped \d+ image\/font\/media request\(s\)/);
    const st = mgr.status();
    expect(st.lean).toMatchObject({ on: false, suspended: 'screenshot' });
    expect(String((await new BrowserStatusTool().execute({} as any, ctx)).content)).toMatch(/Lean mode: off since a screenshot/);
    reset();
    await new BrowserNavigateTool().execute({ url: `${base}/shot` } as any, ctx);
    const page = await mgr.activePage();
    await page.waitForFunction(() => Array.from(document.images).every(i => i.complete && i.naturalWidth > 0), null, { timeout: 10_000 });
    expect(hit('/img1.png')).toBe(1);
    const again = await new BrowserScreenshotTool().execute({} as any, ctx);
    expect(String(again.content)).not.toMatch(/Lean mode skipped/);
  }, 60_000);

  it('the request log names lean mode, the console stays clean', async () => {
    await mgr.restart();
    expect(mgr.status().lean?.on).toBe(true);
    await new BrowserNavigateTool().execute({ url: `${base}/log` } as any, ctx);
    const page = await mgr.activePage();
    await page.waitForTimeout(300);
    const st = (mgr as any).activeTab;
    const failed = st.requests.filter((r: any) => r.ok === false).map((r: any) => r.failure);
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((f: string) => f === LEAN_FAILURE_TEXT)).toBe(true);
    // …and the console carries no "Failed to load resource" line per skipped image.
    expect(st.console.some((c: any) => /BLOCKED_BY_CLIENT/.test(c.text))).toBe(false);
  }, 60_000);

  it('a takeover turns it off (the person sees the whole page)', async () => {
    expect(mgr.status().lean?.on).toBe(true);
    expect(mgr.setTakeover(true, 'human')).toBe(true);
    await (mgr as any).lean.settled();
    await new Promise(r => setTimeout(r, 50));
    expect(mgr.status().lean).toMatchObject({ on: false, suspended: 'takeover' });
    mgr.setTakeover(false, 'human');
    reset();
    await new BrowserNavigateTool().execute({ url: `${base}/after` } as any, ctx);
    const page = await mgr.activePage();
    await page.waitForFunction(() => Array.from(document.images).every(i => i.complete && i.naturalWidth > 0), null, { timeout: 10_000 });
    expect(hit('/img2.png')).toBe(1);
  }, 60_000);

  it('a PDF export turns it off and says what to reload', async () => {
    await mgr.restart();
    await new BrowserNavigateTool().execute({ url: `${base}/pdf` } as any, ctx);
    const r = await new BrowserPdfTool().execute({ path: path.join(tmp, 'page.pdf') } as any, ctx);
    expect(r.isError, String(r.content)).toBeFalsy();
    expect(String(r.content)).toMatch(/Lean mode skipped \d+ image\/font\/media request\(s\)/);
    expect(mgr.status().lean).toMatchObject({ on: false, suspended: 'pdf' });
  }, 60_000);

  it('the live view turns it off', async () => {
    await mgr.restart();
    expect(mgr.status().lean?.on).toBe(true);
    const stop = await mgr.startScreencast(() => {}, { maxFps: 2 });
    try {
      expect(mgr.status().lean).toMatchObject({ on: false, suspended: 'live view' });
    } finally {
      await stop();
    }
  }, 60_000);
});
