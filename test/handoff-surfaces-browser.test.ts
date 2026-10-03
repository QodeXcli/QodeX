/**
 * H2 hand-off surfaces — the real browser manager relays a human's press-and-hold /
 * drag ('down' → 'move' → 'up') to the page with the real hold duration, releases a
 * hold whose 'up' was lost, and takes screenshots clipped to the challenge box.
 * Local pages only; skipped without Playwright + Chromium.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveBrowserExecutable } from '../src/tools/browser/launcher.js';
import { QodexBrowserManager, clampClip } from '../src/tools/browser/session.js';
import { setBrowserManagerForTests, type BrowserActionRecord } from '../src/tools/browser/types.js';

let pw: any = null;
try { pw = await import('playwright'); } catch { pw = null; }
let pwExe = '';
try { pwExe = String(pw?.chromium?.executablePath?.() ?? ''); } catch { pwExe = ''; }
const exe = resolveBrowserExecutable({ playwrightExecutablePath: pwExe, headless: true });
const chromium = !!pw && !!(exe.executablePath || exe.channel);

const PAGE = `<!doctype html><title>Hold</title>
<body style="margin:0">
<div id="btn" style="position:absolute;left:100px;top:100px;width:200px;height:60px;background:#333"></div>
<script>
  window.log = [];
  var b = document.getElementById('btn');
  b.addEventListener('mousedown', function (e) { log.push(['down', e.clientX, e.clientY, Date.now(), e.button]); });
  document.addEventListener('mousemove', function (e) { if (e.buttons) log.push(['move', e.clientX, e.clientY, Date.now()]); });
  document.addEventListener('mouseup', function (e) { log.push(['up', e.clientX, e.clientY, Date.now(), e.button]); });
  document.addEventListener('click', function () { log.push(['click']); });
</script></body>`;

/** Width/height of a baseline or progressive JPEG (its SOF marker). */
function jpegSize(buf: Buffer): { width: number; height: number } | null {
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1]!;
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

describe('clampClip', () => {
  it('keeps a clip inside the viewport and drops one that misses it', () => {
    expect(clampClip({ x: -10, y: 5.4, width: 50, height: 20 }, { width: 100, height: 100 })).toEqual({ x: 0, y: 5, width: 40, height: 21 });
    expect(clampClip({ x: 90, y: 90, width: 50, height: 50 }, { width: 100, height: 100 })).toEqual({ x: 90, y: 90, width: 10, height: 10 });
    expect(clampClip({ x: 200, y: 0, width: 50, height: 50 }, { width: 100, height: 100 })).toBeNull();
    expect(clampClip({ x: NaN, y: 0, width: 50, height: 50 }, { width: 100, height: 100 })).toBeNull();
  });
});

describe.skipIf(!chromium)('real browser: human press-and-hold and clipped screenshots', () => {
  let tmp: string;
  let server: http.Server;
  let base: string;
  let mgr: QodexBrowserManager;
  const actions: BrowserActionRecord[] = [];

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-handoff-browser-'));
    server = http.createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(PAGE); });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
    mgr = new QodexBrowserManager({ profilesDir: path.join(tmp, 'profiles'), downloadsDir: path.join(tmp, 'downloads'), config: { headless: true, viewport: { width: 800, height: 600 } } as any });
    setBrowserManagerForTests(mgr);
    mgr.onAction(r => actions.push(r));
    await mgr.dispatchInput({ type: 'navigate', url: `${base}/` });
  }, 60_000);

  afterAll(async () => {
    await mgr?.close();
    setBrowserManagerForTests(null);
    await new Promise<void>(r => server?.close(() => r()));
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }, 60_000);

  it('relays down → move → up with the real hold time, in frame coordinates, and records no step', async () => {
    const page = await mgr.activePage();
    await page.evaluate('window.log = []');
    actions.length = 0;
    // Frame is half the viewport size: coordinates are rescaled.
    await mgr.dispatchInput({ type: 'down', x: 100, y: 65, frameWidth: 400, frameHeight: 300 });
    await new Promise(r => setTimeout(r, 700));
    await mgr.dispatchInput({ type: 'move', x: 120, y: 65, frameWidth: 400, frameHeight: 300 });
    await mgr.dispatchInput({ type: 'up', x: 130, y: 65, frameWidth: 400, frameHeight: 300 });
    const log = await page.evaluate('window.log') as Array<[string, number, number, number, number]>;
    const down = log.find(e => e[0] === 'down')!;
    const up = log.find(e => e[0] === 'up')!;
    expect(down.slice(1, 3)).toEqual([200, 130]);
    expect(log.some(e => e[0] === 'move' && e[1] === 240)).toBe(true);
    expect(up.slice(1, 3)).toEqual([260, 130]);
    expect(up[3] - down[3]).toBeGreaterThanOrEqual(600); // the human's own hold duration
    expect(actions.filter(a => a.actor === 'human')).toEqual([]); // a hold is never a recorded workflow step
  }, 30_000);

  it('a lost "up" is released: by the next "down", and by releaseHumanMouse()', async () => {
    const page = await mgr.activePage();
    await page.evaluate('window.log = []');
    await mgr.dispatchInput({ type: 'down', x: 150, y: 120 });
    await mgr.dispatchInput({ type: 'down', x: 160, y: 120 });
    await mgr.releaseHumanMouse();
    await mgr.releaseHumanMouse(); // idempotent
    const kinds = (await page.evaluate('window.log') as Array<[string]>).map(e => e[0]).filter(k => k === 'down' || k === 'up');
    expect(kinds).toEqual(['down', 'up', 'down', 'up']);
  }, 30_000);

  it('takes a JPEG of just the clip (clamped to the viewport)', async () => {
    const full = jpegSize(await mgr.screenshotJpeg(60));
    expect(full).toEqual({ width: 800, height: 600 });
    const clip = jpegSize(await mgr.screenshotJpeg(60, { clip: { x: 76, y: 76, width: 248, height: 108 } }));
    expect(clip).toEqual({ width: 248, height: 108 });
    const clamped = jpegSize(await mgr.screenshotJpeg(60, { clip: { x: 700, y: 500, width: 400, height: 400 } }));
    expect(clamped).toEqual({ width: 100, height: 100 });
  }, 30_000);
});
