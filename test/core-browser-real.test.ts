/**
 * The agent core driving the REAL QodeX browser (real Chromium, the real ToolRegistry with
 * Sentinel's fencing, a local http server — no internet) through a scripted model:
 *
 *   - a read-only observer called in the same turn as an action (browser_navigate +
 *     browser_status) reports the state AFTER the action (model order), not before it;
 *   - the loop guards key real browser results by content: scrolling through a long page
 *     (scroll results change) is progress, while re-snapshotting an unchanged page three
 *     times in a row is flagged as stuck.
 *
 * Skipped when playwright / a Chromium executable is unavailable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-core-browser-home-'));
const ORIG_HOME = process.env.HOME;
process.env.HOME = HOME; // src modules compute ~/.qodex at import time (all imported dynamically below)

let pw: any = null;
try { pw = await import('playwright'); } catch { pw = null; }
const { resolveBrowserExecutable } = await import('../src/tools/browser/launcher.js');
let pwExe = '';
try { pwExe = String(pw?.chromium?.executablePath?.() ?? ''); } catch { pwExe = ''; }
const exe = resolveBrowserExecutable({ playwrightExecutablePath: pwExe, headless: true });
const chromium = !!pw && !!(exe.executablePath || exe.channel);

const TALL = Array.from({ length: 120 }, (_, i) => `<p>Paragraph ${i}: lorem ipsum dolor sit amet.</p>`).join('');
const PAGE = `<!doctype html><html><head><title>Core Probe Shop</title></head><body>
<h1>Core Probe Shop</h1><button onclick="document.title='Clicked'">Buy now</button>${TALL}</body></html>`;

// Restore HOME even when the suite below is skipped (no Chromium).
afterAll(() => {
  if (ORIG_HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIG_HOME;
  fs.rmSync(HOME, { recursive: true, force: true });
});

describe.skipIf(!chromium)('agent core × real QodeX browser', () => {
  let server: http.Server;
  let base = '';
  let tmp = '';
  let mgr: any;
  let F: typeof import('./core-fakes.js');
  let L: typeof import('../src/agent/loop.js');
  let S: typeof import('../src/session/store.js');
  let registry: any;
  let store: any;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-core-browser-'));
    server = http.createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(PAGE); });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
    F = await import('./core-fakes.js');
    L = await import('../src/agent/loop.js');
    S = await import('../src/session/store.js');
    const { QodexBrowserManager } = await import('../src/tools/browser/session.js');
    const { setBrowserManagerForTests } = await import('../src/tools/browser/types.js');
    const { ToolRegistry } = await import('../src/tools/registry.js');
    mgr = new QodexBrowserManager({
      profilesDir: path.join(tmp, 'profiles'),
      downloadsDir: path.join(tmp, 'downloads'),
      config: { headless: true, snapshotAfterAction: true },
    });
    setBrowserManagerForTests(mgr);
    registry = new ToolRegistry();
    store = new S.SessionStore(path.join(HOME, 'sessions-browser.db'));
    S.setSessionStoreForTests(store);
  }, 60_000);

  afterAll(async () => {
    await mgr?.close();
    const { setBrowserManagerForTests } = await import('../src/tools/browser/types.js');
    setBrowserManagerForTests(null);
    S?.setSessionStoreForTests(null);
    await new Promise<void>(r => server?.close(() => r()));
    fs.rmSync(tmp, { recursive: true, force: true });
  }, 60_000);

  async function run(script: (req: any, i: number) => import('./core-fakes.js').FakeTurn) {
    const provider = new F.FakeProvider(script);
    const agent = new L.AgentLoop({
      router: F.fakeRouter(provider), registry, permissions: F.allowAllPermissions, config: F.testConfig(), cwd: tmp,
    });
    const sid = store.createSession(tmp, 'fake');
    const events: any[] = [];
    for await (const ev of agent.run(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: `check ${base}/` }],
      sid,
      { mode: { mode: 'subagent' }, askUser: async () => 'no', maxIterationsOverride: 20 },
    )) events.push(ev);
    return { provider, events };
  }

  const toolMsgs = (req: any) => (req?.messages ?? []).filter((m: any) => m.role === 'tool');
  const userNotes = (req: any) => (req?.messages ?? []).filter((m: any) => m.role === 'user').map((m: any) => String(m.content));

  it('[browser_navigate, browser_status] in one turn: status reports the page it navigated to', async () => {
    const { provider } = await run((_r, i) => (i === 0
      ? { calls: [{ name: 'browser_navigate', id: 'nav', args: { url: `${base}/` } }, { name: 'browser_status', id: 'st' }] }
      : { text: 'done' }));
    const msgs = toolMsgs(provider.requests[1]);
    const status = String(msgs.find((m: any) => m.tool_call_id === 'st')?.content ?? '');
    expect(String(msgs.find((m: any) => m.tool_call_id === 'nav')?.content ?? '')).toContain('✓ Loaded');
    expect(status).toContain('<untrusted_content'); // the real Sentinel fenced it
    expect(status).toContain('Running: yes');
    expect(status).toContain('Core Probe Shop');
  }, 90_000);

  it('scroll → snapshot through a long page is progress; three identical snapshots are stuck', async () => {
    // Part 1: alternate scroll / snapshot — scroll results change (y=…), so no guard fires.
    const seq = ['browser_scroll', 'browser_snapshot', 'browser_scroll', 'browser_snapshot', 'browser_scroll', 'browser_snapshot'];
    const r1 = await run((_r, i) => (i < seq.length
      ? { calls: [{ name: seq[i]!, args: seq[i] === 'browser_scroll' ? { direction: 'down' } : {} }] }
      : { text: 'read it all' }));
    expect(r1.provider.requests.length).toBe(seq.length + 1);
    for (const req of r1.provider.requests) {
      expect(userNotes(req).join('\n')).not.toMatch(/same arguments|LOOP_GUARD/);
    }
    const scrolls = toolMsgs(r1.provider.requests.at(-1)).filter((m: any) => m.name === 'browser_scroll').map((m: any) => String(m.content));
    expect(new Set(scrolls).size).toBe(3); // the page really moved each time

    // Part 2: the same snapshot of an unchanged page three times in a row → stuck nudge.
    const r2 = await run((_r, i) => (i < 4 ? { calls: [{ name: 'browser_snapshot', args: {} }] } : { text: 'stopped' }));
    const notes = r2.provider.requests.map(req => userNotes(req).join('\n'));
    expect(notes[2]).not.toMatch(/same arguments 3\+ times/);
    expect(notes[3]).toMatch(/`browser_snapshot` with the same arguments 3\+ times/);
  }, 120_000);
});
