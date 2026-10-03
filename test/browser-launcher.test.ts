import { describe, it, expect } from 'vitest';
import {
  resolveBrowserExecutable,
  playwrightCacheDirs,
  systemBrowserCandidates,
  type LauncherDeps,
} from '../src/tools/browser/launcher.js';

/** Fake filesystem: `files` are executables, `dirs` maps a dir to its entries. */
function fakeDeps(opts: {
  platform: NodeJS.Platform;
  files?: string[];
  dirs?: Record<string, string[]>;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
}): LauncherDeps {
  const files = new Set(opts.files ?? []);
  const dirs = opts.dirs ?? {};
  return {
    platform: opts.platform,
    env: opts.env ?? {},
    homedir: opts.homedir ?? (opts.platform === 'win32' ? 'C:\\Users\\me' : opts.platform === 'darwin' ? '/Users/me' : '/home/me'),
    existsSync: (p: string) => files.has(p) || p in dirs,
    readdirSync: (p: string) => dirs[p] ?? [],
    isFile: (p: string) => files.has(p),
  };
}

describe('resolveBrowserExecutable — order of precedence', () => {
  it('uses an explicit executablePath when it exists', () => {
    const deps = fakeDeps({ platform: 'linux', files: ['/custom/chrome', '/usr/bin/google-chrome'] });
    expect(resolveBrowserExecutable({ executablePath: '/custom/chrome' }, deps)).toEqual({ executablePath: '/custom/chrome', source: 'config' });
  });

  it('reads QODEX_BROWSER_EXECUTABLE from the env', () => {
    const deps = fakeDeps({ platform: 'linux', files: ['/env/chrome'], env: { QODEX_BROWSER_EXECUTABLE: '/env/chrome' } });
    expect(resolveBrowserExecutable({}, deps).executablePath).toBe('/env/chrome');
  });

  it('falls back to discovery with a warning when the configured path is missing', () => {
    const deps = fakeDeps({ platform: 'linux', files: ['/usr/bin/chromium'] });
    const r = resolveBrowserExecutable({ executablePath: '/nope/chrome' }, deps);
    expect(r.executablePath).toBe('/usr/bin/chromium');
    expect(r.source).toBe('system');
    expect(r.warnings?.[0]).toMatch(/not found: \/nope\/chrome/);
  });

  it("prefers Playwright's own executable when it exists on disk", () => {
    const deps = fakeDeps({ platform: 'linux', files: ['/pw/chromium-1228/chrome-linux/chrome', '/usr/bin/google-chrome'] });
    expect(resolveBrowserExecutable({ playwrightExecutablePath: '/pw/chromium-1228/chrome-linux/chrome' }, deps))
      .toEqual({ executablePath: '/pw/chromium-1228/chrome-linux/chrome', source: 'playwright' });
  });

  it("skips Playwright's pinned path when that revision is not installed (the 1228 vs 1194 mismatch)", () => {
    const deps = fakeDeps({
      platform: 'linux',
      env: { PLAYWRIGHT_BROWSERS_PATH: '/opt/pw-browsers' },
      dirs: { '/opt/pw-browsers': ['chromium-1194', 'chromium_headless_shell-1194', 'ffmpeg-1011', 'chromium'] },
      files: ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium'],
    });
    const r = resolveBrowserExecutable({ playwrightExecutablePath: '/opt/pw-browsers/chromium-1228/chrome-linux/chrome' }, deps);
    expect(r.executablePath).toBe('/opt/pw-browsers/chromium-1194/chrome-linux/chrome');
    expect(r.source).toBe('cache:/opt/pw-browsers');
  });

  it('picks the NEWEST chromium-<rev> by revision number (not lexically)', () => {
    const deps = fakeDeps({
      platform: 'linux',
      dirs: { '/home/me/.cache/ms-playwright': ['chromium-999', 'chromium-1100', 'chromium-1050'] },
      files: [
        '/home/me/.cache/ms-playwright/chromium-999/chrome-linux/chrome',
        '/home/me/.cache/ms-playwright/chromium-1100/chrome-linux64/chrome',
        '/home/me/.cache/ms-playwright/chromium-1050/chrome-linux/chrome',
      ],
    });
    expect(resolveBrowserExecutable({}, deps).executablePath).toBe('/home/me/.cache/ms-playwright/chromium-1100/chrome-linux64/chrome');
  });

  it('skips a revision dir that has no binary', () => {
    const deps = fakeDeps({
      platform: 'linux',
      dirs: { '/home/me/.cache/ms-playwright': ['chromium-1200', 'chromium-1100'] },
      files: ['/home/me/.cache/ms-playwright/chromium-1100/chrome-linux/chrome'],
    });
    expect(resolveBrowserExecutable({}, deps).executablePath).toBe('/home/me/.cache/ms-playwright/chromium-1100/chrome-linux/chrome');
  });

  it('accepts a `<cache>/chromium` symlink when no revision dir has a binary', () => {
    const deps = fakeDeps({
      platform: 'linux',
      env: { PLAYWRIGHT_BROWSERS_PATH: '/opt/pw-browsers' },
      dirs: { '/opt/pw-browsers': ['chromium'] },
      files: ['/opt/pw-browsers/chromium'],
    });
    expect(resolveBrowserExecutable({}, deps)).toEqual({ executablePath: '/opt/pw-browsers/chromium', source: 'cache:/opt/pw-browsers' });
  });

  it('ignores PLAYWRIGHT_BROWSERS_PATH=0 (node_modules-local browsers)', () => {
    const deps = fakeDeps({ platform: 'linux', env: { PLAYWRIGHT_BROWSERS_PATH: '0' } });
    expect(playwrightCacheDirs(deps)).not.toContain('0');
  });

  it('honours XDG_CACHE_HOME on linux', () => {
    const deps = fakeDeps({ platform: 'linux', env: { XDG_CACHE_HOME: '/xdg' } });
    expect(playwrightCacheDirs(deps)).toEqual(['/xdg/ms-playwright', '/home/me/.cache/ms-playwright']);
  });

  it('falls back to system browsers on linux (Chrome before Chromium before Edge/Brave)', () => {
    const deps = fakeDeps({ platform: 'linux', files: ['/snap/bin/chromium', '/usr/bin/brave-browser', '/usr/bin/google-chrome-stable'] });
    expect(resolveBrowserExecutable({}, deps)).toEqual({ executablePath: '/usr/bin/google-chrome-stable', source: 'system' });
    const deps2 = fakeDeps({ platform: 'linux', files: ['/snap/bin/chromium', '/usr/bin/brave-browser'] });
    expect(resolveBrowserExecutable({}, deps2).executablePath).toBe('/snap/bin/chromium');
  });

  it('uses headless-shell builds only for headless launches', () => {
    const deps = fakeDeps({
      platform: 'linux',
      env: { PLAYWRIGHT_BROWSERS_PATH: '/pw' },
      dirs: { '/pw': ['chromium_headless_shell-1194'] },
      files: ['/pw/chromium_headless_shell-1194/chrome-linux/headless_shell'],
    });
    expect(resolveBrowserExecutable({ headless: true }, deps).executablePath).toBe('/pw/chromium_headless_shell-1194/chrome-linux/headless_shell');
    expect(resolveBrowserExecutable({ headless: false }, deps).executablePath).toBeUndefined();
  });

  it('falls back to a configured channel, else source none', () => {
    const deps = fakeDeps({ platform: 'linux' });
    expect(resolveBrowserExecutable({ channel: 'chrome' }, deps)).toEqual({ channel: 'chrome', source: 'channel' });
    expect(resolveBrowserExecutable({}, deps)).toEqual({ source: 'none' });
  });
});

describe('resolveBrowserExecutable — macOS', () => {
  it('finds Chromium.app inside an arm64 Playwright cache', () => {
    const base = '/Users/me/Library/Caches/ms-playwright';
    const bin = `${base}/chromium-1194/chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium`;
    const deps = fakeDeps({ platform: 'darwin', dirs: { [base]: ['chromium-1194'] }, files: [bin] });
    expect(resolveBrowserExecutable({}, deps)).toEqual({ executablePath: bin, source: `cache:${base}` });
  });

  it('finds Chrome for Testing builds (newer Playwright)', () => {
    const base = '/Users/me/Library/Caches/ms-playwright';
    const bin = `${base}/chromium-1228/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
    const deps = fakeDeps({ platform: 'darwin', dirs: { [base]: ['chromium-1228'] }, files: [bin] });
    expect(resolveBrowserExecutable({}, deps).executablePath).toBe(bin);
  });

  it('falls back to /Applications browsers, then ~/Applications', () => {
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const brave = '/Users/me/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
    expect(resolveBrowserExecutable({}, fakeDeps({ platform: 'darwin', files: [brave, chrome] })).executablePath).toBe(chrome);
    expect(resolveBrowserExecutable({}, fakeDeps({ platform: 'darwin', files: [brave] })).executablePath).toBe(brave);
    expect(systemBrowserCandidates(fakeDeps({ platform: 'darwin' }))).toContain('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  });
});

describe('resolveBrowserExecutable — Windows', () => {
  it('finds chrome.exe in %LOCALAPPDATA%\\ms-playwright', () => {
    const base = 'C:\\Users\\me\\AppData\\Local\\ms-playwright';
    const bin = `${base}\\chromium-1194\\chrome-win\\chrome.exe`;
    const deps = fakeDeps({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, dirs: { [base]: ['chromium-1194'] }, files: [bin] });
    expect(resolveBrowserExecutable({}, deps)).toEqual({ executablePath: bin, source: `cache:${base}` });
  });

  it('prefers chrome-win64 builds', () => {
    const base = 'C:\\pw';
    const bin = `${base}\\chromium-1228\\chrome-win64\\chrome.exe`;
    const deps = fakeDeps({ platform: 'win32', env: { PLAYWRIGHT_BROWSERS_PATH: base }, dirs: { [base]: ['chromium-1228'] }, files: [bin, `${base}\\chromium-1228\\chrome-win\\chrome.exe`] });
    expect(resolveBrowserExecutable({}, deps).executablePath).toBe(bin);
  });

  it('falls back to Program Files Chrome / Edge', () => {
    const env = { PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' };
    const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    const chrome = 'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
    expect(resolveBrowserExecutable({}, fakeDeps({ platform: 'win32', env, files: [edge, chrome] })).executablePath).toBe(chrome);
    expect(resolveBrowserExecutable({}, fakeDeps({ platform: 'win32', env, files: [edge] }))).toEqual({ executablePath: edge, source: 'system' });
  });
});
