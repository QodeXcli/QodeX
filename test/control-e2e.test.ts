/**
 * End-to-end check of the Control Center against the REAL QodeX browser manager
 * (Module A): a headless agent Chromium serves a local page, the control center
 * streams its real CDP screencast, and a human takes over and drives it — first
 * through the HTTP API, then from the dashboard rendered in a second (viewer)
 * Chromium by clicking on the live frame. Skipped when Playwright or a Chromium
 * executable is unavailable. No network: pages come from a local http server.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startControlCenter, stopControlCenter, type ControlCenterInfo } from '../src/control/server.js';
import { getBus } from '../src/control/bus.js';
import { getApprovalBroker } from '../src/control/approvals.js';
import { resolveBrowserExecutable } from '../src/tools/browser/launcher.js';
import { QodexBrowserManager } from '../src/tools/browser/session.js';
import { setBrowserManagerForTests } from '../src/tools/browser/types.js';

let pw: any = null;
try { pw = await import('playwright'); } catch { pw = null; }
let pwExe = '';
try { pwExe = String(pw?.chromium?.executablePath?.() ?? ''); } catch { pwExe = ''; }
const exe = pw ? resolveBrowserExecutable({ playwrightExecutablePath: pwExe, headless: true }) : { executablePath: undefined, channel: undefined };
const chromium = !!pw && !!(exe.executablePath || exe.channel);

const TOKEN = 'e2e-control-token-0123456789';

const PAGE = `<!doctype html><html><head><title>Counter</title>
<style>body{margin:0;font:16px sans-serif} #inc{position:absolute;left:100px;top:100px;width:200px;height:80px} #box{position:absolute;left:100px;top:260px;width:300px;height:30px}</style></head>
<body>
<button id="inc" onclick="window.__n=(window.__n||0)+1;document.title='Counter '+window.__n">Increment</button>
<input id="box" aria-label="Box">
<script>document.getElementById('box').addEventListener('keydown', e => { if (e.key === 'Enter') document.title = 'Entered ' + e.target.value; });</script>
</body></html>`;

interface SseEvent { event: string; data: string }

async function openSse(url: string): Promise<{ events: SseEvent[]; close: () => void }> {
  const ac = new AbortController();
  const res = await fetch(url, { headers: { accept: 'text/event-stream', authorization: `Bearer ${TOKEN}` }, signal: ac.signal });
  const events: SseEvent[] = [];
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  void (async () => {
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let event = 'message';
          const data: string[] = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data.push(line.slice(6));
          }
          if (data.length) events.push({ event, data: data.join('\n') });
        }
      }
    } catch { /* aborted */ }
  })();
  return { events, close: () => ac.abort() };
}

async function waitUntil(fn: () => boolean | Promise<boolean>, ms = 15_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return !!(await fn());
}

describe.skipIf(!chromium)('control center with the real QodeX browser', () => {
  let server: http.Server;
  let site = '';
  let tmp = '';
  let mgr: QodexBrowserManager;
  let info: ControlCenterInfo;
  let base = '';
  let viewer: any;

  const post = (p: string, body: unknown) => fetch(base + p, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const title = async (): Promise<string> => String(await (await mgr.activePage()).title());

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-control-e2e-'));
    server = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(req.url?.startsWith('/two') ? '<title>Two</title><h1>Second</h1>' : PAGE);
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    site = `http://127.0.0.1:${(server.address() as any).port}`;
    getBus().reset();
    getApprovalBroker().reset();
    mgr = new QodexBrowserManager({
      profilesDir: path.join(tmp, 'profiles'),
      downloadsDir: path.join(tmp, 'downloads'),
      config: { headless: true, viewport: { width: 800, height: 600 } },
    });
    setBrowserManagerForTests(mgr);
    info = await startControlCenter({ port: 0, token: TOKEN, lang: 'en', onSteer: () => true });
    base = `http://127.0.0.1:${info.port}`;
  }, 60_000);

  afterAll(async () => {
    await stopControlCenter();
    await viewer?.close().catch(() => {});
    await mgr?.close().catch(() => {});
    setBrowserManagerForTests(null);
    getApprovalBroker().reset();
    getBus().reset();
    await new Promise<void>(r => server?.close(() => r()));
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }, 60_000);

  it('opens the browser only through a taken-over navigate, streams real frames and forwards input', async () => {
    const frames = await openSse(`${base}/api/frames`);
    try {
      expect(await waitUntil(() => frames.events.some(e => e.event === 'idle'))).toBe(true);
      expect(JSON.parse(frames.events.find(e => e.event === 'idle')!.data).reason).toBe('no-browser');

      // Without takeover nothing reaches (or launches) the browser.
      expect((await post('/api/input', { type: 'navigate', url: `${site}/` })).status).toBe(409);
      expect(mgr.isRunning()).toBe(false);

      expect((await post('/api/takeover', { on: true })).status).toBe(200);
      expect(mgr.isTakeover()).toBe(true);
      expect(mgr.status().takeoverBy).toBe('control');
      expect(mgr.isRunning()).toBe(false); // taking over alone launches nothing

      const nav = await post('/api/input', { type: 'navigate', url: `${site}/` });
      expect(nav.status).toBe(200);
      expect(mgr.isRunning()).toBe(true);
      expect(await title()).toBe('Counter');

      // The real CDP screencast reaches the viewer.
      expect(await waitUntil(() => frames.events.some(e => e.event === 'frame'))).toBe(true);
      const f = JSON.parse(frames.events.filter(e => e.event === 'frame').pop()!.data);
      expect(f.w).toBeGreaterThan(0);
      expect(f.h).toBeGreaterThan(0);
      expect(Buffer.from(f.data, 'base64').subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));

      // A click in FRAME coordinates lands on the button (rescaled to the viewport).
      const sx = f.w / 800, sy = f.h / 600;
      const click = await post('/api/input', { type: 'click', x: Math.round(200 * sx), y: Math.round(140 * sy), frameWidth: f.w, frameHeight: f.h });
      expect(click.status).toBe(200);
      expect(await waitUntil(async () => (await title()) === 'Counter 1')).toBe(true);

      // Typing + Enter into the input; the dashboard's key names work.
      await post('/api/input', { type: 'click', x: Math.round(250 * sx), y: Math.round(275 * sy), frameWidth: f.w, frameHeight: f.h });
      expect((await post('/api/input', { type: 'type', text: 'hello' })).status).toBe(200);
      expect((await post('/api/input', { type: 'key', key: 'Space' })).status).toBe(200);
      expect((await post('/api/input', { type: 'type', text: 'world' })).status).toBe(200);
      expect((await post('/api/input', { type: 'key', key: 'Enter' })).status).toBe(200);
      expect(await waitUntil(async () => (await title()) === 'Entered hello world')).toBe(true);
      expect((await post('/api/input', { type: 'key', key: 'ControlOrMeta+a' })).status).toBe(200);
      expect((await post('/api/input', { type: 'key', key: 'Backspace' })).status).toBe(200);
      const value = await (await mgr.activePage()).evaluate("document.getElementById('box').value");
      expect(value).toBe('');

      // Human actions are recorded on the bus (for the Activity panel / workflow recorder).
      const actions = getBus().recent(300).filter(e => e.kind === 'browser' && e.type === 'action');
      expect(actions.some(e => (e as any).data?.actor === 'human' && (e as any).data?.tool === 'browser_click')).toBe(true);

      // Single JPEG snapshot.
      const jpg = await fetch(`${base}/api/frame.jpg`, { headers: { authorization: `Bearer ${TOKEN}` } });
      expect(jpg.status).toBe(200);
      expect(jpg.headers.get('content-type')).toBe('image/jpeg');
      expect(Buffer.from(await jpg.arrayBuffer()).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));

      // The agent waits while the human holds control, and resumes on hand-back.
      let resumed = false;
      const waiting = mgr.waitForTakeoverEnd().then(() => { resumed = true; });
      await new Promise(r => setTimeout(r, 100));
      expect(resumed).toBe(false);
      expect((await post('/api/takeover', { on: false })).status).toBe(200);
      await waiting;
      expect(resumed).toBe(true);
      expect((await post('/api/input', { type: 'reload' })).status).toBe(409);
    } finally {
      frames.close();
    }
  }, 120_000);

  it('a human drives the agent browser from the dashboard by clicking on the live frame', async () => {
    if (!mgr.isRunning()) await mgr.ensure();
    const page0 = await mgr.activePage();
    await page0.goto(`${site}/`);
    expect(await title()).toBe('Counter');

    viewer = await pw.chromium.launch({ headless: true, executablePath: exe.executablePath, channel: exe.executablePath ? undefined : exe.channel, args: ['--no-proxy-server'] });
    const page = await viewer.newPage({ viewport: { width: 1200, height: 1000 } });
    const pageErrors: string[] = [];
    page.on('pageerror', (e: Error) => pageErrors.push(e.message));
    await page.goto(info.url);
    await page.waitForURL(`${base}/`);
    await page.locator('#frame:not(.hidden)').waitFor({ timeout: 20_000 });
    expect(await page.locator('#url').inputValue()).toBe(`${site}/`);

    await page.locator('#takeBtn').click();
    await page.locator('body.takeover').waitFor({ timeout: 10_000 });
    expect(mgr.isTakeover()).toBe(true);

    // Click where the agent page's button is drawn inside the <img>.
    const box = await page.locator('#frame').boundingBox();
    await page.mouse.click(box.x + (200 / 800) * box.width, box.y + (140 / 600) * box.height);
    expect(await waitUntil(async () => (await title()) === 'Counter 1')).toBe(true);

    // URL bar → navigate the agent's browser.
    await page.locator('#url').fill(`${site}/two`);
    await page.locator('#url').press('Enter');
    expect(await waitUntil(async () => (await title()) === 'Two')).toBe(true);

    await page.locator('#takeBtn').click();
    await page.locator('body:not(.takeover)').waitFor({ timeout: 10_000 });
    expect(mgr.isTakeover()).toBe(false);
    expect(pageErrors).toEqual([]);
    await page.close();
  }, 120_000);

  it('the agent\'s own browser cannot open the dashboard or answer its own approval, even with the link', async () => {
    if (!mgr.isRunning()) await mgr.ensure();
    const broker = getApprovalBroker();
    const pending = broker.request({ prompt: 'Pay $900 to shop.example?', options: ['yes', 'no'], category: 'payment', risk: 'critical' });
    const id = broker.pending()[0]!.id;

    // e.g. a prompt-injected page talked the agent into opening a leaked private link.
    const page = await mgr.activePage();
    const answers: number[] = [];
    // The agent tries to answer from that tab as soon as the page is there (same-origin, with the cookie).
    page.on('load', () => {
      void page.evaluate(`fetch('/api/approvals/${id}', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer: 'yes' }) }).then(r => r.status, () => -1)`)
        .then((s: number) => answers.push(s), () => answers.push(-2));
    });
    await page.goto(info.url).catch(() => {});
    // The control center kicks the agent's tab back to about:blank and says so.
    expect(await waitUntil(() => page.url() === 'about:blank', 10_000)).toBe(true);
    expect(getBus().recent(100).some(e => e.kind === 'notice' && /agent's browser opened the control center/.test(e.message))).toBe(true);
    await new Promise(r => setTimeout(r, 300));
    expect(answers.every(s => s !== 200)).toBe(true);
    expect(broker.get(id)).toBeDefined();
    expect(String(await page.evaluate('document.body ? document.body.innerText : ""'))).not.toContain('Pay $900');

    // The planted login cookie is taken back out of the agent's profile, so a later
    // plain navigation to the API is unauthenticated (no reading approvals either).
    const hasCookie = async () => ((await mgr.context().cookies()) as Array<{ name: string }>).some(c => c.name.startsWith('qx_ctl'));
    expect(await waitUntil(async () => !(await hasCookie()), 10_000)).toBe(true);
    const api = await page.goto(`${base}/api/state`);
    expect(api.status()).toBe(401);
    expect(String(await page.evaluate('document.body ? document.body.innerText : ""'))).not.toContain('Pay $900');
    expect(await post(`/api/approvals/${id}`, { answer: 'yes' }).then(r => r.status)).toBe(403); // agent tab is on the control center right now
    await page.goto('about:blank');

    // A login for ANOTHER control center (e.g. a mission worker's) is swept out too.
    await mgr.context().addCookies([{ name: 'qx_ctl_45678', value: 'some-other-token-0123456789', domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' }]);
    expect(await hasCookie()).toBe(true);
    await fetch(`${base}/?k=${TOKEN}`, { redirect: 'manual' }); // any login here schedules a sweep
    expect(await waitUntil(async () => !(await hasCookie()), 10_000)).toBe(true);

    // The human, in their own browser, answers it.
    const r = await post(`/api/approvals/${id}`, { answer: 'no' });
    expect(r.status).toBe(200);
    expect(await pending).toEqual({ answer: 'no', by: 'control' });
    await page.goto(`${site}/`);
  }, 60_000);

  it('follows the browser closing and relaunching', async () => {
    if (!mgr.isRunning()) await mgr.ensure();
    const frames = await openSse(`${base}/api/frames`);
    try {
      expect(await waitUntil(() => frames.events.some(e => e.event === 'frame'))).toBe(true);
      await mgr.close();
      expect(await waitUntil(() => frames.events.some(e => e.event === 'idle' && /closed|no-browser/.test(JSON.parse(e.data).reason)))).toBe(true);
      const before = frames.events.filter(e => e.event === 'frame').length;
      await mgr.ensure();
      await (await mgr.activePage()).goto(`${site}/`);
      expect(await waitUntil(() => frames.events.filter(e => e.event === 'frame').length > before)).toBe(true);
    } finally {
      frames.close();
    }
  }, 120_000);
});
