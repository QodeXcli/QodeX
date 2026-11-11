import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { handleShell, renderShellHtml, type ShellView } from '../src/desktop/shell.js';
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
  ...over,
});

describe('desktop shell', () => {
  it('escapes control names so the page cannot run them', () => {
    const html = renderShellHtml(view({ tree: '<script>alert(1)</script>' }));
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('\u0026lt;script\u0026gt;');
    expect(html).toContain('No cloud browser');
  });

  it('refuses a request without the token', async () => {
    const handled = await handleShell({
      method: 'GET',
      pathname: '/',
      tokenOk: false,
      rawBody: '',
      view: view(),
      deps: { readTree: async () => ({ ok: true, text: '' }), invoke: async () => ({ content: '' }), shoot: async () => ({ ok: false, error: 'no' }), shotFile: () => null, setShot: () => {} },
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
      deps: {
        readTree: async () => ({ ok: false, error: 'AT-SPI is not available' }),
        invoke: async () => ({ content: 'should not run' }),
        shoot: async () => ({ ok: false, error: 'no' }),
        shotFile: () => null,
        setShot: () => {},
      },
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
      deps: {
        readTree: async () => ({ ok: true, text: '' }),
        invoke: async () => ({ content: '' }),
        shoot: async () => ({ ok: false, error: 'no' }),
        shotFile: () => '/etc/passwd',
        setShot: () => {},
      },
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
      deps: {
        readTree: async () => ({ ok: true, text: '' }),
        invoke: async () => ({ content: '' }),
        shoot: async () => ({ ok: false, error: 'no' }),
        shotFile: () => file,
        setShot: () => {},
      },
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
