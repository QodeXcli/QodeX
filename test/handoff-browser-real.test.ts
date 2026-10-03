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
import {
  BrowserNavigateTool, BrowserClickTool, BrowserFillTool, BrowserScreenshotTool, BrowserGetTextTool, BrowserEvaluateTool, BrowserConsoleTool,
} from '../src/tools/browser/tools.js';
import {
  BrowserSnapshotTool, BrowserFillFormTool, BrowserDragTool, BrowserTypeTool, BrowserPressTool, BrowserHistoryTool, BrowserExtractTool,
} from '../src/tools/browser/tools-extra.js';
import { getBus } from '../src/control/bus.js';
import { BrowserRequestHumanTool, pendingHandoffs, resolveHandoff } from '../src/tools/browser/handoff.js';

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
<div id="slider" role="slider" aria-label="Slide to verify" aria-valuenow="0" tabindex="0" draggable="true" style="position:absolute;top:44px;left:130px;width:30px;height:20px;background:#99f">slide</div>
<div id="slot" role="button" aria-label="Drop slot" style="position:absolute;top:44px;left:200px;width:60px;height:20px;border:1px solid #000">slot</div>
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

/** A login page whose "show password" toggle turns the field into type=text, and which echoes / logs the value. */
const REVEAL = `<!doctype html><html><head><title>Account</title></head><body>
<label for="pw">Password</label><input id="pw" type="password">
<button id="show" onclick="document.getElementById('pw').type = 'text'">Show password</button>
<button id="echo" onclick="var v = document.getElementById('pw').value; document.getElementById('out').textContent = 'Your password is ' + v; console.log('pw=' + v)">Echo</button>
<div id="out"></div>
</body></html>`;

/** A PerimeterX-style "Press & Hold" page: only a ≥1 s hold (the human's own) passes it. */
const PRESS_HOLD = `<!doctype html><html><head><title>Access to this page has been denied</title></head><body>
<p>Press &amp; Hold to confirm you are a human (and not a bot).</p>
<div id="px-captcha" style="width:300px;height:100px;background:#ddd">Press &amp; Hold</div>
<script>
  var el = document.getElementById('px-captcha'); var t0 = 0; window.ups = 0;
  el.addEventListener('mousedown', function () { t0 = Date.now(); });
  document.addEventListener('mouseup', function () {
    window.ups++;
    if (t0 && Date.now() - t0 >= 1000) { el.remove(); document.title = 'Shop'; document.body.insertAdjacentHTML('beforeend', '<h1>Welcome back</h1>'); }
    t0 = 0;
  });
</script></body></html>`;

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
      if (url.pathname === '/recaptcha' || url.pathname === '/again') { res.end(recaptchaPage(vendor)); return; }
      if (url.pathname === '/badge') { res.end(badgePage(vendor)); return; }
      if (url.pathname === '/turnstile') { res.end(turnstilePage(vendor)); return; }
      if (url.pathname === '/interstitial') {
        res.statusCode = 403;
        res.setHeader('cf-mitigated', 'challenge');
        res.setHeader('server', 'cloudflare');
        res.end(INTERSTITIAL);
        return;
      }
      if (url.pathname === '/hold') { res.end(PRESS_HOLD); return; }
      if (url.pathname === '/reveal') { res.end(REVEAL); return; }
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

  it('the agent can never click / fill / type / drag into the challenge — [CHALLENGE_HUMAN_ONLY]; the rest of the page still works', async () => {
    await run(new BrowserNavigateTool(), { url: `${base}/recaptcha`, snapshot: false });
    const snap = (await run(new BrowserSnapshotTool(), {})).content;
    const refIn = (re: RegExp) => { const m = re.exec(snap); if (!m) throw new Error(`no match for ${re} in\n${snap}`); return m[1]!; };
    const box = refIn(/- checkbox "I'm not a robot"[^\n]*\[ref=(f\d+e\d+)\]/);
    const answer = refIn(/- textbox "Answer"[^\n]*\[ref=(f\d+e\d+)\]/);
    const slider = refIn(/- slider "Slide to verify"[^\n]*\[ref=(f\d+e\d+)\]/);
    const slot = refIn(/- button "Drop slot"[^\n]*\[ref=(f\d+e\d+)\]/);
    const user = refIn(/- textbox "Username"[^\n]*\[ref=(e\d+)\]/);
    const go = refIn(/- button "Continue"[^\n]*\[ref=(e\d+)\]/);

    const click = await run(new BrowserClickTool(), { ref: box });
    expect(click.isError).toBe(true);
    expect(click.content).toMatch(/^\[CHALLENGE_HUMAN_ONLY\]/);
    const asSelector = await run(new BrowserClickTool(), { selector: box });
    expect(asSelector.content).toMatch(/^\[CHALLENGE_HUMAN_ONLY\]/);
    const fill = await run(new BrowserFillTool(), { ref: answer, value: 'abc' });
    expect(fill.content).toMatch(/^\[CHALLENGE_HUMAN_ONLY\]/);
    const drag = await run(new BrowserDragTool(), { from_ref: slider, to_ref: go });
    expect(drag.content).toMatch(/^\[CHALLENGE_HUMAN_ONLY\]/);
    const dragInto = await run(new BrowserDragTool(), { from_ref: go, to_ref: slot });
    expect(dragInto.content).toMatch(/^\[CHALLENGE_HUMAN_ONLY\]/);
    const form = await run(new BrowserFillFormTool(), { fields: [{ ref: user, value: 'alice' }, { ref: answer, value: 'x' }], snapshot: false });
    expect(form.isError).toBe(true);
    expect(form.content).toContain('✓ textbox "Username"');
    expect(form.content).toMatch(/✗ \[CHALLENGE_HUMAN_ONLY\]/);

    // Focus inside the challenge frame: typing / keys without a target are refused too.
    const page = await mgr.activePage();
    const anchor = page.frames().find((f: any) => /\/recaptcha\/api2\/anchor/.test(f.url()));
    await anchor.focus('#rc-answer');
    const typed = await run(new BrowserTypeTool(), { text: 'zzz' });
    expect(typed.content).toMatch(/^\[CHALLENGE_HUMAN_ONLY\]/);
    const pressed = await run(new BrowserPressTool(), { key: 'Space' });
    expect(pressed.content).toMatch(/^\[CHALLENGE_HUMAN_ONLY\]/);

    // Nothing in the widget changed.
    expect(await anchor.evaluate("document.querySelector('#recaptcha-anchor').getAttribute('aria-checked')")).toBe('false');
    expect(await anchor.evaluate("document.querySelector('#rc-answer').value")).toBe('');
    // A vision model never sees it.
    const shot = await run(new BrowserScreenshotTool(), { analyze: 'what does the captcha say?', path: path.join(tmp, 'c.png') });
    expect(shot.content).toMatch(/^\[CHALLENGE_HUMAN_ONLY\] No screenshot analysis/);
    // The page outside the widget is still the agent's.
    const ok = await run(new BrowserFillTool(), { selector: '#user', value: 'bob', snapshot: false });
    expect(ok.isError).toBeFalsy();
    expect(await page.evaluate("document.querySelector('#user').value")).toBe('bob');
  }, 60_000);

  /** Wait until the hand-off has taken over and asked; returns its approval. */
  async function waitForHandoff(): Promise<any> {
    for (let i = 0; i < 100; i++) {
      const p = pendingHandoffs()[0];
      if (p && /^handoff:/.test(String(mgr.status().takeoverBy ?? ''))) return p;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('hand-off never started');
  }

  it('browser_request_human resumes by itself when the human passes it via the control-center input path', async () => {
    await run(new BrowserNavigateTool(), { url: `${base}/recaptcha`, snapshot: false });
    const pending = run(new BrowserRequestHumanTool(), { reason: 'solve the CAPTCHA to sign in', timeout_sec: 60 });
    const ap = await waitForHandoff();
    expect(ap.category).toBe('challenge');
    expect(ap.options).toEqual(['done', 'cancel']);
    expect(ap.meta.handoff).toMatchObject({ host: '127.0.0.1', vendor: 'recaptcha', state: 'needs-human', tabIndex: 0, linkTtlSec: 60 });
    expect(ap.meta.handoff.frameBox.w).toBeGreaterThan(200);
    expect(ap.prompt).toContain('reCAPTCHA on 127.0.0.1');
    // Agent tools wait while the human has the browser.
    expect(mgr.isTakeover()).toBe(true);

    // The scripted human clicks the widget through the control center's input path.
    const box = ap.meta.handoff.frameBox;
    await mgr.dispatchInput({ type: 'click', x: box.x + 20, y: box.y + 20 });

    const r = await pending;
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/^✓ The reCAPTCHA on 127\.0\.0\.1 is gone \(\d+s, noticed automatically\) — continuing\./);
    expect((r.metadata as any)).toMatchObject({ outcome: 'cleared', by: 'challenge-cleared' });
    expect(mgr.isTakeover()).toBe(false);
    expect(pendingHandoffs()).toEqual([]);
    const resolved = getBus().recent(300).find((e: any) => e.kind === 'approval.resolved' && e.id === ap.id);
    expect(resolved).toMatchObject({ answer: 'done', by: 'challenge-cleared' });
    // Nothing secret anywhere: no site key, no frame URL / query string.
    const all = JSON.stringify(getBus().recent(300)) + r.content + JSON.stringify(r.metadata) + ctx.events.join('\n');
    expect(all).not.toContain(SITEKEY);
    expect(all).not.toMatch(/recaptcha\/api2/);
  }, 60_000);

  it('"done" while the challenge is still up keeps waiting; a page script removing it ends the hand-off', async () => {
    await run(new BrowserNavigateTool(), { url: `${base}/recaptcha`, snapshot: false });
    const pending = run(new BrowserRequestHumanTool(), { reason: 'solve the CAPTCHA', timeout_sec: 60 });
    const ap = await waitForHandoff();
    expect(resolveHandoff(ap.meta.handoff.id, 'done', 'control')).toBe(true);
    for (let i = 0; i < 60 && !ctx.events.some(e => /still there/.test(e)); i++) await new Promise(r => setTimeout(r, 100));
    expect(ctx.events.some(e => /still there/.test(e))).toBe(true);
    const again = await waitForHandoff();
    expect(again.prompt).toContain('is still there');
    const page = await mgr.activePage();
    await page.evaluate("document.getElementById('rc').remove()");
    const r = await pending;
    expect(r.content).toMatch(/^✓ /);
    expect(mgr.isTakeover()).toBe(false);
  }, 60_000);

  it('times out with [CHALLENGE_UNSOLVED] and releases its takeover', async () => {
    await run(new BrowserNavigateTool(), { url: `${base}/recaptcha`, snapshot: false });
    const t0 = Date.now();
    const r = await run(new BrowserRequestHumanTool(), { reason: 'solve the CAPTCHA', timeout_sec: 5 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(4500);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/^\[CHALLENGE_UNSOLVED\] Nobody finished the reCAPTCHA on 127\.0\.0\.1 within [56]s\. Do not retry automatically; tell the user\./);
    expect(mgr.isTakeover()).toBe(false);
    expect(pendingHandoffs()).toEqual([]);
  }, 30_000);

  it("never steals or releases a human's own takeover", async () => {
    await run(new BrowserNavigateTool(), { url: `${base}/recaptcha`, snapshot: false });
    expect(mgr.setTakeover(true, 'control')).toBe(true);
    try {
      const pending = run(new BrowserRequestHumanTool(), { reason: 'solve the CAPTCHA', timeout_sec: 30 });
      for (let i = 0; i < 50 && !pendingHandoffs().length; i++) await new Promise(r => setTimeout(r, 100));
      expect(pendingHandoffs().length).toBe(1);
      expect(mgr.status().takeoverBy).toBe('control');
      const page = await mgr.activePage();
      await page.evaluate("document.getElementById('rc').remove()");
      const r = await pending;
      expect(r.content).toMatch(/^✓ /);
      expect(mgr.status()).toMatchObject({ takeover: true, takeoverBy: 'control' });
    } finally {
      mgr.setTakeover(false, 'control');
    }
  }, 60_000);

  it('aborting the run stops the hand-off with [ABORTED] and releases the takeover', async () => {
    await run(new BrowserNavigateTool(), { url: `${base}/recaptcha`, snapshot: false });
    const ac = new AbortController();
    const c = makeCtx(tmp, ac.signal);
    const pending = run(new BrowserRequestHumanTool(), { reason: 'solve the CAPTCHA', timeout_sec: 60 }, c);
    await waitForHandoff();
    ac.abort();
    const r = await pending;
    expect(r.content).toMatch(/^\[ABORTED\]/);
    expect(mgr.isTakeover()).toBe(false);
    expect(pendingHandoffs()).toEqual([]);
  }, 30_000);

  it('a "Press & Hold" check is passed by the human\'s own relayed hold (down … up); the hold is capped', async () => {
    const nav = await run(new BrowserNavigateTool(), { url: `${base}/hold`, snapshot: false });
    expect(nav.content).toContain('[CHALLENGE] PerimeterX "Press & Hold" on 127.0.0.1 needs a human.');
    const page = await mgr.activePage();
    // The cap forces an 'up' when the stream drops mid-hold (no stuck button).
    const cap = (QodexBrowserManager as any).HOLD_CAP_MS;
    (QodexBrowserManager as any).HOLD_CAP_MS = 300;
    try {
      await mgr.dispatchInput({ type: 'down', x: 50, y: 70 });
      await new Promise(r => setTimeout(r, 700));
      expect(await page.evaluate('window.ups')).toBe(1);
    } finally {
      (QodexBrowserManager as any).HOLD_CAP_MS = cap;
    }
    const pending = run(new BrowserRequestHumanTool(), { reason: 'press and hold the button', timeout_sec: 60 });
    const ap = await waitForHandoff();
    expect(ap.meta.handoff).toMatchObject({ vendor: 'perimeterx', state: 'needs-human' });
    const b = ap.meta.handoff.frameBox;
    await mgr.dispatchInput({ type: 'down', x: b.x + 40, y: b.y + 40 });
    await new Promise(r => setTimeout(r, 1200));
    await mgr.dispatchInput({ type: 'up', x: b.x + 40, y: b.y + 40 });
    const r = await pending;
    expect(r.content).toMatch(/^✓ The PerimeterX "Press & Hold" on 127\.0\.0\.1 is gone/);
    expect(r.content).toContain('Welcome back');
  }, 60_000);

  it('refuses (softly) to load a URL again whose last 2 loads were a challenge; a clean load resets it', async () => {
    const a = await run(new BrowserNavigateTool(), { url: `${base}/again?x=1`, snapshot: false });
    expect(a.content).toContain('[CHALLENGE]');
    const reload = await run(new BrowserHistoryTool(), { action: 'reload', snapshot: false });
    expect(reload.content).toContain('[CHALLENGE]');
    const third = await run(new BrowserNavigateTool(), { url: `${base}/again?x=2`, snapshot: false });
    expect(third.isError).toBe(true);
    expect(third.content).toMatch(/^\[CHALLENGE\] Not loading 127\.0\.0\.1:\d+\/again again: its last 2 loads ended on a bot check/);
    expect(third.content).not.toContain('x=2');
    const again = await run(new BrowserHistoryTool(), { action: 'reload', snapshot: false });
    expect(again.content).toMatch(/^\[CHALLENGE\] Not loading/);
    // The human passes it: the URL is fine again.
    const page = await mgr.activePage();
    await page.evaluate("document.getElementById('rc').remove()");
    expect(await mgr.detectChallengeNow()).toBeNull();
    expect(mgr.challengeLoadCount(`${base}/again`)).toBe(0);
    const ok = await run(new BrowserNavigateTool(), { url: `${base}/again`, snapshot: false });
    expect(ok.content).toMatch(/^✓ Loaded/);
  }, 60_000);

  it('maskExtra hides vault-filled values even after the site reveals them (snapshot, text, extract, evaluate, console)', async () => {
    const SECRET = 'Vault-Pa55word-XYZ';
    await run(new BrowserNavigateTool(), { url: `${base}/reveal`, snapshot: false });
    const page = await mgr.activePage();
    await page.fill('#pw', SECRET); // what browser_fill_secret does
    await page.click('#show');
    // Control: a revealed type=text field is no longer recognised as a secret by the page scan.
    expect((await run(new BrowserSnapshotTool(), {})).content).toContain(SECRET);

    mgr.maskExtra(page, [SECRET]);
    await page.click('#echo');
    const outputs = [
      (await run(new BrowserSnapshotTool(), {})).content,
      (await run(new BrowserGetTextTool(), {})).content,
      (await run(new BrowserExtractTool(), { format: 'text' })).content,
      (await run(new BrowserEvaluateTool(), { script: "return document.getElementById('pw').value" })).content,
      (await run(new BrowserConsoleTool(), {})).content,
      (await run(new BrowserClickTool(), { selector: '#echo' })).content,
    ];
    for (const o of outputs) expect(o).not.toContain(SECRET);
    expect(outputs[0]).toContain('[hidden]');
    expect(outputs[1]).toContain('Your password is [hidden]');
    // Never published: not in status, not on the bus.
    expect(JSON.stringify(mgr.status())).not.toContain(SECRET);
    expect(JSON.stringify(getBus().recent(300))).not.toContain(SECRET);
    // TTL: an expired value is forgotten.
    mgr.maskExtra(page, ['short-lived-value-1'], 1000);
    expect(mgr.extraSecretsFor(page)).toContain('short-lived-value-1');
    await new Promise(r => setTimeout(r, 1100));
    expect(mgr.extraSecretsFor(page)).not.toContain('short-lived-value-1');
    expect(mgr.extraSecretsFor(page)).toContain(SECRET);
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
