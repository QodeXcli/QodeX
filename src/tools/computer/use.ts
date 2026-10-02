/**
 * `computer_use_*` tools — control the user's real desktop (beyond the browser):
 * native apps, system dialogs, Finder/Explorer/Settings, anything on screen.
 *
 * Cross-platform via backends (./backends): macOS (screencapture/osascript/
 * cliclick/CoreGraphics), Linux X11 (xdotool/scrot/xclip/wmctrl), Linux
 * Wayland (ydotool/grim/wl-clipboard, sway/Hyprland windows) and Windows
 * (PowerShell + user32/SendKeys/System.Drawing).
 *
 * COORDINATES — the one rule the model must follow: x/y are PIXELS OF THE
 * LAST SCREENSHOT it took (computer_use_screenshot or computer_use_locate).
 * Screenshots may be Retina (×2), downscaled to desktop.screenshotMaxWidth, or
 * cropped to a window; we remember that screenshot's scale + origin and map
 * the coordinates back to the screen before any input (backends/index.ts).
 *
 * The main model is text-only: it "sees" via computer_use_locate (vision model
 * returns an element's coordinates) or vision_analyze on the screenshot path.
 *
 * Tool flags:
 *   - Every input tool is isReadOnly=false, isDestructive=true.
 *   - computer_use_screenshot (and computer_use_locate) are ALSO isReadOnly=false
 *     although they only observe: the agent loop runs read-only calls of one
 *     model response FIRST and in parallel, and caches them per iteration, so a
 *     read-only screenshot requested after a click in the same response would
 *     capture the screen BEFORE the click.
 *   - computer_use_clipboard can SET the clipboard, so it is not read-only.
 *   - Tools whose output contains text from other apps (window titles,
 *     clipboard) set untrustedOutput so Sentinel fences it as data.
 *
 * Safety: consequential actions are reviewed by Sentinel at the registry
 * choke point (desktop category; secret-looking typing is critical). Typed
 * text is never echoed back or logged. `desktop.enabled: false` disables all
 * of these tools ([COMPUTER_USE_DISABLED]).
 */

import { z } from 'zod';
import { promises as fs, existsSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { getActiveConfig } from '../../config/loader.js';
import { resolveDesktopConfig, type DesktopConfig } from '../../config/agent-config.js';
import { getBus } from '../../control/bus.js';
import {
  captureScreenshot,
  checkInScreenshot,
  defaultScreenshotPath,
  getDesktopBackend,
  getLastCapture,
  toScreenPoint,
  toScreenshotPoint,
  type BackendAvailability,
  type DesktopBackend,
  type MappedPoint,
  type WindowInfo,
} from './backends/index.js';

// ── shared plumbing ──────────────────────────────────────────────────────────

export interface DesktopSession {
  backend: DesktopBackend;
  cfg: DesktopConfig;
  availability: BackendAvailability;
}

/** Format an availability failure as the model-facing error. PURE. */
export function unavailableMessage(backend: string, av: BackendAvailability): string {
  const label = av.missing.includes('DISPLAY') ? 'Fix' : 'Install';
  return `[COMPUTER_USE_UNAVAILABLE] ${backend}: missing ${av.missing.join(', ')}. ${label}: ${av.hint || 'see the QodeX docs for desktop control'}`;
}

/**
 * Resolve config + backend + availability for one tool call. Returns a
 * ToolResult (isError) when desktop control is disabled or unusable here.
 */
export async function openDesktop(ctx: ToolContext): Promise<DesktopSession | ToolResult> {
  const cfg = resolveDesktopConfig(getActiveConfig());
  if (!cfg.enabled) {
    return {
      content: '[COMPUTER_USE_DISABLED] Desktop control is turned off (desktop.enabled: false in ~/.qodex/config.yaml). Ask the user to enable it, or do the task another way.',
      isError: true,
    };
  }
  const backend = getDesktopBackend(cfg, { signal: ctx.signal });
  if (!backend) {
    return {
      content: `[COMPUTER_USE_UNAVAILABLE] ${process.platform}: no desktop backend for this OS. Supported: macOS, Linux (X11 or Wayland) and Windows.`,
      isError: true,
    };
  }
  const availability = await backend.available();
  if (!availability.ok) return { content: unavailableMessage(backend.name, availability), isError: true };
  return { backend, cfg, availability };
}

function isResult(x: DesktopSession | ToolResult): x is ToolResult {
  return (x as ToolResult).content !== undefined;
}

/** Turn a thrown error into a `[CODE] ...` tool result. */
export function desktopErrorResult(toolName: string, e: unknown): ToolResult {
  const msg = String((e as any)?.message ?? e).trim();
  if (/^\[[A-Z_]+\]/.test(msg)) return { content: msg, isError: true };
  return { content: `[COMPUTER_USE_ERROR] ${toolName} failed: ${msg}`, isError: true };
}

/** Run a desktop tool body with config/backend checks, abort handling and error mapping. */
export async function runDesktopTool(
  toolName: string,
  ctx: ToolContext,
  fn: (s: DesktopSession) => Promise<ToolResult>,
): Promise<ToolResult> {
  if (ctx.signal?.aborted) return { content: `[ABORTED] ${toolName} was cancelled.`, isError: true };
  try {
    const s = await openDesktop(ctx);
    if (isResult(s)) return s;
    return await fn(s);
  } catch (e) {
    return desktopErrorResult(toolName, e);
  }
}

/** Record a desktop action on the bus (control center timeline, channels). Never includes typed text. */
export function publishDesktopAction(tool: string, summary: string, data: Record<string, unknown> = {}): void {
  try {
    getBus().publish({ kind: 'agent', source: 'desktop', type: 'action', data: { tool, summary, ...data } });
  } catch { /* the bus must never break a tool */ }
}

/** Absolute path for a user-supplied file path (relative → ctx.cwd, ~ → home). */
export function resolveUserPath(p: string, cwd: string): string {
  const expanded = p.replace(/^~(?=$|[\\/])/, os.homedir());
  return path.resolve(cwd, expanded);
}

/** Map + validate model coordinates; returns an error result or the screen point. */
function mapPoint(x: number, y: number): MappedPoint | ToolResult {
  const err = checkInScreenshot(x, y);
  if (err) return { content: `[COMPUTER_USE_ERROR] ${err}`, isError: true };
  return toScreenPoint(x, y);
}

function isPoint(p: MappedPoint | ToolResult): p is MappedPoint {
  return (p as MappedPoint).mapped !== undefined;
}

function mappingNote(p: MappedPoint): string {
  return p.mapped ? '' : ' (no screenshot yet — treated as screen coordinates; take computer_use_screenshot first)';
}

function fmtRect(b: WindowInfo['bounds']): string {
  return b ? `${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}×${Math.round(b.height)}` : 'unknown';
}

/** One-line window description; `maxTitle` truncates the (untrusted) title. PURE. */
export function formatWindow(w: WindowInfo, maxTitle = 300): string {
  const title = (w.title || '(untitled)').replace(/\s+/g, ' ');
  const parts = [`"${title.length > maxTitle ? `${title.slice(0, maxTitle)}…` : title}"`];
  if (w.app) parts.push(`app: ${w.app}`);
  if (w.pid) parts.push(`pid ${w.pid}`);
  if (w.bounds) parts.push(`screen ${fmtRect(w.bounds)}`);
  return `${w.focused ? '[focused] ' : ''}${parts.join(' · ')}`;
}

const COORD_HELP = 'in pixels of the most recent computer_use_screenshot (top-left = 0,0)';

// ─────────────────────────────────────────────────────────────────────────────
// computer_use_screenshot

const ScreenshotArgs = z.object({
  path: z.string().describe('Where to save the image (.png or .jpg; relative to the working dir). Default: ~/.qodex/screenshots/desktop-<time>.png.').optional(),
  window: z.string().describe('Capture only this window: an app name or part of a window title (e.g. "Safari", "Settings", "Untitled - Notepad"). Omit for the whole screen.').optional(),
});

export class ComputerUseScreenshotTool extends Tool<z.infer<typeof ScreenshotArgs>> {
  name = 'computer_use_screenshot';
  description =
    'Take a screenshot of the desktop (or one window) and save it to a file. You cannot see the image yourself: follow up with ' +
    'computer_use_locate {description} to get an element\'s click coordinates, or vision_analyze {image_path, prompt} to read/describe the screen. ' +
    'All coordinates you pass to computer_use_click/move/drag/scroll are pixels of the MOST RECENT screenshot (QodeX maps them to the real screen, incl. Retina/HiDPI scaling). ' +
    'Take a fresh screenshot after actions that change the screen.';
  // Not read-only on purpose: read-only calls run before mutating ones in the same response (see header).
  isReadOnly = false;
  isDestructive = false;
  argsSchema = ScreenshotArgs;

  async execute(args: z.infer<typeof ScreenshotArgs>, ctx: ToolContext): Promise<ToolResult> {
    // Only image paths: a stray `path: "src/index.ts"` must never clobber a source file.
    if (args.path && !/\.(png|jpe?g)$/i.test(args.path.trim())) {
      return { content: `[COMPUTER_USE_ERROR] computer_use_screenshot path must end with .png, .jpg or .jpeg (got "${args.path}"). Omit it to use ~/.qodex/screenshots.`, isError: true };
    }
    return runDesktopTool(this.name, ctx, async ({ backend, cfg }) => {
      const dest = args.path ? resolveUserPath(args.path.trim(), ctx.cwd) : defaultScreenshotPath('desktop');
      const { shot, mapping } = await captureScreenshot(backend, { dest, window: args.window, maxWidth: cfg.screenshotMaxWidth });
      let sizeBytes = 0;
      try { sizeBytes = (await fs.stat(shot.path)).size; } catch { /* reported below anyway */ }
      const lines = [
        `Screenshot saved: ${shot.path}`,
        `  Size: ${shot.width}×${shot.height} px (${(sizeBytes / 1024).toFixed(1)} KB)`,
        // Short title only: this result is not fenced as untrusted, and titles come from other apps.
        shot.window ? `  Window: ${formatWindow(shot.window, 60)}` : '  Capture: full screen',
        `  Coordinates: pass x,y ${COORD_HELP} to computer_use_click / move / drag / scroll${Math.abs(mapping.scale - 1) > 0.001 ? ` (scale ${mapping.scale.toFixed(3)} is applied automatically)` : ''}.`,
        ...shot.notes.map(n => `  Note: ${n}`),
        '',
        `Next: computer_use_locate {"description": "<the element>"} to get its coordinates, or vision_analyze {"image_path": "${shot.path}", "prompt": "..."} to read the screen.`,
      ];
      publishDesktopAction(this.name, `screenshot${shot.window ? ` of "${shot.window.title || shot.window.app}"` : ''}`, { path: shot.path });
      return {
        content: lines.join('\n'),
        metadata: { path: shot.path, width: shot.width, height: shot.height, scale: mapping.scale, origin: mapping.origin, backend: backend.name, window: shot.window?.title, sizeBytes },
      };
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// computer_use_click

const ClickArgs = z.object({
  x: z.number().describe(`X ${COORD_HELP}. Get it from computer_use_locate.`),
  y: z.number().describe(`Y ${COORD_HELP}.`),
  button: z.enum(['left', 'right', 'middle']).describe('Mouse button. Default left.').optional(),
  count: z.number().int().min(1).max(3).describe('1 = single, 2 = double, 3 = triple click. Default 1.').optional(),
});

export class ComputerUseClickTool extends Tool<z.infer<typeof ClickArgs>> {
  name = 'computer_use_click';
  description =
    `Click at a point on the real desktop. x/y are ${COORD_HELP} — get them from computer_use_locate, never guess. ` +
    'Supports right/middle click and double/triple click. Take a screenshot afterwards to verify the result.';
  isReadOnly = false;
  isDestructive = true;
  argsSchema = ClickArgs;

  async execute(args: z.infer<typeof ClickArgs>, ctx: ToolContext): Promise<ToolResult> {
    return runDesktopTool(this.name, ctx, async ({ backend }) => {
      const p = mapPoint(args.x, args.y);
      if (!isPoint(p)) return p;
      const button = args.button ?? 'left';
      const count = args.count ?? 1;
      await backend.click(p.x, p.y, { button, count });
      const what = `${count === 2 ? 'Double-clicked' : count === 3 ? 'Triple-clicked' : 'Clicked'}${button !== 'left' ? ` (${button} button)` : ''}`;
      publishDesktopAction(this.name, `${what} at ${Math.round(args.x)},${Math.round(args.y)}`);
      return {
        content: `✓ ${what} at (${Math.round(args.x)}, ${Math.round(args.y)}) → screen (${p.x}, ${p.y})${mappingNote(p)}. Take computer_use_screenshot to verify.`,
        metadata: { x: args.x, y: args.y, screenX: p.x, screenY: p.y, button, count },
      };
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// computer_use_type

const TypeArgs = z.object({
  text: z.string().min(1).describe('Text to type into the focused field. Newlines press Enter.'),
  method: z.enum(['auto', 'type', 'paste']).describe('auto (default): type, but paste non-Latin text (Persian, emoji) via the clipboard; type: always key events (use in terminals); paste: always clipboard + paste shortcut (fast for long text; the previous clipboard is restored).').optional(),
  submit: z.boolean().describe('Press Enter after typing. Default false.').optional(),
});

export class ComputerUseTypeTool extends Tool<z.infer<typeof TypeArgs>> {
  name = 'computer_use_type';
  description =
    'Type text into the currently focused field of the active app (click the field or computer_use_focus_window first). ' +
    'Handles Persian/Unicode by pasting through the clipboard. Never type passwords or card numbers unless the user gave them for this exact purpose.';
  isReadOnly = false;
  isDestructive = true;
  argsSchema = TypeArgs;

  async execute(args: z.infer<typeof TypeArgs>, ctx: ToolContext): Promise<ToolResult> {
    return runDesktopTool(this.name, ctx, async ({ backend }) => {
      const res = await backend.type(args.text, { method: args.method ?? 'auto' });
      if (args.submit) await backend.key('enter');
      const n = [...args.text].length;
      publishDesktopAction(this.name, `typed ${n} character(s)${args.submit ? ' + Enter' : ''}`, { method: res.method });
      return {
        content: `✓ Typed ${n} character(s)${res.method === 'paste' ? ' (pasted via the clipboard)' : ''}${args.submit ? ' and pressed Enter' : ''}. Take computer_use_screenshot to verify.`,
        metadata: { chars: n, method: res.method, submitted: !!args.submit },
      };
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// computer_use_key

const KeyArgs = z.object({
  combo: z.string().min(1).describe('Key or combo: "enter", "esc", "tab", "backspace" (erase left), "delete" (erase right), "up", "pagedown", "f5", "ctrl+s", "cmd+shift+4", "alt+tab", "super". cmd/win/super are the same key; on macOS cmd = Command.'),
  repeat: z.number().int().min(1).max(100).describe('Press it this many times (e.g. 5 × "down"). Default 1.').optional(),
});

export class ComputerUseKeyTool extends Tool<z.infer<typeof KeyArgs>> {
  name = 'computer_use_key';
  description =
    'Press a key or keyboard shortcut in the active app (save, close, switch apps, navigate menus/lists, confirm dialogs). ' +
    'Prefer shortcuts over clicking when they are reliable. For text use computer_use_type.';
  isReadOnly = false;
  isDestructive = true;
  argsSchema = KeyArgs;

  async execute(args: z.infer<typeof KeyArgs>, ctx: ToolContext): Promise<ToolResult> {
    return runDesktopTool(this.name, ctx, async ({ backend }) => {
      const repeat = args.repeat ?? 1;
      await backend.key(args.combo, { repeat });
      publishDesktopAction(this.name, `pressed ${args.combo}${repeat > 1 ? ` ×${repeat}` : ''}`);
      return { content: `✓ Pressed ${args.combo}${repeat > 1 ? ` ×${repeat}` : ''}.`, metadata: { combo: args.combo, repeat } };
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// computer_use_active_window

const ActiveWindowArgs = z.object({});

export class ComputerUseActiveWindowTool extends Tool<z.infer<typeof ActiveWindowArgs>> {
  name = 'computer_use_active_window';
  description = 'Get the focused app and window (title, bounds). Use it to check you are in the right window before typing or pressing keys. Read-only.';
  isReadOnly = true;
  isDestructive = false;
  untrustedOutput = true; // window titles come from other apps / web pages
  argsSchema = ActiveWindowArgs;

  async execute(_args: z.infer<typeof ActiveWindowArgs>, ctx: ToolContext): Promise<ToolResult> {
    return runDesktopTool(this.name, ctx, async ({ backend }) => {
      const w = await backend.activeWindow();
      if (!w) {
        return { content: 'No active window reported (nothing focused, or the window manager does not expose it). Use computer_use_list_windows or a screenshot.' };
      }
      const lines = [`Active app: ${w.app || 'unknown'}`, `Window: ${w.title || '(untitled)'}`];
      if (w.bounds) lines.push(`Bounds (screen): ${fmtRect(w.bounds)}`);
      if (w.pid) lines.push(`PID: ${w.pid}`);
      return { content: lines.join('\n'), metadata: { app: w.app, title: w.title, bounds: w.bounds, pid: w.pid } };
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// computer_use_list_windows

const ListWindowsArgs = z.object({
  app: z.string().describe('Only windows whose app name or title contains this text. Omit to list all.').optional(),
});

export class ComputerUseListWindowsTool extends Tool<z.infer<typeof ListWindowsArgs>> {
  name = 'computer_use_list_windows';
  description = 'List open windows (app, title, focused, screen bounds). Use it to find the window to focus or capture. Read-only.';
  isReadOnly = true;
  isDestructive = false;
  untrustedOutput = true;
  argsSchema = ListWindowsArgs;

  async execute(args: z.infer<typeof ListWindowsArgs>, ctx: ToolContext): Promise<ToolResult> {
    return runDesktopTool(this.name, ctx, async ({ backend }) => {
      const wins = await backend.listWindows(args.app);
      if (!wins.length) return { content: args.app ? `No windows match "${args.app}".` : 'No windows found.' };
      const shown = wins.slice(0, 100);
      const more = wins.length > shown.length ? `\n… ${wins.length - shown.length} more` : '';
      return {
        content: `${wins.length} window(s)${args.app ? ` matching "${args.app}"` : ''}:\n${shown.map(w => `- ${formatWindow(w)}`).join('\n')}${more}`,
        metadata: { count: wins.length },
      };
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// computer_use_move

const MoveArgs = z.object({
  x: z.number().describe(`X ${COORD_HELP}.`),
  y: z.number().describe(`Y ${COORD_HELP}.`),
});

export class ComputerUseMoveTool extends Tool<z.infer<typeof MoveArgs>> {
  name = 'computer_use_move';
  description = `Move the mouse pointer without clicking (to reveal hover menus/tooltips). x/y ${COORD_HELP}.`;
  isReadOnly = false;
  isDestructive = true;
  argsSchema = MoveArgs;

  async execute(args: z.infer<typeof MoveArgs>, ctx: ToolContext): Promise<ToolResult> {
    return runDesktopTool(this.name, ctx, async ({ backend }) => {
      const p = mapPoint(args.x, args.y);
      if (!isPoint(p)) return p;
      await backend.move(p.x, p.y);
      publishDesktopAction(this.name, `moved pointer to ${Math.round(args.x)},${Math.round(args.y)}`);
      return { content: `✓ Moved the pointer to (${Math.round(args.x)}, ${Math.round(args.y)}) → screen (${p.x}, ${p.y})${mappingNote(p)}.`, metadata: { screenX: p.x, screenY: p.y } };
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// computer_use_drag

const DragArgs = z.object({
  from_x: z.number().describe(`Start X ${COORD_HELP}.`),
  from_y: z.number().describe('Start Y.'),
  to_x: z.number().describe('End X.'),
  to_y: z.number().describe('End Y.'),
});

export class ComputerUseDragTool extends Tool<z.infer<typeof DragArgs>> {
  name = 'computer_use_drag';
  description = `Drag with the left mouse button held: move files/windows, sliders, selections. Coordinates ${COORD_HELP}.`;
  isReadOnly = false;
  isDestructive = true;
  argsSchema = DragArgs;

  async execute(args: z.infer<typeof DragArgs>, ctx: ToolContext): Promise<ToolResult> {
    return runDesktopTool(this.name, ctx, async ({ backend }) => {
      const a = mapPoint(args.from_x, args.from_y);
      if (!isPoint(a)) return a;
      const b = mapPoint(args.to_x, args.to_y);
      if (!isPoint(b)) return b;
      await backend.drag(a.x, a.y, b.x, b.y);
      publishDesktopAction(this.name, `dragged ${Math.round(args.from_x)},${Math.round(args.from_y)} → ${Math.round(args.to_x)},${Math.round(args.to_y)}`);
      return {
        content: `✓ Dragged (${Math.round(args.from_x)}, ${Math.round(args.from_y)}) → (${Math.round(args.to_x)}, ${Math.round(args.to_y)}) [screen (${a.x}, ${a.y}) → (${b.x}, ${b.y})]${mappingNote(a)}. Take computer_use_screenshot to verify.`,
        metadata: { from: { x: a.x, y: a.y }, to: { x: b.x, y: b.y } },
      };
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// computer_use_scroll

const ScrollArgs = z.object({
  direction: z.enum(['up', 'down', 'left', 'right']).describe('Scroll direction.'),
  amount: z.number().int().min(1).max(50).describe('Wheel notches (about 3 lines each). Default 5.').optional(),
  x: z.number().describe(`Scroll over this point (X ${COORD_HELP}). Omit to scroll wherever the pointer is.`).optional(),
  y: z.number().describe('Scroll over this point (Y). Give both x and y.').optional(),
});

export class ComputerUseScrollTool extends Tool<z.infer<typeof ScrollArgs>> {
  name = 'computer_use_scroll';
  description = 'Scroll with the mouse wheel, optionally over a specific point (the pane under the pointer scrolls). Take a screenshot afterwards to see the new content.';
  isReadOnly = false;
  isDestructive = true;
  argsSchema = ScrollArgs;

  async execute(args: z.infer<typeof ScrollArgs>, ctx: ToolContext): Promise<ToolResult> {
    return runDesktopTool(this.name, ctx, async ({ backend }) => {
      const n = args.amount ?? 5;
      const dx = args.direction === 'right' ? n : args.direction === 'left' ? -n : 0;
      const dy = args.direction === 'down' ? n : args.direction === 'up' ? -n : 0;
      let at: MappedPoint | undefined;
      if (args.x !== undefined && args.y !== undefined) {
        const p = mapPoint(args.x, args.y);
        if (!isPoint(p)) return p;
        at = p;
      }
      await backend.scroll(dx, dy, at ? { x: at.x, y: at.y } : {});
      publishDesktopAction(this.name, `scrolled ${args.direction} ×${n}`);
      return {
        content: `✓ Scrolled ${args.direction} ${n} notch(es)${at ? ` at (${Math.round(args.x!)}, ${Math.round(args.y!)}) → screen (${at.x}, ${at.y})` : ''}. Take computer_use_screenshot to see the result.`,
        metadata: { direction: args.direction, amount: n },
      };
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// computer_use_clipboard

const ClipboardArgs = z.object({
  action: z.enum(['get', 'set']).describe('get = read the clipboard text; set = replace it with `text`.'),
  text: z.string().describe('Text to put on the clipboard (action=set).').optional(),
});

const CLIPBOARD_MAX_CHARS = 20_000;

export class ComputerUseClipboardTool extends Tool<z.infer<typeof ClipboardArgs>> {
  name = 'computer_use_clipboard';
  description = 'Read or set the system clipboard text. Useful to move text between apps (copy with ctrl/cmd+c via computer_use_key, then get) or to paste long text.';
  // `set` mutates user state, so the whole tool is not read-only.
  isReadOnly = false;
  isDestructive = true;
  untrustedOutput = true; // clipboard contents come from other apps
  argsSchema = ClipboardArgs;

  async execute(args: z.infer<typeof ClipboardArgs>, ctx: ToolContext): Promise<ToolResult> {
    if (args.action === 'set' && args.text === undefined) {
      return { content: '[COMPUTER_USE_ERROR] computer_use_clipboard action=set needs `text`.', isError: true };
    }
    return runDesktopTool(this.name, ctx, async ({ backend }) => {
      if (args.action === 'set') {
        await backend.clipboardSet(args.text!);
        publishDesktopAction(this.name, `set clipboard (${args.text!.length} chars)`);
        return { content: `✓ Clipboard set (${args.text!.length} characters).`, metadata: { chars: args.text!.length } };
      }
      const text = await backend.clipboardGet();
      if (!text) return { content: 'The clipboard is empty (or holds no text).', metadata: { chars: 0 } };
      const shown = text.length > CLIPBOARD_MAX_CHARS ? `${text.slice(0, CLIPBOARD_MAX_CHARS)}\n… [${text.length - CLIPBOARD_MAX_CHARS} more characters]` : text;
      return { content: `Clipboard (${text.length} characters):\n${shown}`, metadata: { chars: text.length } };
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// computer_use_open

const OpenArgs = z.object({
  target: z.string().min(1).describe('An app name ("Calculator", "Visual Studio Code", "firefox", "notepad"), a file/folder path (relative to the working dir or absolute), or a URL (opens in the default app/browser).'),
});

export class ComputerUseOpenTool extends Tool<z.infer<typeof OpenArgs>> {
  name = 'computer_use_open';
  description =
    'Open an application, a file/folder, or a URL with the system default handler. More reliable than clicking icons. ' +
    'For web tasks prefer the QodeX browser tools (browser_*), which you can read and control precisely.';
  isReadOnly = false;
  isDestructive = true;
  argsSchema = OpenArgs;

  async execute(args: z.infer<typeof OpenArgs>, ctx: ToolContext): Promise<ToolResult> {
    return runDesktopTool(this.name, ctx, async ({ backend }) => {
      let target = args.target.trim();
      // Relative paths are relative to the agent's working dir, not QodeX's process cwd.
      if (!/^[a-z][a-z0-9+.-]*:/i.test(target) || /^[a-z]:[\\/]/i.test(target)) {
        const candidate = resolveUserPath(target, ctx.cwd);
        if (/^(~|\.{1,2})?[\\/]/.test(target) || existsSync(candidate)) target = candidate;
      }
      const did = await backend.openApp(target);
      publishDesktopAction(this.name, did);
      return { content: `✓ ${did}. Give it a moment to appear, then computer_use_screenshot (or computer_use_focus_window).`, metadata: { target } };
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// computer_use_screen_info

const ScreenInfoArgs = z.object({});

export class ComputerUseScreenInfoTool extends Tool<z.infer<typeof ScreenInfoArgs>> {
  name = 'computer_use_screen_info';
  description = 'Desktop facts: backend (macOS/X11/Wayland/Windows), screen size, pointer position, the last screenshot\'s coordinate mapping, and which capabilities are available. Read-only.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = ScreenInfoArgs;

  async execute(_args: z.infer<typeof ScreenInfoArgs>, ctx: ToolContext): Promise<ToolResult> {
    return runDesktopTool(this.name, ctx, async ({ backend, availability, cfg }) => {
      const lines = [`Backend: ${backend.name}`];
      const meta: Record<string, unknown> = { backend: backend.name };
      try {
        const s = await backend.screenSize();
        lines.push(`Screen: ${s.width}×${s.height} (logical input coordinates)`);
        meta.screen = s;
      } catch (e: any) {
        lines.push(`Screen: unknown (${String(e?.message ?? e).replace(/^\[[A-Z_]+\]\s*/, '')})`);
      }
      const cap = getLastCapture();
      try {
        const c = await backend.cursor();
        const inShot = cap ? toScreenshotPoint(c.x, c.y, cap) : null;
        lines.push(`Pointer: screen (${c.x}, ${c.y})${inShot ? ` = (${inShot.x}, ${inShot.y}) in the last screenshot` : ''}`);
        meta.cursor = c;
      } catch (e: any) {
        lines.push(`Pointer: unavailable (${String(e?.message ?? e).replace(/^\[[A-Z_]+\]\s*/, '').slice(0, 160)})`);
      }
      if (cap) {
        const age = Math.round((Date.now() - cap.ts) / 1000);
        lines.push(`Last screenshot: ${cap.path} — ${cap.width}×${cap.height} px, scale ${cap.scale.toFixed(3)}, origin (${cap.origin.x}, ${cap.origin.y})${cap.window ? `, window "${cap.window}"` : ''}, ${age}s ago. Tool coordinates are mapped from these pixels.`);
        meta.lastScreenshot = cap;
      } else {
        lines.push('Last screenshot: none yet — coordinates are treated as screen coordinates until you take one.');
      }
      lines.push(`Screenshots are downscaled to ≤ ${cfg.screenshotMaxWidth}px wide when a scaler is available.`);
      if (availability.notes.length) lines.push('Capabilities:', ...availability.notes.map(n => `  - ${n}`));
      return { content: lines.join('\n'), metadata: meta };
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// computer_use_focus_window

const FocusArgs = z.object({
  query: z.string().min(1).describe('App name or part of the window title to bring to the front (e.g. "Terminal", "Excel", "Inbox").'),
});

export class ComputerUseFocusWindowTool extends Tool<z.infer<typeof FocusArgs>> {
  name = 'computer_use_focus_window';
  description = 'Bring a window to the front (by app name or title substring) so keys/typing go to it. Restores minimized windows where the OS allows.';
  isReadOnly = false;
  isDestructive = true;
  untrustedOutput = true;
  argsSchema = FocusArgs;

  async execute(args: z.infer<typeof FocusArgs>, ctx: ToolContext): Promise<ToolResult> {
    return runDesktopTool(this.name, ctx, async ({ backend }) => {
      const w = await backend.focusWindow(args.query);
      publishDesktopAction(this.name, `focused ${w.app || w.title}`);
      return { content: `✓ Focused ${formatWindow(w)}. Take computer_use_screenshot before clicking (window positions may have changed).`, metadata: { app: w.app, title: w.title } };
    });
  }
}
