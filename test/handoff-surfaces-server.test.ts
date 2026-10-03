/**
 * H2 hand-off surfaces — control center side: the scoped short-TTL hand-off link
 * (`/?h=<token>&handoff=<id>`), its routes, its expiry, its hashed storage, and the
 * rule that the token never reaches logs or the bus.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  startControlCenter,
  stopControlCenter,
  mintHandoffLink,
  authenticateRequest,
  stripTokenFromUrl,
  maskSecrets,
  looksLikeControlLink,
  handoffCookieName,
  busEventJson,
  validateHumanInput,
  type ControlCenterInfo,
} from '../src/control/server.js';
import {
  getHandoffLinks,
  hashHandoffToken,
  HandoffLinkStore,
  handoffMetaOf,
  handoffOwner,
  handoffIdOfOwner,
  isHandoffActive,
  answerHandoff,
  handoffForPrompt,
  handoffOutcomeOf,
  noteHandoffBusEvent,
  lastHandoffOutcome,
  localHandoffUrl,
  handoffTerminalHint,
  maskHandoffTokens,
  clampLinkTtlMs,
} from '../src/control/handoff.js';
import { getBus } from '../src/control/bus.js';
import { getApprovalBroker, type ApprovalResult } from '../src/control/approvals.js';
import { logger } from '../src/utils/logger.js';
import {
  setBrowserManagerForTests,
  type BrowserManager,
  type BrowserStatus,
  type HumanInputEvent,
  type ScreencastFrame,
  type TabInfo,
} from '../src/tools/browser/types.js';

const TOKEN = 'owner-token-0123456789abcdef';

class FakeBrowser implements BrowserManager {
  running = true;
  takeover = false;
  takeoverBy?: string;
  inputs: HumanInputEvent[] = [];
  released = 0;
  tabUrls: string[] = ['https://shop.example/checkout?session=s3cret-value'];
  cookies: Array<{ name: string; value: string }> = [];
  cleared: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  async ensure(): Promise<void> {}
  isRunning(): boolean { return this.running; }
  status(): BrowserStatus {
    return {
      running: this.running, mode: 'launch', headless: true, profile: 'test',
      tabs: this.tabs(), takeover: this.takeover, takeoverBy: this.takeoverBy, downloadsDir: '/tmp/x',
    };
  }
  async activePage(): Promise<any> { return {}; }
  context(): any {
    return {
      pages: () => [],
      cookies: async () => this.cookies,
      clearCookies: async (o: { name: string }) => { this.cleared.push(o.name); this.cookies = this.cookies.filter(c => c.name !== o.name); },
    };
  }
  tabs(): TabInfo[] { return this.tabUrls.map((url, i) => ({ index: i, id: `t${i}`, url, title: 'Checkout', active: i === 0 })); }
  async newTab(): Promise<TabInfo> { throw new Error('no'); }
  async switchTab(): Promise<TabInfo> { throw new Error('no'); }
  async closeTab(): Promise<void> {}
  async close(): Promise<void> {}
  async restart(): Promise<void> {}
  async startScreencast(onFrame: (f: ScreencastFrame) => void): Promise<() => Promise<void>> {
    this.timer = setInterval(() => onFrame({ data: Buffer.from('jpeg').toString('base64'), width: 640, height: 400, ts: Date.now() }), 20);
    return async () => { if (this.timer) clearInterval(this.timer); this.timer = null; };
  }
  async screenshotJpeg(): Promise<Buffer> { return Buffer.from([0xff, 0xd8, 0xff, 0xd9]); }
  setTakeover(on: boolean, by?: string): void { this.takeover = on; this.takeoverBy = on ? by : undefined; }
  isTakeover(): boolean { return this.takeover; }
  async waitForTakeoverEnd(): Promise<void> {}
  async dispatchInput(ev: HumanInputEvent): Promise<void> { this.inputs.push(ev); }
  async releaseHumanMouse(): Promise<void> { this.released++; }
  async locator(): Promise<any> { throw new Error('no'); }
  activeUrl(): string { return this.tabUrls[0] ?? ''; }
  async describeRef(): Promise<null> { return null; }
  async describeSelector(): Promise<null> { return null; }
  onAction(): () => void { return () => {}; }
  recordAction(): void {}
  dispose(): void { if (this.timer) clearInterval(this.timer); }
}

let info: ControlCenterInfo;
let base: string;
let fake: FakeBrowser;
const logged: string[] = [];

/** Raise a hand-off the way the browser's HandoffController does. */
function raiseHandoff(id = 'ho_abc123', opts: { takeover?: boolean; timeoutMs?: number } = {}): Promise<ApprovalResult> {
  if (opts.takeover !== false) fake.setTakeover(true, handoffOwner(id));
  return getApprovalBroker().request({
    prompt: 'A bot check (Cloudflare Turnstile) on shop.example needs you. Solve it — QodeX continues by itself.',
    options: ['done', 'cancel'],
    source: 'browser',
    category: 'challenge',
    risk: 'medium',
    timeoutMs: opts.timeoutMs ?? 60_000,
    meta: { handoff: { id, host: 'shop.example', vendor: 'turnstile', state: 'needs-human', tabIndex: 0, frameBox: { x: 100, y: 200, width: 300, height: 65 }, linkTtlSec: 600 } },
  });
}

function tokenOf(url: string): string {
  return new URL(url).searchParams.get('h') ?? '';
}

async function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(base + path, { headers, redirect: 'manual' });
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), redirect: 'manual' });
}

beforeEach(async () => {
  await stopControlCenter();
  getBus().reset();
  getApprovalBroker().reset();
  fake = new FakeBrowser();
  setBrowserManagerForTests(fake);
  logged.length = 0;
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    vi.spyOn(logger, level).mockImplementation((msg: string, meta?: Record<string, unknown>) => { logged.push(`${msg} ${JSON.stringify(meta ?? {})}`); });
  }
  info = await startControlCenter({ port: 0, token: TOKEN });
  base = `http://127.0.0.1:${info.port}`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await stopControlCenter();
  fake.dispose();
  setBrowserManagerForTests(null);
  getApprovalBroker().reset();
  getBus().reset();
});

describe('hand-off link — minting and storage', () => {
  it('mints only for a running hand-off and only while a control center runs', async () => {
    expect(await mintHandoffLink('ho_nothere', 60_000)).toBeNull();
    const pending = raiseHandoff();
    const link = await mintHandoffLink('ho_abc123', 600_000);
    expect(link).not.toBeNull();
    expect(link!.base).toBe('loopback');
    expect(link!.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${info.port}/\\?h=[A-Za-z0-9_-]{43}&handoff=ho_abc123$`));
    expect(link!.plainUrl).toBe(`http://127.0.0.1:${info.port}/?handoff=ho_abc123`);
    expect(link!.expiresAt - Date.now()).toBeLessThanOrEqual(600_000);
    await stopControlCenter();
    expect(await mintHandoffLink('ho_abc123', 60_000)).toBeNull();
    getApprovalBroker().cancel(getApprovalBroker().pending()[0]!.id);
    await pending;
  });

  it('stores only the sha256 of the token, never the token', async () => {
    const pending = raiseHandoff();
    const link = (await mintHandoffLink('ho_abc123', 600_000))!;
    const token = tokenOf(link.url);
    const keys = getHandoffLinks().storedKeysForTests();
    expect(keys).toContain(hashHandoffToken(token));
    expect(keys.join(' ')).not.toContain(token);
    expect(JSON.stringify(getHandoffLinks())).not.toContain(token);
    // A plain store keeps the same rule.
    const s = new HandoffLinkStore();
    const m = s.mint('x1', 60_000, 1000);
    expect(s.storedKeysForTests()).toEqual([hashHandoffToken(m.token)]);
    getApprovalBroker().cancel(getApprovalBroker().pending()[0]!.id);
    await pending;
  });

  it('expires at its TTL and dies when the hand-off ends', () => {
    const s = new HandoffLinkStore();
    let active = true;
    const { token, expiresAt } = s.mint('ho_1', 30_000, 1_000);
    expect(expiresAt).toBe(31_000);
    expect(s.lookup(token, () => active, 2_000)).toEqual({ status: 'active', handoffId: 'ho_1', expiresAt: 31_000 });
    active = false;
    expect(s.lookup(token, () => active, 2_000).status).toBe('ended');
    active = true;
    expect(s.lookup(token, () => active, 31_000).status).toBe('expired');
    // expired tokens are dropped by prune (and never open anything meanwhile)
    s.prune(31_001);
    expect(s.lookup(token, () => true, 31_001).status).toBe('unknown');
    expect(s.lookup('not-a-token', () => true).status).toBe('unknown');
    // TTL is clamped to 15s … 24h
    expect(clampLinkTtlMs(1)).toBe(15_000);
    expect(clampLinkTtlMs(10 * 24 * 3600_000)).toBe(24 * 3600_000);
    expect(clampLinkTtlMs(undefined)).toBe(600_000);
    // revocation
    const b = s.mint('ho_2', 60_000, 1_000);
    expect(s.revokeToken(b.token)).toBe(true);
    expect(s.lookup(b.token, () => true, 1_500).status).toBe('unknown');
    s.mint('ho_3', 60_000, 1_000); s.mint('ho_3', 60_000, 1_000);
    expect(s.revokeHandoff('ho_3')).toBe(2);
  });
});

describe('hand-off link — routes', () => {
  async function login(): Promise<{ token: string; cookie: string; pending: Promise<ApprovalResult> }> {
    const pending = raiseHandoff();
    const link = (await mintHandoffLink('ho_abc123', 600_000))!;
    const token = tokenOf(link.url);
    const res = await get(`/?h=${token}&handoff=ho_abc123`, { accept: 'text/html' });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${handoffCookieName(info.port)}=${token}`);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    const maxAge = Number(/Max-Age=(\d+)/.exec(setCookie)?.[1]);
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(600);
    const html = await res.text();
    // The bounce keeps ?handoff= but drops the token from the address bar.
    expect(html).toContain('location.replace("/?handoff=ho_abc123")');
    expect(html).not.toContain(token);
    return { token, cookie: `${handoffCookieName(info.port)}=${token}`, pending };
  }

  it('opens the dashboard in scoped hand-off mode', async () => {
    const { cookie, pending } = await login();
    const res = await get('/?handoff=ho_abc123', { cookie, accept: 'text/html' });
    expect(res.status).toBe(200);
    const html = await res.text();
    const boot = JSON.parse(/<script id="qx-boot" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1]!);
    expect(boot.handoff).toEqual({ id: 'ho_abc123', scoped: true });
    getApprovalBroker().cancel(getApprovalBroker().pending()[0]!.id);
    await pending;
  });

  it('serves only the live view of this hand-off', async () => {
    const { cookie, pending } = await login();
    const st = await get('/api/state', { cookie });
    expect(st.status).toBe(200);
    const j = await st.json() as Record<string, any>;
    expect(j.scoped).toBe(true);
    expect(j.approvals).toBeUndefined();
    expect(j.missions).toBeUndefined();
    expect(j.recent).toBeUndefined();
    expect(j.actions).toBeUndefined();
    expect(j.handoff.id).toBe('ho_abc123');
    expect(j.handoff.active).toBe(true);
    expect(j.handoff.meta.frameBox).toEqual({ x: 100, y: 200, width: 300, height: 65 });
    // only the active tab, without its query string
    expect(j.browser.tabs).toEqual([{ index: 0, id: 't0', url: 'https://shop.example/checkout', title: 'Checkout', active: true }]);
    expect(JSON.stringify(j)).not.toContain('s3cret-value');
    expect(j.browser.downloadsDir).toBeUndefined();

    expect((await get('/api/frame.jpg', { cookie })).status).toBe(200);
    const ac = new AbortController();
    const frames = await fetch(base + '/api/frames', { headers: { cookie, accept: 'text/event-stream' }, signal: ac.signal });
    expect(frames.status).toBe(200);
    ac.abort();

    // Never approvals, actions, missions, steering, stop, events or the vault.
    const ap = getApprovalBroker().pending()[0]!;
    for (const [method, path] of [
      ['GET', '/api/events'], ['GET', '/api/actions'], ['POST', '/api/steer'], ['POST', '/api/stop'],
      ['POST', `/api/approvals/${ap.id}`], ['POST', '/api/actions/missions.list'], ['GET', '/api/vault'],
      ['POST', '/api/secrets/x'], ['POST', '/api/vault/add'],
    ] as const) {
      const r = method === 'GET' ? await get(path, { cookie }) : await post(path, { answer: 'done', note: 'x', all: true }, { cookie });
      expect(r.status, `${method} ${path}`).toBe(403);
      expect((await r.json() as { error: string }).error).toMatch(/^\[HANDOFF_SCOPE\]/);
    }
    // The approval is untouched by those attempts.
    expect(getApprovalBroker().get(ap.id)).toBeDefined();
    getApprovalBroker().cancel(ap.id);
    await pending;
  });

  it('relays input only while this hand-off holds the browser; never navigation', async () => {
    const { cookie, pending } = await login();
    const ok = await post('/api/input', { type: 'down', x: 10, y: 20, frameWidth: 640, frameHeight: 400 }, { cookie });
    expect(ok.status).toBe(200);
    expect((await post('/api/input', { type: 'move', x: 30, y: 20 }, { cookie })).status).toBe(200);
    expect((await post('/api/input', { type: 'up', x: 40, y: 20 }, { cookie })).status).toBe(200);
    expect(fake.inputs.map(e => e.type)).toEqual(['down', 'move', 'up']);
    for (const ev of [{ type: 'navigate', url: 'https://evil.example/' }, { type: 'back' }, { type: 'forward' }]) {
      const r = await post('/api/input', ev, { cookie });
      expect(r.status).toBe(403);
    }
    expect((await post('/api/input', { type: 'reload' }, { cookie })).status).toBe(200);
    // Someone else (the owner) holds the browser now → the link can't drive it.
    fake.setTakeover(true, 'control');
    expect((await post('/api/input', { type: 'click', x: 1, y: 1 }, { cookie })).status).toBe(409);
    fake.setTakeover(true, handoffOwner('ho_abc123'));
    getApprovalBroker().cancel(getApprovalBroker().pending()[0]!.id);
    await pending;
  });

  it('hand-back from the link means "done"; it never releases or steals the takeover', async () => {
    const { cookie, pending } = await login();
    // owner holds it meanwhile: the link can't take it over
    fake.setTakeover(true, 'control');
    expect((await post('/api/takeover', { on: true }, { cookie })).status).toBe(409);
    expect(fake.takeoverBy).toBe('control');
    fake.setTakeover(true, handoffOwner('ho_abc123'));
    const r = await post('/api/takeover', { on: false }, { cookie });
    expect(r.status).toBe(200);
    expect(await pending).toEqual({ answer: 'done', by: 'control' });
    // still held by the hand-off (the controller re-checks and releases it itself)
    expect(fake.takeoverBy).toBe(handoffOwner('ho_abc123'));
    // …so the link keeps working through the re-check gap
    expect((await get('/api/state', { cookie })).status).toBe(200);
  });

  it('answers its own hand-off only', async () => {
    const { cookie, pending } = await login();
    expect((await post('/api/handoff/ho_other', { answer: 'cancel' }, { cookie })).status).toBe(403);
    expect((await post('/api/handoff/ho_abc123', { answer: 'maybe' }, { cookie })).status).toBe(400);
    expect((await post('/api/handoff/ho_abc123', { answer: 'cancel' }, { cookie })).status).toBe(200);
    expect(await pending).toEqual({ answer: 'cancel', by: 'control' });
  });

  it('is refused (410, outcome) once the hand-off ended, and its cookie is cleared', async () => {
    const { cookie, token, pending } = await login();
    const ap = getApprovalBroker().pending()[0]!;
    // The controller saw the check disappear: auto-resume.
    expect(getApprovalBroker().resolve(ap.id, 'done', 'challenge-cleared')).toBe(true);
    await pending;
    fake.setTakeover(false);
    const r = await get('/api/state', { cookie });
    expect(r.status).toBe(410);
    expect(await r.json()).toMatchObject({ ok: false, outcome: 'cleared' });
    expect(r.headers.get('set-cookie')).toMatch(new RegExp(`${handoffCookieName(info.port)}=;.*Max-Age=0`));
    const page = await get(`/?h=${token}`, { accept: 'text/html' });
    expect(page.status).toBe(410);
    expect(await page.text()).toContain('cleared');
    expect((await post('/api/input', { type: 'click', x: 1, y: 1 }, { cookie })).status).toBe(410);
  });

  it('expires at its TTL even while the hand-off still runs', async () => {
    const pending = raiseHandoff();
    const link = (await mintHandoffLink('ho_abc123', 20_000))!;
    const token = tokenOf(link.url);
    const cookie = `${handoffCookieName(info.port)}=${token}`;
    expect((await get('/api/state', { cookie })).status).toBe(200);
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 21_000);
    const r = await get('/api/state', { cookie });
    spy.mockRestore();
    expect(r.status).toBe(410);
    expect((await get('/api/state', { cookie })).status).toBe(401);
    getApprovalBroker().cancel(getApprovalBroker().pending()[0]!.id);
    await pending;
  });

  it('a wrong or random token opens nothing', async () => {
    const pending = raiseHandoff();
    await mintHandoffLink('ho_abc123', 600_000);
    const fakeToken = 'A'.repeat(43);
    expect((await get(`/api/state?h=${fakeToken}`)).status).toBe(401);
    expect((await get('/api/state', { cookie: `${handoffCookieName(info.port)}=${fakeToken}` })).status).toBe(401);
    // The owner's cookie name does not accept a hand-off token either.
    getApprovalBroker().cancel(getApprovalBroker().pending()[0]!.id);
    await pending;
  });

  it('the agent\'s own browser is refused even with a hand-off link, and its hand-off cookie is swept', async () => {
    const pending = raiseHandoff();
    const link = (await mintHandoffLink('ho_abc123', 600_000))!;
    const token = tokenOf(link.url);
    fake.cookies = [{ name: handoffCookieName(info.port), value: token }, { name: 'session', value: 'x' }];
    const r = await get(`/?h=${token}&handoff=ho_abc123`);
    expect([200, 302]).toContain(r.status);
    await new Promise(res => setTimeout(res, 1800));
    expect(fake.cleared).toContain(handoffCookieName(info.port));
    expect(fake.cleared).not.toContain('session');
    fake.tabUrls = [`http://127.0.0.1:${info.port}/?handoff=ho_abc123`];
    const refused = await get('/api/state', { cookie: `${handoffCookieName(info.port)}=${token}` });
    expect(refused.status).toBe(403);
    getApprovalBroker().cancel(getApprovalBroker().pending()[0]!.id);
    await pending;
  });
});

describe('owner takeover never overwrites a hand-off', () => {
  const bearer = { authorization: `Bearer ${TOKEN}` };

  it('{on:true} keeps the hand-off owner; {on:false} answers "done" without releasing', async () => {
    const pending = raiseHandoff();
    const on = await post('/api/takeover', { on: true }, bearer);
    expect(on.status).toBe(200);
    expect(fake.takeoverBy).toBe(handoffOwner('ho_abc123'));
    const off = await post('/api/takeover', { on: false }, bearer);
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ ok: true, takeover: true, handoff: { id: 'ho_abc123', answered: true } });
    expect(await pending).toEqual({ answer: 'done', by: 'control' });
    expect(fake.takeoverBy).toBe(handoffOwner('ho_abc123'));
  });

  it('the owner can answer any hand-off and sees it in /api/state?handoff=', async () => {
    const pending = raiseHandoff();
    const st = await (await get('/api/state?recent=0&handoff=ho_abc123', bearer)).json() as Record<string, any>;
    expect(st.handoff).toMatchObject({ id: 'ho_abc123', active: true, pending: true });
    expect(Array.isArray(st.approvals)).toBe(true);
    expect((await post('/api/handoff/ho_abc123', { answer: 'cancel' }, bearer)).status).toBe(200);
    expect(await pending).toEqual({ answer: 'cancel', by: 'control' });
    fake.setTakeover(false);
    expect((await post('/api/handoff/ho_abc123', { answer: 'done' }, bearer)).status).toBe(404);
  });

  it('a takeover that ends releases a mouse button the human still held', async () => {
    fake.setTakeover(true, 'control');
    getBus().publish({ kind: 'browser', type: 'takeover', data: { on: false, by: 'control' } });
    await new Promise(r => setTimeout(r, 10));
    expect(fake.released).toBe(1);
  });
});

describe('hand-off token never reaches logs, the bus or masked text', () => {
  it('keeps the token out of logs and bus events across a whole hand-off', async () => {
    const pending = raiseHandoff();
    const link = (await mintHandoffLink('ho_abc123', 600_000))!;
    const token = tokenOf(link.url);
    const cookie = `${handoffCookieName(info.port)}=${token}`;
    await get(`/?h=${token}&handoff=ho_abc123`, { accept: 'text/html' });
    await get('/api/state', { cookie });
    await post('/api/steer', { note: 'x' }, { cookie });
    await post('/api/input', { type: 'down', x: 1, y: 1 }, { cookie });
    await post('/api/input', { type: 'up' }, { cookie });
    await post('/api/handoff/ho_abc123', { answer: 'done' }, { cookie });
    await pending;
    fake.setTakeover(false);
    await get('/api/state', { cookie });
    expect(logged.join('\n')).not.toContain(token);
    const busText = JSON.stringify(getBus().recent(300));
    expect(busText).not.toContain(token);
    // Even a producer that put the link on the bus would not show it to viewers.
    const ev = getBus().publish({ kind: 'notice', level: 'info', message: `open ${link.url}` });
    expect(busEventJson(ev)).not.toContain(token);
    expect(maskSecrets(link.url)).not.toContain(token);
    expect(maskHandoffTokens(link.url)).toContain('h=***');
  });

  it('strips h like k, and treats an h-link as a control link', () => {
    expect(stripTokenFromUrl('/?h=abcdefabcdefabcdefabcdef&handoff=ho_1')).toBe('/?handoff=ho_1');
    expect(stripTokenFromUrl('/?%68=abc&handoff=ho_1&k=x')).toBe('/?handoff=ho_1');
    const t = 'B'.repeat(43);
    expect(looksLikeControlLink(`http://127.0.0.1:7420/?h=${t}&handoff=ho_1`)).toBe(true);
    expect(looksLikeControlLink(`https://abc.trycloudflare.com/?h=${t}`)).toBe(true);
    expect(looksLikeControlLink('https://example.com/?h=short')).toBe(false);
  });

  it('authenticateRequest: the full token wins; a hand-off token is scoped', () => {
    const t = 'C'.repeat(43);
    const resolve = (c: string) => (c === t ? 'ho_9' : null);
    expect(authenticateRequest(TOKEN, 7420, { url: `/?h=${t}`, headers: {} }, resolve)).toEqual({ ok: true, via: 'handoff', handoffId: 'ho_9', from: 'query' });
    expect(authenticateRequest(TOKEN, 7420, { url: '/', headers: { cookie: `qx_ho_7420=${t}` } }, resolve)).toEqual({ ok: true, via: 'handoff', handoffId: 'ho_9', from: 'cookie' });
    expect(authenticateRequest(TOKEN, 7420, { url: `/?h=${t}`, headers: { authorization: `Bearer ${TOKEN}` } }, resolve)).toEqual({ ok: true, via: 'bearer' });
    // without the resolver (old callers) a hand-off token is nothing
    expect(authenticateRequest(TOKEN, 7420, { url: `/?h=${t}`, headers: {} })).toEqual({ ok: false });
    // another port's hand-off cookie is not ours
    expect(authenticateRequest(TOKEN, 7420, { url: '/', headers: { cookie: `qx_ho_7421=${t}` } }, resolve)).toEqual({ ok: false });
  });
});

describe('human press-and-hold input validation', () => {
  it('accepts down / move / up and copies only known fields', () => {
    expect(validateHumanInput({ type: 'down', x: 5, y: 6, button: 'left', frameWidth: 640, frameHeight: 400, extra: 1 }))
      .toEqual({ ok: true, event: { type: 'down', x: 5, y: 6, button: 'left', frameWidth: 640, frameHeight: 400 } });
    expect(validateHumanInput({ type: 'up' })).toEqual({ ok: true, event: { type: 'up' } });
    expect(validateHumanInput({ type: 'up', x: 7, y: 8, junk: 'x' })).toEqual({ ok: true, event: { type: 'up', x: 7, y: 8 } });
    expect(validateHumanInput({ type: 'move', x: 1, y: 2 })).toEqual({ ok: true, event: { type: 'move', x: 1, y: 2 } });
  });

  it('rejects malformed down / up', () => {
    for (const bad of [
      { type: 'down' }, { type: 'down', x: -1, y: 0 }, { type: 'down', x: 1, y: 1, button: 'side' },
      { type: 'down', x: 1, y: 1, frameWidth: 0 }, { type: 'up', x: 1 }, { type: 'up', x: 'a', y: 1 },
      { type: 'up', button: 'back' }, { type: 'drag', x: 1, y: 1 },
    ]) {
      expect(validateHumanInput(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('hand-off helpers', () => {
  it('validates meta.handoff and drops unknown fields', () => {
    expect(handoffMetaOf({ handoff: { id: 'ho_1', host: 'a.example', vendor: 'hcaptcha', frameBox: { x: 1, y: 2, w: 30, h: 40 }, tabIndex: 2, secret: 'x' } }))
      .toEqual({ id: 'ho_1', host: 'a.example', vendor: 'hcaptcha', frameBox: { x: 1, y: 2, width: 30, height: 40 }, tabIndex: 2 });
    expect(handoffMetaOf({ handoff: { id: '../x' } })).toBeNull();
    expect(handoffMetaOf({ handoff: { id: 'ok', frameBox: { x: 1, y: 2, width: -1, height: 3 } } })).toEqual({ id: 'ok' });
    expect(handoffMetaOf({ kind: 'permission' })).toBeNull();
    expect(handoffIdOfOwner('handoff:ho_1')).toBe('ho_1');
    expect(handoffIdOfOwner('control')).toBeNull();
  });

  it('is active while its approval is pending or its takeover is held', async () => {
    const pending = raiseHandoff('ho_7', { takeover: false });
    expect(isHandoffActive('ho_7')).toBe(true);
    const found = handoffForPrompt(getApprovalBroker().pending()[0]!.prompt, ['done', 'cancel']);
    expect(found?.handoff.id).toBe('ho_7');
    expect(answerHandoff('ho_7', 'done', 'control')).toBe(true);
    expect(await pending).toEqual({ answer: 'done', by: 'control' });
    expect(isHandoffActive('ho_7')).toBe(false);
    fake.setTakeover(true, handoffOwner('ho_7'));
    expect(isHandoffActive('ho_7')).toBe(true);
    expect(answerHandoff('ho_7', 'done', 'control')).toBe(false); // nothing pending (re-check gap)
  });

  it('remembers outcomes from the bus', () => {
    noteHandoffBusEvent({ kind: 'approval.requested', id: 'ap_1', prompt: 'p', options: ['done', 'cancel'], meta: { handoff: { id: 'ho_out' } }, ts: 1 });
    noteHandoffBusEvent({ kind: 'approval.resolved', id: 'ap_1', answer: 'done', by: 'challenge-cleared', ts: 2 });
    expect(lastHandoffOutcome('ho_out')).toBe('cleared');
    expect(handoffOutcomeOf({ answer: 'cancel', by: 'timeout' })).toBe('timeout');
    expect(handoffOutcomeOf({ answer: 'cancel', by: 'telegram' })).toBe('cancelled');
    expect(handoffOutcomeOf({ answer: 'cancel', by: 'abort' })).toBe('stopped');
  });

  it('terminal hint: local URL with ?handoff, en + fa', () => {
    const url = localHandoffUrl('ho_abc123');
    expect(url).toBe(`${info.url}&handoff=ho_abc123`);
    const en = handoffTerminalHint({ id: 'ho_abc123' }, 'en', url);
    expect(en[0]).toMatch(/QodeX continues automatically/);
    expect(en.join('\n')).toContain(url!);
    const fa = handoffTerminalHint({ id: 'ho_abc123' }, 'fa', null);
    expect(fa.join('\n')).toContain('/control');
  });
});
