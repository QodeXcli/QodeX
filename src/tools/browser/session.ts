/**
 * The dedicated QodeX Browser — one persistent Chromium the agent owns.
 *
 * `QodexBrowserManager` implements the BrowserManager contract (types.ts):
 *
 *   - Persistent profile: `launchPersistentContext(~/.qodex/browser/profiles/<name>)`
 *     so logins, cookies and localStorage survive restarts (`qodex browser open`
 *     lets the user log in once by hand). A profile locked by another Chromium
 *     falls back to `<name>-<pid>` with a notice instead of failing.
 *   - Or attach to the user's own Chrome over CDP (`browser.cdpUrl`); `close()`
 *     then only disconnects — it never kills the user's browser.
 *   - Executable discovery (launcher.ts) so a Playwright/Chromium revision
 *     mismatch, a system Chrome, or PLAYWRIGHT_BROWSERS_PATH all just work.
 *   - Multi-tab: every page of the context is tracked with its own console /
 *     error / network buffers; a popup opened from the active tab becomes the
 *     active tab and is announced on the next tool result.
 *   - Dialogs per `browser.dialogPolicy`, downloads saved to
 *     ~/.qodex/browser/downloads, live screencast (CDP) for the control center,
 *     human takeover (agent actions wait), human input dispatch, element
 *     introspection for Sentinel and an action feed for the workflow recorder.
 *
 * Playwright is an OPTIONAL dependency: it is imported dynamically on first
 * launch and all its objects are typed `any`.
 *
 * Signals: this module installs NO process signal listeners. Playwright's own
 * launcher kills the Chromium it spawned when the process exits (and closes it
 * gracefully on SIGINT/SIGTERM/SIGHUP, as it always did for QodeX).
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { logger } from '../../utils/logger.js';
import { getActiveConfig } from '../../config/loader.js';
import { resolveBrowserConfig, type BrowserConfig } from '../../config/agent-config.js';
import {
  QODEX_BROWSER_PROFILES_DIR,
  QODEX_BROWSER_DOWNLOADS_DIR,
  browserProfileDir,
  sanitizeName,
} from '../../config/paths.js';
import { getBus } from '../../control/bus.js';
import { resolveBrowserExecutable, missingBrowserHint, type LauncherDeps, type ResolvedExecutable } from './launcher.js';
import {
  takeSnapshotDetailed,
  snapshotWithBoxes,
  DESCRIBE_ELEMENT_FN,
  DESCRIBE_AT_POINT_FN,
  DESCRIBE_ELEMENT_JS,
  REF_RE,
  type SnapshotOptions,
  type SnapshotResult,
  type MarkBox,
} from './snapshot.js';
import {
  registerBrowserManagerFactory,
  getBrowserManager,
  peekBrowserManager,
  type BrowserManager,
  type BrowserStatus,
  type TabInfo,
  type ScreencastFrame,
  type ElementInfo,
  type BrowserActionRecord,
  type HumanInputEvent,
  type LaunchOverrides,
} from './types.js';

type Page = any;
type BrowserContext = any;

// ── buffers / records ───────────────────────────────────────────────────────

export interface ConsoleEntry { type: string; text: string; location?: string; ts: number }
export interface PageErrorEntry { message: string; stack?: string; ts: number }
export interface RequestEntry { url: string; method: string; resourceType?: string; status?: number; ok?: boolean; failure?: string; ts: number }

export interface DownloadEntry {
  id: string;
  url: string;
  suggestedFilename: string;
  /** Final path on disk ('' until a name is reserved). */
  path: string;
  state: 'in_progress' | 'completed' | 'failed';
  error?: string;
  bytes?: number;
  startedAt: number;
  finishedAt?: number;
  tabId?: string;
  /** Already returned by waitForDownload (so the next wait looks for a newer one). */
  claimed?: boolean;
}

export interface DialogEntry {
  id: string;
  type: string;
  message: string;
  defaultValue?: string;
  url: string;
  tabId: string;
  action: 'pending' | 'accepted' | 'dismissed' | 'auto-dismissed';
  ts: number;
}

interface TabState {
  id: string;
  page: Page;
  title: string;
  console: ConsoleEntry[];
  errors: PageErrorEntry[];
  requests: RequestEntry[];
  /** Ref flavour of the latest snapshot on this tab (aria-ref vs data-qx-ref). */
  refMode: 'aria' | 'dom' | null;
  pendingDialog: { entry: DialogEntry; dialog: any; timer: NodeJS.Timeout } | null;
}

interface CastSub {
  onFrame: (f: ScreencastFrame) => void;
  quality: number;
  minIntervalMs: number;
  last: number;
  session: any | null;
  page: Page | null;
  stopped: boolean;
  chain: Promise<void>;
}

export const CONSOLE_CAP = 500;
export const ERROR_CAP = 100;
export const REQUEST_CAP = 500;
const DOWNLOAD_CAP = 200;
const DIALOG_HISTORY_CAP = 50;

/** Append and drop the oldest entries beyond `max`. */
export function pushCapped<T>(arr: T[], item: T, max: number): void {
  arr.push(item);
  if (arr.length > max) arr.splice(0, arr.length - max);
}

function firstLine(e: unknown): string {
  const msg = (e as any)?.message ?? String(e);
  return String(msg).split('\n')[0].slice(0, 400);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => { const t = setTimeout(r, ms); (t as any).unref?.(); });
}

// ── small pure helpers shared with the tools ────────────────────────────────

/**
 * Make a model-typed address loadable: `digikala.com` → `https://digikala.com`,
 * `localhost:3000` → `http://localhost:3000`. Anything with a scheme is
 * returned unchanged. PURE.
 */
export function normalizeUrl(raw: string): string {
  const s = String(raw ?? '').trim();
  if (!s) return s;
  if (/^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[[0-9a-f:]+\])(:\d+)?([/?#]|$)/i.test(s)) return 'http://' + s;
  if (/^(\d{1,3}\.){3}\d{1,3}(:\d+)?([/?#]|$)/.test(s)) return 'http://' + s;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  if (/^(about|data|javascript|file|chrome|blob|mailto|tel|view-source|edge|brave):/i.test(s)) return s;
  if (s.startsWith('//')) return 'https:' + s;
  if (/^[^\s/?#:@]+\.[^\s/?#:@.]{2,}(:\d+)?([/?#]|$)/u.test(s)) return 'https://' + s;
  return s;
}

const KEY_ALIASES: Record<string, string> = {
  enter: 'Enter', return: 'Enter', esc: 'Escape', escape: 'Escape', tab: 'Tab',
  space: 'Space', spacebar: 'Space', backspace: 'Backspace', delete: 'Delete', del: 'Delete',
  insert: 'Insert', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
  pgup: 'PageUp', pgdn: 'PageDown', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft',
  right: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight', ctrl: 'Control', control: 'Control', cmd: 'Meta', command: 'Meta',
  meta: 'Meta', win: 'Meta', super: 'Meta', alt: 'Alt', option: 'Alt', opt: 'Alt', shift: 'Shift',
  controlormeta: 'ControlOrMeta',
};

/** `ctrl+a` → `Control+a`, `esc` → `Escape`, `f5` → `F5`. Playwright key syntax. PURE. */
export function normalizeKey(raw: string): string {
  const s = String(raw ?? '').trim();
  if (!s || s === '+') return s;
  // "Control++" means Control and the "+" key.
  const plusKey = s.endsWith('++');
  const body = plusKey ? s.slice(0, -2) : s;
  const parts = body
    .split('+')
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => {
      const lower = p.toLowerCase();
      if (KEY_ALIASES[lower]) return KEY_ALIASES[lower];
      if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) return lower.toUpperCase();
      return p.length === 1 ? p : p[0].toUpperCase() + p.slice(1);
    });
  if (plusKey) parts.push('+');
  return parts.join('+');
}

/** Width/height from a base64 JPEG's SOF segment (null if not parseable). PURE. */
export function jpegSize(base64: string): { width: number; height: number } | null {
  let buf: Buffer;
  try { buf = Buffer.from(base64, 'base64'); } catch { return null; }
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

/** File name safe on every OS, deduplicated against `taken`. PURE. */
export function dedupFilename(suggested: string, taken: (name: string) => boolean): string {
  let base = String(suggested ?? '')
    .replace(/[/\\?%*:|"<>\x00-\x1f]/g, '_')
    .replace(/^[.\s]+/, '')
    .trim()
    .slice(0, 180);
  if (!base) base = 'download';
  if (!taken(base)) return base;
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  for (let n = 1; n < 10_000; n++) {
    const cand = `${stem} (${n})${ext}`;
    if (!taken(cand)) return cand;
  }
  return `${stem}-${Date.now()}${ext}`;
}

/** Profile lock by another Chromium (Linux/macOS/Windows wording). */
export function isProfileLockedError(e: unknown): boolean {
  return /SingletonLock|ProcessSingleton|user data directory is already in use|profile appears to be in use|profile directory is already in use/i.test((e as any)?.message ?? String(e));
}

function isMissingDisplayError(e: unknown): boolean {
  return /Missing X server|\$DISPLAY|cannot open display|no display|headed browser without having a XServer/i.test((e as any)?.message ?? String(e));
}

/** Turn a raw Playwright launch error into a `[BROWSER_LAUNCH_FAILED]` with a fix. */
export function explainLaunchError(e: unknown, exe: ResolvedExecutable | null): Error {
  const msg = (e as any)?.message ?? String(e);
  const where = exe?.executablePath ? ` (executable: ${exe.executablePath}, found via ${exe.source})` : exe?.channel ? ` (channel: ${exe.channel})` : '';
  if (/Executable doesn't exist|ENOENT|no such file or directory|browserType\.launch.*not found|Chromium distribution .* is not found/i.test(msg)) {
    return new Error(`[BROWSER_LAUNCH_FAILED] No usable Chromium/Chrome was found${where}. ${missingBrowserHint()}`);
  }
  if (isMissingDisplayError(e)) {
    return new Error(
      `[BROWSER_LAUNCH_FAILED] A visible (headed) browser needs a display, but none is available. ` +
      `Run headless (browser.headless: true, unset QODEX_BROWSER_HEADED), use xvfb-run, or run QodeX in a desktop session.`,
    );
  }
  if (/missing dependencies|error while loading shared libraries/i.test(msg)) {
    return new Error(`[BROWSER_LAUNCH_FAILED] Chromium is missing system libraries${where}. Fix (Linux): npx playwright install-deps chromium — or install Google Chrome.`);
  }
  return new Error(`[BROWSER_LAUNCH_FAILED] ${firstLine(e)}${where}. If this keeps happening: ${missingBrowserHint()}`);
}

export const PLAYWRIGHT_MISSING_MESSAGE =
  '[PLAYWRIGHT_MISSING] The QodeX browser needs the optional `playwright` package. Install it in the QodeX ' +
  'installation: `npm install playwright` (then `npx playwright install chromium`, or point ' +
  'QODEX_BROWSER_EXECUTABLE at an installed Chrome/Chromium).';

async function importPlaywright(): Promise<any> {
  const name = 'playwright';
  try {
    const mod: any = await import(name);
    return mod?.chromium ? mod : mod?.default ?? mod;
  } catch {
    throw new Error(PLAYWRIGHT_MISSING_MESSAGE);
  }
}

/** Modest fingerprint hygiene; never breaks a page (every patch is try/catch'd). */
function stealthScript(languages: string[]): string {
  return `(() => {
  try {
    const proto = Object.getPrototypeOf(navigator);
    Object.defineProperty(proto, 'webdriver', { get: () => undefined, configurable: true });
  } catch (e) {}
  try {
    if (!navigator.languages || navigator.languages.length === 0) {
      const langs = ${JSON.stringify(languages)};
      Object.defineProperty(Object.getPrototypeOf(navigator), 'languages', { get: () => langs.slice(), configurable: true });
    }
  } catch (e) {}
  try {
    if (navigator.plugins && navigator.plugins.length === 0) {
      const names = ['PDF Viewer', 'Chrome PDF Viewer', 'Chromium PDF Viewer'];
      const fake = names.map((n) => ({ name: n, filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 }));
      fake.item = (i) => fake[i] || null;
      fake.namedItem = (n) => fake.find((p) => p.name === n) || null;
      fake.refresh = () => {};
      Object.defineProperty(Object.getPrototypeOf(navigator), 'plugins', { get: () => fake, configurable: true });
    }
  } catch (e) {}
  try {
    if (!window.chrome) Object.defineProperty(window, 'chrome', { value: { runtime: {} }, configurable: true, writable: true });
  } catch (e) {}
})();`;
}

function languagesFor(locale: string): string[] {
  const l = locale.trim();
  if (!l) return ['en-US', 'en'];
  const base = l.split('-')[0];
  const out = [l];
  if (base && base !== l) out.push(base);
  if (base !== 'en') out.push('en-US', 'en');
  return Array.from(new Set(out));
}

// ── manager ─────────────────────────────────────────────────────────────────

export interface QodexBrowserManagerOptions {
  /** Base dir of persistent profiles (tests pass a tmp dir). Default ~/.qodex/browser/profiles. */
  profilesDir?: string;
  /** Where downloads are saved. Default ~/.qodex/browser/downloads. */
  downloadsDir?: string;
  /** Overrides applied on top of `resolveBrowserConfig(getActiveConfig())`. */
  config?: Partial<BrowserConfig>;
  /** Inject the playwright module (tests). */
  loadPlaywright?: () => Promise<any>;
  /** Inject executable-discovery deps (tests). */
  launcherDeps?: LauncherDeps;
  /** 'ask' dialog policy: auto-dismiss after this many ms. Default 30000. */
  dialogAutoDismissMs?: number;
}

/** Extended status: the contract fields plus diagnostics for `browser_status`. */
export interface QodexBrowserStatus extends BrowserStatus {
  executableSource?: string;
  cdpUrl?: string;
  /** e.g. "profile 'default' was locked; using 'default-1234'". */
  notice?: string;
  downloads: number;
  pendingDialog?: { type: string; message: string };
}

export class QodexBrowserManager implements BrowserManager {
  readonly profilesDir: string;
  readonly downloadsDir: string;
  private readonly opts: QodexBrowserManagerOptions;

  private pw: any = null;
  private ctx: BrowserContext | null = null;
  private cdpBrowser: any = null;
  private mode: 'launch' | 'cdp' | 'none' = 'none';
  private launching: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private launchedCfg: BrowserConfig | null = null;
  private profileInUse = '';
  private exe: ResolvedExecutable | null = null;
  private browserVersion: string | undefined;
  private profileNotice: string | undefined;

  private tabList: TabState[] = [];
  private activeTab: TabState | null = null;
  private tabSeq = 0;
  private pendingAttach = new Set<Promise<void>>();
  private notices: Array<string | (() => string)> = [];
  private static readonly NOTICE_CAP = 20;

  private takeoverOn = false;
  private takeoverWho: string | undefined;
  private takeoverWaiters = new Set<() => void>();

  private actionListeners = new Set<(rec: BrowserActionRecord) => void>();
  private events = new EventEmitter();
  private casts = new Set<CastSub>();

  private downloadList: DownloadEntry[] = [];
  private downloadDone = new Map<string, Promise<DownloadEntry>>();
  private reservedNames = new Set<string>();
  private downloadSeq = 0;
  private dialogHistory: DialogEntry[] = [];
  private dialogSeq = 0;

  constructor(opts: QodexBrowserManagerOptions = {}) {
    this.opts = opts;
    this.profilesDir = opts.profilesDir ?? QODEX_BROWSER_PROFILES_DIR;
    this.downloadsDir = opts.downloadsDir ?? QODEX_BROWSER_DOWNLOADS_DIR;
    this.events.setMaxListeners(0);
  }

  /** Effective config right now (active QodeX config + constructor overrides). */
  currentConfig(): BrowserConfig {
    const base = resolveBrowserConfig(getActiveConfig());
    const o = this.opts.config;
    if (!o) return base;
    return { ...base, ...o, viewport: { ...base.viewport, ...(o.viewport ?? {}) } };
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  async ensure(overrides?: LaunchOverrides): Promise<void> {
    if (this.ctx) return;
    if (this.closing) await this.closing.catch(() => {});
    if (this.ctx) return;
    if (!this.launching) {
      this.launching = this.launch(overrides).finally(() => { this.launching = null; });
    }
    return this.launching;
  }

  isRunning(): boolean {
    return this.ctx !== null;
  }

  private async loadPlaywright(): Promise<any> {
    if (this.pw) return this.pw;
    let mod: any;
    try {
      mod = this.opts.loadPlaywright ? await this.opts.loadPlaywright() : await importPlaywright();
    } catch (e) {
      throw new Error(String((e as any)?.message ?? '').startsWith('[PLAYWRIGHT_MISSING]') ? (e as any).message : PLAYWRIGHT_MISSING_MESSAGE);
    }
    if (!mod?.chromium) throw new Error(PLAYWRIGHT_MISSING_MESSAGE);
    this.pw = mod;
    return mod;
  }

  private async launch(over?: LaunchOverrides): Promise<void> {
    const base = this.currentConfig();
    const cfg: BrowserConfig = {
      ...base,
      headless: over?.headless ?? base.headless,
      profile: over?.profile ?? base.profile,
      cdpUrl: over?.cdpUrl ?? base.cdpUrl,
    };
    const pw = await this.loadPlaywright();
    this.profileNotice = undefined;
    if (cfg.cdpUrl) await this.attachCdp(pw, cfg);
    else await this.launchPersistent(pw, cfg, over?.headless === undefined);
    this.launchedCfg = cfg;

    const ctx = this.ctx;
    ctx.on('page', (p: Page) => { this.attachPage(p); });
    ctx.on('close', () => this.onContextClosed(ctx));
    for (const p of ctx.pages()) this.attachPage(p, { initial: true });

    if (this.mode === 'cdp') {
      // Never hijack the user's current tab: the agent works in its own tab.
      const p = await ctx.newPage();
      this.activate(this.attachPage(p, { initial: true }));
    } else if (!this.activeTab) {
      const first = this.tabList[0] ?? this.attachPage(await ctx.newPage(), { initial: true });
      this.activate(first);
    }

    getBus().publish({
      kind: 'browser',
      type: 'launched',
      data: { mode: this.mode, headless: this.mode === 'cdp' ? false : cfg.headless, profile: this.profileInUse, executable: this.exe?.executablePath, version: this.browserVersion },
    });
    logger.info('QodeX browser ready', { mode: this.mode, profile: this.profileInUse, executable: this.exe?.executablePath, source: this.exe?.source });
    this.followCasts();
  }

  private async attachCdp(pw: any, cfg: BrowserConfig): Promise<void> {
    let browser: any;
    try {
      browser = await pw.chromium.connectOverCDP(cfg.cdpUrl);
    } catch (e) {
      throw new Error(
        `[BROWSER_LAUNCH_FAILED] Could not attach to Chrome at ${cfg.cdpUrl}: ${firstLine(e)}. ` +
        'Start Chrome with --remote-debugging-port=9222 (and a separate --user-data-dir), or clear browser.cdpUrl / QODEX_BROWSER_CDP_URL to let QodeX launch its own browser.',
      );
    }
    const ctx = browser.contexts()[0] ?? await browser.newContext({ viewport: cfg.viewport, acceptDownloads: true });
    browser.on('disconnected', () => this.onContextClosed(ctx));
    this.cdpBrowser = browser;
    this.ctx = ctx;
    this.mode = 'cdp';
    this.profileInUse = '(user Chrome via CDP)';
    this.exe = { source: 'cdp' };
    try { this.browserVersion = browser.version(); } catch { this.browserVersion = undefined; }
  }

  private async launchPersistent(pw: any, cfg: BrowserConfig, allowHeadlessFallback: boolean): Promise<void> {
    let pwExe = '';
    try { pwExe = String(pw.chromium.executablePath?.() ?? ''); } catch { pwExe = ''; }
    const exe = resolveBrowserExecutable(
      { executablePath: cfg.executablePath, channel: cfg.channel, playwrightExecutablePath: pwExe, headless: cfg.headless },
      this.opts.launcherDeps,
    );
    this.exe = exe;
    for (const w of exe.warnings ?? []) { logger.warn(w); this.notice(w); }

    const options: Record<string, unknown> = {
      headless: cfg.headless,
      viewport: { ...cfg.viewport },
      acceptDownloads: true,
      args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
    };
    if (cfg.stealth) options.ignoreDefaultArgs = ['--enable-automation'];
    if (exe.executablePath) options.executablePath = exe.executablePath;
    else if (exe.channel) options.channel = exe.channel;
    if (cfg.userAgent) options.userAgent = cfg.userAgent;
    if (cfg.locale) options.locale = cfg.locale;
    if (cfg.timezone) options.timezoneId = cfg.timezone;

    const open = async (profile: string, opts: Record<string, unknown>) => {
      const dir = browserProfileDir(profile, this.profilesDir);
      await fs.mkdir(dir, { recursive: true });
      return pw.chromium.launchPersistentContext(dir, opts);
    };

    let profile = sanitizeName(cfg.profile) || 'default';
    let ctx: any;
    try {
      ctx = await open(profile, options);
    } catch (e) {
      if (isProfileLockedError(e)) {
        const alt = `${profile}-${process.pid}`;
        try {
          ctx = await open(alt, options);
        } catch (e2) {
          throw explainLaunchError(e2, exe);
        }
        this.profileNotice = `Browser profile "${profile}" is in use by another browser; this session uses "${alt}" (logins saved in "${profile}" are not available until that browser closes).`;
        this.notice(this.profileNotice);
        logger.warn(this.profileNotice);
        profile = alt;
      } else if (!cfg.headless && allowHeadlessFallback && isMissingDisplayError(e)) {
        try {
          ctx = await open(profile, { ...options, headless: true });
        } catch (e2) {
          throw explainLaunchError(e2, exe);
        }
        cfg.headless = true;
        this.notice('No display is available for a visible browser — running headless instead.');
      } else {
        throw explainLaunchError(e, exe);
      }
    }

    this.ctx = ctx;
    this.cdpBrowser = null;
    this.mode = 'launch';
    this.profileInUse = profile;
    try { this.browserVersion = ctx.browser?.()?.version?.(); } catch { this.browserVersion = undefined; }
    if (cfg.stealth) {
      try { await ctx.addInitScript(stealthScript(languagesFor(cfg.locale))); } catch (e) { logger.debug('stealth init script failed', { err: firstLine(e) }); }
    }
  }

  /** Reset to "not running" after the context/browser went away (idempotent). */
  private onContextClosed(ctx: BrowserContext | null): void {
    if (ctx && this.ctx !== ctx) return;
    const wasRunning = this.ctx !== null;
    for (const st of this.tabList) {
      if (st.pendingDialog) clearTimeout(st.pendingDialog.timer);
    }
    for (const sub of this.casts) { sub.session = null; sub.page = null; }
    this.ctx = null;
    this.cdpBrowser = null;
    this.mode = 'none';
    this.tabList = [];
    this.activeTab = null;
    this.launchedCfg = null;
    if (wasRunning) getBus().publish({ kind: 'browser', type: 'closed', data: { profile: this.profileInUse } });
  }

  async close(): Promise<void> {
    if (this.launching) { try { await this.launching; } catch { /* launch failed: nothing to close */ } }
    if (this.closing) return this.closing;
    if (!this.ctx) return;
    const ctx = this.ctx;
    const browser = this.cdpBrowser;
    const mode = this.mode;
    this.closing = (async () => {
      await Promise.all([...this.casts].map(sub => this.detachCast(sub)));
      try {
        // CDP: Browser.close() on a connectOverCDP browser only drops the
        // connection — the user's Chrome keeps running.
        if (mode === 'cdp') await browser?.close();
        else await ctx.close();
      } catch (e) {
        logger.debug('browser close failed', { err: firstLine(e) });
      }
      this.onContextClosed(ctx);
    })().finally(() => { this.closing = null; });
    return this.closing;
  }

  async restart(overrides?: LaunchOverrides): Promise<void> {
    await this.close();
    await this.ensure(overrides);
  }

  // ── tabs ──────────────────────────────────────────────────────────────────

  private attachPage(page: Page, opts: { initial?: boolean } = {}): TabState {
    const existing = this.tabList.find(t => t.page === page);
    if (existing) return existing;
    const st: TabState = { id: `t${++this.tabSeq}`, page, title: '', console: [], errors: [], requests: [], refMode: null, pendingDialog: null };
    this.tabList.push(st);

    page.on('console', (msg: any) => {
      let location: string | undefined;
      try { location = msg.location()?.url || undefined; } catch { /* ignore */ }
      pushCapped(st.console, { type: String(msg.type()), text: String(msg.text()), location, ts: Date.now() }, CONSOLE_CAP);
    });
    page.on('pageerror', (err: any) => {
      pushCapped(st.errors, { message: String(err?.message ?? err), stack: err?.stack, ts: Date.now() }, ERROR_CAP);
    });
    page.on('requestfinished', (req: any) => {
      const base = { url: String(req.url()), method: String(req.method()), resourceType: safe(() => req.resourceType()), ts: Date.now() };
      Promise.resolve()
        .then(() => req.response())
        .then((resp: any) => pushCapped(st.requests, { ...base, status: resp?.status(), ok: resp?.ok() }, REQUEST_CAP))
        .catch(() => pushCapped(st.requests, base, REQUEST_CAP));
    });
    page.on('requestfailed', (req: any) => {
      pushCapped(st.requests, {
        url: String(req.url()), method: String(req.method()), resourceType: safe(() => req.resourceType()),
        ok: false, failure: safe(() => req.failure()?.errorText) ?? 'failed', ts: Date.now(),
      }, REQUEST_CAP);
    });
    page.on('dialog', (d: any) => this.onDialog(st, d));
    page.on('download', (d: any) => this.onDownload(st, d));
    page.on('close', () => this.onPageClosed(st));
    page.on('framenavigated', (frame: any) => {
      try {
        if (frame !== page.mainFrame()) return;
      } catch { return; }
      st.refMode = null;
      getBus().publish({ kind: 'browser', type: 'navigated', data: { tab: st.id, index: this.tabList.indexOf(st), url: safeUrl(page) } });
    });
    page.on('domcontentloaded', () => { void this.refreshTitle(st); });
    page.on('load', () => { void this.refreshTitle(st); });

    if (!opts.initial) {
      // Popup / target=_blank from the active tab → becomes the active tab.
      const p: Promise<void> = (async () => {
        let opener: Page | null = null;
        try { opener = await page.opener(); } catch { opener = null; }
        if (opener && this.activeTab && opener === this.activeTab.page && this.tabList.includes(st)) {
          this.activate(st);
          this.notice(() => `New tab opened: ${safeUrl(page) || 'about:blank'}${st.title ? ` — "${st.title}"` : ''} (tab ${this.tabList.indexOf(st)}, now active; browser_tabs to list/switch back)`);
        }
        getBus().publish({ kind: 'browser', type: 'tab', data: { action: 'open', tab: st.id, index: this.tabList.indexOf(st), url: safeUrl(page) } });
      })().finally(() => { this.pendingAttach.delete(p); });
      this.pendingAttach.add(p);
    }
    return st;
  }

  private onPageClosed(st: TabState): void {
    const idx = this.tabList.indexOf(st);
    if (idx < 0) return;
    if (st.pendingDialog) { clearTimeout(st.pendingDialog.timer); st.pendingDialog = null; }
    this.tabList.splice(idx, 1);
    if (this.activeTab === st) {
      this.activeTab = null;
      const prev = this.tabList[Math.max(0, idx - 1)];
      if (prev) this.activate(prev);
    }
    getBus().publish({ kind: 'browser', type: 'tab', data: { action: 'close', tab: st.id, index: idx } });
  }

  private activate(st: TabState): void {
    if (this.activeTab === st) return;
    this.activeTab = st;
    try { void Promise.resolve(st.page.bringToFront()).catch(() => {}); } catch { /* ignore */ }
    getBus().publish({ kind: 'browser', type: 'tab', data: { action: 'switch', tab: st.id, index: this.tabList.indexOf(st), url: safeUrl(st.page) } });
    this.followCasts();
  }

  private async refreshTitle(st: TabState): Promise<void> {
    try { st.title = String(await st.page.title()); } catch { /* page busy/closed */ }
  }

  /** Re-read every tab's title (titles are cached for the sync `tabs()`). */
  async refreshTitles(): Promise<void> {
    await Promise.all(this.tabList.map(st => this.refreshTitle(st)));
  }

  context(): any | null {
    return this.ctx;
  }

  async activePage(): Promise<Page> {
    await this.ensure();
    let st = this.activeTab;
    if (st && safe(() => st!.page.isClosed())) { this.onPageClosed(st); st = this.activeTab; }
    if (!st) {
      if (!this.ctx) throw new Error('[BROWSER_ERROR] The browser closed while starting — try again.');
      const p = await this.ctx.newPage();
      st = this.attachPage(p, { initial: true });
      this.activate(st);
    }
    return st.page;
  }

  private tabInfo(st: TabState, index: number): TabInfo {
    return { index, id: st.id, url: safeUrl(st.page), title: st.title, active: st === this.activeTab };
  }

  tabs(): TabInfo[] {
    return this.tabList.map((st, i) => this.tabInfo(st, i));
  }

  async newTab(url?: string): Promise<TabInfo> {
    await this.ensure();
    const p = await this.ctx.newPage();
    const st = this.attachPage(p, { initial: true });
    this.activate(st);
    if (url) {
      try {
        await p.goto(normalizeUrl(url), { waitUntil: 'domcontentloaded', timeout: 30_000 });
      } catch (e) {
        if (!/timeout/i.test(firstLine(e))) throw e;
      }
      await this.refreshTitle(st);
    }
    return this.tabInfo(st, this.tabList.indexOf(st));
  }

  async switchTab(index: number): Promise<TabInfo> {
    await this.ensure();
    const st = this.tabList[index];
    if (!st) throw new Error(`[BROWSER_ERROR] No tab at index ${index} (open tabs: ${this.tabList.length ? `0..${this.tabList.length - 1}` : 'none'}).`);
    this.activate(st);
    await this.refreshTitle(st);
    return this.tabInfo(st, index);
  }

  async closeTab(index?: number): Promise<void> {
    if (!this.ctx) return;
    const st = index === undefined ? this.activeTab : this.tabList[index];
    if (!st) throw new Error(`[BROWSER_ERROR] No tab at index ${index} (open tabs: ${this.tabList.length ? `0..${this.tabList.length - 1}` : 'none'}).`);
    try { await st.page.close({ runBeforeUnload: false }); } catch (e) { logger.debug('tab close failed', { err: firstLine(e) }); }
    this.onPageClosed(st);
  }

  // ── status / notices ──────────────────────────────────────────────────────

  status(): QodexBrowserStatus {
    const cfg = this.launchedCfg ?? this.currentConfig();
    const pending = this.activeTab?.pendingDialog?.entry;
    return {
      running: this.ctx !== null,
      mode: this.mode,
      headless: this.mode === 'cdp' ? false : cfg.headless,
      profile: this.profileInUse || sanitizeName(cfg.profile) || 'default',
      executable: this.exe?.executablePath ?? this.exe?.channel,
      version: this.browserVersion,
      tabs: this.tabs(),
      takeover: this.takeoverOn,
      takeoverBy: this.takeoverWho,
      downloadsDir: this.downloadsDir,
      executableSource: this.exe?.source,
      cdpUrl: cfg.cdpUrl || undefined,
      notice: this.profileNotice,
      downloads: this.downloadList.length,
      pendingDialog: pending ? { type: pending.type, message: pending.message } : undefined,
    };
  }

  private notice(n: string | (() => string)): void {
    pushCapped(this.notices, n, QodexBrowserManager.NOTICE_CAP);
  }

  /** Notes for the next tool result (new tabs, dialogs, downloads, launch notices). Clears them. */
  drainNotices(): string[] {
    const out = this.notices.map(n => (typeof n === 'function' ? n() : n));
    this.notices = [];
    return out;
  }

  /** Let popups / navigations triggered by an action start and the active tab settle. */
  async settle(opts: { timeoutMs?: number } = {}): Promise<void> {
    await sleep(150);
    if (this.pendingAttach.size) await Promise.race([Promise.allSettled([...this.pendingAttach]), sleep(1500)]);
    const st = this.activeTab;
    if (!st || st.pendingDialog) return;
    try { await st.page.waitForLoadState('domcontentloaded', { timeout: opts.timeoutMs ?? 5000 }); } catch { /* slow page: report what we have */ }
    await this.refreshTitle(st);
  }

  /** Console / error / network buffers of the active tab (null when not running). */
  activeBuffers(): { console: ConsoleEntry[]; errors: PageErrorEntry[]; requests: RequestEntry[]; tabId: string } | null {
    const st = this.activeTab;
    return st ? { console: st.console, errors: st.errors, requests: st.requests, tabId: st.id } : null;
  }

  /** Clear the active tab's buffers (browser_navigate does this for the new page). */
  clearActiveBuffers(): void {
    const st = this.activeTab;
    if (!st) return;
    st.console.length = 0;
    st.errors.length = 0;
    st.requests.length = 0;
  }

  activeUrl(): string {
    return this.activeTab ? safeUrl(this.activeTab.page) : '';
  }

  /** The active tab's title (cached). */
  activeTitle(): string {
    return this.activeTab?.title ?? '';
  }

  // ── snapshots / refs ──────────────────────────────────────────────────────

  /** Snapshot the active tab and remember which ref flavour it produced. */
  async snapshot(opts: Omit<SnapshotOptions, 'tabs'> = {}): Promise<SnapshotResult> {
    const page = await this.activePage();
    const st = this.tabList.find(t => t.page === page);
    const r = await takeSnapshotDetailed(page, {
      ...opts,
      tabs: { count: this.tabList.length, active: st ? this.tabList.indexOf(st) : 0 },
    });
    if (st) { st.refMode = r.mode; st.title = r.title || st.title; }
    return r;
  }

  /** Snapshot with element boxes (set-of-marks); refreshes the tab's refs like snapshot(). */
  async boxes(): Promise<{ text: string; marks: MarkBox[]; mode: 'aria' | 'dom' }> {
    const page = await this.activePage();
    const r = await snapshotWithBoxes(page);
    const st = this.tabList.find(t => t.page === page);
    if (st) st.refMode = r.mode;
    return r;
  }

  async locator(target: { ref?: string; selector?: string }): Promise<any> {
    const page = await this.activePage();
    if (target.ref !== undefined && target.ref !== null && String(target.ref).trim() !== '') {
      const ref = String(target.ref).trim().replace(/^\[?ref=/, '').replace(/\]$/, '');
      if (!REF_RE.test(ref)) {
        throw new Error(`[STALE_REF] "${target.ref}" is not a snapshot ref (expected e.g. e12) — call browser_snapshot and use a ref from it, or pass a selector.`);
      }
      const st = this.tabList.find(t => t.page === page);
      const aria = `aria-ref=${ref}`;
      const dom = `[data-qx-ref="${ref}"]`;
      const order = st?.refMode === 'dom' ? [dom, aria] : [aria, dom];
      for (const sel of order) {
        try {
          const loc = page.locator(sel);
          if ((await loc.count()) > 0) return loc.first();
        } catch { /* unknown engine / detached frame: try the next flavour */ }
      }
      throw new Error(`[STALE_REF] ref ${ref} not found — call browser_snapshot again (refs change when the page changes).`);
    }
    if (target.selector && target.selector.trim()) return page.locator(target.selector).first();
    throw new Error('[BROWSER_ERROR] Pass `ref` (from browser_snapshot) or `selector`.');
  }

  /** ElementInfo for a resolved locator (best-effort, never throws). */
  async describeLocator(loc: any, timeoutMs = 1500): Promise<ElementInfo | null> {
    try {
      const info = await loc.evaluate(DESCRIBE_ELEMENT_FN, undefined, { timeout: timeoutMs });
      return info && typeof info === 'object' ? (info as ElementInfo) : null;
    } catch {
      return null;
    }
  }

  async describeRef(ref: string): Promise<ElementInfo | null> {
    if (!this.ctx) return null; // never launch for introspection
    try {
      const loc = await this.locator({ ref });
      const info = await this.describeLocator(loc);
      return info ? { ...info, ref: String(ref).trim() } : null;
    } catch {
      return null;
    }
  }

  async describeSelector(selector: string): Promise<ElementInfo | null> {
    if (!this.ctx) return null;
    try {
      const page = await this.activePage();
      const loc = page.locator(selector).first();
      if ((await page.locator(selector).count()) === 0) return null;
      return await this.describeLocator(loc);
    } catch {
      return null;
    }
  }

  // ── dialogs ───────────────────────────────────────────────────────────────

  private onDialog(st: TabState, dialog: any): void {
    const type = String(safe(() => dialog.type()) ?? 'alert');
    const entry: DialogEntry = {
      id: `d${++this.dialogSeq}`,
      type,
      message: String(safe(() => dialog.message()) ?? ''),
      defaultValue: safe(() => dialog.defaultValue()) || undefined,
      url: safeUrl(st.page),
      tabId: st.id,
      action: 'pending',
      ts: Date.now(),
    };
    pushCapped(this.dialogHistory, entry, DIALOG_HISTORY_CAP);
    const policy = this.currentConfig().dialogPolicy;
    const msg = entry.message.length > 200 ? entry.message.slice(0, 200) + '…' : entry.message;
    if (policy === 'ask' && type !== 'beforeunload') {
      if (st.pendingDialog) {
        // A second dialog while one is pending cannot happen in one page; be safe.
        void Promise.resolve(dialog.dismiss()).catch(() => {});
        entry.action = 'dismissed';
        return;
      }
      const ms = this.opts.dialogAutoDismissMs ?? 30_000;
      const timer = setTimeout(() => { void this.resolveDialog('dismiss', undefined, st, true).catch(() => {}); }, ms);
      (timer as any).unref?.();
      st.pendingDialog = { entry, dialog, timer };
      this.notice(`Dialog waiting (${type}): "${msg}" — answer with browser_dialog action=accept|dismiss (auto-dismissed in ${Math.round(ms / 1000)}s).`);
      this.events.emit('dialog-pending', entry);
    } else {
      // beforeunload is always accepted: dismissing it would block navigation.
      const accept = policy !== 'dismiss' || type === 'beforeunload';
      void Promise.resolve(accept ? dialog.accept(entry.defaultValue) : dialog.dismiss()).catch(() => {});
      entry.action = accept ? 'accepted' : 'dismissed';
      this.notice(`Dialog (${type}) "${msg}" → ${entry.action}`);
    }
    getBus().publish({ kind: 'browser', type: 'dialog', data: { tab: st.id, type, message: msg, action: entry.action } });
  }

  /** Subscribe to dialogs that wait for an answer ('ask' policy). Returns unsubscribe. */
  onPendingDialog(listener: (d: DialogEntry) => void): () => void {
    this.events.on('dialog-pending', listener);
    return () => { this.events.off('dialog-pending', listener); };
  }

  /** The pending dialog of a page (or of the active tab). */
  pendingDialog(page?: Page): DialogEntry | null {
    const st = page ? this.tabList.find(t => t.page === page) : this.activeTab;
    return st?.pendingDialog?.entry ?? null;
  }

  /** Answer a pending dialog (active tab first, else any tab). Returns null if none is pending. */
  async resolveDialog(action: 'accept' | 'dismiss', text?: string, tab?: TabState, auto = false): Promise<DialogEntry | null> {
    const st = tab ?? (this.activeTab?.pendingDialog ? this.activeTab : this.tabList.find(t => t.pendingDialog));
    const pd = st?.pendingDialog;
    if (!st || !pd) return null;
    clearTimeout(pd.timer);
    st.pendingDialog = null;
    try {
      if (action === 'accept') await pd.dialog.accept(text ?? pd.entry.defaultValue);
      else await pd.dialog.dismiss();
    } catch (e) {
      logger.debug('dialog answer failed', { err: firstLine(e) });
    }
    pd.entry.action = auto ? 'auto-dismissed' : action === 'accept' ? 'accepted' : 'dismissed';
    if (auto) this.notice(`Dialog (${pd.entry.type}) "${pd.entry.message.slice(0, 120)}" was auto-dismissed after waiting.`);
    getBus().publish({ kind: 'browser', type: 'dialog', data: { tab: st.id, type: pd.entry.type, action: pd.entry.action } });
    return pd.entry;
  }

  /** Recent dialogs, oldest first. */
  dialogs(): DialogEntry[] {
    return [...this.dialogHistory];
  }

  // ── downloads ─────────────────────────────────────────────────────────────

  private onDownload(st: TabState, download: any): void {
    const entry: DownloadEntry = {
      id: `dl${++this.downloadSeq}`,
      url: String(safe(() => download.url()) ?? ''),
      suggestedFilename: String(safe(() => download.suggestedFilename()) ?? 'download'),
      path: '',
      state: 'in_progress',
      startedAt: Date.now(),
      tabId: st.id,
    };
    pushCapped(this.downloadList, entry, DOWNLOAD_CAP);
    if (this.downloadDone.size > DOWNLOAD_CAP) {
      const live = new Set(this.downloadList.map(d => d.id));
      for (const id of [...this.downloadDone.keys()]) if (!live.has(id)) this.downloadDone.delete(id);
    }
    this.notice(() => entry.state === 'in_progress'
      ? `Download started: ${entry.suggestedFilename} → ${entry.path || this.downloadsDir} (browser_downloads action=wait to wait for it)`
      : `Download ${entry.state}: ${entry.path || entry.suggestedFilename}${entry.bytes !== undefined ? ` (${formatBytes(entry.bytes)})` : ''}${entry.error ? ` — ${entry.error}` : ''}`);
    getBus().publish({ kind: 'browser', type: 'download', data: { id: entry.id, state: 'started', filename: entry.suggestedFilename, url: entry.url } });
    this.events.emit('download-start', entry);

    const done = (async (): Promise<DownloadEntry> => {
      let target = '';
      try {
        await fs.mkdir(this.downloadsDir, { recursive: true });
        const existing = new Set(await fs.readdir(this.downloadsDir).catch(() => [] as string[]));
        const name = dedupFilename(entry.suggestedFilename, n => existing.has(n) || this.reservedNames.has(n));
        this.reservedNames.add(name);
        target = path.join(this.downloadsDir, name);
        entry.path = target;
        await download.saveAs(target);
        const stat = await fs.stat(target);
        entry.bytes = stat.size;
        entry.state = 'completed';
      } catch (e) {
        entry.state = 'failed';
        entry.error = firstLine(e);
      } finally {
        if (target) this.reservedNames.delete(path.basename(target));
        entry.finishedAt = Date.now();
      }
      getBus().publish({ kind: 'browser', type: 'download', data: { id: entry.id, state: entry.state, path: entry.path, bytes: entry.bytes, error: entry.error } });
      this.events.emit('download-done', entry);
      return entry;
    })();
    this.downloadDone.set(entry.id, done);
  }

  /** Downloads of this session, oldest first. */
  downloads(): DownloadEntry[] {
    return [...this.downloadList];
  }

  /**
   * Wait for a download to finish and return it: the newest download not yet
   * returned by a previous wait (it may already be complete — fast downloads
   * often finish during the click), else the next one that starts. Resolves
   * null on timeout.
   */
  async waitForDownload(timeoutMs: number, signal?: AbortSignal): Promise<DownloadEntry | null> {
    const unclaimed = [...this.downloadList].reverse().find(d => !d.claimed);
    const waitDone = (d: DownloadEntry) => (this.downloadDone.get(d.id) ?? Promise.resolve(d)).then(r => { r.claimed = true; return r; });
    return new Promise<DownloadEntry | null>((resolve, reject) => {
      let finished = false;
      const finish = (v: DownloadEntry | null, err?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.events.off('download-start', onStart);
        signal?.removeEventListener('abort', onAbort);
        if (err) reject(err); else resolve(v);
      };
      const onStart = (d: DownloadEntry) => { void waitDone(d).then(r => finish(r)); };
      const onAbort = () => finish(null, new Error('[ABORTED] Stopped waiting for the download.'));
      const timer = setTimeout(() => finish(null), Math.max(0, timeoutMs));
      (timer as any).unref?.();
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      if (unclaimed) void waitDone(unclaimed).then(r => finish(r));
      else this.events.on('download-start', onStart);
    });
  }

  // ── screencast ────────────────────────────────────────────────────────────

  async startScreencast(onFrame: (f: ScreencastFrame) => void, opts: { quality?: number; maxFps?: number } = {}): Promise<() => Promise<void>> {
    const fps = Math.min(30, Math.max(1, opts.maxFps ?? 8));
    const sub: CastSub = {
      onFrame,
      quality: Math.min(100, Math.max(1, Math.round(opts.quality ?? 60))),
      minIntervalMs: Math.floor(1000 / fps),
      last: 0,
      session: null,
      page: null,
      stopped: false,
      chain: Promise.resolve(),
    };
    this.casts.add(sub);
    this.queueCast(sub);
    await sub.chain;
    return async () => {
      sub.stopped = true;
      this.casts.delete(sub);
      await sub.chain.catch(() => {});
      await this.detachCast(sub);
    };
  }

  private queueCast(sub: CastSub): void {
    sub.chain = sub.chain.then(() => this.attachCast(sub)).catch(e => logger.debug('screencast attach failed', { err: firstLine(e) }));
  }

  private followCasts(): void {
    for (const sub of this.casts) this.queueCast(sub);
  }

  private async attachCast(sub: CastSub): Promise<void> {
    if (sub.stopped || !this.ctx || !this.activeTab) return;
    const page = this.activeTab.page;
    if (sub.page === page && sub.session) return;
    await this.detachCast(sub);
    const ctx = this.ctx;
    const session = await ctx.newCDPSession(page);
    if (sub.stopped || this.ctx !== ctx || this.activeTab?.page !== page) {
      await Promise.resolve(session.detach()).catch(() => {});
      if (!sub.stopped && this.ctx && this.activeTab && this.activeTab.page !== page) this.queueCast(sub);
      return;
    }
    sub.session = session;
    sub.page = page;
    session.on('Page.screencastFrame', (ev: any) => {
      void Promise.resolve(session.send('Page.screencastFrameAck', { sessionId: ev.sessionId })).catch(() => {});
      if (sub.stopped) return;
      const now = Date.now();
      if (now - sub.last < sub.minIntervalMs) return;
      sub.last = now;
      const dims = jpegSize(ev.data) ?? { width: Math.round(ev.metadata?.deviceWidth ?? 0), height: Math.round(ev.metadata?.deviceHeight ?? 0) };
      try { sub.onFrame({ data: ev.data, width: dims.width, height: dims.height, ts: now }); } catch { /* viewer error must not kill the cast */ }
    });
    const vp = await this.viewportOf(page);
    await session.send('Page.startScreencast', { format: 'jpeg', quality: sub.quality, maxWidth: vp.width, maxHeight: vp.height, everyNthFrame: 1 });
  }

  private async detachCast(sub: CastSub): Promise<void> {
    const session = sub.session;
    sub.session = null;
    sub.page = null;
    if (!session) return;
    try { await session.send('Page.stopScreencast'); } catch { /* page gone */ }
    try { await session.detach(); } catch { /* already detached */ }
  }

  private async viewportOf(page: Page): Promise<{ width: number; height: number }> {
    const vp = safe(() => page.viewportSize());
    if (vp && vp.width && vp.height) return vp;
    try {
      const r = await page.evaluate('({ width: window.innerWidth, height: window.innerHeight })');
      if (r?.width && r?.height) return r;
    } catch { /* fall through */ }
    return { ...(this.launchedCfg ?? this.currentConfig()).viewport };
  }

  async screenshotJpeg(quality = 70): Promise<Buffer> {
    if (!this.ctx || !this.activeTab) throw new Error('[BROWSER_ERROR] The QodeX browser is not running.');
    return this.activeTab.page.screenshot({ type: 'jpeg', quality: Math.min(100, Math.max(1, Math.round(quality))) });
  }

  // ── takeover / human input ────────────────────────────────────────────────

  setTakeover(on: boolean, by = 'human'): void {
    const changed = this.takeoverOn !== on;
    this.takeoverOn = on;
    this.takeoverWho = on ? by : undefined;
    if (changed) getBus().publish({ kind: 'browser', type: 'takeover', data: { on, by } });
    if (!on) {
      const waiters = [...this.takeoverWaiters];
      this.takeoverWaiters.clear();
      for (const w of waiters) w();
    }
  }

  isTakeover(): boolean {
    return this.takeoverOn;
  }

  waitForTakeoverEnd(signal?: AbortSignal): Promise<void> {
    if (!this.takeoverOn) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) { reject(new Error('[ABORTED] Stopped waiting for the human to hand back the browser.')); return; }
      const done = () => { signal?.removeEventListener('abort', onAbort); resolve(); };
      const onAbort = () => {
        this.takeoverWaiters.delete(done);
        reject(new Error('[ABORTED] Stopped waiting for the human to hand back the browser.'));
      };
      this.takeoverWaiters.add(done);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  async dispatchInput(ev: HumanInputEvent): Promise<void> {
    if (ev.type === 'navigate') {
      const page = await this.activePage();
      const url = normalizeUrl(ev.url);
      try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }); } catch (e) { if (!/timeout/i.test(firstLine(e))) throw e; }
      this.recordAction({ tool: 'browser_navigate', args: { url }, url: safeUrl(page), title: await safeTitle(page), actor: 'human' });
      return;
    }
    if (!this.ctx || !this.activeTab) throw new Error('[BROWSER_ERROR] The QodeX browser is not running.');
    const page = this.activeTab.page;
    const toViewport = async (x: number, y: number, fw?: number, fh?: number) => {
      if (!fw || !fh) return { x, y };
      const vp = await this.viewportOf(page);
      return { x: (x * vp.width) / fw, y: (y * vp.height) / fh };
    };
    const focused = async (): Promise<ElementInfo | null> => {
      try {
        return await page.evaluate(new Function(`var el = document.activeElement; while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement; return el && el !== document.body ? (${DESCRIBE_ELEMENT_JS})(el) : null;`) as any);
      } catch { return null; }
    };
    switch (ev.type) {
      case 'click': {
        const p = await toViewport(ev.x, ev.y, ev.frameWidth, ev.frameHeight);
        let element: ElementInfo | null = null;
        try { element = await page.evaluate(DESCRIBE_AT_POINT_FN, p); } catch { element = null; }
        await page.mouse.click(p.x, p.y, { button: ev.button ?? 'left', clickCount: ev.clickCount ?? 1 });
        this.recordAction({ tool: 'browser_click', args: { x: Math.round(p.x), y: Math.round(p.y), button: ev.button ?? 'left', click_count: ev.clickCount ?? 1 }, url: safeUrl(page), title: await safeTitle(page), element: element ?? undefined, actor: 'human' });
        return;
      }
      case 'move': {
        const p = await toViewport(ev.x, ev.y, ev.frameWidth, ev.frameHeight);
        await page.mouse.move(p.x, p.y);
        return;
      }
      case 'type': {
        const el = await focused();
        await page.keyboard.type(ev.text);
        this.recordAction({ tool: 'browser_type', args: { text: el?.isPassword ? '***' : ev.text }, url: safeUrl(page), title: await safeTitle(page), element: el ?? undefined, actor: 'human' });
        return;
      }
      case 'key': {
        const el = await focused();
        const key = normalizeKey(ev.key);
        await page.keyboard.press(key);
        this.recordAction({ tool: 'browser_press', args: { key }, url: safeUrl(page), title: await safeTitle(page), element: el ?? undefined, actor: 'human' });
        return;
      }
      case 'scroll': {
        if (ev.x !== undefined && ev.y !== undefined) {
          const p = await toViewport(ev.x, ev.y, ev.frameWidth, ev.frameHeight);
          await page.mouse.move(p.x, p.y);
        }
        await page.mouse.wheel(ev.dx || 0, ev.dy || 0);
        this.recordAction({ tool: 'browser_scroll', args: { dx: ev.dx || 0, dy: ev.dy || 0 }, url: safeUrl(page), actor: 'human' });
        return;
      }
      case 'back':
      case 'forward':
      case 'reload': {
        const opts = { waitUntil: 'domcontentloaded', timeout: 15_000 };
        try {
          if (ev.type === 'back') await page.goBack(opts);
          else if (ev.type === 'forward') await page.goForward(opts);
          else await page.reload(opts);
        } catch (e) {
          if (!/timeout/i.test(firstLine(e))) throw e;
        }
        this.recordAction({ tool: 'browser_history', args: { action: ev.type }, url: safeUrl(page), title: await safeTitle(page), actor: 'human' });
        return;
      }
    }
  }

  // ── action feed ───────────────────────────────────────────────────────────

  onAction(listener: (rec: BrowserActionRecord) => void): () => void {
    this.actionListeners.add(listener);
    return () => { this.actionListeners.delete(listener); };
  }

  recordAction(rec: Omit<BrowserActionRecord, 'ts'> & { ts?: number }): void {
    const full: BrowserActionRecord = { ...rec, ts: rec.ts ?? Date.now() };
    for (const l of [...this.actionListeners]) {
      try { l(full); } catch (e) { logger.debug('browser action listener failed', { err: firstLine(e) }); }
    }
    const args: Record<string, unknown> = { ...full.args };
    if (full.element?.isPassword) {
      for (const k of ['text', 'value']) if (k in args) args[k] = '***';
    }
    getBus().publish({
      kind: 'browser',
      type: 'action',
      data: {
        tool: full.tool,
        actor: full.actor,
        url: full.url,
        title: full.title,
        args,
        element: full.element ? { role: full.element.role, name: full.element.name, selector: full.element.selector } : undefined,
      },
    });
  }
}

function safe<T>(fn: () => T): T | undefined {
  try { return fn(); } catch { return undefined; }
}

function safeUrl(page: Page): string {
  try { return String(page.url()); } catch { return ''; }
}

async function safeTitle(page: Page): Promise<string> {
  try { return String(await page.title()); } catch { return ''; }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

registerBrowserManagerFactory(() => new QodexBrowserManager());

// ── back-compat API (pre-manager callers) ───────────────────────────────────

export interface BrowserSession {
  browser: any;
  context: any;
  page: any;
  consoleBuffer: ConsoleEntry[];
  requestBuffer: RequestEntry[];
  errorBuffer: PageErrorEntry[];
}

/** The ACTIVE tab as the old single-page session shape (launches if needed). */
export async function getSession(): Promise<BrowserSession> {
  const mgr = await getBrowserManager();
  if (!(mgr instanceof QodexBrowserManager)) {
    const page = await mgr.activePage();
    return { browser: null, context: mgr.context(), page, consoleBuffer: [], requestBuffer: [], errorBuffer: [] };
  }
  const page = await mgr.activePage();
  const bufs = mgr.activeBuffers();
  const ctx = mgr.context();
  let browser: any = null;
  try { browser = ctx?.browser?.() ?? null; } catch { browser = null; }
  return {
    browser,
    context: ctx,
    page,
    consoleBuffer: bufs?.console ?? [],
    requestBuffer: bufs?.requests ?? [],
    errorBuffer: bufs?.errors ?? [],
  };
}

/** Clear a session's buffers (the active tab's when called with getSession()'s result). */
export function clearBuffers(s: BrowserSession): void {
  s.consoleBuffer.length = 0;
  s.requestBuffer.length = 0;
  s.errorBuffer.length = 0;
}

/** Close the browser if one was started. Idempotent. */
export async function closeBrowser(): Promise<void> {
  const mgr = peekBrowserManager();
  if (mgr) await mgr.close();
}

/** Whether the optional playwright package can be imported. */
export async function isPlaywrightAvailable(): Promise<boolean> {
  try {
    await importPlaywright();
    return true;
  } catch {
    return false;
  }
}
