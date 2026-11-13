import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { handleShell, renderShellHtml, resultTone, deskRows, liveSnapshot, type ShellView } from '../src/desktop/shell.js';
import { appWindowLaunch, isLoopbackAppUrl, nativeWindowLaunch } from '../src/desktop/window.js';

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
  audit: [],
  ...over,
});

const deps = (over: Record<string, unknown> = {}) => ({
  readTree: async () => ({ ok: true as const, text: '' }),
  invoke: async () => ({ content: '' }),
  typeText: async () => ({ content: '' }),
  shoot: async () => ({ ok: false as const, error: 'no' }),
  shotFile: () => null as string | null,
  setShot: () => {},
  decide: async () => ({ ok: true }),
  board: async () => ({ ok: true, message: 'queued' }),
  launch: async () => ({ ok: true, message: 'running ab12cd34' }),
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
    expect(html).toContain('value="type"');
    expect(html).toContain('maxlength="500"');
    expect(html).toContain('id="live-screen"');
    expect(resultTone('verified: the control is no longer in the tree.')).toBe('ok');
    expect(resultTone('')).toBe('idle');
  });

  it('types into the named control and refuses a newline', async () => {
    let got = '';
    const sent = await handleShell({
      method: 'POST', pathname: '/act', tokenOk: true,
      rawBody: 'action=type&name=Search&role=AXTextField&app=Safari&text=hello',
      view: view(),
      deps: deps({ typeText: async (_q: { name: string }, text: string) => { got = text; return { content: 'verified: the field now shows the text.' }; } }),
    });
    expect(got).toBe('hello');
    expect(sent.view.result).toContain('verified:');
    const secret = 'line1\nline2';
    let called = false;
    const refused = await handleShell({
      method: 'POST', pathname: '/act', tokenOk: true,
      rawBody: `action=type&name=Search&text=${encodeURIComponent(secret)}`,
      view: view(),
      deps: deps({ typeText: async () => { called = true; return { content: 'no' }; } }),
    });
    expect(called).toBe(true);
    expect(refused.view.result).toBe('no');
  });

  it('shows active desk goals and serves them on the live poll', async () => {
    const rows = deskRows([
      { id: 'research', name: 'research', goals: [
        { id: 'old', text: 'done already', status: 'done' },
        { id: 'now', text: '<script>alert(1)</script> ' + 'x'.repeat(200), status: 'running' },
      ] },
    ]);
    expect(rows[0]!.goals.map(g => g.status)).toEqual(['running']);
    expect(rows[0]!.runnable).toBe(false);
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

  it('assigns a goal through the desk lock and holds a sensitive one', async () => {
    const fs = await import('fs/promises');
    const os = await import('os');
    const path = await import('path');
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'qodex-shell-desk-'));
    const prev = process.env.HOME;
    process.env.HOME = home;
    try {
      const { handleDeskRequest } = await import('../src/desk/console.js');
      const { loadBoard } = await import('../src/desk/store.js');
      const { applyDeskAction } = await import('../src/desk/console.js');
      const created = await handleDeskRequest({
        method: 'POST', pathname: '/api/action', tokenOk: true,
        rawBody: JSON.stringify({ action: 'create', name: 'inbox', brief: 'mail' }),
        contentType: 'application/json', cwd: '/work',
      });
      expect(created.status).toBe(200);
      const refused = await handleShell({
        method: 'POST', pathname: '/act', tokenOk: true, rawBody: 'action=goal&deskId=../x&text=hello',
        view: view(), deps: deps(),
      });
      expect(refused.view.result).toContain('refused');
      const posted = await handleShell({
        method: 'POST', pathname: '/act', tokenOk: true,
        rawBody: 'action=goal&deskId=inbox&text=' + encodeURIComponent('send an email to the team'),
        view: view(),
        deps: deps({ board: (body: Record<string, string>) => applyDeskAction(body, '/work') }),
      });
      expect(posted.view.result).toBe('goal needs-approval');
      const board = await loadBoard();
      const goal = board.desks[0]!.goals[0]!;
      expect(goal.status).toBe('needs-approval');
      const html = renderShellHtml(view({ team: deskRows(board.desks) }));
      expect(html).toContain('name="action" value="approve"');
      expect(html).toContain('Assign a goal');
      const allowed = await handleShell({
        method: 'POST', pathname: '/act', tokenOk: true,
        rawBody: `action=approve&deskId=inbox&goalId=${goal.id}&allow=yes`,
        view: view(),
        deps: deps({ board: (body: Record<string, string>) => applyDeskAction(body, '/work') }),
      });
      expect(allowed.view.result).toBe('goal approved');
    } finally {
      if (prev === undefined) delete process.env.HOME;
      else process.env.HOME = prev;
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('starts a runnable goal only through the launch path', async () => {
    let seen = '';
    const started = await handleShell({
      method: 'POST', pathname: '/act', tokenOk: true, rawBody: 'action=run&deskId=inbox',
      view: view(),
      deps: deps({ launch: async (id: string) => { seen = id; return { ok: true, message: 'running ab12cd34' }; } }),
    });
    expect(started.view.result).toBe('running ab12cd34');
    expect(seen).toBe('inbox');
    const bad = await handleShell({
      method: 'POST', pathname: '/act', tokenOk: true, rawBody: 'action=run&deskId=../x',
      view: view(), deps: deps(),
    });
    expect(bad.view.result).toContain('refused');
    const rows = deskRows([{ id: 'inbox', name: 'inbox', goals: [{ id: 'ab12cd34', text: 'read notes', status: 'queued' }] }]);
    expect(renderShellHtml(view({ team: rows }))).toContain('value="run"');
    const held = deskRows([{ id: 'inbox', name: 'inbox', goals: [{ id: 'ab12cd34', text: 'pay the invoice', status: 'needs-approval', sensitive: { kind: 'spend' } }] }]);
    expect(held[0]!.runnable).toBe(false);
    expect(renderShellHtml(view({ team: held }))).not.toContain('value="run"');
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
    expect(nativeWindowLaunch('https://example.com/', '/usr/local/bin/qodex-desktop')).toBeNull();
    expect(nativeWindowLaunch('http://127.0.0.1:9/?k=a', null)).toBeNull();
    expect(nativeWindowLaunch('http://127.0.0.1:9/?k=a', '/usr/local/bin/qodex-desktop')).toEqual({
      cmd: '/usr/local/bin/qodex-desktop',
      args: ['--url', 'http://127.0.0.1:9/?k=a'],
    });
  });
});
