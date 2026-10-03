/**
 * Linux / Wayland desktop backend.
 *
 * Wayland deliberately hides other clients' windows and input, so this backend
 * is more limited than X11:
 *   input       ydotool (needs the ydotoold daemon + /dev/uinput access)
 *   screenshots grim (wlroots: sway, Hyprland, ...) → gnome-screenshot → spectacle (KDE),
 *               the first that works
 *   clipboard   wl-copy / wl-paste
 *   windows     only where the compositor exposes them: sway (swaymsg) or
 *               Hyprland (hyprctl). Elsewhere window tools return a clear
 *               [COMPUTER_USE_UNSUPPORTED] note — use screenshot + locate.
 *
 * ydotool's `key` takes raw Linux input-event keycodes (`29:1 47:1 47:0 29:0`
 * = ctrl+v) and its `type` only knows US-layout ASCII, so non-ASCII text
 * (Persian) is pasted through wl-copy. Absolute pointer moves are emulated by
 * ydotool, so compositor pointer acceleration can skew them — a flat
 * acceleration profile is recommended (noted in screen_info).
 */

import { promises as fs } from 'fs';
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
  type PackageNames,
  type Point,
  type ScreenshotOptions,
  type ScreenshotResult,
  type Size,
  type TypeOptions,
  type WindowInfo,
  desktopError,
  hasNonAscii,
  linuxInstallHint,
  parseKeyCombo,
  pickWindow,
  readImageSize,
  windowMatches,
  windowNotFound,
} from './types.js';
import { firstAvailable, which } from '../exec.js';
import { IMAGE_SCALERS, openLinuxTarget, readOsRelease } from './x11.js';

export const WAYLAND_SCREENSHOT_TOOLS = ['grim', 'gnome-screenshot', 'spectacle'] as const;

const PKG: Record<string, PackageNames> = {
  ydotool: { apt: 'ydotool', dnf: 'ydotool', pacman: 'ydotool', zypper: 'ydotool' },
  grim: { apt: 'grim', dnf: 'grim', pacman: 'grim', zypper: 'grim' },
  'wl-clipboard': { apt: 'wl-clipboard', dnf: 'wl-clipboard', pacman: 'wl-clipboard', zypper: 'wl-clipboard' },
  imagemagick: { apt: 'imagemagick', dnf: 'ImageMagick', pacman: 'imagemagick', zypper: 'ImageMagick' },
};

function hint(deps: BackendDeps, keys: string[]): string {
  return linuxInstallHint(keys.map(k => PKG[k]).filter((p): p is PackageNames => !!p), readOsRelease(deps));
}

/** Linux input-event keycodes (linux/input-event-codes.h). */
export const LINUX_KEYCODES: Record<string, number> = {
  escape: 1, '1': 2, '2': 3, '3': 4, '4': 5, '5': 6, '6': 7, '7': 8, '8': 9, '9': 10, '0': 11,
  '-': 12, '=': 13, backspace: 14, tab: 15,
  q: 16, w: 17, e: 18, r: 19, t: 20, y: 21, u: 22, i: 23, o: 24, p: 25, '[': 26, ']': 27, enter: 28,
  ctrl: 29, a: 30, s: 31, d: 32, f: 33, g: 34, h: 35, j: 36, k: 37, l: 38, ';': 39, "'": 40, '`': 41,
  shift: 42, '\\': 43, z: 44, x: 45, c: 46, v: 47, b: 48, n: 49, m: 50, ',': 51, '.': 52, '/': 53,
  alt: 56, space: 57, capslock: 58,
  f1: 59, f2: 60, f3: 61, f4: 62, f5: 63, f6: 64, f7: 65, f8: 66, f9: 67, f10: 68,
  numlock: 69, scrolllock: 70, f11: 87, f12: 88, printscreen: 99,
  home: 102, up: 103, pageup: 104, left: 105, right: 106, end: 107, down: 108, pagedown: 109,
  insert: 110, delete: 111, pause: 119, super: 125, menu: 139,
  f13: 183, f14: 184, f15: 185, f16: 186, f17: 187, f18: 188, f19: 189, f20: 190, f21: 191, f22: 192, f23: 193, f24: 194,
};

/** ydotool `key` arguments for a combo: modifiers down, key down/up (× repeat), modifiers up. PURE. */
export function ydotoolKeyArgs(c: ParsedCombo, repeat = 1): string[] {
  const mods = [...c.modifiers];
  let key = c.key;
  if (key === '+') { key = '='; if (!mods.includes('shift')) mods.push('shift'); }
  const code = LINUX_KEYCODES[key];
  if (code === undefined) throw desktopError('COMPUTER_USE_ERROR', `wayland: key "${c.key}" has no keycode mapping.`);
  const modCodes = mods.map(m => LINUX_KEYCODES[m]!);
  const out: string[] = modCodes.map(m => `${m}:1`);
  for (let i = 0; i < repeat; i++) out.push(`${code}:1`, `${code}:0`);
  out.push(...[...modCodes].reverse().map(m => `${m}:0`));
  return out;
}

/** ydotool click codes: 0x40 = down, 0x80 = up, low bits = button. */
const BUTTON_BITS: Record<MouseButton, number> = { left: 0x00, right: 0x01, middle: 0x02 };
function clickCode(b: MouseButton, flags: number): string {
  return `0x${(flags | BUTTON_BITS[b]).toString(16).toUpperCase()}`;
}

function int(n: number): string {
  return String(Math.round(n));
}

interface SwayNode {
  id?: number; name?: string | null; type?: string; focused?: boolean; pid?: number;
  app_id?: string | null; window_properties?: { class?: string; title?: string };
  rect?: { x: number; y: number; width: number; height: number };
  nodes?: SwayNode[]; floating_nodes?: SwayNode[];
}

/** Flatten a `swaymsg -t get_tree` JSON into windows. PURE. */
export function parseSwayTree(json: string): WindowInfo[] {
  let root: SwayNode;
  try { root = JSON.parse(json); } catch { return []; }
  const out: WindowInfo[] = [];
  const walk = (n: SwayNode) => {
    const isWindow = (n.type === 'con' || n.type === 'floating_con') && (n.pid || n.app_id || n.window_properties);
    if (isWindow) {
      out.push({
        id: String(n.id),
        title: String(n.name ?? ''),
        app: String(n.app_id || n.window_properties?.class || ''),
        pid: n.pid,
        bounds: n.rect ? { x: n.rect.x, y: n.rect.y, width: n.rect.width, height: n.rect.height } : undefined,
        focused: !!n.focused,
      });
    }
    for (const c of n.nodes ?? []) walk(c);
    for (const c of n.floating_nodes ?? []) walk(c);
  };
  walk(root);
  return out;
}

/** Parse `hyprctl clients -j`. PURE. */
export function parseHyprClients(json: string, activeAddress?: string): WindowInfo[] {
  let list: any[];
  try { list = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(list)) return [];
  return list.filter(c => c && c.mapped !== false).map(c => ({
    id: String(c.address ?? ''),
    title: String(c.title ?? ''),
    app: String(c.class ?? c.initialClass ?? ''),
    pid: typeof c.pid === 'number' ? c.pid : undefined,
    bounds: Array.isArray(c.at) && Array.isArray(c.size) ? { x: c.at[0], y: c.at[1], width: c.size[0], height: c.size[1] } : undefined,
    focused: activeAddress ? c.address === activeAddress : c.focusHistoryID === 0,
  }));
}

/** Best plain-text MIME type among those the clipboard offers (`wl-paste --list-types`), or null. PURE. */
export function pickTextMime(types: string[]): string | null {
  const lower = types.map(t => t.toLowerCase());
  for (const want of ['text/plain;charset=utf-8', 'text/plain', 'utf8_string', 'string', 'text']) {
    const i = lower.indexOf(want);
    if (i >= 0) return types[i]!;
  }
  const i = lower.findIndex(t => t.startsWith('text/plain'));
  return i >= 0 ? types[i]! : null;
}

/** Screen sizes are expensive to probe on Wayland (no xdotool) — cache briefly. */
let sizeCache: { size: Size; at: number } | null = null;

export class WaylandBackend extends CommandBackend implements DesktopBackend {
  readonly name = 'wayland' as const;

  constructor(deps: BackendDeps) {
    super(deps);
  }

  async available(): Promise<BackendAvailability> {
    const missing: string[] = [];
    const pkgs: string[] = [];
    const notes: string[] = [];
    if (!(await which('ydotool'))) { missing.push('ydotool'); pkgs.push('ydotool'); }
    const shot = await firstAvailable(WAYLAND_SCREENSHOT_TOOLS);
    if (!shot) { missing.push(WAYLAND_SCREENSHOT_TOOLS.join('|')); pkgs.push('grim'); }
    else notes.push(`screenshots: ${shot}`);
    const clip = (await which('wl-copy')) && (await which('wl-paste'));
    notes.push(clip ? 'clipboard: wl-clipboard' : `clipboard: unavailable (${hint(this.deps, ['wl-clipboard'])}); non-ASCII typing needs it`);
    const wm = await this.windowManager();
    notes.push(wm ? `windows: ${wm}` : 'windows: not exposed by this compositor (only sway/Hyprland are supported) — use screenshot + computer_use_locate');
    notes.push('ydotool needs its daemon: `sudo systemctl enable --now ydotool` (or run `ydotoold`) and access to /dev/uinput.');
    notes.push('Pointer moves are emulated: if clicks land off-target, set a flat pointer-acceleration profile.');
    notes.push('ydotool types raw key codes through the ACTIVE keyboard layout: with a Persian (or other non-US) layout active, ASCII text comes out wrong — switch to an English/US layout, or use computer_use_type method "paste".');
    const hintText = pkgs.length ? `${hint(this.deps, pkgs)}; then start the daemon: sudo systemctl enable --now ydotool` : '';
    return { ok: missing.length === 0, missing, hint: hintText, notes };
  }

  private async windowManager(): Promise<'sway' | 'hyprland' | null> {
    if (this.deps.env.SWAYSOCK && (await which('swaymsg'))) return 'sway';
    if (this.deps.env.HYPRLAND_INSTANCE_SIGNATURE && (await which('hyprctl'))) return 'hyprland';
    if (await which('swaymsg')) return 'sway';
    if (await which('hyprctl')) return 'hyprland';
    return null;
  }

  private unsupported(what: string): Error {
    return desktopError('COMPUTER_USE_UNSUPPORTED', `wayland: ${what} isn't exposed by this compositor (Wayland hides other apps' windows; only sway and Hyprland are supported). Use computer_use_screenshot + computer_use_locate instead.`);
  }

  // ── screenshots ──

  async screenshot(opts: ScreenshotOptions): Promise<ScreenshotResult> {
    const notes: string[] = [];
    const dest = opts.path;
    await fs.mkdir(path.dirname(dest), { recursive: true });
    let origin: Point = { x: 0, y: 0 };
    let win: WindowInfo | undefined;
    let region: string | undefined;
    if (opts.window) {
      const wins = await this.listWindows().catch((e: Error) => {
        notes.push(`${e.message.replace(/^\[[A-Z_]+\]\s*/, '')} Captured the full screen.`);
        return null;
      });
      if (wins) {
        win = pickWindow(wins, opts.window);
        if (!win) throw windowNotFound(opts.window, wins);
        if (win.bounds) {
          origin = { x: win.bounds.x, y: win.bounds.y };
          region = `${int(win.bounds.x)},${int(win.bounds.y)} ${int(win.bounds.width)}x${int(win.bounds.height)}`;
        }
      }
    }
    const tools: string[] = [];
    for (const t of WAYLAND_SCREENSHOT_TOOLS) if (await which(t)) tools.push(t);
    if (!tools.length) throw this.unavailable(WAYLAND_SCREENSHOT_TOOLS.join('|'), hint(this.deps, ['grim']));
    // The first tool that WORKS: grim is often installed on GNOME / KDE too, but
    // only wlroots compositors (sway, Hyprland, ...) let it capture.
    let used: string | null = null;
    let lastErr: unknown;
    for (const tool of tools) {
      try {
        await fs.rm(dest, { force: true }); // no partial file from a failed attempt
        if (tool === 'grim') {
          const type = /\.jpe?g$/i.test(dest) ? ['-t', 'jpeg'] : [];
          const regionArgs = region ? ['-g', region] : [];
          // -s 1: logical-pixel image, the same space ydotool moves in (HiDPI-safe).
          const r = await this.run('grim', ['-s', '1', ...type, ...regionArgs, dest], { timeoutMs: 20_000 });
          if (r.code !== 0) await this.check('grim', [...type, ...regionArgs, dest], { timeoutMs: 20_000 });
        } else if (tool === 'gnome-screenshot') {
          await this.check('gnome-screenshot', ['-f', dest], { timeoutMs: 20_000 });
        } else {
          await this.check('spectacle', ['-b', '-n', '-f', '-o', dest], { timeoutMs: 20_000 });
        }
        used = tool;
        break;
      } catch (e) {
        this.throwIfAborted();
        lastErr = e;
      }
    }
    if (!used) throw lastErr;
    const regionApplied = used === 'grim' && !!region;
    if (region && !regionApplied) { notes.push(`${used} can't capture a region; captured the full screen.`); origin = { x: 0, y: 0 }; }
    const raw = await readImageSize(dest);
    if (!regionApplied) sizeCache = { size: raw, at: Date.now() };
    let size = raw;
    if (opts.maxWidth && raw.width > opts.maxWidth) {
      const scaler = await firstAvailable(IMAGE_SCALERS);
      if (scaler) {
        await this.check(scaler, [dest, '-resize', `${int(opts.maxWidth)}x`, dest], { timeoutMs: 20_000 });
        size = await readImageSize(dest);
      } else {
        notes.push(`Not downscaled (${raw.width}px wide): install ImageMagick (${hint(this.deps, ['imagemagick'])}).`);
      }
    }
    return { path: dest, width: size.width, height: size.height, scale: size.width / raw.width, origin, window: win, notes };
  }

  async screenSize(): Promise<Size> {
    const wm = await this.windowManager();
    if (wm === 'sway') {
      const r = await this.run('swaymsg', ['-t', 'get_outputs', '-r'], { timeoutMs: 5000 });
      try {
        const outs = (JSON.parse(r.stdout) as any[]).filter(o => o.active && o.rect);
        if (outs.length) {
          const w = Math.max(...outs.map(o => o.rect.x + o.rect.width));
          const h = Math.max(...outs.map(o => o.rect.y + o.rect.height));
          return { width: w, height: h };
        }
      } catch { /* fall through */ }
    } else if (wm === 'hyprland') {
      const r = await this.run('hyprctl', ['monitors', '-j'], { timeoutMs: 5000 });
      try {
        const mons = JSON.parse(r.stdout) as any[];
        if (mons.length) {
          const w = Math.max(...mons.map(m => m.x + Math.round(m.width / (m.scale || 1))));
          const h = Math.max(...mons.map(m => m.y + Math.round(m.height / (m.scale || 1))));
          return { width: w, height: h };
        }
      } catch { /* fall through */ }
    }
    if (sizeCache && Date.now() - sizeCache.at < 60_000) return sizeCache.size;
    // Measure with a throwaway screenshot, in a private (0700) directory: a predictable
    // name in the shared temp dir could be pre-created as a symlink by another user.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qodex-wl-size-'));
    try {
      const shot = await this.screenshot({ path: path.join(dir, 'size.png') });
      return { width: shot.width, height: shot.height };
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async cursor(): Promise<Point> {
    if ((await this.windowManager()) === 'hyprland') {
      const out = await this.check('hyprctl', ['cursorpos'], { timeoutMs: 5000 });
      const m = out.match(/(-?\d+)\s*,\s*(-?\d+)/);
      if (m) return { x: Number(m[1]), y: Number(m[2]) };
    }
    throw this.unsupported('the pointer position');
  }

  // ── input ──

  /** ydotool with a clearer error for the old 0.1.x CLI (Debian/Ubuntu ship it) and a missing daemon. */
  private async ydotool(args: string[], timeoutMs?: number, stdin?: string): Promise<void> {
    const r = await this.run('ydotool', args, { ...(timeoutMs ? { timeoutMs } : {}), ...(stdin !== undefined ? { stdin } : {}) });
    if (r.code === 0) return;
    if (r.code === 130) throw desktopError('ABORTED', 'wayland: ydotool aborted.');
    const detail = (r.stderr || r.stdout).trim().replace(/\s+/g, ' ').slice(0, 300);
    let advice = '';
    if (/unrecognized option|invalid option|unknown option|usage:/i.test(detail)) {
      advice = ' This looks like ydotool 0.1.x; QodeX needs ydotool >= 1.0 (https://github.com/ReimuNotMoe/ydotool), or log into an X11 session.';
    } else if (/socket|connect|ydotoold|uinput|permission denied/i.test(detail)) {
      advice = ' Start the daemon (`sudo systemctl enable --now ydotool` or `ydotoold &`) and make sure you can access /dev/uinput.';
    }
    throw desktopError('COMPUTER_USE_ERROR', `wayland: ydotool ${args[0]} exited ${r.code}${detail ? `: ${detail}` : ''}.${advice}`);
  }

  private async moveAbs(x: number, y: number): Promise<void> {
    await this.ydotool(['mousemove', '--absolute', '-x', int(x), '-y', int(y)]);
  }

  async click(x: number, y: number, opts: ClickOptions = {}): Promise<void> {
    const count = Math.max(1, Math.min(3, Math.round(opts.count ?? 1)));
    await this.moveAbs(x, y);
    const args = ['click'];
    if (count > 1) args.push('--repeat', String(count), '--next-delay', String(Math.max(40, Math.min(150, this.inputDelay * 2))));
    args.push(clickCode(opts.button ?? 'left', 0xc0));
    await this.ydotool(args);
  }

  async move(x: number, y: number): Promise<void> {
    await this.moveAbs(x, y);
  }

  async drag(x1: number, y1: number, x2: number, y2: number): Promise<void> {
    await this.moveAbs(x1, y1);
    await this.ydotool(['click', clickCode('left', 0x40)]);
    await this.wait(Math.max(50, this.inputDelay * 2));
    // Relative move while the button is held: an "absolute" ydotool move first
    // slams the pointer into the corner, which would drag there.
    await this.ydotool(['mousemove', '-x', int(x2 - x1), '-y', int(y2 - y1)]);
    await this.wait(Math.max(50, this.inputDelay * 2));
    await this.ydotool(['click', clickCode('left', 0x80)]);
  }

  async scroll(dx: number, dy: number, at: Partial<Point> = {}): Promise<void> {
    if (at.x !== undefined && at.y !== undefined) await this.moveAbs(at.x, at.y);
    if (!Math.round(dx) && !Math.round(dy)) return;
    // REL_WHEEL > 0 scrolls up; REL_HWHEEL > 0 scrolls right.
    await this.ydotool(['mousemove', '--wheel', '-x', int(dx), '-y', int(-dy)]);
  }

  async type(text: string, opts: TypeOptions = {}): Promise<{ method: 'type' | 'paste' }> {
    const method = opts.method ?? 'auto';
    if (method === 'paste' || (method === 'auto' && hasNonAscii(text))) {
      if (!(await which('wl-copy'))) {
        throw this.unavailable('wl-copy', `${hint(this.deps, ['wl-clipboard'])} (ydotool can only type US-layout ASCII; other text is pasted)`);
      }
      await this.pasteText(text, () => this.key('ctrl+v'));
      return { method: 'paste' };
    }
    const delay = Math.max(1, Math.min(this.inputDelay, 25));
    const timeoutMs = 15_000 + text.length * (delay * 2 + 15);
    try {
      // Text on stdin (`--file -`), never argv: a typed password must not show up in `ps`.
      await this.ydotool(['type', '--key-delay', String(delay), '--file', '-'], timeoutMs, text);
    } catch (e: any) {
      if (!/unrecognized option|invalid option|unknown option|usage:/i.test(String(e?.message ?? e))) throw e;
      await this.ydotool(['type', '--key-delay', String(delay), '--', text], timeoutMs);
    }
    return { method: 'type' };
  }

  async key(combo: string, opts: { repeat?: number } = {}): Promise<void> {
    const repeat = Math.max(1, Math.min(100, Math.round(opts.repeat ?? 1)));
    await this.ydotool(['key', ...ydotoolKeyArgs(parseKeyCombo(combo), repeat)]);
  }

  // ── windows ──

  async listWindows(app?: string): Promise<WindowInfo[]> {
    const wm = await this.windowManager();
    let wins: WindowInfo[];
    if (wm === 'sway') {
      wins = parseSwayTree(await this.check('swaymsg', ['-t', 'get_tree', '-r'], { timeoutMs: 8000 }));
    } else if (wm === 'hyprland') {
      const active = await this.run('hyprctl', ['activewindow', '-j'], { timeoutMs: 5000 });
      let activeAddr: string | undefined;
      try { activeAddr = JSON.parse(active.stdout)?.address; } catch { activeAddr = undefined; }
      wins = parseHyprClients(await this.check('hyprctl', ['clients', '-j'], { timeoutMs: 8000 }), activeAddr);
    } else {
      throw this.unsupported('the window list');
    }
    return app ? wins.filter(w => windowMatches(w, app)) : wins;
  }

  async activeWindow(): Promise<WindowInfo | null> {
    const wins = await this.listWindows();
    return wins.find(w => w.focused) ?? null;
  }

  async focusWindow(query: string): Promise<WindowInfo> {
    const wm = await this.windowManager();
    if (!wm) throw this.unsupported('window focusing');
    const wins = await this.listWindows();
    const w = pickWindow(wins, query);
    if (!w) throw windowNotFound(query, wins);
    if (wm === 'sway') await this.check('swaymsg', [`[con_id=${w.id}]`, 'focus'], { timeoutMs: 5000 });
    else await this.check('hyprctl', ['dispatch', 'focuswindow', `address:${w.id}`], { timeoutMs: 5000 });
    return { ...w, focused: true };
  }

  async openApp(target: string): Promise<string> {
    return openLinuxTarget(this.name, target, this.deps);
  }

  // ── clipboard ──

  async clipboardGet(): Promise<string> {
    if (!(await which('wl-paste'))) throw this.unavailable('wl-paste', hint(this.deps, ['wl-clipboard']));
    // Ask for a TEXT type explicitly: plain `wl-paste` outputs whatever was copied —
    // PNG bytes for a copied image — which would reach the model as garbage and be
    // "restored" as text after a paste.
    const types = await this.run('wl-paste', ['--list-types'], { timeoutMs: 5000 });
    if (types.code !== 0) return ''; // "Nothing is copied"
    const mime = pickTextMime(types.stdout.split('\n').map(s => s.trim()).filter(Boolean));
    if (!mime) return '';
    const r = await this.run('wl-paste', ['--no-newline', '--type', mime], { timeoutMs: 5000 });
    return r.code === 0 ? r.stdout : '';
  }

  async clipboardSet(text: string): Promise<void> {
    if (!(await which('wl-copy'))) throw this.unavailable('wl-copy', hint(this.deps, ['wl-clipboard']));
    if (text === '') await this.check('wl-copy', ['--clear'], { timeoutMs: 5000 });
    else await this.check('wl-copy', [], { stdin: text, timeoutMs: 5000 });
  }
}
