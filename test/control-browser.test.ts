/**
 * Real-browser check of the Control Center dashboard: a headless Chromium opens
 * the private link, and we drive the page like a human would — approve a purchase,
 * take over and click/type on the live frame, steer, cancel a mission, switch to
 * Persian. The browser manager behind the server is a fake (no agent browser is
 * launched); Chromium is only the VIEWER here. Skipped when Playwright or a
 * Chromium executable isn't available.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startControlCenter, stopControlCenter, registerControlAction, type ControlCenterInfo } from '../src/control/server.js';
import { getApprovalBroker } from '../src/control/approvals.js';
import { getBus } from '../src/control/bus.js';
import {
  setBrowserManagerForTests,
  type BrowserManager,
  type BrowserStatus,
  type HumanInputEvent,
  type ScreencastFrame,
  type TabInfo,
} from '../src/tools/browser/types.js';

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
  candidates.push('/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable');
  if (process.platform === 'darwin') candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  return candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } }) ?? null;
}

let playwright: any = null;
try { playwright = await import('playwright'); } catch { playwright = null; }
const chromiumPath = playwright ? findChromium() : null;

const TOKEN = 'browser-test-token-0123456789';

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
  tabs(): TabInfo[] { return [{ index: 0, id: 't1', url: 'https://shop.example/cart', title: 'Cart', active: true }]; }
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
  activeUrl(): string { return 'https://shop.example/cart'; }
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

describe('control center dashboard in a real browser', () => {
  let browser: any;
  let info: ControlCenterInfo;
  let fake: FakeBrowser;
  const steered: string[] = [];
  const cancelled: unknown[] = [];
  const unregister: Array<() => void> = [];

  beforeAll(async () => {
    if (!chromiumPath) return;
    browser = await playwright.chromium.launch({ headless: true, executablePath: chromiumPath, args: ['--no-proxy-server'] });
    // A real JPEG for the fake screencast (the dashboard renders it in an <img>).
    const p0 = await browser.newPage({ viewport: { width: 640, height: 400 } });
    await p0.setContent('<body style="margin:0;background:#2563eb;color:#fff;font:40px sans-serif"><p style="padding:40px">Fake shop</p></body>');
    const jpeg: Buffer = await p0.screenshot({ type: 'jpeg', quality: 60 });
    await p0.close();

    getBus().reset();
    getApprovalBroker().reset();
    fake = new FakeBrowser();
    fake.frameData = jpeg.toString('base64');
    setBrowserManagerForTests(fake);
    info = await startControlCenter({ port: 0, token: TOKEN, lang: 'en', onSteer: (note) => { steered.push(note); return true; } });
  }, 60_000);

  afterAll(async () => {
    while (unregister.length) unregister.pop()!();
    await stopControlCenter();
    fake?.dispose();
    setBrowserManagerForTests(null);
    getApprovalBroker().reset();
    getBus().reset();
    await browser?.close();
  });

  it.skipIf(!chromiumPath)('approves, takes over, forwards input, steers, cancels a mission and switches to Persian', async () => {
    const base = `http://127.0.0.1:${info.port}`;
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const pageErrors: string[] = [];
    page.on('pageerror', (e: Error) => pageErrors.push(e.message));
    page.on('dialog', (d: any) => { void d.accept(); });

    // Private link → cookie + bounce → dashboard without the token in the URL.
    await page.goto(info.url);
    await page.waitForURL(`${base}/`);
    expect(page.url()).not.toContain(TOKEN);
    await page.locator('#connText', { hasText: 'Live' }).waitFor({ timeout: 10_000 });

    // Live view shows frames.
    await page.locator('#frame:not(.hidden)').waitFor({ timeout: 10_000 });
    expect(await page.locator('#url').inputValue()).toBe('https://shop.example/cart');

    // Approvals: a Sentinel-critical purchase is answered from the page.
    const pending = getApprovalBroker().request({ prompt: 'Place the order for $42.00 on shop.example?', options: ['yes', 'no'], category: 'purchase', risk: 'critical', source: 'browser_click' });
    const card = page.locator('#approvalList .card', { hasText: 'Place the order for $42.00' });
    await card.waitFor({ timeout: 10_000 });
    expect(await card.locator('.badge').first().textContent()).toBe('critical');
    expect(await page.title()).toMatch(/^\(1\) /);
    await card.locator('button', { hasText: 'Yes' }).click();
    expect(await pending).toEqual({ answer: 'yes', by: 'control' });
    await page.locator('#approvalList .empty').waitFor({ timeout: 10_000 });

    // Input is NOT forwarded while the agent is in control.
    await page.locator('#frame').click({ position: { x: 50, y: 50 } });
    await new Promise(r => setTimeout(r, 300));
    expect(fake.inputs).toEqual([]);

    // Take over → clicks/keys/URL bar reach the browser manager in frame coordinates.
    await page.locator('#takeBtn').click();
    expect(await waitUntil(() => fake.takeover)).toBe(true);
    expect(fake.takeoverBy).toBe('control');
    await page.locator('body.takeover').waitFor();
    expect(await page.locator('#takeBtn').textContent()).toBe('Hand back');

    const box = await page.locator('#frame').boundingBox();
    await page.locator('#frame').click({ position: { x: 100, y: 60 } });
    expect(await waitUntil(() => fake.inputs.some(e => e.type === 'click'))).toBe(true);
    const click = fake.inputs.find(e => e.type === 'click') as Extract<HumanInputEvent, { type: 'click' }>;
    expect(click.frameWidth).toBe(640);
    expect(click.frameHeight).toBe(400);
    expect(Math.abs(click.x - Math.round(100 / box.width * 640))).toBeLessThanOrEqual(1);
    expect(Math.abs(click.y - Math.round(60 / box.height * 400))).toBeLessThanOrEqual(1);

    await page.keyboard.type('hi');
    await page.keyboard.press('Enter');
    expect(await waitUntil(() => fake.inputs.some(e => e.type === 'key' && e.key === 'Enter'))).toBe(true);
    expect(fake.inputs).toContainEqual({ type: 'type', text: 'hi' });

    await page.locator('#url').fill('example.com/checkout');
    await page.locator('#url').press('Enter');
    expect(await waitUntil(() => fake.inputs.some(e => e.type === 'navigate'))).toBe(true);
    expect(fake.inputs).toContainEqual({ type: 'navigate', url: 'https://example.com/checkout' });

    // Hand back → input stops.
    await page.locator('#takeBtn').click();
    expect(await waitUntil(() => !fake.takeover)).toBe(true);
    await page.locator('body:not(.takeover)').waitFor();
    const count = fake.inputs.length;
    await page.locator('#frame').click({ position: { x: 20, y: 20 } });
    await new Promise(r => setTimeout(r, 300));
    expect(fake.inputs.length).toBe(count);

    // Steer.
    await page.locator('#steerText').fill('Use the cheaper shipping option');
    await page.locator('#steerBtn').click();
    expect(await waitUntil(() => steered.length === 1)).toBe(true);
    expect(steered[0]).toBe('Use the cheaper shipping option');
    await page.locator('#steerMsg', { hasText: 'Sent' }).waitFor();

    // Missions panel appears when the action is registered; cancel goes through the action.
    unregister.push(registerControlAction('missions.list', () => [{ id: 'm_42', goal: 'Order coffee beans every Friday', status: 'running', steps: [{ status: 'done' }, { status: 'running' }] }]));
    unregister.push(registerControlAction('missions.cancel', (body) => { cancelled.push(body); return { ok: true }; }));
    await page.locator('#missionsPanel:not(.hidden)').waitFor({ timeout: 10_000 });
    const mission = page.locator('#missionList .mission', { hasText: 'Order coffee beans every Friday' });
    await mission.waitFor({ timeout: 10_000 });
    expect(await mission.textContent()).toContain('1/2');
    await mission.locator('button', { hasText: 'Cancel' }).click();
    expect(await waitUntil(() => cancelled.length === 1)).toBe(true);
    expect(cancelled[0]).toEqual({ id: 'm_42' });

    // Activity timeline.
    getBus().publish({ kind: 'notice', level: 'warn', message: 'Sentinel paused a payment' });
    await page.locator('#activityList li', { hasText: 'Sentinel paused a payment' }).waitFor({ timeout: 10_000 });

    // Persian.
    await page.locator('#langBtn').click();
    expect(await page.evaluate('document.documentElement.dir')).toBe('rtl');
    expect(await page.evaluate('document.documentElement.lang')).toBe('fa');
    expect(await page.locator('#takeBtn').textContent()).toBe('گرفتن کنترل');
    expect(await page.locator('#approvalsPanel h2').textContent()).toBe('تأییدها');

    expect(pageErrors).toEqual([]);
    await page.close();
  }, 90_000);

  it.skipIf(!chromiumPath)('types emoji / AltGr / Option characters as text, drops already-answered mission approvals, URL bar follows the active tab', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const pageErrors: string[] = [];
    page.on('pageerror', (e: Error) => pageErrors.push(e.message));
    await page.goto(info.url);
    await page.waitForURL(`http://127.0.0.1:${info.port}/`);
    await page.locator('#frame:not(.hidden)').waitFor({ timeout: 10_000 });
    await page.locator('#takeBtn').click();
    await page.locator('body.takeover').waitFor({ timeout: 10_000 });
    fake.inputs.length = 0;

    // Synthetic keydowns on the live view, as a phone emoji keyboard / AltGr layout / macOS Option would send them.
    await page.evaluate(`(() => {
      const s = document.getElementById('screen');
      s.focus();
      const fire = (init) => s.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, init)));
      fire({ key: '😀' });
      fire({ key: '@', ctrlKey: true, altKey: true, modifierAltGraph: true });
      fire({ key: 'ø', altKey: true });
    })()`);
    expect(await waitUntil(() => fake.inputs.some(e => e.type === 'type'))).toBe(true);
    await new Promise(r => setTimeout(r, 300));
    const typed = fake.inputs.filter(e => e.type === 'type').map(e => (e as { text: string }).text).join('');
    expect(typed).toBe('😀@ø');
    expect(fake.inputs.filter(e => e.type === 'key')).toEqual([]);

    // A plain Alt+letter is still a shortcut (accesskeys), and Ctrl+L is still a key combo.
    fake.inputs.length = 0;
    await page.evaluate(`(() => {
      const s = document.getElementById('screen');
      const fire = (init) => s.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, init)));
      fire({ key: 'd', altKey: true });
      fire({ key: 'l', ctrlKey: true });
    })()`);
    expect(await waitUntil(() => fake.inputs.filter(e => e.type === 'key').length === 2)).toBe(true);
    expect(fake.inputs).toEqual([{ type: 'key', key: 'Alt+d' }, { type: 'key', key: 'ControlOrMeta+l' }]);
    await page.locator('#takeBtn').click();
    await page.locator('body:not(.takeover)').waitFor();

    // A mission approval answered elsewhere: the server says 409 → the card goes away.
    const tries: unknown[] = [];
    unregister.push(registerControlAction('missions.approvals', () => [{ id: 'ap_m1', missionId: 'm_42', prompt: 'Renew the domain for $12?', options: ['yes', 'no'], category: 'payment', createdAt: new Date().toISOString() }]));
    unregister.push(registerControlAction('missions.resolveApproval', (body) => { tries.push(body); throw new Error('[APPROVAL_NOT_PENDING] Approval ap_m1 is already approved.'); }));
    const card = page.locator('#approvalList .card', { hasText: 'Renew the domain' });
    await card.waitFor({ timeout: 10_000 });
    await card.locator('button', { hasText: 'Yes' }).click();
    expect(await waitUntil(() => tries.length === 1)).toBe(true);
    await card.waitFor({ state: 'detached', timeout: 3000 });

    // The URL bar follows the ACTIVE tab only (Module A publishes 'navigated' for every tab).
    expect(await page.locator('#url').inputValue()).toBe('https://shop.example/cart');
    getBus().publish({ kind: 'browser', type: 'navigated', data: { tab: 't9', index: 3, url: 'https://ads.example/background' } });
    getBus().publish({ kind: 'notice', level: 'info', message: 'after-background-nav' });
    await page.locator('#activityList li', { hasText: 'after-background-nav' }).waitFor({ timeout: 10_000 });
    expect(await page.locator('#url').inputValue()).toBe('https://shop.example/cart');
    getBus().publish({ kind: 'browser', type: 'navigated', data: { tab: 't1', index: 0, url: 'https://shop.example/checkout' } });
    let seen = '';
    for (let i = 0; i < 60 && seen !== 'https://shop.example/checkout'; i++) {
      seen = await page.locator('#url').inputValue();
      if (seen !== 'https://shop.example/checkout') await new Promise(r => setTimeout(r, 50));
    }
    expect(seen).toBe('https://shop.example/checkout');

    expect(pageErrors).toEqual([]);
    await page.close();
  }, 60_000);

  it.skipIf(!chromiumPath)('masks secrets in forwarded bus events but never puts a masked URL into the URL bar', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const pageErrors: string[] = [];
    page.on('pageerror', (e: Error) => pageErrors.push(e.message));
    await page.goto(info.url);
    await page.waitForURL(`http://127.0.0.1:${info.port}/`);
    await page.locator('#connText', { hasText: 'Live' }).waitFor({ timeout: 10_000 });
    const realUrl = 'https://shop.example/oauth/cb?access_token=abcdefghijklmnopqrstuvwxyz';
    const originalTabs = fake.tabs;
    fake.tabs = () => [{ index: 0, id: 't1', url: realUrl, title: 'Callback', active: true }];
    try {
      getBus().publish({ kind: 'browser', type: 'navigated', data: { tab: 't1', index: 0, url: realUrl } });
      getBus().publish({ kind: 'notice', level: 'info', message: 'after-secret-nav' });
      await page.locator('#activityList li', { hasText: 'after-secret-nav' }).waitFor({ timeout: 10_000 });
      // The timeline copy is masked...
      expect(await page.locator('#activityList').textContent()).not.toContain('abcdefghijklmnopqrstuvwxyz');
      // ...and the URL bar shows the real (authoritative /api/state) URL, never the masked one.
      let seen = '';
      for (let i = 0; i < 80 && seen !== realUrl; i++) {
        seen = await page.locator('#url').inputValue();
        expect(seen).not.toContain('***');
        if (seen !== realUrl) await new Promise(r => setTimeout(r, 50));
      }
      expect(seen).toBe(realUrl);
    } finally {
      fake.tabs = originalTabs;
    }
    expect(pageErrors).toEqual([]);
    await page.close();
  }, 60_000);

  it.skipIf(!chromiumPath)('shows an access message instead of the dashboard without the token', async () => {
    const page = await browser.newPage();
    const r = await page.goto(`http://127.0.0.1:${info.port}/`);
    expect(r.status()).toBe(401);
    expect(await page.textContent('body')).toContain('Access denied');
    await page.close();
  }, 30_000);
});
