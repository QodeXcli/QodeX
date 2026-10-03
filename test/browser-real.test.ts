/**
 * Real-Chromium tests for the dedicated QodeX Browser. Skipped when playwright
 * or a Chromium executable cannot be found (executable discovery must find e.g.
 * /opt/pw-browsers/chromium even when Playwright's pinned revision is missing).
 * Pages come from a local http server (no internet needed).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import { promises as fs } from 'fs';
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import type { ToolContext, ToolResult } from '../src/tools/base.js';
import { resolveBrowserExecutable } from '../src/tools/browser/launcher.js';
import { QodexBrowserManager, getSession, closeBrowser } from '../src/tools/browser/session.js';
import { setBrowserManagerForTests } from '../src/tools/browser/types.js';
import type { BrowserActionRecord, ScreencastFrame } from '../src/tools/browser/types.js';
import {
  BrowserNavigateTool, BrowserClickTool, BrowserFillTool, BrowserScreenshotTool, BrowserEvaluateTool,
  BrowserGetTextTool, BrowserWaitForTool, BrowserConsoleTool,
} from '../src/tools/browser/tools.js';
import {
  BrowserSnapshotTool, BrowserTypeTool, BrowserFillFormTool, BrowserSelectTool, BrowserTabsTool,
  BrowserExtractTool, BrowserDownloadsTool, BrowserPressTool, BrowserScrollTool, BrowserHistoryTool,
  BrowserNetworkTool, BrowserStatusTool, BrowserUploadTool, BrowserHoverTool,
} from '../src/tools/browser/tools-extra.js';
import { getBus } from '../src/control/bus.js';
import { setActiveConfig } from '../src/config/loader.js';
import { takeSnapshotDetailed, snapshotWithBoxes } from '../src/tools/browser/snapshot.js';
import { BrowserDialogTool, BrowserPdfTool, BrowserDragTool } from '../src/tools/browser/tools-extra.js';

let pw: any = null;
try { pw = await import('playwright'); } catch { pw = null; }
let pwExe = '';
try { pwExe = String(pw?.chromium?.executablePath?.() ?? ''); } catch { pwExe = ''; }
const exe = resolveBrowserExecutable({ playwrightExecutablePath: pwExe, headless: true });
const chromium = !!pw && !!(exe.executablePath || exe.channel);

function makeCtx(cwd: string): ToolContext & { events: string[] } {
  const events: string[] = [];
  return {
    cwd,
    sessionId: 'browser-test',
    transaction: {} as any,
    permissions: { evaluate: () => 'allow' } as any,
    askUser: async () => 'yes',
    signal: new AbortController().signal,
    emit: (e: any) => { events.push(e.message ?? e.type); },
    events,
  } as any;
}

/** Ref of the first line `- <role> "<name>"... [ref=X]` in a snapshot. */
function refOf(text: string, role: string, name: string): string {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`- ${role} "${esc}"[^\\n]*?\\[ref=([a-z0-9]+)\\]`).exec(text);
  if (!m) throw new Error(`no ${role} "${name}" in snapshot:\n${text}`);
  return m[1];
}

const PAGE = `<!doctype html><html lang="en"><head><title>QX Test Shop</title>
<meta name="description" content="A page for QodeX browser tests"><meta property="og:title" content="QX OG"></head>
<body>
<h1>Test Shop</h1>
<p>Welcome to the <a href="/page2">second page</a> of tests.</p>
<form id="login" action="/submitted" method="get">
  <label for="email">Email</label><input id="email" name="email" type="email">
  <label for="pw">Password</label><input id="pw" name="pw" type="password" autocomplete="current-password">
  <label for="country">Country</label><select id="country" name="country"><option value="ir">Iran</option><option value="fr">France</option></select>
  <input type="checkbox" id="remember" name="remember"><label for="remember">Remember me</label>
  <button type="submit">Sign in</button>
</form>
<form id="search" action="/submitted" method="get"><input name="q" aria-label="Search"></form>
<button id="pop" onclick="window.open('/popup','_blank')">Open popup</button>
<a href="/file.txt">Download file</a>
<button id="al" onclick="alert('Saved!')">Show alert</button>
<input type="file" id="up" aria-label="Attachment" onchange="document.title = 'uploaded ' + this.files[0].name">
<div id="hov" onmouseover="this.textContent='hovered!'">hover me</div>
<div id="drag" draggable="true" ondragstart="event.dataTransfer.setData('text/plain','x')">Drag me</div>
<div id="drop" style="width:200px;height:60px;border:1px solid #000" ondragover="event.preventDefault()" ondrop="event.preventDefault(); this.textContent='dropped!'">Drop here</div>
<table><tr><th>Item</th><th>Price</th></tr><tr><td>Book</td><td>10</td></tr></table>
<div style="height:3000px">tall</div>
<p id="bottom">Bottom of page</p>
<script>console.log('page ready'); fetch('/missing-api').catch(() => {});</script>
</body></html>`;

describe.skipIf(!chromium)('QodeX browser (real Chromium)', () => {
  let server: http.Server;
  let base = '';
  let tmp = '';
  let mgr: QodexBrowserManager;
  let ctx: ReturnType<typeof makeCtx>;
  const actions: BrowserActionRecord[] = [];

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-browser-'));
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname === '/') { res.setHeader('content-type', 'text/html'); res.end(PAGE); return; }
      if (url.pathname === '/page2') { res.setHeader('content-type', 'text/html'); res.end('<title>Second</title><h2>Second page</h2>'); return; }
      if (url.pathname === '/popup') { res.setHeader('content-type', 'text/html'); res.end('<title>Popup Window</title><h1>I am the popup</h1>'); return; }
      if (url.pathname === '/submitted') {
        res.setHeader('content-type', 'text/html');
        res.end(`<title>Submitted</title><h1>Got ${url.searchParams.get('q') ?? url.searchParams.get('email') ?? ''}</h1>`);
        return;
      }
      if (url.pathname === '/file.txt') {
        res.setHeader('content-type', 'text/plain');
        res.setHeader('content-disposition', 'attachment; filename="report.txt"');
        res.end('hello download');
        return;
      }
      if (url.pathname === '/store') {
        res.setHeader('content-type', 'text/html');
        res.end('<title>Store</title><p id="v"></p><script>document.getElementById("v").textContent = localStorage.getItem("qx") || "none";</script>');
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
    mgr = new QodexBrowserManager({
      profilesDir: path.join(tmp, 'profiles'),
      downloadsDir: path.join(tmp, 'downloads'),
      config: { headless: true, snapshotAfterAction: true },
    });
    setBrowserManagerForTests(mgr);
    mgr.onAction(r => actions.push(r));
    ctx = makeCtx(tmp);
  }, 60_000);

  afterAll(async () => {
    await mgr?.close();
    setBrowserManagerForTests(null);
    await new Promise<void>(r => server?.close(() => r()));
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }, 60_000);

  const run = async (tool: { execute: (a: any, c: ToolContext) => Promise<ToolResult>; argsSchema: any }, args: Record<string, unknown>): Promise<ToolResult> =>
    tool.execute(tool.argsSchema.parse(args), ctx);

  it('navigates and returns a compact snapshot with refs', async () => {
    const r = await run(new BrowserNavigateTool(), { url: `${base}/` });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain(`✓ Loaded ${base}/`);
    expect(r.content).toContain('Title: QX Test Shop');
    expect(r.content).toMatch(/- textbox "Email" \[ref=e\d+\]/);
    expect(mgr.status()).toMatchObject({ running: true, mode: 'launch', headless: true, profile: 'default' });
  }, 60_000);

  it('browser_snapshot lists refs; describeRef of the password field says isPassword', async () => {
    const r = await run(new BrowserSnapshotTool(), {});
    expect(r.content).toMatch(/^Page: QX Test Shop\nURL: http:\/\/127\.0\.0\.1:\d+\/\nTabs: 1 \(active 0\)/);
    const pwRef = refOf(r.content, 'textbox', 'Password');
    const info = await mgr.describeRef(pwRef);
    expect(info).toMatchObject({ ref: pwRef, isPassword: true, tag: 'input', inputType: 'password', selector: '#pw', autocomplete: 'current-password' });
    expect(info?.formAction).toMatch(/\/submitted$/);
    const sel = await mgr.describeSelector('#email');
    expect(sel).toMatchObject({ role: 'textbox', name: 'Email', isPassword: false, selector: '#email' });
  }, 30_000);

  it('fills fields, selects, checks — and redacts the password in the action feed', async () => {
    const snap = (await run(new BrowserSnapshotTool(), { interactive_only: true })).content;
    const email = refOf(snap, 'textbox', 'Email');
    const pass = refOf(snap, 'textbox', 'Password');
    const country = refOf(snap, 'combobox', 'Country');
    const remember = refOf(snap, 'checkbox', 'Remember me');
    actions.length = 0;

    const t = await run(new BrowserTypeTool(), { ref: email, text: 'me@example.com', snapshot: false });
    expect(t.isError).toBeFalsy();
    expect(t.content).toContain(`✓ Typed 14 char(s) into textbox "Email" [ref=${email}]`);
    expect(t.content).not.toContain('Page after action');

    const f = await run(new BrowserFillTool(), { ref: pass, value: 's3cret!', snapshot: false });
    expect(f.content).toContain('(hidden)');
    expect(f.content).not.toContain('s3cret');

    const s = await run(new BrowserSelectTool(), { ref: country, values: ['France'], snapshot: false });
    expect(s.isError).toBeFalsy();
    expect(s.content).toContain('✓ Selected fr');

    const ff = await run(new BrowserFillFormTool(), { fields: [{ ref: remember, value: 'true' }, { selector: '#email', value: 'again@example.com' }], snapshot: false });
    expect(ff.isError).toBeFalsy();
    expect(ff.content).toContain('✓ Filled 2/2 field(s)');
    expect(ff.content).toMatch(/checkbox "Remember me" \[ref=e\d+\] → checked/);

    const ev = await run(new BrowserEvaluateTool(), { script: "return [document.querySelector('#email').value, document.querySelector('#country').value, document.querySelector('#remember').checked]" });
    expect(ev.content).toContain('"again@example.com"');
    expect(ev.content).toContain('"fr"');
    expect(ev.content).toContain('true');

    const pwRecord = actions.find(a => a.tool === 'browser_fill' && a.element?.isPassword);
    expect(pwRecord?.args.value).toBe('***');
    expect(actions.find(a => a.tool === 'browser_type')?.args.text).toBe('me@example.com');
    expect(actions.find(a => a.tool === 'browser_select')?.element?.selector).toBe('#country');
    expect(JSON.stringify(getBus().recent(50))).not.toContain('s3cret');
  }, 60_000);

  it('browser_evaluate returns values (fixed: the Function object is passed, not its source)', async () => {
    const a = await run(new BrowserEvaluateTool(), { script: 'return 1 + arg', arg: '2' });
    expect(a.content).toBe('Result:\n3');
    const b = await run(new BrowserEvaluateTool(), { script: 'document.title' });
    expect(b.content).toBe('Result:\nQX Test Shop');
    const c = await run(new BrowserEvaluateTool(), { script: '() => location.pathname' });
    expect(c.content).toBe('Result:\n/');
    const d = await run(new BrowserEvaluateTool(), { script: 'const r = await Promise.resolve(arg.n * 2); return r;', arg: '{"n": 21}' });
    expect(d.content).toBe('Result:\n42');
    // No stealth by default: the browser does not hide that it is automated.
    const st = await run(new BrowserEvaluateTool(), { script: 'return [navigator.webdriver === true, navigator.languages.length > 0]' });
    expect(JSON.parse(st.content.replace(/^Result:\n/, ''))).toEqual([true, true]);
  }, 30_000);

  it('a popup from the active tab becomes the active tab and is reported; tabs list/switch work', async () => {
    const snap = (await run(new BrowserSnapshotTool(), { interactive_only: true })).content;
    const r = await run(new BrowserClickTool(), { ref: refOf(snap, 'button', 'Open popup') });
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/New tab opened: .*\/popup/);
    expect(r.content).toContain('Page: Popup Window');
    expect(mgr.tabs().length).toBe(2);
    expect(mgr.tabs()[1].active).toBe(true);

    const list = await run(new BrowserTabsTool(), { action: 'list' });
    expect(list.content).toMatch(/\* \[1\] Popup Window — .*\/popup/);
    const sw = await run(new BrowserTabsTool(), { action: 'switch', index: 0, snapshot: false });
    expect(sw.content).toContain('✓ Switched to tab [0] QX Test Shop');
    expect(mgr.tabs()[0].active).toBe(true);
    const close = await run(new BrowserTabsTool(), { action: 'close', index: 1, snapshot: false });
    expect(close.isError).toBeFalsy();
    expect(mgr.tabs().length).toBe(1);
  }, 60_000);

  it('type + submit navigates and reports the new URL', async () => {
    const snap = (await run(new BrowserSnapshotTool(), { interactive_only: true })).content;
    const r = await run(new BrowserTypeTool(), { ref: refOf(snap, 'textbox', 'Search'), text: 'kettle', submit: true });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('and pressed Enter');
    expect(r.content).toMatch(/→ Now at: .*\/submitted\?q=kettle — "Submitted"/);
    const back = await run(new BrowserHistoryTool(), { action: 'back', snapshot: false });
    expect(back.content).toMatch(/→ Now at: http:\/\/127\.0\.0\.1:\d+\/ — "QX Test Shop"/);
  }, 60_000);

  it('extracts markdown, tables, links and metadata', async () => {
    const md = await run(new BrowserExtractTool(), { format: 'markdown' });
    expect(md.content).toContain('# Test Shop');
    expect(md.content).toMatch(/\[second page\]\(http:\/\/127\.0\.0\.1:\d+\/page2\)/);
    expect(md.content).toContain('| Item | Price |');
    const links = await run(new BrowserExtractTool(), { format: 'links' });
    expect(links.content).toMatch(/1\. \[second page\]\(http/);
    const meta = await run(new BrowserExtractTool(), { format: 'metadata' });
    expect(meta.content).toContain('description: A page for QodeX browser tests');
    expect(meta.content).toContain('og:title: QX OG');
    expect(meta.content).toContain('h1: Test Shop');
    const tables = await run(new BrowserExtractTool(), { format: 'tables', selector: 'table' });
    expect(tables.content).toContain('| Book | 10 |');
    const text = await run(new BrowserGetTextTool(), { selector: 'h1' });
    expect(text.content).toBe('Test Shop');
  }, 30_000);

  it('screenshot with set-of-marks writes a file and a ref legend', async () => {
    const dest = path.join(tmp, 'shots', 'marks.png');
    const r = await run(new BrowserScreenshotTool(), { marks: true, path: dest });
    expect(r.isError).toBeFalsy();
    expect(fsSync.existsSync(dest)).toBe(true);
    expect(fsSync.statSync(dest).size).toBeGreaterThan(1000);
    expect(r.content).toMatch(/Marks \(ref → element\):\n {2}e\d+ {2}\w+/);
    // overlay removed afterwards
    const left = await run(new BrowserEvaluateTool(), { script: "return !!document.getElementById('__qx_marks__')" });
    expect(left.content).toBe('Result:\nfalse');
  }, 30_000);

  it('screencast delivers at least one JPEG frame', async () => {
    const frames: ScreencastFrame[] = [];
    const stop = await mgr.startScreencast(f => frames.push(f), { quality: 50, maxFps: 5 });
    const page = await mgr.activePage();
    for (let i = 0; i < 20 && frames.length === 0; i++) {
      await page.evaluate(`document.body.style.background = '${i % 2 ? '#fff' : '#eee'}'`);
      await new Promise(r => setTimeout(r, 150));
    }
    await stop();
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0].width).toBeGreaterThan(100);
    expect(frames[0].height).toBeGreaterThan(100);
    expect(Buffer.from(frames[0].data, 'base64').subarray(0, 2).toString('hex')).toBe('ffd8');
    const jpg = await mgr.screenshotJpeg(40);
    expect(jpg.subarray(0, 2).toString('hex')).toBe('ffd8');
  }, 30_000);

  it('downloads land in the downloads dir; dialogs are handled per policy', async () => {
    const snap = (await run(new BrowserSnapshotTool(), { interactive_only: true })).content;
    const click = await run(new BrowserClickTool(), { ref: refOf(snap, 'link', 'Download file'), snapshot: false });
    expect(click.isError, click.content).toBeFalsy();
    const w = await run(new BrowserDownloadsTool(), { action: 'wait', timeout_ms: 15_000 });
    expect(w.isError, w.content + '\n---click:\n' + click.content).toBeFalsy();
    const saved = path.join(tmp, 'downloads', 'report.txt');
    expect(w.content).toContain(`✓ Download finished: ${saved}`);
    expect(await fs.readFile(saved, 'utf8')).toBe('hello download');
    const list = await run(new BrowserDownloadsTool(), { action: 'list' });
    expect(list.content).toContain('[completed]');

    const alert = await run(new BrowserClickTool(), { ref: refOf(snap, 'button', 'Show alert'), snapshot: false });
    expect(alert.isError).toBeFalsy();
    expect(alert.content).toContain('Dialog (alert) "Saved!" → accepted');
  }, 60_000);

  it('press, hover, scroll and upload', async () => {
    const snap = (await run(new BrowserSnapshotTool(), {})).content;
    const hv = await run(new BrowserHoverTool(), { selector: '#hov', snapshot: false });
    expect(hv.isError).toBeFalsy();
    expect((await run(new BrowserGetTextTool(), { selector: '#hov' })).content).toBe('hovered!');

    const sc = await run(new BrowserScrollTool(), { direction: 'down', amount: 1500, snapshot: false });
    expect(sc.content).toMatch(/✓ Scrolled down 1500px — now at y=\d+/);
    const into = await run(new BrowserScrollTool(), { selector: '#bottom', snapshot: false });
    expect(into.content).toContain('into view');

    const file = path.join(tmp, 'upload-me.txt');
    await fs.writeFile(file, 'data');
    const up = await run(new BrowserUploadTool(), { ref: refOf(snap, 'button', 'Attachment'), paths: ['upload-me.txt'], snapshot: false });
    expect(up.isError).toBeFalsy();
    expect(up.content).toContain('✓ Uploaded upload-me.txt');
    expect(await (await mgr.activePage()).title()).toBe('uploaded upload-me.txt');
    const missing = await run(new BrowserUploadTool(), { paths: ['nope.txt'] });
    expect(missing.content).toMatch(/^\[BROWSER_ERROR\] File not found/);

    const pr = await run(new BrowserPressTool(), { key: 'esc', snapshot: false });
    expect(pr.content).toContain('✓ Pressed Escape');
  }, 60_000);

  it('console, network and status report the active tab', async () => {
    await run(new BrowserNavigateTool(), { url: `${base}/`, snapshot: false });
    await run(new BrowserWaitForTool(), { kind: 'text', value: 'Bottom of page' });
    const c = await run(new BrowserConsoleTool(), {});
    expect(c.content).toContain('[log] page ready');
    const n = await run(new BrowserNetworkTool(), { failed_only: true });
    expect(n.content).toMatch(/\[404\] GET .*\/missing-api/);
    const st = await run(new BrowserStatusTool(), {});
    expect(st.content).toContain('Running: yes (headless)');
    expect(st.content).toMatch(/\* \[0\] QX Test Shop/);
  }, 60_000);

  it('a stale or bogus ref fails with [STALE_REF]', async () => {
    const r = await run(new BrowserClickTool(), { ref: 'e9999' });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/^\[STALE_REF\] ref e9999 not found — call browser_snapshot again/);
    const bad = await run(new BrowserClickTool(), { ref: 'Sign in' });
    expect(bad.content).toMatch(/^\[STALE_REF\]/);
    const none = await run(new BrowserClickTool(), {});
    expect(none.content).toMatch(/^\[BROWSER_ERROR\] Pass `ref`/);
  }, 30_000);

  it('human takeover makes agent actions wait until hand-back', async () => {
    mgr.setTakeover(true, 'control');
    let done = false;
    const p = run(new BrowserPressTool(), { key: 'Tab', snapshot: false }).then(r => { done = true; return r; });
    await new Promise(r => setTimeout(r, 300));
    expect(done).toBe(false);
    expect(ctx.events.some(e => /taken over/.test(e))).toBe(true);
    mgr.setTakeover(false);
    const r = await p;
    expect(r.content).toContain('✓ Pressed Tab');
  }, 30_000);

  it('dispatchInput replays human clicks/typing and records them (password redacted)', async () => {
    actions.length = 0;
    const page = await mgr.activePage();
    const box = await page.locator('#pw').boundingBox();
    await mgr.dispatchInput({ type: 'click', x: box.x + 5, y: box.y + 5 });
    await mgr.dispatchInput({ type: 'type', text: 'hunter2' });
    const human = actions.filter(a => a.actor === 'human');
    expect(human[0]).toMatchObject({ tool: 'browser_click', element: { selector: '#pw', isPassword: true } });
    expect(human[1]).toMatchObject({ tool: 'browser_type', args: { text: '***' } });
    expect(await page.locator('#pw').inputValue()).toBe('hunter2');
  }, 30_000);

  it("dialogPolicy 'ask' keeps a dialog pending until browser_dialog answers it", async () => {
    setActiveConfig({ browser: { dialogPolicy: 'ask' } } as any);
    try {
      await run(new BrowserNavigateTool(), { url: `${base}/`, snapshot: false });
      const snap = (await run(new BrowserSnapshotTool(), { interactive_only: true })).content;
      const r = await run(new BrowserClickTool(), { ref: refOf(snap, 'button', 'Show alert') });
      expect(r.isError).toBeFalsy();
      expect(r.content).toContain('it opened a dialog');
      expect(r.content).toMatch(/Dialog waiting \(alert\): "Saved!"/);
      const blocked = await run(new BrowserPressTool(), { key: 'Tab' });
      expect(blocked.content).toMatch(/^\[BROWSER_ERROR\] An alert dialog is open on this tab: "Saved!"/);
      const st = await run(new BrowserDialogTool(), { action: 'status' });
      expect(st.content).toContain('Waiting: (alert) "Saved!"');
      const acc = await run(new BrowserDialogTool(), { action: 'accept' });
      expect(acc.content).toContain('✓ Accepted alert "Saved!"');
      expect(mgr.pendingDialog()).toBeNull();
      const none = await run(new BrowserDialogTool(), { action: 'dismiss' });
      expect(none.content).toMatch(/No dialog is waiting/);
    } finally {
      setActiveConfig(null as any);
    }
  }, 60_000);

  it('drag and drop, PDF export, and closing the active tab activates the previous one', async () => {
    await run(new BrowserNavigateTool(), { url: `${base}/`, snapshot: false });
    const d = await run(new BrowserDragTool(), { from_selector: '#drag', to_selector: '#drop', snapshot: false });
    expect(d.isError, d.content).toBeFalsy();
    expect((await run(new BrowserGetTextTool(), { selector: '#drop' })).content).toBe('dropped!');

    const pdf = await run(new BrowserPdfTool(), { path: 'out/page.pdf' });
    expect(pdf.isError, pdf.content).toBeFalsy();
    expect((await fs.readFile(path.join(tmp, 'out', 'page.pdf'))).subarray(0, 4).toString()).toBe('%PDF');
    expect((await run(new BrowserPdfTool(), { path: 'notes.txt' })).content).toMatch(/must end with \.pdf/);
    expect((await run(new BrowserScreenshotTool(), { path: 'evil.sh' })).content).toMatch(/must end with \.png/);

    const opened = await run(new BrowserTabsTool(), { action: 'new', url: `${base}/page2`, snapshot: false });
    expect(opened.content).toMatch(/✓ Opened tab \[1\] at .*\/page2 \(now active\)/);
    const closed = await run(new BrowserTabsTool(), { action: 'close', snapshot: false });
    expect(closed.content).toContain('✓ Closed tab [1]');
    expect(mgr.tabs()).toHaveLength(1);
    expect(mgr.tabs()[0]).toMatchObject({ active: true, title: 'QX Test Shop' });
  }, 60_000);

  it('falls back to a DOM walker (data-qx-ref refs) when the AI snapshot is unavailable', async () => {
    const page = await mgr.activePage();
    const noAria = new Proxy(page, {
      get(t, p) {
        if (p === 'ariaSnapshot') return undefined;
        const v = (t as any)[p];
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    const r = await takeSnapshotDetailed(noAria, { interactiveOnly: true });
    expect(r.mode).toBe('dom');
    const ref = refOf(r.body, 'textbox', 'Email');
    expect(await page.locator(`[data-qx-ref="${ref}"]`).getAttribute('id')).toBe('email');
    expect(r.body).toMatch(/- combobox "Country" \[ref=e\d+\]\n {2}- option "Iran"/);
    const full = await takeSnapshotDetailed(noAria, {});
    expect(full.body).toMatch(/- heading "Test Shop" \[level=1\] \[ref=e\d+\]/);
    expect(full.body).toContain('- text: Welcome to the');
    const boxes = await snapshotWithBoxes(noAria);
    expect(boxes.mode).toBe('dom');
    expect(boxes.marks.some(m => m.role === 'button' && m.name === 'Sign in' && m.w > 0)).toBe(true);
  }, 30_000);

  it('back-compat getSession() exposes the active tab', async () => {
    const s = await getSession();
    expect(s.page).toBe(await mgr.activePage());
    expect(Array.isArray(s.consoleBuffer)).toBe(true);
  }, 30_000);

  it('the persistent profile keeps localStorage across close / relaunch', async () => {
    await run(new BrowserNavigateTool(), { url: `${base}/store`, snapshot: false });
    await run(new BrowserEvaluateTool(), { script: "localStorage.setItem('qx', 'kept-across-restarts'); return true" });
    await closeBrowser();
    expect(mgr.isRunning()).toBe(false);
    await mgr.ensure();
    const r = await run(new BrowserNavigateTool(), { url: `${base}/store`, snapshot: false });
    expect(r.isError).toBeFalsy();
    const v = await run(new BrowserGetTextTool(), { selector: '#v' });
    expect(v.content).toBe('kept-across-restarts');
  }, 60_000);

  it.skipIf(!exe.executablePath)('cdpUrl mode attaches to a running Chrome and close() only disconnects', async () => {
    const userDir = path.join(tmp, 'user-chrome');
    await fs.mkdir(userDir, { recursive: true });
    const child = spawn(exe.executablePath!, ['--headless=new', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${userDir}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
    try {
      let port = '';
      for (let i = 0; i < 100 && !port; i++) {
        try { port = (await fs.readFile(path.join(userDir, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; } catch { /* not yet */ }
        if (!port) await new Promise(r => setTimeout(r, 100));
      }
      expect(port).toMatch(/^\d+$/);
      const cdp = new QodexBrowserManager({ profilesDir: path.join(tmp, 'profiles'), downloadsDir: path.join(tmp, 'downloads'), config: { cdpUrl: `http://127.0.0.1:${port}` } });
      await cdp.ensure();
      expect(cdp.status()).toMatchObject({ running: true, mode: 'cdp', headless: false });
      expect(cdp.tabs().length).toBe(2); // the user's tab + the agent's own tab
      expect(cdp.tabs()[1].active).toBe(true);
      const page = await cdp.activePage();
      await page.goto(`${base}/page2`);
      expect(await page.title()).toBe('Second');
      await cdp.close();
      expect(cdp.isRunning()).toBe(false);
      await new Promise(r => setTimeout(r, 300));
      expect(child.exitCode).toBeNull();
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
    } finally {
      child.kill('SIGKILL');
    }
  }, 60_000);

  it('a profile locked by another browser falls back to <profile>-<pid> with a notice', async () => {
    const second = new QodexBrowserManager({ profilesDir: path.join(tmp, 'profiles'), downloadsDir: path.join(tmp, 'downloads'), config: { headless: true } });
    try {
      await second.ensure();
      const st = second.status();
      expect(st.profile).toBe(`default-${process.pid}`);
      expect(st.notice).toMatch(/in use by another browser/);
      expect(second.drainNotices().join('\n')).toMatch(/in use by another browser/);
    } finally {
      await second.close();
    }
  }, 60_000);
});
