/**
 * Chromium executable discovery for the dedicated QodeX Browser.
 *
 * Playwright pins one exact Chromium revision per release and, by default,
 * refuses to launch anything else ("Executable doesn't exist at
 * .../chromium-1228/..."). In practice users have a different revision cached,
 * a system Chrome, or a pre-provisioned browsers dir (CI images,
 * PLAYWRIGHT_BROWSERS_PATH), so QodeX resolves a working executable itself:
 *
 *   1. explicit `browser.executablePath` / QODEX_BROWSER_EXECUTABLE
 *   2. Playwright's own `chromium.executablePath()` when that file exists
 *   3. Playwright browser caches (PLAYWRIGHT_BROWSERS_PATH, ~/.cache/ms-playwright,
 *      ~/Library/Caches/ms-playwright, %LOCALAPPDATA%\ms-playwright): the newest
 *      `chromium-<rev>` build, plus `<cache>/chromium` style symlinks
 *   4. installed system browsers (Chrome, Chromium, Edge, Brave) per OS
 *   5. headless-shell builds from the caches (headless launches only)
 *   6. a configured Playwright `channel` ('chrome', 'msedge', ...)
 *
 * For a VISIBLE (headed) browser a configured `channel` wins right after an explicit
 * executable: the user's real Google Chrome / Edge instead of a test Chromium (a
 * legitimate way to look like the browser it is — no spoofing).
 *
 * `resolveBrowserExecutable` is PURE: every filesystem / environment access goes
 * through injectable deps so discovery is unit-testable for every OS on any OS.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface LauncherDeps {
  existsSync: (p: string) => boolean;
  readdirSync: (p: string) => string[];
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homedir: string;
  /** True for a regular file (symlinks followed). Optional; derived from readdirSync when absent. */
  isFile?: (p: string) => boolean;
}

export interface ResolveExecutableOptions {
  /** Explicit executable (config `browser.executablePath`; env QODEX_BROWSER_EXECUTABLE is also read). */
  executablePath?: string;
  /** Playwright channel fallback ('chrome', 'msedge', ...). */
  channel?: string;
  /** What Playwright's `chromium.executablePath()` returned (may not exist on disk). */
  playwrightExecutablePath?: string;
  /** Allow headless-shell builds (they cannot open a visible window). */
  headless?: boolean;
}

export interface ResolvedExecutable {
  executablePath?: string;
  channel?: string;
  /** Where the answer came from: 'config', 'playwright', 'cache:<dir>', 'system', 'channel', 'none'. */
  source: string;
  /** Non-fatal notes (e.g. a configured path that does not exist). */
  warnings?: string[];
}

export const defaultLauncherDeps = (): LauncherDeps => ({
  existsSync: (p: string) => {
    try { return fs.existsSync(p); } catch { return false; }
  },
  readdirSync: (p: string) => {
    try { return fs.readdirSync(p); } catch { return []; }
  },
  platform: process.platform,
  env: process.env,
  homedir: os.homedir(),
  isFile: (p: string) => {
    try { return fs.statSync(p).isFile(); } catch { return false; }
  },
});

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** Relative paths of a Chromium binary inside a `chromium-<rev>` cache dir, per OS. */
export function chromiumBinaryCandidates(platform: NodeJS.Platform): string[][] {
  if (platform === 'darwin') {
    return [
      ['chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
      ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
      ['chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
      ['chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
      ['chrome-mac', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
    ];
  }
  if (platform === 'win32') {
    return [['chrome-win64', 'chrome.exe'], ['chrome-win', 'chrome.exe']];
  }
  return [['chrome-linux64', 'chrome'], ['chrome-linux', 'chrome']];
}

/** Relative paths of a headless-shell binary inside a `chromium_headless_shell-<rev>` dir. */
function headlessShellCandidates(platform: NodeJS.Platform): string[][] {
  if (platform === 'darwin') {
    return [
      ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell'],
      ['chrome-headless-shell-mac-x64', 'chrome-headless-shell'],
      ['chrome-mac', 'headless_shell'],
      ['chrome-mac-arm64', 'headless_shell'],
    ];
  }
  if (platform === 'win32') {
    return [['chrome-headless-shell-win64', 'chrome-headless-shell.exe'], ['chrome-win', 'headless_shell.exe']];
  }
  return [['chrome-headless-shell-linux64', 'chrome-headless-shell'], ['chrome-linux', 'headless_shell']];
}

/** Playwright browser cache directories to scan, most specific first. */
export function playwrightCacheDirs(deps: LauncherDeps): string[] {
  const p = pathApi(deps.platform);
  const dirs: string[] = [];
  const custom = deps.env.PLAYWRIGHT_BROWSERS_PATH;
  if (custom && custom !== '0') dirs.push(custom);
  if (deps.platform === 'darwin') {
    dirs.push(p.join(deps.homedir, 'Library', 'Caches', 'ms-playwright'));
  } else if (deps.platform === 'win32') {
    const local = deps.env.LOCALAPPDATA || p.join(deps.homedir, 'AppData', 'Local');
    dirs.push(p.join(local, 'ms-playwright'));
  } else {
    const xdg = deps.env.XDG_CACHE_HOME;
    if (xdg) dirs.push(p.join(xdg, 'ms-playwright'));
    dirs.push(p.join(deps.homedir, '.cache', 'ms-playwright'));
  }
  return Array.from(new Set(dirs));
}

/** Installed system browsers to try, in preference order (Chrome → Chromium → Edge → Brave). */
export function systemBrowserCandidates(deps: LauncherDeps): string[] {
  const p = pathApi(deps.platform);
  if (deps.platform === 'darwin') {
    const apps = [
      ['Google Chrome.app', 'Google Chrome'],
      ['Chromium.app', 'Chromium'],
      ['Microsoft Edge.app', 'Microsoft Edge'],
      ['Brave Browser.app', 'Brave Browser'],
      ['Google Chrome Canary.app', 'Google Chrome Canary'],
    ];
    const out: string[] = [];
    for (const root of ['/Applications', p.join(deps.homedir, 'Applications')]) {
      for (const [app, bin] of apps) out.push(p.join(root, app, 'Contents', 'MacOS', bin));
    }
    return out;
  }
  if (deps.platform === 'win32') {
    const roots = [
      deps.env.PROGRAMFILES || 'C:\\Program Files',
      deps.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)',
      deps.env.LOCALAPPDATA || p.join(deps.homedir, 'AppData', 'Local'),
    ];
    const rel = [
      ['Google', 'Chrome', 'Application', 'chrome.exe'],
      ['Chromium', 'Application', 'chrome.exe'],
      ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
      ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
    ];
    const out: string[] = [];
    for (const r of rel) for (const root of roots) out.push(p.join(root, ...r));
    return out;
  }
  // Linux / other unix
  return [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/opt/google/chrome/chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/local/bin/chromium',
    '/usr/bin/microsoft-edge-stable',
    '/usr/bin/microsoft-edge',
    '/opt/microsoft/msedge/msedge',
    '/usr/bin/brave-browser',
    '/usr/bin/brave',
    '/opt/brave.com/brave/brave',
  ];
}

/** A file (or symlink to one). Without an `isFile` dep, a path that lists no
 *  directory entries is treated as a file. */
function isFileLike(p: string, deps: LauncherDeps): boolean {
  if (deps.isFile) return deps.isFile(p);
  return deps.readdirSync(p).length === 0;
}

/** `chromium-1194` → 1194; non-matching names → null. */
function revisionOf(name: string, prefix: string): number | null {
  const m = new RegExp(`^${prefix}-(\\d+)$`).exec(name);
  return m ? Number(m[1]) : null;
}

function newestBuild(dir: string, prefix: string, candidates: string[][], deps: LauncherDeps): string | undefined {
  const p = pathApi(deps.platform);
  const builds = deps.readdirSync(dir)
    .map(name => ({ name, rev: revisionOf(name, prefix) }))
    .filter((b): b is { name: string; rev: number } => b.rev !== null)
    .sort((a, b) => b.rev - a.rev);
  for (const b of builds) {
    for (const rel of candidates) {
      const full = p.join(dir, b.name, ...rel);
      if (deps.existsSync(full)) return full;
    }
  }
  return undefined;
}

/**
 * Resolve the browser to launch. PURE (all I/O through `deps`).
 * Never throws; `{ source: 'none' }` means "let Playwright try its default".
 */
export function resolveBrowserExecutable(opts: ResolveExecutableOptions = {}, deps: LauncherDeps = defaultLauncherDeps()): ResolvedExecutable {
  const p = pathApi(deps.platform);
  const warnings: string[] = [];
  const withWarnings = (r: ResolvedExecutable): ResolvedExecutable => (warnings.length ? { ...r, warnings } : r);

  // 1. explicit
  const explicit = (opts.executablePath || deps.env.QODEX_BROWSER_EXECUTABLE || '').trim();
  if (explicit) {
    if (deps.existsSync(explicit)) return { executablePath: explicit, source: 'config' };
    warnings.push(`Configured browser executable not found: ${explicit} — falling back to auto-discovery.`);
  }

  // 1b. headed + a configured channel → the user's branded browser
  const configuredChannel = (opts.channel || '').trim();
  if (configuredChannel && opts.headless === false) return withWarnings({ channel: configuredChannel, source: 'channel' });

  // 2. Playwright's pinned revision, when it is actually installed
  const pwPath = (opts.playwrightExecutablePath || '').trim();
  if (pwPath && deps.existsSync(pwPath)) return withWarnings({ executablePath: pwPath, source: 'playwright' });

  // 3. Playwright caches: newest chromium-<rev>, then `<cache>/chromium` symlinks
  const caches = playwrightCacheDirs(deps);
  for (const dir of caches) {
    const found = newestBuild(dir, 'chromium', chromiumBinaryCandidates(deps.platform), deps);
    if (found) return withWarnings({ executablePath: found, source: `cache:${dir}` });
    for (const link of deps.platform === 'win32' ? ['chromium.exe', 'chrome.exe'] : ['chromium', 'chrome']) {
      const full = p.join(dir, link);
      if (deps.existsSync(full) && isFileLike(full, deps)) {
        return withWarnings({ executablePath: full, source: `cache:${dir}` });
      }
    }
  }

  // 4. system browsers
  for (const cand of systemBrowserCandidates(deps)) {
    if (deps.existsSync(cand)) return withWarnings({ executablePath: cand, source: 'system' });
  }

  // 5. headless shell (headless only — it has no UI)
  if (opts.headless) {
    for (const dir of caches) {
      const found = newestBuild(dir, 'chromium_headless_shell', headlessShellCandidates(deps.platform), deps);
      if (found) return withWarnings({ executablePath: found, source: `cache:${dir}` });
    }
  }

  // 6. channel
  const channel = (opts.channel || '').trim();
  if (channel) return withWarnings({ channel, source: 'channel' });

  return withWarnings({ source: 'none' });
}

/** Human-readable fix-it text for a launch that could not find a browser. */
export function missingBrowserHint(): string {
  return (
    'Fix: set QODEX_BROWSER_EXECUTABLE=/path/to/chrome (or browser.executablePath in ~/.qodex/config.yaml), ' +
    'install Google Chrome / Chromium, or run: npx playwright install chromium'
  );
}
