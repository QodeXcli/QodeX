import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as net from 'node:net';
import { request as httpRequest } from 'node:http';
import {
  startControlCenter,
  stopControlCenter,
  getControlCenter,
  registerControlAction,
  listControlActions,
  runControlAction,
  setTunnelStarterForTests,
  validateHumanInput,
  normalizeNavigateUrl,
  authenticateRequest,
  originAllowed,
  stripTokenFromUrl,
  parseCookies,
  safeDecode,
  tokenMatches,
  busEventJson,
  agentEventToBus,
  publishAgentEvent,
  maskSecrets,
  controlCookieName,
  looksLikeControlLink,
  MAX_BODY_BYTES,
  type ControlCenterInfo,
} from '../src/control/server.js';
import { getBus } from '../src/control/bus.js';
import { getApprovalBroker } from '../src/control/approvals.js';
import {
  setBrowserManagerForTests,
  type BrowserManager,
  type BrowserStatus,
  type HumanInputEvent,
  type ScreencastFrame,
  type TabInfo,
} from '../src/tools/browser/types.js';

const TOKEN = 'test-token-0123456789abcdef';

// ── fakes / helpers ──────────────────────────────────────────────────────────

class FakeBrowser implements BrowserManager {
  running = true;
  takeover = false;
  takeoverBy?: string;
  inputs: HumanInputEvent[] = [];
  screencasts = 0;
  stops = 0;
  lastOpts: { quality?: number; maxFps?: number } | undefined;
  frameData = Buffer.from('fake-jpeg').toString('base64');
  /** URLs of the agent browser's tabs (the first is active). */
  tabUrls: string[] = ['https://example.test/'];
  private timer: NodeJS.Timeout | null = null;

  async ensure(): Promise<void> { this.running = true; }
  isRunning(): boolean { return this.running; }
  status(): BrowserStatus {
    return {
      running: this.running,
      mode: this.running ? 'launch' : 'none',
      headless: true,
      profile: 'test',
      tabs: this.tabs(),
      takeover: this.takeover,
      takeoverBy: this.takeoverBy,
      downloadsDir: '/tmp/qx-downloads',
    };
  }
  async activePage(): Promise<any> { return {}; }
  context(): any { return null; }
  tabs(): TabInfo[] {
    return this.running ? this.tabUrls.map((url, i) => ({ index: i, id: `t${i + 1}`, url, title: 'Example', active: i === 0 })) : [];
  }
  async newTab(): Promise<TabInfo> { throw new Error('not supported'); }
  async switchTab(): Promise<TabInfo> { throw new Error('not supported'); }
  async closeTab(): Promise<void> {}
  async close(): Promise<void> { this.running = false; }
  async restart(): Promise<void> {}
  async startScreencast(onFrame: (f: ScreencastFrame) => void, opts?: { quality?: number; maxFps?: number }): Promise<() => Promise<void>> {
    this.screencasts++;
    this.lastOpts = opts;
    this.timer = setInterval(() => onFrame({ data: this.frameData, width: 640, height: 400, ts: Date.now() }), 15);
    return async () => {
      this.stops++;
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
    };
  }
  async screenshotJpeg(): Promise<Buffer> { return Buffer.from([0xff, 0xd8, 0xff, 0xd9]); }
  setTakeover(on: boolean, by?: string): void { this.takeover = on; this.takeoverBy = on ? by : undefined; }
  isTakeover(): boolean { return this.takeover; }
  async waitForTakeoverEnd(): Promise<void> {}
  async dispatchInput(ev: HumanInputEvent): Promise<void> {
    if (ev.type === 'navigate') this.running = true;
    this.inputs.push(ev);
  }
  async locator(): Promise<any> { throw new Error('not supported'); }
  activeUrl(): string { return this.running ? 'https://example.test/' : ''; }
  async describeRef(): Promise<null> { return null; }
  async describeSelector(): Promise<null> { return null; }
  onAction(): () => void { return () => {}; }
  recordAction(): void {}
  dispose(): void { if (this.timer) clearInterval(this.timer); }
}

async function waitUntil(fn: () => boolean, ms = 4000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await new Promise(r => setTimeout(r, 15));
  }
  return fn();
}

interface SseEvent { event: string; data: string }
interface SseHandle { status: number; events: SseEvent[]; close: () => void; of: (name: string) => SseEvent[] }

async function openSse(url: string, headers: Record<string, string> = {}): Promise<SseHandle> {
  const ac = new AbortController();
  const res = await fetch(url, { headers: { accept: 'text/event-stream', ...headers }, signal: ac.signal });
  const events: SseEvent[] = [];
  if (res.body) {
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
  }
  return { status: res.status, events, close: () => ac.abort(), of: (name) => events.filter(e => e.event === name) };
}

let info: ControlCenterInfo;
let base: string;
let steered: string[];
let steerResult: boolean;
const bearer = { authorization: `Bearer ${TOKEN}` };
const json = { 'content-type': 'application/json' };
const extraUnregister: Array<() => void> = [];
const fakes: FakeBrowser[] = [];

function fake(): FakeBrowser {
  const f = new FakeBrowser();
  fakes.push(f);
  setBrowserManagerForTests(f);
  return f;
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(base + path, { method: 'POST', headers: { ...bearer, ...json, ...headers }, body: JSON.stringify(body) });
}

beforeEach(async () => {
  await stopControlCenter();
  getBus().reset();
  getApprovalBroker().reset();
  setBrowserManagerForTests(null);
  setTunnelStarterForTests(null);
  steered = [];
  steerResult = true;
  info = await startControlCenter({
    port: 0,
    token: TOKEN,
    onSteer: (note) => { steered.push(note); return steerResult; },
  });
  base = `http://127.0.0.1:${info.port}`;
});

afterEach(async () => {
  await stopControlCenter();
  while (extraUnregister.length) extraUnregister.pop()!();
  for (const f of fakes.splice(0)) f.dispose();
  setBrowserManagerForTests(null);
  setTunnelStarterForTests(null);
  getApprovalBroker().reset();
  getBus().reset();
});

// ── auth ─────────────────────────────────────────────────────────────────────

describe('control center — authentication', () => {
  it('reports a token-bearing loopback URL', () => {
    expect(info.url).toBe(`http://127.0.0.1:${info.port}/?k=${TOKEN}`);
    expect(info.urls[0]).toBe(info.url);
    expect(info.token).toBe(TOKEN);
    expect(info.port).toBeGreaterThan(0);
  });

  it('rejects requests without (or with a wrong) token, even on loopback', async () => {
    const r1 = await fetch(`${base}/api/state`);
    expect(r1.status).toBe(401);
    const j1 = await r1.json() as { error: string };
    expect(j1.error).toMatch(/^\[UNAUTHORIZED\]/);
    const r2 = await fetch(`${base}/api/state?k=wrong-token-wrong-token`);
    expect(r2.status).toBe(401);
    const r3 = await fetch(`${base}/`, { headers: { accept: 'text/html' } });
    expect(r3.status).toBe(401);
    const html = await r3.text();
    expect(html).toContain('Access denied');
    expect(html).not.toContain(TOKEN);
    const r4 = await fetch(`${base}/api/events`);
    expect(r4.status).toBe(401);
    const r5 = await fetch(`${base}/api/steer`, { method: 'POST', headers: json, body: '{"note":"x"}' });
    expect(r5.status).toBe(401);
    expect(steered).toEqual([]);
  });

  it('?k= sets an HttpOnly SameSite=Strict cookie and redirects to strip the token', async () => {
    const r = await fetch(`${base}/?k=${TOKEN}&lang=fa`, { redirect: 'manual' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/?lang=fa');
    const cookie = r.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`${controlCookieName(info.port)}=${TOKEN}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\//);

    // The cookie alone now authorizes.
    const pair = cookie.split(';')[0];
    const s = await fetch(`${base}/api/state`, { headers: { cookie: pair } });
    expect(s.status).toBe(200);
    const page = await fetch(`${base}/`, { headers: { cookie: pair, accept: 'text/html' } });
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    expect(await page.text()).not.toContain(TOKEN);
  });

  it('browsers get an HTML bounce (same-site follow-up) instead of a 302', async () => {
    const r = await fetch(`${base}/?k=${TOKEN}`, { redirect: 'manual', headers: { accept: 'text/html,application/xhtml+xml' } });
    expect(r.status).toBe(200);
    expect(r.headers.get('set-cookie') ?? '').toMatch(/SameSite=Strict/);
    const body = await r.text();
    expect(body).toContain('location.replace("/")');
    expect(body).not.toContain(TOKEN);
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('never bounces to another origin', async () => {
    const r = await fetch(`${base}//evil.example/x?k=${TOKEN}`, { redirect: 'manual' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/');
    expect(stripTokenFromUrl('/\\evil.example?k=abc')).toBe('/');
    expect(stripTokenFromUrl('http://evil.example/?k=abc')).toBe('/');
    expect(stripTokenFromUrl('/api/state?k=abc&recent=0')).toBe('/api/state?recent=0');
    expect(stripTokenFromUrl('/?k=abc')).toBe('/');
  });

  it('accepts Authorization: Bearer and never echoes the token', async () => {
    const r = await fetch(`${base}/api/state`, { headers: bearer });
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).not.toContain(TOKEN);
    const j = JSON.parse(text) as Record<string, unknown>;
    expect(j).toHaveProperty('browser', null);
    expect(j).toHaveProperty('approvals');
    expect(j).toHaveProperty('recent');
    expect(j).toHaveProperty('actions');
    const wrong = await fetch(`${base}/api/state`, { headers: { authorization: 'Bearer nope-nope-nope-nope' } });
    expect(wrong.status).toBe(401);
  });

  it('survives malformed percent-escapes in the query, cookie and path', async () => {
    const r1 = await fetch(`${base}/?k=%E0%A4%A`);
    expect(r1.status).toBe(401);
    const r2 = await fetch(`${base}/api/state`, { headers: { cookie: `${controlCookieName(info.port)}=%E0%A4%A; ${'qx_ctl'}=%` } });
    expect(r2.status).toBe(401);
    const r3 = await post('/api/approvals/%E0%A4%A', { answer: 'yes' });
    expect(r3.status).toBe(400);
    const r4 = await post('/api/actions/%E0%A4%A', {});
    expect(r4.status).toBe(404);
    // Still alive and serving.
    const ok = await fetch(`${base}/api/state`, { headers: bearer });
    expect(ok.status).toBe(200);
  });

  it('rejects cross-origin writes and requires JSON bodies of at most 64KB', async () => {
    const cross = await post('/api/steer', { note: 'hi' }, { origin: 'http://evil.example' });
    expect(cross.status).toBe(403);
    expect((await cross.json() as { error: string }).error).toMatch(/^\[FORBIDDEN_ORIGIN\]/);
    const crossRef = await post('/api/steer', { note: 'hi' }, { referer: 'http://evil.example/page' });
    expect(crossRef.status).toBe(403);
    const nullOrigin = await post('/api/steer', { note: 'hi' }, { origin: 'null' });
    expect(nullOrigin.status).toBe(403);
    expect(steered).toEqual([]);

    const sameOrigin = await post('/api/steer', { note: 'hello agent' }, { origin: base });
    expect(sameOrigin.status).toBe(200);
    expect(steered).toEqual(['hello agent']);

    const notJson = await fetch(`${base}/api/steer`, { method: 'POST', headers: { ...bearer, 'content-type': 'text/plain' }, body: '{"note":"x"}' });
    expect(notJson.status).toBe(415);
    const form = await fetch(`${base}/api/steer`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/x-www-form-urlencoded' }, body: 'note=x' });
    expect(form.status).toBe(415);

    const big = await post('/api/steer', { note: 'x'.repeat(MAX_BODY_BYTES + 10) });
    expect(big.status).toBe(413);
    const badJson = await fetch(`${base}/api/steer`, { method: 'POST', headers: { ...bearer, ...json }, body: '{nope' });
    expect(badJson.status).toBe(400);
    expect(steered).toEqual(['hello agent']);
  });

  it('answers unknown routes with 404 and wrong methods with 405', async () => {
    expect((await fetch(`${base}/nope`, { headers: bearer })).status).toBe(404);
    expect((await fetch(`${base}/api/steer`, { headers: bearer })).status).toBe(405);
    expect((await post('/api/state', {})).status).toBe(405);
  });
});

// ── events SSE ───────────────────────────────────────────────────────────────

describe('control center — events stream', () => {
  it('sends a hello, recent history, then live bus events', async () => {
    getBus().publish({ kind: 'notice', level: 'info', message: 'before-connect' });
    const sse = await openSse(`${base}/api/events`, bearer);
    expect(sse.status).toBe(200);
    try {
      expect(await waitUntil(() => sse.of('hello').length === 1)).toBe(true);
      expect(await waitUntil(() => sse.of('bus').some(e => e.data.includes('before-connect')))).toBe(true);
      getBus().publish({ kind: 'mission', missionId: 'm-1', type: 'milestone', data: { title: 'Logged in' } });
      expect(await waitUntil(() => sse.of('bus').some(e => e.data.includes('Logged in')))).toBe(true);
      const ev = JSON.parse(sse.of('bus').find(e => e.data.includes('Logged in'))!.data) as { kind: string; missionId: string; ts: number };
      expect(ev.kind).toBe('mission');
      expect(ev.missionId).toBe('m-1');
      expect(typeof ev.ts).toBe('number');
      expect(sse.events.map(e => e.data).join('\n')).not.toContain(TOKEN);
    } finally {
      sse.close();
    }
  });

  it('announces newly registered control actions to open viewers', async () => {
    const sse = await openSse(`${base}/api/events`, bearer);
    try {
      expect(await waitUntil(() => sse.of('hello').length === 1)).toBe(true);
      extraUnregister.push(registerControlAction('missions.list', () => []));
      expect(await waitUntil(() => sse.of('actions').some(e => e.data.includes('missions.list')))).toBe(true);
    } finally {
      sse.close();
    }
  });

  it('truncates oversized events instead of flooding viewers', () => {
    const ev = getBus().publish({ kind: 'agent', source: 'test', type: 'huge', data: { blob: 'x'.repeat(100_000) } });
    const wire = JSON.parse(busEventJson(ev)) as { truncated?: boolean; kind: string; source: string; preview: string };
    expect(wire.truncated).toBe(true);
    expect(wire.kind).toBe('agent');
    expect(wire.source).toBe('test');
    expect(wire.preview.length).toBeLessThanOrEqual(2000);
  });
});

// ── approvals ────────────────────────────────────────────────────────────────

describe('control center — approvals', () => {
  it('registers the control approval channel while running', async () => {
    const broker = getApprovalBroker();
    expect(broker.channelNames()).toContain('control');
    expect(broker.hasRemoteChannel()).toBe(true);
    await stopControlCenter();
    expect(broker.channelNames()).not.toContain('control');
  });

  it('delivers pending approvals over SSE and resolves them via POST', async () => {
    const broker = getApprovalBroker();
    const sse = await openSse(`${base}/api/events`, bearer);
    try {
      expect(await waitUntil(() => sse.of('approvals').length === 1)).toBe(true);
      const pending = broker.request({ prompt: 'Place order for 2 items ($59)?', options: ['yes', 'no'], category: 'purchase', risk: 'critical', source: 'browser_click' });
      expect(await waitUntil(() => sse.of('approval').length === 1)).toBe(true);
      const delivered = JSON.parse(sse.of('approval')[0].data) as { id: string; prompt: string; options: string[]; category: string; risk: string };
      expect(delivered.prompt).toContain('Place order');
      expect(delivered.options).toEqual(['yes', 'no']);
      expect(delivered.risk).toBe('critical');

      const state = await (await fetch(`${base}/api/state`, { headers: bearer })).json() as { approvals: Array<{ id: string }> };
      expect(state.approvals.map(a => a.id)).toEqual([delivered.id]);

      const unknown = await post('/api/approvals/ap_doesnotexist', { answer: 'yes' });
      expect(unknown.status).toBe(404);
      const invalid = await post(`/api/approvals/${delivered.id}`, { answer: 'perhaps later' });
      expect(invalid.status).toBe(400);
      expect(broker.get(delivered.id)).toBeDefined();
      const missing = await post(`/api/approvals/${delivered.id}`, {});
      expect(missing.status).toBe(400);

      const ok = await post(`/api/approvals/${delivered.id}`, { answer: 'approve' });
      expect(ok.status).toBe(200);
      expect(await pending).toEqual({ answer: 'yes', by: 'control' });
      expect(await waitUntil(() => sse.of('approval-retract').length === 1)).toBe(true);
      expect(JSON.parse(sse.of('approval-retract')[0].data)).toMatchObject({ id: delivered.id, answer: 'yes', by: 'control' });

      const again = await post(`/api/approvals/${delivered.id}`, { answer: 'no' });
      expect(again.status).toBe(404);
    } finally {
      sse.close();
    }
  });

  it('shows approvals that were already pending when the viewer connects', async () => {
    const broker = getApprovalBroker();
    const pending = broker.request({ prompt: 'Send the email?', options: ['yes', 'no', 'always'], category: 'send', risk: 'critical' });
    const sse = await openSse(`${base}/api/events`, bearer);
    try {
      expect(await waitUntil(() => sse.of('approvals').length === 1)).toBe(true);
      const list = JSON.parse(sse.of('approvals')[0].data) as Array<{ id: string; prompt: string }>;
      expect(list).toHaveLength(1);
      expect(list[0].prompt).toBe('Send the email?');
      expect((await post(`/api/approvals/${encodeURIComponent(list[0].id)}`, { answer: 'no' })).status).toBe(200);
      expect(await pending).toEqual({ answer: 'no', by: 'control' });
    } finally {
      sse.close();
    }
  });
});

// ── takeover + input ─────────────────────────────────────────────────────────

describe('control center — takeover and human input', () => {
  it('refuses input until the human takes over, then forwards sanitized events', async () => {
    const f = fake();
    const before = await post('/api/input', { type: 'click', x: 10, y: 20 });
    expect(before.status).toBe(409);
    expect((await before.json() as { error: string }).error).toMatch(/^\[TAKEOVER_REQUIRED\]/);
    expect(f.inputs).toEqual([]);

    const on = await post('/api/takeover', { on: true });
    expect(on.status).toBe(200);
    expect(await on.json()).toMatchObject({ ok: true, takeover: true });
    expect(f.takeover).toBe(true);
    expect(f.takeoverBy).toBe('control');

    const click = await post('/api/input', { type: 'click', x: 10, y: 20, frameWidth: 640, frameHeight: 400, clickCount: 2, evil: 'payload' });
    expect(click.status).toBe(200);
    expect(f.inputs[0]).toEqual({ type: 'click', x: 10, y: 20, frameWidth: 640, frameHeight: 400, clickCount: 2 });

    expect((await post('/api/input', { type: 'type', text: 'سلام دنیا' })).status).toBe(200);
    expect((await post('/api/input', { type: 'key', key: 'ControlOrMeta+a' })).status).toBe(200);
    expect((await post('/api/input', { type: 'scroll', dx: 0, dy: 300 })).status).toBe(200);
    expect((await post('/api/input', { type: 'back' })).status).toBe(200);
    expect((await post('/api/input', { type: 'navigate', url: 'example.com/path' })).status).toBe(200);
    expect(f.inputs.slice(1)).toEqual([
      { type: 'type', text: 'سلام دنیا' },
      { type: 'key', key: 'ControlOrMeta+a' },
      { type: 'scroll', dx: 0, dy: 300 },
      { type: 'back' },
      { type: 'navigate', url: 'https://example.com/path' },
    ]);

    for (const bad of [
      { type: 'navigate', url: 'javascript:alert(1)' },
      { type: 'navigate', url: 'file:///etc/passwd' },
      { type: 'click', x: 'a', y: 1 },
      { type: 'teleport' },
      { type: 'key', key: '' },
      { type: 'type', text: '' },
    ]) {
      const r = await post('/api/input', bad);
      expect(r.status).toBe(400);
      expect((await r.json() as { error: string }).error).toMatch(/^\[INVALID_INPUT\]/);
    }
    expect(f.inputs).toHaveLength(6);

    const off = await post('/api/takeover', { on: false });
    expect(await off.json()).toMatchObject({ takeover: false });
    expect((await post('/api/input', { type: 'reload' })).status).toBe(409);
    expect((await post('/api/takeover', { on: 'yes' })).status).toBe(400);
  });

  it('allows opening the browser only through navigate while taken over', async () => {
    const f = fake();
    f.running = false;
    await post('/api/takeover', { on: true });
    const click = await post('/api/input', { type: 'click', x: 1, y: 1 });
    expect(click.status).toBe(409);
    expect((await click.json() as { error: string }).error).toMatch(/^\[BROWSER_NOT_RUNNING\]/);
    const nav = await post('/api/input', { type: 'navigate', url: 'localhost:3000' });
    expect(nav.status).toBe(200);
    expect(f.inputs).toEqual([{ type: 'navigate', url: 'http://localhost:3000/' }]);
    expect(f.running).toBe(true);
  });

  it('reports browser status (incl. takeover) in /api/state and hands control back on stop', async () => {
    const f = fake();
    await post('/api/takeover', { on: true });
    const s = await (await fetch(`${base}/api/state`, { headers: bearer })).json() as { browser: BrowserStatus };
    expect(s.browser.takeover).toBe(true);
    expect(s.browser.tabs[0].url).toBe('https://example.test/');
    await stopControlCenter();
    expect(f.takeover).toBe(false);
  });

  it('surfaces dispatch failures as [INPUT_FAILED]', async () => {
    const f = fake();
    f.dispatchInput = async () => { throw new Error('page crashed'); };
    await post('/api/takeover', { on: true });
    const r = await post('/api/input', { type: 'reload' });
    expect(r.status).toBe(502);
    expect((await r.json() as { error: string }).error).toBe('[INPUT_FAILED] page crashed');
  });
});

// ── frames ───────────────────────────────────────────────────────────────────

describe('control center — live frames', () => {
  it('streams frames while a viewer is connected and stops the screencast after', async () => {
    const f = fake();
    const sse = await openSse(`${base}/api/frames`, bearer);
    try {
      expect(await waitUntil(() => sse.of('frame').length >= 2)).toBe(true);
      const frame = JSON.parse(sse.of('frame')[0].data) as { data: string; w: number; h: number };
      expect(frame).toMatchObject({ data: f.frameData, w: 640, h: 400 });
      expect(f.screencasts).toBe(1);
      expect(f.lastOpts?.quality).toBeGreaterThan(0);
      expect(f.lastOpts?.maxFps).toBeGreaterThan(0);
    } finally {
      sse.close();
    }
    expect(await waitUntil(() => f.stops === 1)).toBe(true);
  });

  it('shares one screencast between viewers', async () => {
    const f = fake();
    const a = await openSse(`${base}/api/frames`, bearer);
    const b = await openSse(`${base}/api/frames`, bearer);
    try {
      expect(await waitUntil(() => a.of('frame').length > 0 && b.of('frame').length > 0)).toBe(true);
      expect(f.screencasts).toBe(1);
      a.close();
      await new Promise(r => setTimeout(r, 100));
      expect(f.stops).toBe(0);
    } finally {
      a.close();
      b.close();
    }
    expect(await waitUntil(() => f.stops === 1)).toBe(true);
  });

  it('sends idle when no browser runs and starts streaming once one launches', async () => {
    const sse = await openSse(`${base}/api/frames`, bearer);
    try {
      expect(await waitUntil(() => sse.of('idle').length >= 1)).toBe(true);
      expect(JSON.parse(sse.of('idle')[0].data)).toEqual({ reason: 'no-browser' });
      const f = fake();
      getBus().publish({ kind: 'browser', type: 'launched', data: { profile: 'test' } });
      expect(await waitUntil(() => sse.of('frame').length > 0)).toBe(true);
      // Browser closes → viewers are told, screencast stopped.
      f.running = false;
      getBus().publish({ kind: 'browser', type: 'closed' });
      expect(await waitUntil(() => sse.of('idle').some(e => e.data.includes('closed')))).toBe(true);
      expect(await waitUntil(() => f.stops === 1)).toBe(true);
    } finally {
      sse.close();
    }
  });

  it('serves a single JPEG snapshot at /api/frame.jpg', async () => {
    const none = await fetch(`${base}/api/frame.jpg`, { headers: bearer });
    expect(none.status).toBe(404);
    fake();
    const r = await fetch(`${base}/api/frame.jpg`, { headers: bearer });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await r.arrayBuffer())).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  });
});

// ── steer + actions ──────────────────────────────────────────────────────────

describe('control center — steer and actions', () => {
  it('delivers steering notes and logs them on the bus', async () => {
    const r = await post('/api/steer', { note: '  use the cheaper shipping option  ' });
    expect(r.status).toBe(200);
    expect(steered).toEqual(['use the cheaper shipping option']);
    expect(getBus().recent(10).some(e => e.kind === 'agent' && e.type === 'steer')).toBe(true);
    expect((await post('/api/steer', { note: '   ' })).status).toBe(400);
    steerResult = false;
    const none = await post('/api/steer', { note: 'anyone?' });
    expect(none.status).toBe(409);
    expect((await none.json() as { error: string }).error).toMatch(/^\[NO_ACTIVE_AGENT\]/);
  });

  it('defaults to the active agent of this process (none here → 409)', async () => {
    await stopControlCenter();
    info = await startControlCenter({ port: 0, token: TOKEN });
    base = `http://127.0.0.1:${info.port}`;
    const r = await post('/api/steer', { note: 'hello?' });
    expect(r.status).toBe(409);
  }, 30_000);

  it('runs registered actions and exposes missions in /api/state', async () => {
    const calls: unknown[] = [];
    extraUnregister.push(registerControlAction('missions.list', (body) => {
      calls.push(body);
      return [{ id: 'm1', goal: 'Book a table for two', status: 'running' }];
    }));
    extraUnregister.push(registerControlAction('missions.cancel', () => { throw new Error('mission not found'); }));
    expect(listControlActions()).toEqual(['missions.cancel', 'missions.list']);

    const list = await (await fetch(`${base}/api/actions`, { headers: bearer })).json() as { actions: string[] };
    expect(list.actions).toEqual(['missions.cancel', 'missions.list']);

    const r = await post('/api/actions/missions.list', { limit: 5 });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, result: [{ id: 'm1', goal: 'Book a table for two', status: 'running' }] });
    expect(calls).toContainEqual({ limit: 5 });

    const s = await (await fetch(`${base}/api/state?recent=0`, { headers: bearer })).json() as { missions: unknown[]; recent: unknown[] };
    expect(s.missions).toHaveLength(1);
    expect(s.recent).toEqual([]);

    const failed = await post('/api/actions/missions.cancel', { id: 'm9' });
    expect(failed.status).toBe(500);
    expect((await failed.json() as { error: string }).error).toBe('[ACTION_FAILED] missions.cancel: mission not found');
    const unknown = await post('/api/actions/missions.start', {});
    expect(unknown.status).toBe(404);

    await expect(runControlAction('missions.list', {})).resolves.toHaveLength(1);
    await expect(runControlAction('nope')).rejects.toThrow(/UNKNOWN_ACTION/);
    expect(() => registerControlAction('bad name!', () => 1)).toThrow(/INVALID_ACTION_NAME/);
  });

  it('unregistering an action removes it (only if it is still the same handler)', () => {
    const off1 = registerControlAction('x.test', () => 1);
    const off2 = registerControlAction('x.test', () => 2);
    off1();
    expect(listControlActions()).toContain('x.test');
    off2();
    expect(listControlActions()).not.toContain('x.test');
  });
});

// ── lifecycle ────────────────────────────────────────────────────────────────

describe('control center — lifecycle', () => {
  it('is a singleton per process', async () => {
    const again = await startControlCenter({ port: 0 });
    expect(again.port).toBe(info.port);
    expect(again.token).toBe(TOKEN);
    expect(getControlCenter()?.port).toBe(info.port);
    expect(await stopControlCenter()).toBe(true);
    expect(await stopControlCenter()).toBe(false);
    expect(getControlCenter()).toBeNull();
  });

  it('falls back to a free port when the requested one is busy', async () => {
    await stopControlCenter();
    const blocker = net.createServer();
    await new Promise<void>(r => blocker.listen(0, '127.0.0.1', () => r()));
    const busy = (blocker.address() as net.AddressInfo).port;
    try {
      const i = await startControlCenter({ port: busy, token: TOKEN });
      expect(i.port).not.toBe(busy);
      expect((await fetch(`http://127.0.0.1:${i.port}/api/state`, { headers: bearer })).status).toBe(200);
    } finally {
      await new Promise<void>(r => blocker.close(() => r()));
    }
  });

  it('adds a tunnel link (token included) and reports tunnel failures softly', async () => {
    let closed = 0;
    setTunnelStarterForTests(async () => ({ url: 'https://quiet-river.trycloudflare.com', close: () => { closed++; } }));
    const withTunnel = await startControlCenter({ tunnel: true });
    expect(withTunnel.tunnelUrl).toBe(`https://quiet-river.trycloudflare.com/?k=${TOKEN}`);
    expect(withTunnel.urls).toContain(withTunnel.tunnelUrl);
    await stopControlCenter();
    expect(closed).toBe(1);

    setTunnelStarterForTests(async () => { throw new Error('cloudflared unavailable'); });
    const failed = await startControlCenter({ port: 0, token: TOKEN, tunnel: true });
    expect(failed.tunnelUrl).toBeUndefined();
    expect(failed.tunnelError).toContain('cloudflared unavailable');
    expect(failed.url).toContain(`?k=${TOKEN}`);
  });

  it('rebinds on all interfaces when LAN access is requested later', async () => {
    const lan = await startControlCenter({ lan: true });
    expect(lan.host).toBe('0.0.0.0');
    expect(lan.lan).toBe(true);
    expect(lan.token).toBe(TOKEN);
    expect(getApprovalBroker().channelNames()).toContain('control');
    const r = await fetch(`http://127.0.0.1:${lan.port}/api/state`, { headers: bearer });
    expect(r.status).toBe(200);
  });

  it('refuses weak tokens', async () => {
    await stopControlCenter();
    await expect(startControlCenter({ port: 0, token: 'short' })).rejects.toThrow(/CONTROL_WEAK_TOKEN/);
    await expect(startControlCenter({ port: 0, token: 'has spaces in it but long enough' })).rejects.toThrow(/CONTROL_WEAK_TOKEN/);
    const gen = await startControlCenter({ port: 0 });
    expect(gen.token).toMatch(/^[A-Za-z0-9_-]{16,}$/);
  });
});

// ── pure helpers ─────────────────────────────────────────────────────────────

describe('control center — pure helpers', () => {
  it('decodes safely and parses cookies', () => {
    expect(safeDecode('%E0%A4%A')).toBeNull();
    expect(safeDecode('a%20b')).toBe('a b');
    expect(safeDecode('a+b', true)).toBe('a b');
    const c = parseCookies('a=1; qx_ctl_7420=tok%2Den; bad=%E0%A4%A; a=2');
    expect(c.get('a')).toBe('1');
    expect(c.get('qx_ctl_7420')).toBe('tok-en');
    expect(c.has('bad')).toBe(false);
  });

  it('compares tokens in constant time over digests', () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches(TOKEN, TOKEN + 'x')).toBe(false);
    expect(tokenMatches(TOKEN, '')).toBe(false);
    expect(tokenMatches(TOKEN, undefined)).toBe(false);
  });

  it('authenticates via query, bearer or the port-specific cookie', () => {
    const h = (headers: Record<string, string>) => headers;
    expect(authenticateRequest(TOKEN, 7420, { url: `/?k=${TOKEN}`, headers: h({}) })).toEqual({ ok: true, via: 'query' });
    expect(authenticateRequest(TOKEN, 7420, { url: '/', headers: h({ authorization: `bearer ${TOKEN}` }) })).toEqual({ ok: true, via: 'bearer' });
    expect(authenticateRequest(TOKEN, 7420, { url: '/', headers: h({ cookie: `qx_ctl_7420=${TOKEN}` }) })).toEqual({ ok: true, via: 'cookie' });
    expect(authenticateRequest(TOKEN, 7420, { url: '/', headers: h({ cookie: `qx_ctl_9999=${TOKEN}` }) })).toEqual({ ok: false });
    expect(authenticateRequest(TOKEN, 7420, { url: '/?k=%E0%A4%A', headers: h({}) })).toEqual({ ok: false });
  });

  it('checks Origin/Referer against Host (and a tunnel X-Forwarded-Host)', () => {
    expect(originAllowed({ host: '127.0.0.1:7420' })).toBe(true);
    expect(originAllowed({ host: '127.0.0.1:7420', origin: 'http://127.0.0.1:7420' })).toBe(true);
    expect(originAllowed({ host: '127.0.0.1:7420', origin: 'http://localhost:7420' })).toBe(false);
    expect(originAllowed({ host: 'abc.trycloudflare.com', origin: 'https://abc.trycloudflare.com' })).toBe(true);
    expect(originAllowed({ host: 'localhost:7420', 'x-forwarded-host': 'abc.trycloudflare.com', origin: 'https://abc.trycloudflare.com' })).toBe(true);
    expect(originAllowed({ host: '127.0.0.1:7420', referer: 'http://127.0.0.1:7420/' })).toBe(true);
    expect(originAllowed({ host: '127.0.0.1:7420', origin: 'null' })).toBe(false);
  });

  it('normalizes URL-bar input to http(s) only', () => {
    expect(normalizeNavigateUrl('example.com')).toBe('https://example.com/');
    expect(normalizeNavigateUrl('digikala.com/search?q=کتاب')).toMatch(/^https:\/\/digikala\.com\/search\?q=/);
    expect(normalizeNavigateUrl('localhost:5173')).toBe('http://localhost:5173/');
    expect(normalizeNavigateUrl('192.168.1.10:8080/admin')).toBe('http://192.168.1.10:8080/admin');
    expect(normalizeNavigateUrl('HTTP://Example.com')).toBe('http://example.com/');
    expect(normalizeNavigateUrl('about:blank')).toBe('about:blank');
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'chrome://settings', 'data:text/html,hi', 'mailto:a@b.c', 'two words', '', 'view-source:https://x.com']) {
      expect(normalizeNavigateUrl(bad)).toBeNull();
    }
  });

  it('compacts agent events for the timeline and masks secrets', () => {
    expect(agentEventToBus('tui', { type: 'text_delta', data: { delta: 'x' } })).toBeNull();
    expect(agentEventToBus('tui', { type: 'tool_call_args_delta', data: { delta: '{' } })).toBeNull();
    expect(agentEventToBus('tui', { type: 'budget_update', data: {} })).toBeNull();
    expect(agentEventToBus('tui', { type: 'tool_call_start', data: { name: 'browser_click' } }))
      .toEqual({ kind: 'agent', source: 'tui', type: 'tool', data: { tool: 'browser_click' } });
    const res = agentEventToBus('mission:m1', { type: 'tool_result', data: { name: 'read_file', result: '\n\nOPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123\nmore', isError: false } });
    expect(res).toMatchObject({ kind: 'agent', source: 'mission:m1', type: 'tool_done', data: { tool: 'read_file' } });
    const summary = (res as { data: { summary: string } }).data.summary;
    expect(summary).not.toContain('abcdefghijklmnopqrstuvwxyz123');
    expect(agentEventToBus('tui', { type: 'tool_result', data: { name: 'shell', result: 'boom', isError: true } })).toMatchObject({ type: 'tool_error' });
    const final = agentEventToBus('tui', { type: 'final', data: { content: 'x'.repeat(1000) } }) as { data: { summary: string } };
    expect(final.data.summary.length).toBeLessThanOrEqual(400);

    getBus().reset();
    publishAgentEvent('tui', { type: 'error', data: { message: 'Cancelled by user' } });
    publishAgentEvent('tui', { type: 'text_delta', data: { delta: 'ignored' } });
    expect(getBus().recent(10).map(e => e.kind === 'agent' ? e.type : e.kind)).toEqual(['error']);

    expect(maskSecrets('Authorization: Bearer abcdef1234567890')).not.toContain('abcdef1234567890');
    expect(maskSecrets('token=ghp_abcdefghijklmnopqrstuvwxyz0123')).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123');
    expect(maskSecrets('bot 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawabcdef')).not.toContain('AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw');
    expect(maskSecrets('"password": "hunter2hunter2"')).not.toContain('hunter2hunter2');
    expect(maskSecrets('Order placed: 2 items, $42.00')).toBe('Order placed: 2 items, $42.00');
  });

  it('validates human input events and strips unknown fields', () => {
    expect(validateHumanInput({ type: 'scroll', dx: 0, dy: -120, x: 5, y: 6, frameWidth: 100, frameHeight: 50, junk: 1 }))
      .toEqual({ ok: true, event: { type: 'scroll', dx: 0, dy: -120, x: 5, y: 6, frameWidth: 100, frameHeight: 50 } });
    expect(validateHumanInput({ type: 'click', x: 1, y: 2, button: 'right' })).toEqual({ ok: true, event: { type: 'click', x: 1, y: 2, button: 'right' } });
    expect(validateHumanInput({ type: 'click', x: 1, y: 2, button: 'side' }).ok).toBe(false);
    expect(validateHumanInput({ type: 'click', x: -1, y: 2 }).ok).toBe(false);
    expect(validateHumanInput({ type: 'click', x: 1, y: 2, clickCount: 9 }).ok).toBe(false);
    expect(validateHumanInput({ type: 'key', key: 'Enter\n' }).ok).toBe(false);
    expect(validateHumanInput({ type: 'type', text: 'x'.repeat(10_001) }).ok).toBe(false);
    expect(validateHumanInput(null).ok).toBe(false);
    expect(validateHumanInput([]).ok).toBe(false);
  });
});

// ── adversarial review regressions ───────────────────────────────────────────

describe('control center — review hardening', () => {
  it('strips a percent-encoded token parameter too (no bounce loop, token never kept in the URL)', async () => {
    expect(stripTokenFromUrl('/?%6B=abc&x=1')).toBe('/?x=1');
    expect(stripTokenFromUrl('/?%6b=abc')).toBe('/');
    expect(stripTokenFromUrl('/api/state?recent=0&%6B=abc')).toBe('/api/state?recent=0');
    // Other parameters that merely start with k / contain encoded bytes survive untouched.
    expect(stripTokenFromUrl('/?kk=1&lang=%66a')).toBe('/?kk=1&lang=%66a');

    const r = await fetch(`${base}/?%6B=${TOKEN}`, { redirect: 'manual' });
    expect(r.status).toBe(302);
    const location = r.headers.get('location') ?? '';
    expect(location).not.toContain(TOKEN);
    expect(location).toBe('/');
    // Following the bounce with the cookie lands on the dashboard (not another bounce).
    const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
    const page = await fetch(base + location, { redirect: 'manual', headers: { cookie, accept: 'text/html' } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('id="takeBtn"');
  });

  it('masks control-center tokens (?k=) in text shown to viewers / channels', () => {
    const line = `Live view: http://127.0.0.1:5555/?k=${TOKEN}`;
    expect(maskSecrets(line)).not.toContain(TOKEN);
    expect(maskSecrets(line)).toContain('http://127.0.0.1:5555/?k=');
    expect(maskSecrets(`http://192.168.1.4:7420/?lang=fa&k=${TOKEN}`)).not.toContain(TOKEN);
    const ev = agentEventToBus('mission:m1', { type: 'tool_result', data: { name: 'mission_status', result: `Live view: http://127.0.0.1:41000/?k=${TOKEN}` } }) as { data: { summary: string } };
    expect(ev.data.summary).not.toContain(TOKEN);
  });

  it('refuses to open the control center itself inside the agent browser (would plant the login cookie there)', async () => {
    const f = fake();
    await post('/api/takeover', { on: true });
    for (const url of [
      `http://127.0.0.1:${info.port}/?k=${TOKEN}`,
      `127.0.0.1:${info.port}/`,
      `localhost:${info.port}/api/state`,
      `http://[::1]:${info.port}/`,
      `http://0.0.0.0:${info.port}/`,
    ]) {
      const r = await post('/api/input', { type: 'navigate', url });
      expect(r.status).toBe(400);
      expect((await r.json() as { error: string }).error).toMatch(/^\[CONTROL_CENTER_URL\]/);
    }
    expect(f.inputs).toEqual([]);
    // Other local ports (a dev server) are still fine.
    const other = info.port === 65535 ? 65534 : info.port + 1;
    expect((await post('/api/input', { type: 'navigate', url: `localhost:${other}` })).status).toBe(200);
    expect(f.inputs).toHaveLength(1);
    // ...but not another QodeX control center's private link (e.g. a mission worker's live view).
    for (const url of [`http://127.0.0.1:${other}/?k=abcdEFGH12345678xyz`, 'http://192.168.1.20:7420/?k=abcdEFGH12345678xyz', 'https://blue-sky-123.trycloudflare.com/?k=abcdEFGH12345678xyz']) {
      const r = await post('/api/input', { type: 'navigate', url });
      expect(r.status).toBe(400);
    }
    expect(f.inputs).toHaveLength(1);
    // A public site that happens to use a k= search parameter is fine.
    expect((await post('/api/input', { type: 'navigate', url: 'https://www.amazon.com/s?k=mechanicalkeyboards' })).status).toBe(200);
    expect(f.inputs).toHaveLength(2);
    expect(looksLikeControlLink('http://localhost:7420/?k=short')).toBe(false);
    expect(looksLikeControlLink('http://[::1]:7420/?lang=fa&k=abcdEFGH12345678xyz')).toBe(true);
  });

  it('maps action errors to proper HTTP statuses (400 bad input, 404 not found, 500 otherwise)', async () => {
    extraUnregister.push(registerControlAction('x.bad', () => { throw new Error('[BAD_REQUEST] "id" is required'); }));
    extraUnregister.push(registerControlAction('x.missing', () => { throw new Error('[MISSION_NOT_FOUND] No mission matches "zz"'); }));
    extraUnregister.push(registerControlAction('x.approval', async () => { throw new Error('[APPROVAL_NOT_FOUND] No approval ap_1.'); }));
    extraUnregister.push(registerControlAction('x.boom', () => { throw new Error('[DB_LOCKED] busy'); }));
    const bad = await post('/api/actions/x.bad', {});
    expect(bad.status).toBe(400);
    expect((await bad.json() as { error: string }).error).toBe('[BAD_REQUEST] "id" is required');
    expect((await post('/api/actions/x.missing', {})).status).toBe(404);
    expect((await post('/api/actions/x.approval', {})).status).toBe(404);
    expect((await post('/api/actions/x.boom', {})).status).toBe(500);
  });

  it('refuses to serve the agent\'s own browser (it could open the dashboard and approve its own actions)', async () => {
    const f = fake();
    const broker = getApprovalBroker();
    const pending = broker.request({ prompt: 'Pay $500?', options: ['yes', 'no'], category: 'payment', risk: 'critical' });
    const id = broker.pending()[0]!.id;

    // The agent's browser has a tab on the control center (it navigated there, e.g. from a leaked link).
    f.tabUrls = ['https://shop.example/checkout', `http://127.0.0.1:${info.port}/`];
    const approve = await post(`/api/approvals/${id}`, { answer: 'yes' }, { origin: base });
    expect(approve.status).toBe(403);
    expect((await approve.json() as { error: string }).error).toMatch(/^\[AGENT_BROWSER\]/);
    expect(broker.get(id)).toBeDefined();
    expect((await fetch(`${base}/api/state`, { headers: bearer })).status).toBe(403);
    const page = await fetch(`${base}/`, { headers: { ...bearer, accept: 'text/html' } });
    expect(page.status).toBe(403);
    expect(await page.text()).not.toContain('id="takeBtn"');
    const login = await fetch(`${base}/?k=${TOKEN}`, { redirect: 'manual' });
    expect(login.status).toBe(403);
    expect(login.headers.get('set-cookie')).toBeNull();

    // Same through another host name for this server (Host header == the tab's host).
    f.tabUrls = [`http://qx-alias.test:${info.port}/`];
    const statusWithHost = (host: string) => new Promise<number>((resolve, reject) => {
      // fetch() can't override Host; node:http can.
      const r = httpRequest({ host: '127.0.0.1', port: info.port, path: '/api/state', headers: { ...bearer, host } }, res => { res.resume(); resolve(res.statusCode ?? 0); });
      r.on('error', reject);
      r.end();
    });
    expect(await statusWithHost(`qx-alias.test:${info.port}`)).toBe(403);
    expect(await statusWithHost(`127.0.0.1:${info.port}`)).toBe(200);

    // Once the agent's browser is elsewhere the human's dashboard works again.
    f.tabUrls = ['https://shop.example/checkout', `http://127.0.0.1:${info.port + 1}/dev`];
    expect((await fetch(`${base}/api/state`, { headers: bearer })).status).toBe(200);
    expect((await post(`/api/approvals/${id}`, { answer: 'no' })).status).toBe(200);
    expect(await pending).toEqual({ answer: 'no', by: 'control' });
  });

  it('hands an orphaned takeover back to the agent when no dashboard is connected', async () => {
    await stopControlCenter();
    info = await startControlCenter({ port: 0, token: TOKEN, onSteer: () => true, takeoverReleaseMs: 300 });
    base = `http://127.0.0.1:${info.port}`;
    const f = fake();
    // While a viewer is connected the human keeps control.
    const sse = await openSse(`${base}/api/events`, bearer);
    try {
      expect(await waitUntil(() => sse.of('hello').length === 1)).toBe(true);
      await post('/api/takeover', { on: true });
      expect(f.takeover).toBe(true);
      await new Promise(r => setTimeout(r, 1200));
      expect(f.takeover).toBe(true);
    } finally {
      sse.close();
    }
    // The viewer is gone: after the grace period control returns to the agent, with a notice.
    expect(await waitUntil(() => !f.takeover, 5000)).toBe(true);
    expect(getBus().recent(50).some(e => e.kind === 'notice' && /handed back/i.test(e.message))).toBe(true);
    // A takeover held by someone else (the terminal) is never touched.
    f.setTakeover(true, 'terminal');
    await new Promise(r => setTimeout(r, 1200));
    expect(f.takeover).toBe(true);
    expect(f.takeoverBy).toBe('terminal');
  }, 20_000);
});
