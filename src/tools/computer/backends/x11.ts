/**
 * Linux / X11 desktop backend.
 *
 *   input       xdotool (mousemove, click --repeat, mousedown/up, type, key)
 *   screenshots scrot → import (ImageMagick) → gnome-screenshot (first available)
 *   downscale   magick | convert (ImageMagick)
 *   clipboard   xclip | xsel
 *   windows     wmctrl -lpG (falls back to `xdotool search`), windowactivate
 *   open        xdg-open (URLs/files), gtk-launch / .desktop entries / PATH (apps)
 *
 * X11 screenshots and xdotool share one pixel space, so scale is 1 unless the
 * image was downscaled. Text: `xdotool type` needs a UTF-8 locale (forced), and
 * even then characters missing from the keyboard layout (Persian on a US
 * layout) are typed by remapping a spare keycode per character, which races
 * with the app reading the keymap — verified under Xvfb + Chromium: wrong
 * letters ("سلسم سنیا" for "سلام دنیا") with exit code 0, at any --delay. So
 * method 'auto' pastes non-ASCII text through the clipboard (like the other
 * backends) and types only ASCII; method 'type' still forces key events.
 *
 * Also exports the Linux helpers (app launching, .desktop lookup, process
 * names) that the Wayland backend reuses.
 */

import { promises as fs, existsSync, readFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CommandBackend,
  type BackendAvailability,
  type BackendDeps,
  type ClickOptions,
  type DesktopBackend,
  type MouseButton,
  type ParsedCombo,
  type Point,
  type ScreenshotOptions,
  type ScreenshotResult,
  type Size,
  type TypeOptions,
  type WindowInfo,
  classifyOpenTarget,
  desktopError,
  hasNonAscii,
  linuxInstallHint,
  parseKeyCombo,
  pickWindow,
  readImageSize,
  windowLabel,
  windowMatches,
  windowNotFound,
  type PackageNames,
} from './types.js';
import { firstAvailable, runCommand, spawnDetached, utf8Env, which } from '../exec.js';

export const X11_SCREENSHOT_TOOLS = ['scrot', 'import', 'gnome-screenshot'] as const;
export const X11_CLIPBOARD_TOOLS = ['xclip', 'xsel'] as const;
export const IMAGE_SCALERS = ['magick', 'convert'] as const;

const PKG: Record<string, PackageNames> = {
  xdotool: { apt: 'xdotool', dnf: 'xdotool', pacman: 'xdotool', zypper: 'xdotool' },
  scrot: { apt: 'scrot', dnf: 'scrot', pacman: 'scrot', zypper: 'scrot' },
  xclip: { apt: 'xclip', dnf: 'xclip', pacman: 'xclip', zypper: 'xclip' },
  wmctrl: { apt: 'wmctrl', dnf: 'wmctrl', pacman: 'wmctrl', zypper: 'wmctrl' },
  imagemagick: { apt: 'imagemagick', dnf: 'ImageMagick', pacman: 'imagemagick', zypper: 'ImageMagick' },
  'xdg-utils': { apt: 'xdg-utils', dnf: 'xdg-utils', pacman: 'xdg-utils', zypper: 'xdg-utils' },
};

/** /etc/os-release contents (for distro-specific hints), or the injected test value. */
export function readOsRelease(deps: BackendDeps): string | undefined {
  if (deps.osRelease !== undefined) return deps.osRelease;
  try { return readFileSync('/etc/os-release', 'utf-8'); } catch { return undefined; }
}

export function installHint(deps: BackendDeps, pkgKeys: string[]): string {
  const pkgs = pkgKeys.map(k => PKG[k]).filter((p): p is PackageNames => !!p);
  return linuxInstallHint(pkgs, readOsRelease(deps));
}

/** xdotool keysym for a canonical key. */
const X11_KEYSYMS: Record<string, string> = {
  enter: 'Return', escape: 'Escape', tab: 'Tab', space: 'space', backspace: 'BackSpace', delete: 'Delete',
  insert: 'Insert', home: 'Home', end: 'End', pageup: 'Page_Up', pagedown: 'Page_Down',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', capslock: 'Caps_Lock', printscreen: 'Print',
  menu: 'Menu', numlock: 'Num_Lock', scrolllock: 'Scroll_Lock', pause: 'Pause',
  ctrl: 'ctrl', alt: 'alt', shift: 'shift', super: 'super',
  ',': 'comma', '.': 'period', '/': 'slash', ';': 'semicolon', "'": 'apostrophe', '[': 'bracketleft',
  ']': 'bracketright', '\\': 'backslash', '-': 'minus', '=': 'equal', '`': 'grave', '+': 'plus',
};

/** "ctrl+shift+Page_Up" for xdotool from a parsed combo. PURE. */
export function x11KeyCombo(c: ParsedCombo): string {
  let key = X11_KEYSYMS[c.key];
  if (!key) key = /^f\d+$/.test(c.key) ? c.key.toUpperCase() : c.key;
  return [...c.modifiers, key].join('+');
}

const BUTTONS: Record<MouseButton, string> = { left: '1', middle: '2', right: '3' };

function int(n: number): string {
  return String(Math.round(n));
}

/** Parse `KEY=value` lines (xdotool --shell output). */
function parseShellVars(out: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of out.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) vars[m[1]!] = m[2]!.trim();
  }
  return vars;
}

/** Parse `wmctrl -lpG` output. PURE. */
export function parseWmctrl(out: string): WindowInfo[] {
  const wins: WindowInfo[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^(0x[0-9a-f]+)\s+(-?\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s?(.*)$/i);
    if (!m) continue;
    const pid = Number(m[3]);
    wins.push({
      id: String(parseInt(m[1]!, 16)),
      title: m[9]!.trim(),
      pid: pid > 0 ? pid : undefined,
      bounds: { x: Number(m[4]), y: Number(m[5]), width: Number(m[6]), height: Number(m[7]) },
    });
  }
  return wins;
}

/** pid → process name via `ps` (best-effort, one call). */
export async function processNames(pids: number[], signal?: AbortSignal): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  const uniq = [...new Set(pids.filter(p => p > 0))];
  if (!uniq.length) return map;
  const r = await runCommand('ps', ['-o', 'pid=,comm=', '-p', uniq.join(',')], { timeoutMs: 5000, signal });
  if (r.code !== 0 && !r.stdout) return map;
  for (const line of r.stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.+)$/);
    if (m) map.set(Number(m[1]), m[2]!.trim());
  }
  return map;
}

// ── app launching (shared with wayland) ──────────────────────────────────────

export interface DesktopEntry { id: string; file: string; name: string; exec: string }

export function defaultDesktopEntryDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME || os.homedir();
  const dataHome = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const dataDirs = (env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean);
  return [
    path.join(dataHome, 'applications'),
    ...dataDirs.map(d => path.join(d, 'applications')),
    '/var/lib/flatpak/exports/share/applications',
    path.join(dataHome, 'flatpak', 'exports', 'share', 'applications'),
    '/var/lib/snapd/desktop/applications',
  ];
}

/** Parse the [Desktop Entry] group of a .desktop file. PURE. */
export function parseDesktopEntry(content: string): { name?: string; exec?: string; hidden: boolean } {
  let inGroup = false;
  let name: string | undefined;
  let exec: string | undefined;
  let hidden = false;
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) { inGroup = line === '[Desktop Entry]'; continue; }
    if (!inGroup) continue;
    if (line.startsWith('Name=') && name === undefined) name = line.slice(5).trim();
    else if (line.startsWith('Exec=') && exec === undefined) exec = line.slice(5).trim();
    else if (/^(NoDisplay|Hidden)=true$/i.test(line)) hidden = true;
  }
  return { name, exec, hidden };
}

/** Split a .desktop Exec= line into argv, dropping %f/%U/... field codes. PURE. */
export function splitExec(exec: string): string[] {
  const argv: string[] = [];
  let cur = '';
  let quoted = false;
  let has = false;
  for (let i = 0; i < exec.length; i++) {
    const ch = exec[i]!;
    if (quoted) {
      if (ch === '\\' && i + 1 < exec.length) { cur += exec[++i]; continue; }
      if (ch === '"') { quoted = false; continue; }
      cur += ch;
      continue;
    }
    if (ch === '"') { quoted = true; has = true; continue; }
    if (/\s/.test(ch)) { if (has || cur) argv.push(cur); cur = ''; has = false; continue; }
    cur += ch;
  }
  if (has || cur) argv.push(cur);
  return argv.filter(a => !/^%[a-zA-Z]$/.test(a)).map(a => a.replace(/%%/g, '%'));
}

/** Find a .desktop entry whose Name or id matches `query` (exact first, then prefix, then substring). */
export async function findDesktopEntry(query: string, dirs: string[]): Promise<DesktopEntry | null> {
  const q = query.toLowerCase().trim();
  if (!q) return null;
  const entries: DesktopEntry[] = [];
  for (const dir of dirs) {
    let files: string[];
    try { files = await fs.readdir(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.desktop')) continue;
      const file = path.join(dir, f);
      let content: string;
      try { content = await fs.readFile(file, 'utf-8'); } catch { continue; }
      const parsed = parseDesktopEntry(content);
      if (parsed.hidden || !parsed.exec) continue;
      entries.push({ id: f.replace(/\.desktop$/, ''), file, name: parsed.name ?? '', exec: parsed.exec });
    }
  }
  const tiers: Array<(e: DesktopEntry) => boolean> = [
    e => e.name.toLowerCase() === q || e.id.toLowerCase() === q,
    e => e.id.toLowerCase().split('.').pop() === q,
    e => e.name.toLowerCase().startsWith(q),
    e => e.name.toLowerCase().includes(q) || e.id.toLowerCase().includes(q),
  ];
  for (const t of tiers) {
    const hit = entries.find(t);
    if (hit) return hit;
  }
  return null;
}

/**
 * Open a URL / file / app on Linux (X11 or Wayland). URLs and files go to
 * xdg-open; apps are resolved via .desktop entries (gtk-launch, else their
 * Exec line) or a binary on PATH. Never goes through a shell.
 */
export async function openLinuxTarget(backendName: string, target: string, deps: BackendDeps): Promise<string> {
  const t = classifyOpenTarget(target, p => existsSync(p));
  const env = deps.env;
  if (t.kind === 'url' || t.kind === 'path') {
    let value = t.value;
    if (t.kind === 'path') value = value.replace(/^~(?=$|\/)/, env.HOME || os.homedir());
    if (!(await which('xdg-open'))) {
      throw desktopError('COMPUTER_USE_UNAVAILABLE', `${backendName}: missing xdg-open. Install: ${installHint(deps, ['xdg-utils'])}`);
    }
    await spawnDetached('xdg-open', [value], { env });
    return `Opened ${t.kind === 'url' ? 'URL' : 'path'} ${value} with xdg-open`;
  }
  const dirs = deps.desktopEntryDirs ?? defaultDesktopEntryDirs(env);
  const entry = await findDesktopEntry(t.value, dirs);
  if (entry) {
    if (await which('gtk-launch')) {
      const r = await runCommand('gtk-launch', [entry.id], { env, timeoutMs: 10_000, signal: deps.signal });
      if (r.code === 0) return `Launched ${entry.name || entry.id} (gtk-launch ${entry.id})`;
    }
    const argv = splitExec(entry.exec);
    if (argv.length) {
      await spawnDetached(argv[0]!, argv.slice(1), { env });
      return `Launched ${entry.name || entry.id} (${argv.join(' ')})`;
    }
  }
  const candidates = [t.value, t.value.toLowerCase(), t.value.toLowerCase().replace(/\s+/g, '-')];
  for (const c of [...new Set(candidates)]) {
    if (/[\s/]/.test(c)) continue;
    if (await which(c)) {
      await spawnDetached(c, [], { env });
      return `Launched ${c}`;
    }
  }
  throw desktopError('COMPUTER_USE_ERROR', `${backendName}: couldn't find an application named "${t.value}". Pass its command name (e.g. firefox, gnome-calculator, code), a file path, or a URL.`);
}

// ── backend ──────────────────────────────────────────────────────────────────

export class X11Backend extends CommandBackend implements DesktopBackend {
  readonly name = 'x11' as const;

  constructor(deps: BackendDeps) {
    super(deps);
  }

  async available(): Promise<BackendAvailability> {
    const missing: string[] = [];
    const pkgs: string[] = [];
    const notes: string[] = [];
    if (!this.deps.env.DISPLAY) {
      return {
        ok: false,
        missing: ['DISPLAY'],
        hint: 'no X11 display — DISPLAY is unset. Run QodeX inside your desktop session (or `export DISPLAY=:0`); on a headless server use a virtual display: `xvfb-run -a qodex`.',
        notes,
      };
    }
    if (!(await which('xdotool'))) { missing.push('xdotool'); pkgs.push('xdotool'); }
    const shot = await firstAvailable(X11_SCREENSHOT_TOOLS);
    if (!shot) { missing.push(X11_SCREENSHOT_TOOLS.join('|')); pkgs.push('scrot'); }
    else notes.push(`screenshots: ${shot}`);
    const clip = await firstAvailable(X11_CLIPBOARD_TOOLS);
    notes.push(clip ? `clipboard: ${clip}` : `clipboard: unavailable (install xclip: ${installHint(this.deps, ['xclip'])})`);
    notes.push((await which('wmctrl')) ? 'windows: wmctrl' : 'windows: xdotool search (install wmctrl for faster, complete window lists)');
    const scaler = await firstAvailable(IMAGE_SCALERS);
    notes.push(scaler ? `downscale: ${scaler}` : 'downscale: unavailable (install ImageMagick to shrink large screenshots)');
    if (this.deps.env.WAYLAND_DISPLAY || this.deps.env.XDG_SESSION_TYPE === 'wayland') {
      notes.push('Wayland session detected: X11 tools only see/drive XWayland apps. Set desktop.backend: wayland in ~/.qodex/config.yaml to use ydotool/grim instead.');
    }
    return { ok: missing.length === 0, missing, hint: pkgs.length ? installHint(this.deps, pkgs) : '', notes };
  }

  // ── screenshots ──

  async screenshot(opts: ScreenshotOptions): Promise<ScreenshotResult> {
    const notes: string[] = [];
    const dest = opts.path;
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rm(dest, { force: true }); // scrot appends _000 instead of overwriting
    let origin: Point = { x: 0, y: 0 };
    let win: WindowInfo | undefined;
    let captured = false;

    if (opts.window) {
      win = await this.findWindow(opts.window);
      if (win.bounds) origin = { x: win.bounds.x, y: win.bounds.y };
      if (win.id && (await which('import'))) {
        await this.check('import', ['-window', win.id, dest], { timeoutMs: 20_000 });
        captured = true;
      } else if (win.bounds) {
        await this.captureFull(dest);
        const scaler = await firstAvailable(IMAGE_SCALERS);
        if (scaler) {
          const b = win.bounds;
          await this.check(scaler, [dest, '-crop', `${int(b.width)}x${int(b.height)}+${int(b.x)}+${int(b.y)}`, '+repage', dest], { timeoutMs: 20_000 });
        } else {
          origin = { x: 0, y: 0 };
          notes.push(`Captured the full screen: cropping to "${windowLabel(win)}" needs ImageMagick (${installHint(this.deps, ['imagemagick'])}).`);
        }
        captured = true;
      } else {
        origin = { x: 0, y: 0 };
        notes.push(`Window "${windowLabel(win)}" has no known geometry; captured the full screen.`);
      }
    }
    if (!captured) await this.captureFull(dest);

    const raw = await readImageSize(dest);
    let size = raw;
    if (opts.maxWidth && raw.width > opts.maxWidth) {
      const scaler = await firstAvailable(IMAGE_SCALERS);
      if (scaler) {
        await this.check(scaler, [dest, '-resize', `${int(opts.maxWidth)}x`, dest], { timeoutMs: 20_000 });
        size = await readImageSize(dest);
      } else {
        notes.push(`Not downscaled (${raw.width}px wide): install ImageMagick (${installHint(this.deps, ['imagemagick'])}).`);
      }
    }
    return { path: dest, width: size.width, height: size.height, scale: size.width / raw.width, origin, window: win, notes };
  }

  private async captureFull(dest: string): Promise<void> {
    const tool = await firstAvailable(X11_SCREENSHOT_TOOLS);
    if (!tool) throw this.unavailable(X11_SCREENSHOT_TOOLS.join('|'), installHint(this.deps, ['scrot']));
    if (tool === 'scrot') await this.check('scrot', [dest], { timeoutMs: 20_000 });
    else if (tool === 'import') await this.check('import', ['-window', 'root', dest], { timeoutMs: 20_000 });
    else await this.check('gnome-screenshot', ['-f', dest], { timeoutMs: 20_000 });
  }

  // ── geometry ──

  async screenSize(): Promise<Size> {
    const out = await this.check('xdotool', ['getdisplaygeometry'], { timeoutMs: 5000 });
    const [w, h] = out.trim().split(/\s+/).map(Number);
    if (!w || !h) throw desktopError('COMPUTER_USE_ERROR', `x11: unexpected display geometry "${out.trim()}"`);
    return { width: w, height: h };
  }

  async cursor(): Promise<Point> {
    const vars = parseShellVars(await this.check('xdotool', ['getmouselocation', '--shell'], { timeoutMs: 5000 }));
    return { x: Number(vars.X ?? 0), y: Number(vars.Y ?? 0) };
  }

  // ── input ──

  async click(x: number, y: number, opts: ClickOptions = {}): Promise<void> {
    const count = Math.max(1, Math.min(3, Math.round(opts.count ?? 1)));
    const btn = BUTTONS[opts.button ?? 'left'];
    const args = ['mousemove', int(x), int(y), 'click'];
    if (count > 1) args.push('--repeat', String(count), '--delay', String(this.clickInterval()));
    args.push(btn);
    await this.check('xdotool', args);
  }

  async move(x: number, y: number): Promise<void> {
    await this.check('xdotool', ['mousemove', int(x), int(y)]);
  }

  async drag(x1: number, y1: number, x2: number, y2: number): Promise<void> {
    const pause = (Math.max(50, this.inputDelay * 2) / 1000).toFixed(2);
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    await this.check('xdotool', [
      'mousemove', int(x1), int(y1), 'mousedown', '1', 'sleep', pause,
      'mousemove', int(mx), int(my), 'sleep', pause,
      'mousemove', int(x2), int(y2), 'sleep', pause,
      'mouseup', '1',
    ]);
  }

  async scroll(dx: number, dy: number, at: Partial<Point> = {}): Promise<void> {
    const args: string[] = [];
    if (at.x !== undefined && at.y !== undefined) args.push('mousemove', int(at.x), int(at.y));
    const delay = String(Math.max(10, this.inputDelay));
    if (Math.round(dy)) args.push('click', '--repeat', String(Math.abs(Math.round(dy))), '--delay', delay, dy > 0 ? '5' : '4');
    if (Math.round(dx)) args.push('click', '--repeat', String(Math.abs(Math.round(dx))), '--delay', delay, dx > 0 ? '7' : '6');
    if (!args.length) return;
    await this.check('xdotool', args);
  }

  async type(text: string, opts: TypeOptions = {}): Promise<{ method: 'type' | 'paste' }> {
    const method = opts.method ?? 'auto';
    // Non-ASCII via xdotool silently types wrong letters (see header): paste it when we can.
    if (method === 'paste' || (method === 'auto' && hasNonAscii(text) && (await firstAvailable(X11_CLIPBOARD_TOOLS)))) {
      await this.pasteText(text, () => this.key('ctrl+v'));
      return { method: 'paste' };
    }
    const delay = Math.max(1, Math.min(this.inputDelay, 25));
    const runOpts = { env: utf8Env(this.deps.env), timeoutMs: 15_000 + text.length * (delay + 15) };
    // The text goes on stdin (`--file -`), never argv: a typed password must not show up
    // in `ps` / /proc/<pid>/cmdline, which other local users can read.
    let r = await this.run('xdotool', ['type', '--delay', String(delay), '--clearmodifiers', '--file', '-'], { ...runOpts, stdin: text });
    if (r.code !== 0 && r.code !== 130 && !r.timedOut && /unrecognized option|invalid option|unknown option|usage:/i.test(`${r.stderr}\n${r.stdout}`)) {
      // xdotool too old for --file: fall back to the argument form.
      r = await this.run('xdotool', ['type', '--delay', String(delay), '--clearmodifiers', '--', text], runOpts);
    }
    if (r.code === 0) return { method: 'type' };
    if (r.code === 130 || this.deps.signal?.aborted) throw desktopError('ABORTED', 'x11: typing aborted.');
    throw desktopError('COMPUTER_USE_ERROR', `x11: xdotool type exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  }

  async key(combo: string, opts: { repeat?: number } = {}): Promise<void> {
    const keys = x11KeyCombo(parseKeyCombo(combo));
    const repeat = Math.max(1, Math.min(100, Math.round(opts.repeat ?? 1)));
    await this.check('xdotool', ['key', '--clearmodifiers', '--delay', String(Math.max(10, this.inputDelay)), ...Array(repeat).fill(keys)]);
  }

  private clickInterval(): number {
    // Must stay well under the double-click interval (~400ms).
    return Math.max(40, Math.min(150, this.inputDelay * 2));
  }

  // ── windows ──

  async activeWindow(): Promise<WindowInfo | null> {
    const r = await this.run('xdotool', ['getactivewindow'], { timeoutMs: 5000 });
    if (r.code !== 0 || !r.stdout.trim()) return null;
    const id = r.stdout.trim().split(/\s+/)[0]!;
    return this.describeWindow(id, true);
  }

  private async describeWindow(id: string, focused?: boolean): Promise<WindowInfo> {
    const title = (await this.run('xdotool', ['getwindowname', id], { timeoutMs: 5000 })).stdout.trim();
    const pidOut = (await this.run('xdotool', ['getwindowpid', id], { timeoutMs: 5000 })).stdout.trim();
    const geo = parseShellVars((await this.run('xdotool', ['getwindowgeometry', '--shell', id], { timeoutMs: 5000 })).stdout);
    const pid = Number(pidOut) || undefined;
    const app = pid ? (await processNames([pid], this.deps.signal)).get(pid) : undefined;
    const w: WindowInfo = { id, title, pid, app };
    if (geo.WIDTH && geo.HEIGHT) {
      w.bounds = { x: Number(geo.X ?? 0), y: Number(geo.Y ?? 0), width: Number(geo.WIDTH), height: Number(geo.HEIGHT) };
    }
    if (focused !== undefined) w.focused = focused;
    return w;
  }

  async listWindows(app?: string): Promise<WindowInfo[]> {
    let wins: WindowInfo[] = [];
    if (await which('wmctrl')) {
      const r = await this.run('wmctrl', ['-lpG'], { timeoutMs: 8000 });
      if (r.code === 0) {
        wins = parseWmctrl(r.stdout);
        const names = await processNames(wins.map(w => w.pid ?? 0), this.deps.signal);
        for (const w of wins) if (w.pid) w.app = names.get(w.pid);
      }
    }
    if (!wins.length) {
      const r = await this.run('xdotool', ['search', '--onlyvisible', '--name', '.'], { timeoutMs: 8000 });
      const ids = r.code === 0 ? r.stdout.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 40) : [];
      for (const id of ids) {
        const w = await this.describeWindow(id);
        if (w.title) wins.push(w);
      }
    }
    const active = await this.run('xdotool', ['getactivewindow'], { timeoutMs: 5000 });
    const activeId = active.code === 0 ? active.stdout.trim() : '';
    for (const w of wins) w.focused = !!activeId && w.id === activeId;
    return app ? wins.filter(w => windowMatches(w, app)) : wins;
  }

  private async findWindow(query: string): Promise<WindowInfo> {
    const wins = await this.listWindows();
    const w = pickWindow(wins, query);
    if (!w) throw windowNotFound(query, wins);
    return w;
  }

  async focusWindow(query: string): Promise<WindowInfo> {
    const w = await this.findWindow(query);
    const r = await this.run('xdotool', ['windowactivate', w.id!], { timeoutMs: 5000 });
    if (r.code !== 0) {
      if (await which('wmctrl')) await this.check('wmctrl', ['-i', '-a', `0x${Number(w.id).toString(16)}`], { timeoutMs: 5000 });
      else throw desktopError('COMPUTER_USE_ERROR', `x11: couldn't activate "${windowLabel(w)}": ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
    }
    return { ...w, focused: true };
  }

  async openApp(target: string): Promise<string> {
    return openLinuxTarget(this.name, target, this.deps);
  }

  // ── clipboard ──

  async clipboardGet(): Promise<string> {
    const tool = await firstAvailable(X11_CLIPBOARD_TOOLS);
    if (!tool) throw this.unavailable(X11_CLIPBOARD_TOOLS.join('|'), installHint(this.deps, ['xclip']));
    const args = tool === 'xclip' ? ['-selection', 'clipboard', '-o'] : ['--clipboard', '--output'];
    const r = await this.run(tool, args, { timeoutMs: 5000, env: utf8Env(this.deps.env) });
    // xclip exits 1 ("target STRING not available") when the clipboard is empty.
    if (r.code !== 0) return '';
    return r.stdout;
  }

  async clipboardSet(text: string): Promise<void> {
    const tool = await firstAvailable(X11_CLIPBOARD_TOOLS);
    if (!tool) throw this.unavailable(X11_CLIPBOARD_TOOLS.join('|'), installHint(this.deps, ['xclip']));
    const args = tool === 'xclip' ? ['-selection', 'clipboard'] : ['--clipboard', '--input'];
    await this.check(tool, args, { stdin: text, timeoutMs: 5000, env: utf8Env(this.deps.env) });
  }
}
