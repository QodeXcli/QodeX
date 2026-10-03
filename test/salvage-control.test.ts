/**
 * Salvaged Control Center hardening (from a review that stopped before committing):
 * CSP script hashes, CORP/COOP headers, a Secure cookie behind https tunnels,
 * secret masking of every forwarded bus event, the env token kept away from
 * agent-spawned processes, a late server 'error' that must not crash the process,
 * a screencast that never delivers a frame, and a LAN rebind that keeps the public
 * tunnel and the approval channel.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import {
  startControlCenter,
  stopControlCenter,
  stripTokenFromUrl,
  busEventJson,
  setTunnelStarterForTests,
  controlServerForTests,
  type ControlCenterInfo,
} from '../src/control/server.js';
import { getBus } from '../src/control/bus.js';
import { getApprovalBroker } from '../src/control/approvals.js';
import {
  setBrowserManagerForTests,
  type BrowserManager,
  type BrowserStatus,
  type ScreencastFrame,
} from '../src/tools/browser/types.js';

const TOKEN = 'hardening-token-0123456789';
const bearer = { authorization: `Bearer ${TOKEN}` };

let info: ControlCenterInfo;
let base: string;

async function waitUntil(fn: () => boolean, ms = 4000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await new Promise(r => setTimeout(r, 15));
  }
  return fn();
}

async function sseCollect(url: string, headers: Record<string, string>): Promise<{ text: () => string; close: () => void }> {
  const ac = new AbortController();
  const res = await fetch(url, { headers: { accept: 'text/event-stream', ...headers }, signal: ac.signal });
  let buf = '';
  if (res.body) {
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
        }
      } catch { /* aborted */ }
    })();
  }
  return { text: () => buf, close: () => ac.abort() };
}

/** Inline <script> bodies (not JSON data blocks) of an HTML page. */
function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script(?![^>]*type="application\/json")[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1] ?? '');
}

function sha256(s: string): string {
  return `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`;
}

function scriptSrcOf(csp: string): string {
  return csp.split(';').map(s => s.trim()).find(s => s.startsWith('script-src')) ?? '';
}

beforeEach(async () => {
  await stopControlCenter();
  getBus().reset();
  getApprovalBroker().reset();
  setBrowserManagerForTests(null);
  setTunnelStarterForTests(null);
  info = await startControlCenter({ port: 0, token: TOKEN, onSteer: () => true });
  base = `http://127.0.0.1:${info.port}`;
});

afterEach(async () => {
  await stopControlCenter();
  setBrowserManagerForTests(null);
  setTunnelStarterForTests(null);
  getApprovalBroker().reset();
  getBus().reset();
  delete process.env.QODEX_CONTROL_TOKEN;
});

describe('salvaged control hardening — login link', () => {
  it('strips a percent-encoded `k` too, keeping malformed escapes of other params as-is', async () => {
    expect(stripTokenFromUrl('/?%6B=abc&x=1')).toBe('/?x=1');
    expect(stripTokenFromUrl('/?%6b=abc')).toBe('/');
    expect(stripTokenFromUrl('/?x=1&k=abc&%6B=def&y=%E0%A4%A')).toBe('/?x=1&y=%E0%A4%A');
    const r = await fetch(`${base}/?%6B=${TOKEN}`, { redirect: 'manual' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/');
    const html = await fetch(`${base}/?%6B=${TOKEN}`, { redirect: 'manual', headers: { accept: 'text/html' } });
    expect(await html.text()).not.toContain(TOKEN);
  });

  it('marks the login cookie Secure when the request came through an https tunnel', async () => {
    const plain = await fetch(`${base}/?k=${TOKEN}`, { redirect: 'manual' });
    expect(plain.headers.get('set-cookie') ?? '').not.toMatch(/;\s*Secure/i);
    const viaTunnel = await fetch(`${base}/?k=${TOKEN}`, { redirect: 'manual', headers: { 'x-forwarded-proto': 'https' } });
    expect(viaTunnel.headers.get('set-cookie') ?? '').toMatch(/;\s*Secure/i);
    const htmlViaTunnel = await fetch(`${base}/?k=${TOKEN}`, { redirect: 'manual', headers: { 'x-forwarded-proto': 'https, http', accept: 'text/html' } });
    expect(htmlViaTunnel.headers.get('set-cookie') ?? '').toMatch(/;\s*Secure/i);
  });
});

describe('salvaged control hardening — headers', () => {
  it('allows only the exact inline scripts it serves (CSP hashes, no unsafe-inline for scripts)', async () => {
    const page = await fetch(`${base}/`, { headers: { ...bearer, accept: 'text/html' } });
    expect(page.status).toBe(200);
    const scriptSrc = scriptSrcOf(page.headers.get('content-security-policy') ?? '');
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    const scripts = inlineScripts(await page.text());
    expect(scripts.length).toBeGreaterThan(0);
    for (const s of scripts) expect(scriptSrc).toContain(sha256(s));
    // Same for the Persian page (both languages share one script).
    const fa = await fetch(`${base}/`, { headers: { ...bearer, accept: 'text/html', 'accept-language': 'fa-IR' } });
    for (const s of inlineScripts(await fa.text())) expect(scriptSrcOf(fa.headers.get('content-security-policy') ?? '')).toContain(sha256(s));

    const bounce = await fetch(`${base}/?k=${TOKEN}&x=%3C/script%3E`, { redirect: 'manual', headers: { accept: 'text/html' } });
    expect(bounce.status).toBe(200);
    const bScriptSrc = scriptSrcOf(bounce.headers.get('content-security-policy') ?? '');
    expect(bScriptSrc).not.toContain("'unsafe-inline'");
    const bScripts = inlineScripts(await bounce.text());
    expect(bScripts.length).toBe(1);
    for (const s of bScripts) expect(bScriptSrc).toContain(sha256(s));

    const denied = await fetch(`${base}/`, { headers: { accept: 'text/html' } });
    expect(denied.status).toBe(401);
    expect(denied.headers.get('content-security-policy') ?? '').toContain("script-src 'none'");
  });

  it('forbids cross-origin embedding of frames and API responses (CORP) and severs window.opener (COOP)', async () => {
    const running: Partial<BrowserManager> = {
      isRunning: () => true,
      status: () => ({ running: true } as BrowserStatus),
      tabs: () => [],
      screenshotJpeg: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      startScreencast: async (_f: (f: ScreencastFrame) => void) => async () => {},
      isTakeover: () => false,
    };
    setBrowserManagerForTests(running as BrowserManager);
    const jpg = await fetch(`${base}/api/frame.jpg`, { headers: bearer });
    expect(jpg.status).toBe(200);
    expect(jpg.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    const state = await fetch(`${base}/api/state`, { headers: bearer });
    expect(state.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    const denied = await fetch(`${base}/api/frame.jpg`);
    expect(denied.status).toBe(401);
    expect(denied.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    const page = await fetch(`${base}/`, { headers: { ...bearer, accept: 'text/html' } });
    expect(page.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    const ac = new AbortController();
    const sse = await fetch(`${base}/api/events`, { headers: { ...bearer, accept: 'text/event-stream' }, signal: ac.signal });
    expect(sse.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    ac.abort();
  });
});

describe('salvaged control hardening — robustness', () => {
  it('survives a server error emitted after listening (e.g. EMFILE on accept)', async () => {
    const server = controlServerForTests();
    expect(server).not.toBeNull();
    const err = Object.assign(new Error('accept EMFILE'), { code: 'EMFILE' });
    // Without a persistent 'error' listener this throws (and would crash the process).
    expect(() => server!.emit('error', err)).not.toThrow();
    const r = await fetch(`${base}/api/state`, { headers: bearer });
    expect(r.status).toBe(200);
  });
});

describe('salvaged control hardening — live view recovery', () => {
  it('restarts a screencast that started but never delivered a frame', async () => {
    // The real manager resolves startScreencast even when attaching to the page failed
    // (it logs and waits for the next tab event), so "no frame ever" must be recovered here.
    let starts = 0;
    let stops = 0;
    let timer: NodeJS.Timeout | null = null;
    const mgr: Partial<BrowserManager> = {
      isRunning: () => true,
      status: () => ({ running: true, tabs: [], takeover: false } as unknown as BrowserStatus),
      tabs: () => [],
      isTakeover: () => false,
      startScreencast: async (onFrame: (f: ScreencastFrame) => void) => {
        starts++;
        if (starts >= 2) timer = setInterval(() => onFrame({ data: 'AAAA', width: 10, height: 10, ts: Date.now() }), 50);
        return async () => { stops++; if (timer) clearInterval(timer); timer = null; };
      },
    };
    setBrowserManagerForTests(mgr as BrowserManager);
    const sse = await sseCollect(`${base}/api/frames`, bearer);
    try {
      expect(await waitUntil(() => sse.text().includes('event: frame'), 12_000)).toBe(true);
      expect(starts).toBe(2);
      expect(stops).toBeGreaterThanOrEqual(1);
    } finally {
      sse.close();
      if (timer) clearInterval(timer);
    }
  }, 20_000);
});

describe('salvaged control hardening — secrets', () => {
  it('masks secret-looking strings in every bus event forwarded to viewers', async () => {
    const sse = await sseCollect(`${base}/api/events`, bearer);
    try {
      expect(await waitUntil(() => sse.text().includes('event: hello'))).toBe(true);
      getBus().publish({ kind: 'mission', missionId: 'm1', type: 'milestone', data: { title: 'Configured', detail: 'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456' } });
      getBus().publish({ kind: 'browser', type: 'action', data: { tool: 'browser_type', args: { text: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' } } });
      getBus().publish({ kind: 'browser', type: 'navigated', data: { tab: 't1', index: 0, url: 'https://app.example/cb#access_token=zyxwvutsrqponmlk987654' } });
      expect(await waitUntil(() => sse.text().includes('Configured') && sse.text().includes('browser_type') && sse.text().includes('app.example/cb'))).toBe(true);
      expect(sse.text()).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
      expect(sse.text()).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
      expect(sse.text()).not.toContain('zyxwvutsrqponmlk987654');
    } finally {
      sse.close();
    }
    const state = await (await fetch(`${base}/api/state`, { headers: bearer })).text();
    expect(state).toContain('Configured');
    expect(state).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
    // The wire form stays valid JSON even when a masked value contained an escaped quote.
    const ev = getBus().publish({ kind: 'notice', level: 'info', message: 'token="abc\\"defghijkl"' });
    expect(() => JSON.parse(busEventJson(ev))).not.toThrow();
    // Ordinary text is untouched; cycles don't throw.
    const plain = getBus().publish({ kind: 'notice', level: 'info', message: 'Order placed: 2 items, $42.00' });
    expect(JSON.parse(busEventJson(plain)).message).toBe('Order placed: 2 items, $42.00');
    const cyclic: Record<string, unknown> = { note: 'loop' };
    cyclic.self = cyclic;
    const c = getBus().publish({ kind: 'mission', missionId: 'm2', type: 'milestone', data: cyclic });
    expect(() => JSON.parse(busEventJson(c))).not.toThrow();
  });

  it('takes $QODEX_CONTROL_TOKEN out of the environment so agent-spawned processes cannot read it', async () => {
    await stopControlCenter();
    process.env.QODEX_CONTROL_TOKEN = 'env-token-abcdefghijklmnop';
    const a = await startControlCenter({ port: 0 });
    expect(a.token).toBe('env-token-abcdefghijklmnop');
    expect(process.env.QODEX_CONTROL_TOKEN).toBeUndefined();
    await stopControlCenter();
    // Restarting in the same process keeps using the configured token.
    const b = await startControlCenter({ port: 0 });
    expect(b.token).toBe('env-token-abcdefghijklmnop');
  });
});

describe('salvaged control hardening — LAN rebind', () => {
  it('keeps the public tunnel (same URL, not restarted) and the approval channel', async () => {
    await stopControlCenter();
    let starts = 0;
    let closes = 0;
    setTunnelStarterForTests(async () => { starts++; return { url: `https://t${starts}.trycloudflare.com`, close: () => { closes++; } }; });
    const first = await startControlCenter({ port: 0, token: TOKEN, tunnel: true });
    expect(first.tunnelUrl).toBe(`https://t1.trycloudflare.com/?k=${TOKEN}`);
    const pending = getApprovalBroker().request({ prompt: 'Pay $10?', options: ['yes', 'no'] });
    const lan = await startControlCenter({ lan: true });
    expect(lan.host).toBe('0.0.0.0');
    expect(lan.port).toBe(first.port);
    expect(lan.tunnelUrl).toBe(first.tunnelUrl);
    expect(starts).toBe(1);
    expect(closes).toBe(0);
    expect(getApprovalBroker().channelNames()).toContain('control');
    // The approval raised before the rebind is still answerable through the new server.
    const id = getApprovalBroker().pending()[0]?.id;
    expect(id).toBeDefined();
    const r = await fetch(`http://127.0.0.1:${lan.port}/api/approvals/${id}`, {
      method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify({ answer: 'no' }),
    });
    expect(r.status).toBe(200);
    expect(await pending).toEqual({ answer: 'no', by: 'control' });
    await stopControlCenter();
    expect(closes).toBe(1);
  });
});
