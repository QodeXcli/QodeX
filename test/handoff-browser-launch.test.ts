/**
 * H1 item 6 — fewer challenges, legitimately: `browser.headless: auto`, stealth OFF by
 * default, a configured channel honoured when headed, the real window when headed,
 * per-host pacing and the soft refusal to reload a challenge page. No browser needed
 * (launch options are recorded through an injected fake Playwright).
 */
import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { resolveBrowserConfig, hasDisplay } from '../src/config/agent-config.js';
import { resolveBrowserExecutable } from '../src/tools/browser/launcher.js';
import { QodexBrowserManager, isLocalHost } from '../src/tools/browser/session.js';

describe('browser.headless auto, stealth off, hand-off config', () => {
  it('auto = a window only with a display AND a human at the TUI; env overrides win', () => {
    const disp = { DISPLAY: ':0' };
    expect(resolveBrowserConfig({}, disp, { interactive: true, platform: 'linux' })).toMatchObject({ headless: false, headlessMode: 'auto' });
    expect(resolveBrowserConfig({}, disp, { interactive: false, platform: 'linux' }).headless).toBe(true); // --print / missions
    expect(resolveBrowserConfig({}, {}, { interactive: true, platform: 'linux' }).headless).toBe(true); // no display
    expect(resolveBrowserConfig({}, {}, { interactive: true, platform: 'darwin' }).headless).toBe(false);
    expect(resolveBrowserConfig({}, { SSH_CONNECTION: '1 2 3 4' }, { interactive: true, platform: 'darwin' }).headless).toBe(true);
    expect(resolveBrowserConfig({}, { ...disp, QODEX_BROWSER_HEADLESS: '1' }, { interactive: true, platform: 'linux' })).toMatchObject({ headless: true, headlessMode: 'headless' });
    expect(resolveBrowserConfig({ browser: { headless: false } }, {}, {})).toMatchObject({ headless: false, headlessMode: 'headed' });
    expect(resolveBrowserConfig({ browser: { headless: true } }, disp, { interactive: true, platform: 'linux' }).headless).toBe(true);
    expect(resolveBrowserConfig({ browser: { headless: 'auto' } }, disp, { interactive: true, platform: 'linux' }).headless).toBe(false);
    expect(resolveBrowserConfig(null, {}).headless).toBe(true); // callers without runtime info stay headless
    expect(hasDisplay({ CI: 'true', DISPLAY: ':0' }, 'linux')).toBe(false);
    expect(hasDisplay({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux')).toBe(true);
    expect(hasDisplay({ QODEX_NO_BROWSER: '1' }, 'darwin')).toBe(false);
  });

  it('stealth is off unless the user explicitly sets it', () => {
    expect(resolveBrowserConfig({}, {}).stealth).toBe(false);
    expect(resolveBrowserConfig({ browser: { stealth: true } }, {}).stealth).toBe(true);
  });

  it('hand-off keys: defaults, clamps, timeout follows Sentinel, the link TTL is never longer', () => {
    expect(resolveBrowserConfig({}, {})).toMatchObject({
      challengeAutoWaitSec: 20, challengeHandoff: 'auto', handoffTimeoutSec: 600, handoffLinkTtlSec: 600, hostPacingMs: 500,
    });
    const c = resolveBrowserConfig({
      sentinel: { remoteApprovalTimeoutSec: 120 },
      browser: { challengeAutoWaitSec: 999, challengeHandoff: 'bogus', hostPacingMs: 5000, handoffLinkTtlSec: 900 },
    }, {});
    expect(c).toMatchObject({ challengeAutoWaitSec: 120, challengeHandoff: 'auto', handoffTimeoutSec: 120, handoffLinkTtlSec: 120, hostPacingMs: 1000 });
    expect(resolveBrowserConfig({ browser: { challengeHandoff: 'report', handoffTimeoutSec: 45 } }, {}))
      .toMatchObject({ challengeHandoff: 'report', handoffTimeoutSec: 45, handoffLinkTtlSec: 45 });
  });

  it("a configured channel is honoured for a visible browser (the user's real Chrome); headless keeps Chromium first", () => {
    const deps = { platform: 'linux' as const, env: {}, homedir: '/home/me', existsSync: (p: string) => p === '/pw/chrome', readdirSync: () => [], isFile: () => true };
    expect(resolveBrowserExecutable({ channel: 'chrome', headless: false, playwrightExecutablePath: '/pw/chrome' }, deps)).toEqual({ channel: 'chrome', source: 'channel' });
    expect(resolveBrowserExecutable({ channel: 'chrome', headless: true, playwrightExecutablePath: '/pw/chrome' }, deps)).toEqual({ executablePath: '/pw/chrome', source: 'playwright' });
    expect(resolveBrowserExecutable({ executablePath: '/pw/chrome', channel: 'chrome', headless: false }, deps).source).toBe('config');
  });

  it('isLocalHost: loopback / LAN / .local hosts are never paced', () => {
    for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.1.5', '172.20.0.1', '169.254.1.1', '::1', '[::1]', 'printer.local', 'app.localhost']) {
      expect(isLocalHost(h), h).toBe(true);
    }
    for (const h of ['shop.example', '8.8.8.8', '172.32.0.1', 'example.com']) expect(isLocalHost(h), h).toBe(false);
  });
});

/** A fake Playwright that records the launch options (no browser is started). */
function fakePlaywright(record: Array<Record<string, any>>) {
  const page: any = {
    on() {}, url: () => 'about:blank', isClosed: () => false, bringToFront: async () => {}, title: async () => '',
    frames: () => [], mainFrame: () => ({}), opener: async () => null, close: async () => {},
  };
  const ctx: any = {
    on() {}, pages: () => [page], newPage: async () => page, browser: () => ({ version: () => '1.0' }), addInitScript: async () => {}, close: async () => {},
  };
  return {
    chromium: {
      executablePath: () => '',
      launchPersistentContext: async (_dir: string, opts: Record<string, any>) => { record.push(opts); return ctx; },
    },
  };
}

describe('launch options', () => {
  const launcherDeps = { platform: 'linux' as const, env: {}, homedir: '/home/me', existsSync: (p: string) => p === '/fake/chrome', readdirSync: () => [], isFile: () => true };
  const mk = (config: Record<string, unknown>, record: Array<Record<string, any>>) => new QodexBrowserManager({
    profilesDir: path.join(os.tmpdir(), `qx-ho-launch-${process.pid}`),
    config: { executablePath: '/fake/chrome', ...config } as any,
    loadPlaywright: async () => fakePlaywright(record),
    launcherDeps,
  });

  it('default: no AutomationControlled flag, --enable-automation kept, no stealth script; headless keeps its viewport', async () => {
    const rec: Array<Record<string, any>> = [];
    const m = mk({ headless: true }, rec);
    await m.ensure();
    expect(rec[0]!.args).not.toContain('--disable-blink-features=AutomationControlled');
    expect(rec[0]!.ignoreDefaultArgs).toBeUndefined();
    expect(rec[0]!.viewport).toEqual({ width: 1280, height: 800 });
    await m.close();
  });

  it('headed uses the real window (viewport null + a window size)', async () => {
    const rec: Array<Record<string, any>> = [];
    const m = mk({ headless: false }, rec);
    await m.ensure();
    expect(rec[0]!.viewport).toBeNull();
    expect(rec[0]!.args).toContain('--window-size=1280,800');
    await m.close();
  });

  it('only an explicit stealth: true brings the old flags back', async () => {
    const rec: Array<Record<string, any>> = [];
    const m = mk({ headless: true, stealth: true }, rec);
    await m.ensure();
    expect(rec[0]!.args).toContain('--disable-blink-features=AutomationControlled');
    expect(rec[0]!.ignoreDefaultArgs).toEqual(['--enable-automation']);
    await m.close();
  });
});

describe('per-host pacing and the challenge-reload counter', () => {
  it('spaces agent actions on the same public host, never on local hosts', async () => {
    const m = new QodexBrowserManager({ profilesDir: path.join(os.tmpdir(), 'qx-ho-pace'), config: { hostPacingMs: 200 } });
    expect(await m.paceHost('https://shop.example/a')).toBe(0);
    const t0 = Date.now();
    const waited = await m.paceHost('https://shop.example/b');
    expect(waited).toBeGreaterThan(100);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(waited - 5);
    expect(await m.paceHost('https://other.example/')).toBe(0);
    expect(await m.paceHost('http://127.0.0.1:3000/')).toBe(0);
    expect(await m.paceHost('http://127.0.0.1:3000/x')).toBe(0);
  });

  it('counts loads that ended on a challenge per URL (no query), and resets', () => {
    const m = new QodexBrowserManager({ profilesDir: path.join(os.tmpdir(), 'qx-ho-pace') });
    m.noteChallengeLoad('https://shop.example/login?a=1', true);
    m.noteChallengeLoad('https://shop.example/login?b=2', true);
    expect(m.challengeLoadCount('https://shop.example/login')).toBe(2);
    m.noteChallengeLoad('https://shop.example/login', false);
    expect(m.challengeLoadCount('https://shop.example/login')).toBe(0);
  });
});
