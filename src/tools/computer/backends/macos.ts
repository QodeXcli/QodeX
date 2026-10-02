/**
 * macOS desktop backend.
 *
 *   screenshots screencapture (-x silent; -l<CGWindowID> / -R rect for windows)
 *   downscale   sips --resampleWidth
 *   mouse       cliclick (c:/dc:/tc:/rc:/m:) when installed, else CoreGraphics
 *               events via JXA (`osascript -l JavaScript`, ObjC.import('CoreGraphics'))
 *   drag/scroll CoreGraphics via JXA (down → dragged steps → up; scroll-wheel events)
 *   keys        System Events `key code` / `keystroke ... using {command down}`
 *   text        cliclick t: / keystroke for ASCII; NON-ASCII (Persian, emoji)
 *               is pasted via pbcopy + cmd+v (keystroke can't type it), with
 *               the previous clipboard restored afterwards
 *   windows     System Events (+ CGWindowList via JXA for window screenshots)
 *   open        open <url|path>, open -a <App>
 *
 * Retina: screencapture saves physical pixels while input uses points, so
 * scale = screenshot pixel width / logical screen width (2 on Retina). The
 * tool layer divides model coordinates by it.
 *
 * Permissions: the terminal running QodeX needs Accessibility (input) and
 * Screen Recording (screenshots / window titles) in System Settings → Privacy
 * & Security. macOS shows the prompt on first use; we never bypass it.
 */

import { promises as fs, existsSync } from 'fs';
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
  type Rect,
  type ScreenshotOptions,
  type ScreenshotResult,
  type Size,
  type TypeOptions,
  type WindowInfo,
  classifyOpenTarget,
  desktopError,
  hasNonAscii,
  isJpegPath,
  parseKeyCombo,
  pickWindow,
  readImageSize,
  windowMatches,
  windowNotFound,
} from './types.js';
import { missingCommands, utf8Env, which } from '../exec.js';

const PERMISSION_HINT = 'grant your terminal app Accessibility and Screen Recording access in System Settings → Privacy & Security, then retry';

/** AppleScript string literal. PURE. */
export function asString(s: string): string {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** AppleScript `key code` numbers for named keys. */
export const MAC_KEY_CODES: Record<string, number> = {
  enter: 36, tab: 48, space: 49, backspace: 51, escape: 53, delete: 117, insert: 114,
  home: 115, end: 119, pageup: 116, pagedown: 121, left: 123, right: 124, down: 125, up: 126,
  capslock: 57, super: 55, shift: 56, alt: 58, ctrl: 59,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109,
  f11: 103, f12: 111, f13: 105, f14: 107, f15: 113, f16: 106, f17: 64, f18: 79, f19: 80, f20: 90,
};

const MAC_MODIFIERS: Record<string, string> = { super: 'command down', ctrl: 'control down', alt: 'option down', shift: 'shift down' };

/** AppleScript statement pressing a parsed combo (repeat times). PURE. */
export function appleScriptKey(c: ParsedCombo, repeat = 1, delaySec = 0.04): string {
  const mods = c.modifiers.map(m => MAC_MODIFIERS[m]!);
  const using = mods.length ? ` using {${mods.join(', ')}}` : '';
  let press: string;
  if (c.key in MAC_KEY_CODES) press = `key code ${MAC_KEY_CODES[c.key]}${using}`;
  else if (c.key.length === 1) press = `keystroke ${asString(c.key)}${using}`;
  else throw desktopError('COMPUTER_USE_ERROR', `macos: key "${c.key}" is not available on macOS${c.key === 'printscreen' ? ' (use cmd+shift+3 / cmd+shift+4)' : ''}.`);
  const body = repeat > 1 ? `repeat ${repeat} times\n    ${press}\n    delay ${delaySec}\n  end repeat` : press;
  return `tell application "System Events"\n  ${body}\nend tell`;
}

// ── CoreGraphics via JXA ─────────────────────────────────────────────────────

export type MouseOp =
  | { t: 'move'; x: number; y: number }
  | { t: 'click'; x: number; y: number; button: MouseButton; count: number }
  | { t: 'drag'; x1: number; y1: number; x2: number; y2: number; steps: number; pauseMs: number }
  | { t: 'scroll'; dx: number; dy: number; at?: Point };

const CG_DOWN: Record<MouseButton, number> = { left: 1, right: 3, middle: 25 };
const CG_UP: Record<MouseButton, number> = { left: 2, right: 4, middle: 26 };
const CG_BUTTON: Record<MouseButton, number> = { left: 0, right: 1, middle: 2 };
const LINES_PER_NOTCH = 3;

/**
 * JXA program posting CoreGraphics mouse events (kCGHIDEventTap = 0;
 * event types: 5 moved, 1/2 left down/up, 3/4 right, 25/26 other, 6 left
 * dragged; field 1 = kCGMouseEventClickState). PURE.
 */
export function jxaMouseScript(ops: MouseOp[]): string {
  const lines: string[] = [
    "ObjC.import('CoreGraphics');",
    'function post(type, x, y, btn, clicks) {',
    '  var e = $.CGEventCreateMouseEvent(null, type, $.CGPointMake(x, y), btn);',
    '  if (clicks) $.CGEventSetIntegerValueField(e, 1, clicks);',
    '  $.CGEventPost(0, e);',
    '}',
    'function wheel(dy, dx) {',
    '  var e = null;',
    '  try { e = $.CGEventCreateScrollWheelEvent2(null, 1, 2, dy, dx, 0); } catch (err) { e = null; }',
    '  if (!e) e = $.CGEventCreateScrollWheelEvent(null, 1, 2, dy, dx);',
    '  $.CGEventPost(0, e);',
    '}',
  ];
  const r = (n: number) => Math.round(n);
  for (const op of ops) {
    if (op.t === 'move') {
      lines.push(`post(5, ${r(op.x)}, ${r(op.y)}, 0, 0);`);
    } else if (op.t === 'click') {
      lines.push(`post(5, ${r(op.x)}, ${r(op.y)}, 0, 0);`);
      for (let i = 1; i <= op.count; i++) {
        lines.push(`post(${CG_DOWN[op.button]}, ${r(op.x)}, ${r(op.y)}, ${CG_BUTTON[op.button]}, ${i});`);
        lines.push(`post(${CG_UP[op.button]}, ${r(op.x)}, ${r(op.y)}, ${CG_BUTTON[op.button]}, ${i});`);
        if (i < op.count) lines.push('delay(0.03);');
      }
    } else if (op.t === 'drag') {
      const pause = (op.pauseMs / 1000).toFixed(3);
      lines.push(`post(5, ${r(op.x1)}, ${r(op.y1)}, 0, 0);`);
      lines.push(`post(1, ${r(op.x1)}, ${r(op.y1)}, 0, 1);`);
      lines.push(`delay(${pause});`);
      for (let i = 1; i <= op.steps; i++) {
        const x = op.x1 + ((op.x2 - op.x1) * i) / op.steps;
        const y = op.y1 + ((op.y2 - op.y1) * i) / op.steps;
        lines.push(`post(6, ${r(x)}, ${r(y)}, 0, 1);`);
        lines.push('delay(0.012);');
      }
      lines.push(`delay(${pause});`);
      lines.push(`post(2, ${r(op.x2)}, ${r(op.y2)}, 0, 1);`);
    } else {
      if (op.at) lines.push(`post(5, ${r(op.at.x)}, ${r(op.at.y)}, 0, 0);`);
      // Line units; positive wheel1 scrolls UP / wheel2 scrolls LEFT.
      lines.push(`wheel(${-r(op.dy) * LINES_PER_NOTCH}, ${-r(op.dx) * LINES_PER_NOTCH});`);
    }
  }
  lines.push("'ok';");
  return lines.join('\n');
}

/** JXA: primary display size in points. PURE. */
export const JXA_SCREEN_SIZE = [
  "ObjC.import('AppKit');",
  'var f = $.NSScreen.screens.objectAtIndex(0).frame;',
  'JSON.stringify({ width: f.size.width, height: f.size.height });',
].join('\n');

export const JXA_CURSOR = [
  "ObjC.import('CoreGraphics');",
  'var p = $.CGEventGetLocation($.CGEventCreate(null));',
  'JSON.stringify({ x: p.x, y: p.y });',
].join('\n');

/** JXA: front-most on-screen window whose owner or title matches `query` (CGWindowList). PURE. */
export function jxaFindWindowScript(query: string): string {
  return [
    "ObjC.import('CoreGraphics');",
    `var q = ${JSON.stringify(query.toLowerCase())};`,
    'var raw = $.CGWindowListCopyWindowInfo(1 | 16, 0);',
    'var list = ObjC.deepUnwrap(ObjC.castRefToObject(raw)) || [];',
    'var hit = null, partial = null;',
    'for (var i = 0; i < list.length; i++) {',
    '  var w = list[i];',
    '  if (!w || w.kCGWindowLayer !== 0 || !w.kCGWindowBounds) continue;',
    "  var o = String(w.kCGWindowOwnerName || '').toLowerCase(), n = String(w.kCGWindowName || '').toLowerCase();",
    '  if (o === q || n === q) { hit = w; break; }',
    '  if (!partial && (o.indexOf(q) >= 0 || n.indexOf(q) >= 0)) partial = w;',
    '}',
    'hit = hit || partial;',
    "hit ? JSON.stringify({ id: hit.kCGWindowNumber, app: String(hit.kCGWindowOwnerName || ''), title: String(hit.kCGWindowName || ''),",
    '  x: hit.kCGWindowBounds.X, y: hit.kCGWindowBounds.Y, width: hit.kCGWindowBounds.Width, height: hit.kCGWindowBounds.Height }) : "";',
  ].join('\n');
}

const LIST_WINDOWS_SCRIPT = `set out to ""
tell application "System Events"
  repeat with p in (every application process whose background only is false)
    set pn to name of p
    set pidv to unix id of p
    set fm to frontmost of p
    try
      repeat with w in (every window of p)
        set wn to ""
        try
          set wn to (name of w) as text
        end try
        set px to ""
        set py to ""
        set sw to ""
        set sh to ""
        try
          set {px, py} to position of w
          set {sw, sh} to size of w
        end try
        set out to out & pn & tab & wn & tab & px & tab & py & tab & sw & tab & sh & tab & fm & tab & pidv & linefeed
        set fm to false
      end repeat
    end try
  end repeat
end tell
return out`;

const ACTIVE_WINDOW_SCRIPT = `tell application "System Events"
  set frontApp to first application process whose frontmost is true
  set appName to name of frontApp
  set pidv to unix id of frontApp
  try
    set w to window 1 of frontApp
    set wn to ""
    try
      set wn to (name of w) as text
    end try
    set {px, py} to position of w
    set {sw, sh} to size of w
    return appName & tab & wn & tab & px & tab & py & tab & sw & tab & sh & tab & "true" & tab & pidv
  on error
    return appName & tab & "" & tab & "" & tab & "" & tab & "" & tab & "" & tab & "true" & tab & pidv
  end try
end tell`;

/** Parse the tab-separated window lines our AppleScripts print. PURE. */
export function parseMacWindowLines(out: string): WindowInfo[] {
  const wins: WindowInfo[] = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [app, title, px, py, sw, sh, fm, pid] = line.split('\t');
    const t = !title || title === 'missing value' ? '' : title;
    const w: WindowInfo = { app: app ?? '', title: t, focused: fm === 'true' };
    const nums = [px, py, sw, sh].map(v => (v === undefined || v === '' ? NaN : Number(v)));
    if (nums.every(n => Number.isFinite(n))) w.bounds = { x: nums[0]!, y: nums[1]!, width: nums[2]!, height: nums[3]! };
    if (pid && Number(pid) > 0) w.pid = Number(pid);
    wins.push(w);
  }
  return wins;
}

export class MacosBackend extends CommandBackend implements DesktopBackend {
  readonly name = 'macos' as const;

  constructor(deps: BackendDeps) {
    super(deps);
  }

  async available(): Promise<BackendAvailability> {
    const missing = await missingCommands(['screencapture', 'osascript']);
    const notes: string[] = [];
    notes.push((await which('cliclick')) ? 'mouse: cliclick' : 'mouse: CoreGraphics via JXA (optional: `brew install cliclick` for faster clicks)');
    notes.push((await which('sips')) ? 'downscale: sips' : 'downscale: unavailable');
    notes.push('Needs Accessibility (input) and Screen Recording (screenshots) permission for your terminal app — macOS prompts on first use.');
    return {
      ok: missing.length === 0,
      missing,
      hint: missing.length ? 'these ship with macOS — make sure /usr/sbin and /usr/bin are on PATH' : '',
      notes,
    };
  }

  private async osa(script: string, timeoutMs = 10_000): Promise<string> {
    try {
      return await this.check('osascript', ['-e', script], { timeoutMs });
    } catch (e: any) {
      throw this.permissionAware(e);
    }
  }

  private async jxa(script: string, timeoutMs = 10_000): Promise<string> {
    try {
      return await this.check('osascript', ['-l', 'JavaScript', '-e', script], { timeoutMs });
    } catch (e: any) {
      throw this.permissionAware(e);
    }
  }

  /** Add the Accessibility/Screen-Recording hint to TCC-looking failures. */
  private permissionAware(e: Error): Error {
    const msg = String(e?.message ?? e);
    // -25211: no Accessibility access; -1743: Automation (Apple Events) not permitted.
    if (/not allowed|assistive|accessibility|-1743|-25211|not authori[sz]ed|privilege/i.test(msg)) {
      return desktopError('COMPUTER_USE_ERROR', `${msg.replace(/^\[[A-Z_]+\]\s*/, '')} — ${PERMISSION_HINT}.`);
    }
    return e;
  }

  // ── screenshots ──

  async screenshot(opts: ScreenshotOptions): Promise<ScreenshotResult> {
    const notes: string[] = [];
    const dest = opts.path;
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const typeArgs = isJpegPath(dest) ? ['-t', 'jpg'] : [];
    let origin: Point = { x: 0, y: 0 };
    let logicalWidth: number;
    let win: WindowInfo | undefined;

    if (opts.window) {
      let cg: (Rect & { id: number; app: string; title: string }) | null = null;
      try {
        const out = (await this.jxa(jxaFindWindowScript(opts.window))).trim();
        if (out) cg = JSON.parse(out);
      } catch { cg = null; }
      if (cg && cg.width > 0) {
        await this.check('screencapture', ['-x', '-o', `-l${cg.id}`, ...typeArgs, dest], { timeoutMs: 20_000 });
        win = { id: String(cg.id), app: cg.app, title: cg.title, bounds: { x: cg.x, y: cg.y, width: cg.width, height: cg.height } };
      } else {
        const wins = await this.listWindows();
        const w = pickWindow(wins, opts.window);
        if (!w) throw windowNotFound(opts.window, wins);
        if (!w.bounds || w.bounds.width <= 0) throw desktopError('COMPUTER_USE_ERROR', `macos: window "${w.title || w.app}" has no on-screen bounds (minimized?). Focus it first with computer_use_focus_window.`);
        const b = w.bounds;
        await this.check('screencapture', ['-x', `-R${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.width)},${Math.round(b.height)}`, ...typeArgs, dest], { timeoutMs: 20_000 });
        notes.push('Captured the window\'s screen area (anything covering it is included).');
        win = w;
      }
      origin = { x: win.bounds!.x, y: win.bounds!.y };
      logicalWidth = win.bounds!.width;
    } else {
      await this.check('screencapture', ['-x', ...typeArgs, dest], { timeoutMs: 20_000 });
      logicalWidth = (await this.screenSize()).width;
    }

    const raw = await readImageSize(dest);
    let size = raw;
    if (opts.maxWidth && raw.width > opts.maxWidth) {
      if (await which('sips')) {
        await this.check('sips', ['--resampleWidth', String(Math.round(opts.maxWidth)), dest, '--out', dest], { timeoutMs: 20_000 });
        size = await readImageSize(dest);
      } else {
        notes.push(`Not downscaled (${raw.width}px wide): sips not found.`);
      }
    }
    return { path: dest, width: size.width, height: size.height, scale: size.width / logicalWidth, origin, window: win, notes };
  }

  // ── geometry ──

  async screenSize(): Promise<Size> {
    try {
      const s = JSON.parse((await this.jxa(JXA_SCREEN_SIZE)).trim());
      if (s && s.width > 0 && s.height > 0) return { width: Math.round(s.width), height: Math.round(s.height) };
    } catch { /* fall back to Finder */ }
    const out = await this.osa('tell application "Finder" to get bounds of window of desktop');
    const nums = out.split(',').map(s => Number(s.trim()));
    if (nums.length === 4 && nums.every(Number.isFinite) && nums[2]! > 0) {
      return { width: nums[2]! - nums[0]!, height: nums[3]! - nums[1]! };
    }
    throw desktopError('COMPUTER_USE_ERROR', `macos: couldn't read the screen size (${out.trim()})`);
  }

  async cursor(): Promise<Point> {
    const p = JSON.parse((await this.jxa(JXA_CURSOR)).trim());
    return { x: Math.round(Number(p.x)), y: Math.round(Number(p.y)) };
  }

  // ── input ──

  private cc(n: number): string {
    const v = Math.round(n);
    return v < 0 ? `=${v}` : String(v); // cliclick needs "=" before negative absolutes
  }

  private async mouse(ops: MouseOp[]): Promise<void> {
    await this.jxa(jxaMouseScript(ops), 15_000);
  }

  async click(x: number, y: number, opts: ClickOptions = {}): Promise<void> {
    const count = Math.max(1, Math.min(3, Math.round(opts.count ?? 1)));
    const button = opts.button ?? 'left';
    if (button !== 'middle' && (await which('cliclick'))) {
      const at = `${this.cc(x)},${this.cc(y)}`;
      const cmd = button === 'right' ? `rc:${at}` : count === 3 ? `tc:${at}` : count === 2 ? `dc:${at}` : `c:${at}`;
      await this.check('cliclick', [cmd], { timeoutMs: 8000 });
      return;
    }
    await this.mouse([{ t: 'click', x, y, button, count }]);
  }

  async move(x: number, y: number): Promise<void> {
    if (await which('cliclick')) {
      await this.check('cliclick', [`m:${this.cc(x)},${this.cc(y)}`], { timeoutMs: 8000 });
      return;
    }
    await this.mouse([{ t: 'move', x, y }]);
  }

  async drag(x1: number, y1: number, x2: number, y2: number): Promise<void> {
    // CoreGraphics gives apps the full down → dragged… → up sequence they
    // expect (cliclick's dd:/du: skips the intermediate drag events on older versions).
    const dist = Math.hypot(x2 - x1, y2 - y1);
    const steps = Math.max(4, Math.min(40, Math.round(dist / 25)));
    await this.mouse([{ t: 'drag', x1, y1, x2, y2, steps, pauseMs: Math.max(60, this.inputDelay * 2) }]);
  }

  async scroll(dx: number, dy: number, at: Partial<Point> = {}): Promise<void> {
    if (!Math.round(dx) && !Math.round(dy)) return;
    const point = at.x !== undefined && at.y !== undefined ? { x: at.x, y: at.y } : undefined;
    await this.mouse([{ t: 'scroll', dx, dy, at: point }]);
  }

  async type(text: string, opts: TypeOptions = {}): Promise<{ method: 'type' | 'paste' }> {
    const method = opts.method ?? 'auto';
    // keystroke/cliclick can't produce non-ASCII (Persian, accents, emoji) — paste it.
    if (method === 'paste' || (method === 'auto' && hasNonAscii(text))) {
      await this.pasteText(text, () => this.key('cmd+v'));
      return { method: 'paste' };
    }
    const lines = text.split(/\r?\n/);
    const cliclick = await which('cliclick');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line) {
        if (cliclick) await this.check('cliclick', [`t:${line}`], { timeoutMs: 15_000 + line.length * 40 });
        else await this.osa(`tell application "System Events" to keystroke ${asString(line)}`, 15_000 + line.length * 40);
      }
      if (i < lines.length - 1) await this.key('enter');
    }
    return { method: 'type' };
  }

  async key(combo: string, opts: { repeat?: number } = {}): Promise<void> {
    const repeat = Math.max(1, Math.min(100, Math.round(opts.repeat ?? 1)));
    await this.osa(appleScriptKey(parseKeyCombo(combo), repeat, Math.max(0.01, this.inputDelay / 1000)));
  }

  // ── windows ──

  async activeWindow(): Promise<WindowInfo | null> {
    const wins = parseMacWindowLines(await this.osa(ACTIVE_WINDOW_SCRIPT));
    return wins[0] ?? null;
  }

  async listWindows(app?: string): Promise<WindowInfo[]> {
    const wins = parseMacWindowLines(await this.osa(LIST_WINDOWS_SCRIPT, 20_000));
    return app ? wins.filter(w => windowMatches(w, app)) : wins;
  }

  async focusWindow(query: string): Promise<WindowInfo> {
    const wins = await this.listWindows();
    const w = pickWindow(wins, query);
    if (!w) throw windowNotFound(query, wins);
    const raise = w.title
      ? `\n    try\n      perform action "AXRaise" of (first window whose name is ${asString(w.title)})\n    end try`
      : '';
    await this.osa(`tell application "System Events"\n  tell process ${asString(w.app ?? '')}\n    set frontmost to true${raise}\n  end tell\nend tell`);
    return { ...w, focused: true };
  }

  async openApp(target: string): Promise<string> {
    const t = classifyOpenTarget(target, p => existsSync(p));
    if (t.kind === 'url') {
      await this.check('open', [t.value], { timeoutMs: 15_000 });
      return `Opened URL ${t.value}`;
    }
    if (t.kind === 'path') {
      const p = t.value.replace(/^~(?=$|\/)/, this.deps.env.HOME || os.homedir());
      await this.check('open', [p], { timeoutMs: 15_000 });
      return `Opened ${p}`;
    }
    const r = await this.run('open', ['-a', t.value], { timeoutMs: 15_000 });
    if (r.code !== 0) {
      throw desktopError('COMPUTER_USE_ERROR', `macos: couldn't open app "${t.value}": ${(r.stderr || r.stdout).trim().slice(0, 200)}. Use the name shown in /Applications (e.g. "Safari", "System Settings", "Visual Studio Code").`);
    }
    return `Opened app ${t.value}`;
  }

  // ── clipboard ──

  async clipboardGet(): Promise<string> {
    const r = await this.run('pbpaste', [], { timeoutMs: 5000, env: utf8Env(this.deps.env, 'en_US.UTF-8') });
    if (r.code !== 0) throw desktopError('COMPUTER_USE_ERROR', `macos: pbpaste exited ${r.code}: ${r.stderr.trim().slice(0, 200)}`);
    return r.stdout;
  }

  async clipboardSet(text: string): Promise<void> {
    await this.check('pbcopy', [], { stdin: text, timeoutMs: 5000, env: utf8Env(this.deps.env, 'en_US.UTF-8') });
  }
}
