/**
 * H2 hand-off surfaces — dashboard side: hand-off mode markup, the press-and-hold
 * gesture state machine (every 'down' ends with an 'up'), the input queue never
 * dropping 'down' / 'up', and a real Chromium phone-sized viewer that opens a
 * hand-off link, relays a press-and-hold / drag, answers "done" and sees the
 * automatic resume. Chromium is only the VIEWER; the agent browser is a fake.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { renderDashboard, DASHBOARD_STRINGS, DASHBOARD_INPUT_HELPERS } from '../src/control/dashboard.js';
import { startControlCenter, stopControlCenter, mintHandoffLink, type ControlCenterInfo } from '../src/control/server.js';
import { getApprovalBroker, type ApprovalResult } from '../src/control/approvals.js';
import { getBus } from '../src/control/bus.js';
import { handoffOwner } from '../src/control/handoff.js';
import {
  setBrowserManagerForTests,
  type BrowserManager,
  type BrowserStatus,
  type HumanInputEvent,
  type ScreencastFrame,
  type TabInfo,
} from '../src/tools/browser/types.js';

function inlineScripts(html: string): { boot: string; code: string } {
  const boot = html.match(/<script id="qx-boot" type="application\/json">([\s\S]*?)<\/script>/);
  const code = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
  return { boot: boot?.[1] ?? '', code: code?.[1] ?? '' };
}

type Ev = Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const helpers = new Function(`${DASHBOARD_INPUT_HELPERS}; return { qxEnqueueInput, qxHoldStep, QX_HOLD_MAX_MS, QX_MOVE_EVERY_MS };`)() as {
  qxEnqueueInput: (q: Ev[], ev: Ev, max?: number) => Ev[];
  qxHoldStep: (g: Ev, ev: Ev, now: number) => Ev[];
  QX_HOLD_MAX_MS: number;
  QX_MOVE_EVERY_MS: number;
};

const P = (x: number, y = 10) => ({ x, y, frameWidth: 640, frameHeight: 400 });

describe('dashboard hand-off mode markup', () => {
  it('still parses and keeps the sendInput takeover guard', () => {
    for (const opts of [{}, { handoff: { id: 'ho_1', scoped: true } }, { lang: 'fa' as const, handoff: { id: 'ho_1' } }]) {
      const { code } = inlineScripts(renderDashboard(opts));
      expect(() => new Function(code)).not.toThrow();
      expect(code).toMatch(/function sendInput\(ev\) \{\s*if \(!state\.takeover\) return;/);
    }
  });

  it('boots hand-off mode only for a valid id; scoped only when the server says so', () => {
    const boot = (o: Parameters<typeof renderDashboard>[0]) => JSON.parse(inlineScripts(renderDashboard(o)).boot) as { handoff: unknown };
    expect(boot({}).handoff).toBeNull();
    expect(boot({ handoff: { id: 'ho_1', scoped: true } }).handoff).toEqual({ id: 'ho_1', scoped: true });
    expect(boot({ handoff: { id: 'ho_1' } }).handoff).toEqual({ id: 'ho_1', scoped: false });
    expect(boot({ handoff: { id: '</script><x>' } }).handoff).toBeNull();
  });

  it('has the banner, Done / Can\'t buttons, phone-first live view and no long-press right-click', () => {
    const html = renderDashboard({ handoff: { id: 'ho_1', scoped: true } });
    for (const id of ['handoffBar', 'hoDoneBtn', 'hoCantBtn', 'hoZoomBtn', 'hoModeBtn', 'hoKbBtn', 'typeBox']) expect(html).toContain(`id="${id}"`);
    expect(html).toContain('Solve it — QodeX continues by itself');
    expect(html).toContain('حلش کنید — QodeX خودش ادامه می‌دهد');
    expect(html).toMatch(/@media \(max-width:900px\)\{body\.handoff #livePanel\{order:0\}\}/);
    expect(html).toContain('body.handoff.takeover #screen{touch-action:pinch-zoom}');
    const { code } = inlineScripts(html);
    expect(code).toMatch(/addEventListener\('contextmenu', function \(e\) \{\s*if \(HO\) \{ e\.preventDefault\(\); return; \}/);
    expect(code).toContain("'/api/handoff/'");
    // A scoped page never opens the event stream (approvals/activity are not its business).
    expect(code).toContain("if (!(HO && HO.scoped)) connectEvents();");
  });

  it('every new string exists in English and Persian', () => {
    for (const k of Object.keys(DASHBOARD_STRINGS.en).filter(k => k.startsWith('ho') || k === 'opt_done' || k === 'cat_challenge')) {
      expect(DASHBOARD_STRINGS.fa[k], k).toBeTruthy();
    }
    expect(Object.keys(DASHBOARD_STRINGS.fa).sort()).toEqual(Object.keys(DASHBOARD_STRINGS.en).sort());
  });
});

describe('press-and-hold gesture state machine', () => {
  it('relays down → move → up for one finger', () => {
    const g: Ev = {};
    expect(helpers.qxHoldStep(g, { kind: 'down', id: 1, p: P(10) }, 0)).toEqual([{ type: 'down', button: 'left', ...P(10) }]);
    expect(helpers.qxHoldStep(g, { kind: 'move', id: 1, p: P(20) }, 100)).toEqual([{ type: 'move', button: 'left', ...P(20) }]);
    // throttled moves only update the position
    expect(helpers.qxHoldStep(g, { kind: 'move', id: 1, p: P(25) }, 110)).toEqual([]);
    expect(helpers.qxHoldStep(g, { kind: 'move', id: 2, p: P(99) }, 300)).toEqual([]); // another pointer
    expect(helpers.qxHoldStep(g, { kind: 'up', id: 1, p: P(30) }, 400)).toEqual([{ type: 'up', button: 'left', ...P(30) }]);
    expect(g.down).toBe(false);
  });

  it('a second finger (pinch zoom) releases the hold instead of relaying', () => {
    const g: Ev = {};
    helpers.qxHoldStep(g, { kind: 'down', id: 1, p: P(10) }, 0);
    expect(helpers.qxHoldStep(g, { kind: 'down', id: 2, p: P(50) }, 10)).toEqual([{ type: 'up', button: 'left', ...P(10) }]);
    expect(helpers.qxHoldStep(g, { kind: 'move', id: 1, p: P(60) }, 200)).toEqual([]);
    expect(helpers.qxHoldStep(g, { kind: 'up', id: 1, p: P(60) }, 300)).toEqual([]);
    helpers.qxHoldStep(g, { kind: 'up', id: 2, p: P(60) }, 300);
    // both fingers lifted: the next touch is a fresh gesture
    expect(helpers.qxHoldStep(g, { kind: 'down', id: 3, p: P(5) }, 400)).toEqual([{ type: 'down', button: 'left', ...P(5) }]);
  });

  it('cancel, abort (page hidden / stream drop / control lost) and the hold cap all end with up', () => {
    for (const end of [
      (g: Ev) => helpers.qxHoldStep(g, { kind: 'cancel', id: 1 }, 50),
      (g: Ev) => helpers.qxHoldStep(g, { kind: 'abort' }, 50),
      (g: Ev) => helpers.qxHoldStep(g, { kind: 'tick' }, helpers.QX_HOLD_MAX_MS),
    ]) {
      const g: Ev = {};
      helpers.qxHoldStep(g, { kind: 'down', id: 1, p: P(10) }, 0);
      helpers.qxHoldStep(g, { kind: 'move', id: 1, p: P(70) }, 45);
      expect(end(g)).toEqual([{ type: 'up', button: 'left', ...P(70) }]);
      expect(g.down).toBe(false);
    }
    const g: Ev = {};
    helpers.qxHoldStep(g, { kind: 'down', id: 1, p: P(10) }, 0);
    expect(helpers.qxHoldStep(g, { kind: 'tick' }, helpers.QX_HOLD_MAX_MS - 1)).toEqual([]);
    helpers.qxHoldStep(g, { kind: 'tick' }, helpers.QX_HOLD_MAX_MS);
    expect(g.capped).toBe(true);
    expect(helpers.QX_HOLD_MAX_MS).toBeLessThanOrEqual(15_000);
  });

  it('never emits a down without a matching up, whatever the pointer sequence', () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const kinds = ['down', 'move', 'up', 'cancel', 'abort', 'tick'];
    for (let run = 0; run < 200; run++) {
      const g: Ev = {};
      const out: Ev[] = [];
      let now = 0;
      for (let i = 0; i < 40; i++) {
        now += Math.floor(rnd() * 3000);
        const kind = kinds[Math.floor(rnd() * kinds.length)];
        const id = 1 + Math.floor(rnd() * 3);
        out.push(...helpers.qxHoldStep(g, { kind, id, p: rnd() < 0.9 ? P(Math.floor(rnd() * 600)) : null }, now));
      }
      out.push(...helpers.qxHoldStep(g, { kind: 'abort' }, now + 1));
      let held = false;
      for (const ev of out) {
        if (ev.type === 'down') { expect(held).toBe(false); held = true; }
        if (ev.type === 'up') { expect(held).toBe(true); held = false; }
        if (ev.type === 'move') expect(held).toBe(true);
      }
      expect(held).toBe(false);
    }
  });
});

describe('input queue keeps every down / up', () => {
  it('never drops or merges down / up, even over the cap', () => {
    const q: Ev[] = [];
    helpers.qxEnqueueInput(q, { type: 'down', ...P(1) }, 3);
    for (let i = 0; i < 20; i++) helpers.qxEnqueueInput(q, { type: 'move', ...P(i) }, 3);
    helpers.qxEnqueueInput(q, { type: 'up', ...P(30) }, 3);
    helpers.qxEnqueueInput(q, { type: 'down', ...P(2) }, 3);
    helpers.qxEnqueueInput(q, { type: 'up', ...P(3) }, 3);
    const types = q.map(e => e.type);
    expect(types.filter(t => t === 'down').length).toBe(2);
    expect(types.filter(t => t === 'up').length).toBe(2);
    expect(types[types.length - 1]).toBe('up');
    // the drag's final move is not dropped in front of 'up' (only a click carries its own point)
    const d: Ev[] = [];
    helpers.qxEnqueueInput(d, { type: 'down', ...P(1) });
    helpers.qxEnqueueInput(d, { type: 'move', ...P(5) });
    helpers.qxEnqueueInput(d, { type: 'move', ...P(9) });
    helpers.qxEnqueueInput(d, { type: 'up', ...P(9) });
    expect(d.map(e => [e.type, e.x])).toEqual([['down', 1], ['move', 9], ['up', 9]]);
  });
});

// ── real browser ──────────────────────────────────────────────────────────────

function findChromium(): string | null {
  const candidates: string[] = [];
  if (process.env.QODEX_BROWSER_EXECUTABLE) candidates.push(process.env.QODEX_BROWSER_EXECUTABLE);
  candidates.push('/opt/pw-browsers/chromium');
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(os.homedir(), '.cache', 'ms-playwright')].filter((r): r is string => !!r);
  for (const root of roots) {
    let dirs: string[] = [];
    try { dirs = fs.readdirSync(root).filter(n => /^chromium-\d+$/.test(n)); } catch { continue; }
    dirs.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const d of dirs) candidates.push(path.join(root, d, 'chrome-linux', 'chrome'), path.join(root, d, 'chrome-linux64', 'chrome'));
  }
  candidates.push('/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome');
  return candidates.find(p => { try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; } }) ?? null;
}

let playwright: any = null;
try { playwright = await import('playwright'); } catch { playwright = null; }
const chromiumPath = playwright ? findChromium() : null;

class FakeBrowser implements BrowserManager {
  running = true;
  takeover = false;
  takeoverBy?: string;
  inputs: HumanInputEvent[] = [];
  frameData = '';
  private timer: NodeJS.Timeout | null = null;
  async ensure(): Promise<void> {}
  isRunning(): boolean { return this.running; }
  status(): BrowserStatus {
    return { running: this.running, mode: 'launch', headless: true, profile: 'default', tabs: this.tabs(), takeover: this.takeover, takeoverBy: this.takeoverBy, downloadsDir: '/tmp' };
  }
  async activePage(): Promise<any> { return {}; }
  context(): any { return null; }
  tabs(): TabInfo[] { return [{ index: 0, id: 't1', url: 'https://shop.example/login?next=%2Fcart', title: 'Just a moment…', active: true }]; }
  async newTab(): Promise<TabInfo> { throw new Error('n/a'); }
  async switchTab(): Promise<TabInfo> { throw new Error('n/a'); }
  async closeTab(): Promise<void> {}
  async close(): Promise<void> {}
  async restart(): Promise<void> {}
  async startScreencast(onFrame: (f: ScreencastFrame) => void): Promise<() => Promise<void>> {
    this.timer = setInterval(() => onFrame({ data: this.frameData, width: 640, height: 400, ts: Date.now() }), 100);
    return async () => { if (this.timer) clearInterval(this.timer); this.timer = null; };
  }
  async screenshotJpeg(): Promise<Buffer> { return Buffer.from(this.frameData, 'base64'); }
  setTakeover(on: boolean, by?: string): void {
    this.takeover = on;
    this.takeoverBy = on ? by : undefined;
    getBus().publish({ kind: 'browser', type: 'takeover', data: { on, by } });
  }
  isTakeover(): boolean { return this.takeover; }
  async waitForTakeoverEnd(): Promise<void> {}
  async dispatchInput(ev: HumanInputEvent): Promise<void> { this.inputs.push(ev); }
  async locator(): Promise<any> { throw new Error('n/a'); }
  activeUrl(): string { return 'https://shop.example/login'; }
  async describeRef(): Promise<null> { return null; }
  async describeSelector(): Promise<null> { return null; }
  onAction(): () => void { return () => {}; }
  recordAction(): void {}
  dispose(): void { if (this.timer) clearInterval(this.timer); }
}

async function waitUntil(fn: () => boolean, ms = 8000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await new Promise(r => setTimeout(r, 25));
  }
  return fn();
}

function raise(): Promise<ApprovalResult> {
  return getApprovalBroker().request({
    prompt: 'A bot check (Cloudflare Turnstile) on shop.example needs you.',
    options: ['done', 'cancel'], source: 'browser', category: 'challenge', risk: 'medium', timeoutMs: 120_000,
    meta: { handoff: { id: 'ho_live1', host: 'shop.example', vendor: 'turnstile', state: 'needs-human', tabIndex: 0, frameBox: { x: 170, y: 160, width: 300, height: 65 }, linkTtlSec: 600 } },
  });
}

describe('hand-off link in a real phone-sized browser', () => {
  let browser: any;
  let info: ControlCenterInfo;
  let fake: FakeBrowser;

  beforeAll(async () => {
    if (!chromiumPath) return;
    browser = await playwright.chromium.launch({ headless: true, executablePath: chromiumPath, args: ['--no-proxy-server'] });
    const p0 = await browser.newPage({ viewport: { width: 640, height: 400 } });
    await p0.setContent('<body style="margin:0;background:#f97316"><div style="position:absolute;left:170px;top:160px;width:300px;height:65px;background:#fff"></div></body>');
    const jpeg: Buffer = await p0.screenshot({ type: 'jpeg', quality: 60 });
    await p0.close();
    getBus().reset();
    getApprovalBroker().reset();
    fake = new FakeBrowser();
    fake.frameData = jpeg.toString('base64');
    setBrowserManagerForTests(fake);
    info = await startControlCenter({ port: 0, token: 'handoff-dash-token-0123456789', lang: 'en' });
  }, 60_000);

  afterAll(async () => {
    await stopControlCenter();
    fake?.dispose();
    setBrowserManagerForTests(null);
    getApprovalBroker().reset();
    getBus().reset();
    await browser?.close();
  });

  it.skipIf(!chromiumPath)('relays a press-and-hold / drag, answers "done", and shows the automatic resume', async () => {
    fake.setTakeover(true, handoffOwner('ho_live1'));
    const first = raise();
    const link = (await mintHandoffLink('ho_live1', 600_000))!;
    const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true });
    const page = await ctx.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (e: Error) => pageErrors.push(e.message));
    const requests: string[] = [];
    page.on('request', (r: any) => requests.push(new URL(r.url()).pathname));

    await page.goto(link.url);
    await page.waitForURL(`http://127.0.0.1:${info.port}/?handoff=ho_live1`);
    expect(page.url()).not.toContain('h=');
    await page.locator('body.handoff.scoped').waitFor({ timeout: 10_000 });
    await page.locator('#handoffBar:not(.hidden)').waitFor();
    expect(await page.locator('#hoTitle').textContent()).toBe('Solve it — QodeX continues by itself');
    await page.locator('#hoInfo', { hasText: 'turnstile · shop.example' }).waitFor({ timeout: 10_000 });
    expect(await page.locator('#approvalsPanel').isVisible()).toBe(false);
    expect(await page.locator('#stopBtn').isVisible()).toBe(false);
    await page.locator('#frame:not(.hidden)').waitFor({ timeout: 10_000 });
    await page.locator('body.takeover').waitFor({ timeout: 10_000 });
    // zoomed to the challenge box
    await page.waitForFunction(() => /scale\(/.test((document.getElementById('frame') as any).style.transform), null, { timeout: 10_000 });

    // Press and hold, drag, release — relayed as the human's own down / move / up.
    const box = await page.locator('#screen').boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + Math.min(box.height / 2, 60);
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await new Promise(r => setTimeout(r, 400));
    await page.mouse.move(cx + 30, cy, { steps: 6 });
    await new Promise(r => setTimeout(r, 120));
    await page.mouse.up();
    expect(await waitUntil(() => fake.inputs.some(e => e.type === 'up'))).toBe(true);
    const types = fake.inputs.map(e => e.type);
    // (a mouse also relays its hover moves before the press)
    expect(types.filter(t => t !== 'move')).toEqual(['down', 'up']);
    expect(types.indexOf('down')).toBeLessThan(types.lastIndexOf('move'));
    expect(types[types.length - 1]).toBe('up');
    expect(types).not.toContain('click'); // the tap is the down/up pair, not an extra click
    // a long-press / right-click never becomes a right-click on the page
    await page.locator('#screen').dispatchEvent('contextmenu');
    await new Promise(r => setTimeout(r, 200));
    expect(fake.inputs.some(e => e.type === 'click')).toBe(false);

    // "Done" answers the hand-off; the controller re-checks and asks again while it is still there.
    await page.locator('#hoDoneBtn').click();
    expect(await first).toEqual({ answer: 'done', by: 'control' });
    const second = raise();
    await page.locator('#hoStatus', { hasText: 'QodeX still sees the check' }).waitFor({ timeout: 10_000 });

    // The check disappears: the controller resolves it itself and releases the browser.
    const ap = getApprovalBroker().pending()[0]!;
    getApprovalBroker().resolve(ap.id, 'done', 'challenge-cleared');
    expect(await second).toEqual({ answer: 'done', by: 'challenge-cleared' });
    fake.setTakeover(false);
    await page.locator('#hoStatus', { hasText: 'Cleared — QodeX continues by itself' }).waitFor({ timeout: 10_000 });

    // The scoped page never asked for anything outside its hand-off.
    for (const p of requests) expect(p).toMatch(/^\/($|api\/(state|frames|frame\.jpg|input|takeover|handoff\/ho_live1))/);
    expect(pageErrors).toEqual([]);
    await ctx.close();
  }, 60_000);
});
