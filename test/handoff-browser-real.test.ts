/**
 * H1 — CAPTCHA hand-off against REAL Chromium with local pages only (no internet).
 * Fake vendor frames are served from a second local server (cross-origin, like the
 * real widgets); detection recognises them by their path signature.
 *
 * Nothing here solves anything: the "human" is scripted through the control-center
 * input path (dispatchInput) or a page script.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as http from 'http';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ToolContext, ToolResult } from '../src/tools/base.js';
import { resolveBrowserExecutable } from '../src/tools/browser/launcher.js';
import { QodexBrowserManager } from '../src/tools/browser/session.js';
import { setBrowserManagerForTests } from '../src/tools/browser/types.js';
import { detectChallenge } from '../src/tools/browser/challenge.js';
import { BrowserNavigateTool } from '../src/tools/browser/tools.js';
import { BrowserSnapshotTool } from '../src/tools/browser/tools-extra.js';
import { getBus } from '../src/control/bus.js';

let pw: any = null;
try { pw = await import('playwright'); } catch { pw = null; }
let pwExe = '';
try { pwExe = String(pw?.chromium?.executablePath?.() ?? ''); } catch { pwExe = ''; }
const exe = resolveBrowserExecutable({ playwrightExecutablePath: pwExe, headless: true });
const chromium = !!pw && !!(exe.executablePath || exe.channel);

const SITEKEY = 'SITEKEY_SECRET_12345';

function makeCtx(cwd: string, signal?: AbortSignal): ToolContext & { events: string[]; asked: string[] } {
  const events: string[] = [];
  const asked: string[] = [];
  return {
    cwd,
    sessionId: 'handoff-test',
    transaction: {} as any,
    permissions: { evaluate: () => 'allow' } as any,
    askUser: async (p: string) => { asked.push(p); return 'yes'; },
    signal: signal ?? new AbortController().signal,
    emit: (e: any) => { events.push(e.message ?? e.type); },
    events,
    asked,
  } as any;
}

/** A fake reCAPTCHA checkbox frame: the whole frame is the checkbox; clicking it "passes" (tells the parent). */
const ANCHOR_FRAME = `<!doctype html><html><head><title>reCAPTCHA</title></head><body style="margin:0">
<div id="recaptcha-anchor" role="checkbox" aria-checked="false" tabindex="0" aria-label="I'm not a robot"
  style="position:absolute;left:0;top:0;width:300px;height:40px;background:#eee"
  onclick="this.setAttribute('aria-checked','true'); parent.postMessage({ qx: 'solved' }, '*')">I'm not a robot</div>
<input id="rc-answer" aria-label="Answer" style="position:absolute;top:44px;left:0;width:120px">
<div id="slider" draggable="true" style="position:absolute;top:44px;left:130px;width:30px;height:20px;background:#99f">slide</div>
<div id="slot" style="position:absolute;top:44px;left:200px;width:60px;height:20px;border:1px solid #000">slot</div>
</body></html>`;

const TURNSTILE_FRAME = `<!doctype html><title>Turnstile</title><body><input type="checkbox" aria-label="Verify you are human"></body>`;

function recaptchaPage(vendor: string): string {
  return `<!doctype html><html><head><title>Sign in</title></head><body>
<h1>Sign in</h1>
<label for="user">Username</label><input id="user" name="user">
<div class="g-recaptcha" data-sitekey="${SITEKEY}" id="rc">
  <iframe title="reCAPTCHA" width="304" height="78" style="border:0" src="${vendor}/recaptcha/api2/anchor?ar=1&k=${SITEKEY}&co=x&hl=en&v=abc&size=normal&cb=1"></iframe>
  <textarea name="g-recaptcha-response" style="display:none"></textarea>
</div>
<div style="visibility:hidden;position:absolute;top:-10000px;left:0;right:0;opacity:0">
  <iframe title="recaptcha challenge expires in two minutes" width="400" height="580" src="${vendor}/recaptcha/api2/bframe?hl=en&v=abc&k=${SITEKEY}"></iframe>
</div>
<button id="go">Continue</button>
<script>
  window.addEventListener('message', function (e) {
    if (e.data && e.data.qx === 'solved') { var w = document.getElementById('rc'); if (w) w.remove(); }
  });
</script>
</body></html>`;
}

function badgePage(vendor: string): string {
  return `<!doctype html><html><head><title>Newsletter</title></head><body>
<h1>Subscribe</h1><input aria-label="Email"><button>Subscribe</button>
<div class="grecaptcha-badge" data-style="bottomright" style="width:256px;height:60px;position:fixed;visibility:visible;bottom:14px;right:-186px;box-shadow:gray 0 0 5px;overflow:hidden">
  <div class="grecaptcha-logo"><iframe title="reCAPTCHA" width="256" height="60" style="border:0" src="${vendor}/recaptcha/api2/anchor?ar=1&k=${SITEKEY}&co=x&hl=en&v=abc&size=invisible&cb=2"></iframe></div>
</div>
<textarea name="g-recaptcha-response" style="display:none"></textarea>
</body></html>`;
}

function turnstilePage(vendor: string): string {
  return `<!doctype html><html><head><title>Create account</title></head><body>
<h1>Create account</h1>
<form><div class="cf-turnstile" data-sitekey="${SITEKEY}">
  <iframe title="Widget containing a Cloudflare security challenge" width="300" height="65" style="border:0" src="${vendor}/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv0/0/abc/${SITEKEY}/light/normal"></iframe>
  <input type="hidden" name="cf-turnstile-response" value="">
</div></form></body></html>`;
}

/** A Cloudflare-style interstitial that swaps itself for the real page after 2 s (no human). */
const INTERSTITIAL = `<!doctype html><html><head><title>Just a moment...</title></head><body>
<div id="challenge-running"><h1>Checking your browser before accessing the site.</h1><p>This process is automatic.</p></div>
<script>setTimeout(function () { document.title = 'Shop home'; document.body.innerHTML = '<h1>Real content</h1><button>Buy</button>'; }, 2000);</script>
</body></html>`;

describe.skipIf(!chromium)('H1 hand-off (real Chromium)', () => {
  let server: http.Server;
  let vendorServer: http.Server;
  let base = '';
  let vendor = '';
  let tmp = '';
  let mgr: QodexBrowserManager;
  let ctx: ReturnType<typeof makeCtx>;

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-handoff-'));
    vendorServer = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      res.setHeader('content-type', 'text/html');
      if (url.pathname.startsWith('/recaptcha/api2/')) { res.end(ANCHOR_FRAME); return; }
      if (url.pathname.startsWith('/cdn-cgi/challenge-platform/')) { res.end(TURNSTILE_FRAME); return; }
      res.statusCode = 404; res.end('nope');
    });
    await new Promise<void>(r => vendorServer.listen(0, '127.0.0.1', () => r()));
    vendor = `http://localhost:${(vendorServer.address() as any).port}`;
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      res.setHeader('content-type', 'text/html');
      if (url.pathname === '/recaptcha') { res.end(recaptchaPage(vendor)); return; }
      if (url.pathname === '/badge') { res.end(badgePage(vendor)); return; }
      if (url.pathname === '/turnstile') { res.end(turnstilePage(vendor)); return; }
      if (url.pathname === '/interstitial') {
        res.statusCode = 403;
        res.setHeader('cf-mitigated', 'challenge');
        res.setHeader('server', 'cloudflare');
        res.end(INTERSTITIAL);
        return;
      }
      if (url.pathname === '/plain') { res.end('<title>Plain</title><h1>Hello</h1><a href="/recaptcha">login</a>'); return; }
      res.statusCode = 404; res.end('not found');
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
    mgr = new QodexBrowserManager({
      profilesDir: path.join(tmp, 'profiles'),
      downloadsDir: path.join(tmp, 'downloads'),
      config: { headless: true, snapshotAfterAction: true, challengeAutoWaitSec: 8 },
    });
    setBrowserManagerForTests(mgr);
    ctx = makeCtx(tmp);
  }, 60_000);

  afterAll(async () => {
    await mgr?.close();
    setBrowserManagerForTests(null);
    await new Promise<void>(r => server?.close(() => r()));
    await new Promise<void>(r => vendorServer?.close(() => r()));
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }, 60_000);

  beforeEach(() => { ctx = makeCtx(tmp); });

  const run = async (tool: { execute: (a: any, c: ToolContext) => Promise<ToolResult>; argsSchema: any }, args: Record<string, unknown>, c: ToolContext = ctx): Promise<ToolResult> =>
    tool.execute(tool.argsSchema.parse(args), c);

  const goto = async (p: string) => {
    const page = await mgr.activePage();
    await page.goto(`${base}${p}`, { waitUntil: 'load' });
    return page;
  };

  it('detects a visible reCAPTCHA checkbox frame (needs a human) — host only, no site key', async () => {
    const page = await goto('/recaptcha');
    const r = await detectChallenge(page);
    expect(r).toMatchObject({ vendor: 'recaptcha', state: 'needs-human', host: '127.0.0.1' });
    expect((r as any).frameUrl).toMatch(/\/recaptcha\/api2\/anchor$/);
    expect((r as any).frameBox.w).toBeGreaterThan(200);
    expect(JSON.stringify(r)).not.toContain(SITEKEY);
  }, 60_000);

  it('a page with only the reCAPTCHA v3 badge is NOT a challenge', async () => {
    const page = await goto('/badge');
    expect(await detectChallenge(page)).toBeNull();
  }, 30_000);

  it('detects a Turnstile frame (self-clearing until solved)', async () => {
    const page = await goto('/turnstile');
    expect(await detectChallenge(page)).toMatchObject({ vendor: 'turnstile', state: 'self-clearing' });
  }, 30_000);

  it('a plain page is not a challenge; the passive watcher publishes host/vendor/state only', async () => {
    const page = await goto('/plain');
    expect(await detectChallenge(page)).toBeNull();
    const seen: any[] = [];
    const off = getBus().subscribe((e: any) => { if (e.kind === 'browser' && /^challenge/.test(e.type)) seen.push(e); });
    try {
      await goto('/recaptcha');
      for (let i = 0; i < 40 && !seen.length; i++) await new Promise(r => setTimeout(r, 100));
      expect(seen[0]).toMatchObject({ type: 'challenge', data: { host: '127.0.0.1', vendor: 'recaptcha', state: 'needs-human' } });
      expect(JSON.stringify(seen)).not.toMatch(/SITEKEY|\/recaptcha\/|\?/);
      expect(mgr.challengeOf()).toMatchObject({ vendor: 'recaptcha' });
      expect(mgr.status().challenge).toMatchObject({ tab: 0, vendor: 'recaptcha', host: '127.0.0.1' });
      await goto('/plain');
      for (let i = 0; i < 40 && !seen.some(e => e.type === 'challenge-cleared'); i++) await new Promise(r => setTimeout(r, 100));
      expect(seen.some(e => e.type === 'challenge-cleared')).toBe(true);
    } finally { off(); }
  }, 30_000);

  it('the element describer marks parts of the challenge frame', async () => {
    await goto('/recaptcha');
    const snap = (await run(new BrowserSnapshotTool(), {})).content;
    const ref = /- checkbox "I'm not a robot"[^\n]*\[ref=(f\d+e\d+)\]/.exec(snap)?.[1];
    expect(ref, snap).toBeTruthy();
    expect(await mgr.describeRef(ref!)).toMatchObject({ challenge: true });
    expect((await mgr.describeSelector('#user'))?.challenge).toBeUndefined();
  }, 30_000);

  it('navigate to a CAPTCHA page reports [CHALLENGE] at once (no auto-wait for needs-human) and never the site key', async () => {
    const t0 = Date.now();
    const r = await run(new BrowserNavigateTool(), { url: `${base}/recaptcha` });
    expect(Date.now() - t0).toBeLessThan(6000);
    expect(r.content).toContain('[CHALLENGE] reCAPTCHA on 127.0.0.1 needs a human.');
    expect(r.content).toContain('browser_request_human');
    expect(r.content).not.toContain(SITEKEY);
    expect((r.metadata as any).challenge).toEqual({ vendor: 'recaptcha', state: 'needs-human', host: '127.0.0.1' });
    const s = await run(new BrowserSnapshotTool(), { interactive_only: true });
    expect(s.content).toContain('[CHALLENGE]');
  }, 60_000);

  it('navigate waits out a self-clearing interstitial without the human', async () => {
    const r = await run(new BrowserNavigateTool(), { url: `${base}/interstitial` });
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/cleared by itself after \d+s/);
    expect(r.content).not.toContain('[CHALLENGE]');
    expect(r.content).toContain('Real content');
    expect(ctx.asked).toEqual([]);
  }, 60_000);
});
