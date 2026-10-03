/**
 * Desktop-control backend contract + small helpers shared by every backend.
 *
 * A backend drives ONE platform's native input / screenshot / window tooling:
 *   macos   — screencapture, osascript (AppleScript + JXA/CoreGraphics), optional cliclick
 *   x11     — xdotool, scrot|import|gnome-screenshot, xclip|xsel, wmctrl
 *   wayland — ydotool, grim|gnome-screenshot|spectacle, wl-copy/wl-paste, swaymsg|hyprctl
 *   windows — PowerShell + user32 (SetCursorPos, mouse_event, keybd_event), SendKeys, System.Drawing
 *
 * COORDINATES: every backend method takes and returns LOGICAL screen
 * coordinates — the units its input tool moves the pointer in (points on macOS,
 * pixels on X11/Windows-DPI-aware). The tool layer (use.ts) maps the model's
 * SCREENSHOT-pixel coordinates to logical ones using the scale/origin returned
 * by the last `screenshot()`.
 *
 * Errors thrown by backends start with a `[CODE]` token so the tool layer can
 * pass them to the model verbatim.
 */

import { promises as fs } from 'fs';
import { runCommand, describeFailure, type ExecOptions, type ExecResult } from '../exec.js';

export type DesktopBackendName = 'macos' | 'x11' | 'wayland' | 'windows';
export type MouseButton = 'left' | 'right' | 'middle';

export interface BackendAvailability {
  /** Core input + screenshots work. */
  ok: boolean;
  /** Required binaries (or "a|b|c" alternative groups) that are missing. */
  missing: string[];
  /** How to install what's missing (per OS / distro). */
  hint: string;
  /** Capabilities, optional tools and known limitations — shown by screen_info. */
  notes: string[];
}

export interface ScreenshotOptions {
  /** Absolute destination path (.png, or .jpg/.jpeg where supported). */
  path: string;
  /** Capture only this window (app name or window-title substring). */
  window?: string;
  /** Downscale to this width when larger (and a scaler exists). 0/undefined = never. */
  maxWidth?: number;
}

export interface Point { x: number; y: number }
export interface Size { width: number; height: number }
export interface Rect { x: number; y: number; width: number; height: number }

export interface ScreenshotResult {
  path: string;
  /** Pixel size of the saved image. */
  width: number;
  height: number;
  /**
   * Image pixels per logical input unit. 2 on a Retina Mac, <1 after
   * downscaling. logical = origin + imagePixel / scale.
   */
  scale: number;
  /** Logical screen position of the image's top-left pixel (window captures). */
  origin: Point;
  /** Window that was captured, when `window` was requested and found. */
  window?: WindowInfo;
  /** Non-fatal caveats ("captured full screen: ImageMagick missing", ...). */
  notes: string[];
}

export interface WindowInfo {
  /** Backend-specific window id (X11 decimal id, macOS CGWindowID, HWND, sway con_id, ...). */
  id?: string;
  /** Owning application / process name. */
  app?: string;
  title: string;
  pid?: number;
  /** Logical screen rectangle. */
  bounds?: Rect;
  focused?: boolean;
}

export interface ClickOptions {
  button?: MouseButton;
  /** 1 = single, 2 = double, 3 = triple. */
  count?: number;
}

export interface TypeOptions {
  /**
   * 'type'  — synthesize key events (works in terminals; may fail for non-Latin text),
   * 'paste' — put the text on the clipboard, press paste, restore the clipboard,
   * 'auto'  — type, but paste when the text has characters the platform's
   *           typing tool can't produce reliably (e.g. Persian).
   */
  method?: 'auto' | 'type' | 'paste';
}

export interface DesktopBackend {
  readonly name: DesktopBackendName;
  available(): Promise<BackendAvailability>;
  screenshot(opts: ScreenshotOptions): Promise<ScreenshotResult>;
  /** Logical size of the primary screen. */
  screenSize(): Promise<Size>;
  /** Pointer position (logical). */
  cursor(): Promise<Point>;
  click(x: number, y: number, opts?: ClickOptions): Promise<void>;
  move(x: number, y: number): Promise<void>;
  drag(x1: number, y1: number, x2: number, y2: number): Promise<void>;
  /** Scroll by wheel notches: dy > 0 = down, dx > 0 = right. Optionally at a point. */
  scroll(dx: number, dy: number, at?: Partial<Point>): Promise<void>;
  type(text: string, opts?: TypeOptions): Promise<{ method: 'type' | 'paste' }>;
  /** Key combo like "ctrl+s", "cmd+shift+4", "enter". */
  key(combo: string, opts?: { repeat?: number }): Promise<void>;
  activeWindow(): Promise<WindowInfo | null>;
  listWindows(app?: string): Promise<WindowInfo[]>;
  /** Bring the best match for `query` (app or title substring) to the front. */
  focusWindow(query: string): Promise<WindowInfo>;
  /** Open an app (by name), a file/folder (absolute path) or a URL. Returns what was done. */
  openApp(target: string): Promise<string>;
  clipboardGet(): Promise<string>;
  clipboardSet(text: string): Promise<void>;
}

export interface BackendDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** Pause between low-level input events (ms) — desktop.inputDelayMs. */
  inputDelayMs: number;
  /** Aborts in-flight commands (the tool call's ctx.signal). */
  signal?: AbortSignal;
  /** Contents of /etc/os-release for distro-specific install hints (tests). */
  osRelease?: string;
  /** Where Linux .desktop entries are searched (tests). */
  desktopEntryDirs?: string[];
}

// ── errors ───────────────────────────────────────────────────────────────────

/** Build an Error whose message starts with a `[CODE]` token. */
export function desktopError(code: string, message: string): Error {
  return new Error(`[${code}] ${message}`);
}

// ── key combos ───────────────────────────────────────────────────────────────

export type Modifier = 'ctrl' | 'alt' | 'shift' | 'super';

export interface ParsedCombo {
  modifiers: Modifier[];
  /**
   * Canonical key: a single printable ASCII char ('a', '1', ',', '+', ...), or
   * a name: enter, escape, tab, space, backspace, delete, insert, home, end,
   * pageup, pagedown, up, down, left, right, f1..f24, capslock, printscreen,
   * menu, numlock, scrolllock, pause, or a modifier pressed alone (ctrl, alt,
   * shift, super).
   */
  key: string;
}

const MODIFIER_ALIASES: Record<string, Modifier> = {
  ctrl: 'ctrl', control: 'ctrl', ctl: 'ctrl', strg: 'ctrl',
  alt: 'alt', option: 'alt', opt: 'alt', altgr: 'alt',
  shift: 'shift',
  super: 'super', cmd: 'super', command: 'super', meta: 'super', win: 'super', windows: 'super', mod4: 'super', '⌘': 'super',
};

const KEY_ALIASES: Record<string, string> = {
  enter: 'enter', return: 'enter', ret: 'enter', '⏎': 'enter', '↵': 'enter',
  escape: 'escape', esc: 'escape',
  tab: 'tab',
  space: 'space', spacebar: 'space', ' ': 'space',
  backspace: 'backspace', bksp: 'backspace', bs: 'backspace',
  delete: 'delete', del: 'delete', forwarddelete: 'delete',
  insert: 'insert', ins: 'insert',
  home: 'home', end: 'end',
  pageup: 'pageup', pgup: 'pageup', page_up: 'pageup', prior: 'pageup',
  pagedown: 'pagedown', pgdn: 'pagedown', page_down: 'pagedown', next: 'pagedown',
  up: 'up', arrowup: 'up', uparrow: 'up', '↑': 'up',
  down: 'down', arrowdown: 'down', downarrow: 'down', '↓': 'down',
  left: 'left', arrowleft: 'left', leftarrow: 'left', '←': 'left',
  right: 'right', arrowright: 'right', rightarrow: 'right', '→': 'right',
  capslock: 'capslock', caps: 'capslock', caps_lock: 'capslock',
  printscreen: 'printscreen', print: 'printscreen', prtsc: 'printscreen', prtscr: 'printscreen', sysrq: 'printscreen',
  menu: 'menu', contextmenu: 'menu', apps: 'menu',
  numlock: 'numlock', scrolllock: 'scrolllock', pause: 'pause',
  plus: '+', minus: '-', dash: '-', hyphen: '-', equal: '=', equals: '=',
  comma: ',', period: '.', dot: '.', slash: '/', backslash: '\\',
  semicolon: ';', quote: "'", apostrophe: "'", grave: '`', backtick: '`',
  bracketleft: '[', leftbracket: '[', bracketright: ']', rightbracket: ']',
};

/** Printable ASCII keys every backend can press directly. */
const PRINTABLE_KEYS = new Set('abcdefghijklmnopqrstuvwxyz0123456789,./;\'[]\\-=`+'.split(''));

/** Named (non-printable) canonical keys. */
export const NAMED_KEYS = new Set([
  'enter', 'escape', 'tab', 'space', 'backspace', 'delete', 'insert', 'home', 'end', 'pageup', 'pagedown',
  'up', 'down', 'left', 'right', 'capslock', 'printscreen', 'menu', 'numlock', 'scrolllock', 'pause',
  ...Array.from({ length: 24 }, (_, i) => `f${i + 1}`),
]);

/**
 * Parse "ctrl+shift+s", "cmd+,", "ctrl++", "Enter", "super" into modifiers +
 * one canonical key. Throws `[COMPUTER_USE_ERROR]` for unusable combos. PURE.
 */
export function parseKeyCombo(combo: string): ParsedCombo {
  const raw = String(combo ?? '').trim();
  if (!raw) throw desktopError('COMPUTER_USE_ERROR', 'Empty key combo. Examples: "enter", "ctrl+s", "cmd+shift+4".');
  let parts: string[];
  if (raw === '+') parts = ['+'];
  else if (/\+\s*\+$/.test(raw)) parts = [...raw.replace(/\+\s*\+$/, '').split('+'), '+'];
  else parts = raw.split('+');
  parts = parts.map(p => (p === '+' || p === ' ' ? p : p.trim()));
  if (parts.some(p => p === '')) {
    throw desktopError('COMPUTER_USE_ERROR', `Malformed key combo "${raw}". Use "+" between keys, e.g. "ctrl+shift+t".`);
  }
  const modifiers: Modifier[] = [];
  const keys: string[] = [];
  for (const part of parts) {
    const lower = part.length === 1 ? part.toLowerCase() : part.toLowerCase().replace(/[\s-]+/g, '');
    const mod = MODIFIER_ALIASES[lower];
    if (mod) {
      if (!modifiers.includes(mod)) modifiers.push(mod);
      continue;
    }
    keys.push(lower);
  }
  if (keys.length === 0) {
    // Modifiers only: press the last one on its own ("super" opens the start menu).
    const key = modifiers.pop()!;
    return { modifiers, key };
  }
  if (keys.length > 1) {
    throw desktopError('COMPUTER_USE_ERROR', `Key combo "${raw}" has ${keys.length} non-modifier keys (${keys.join(', ')}). Press one combo per call, or use computer_use_type for text.`);
  }
  const k = keys[0]!;
  const key = KEY_ALIASES[k] ?? k;
  if (PRINTABLE_KEYS.has(key) || NAMED_KEYS.has(key)) return { modifiers, key };
  throw desktopError('COMPUTER_USE_ERROR', `Unknown key "${keys[0]}" in "${raw}". Use names like enter, esc, tab, space, backspace, delete, home, end, pageup, pagedown, up/down/left/right, f1-f24, or a single ASCII character. To enter text (incl. non-Latin), use computer_use_type.`);
}

// ── text ─────────────────────────────────────────────────────────────────────

/** True when `text` has anything beyond printable ASCII + newline/tab. */
export function hasNonAscii(text: string): boolean {
  return /[^\x20-\x7E\n\r\t]/.test(text);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(desktopError('ABORTED', 'Desktop action aborted.')); return; }
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(desktopError('ABORTED', 'Desktop action aborted.')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ── windows ──────────────────────────────────────────────────────────────────

function norm(s: string | undefined): string {
  return String(s ?? '').normalize('NFC').toLowerCase().replace(/‌/g, '').trim();
}

/** Case-insensitive match of `query` against a window's app name or title. */
export function windowMatches(w: WindowInfo, query: string): boolean {
  const q = norm(query);
  if (!q) return true;
  return norm(w.app).includes(q) || norm(w.title).includes(q);
}

/**
 * Best window for `query`: exact title → exact app → title prefix → app
 * prefix → substring of either. Ties prefer the focused window, then list
 * order (most backends list front-to-back or by stacking). PURE.
 */
export function pickWindow(windows: WindowInfo[], query: string): WindowInfo | undefined {
  const q = norm(query);
  if (!q) return windows.find(w => w.focused) ?? windows[0];
  const tiers: Array<(w: WindowInfo) => boolean> = [
    w => norm(w.title) === q,
    w => norm(w.app) === q,
    w => norm(w.title).startsWith(q),
    w => norm(w.app).startsWith(q),
    w => windowMatches(w, q),
  ];
  for (const t of tiers) {
    const hits = windows.filter(t);
    if (hits.length) return hits.find(w => w.focused) ?? hits[0];
  }
  return undefined;
}

/** "[WINDOW_NOT_FOUND] ..." with a short list of what IS open. */
export function windowNotFound(query: string, windows: WindowInfo[]): Error {
  const list = windows.slice(0, 15).map(w => `${w.app ? `${w.app}: ` : ''}${w.title || '(untitled)'}`).join(' · ');
  return desktopError('WINDOW_NOT_FOUND', `No window matches "${query}".${list ? ` Open windows: ${list}` : ' No windows were reported.'}`);
}

// ── open targets ─────────────────────────────────────────────────────────────

export type OpenTargetKind = 'url' | 'path' | 'app';

const WEB_TLDS = 'com|org|net|io|dev|app|ir|co|ai|me|info|xyz|edu|gov|uk|de|fr|ca|us|tv|so|sh|gg|ly|to|cc';

/**
 * Classify what `computer_use_open` was given. `exists` checks a path (injected
 * for tests). Absolute / home / relative-looking paths are 'path'; URLs with a
 * scheme or bare web domains ("github.com/foo") are 'url' (bare domains get
 * https://); anything else is an app name. PURE given `exists`.
 */
export function classifyOpenTarget(target: string, exists: (p: string) => boolean): { kind: OpenTargetKind; value: string } {
  const t = String(target ?? '').trim();
  if (/^[a-z]:[\\/]/i.test(t) || /^\\\\/.test(t)) return { kind: 'path', value: t };
  // host:port ("localhost:3000", "127.0.0.1:8080/x") — not a scheme.
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3}|[a-z0-9-]+(\.[a-z0-9-]+)+):\d+([/?#]\S*)?$/i.test(t)) return { kind: 'url', value: `http://${t}` };
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^[a-z]:$/i.test(t)) return { kind: 'url', value: t };
  if (/^(~|\.{1,2})?[\\/]/.test(t) || t === '~' || exists(t)) return { kind: 'path', value: t };
  if (new RegExp(`^(www\\.)?[a-z0-9-]+(\\.[a-z0-9-]+)*\\.(${WEB_TLDS})(:\\d+)?([/?#]\\S*)?$`, 'i').test(t)) {
    return { kind: 'url', value: `https://${t}` };
  }
  return { kind: 'app', value: t };
}

// ── images ───────────────────────────────────────────────────────────────────

/** Pixel size from a PNG / JPEG / GIF / BMP header. PURE. */
export function imageSizeFromBuffer(buf: Buffer): Size | null {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString('ascii', 12, 16) === 'IHDR') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 10 && buf.toString('ascii', 0, 4) === 'GIF8') {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.length >= 26 && buf.toString('ascii', 0, 2) === 'BM') {
    return { width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)) };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1]!;
      if (marker === 0xff) { i++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  return null;
}

/** Read an image file's pixel size. Throws `[COMPUTER_USE_ERROR]` when it isn't a readable image. */
export async function readImageSize(file: string): Promise<Size> {
  let fh: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    fh = await fs.open(file, 'r');
    const st = await fh.stat();
    const len = Math.min(st.size, 256 * 1024);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
    const size = imageSizeFromBuffer(buf);
    if (!size || !size.width || !size.height) throw new Error('unrecognized image format');
    return size;
  } catch (e: any) {
    if (e?.code === 'ENOENT') throw desktopError('COMPUTER_USE_ERROR', `Screenshot file was not created: ${file}`);
    throw desktopError('COMPUTER_USE_ERROR', `Couldn't read screenshot ${file}: ${e?.message ?? e}`);
  } finally {
    await fh?.close().catch(() => {});
  }
}

export function isJpegPath(p: string): boolean {
  return /\.jpe?g$/i.test(p);
}

// ── install hints ────────────────────────────────────────────────────────────

export interface PackageNames { apt?: string; dnf?: string; pacman?: string; zypper?: string }

/** Distro family from /etc/os-release contents. PURE. */
export function linuxFamily(osRelease: string | undefined): 'apt' | 'dnf' | 'pacman' | 'zypper' | null {
  if (!osRelease) return null;
  const ids = (osRelease.match(/^(?:ID|ID_LIKE)=(.*)$/gm) ?? []).join(' ').toLowerCase();
  if (/debian|ubuntu|mint|pop|elementary|kali|raspbian/.test(ids)) return 'apt';
  if (/fedora|rhel|centos|rocky|alma|nobara/.test(ids)) return 'dnf';
  if (/arch|manjaro|endeavouros|garuda/.test(ids)) return 'pacman';
  if (/suse/.test(ids)) return 'zypper';
  return null;
}

/** "sudo apt install a b" for the detected distro, else one line per family. PURE. */
export function linuxInstallHint(pkgs: PackageNames[], osRelease: string | undefined): string {
  const fam = linuxFamily(osRelease);
  const cmd = (f: 'apt' | 'dnf' | 'pacman' | 'zypper') => {
    const names = [...new Set(pkgs.map(p => p[f]).filter((x): x is string => !!x))];
    if (!names.length) return '';
    if (f === 'apt') return `sudo apt install ${names.join(' ')}`;
    if (f === 'dnf') return `sudo dnf install ${names.join(' ')}`;
    if (f === 'pacman') return `sudo pacman -S ${names.join(' ')}`;
    return `sudo zypper install ${names.join(' ')}`;
  };
  if (fam) return cmd(fam);
  return (['apt', 'dnf', 'pacman'] as const).map(f => `${f === 'apt' ? 'Debian/Ubuntu' : f === 'dnf' ? 'Fedora' : 'Arch'}: ${cmd(f)}`).filter(s => !s.endsWith(': ')).join(' · ');
}

// ── shared base class ────────────────────────────────────────────────────────

/**
 * Common plumbing for command-driven backends: signal-aware command running,
 * failure → `[COMPUTER_USE_ERROR]` translation, and clipboard-paste typing
 * (save clipboard → set text → press paste → restore).
 */
export abstract class CommandBackend {
  abstract readonly name: DesktopBackendName;
  constructor(protected readonly deps: BackendDeps) {}

  abstract clipboardGet(): Promise<string>;
  abstract clipboardSet(text: string): Promise<void>;

  protected run(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    return runCommand(cmd, args, { signal: this.deps.signal, ...opts });
  }

  /** Run and throw a `[CODE]` error on failure; returns stdout. */
  protected async check(cmd: string, args: string[], opts: ExecOptions = {}): Promise<string> {
    const r = await this.run(cmd, args, opts);
    if (r.code !== 0) {
      if (r.code === 130 && /aborted/i.test(r.stderr)) throw desktopError('ABORTED', `${this.name}: ${cmd} aborted.`);
      throw desktopError('COMPUTER_USE_ERROR', `${this.name}: ${describeFailure(cmd, r)}`);
    }
    return r.stdout;
  }

  protected wait(ms: number): Promise<void> {
    return sleep(ms, this.deps.signal);
  }

  /** Delay between discrete input events, from desktop.inputDelayMs. */
  protected get inputDelay(): number {
    return Math.max(0, Math.round(this.deps.inputDelayMs));
  }

  protected unavailable(missing: string, hint: string): Error {
    return desktopError('COMPUTER_USE_UNAVAILABLE', `${this.name}: missing ${missing}. Install: ${hint}`);
  }

  /**
   * Type via the clipboard: remember the current clipboard, put `text` on it,
   * press the platform's paste shortcut, give the app time to read it, then
   * restore the previous contents (best-effort).
   */
  protected async pasteText(text: string, pressPaste: () => Promise<void>): Promise<void> {
    let previous: string | null = null;
    try { previous = await this.clipboardGet(); } catch { previous = null; }
    await this.clipboardSet(text);
    await this.wait(60);
    await pressPaste();
    // Apps read the clipboard asynchronously after the paste key; restoring too
    // early would paste the OLD contents.
    await this.wait(350);
    if (previous !== null && previous !== text) {
      try { await this.clipboardSet(previous); } catch { /* best-effort */ }
    }
  }
}
