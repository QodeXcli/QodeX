import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { handleShell, renderShellHtml, resultTone, deskRows, liveSnapshot, type ShellView } from '../src/desktop/shell.js';
import { appWindowLaunch, isLoopbackAppUrl } from '../src/desktop/window.js';

const view = (over: Partial<ShellView> = {}): ShellView => ({
  token: 'tok',
  tree: '',
  result: '',
  shot: false,
  gui: 'x11',
  access: 'none',
  note: 'note',
  desks: 0,
  pending: 0,
  resident: 'resident off',
  controls: [],
  capped: false,
  waits: [],
  team: [],
  ...over,
});

const deps = (over: Record<string, unknown> = {}) => ({
  readTree: async () => ({ ok: true as const, text: '' }),
  invoke: async () => ({ content: '' }),
  shoot: async () => ({ ok: false as const, error: 'no' }),
  shotFile: () => null as string | null,
  setShot: () => {},
  decide: async () => ({ ok: true }),
  ...over,
});

describe('desktop shell', () => {
  it('escapes control names so the page cannot run them', () => {
    const html = renderShellHtml(view({ tree: '<script>alert(1)</script>' }));
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('\u0026lt;script\u0026gt;');
    expect(html).toContain('No cloud browser');
  });

  it('renders a named control as a press, and marks an unverified result as a failure', () => {
    const html = renderShellHtml(view({
      controls: [{ app: 'Settings', role: 'AXButton', name: '<Allow>', enabled: true, value: '', x: 1, y: 2, w: 3, h: 4 }],
      result: 'Pressed "Allow"\nunverified: the control still looks the same.',
    }));
    expect(html).toContain('name="name" value="\u0026lt;Allow\u0026gt;"');
    expect(html).toContain('data-hit=');
    expect(html).not.toContain('<Allow>');
    expect(html).toContain('banner bad');
    expect(resultTone('verified: the control is no longer in the tree.')).toBe('ok');
    expect(resultTone('')).toBe('idle');
  });

  it('shows active desk goals and serves them on the live poll', async () => {
    const rows = deskRows([
      { name: 'research', goals: [
        { id: 'old', text: 'done already', status: 'done' },
        { id: 'now', text: '<script>alert(1)</script> ' + 'x'.repeat(200), status: 'running' },
      ] },
    ]);
    expect(rows[0]!.goals.map(g => g.status)).toEqual(['running']);
    expect(rows[0]!.goals[0]!.text.startsWith('<script>')).toBe(true);
    expect(rows[0]!.goals[0]!.text.length).toBeLessThanOrEqual(160);
    const page = view({ team: rows, waits: [{ id: 'ab12cd34', kind: 'spend', reason: 'pays', prompt: 'buy' }] });
    const html = renderShellHtml(page);
    expect(html).toContain('research');
    expect(html).not.toContain('<script>alert');
    const live = await handleShell({
      method: 'GET', pathname: '/live', tokenOk: true, rawBody: '', view: page, deps: deps(),
    });
    expect(live.route.status).toBe(200);
    expect(live.route.contentType).toContain('application/json');
    const body = JSON.parse(String(live.route.body));
    expect(body.pending).toBe(1);
    expect(body.desks[0].name).toBe('research');
    expect(body.token).toBeUndefined();
    expect(liveSnapshot(page).waits[0].kind).toBe('spend');
    const denied = await handleShell({
      method: 'GET', pathname: '/live', tokenOk: false, rawBody: '', view: page, deps: deps(),
    });
    expect(denied.route.status).toBe(401);
  });

  it('allows a waiting call only with a real id', async () => {
    let seen: { id?: string; allow?: boolean } = {};
    const bad = await handleShell({
      method: 'POST', pathname: '/act', tokenOk: true, rawBody: 'action=allow&id=../x',
      view: view(), deps: deps(),
    });
    expect(bad.view.result).toContain('refused');
    const ok = await handleShell({
      method: 'POST', pathname: '/act', tokenOk: true, rawBody: 'action=allow&id=ab12cd34',
      view: view(),
      deps: deps({ decide: async (id: string, allow: boolean) => { seen = { id, allow }; return { ok: true }; } }),
    });
    expect(ok.view.result).toBe('allowed ab12cd34');
    expect(seen).toEqual({ id: 'ab12cd34', allow: true });
  });

  it('refuses a request without the token', async () => {
    const handled = await handleShell({
      method: 'GET',
      pathname: '/',
      tokenOk: false,
      rawBody: '',
      view: view(),
      deps: deps(),
    });
    expect(handled.route.status).toBe(401);
  });

  it('reads the tree only when asked, and does not invent one', async () => {
    const handled = await handleShell({
      method: 'POST',
      pathname: '/act',
      tokenOk: true,
      rawBody: 'action=tree',
      view: view(),
      deps: deps({ readTree: async () => ({ ok: false as const, error: 'AT-SPI is not available' }) }),
    });
    expect(handled.route.status).toBe(303);
    expect(handled.view.tree).toContain('AT-SPI');
    expect(handled.view.result).toBe('');
  });

  it('does not serve a screenshot from outside the screenshot directory', async () => {
    const handled = await handleShell({
      method: 'GET',
      pathname: '/shot',
      tokenOk: true,
      rawBody: '',
      view: view(),
      deps: deps({ shotFile: () => '/etc/passwd' }),
    });
    expect(handled.route.status).toBe(403);
  });

  it('serves a png that the shell itself captured', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'qodex-screenshots-'));
    const root = path.join(os.tmpdir(), 'qodex-screenshots');
    await import('fs/promises').then(fs => fs.mkdir(root, { recursive: true }));
    const file = path.join(root, `shell-test-${process.pid}.png`);
    await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const handled = await handleShell({
      method: 'GET',
      pathname: '/shot',
      tokenOk: true,
      rawBody: '',
      view: view({ shot: true }),
      deps: deps({ shotFile: () => file }),
    });
    expect(handled.route.status).toBe(200);
    expect(handled.route.contentType).toBe('image/png');
    await rm(file, { force: true });
    await rm(dir, { recursive: true, force: true });
  });
});

describe('app window', () => {
  it('only launches a window for the loopback shell', () => {
    expect(isLoopbackAppUrl('http://127.0.0.1:4311/?k=abc')).toBe(true);
    expect(isLoopbackAppUrl('https://example.com/')).toBe(false);
    expect(appWindowLaunch('linux', 'https://browserbase.com/', '/usr/bin/chromium')).toBeNull();
    const launch = appWindowLaunch('linux', 'http://127.0.0.1:9/?k=a', '/usr/bin/chromium');
    expect(launch?.cmd).toBe('/usr/bin/chromium');
    expect(launch?.args[0]).toBe('--app=http://127.0.0.1:9/?k=a');
  });
});
