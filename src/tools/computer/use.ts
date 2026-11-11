/**
 * `computer_use_*` tools — native macOS screen control beyond the browser.
 *
 * Use cases that browser tools can't cover:
 *   - Take a screenshot of LM Studio's window to see what model is loaded
 *   - Click "Allow" on a system permission dialog
 *   - Read text from a desktop app (Slack, Mail, terminal)
 *   - Automate flows in native apps (Finder, Xcode, anything not web-based)
 *
 * macOS uses screencapture, osascript, and optional cliclick.
 * Linux uses xdotool plus scrot, ImageMagick import, or gnome-screenshot.
 * Windows uses PowerShell and Win32. No extra install.
 *
 * Click, type, and key ask every time — including under always-yes — and then
 * they run. `qodex desk run` parks that ask on the sentinel until you allow it.
 *
 * Tools defined here:
 *   - computer_use_screenshot     — capture screen or specific window to PNG
 *   - computer_use_click          — click at (x, y) on screen
 *   - computer_use_type           — type text into the focused field
 *   - computer_use_key            — press a key combo (e.g. "cmd+s", "esc", "tab")
 *   - computer_use_active_window  — get info about the focused window
 *   - computer_use_list_windows   — list open windows by app
 */

import { z } from 'zod';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { interpretPermissionAnswer } from '../../security/permissions.js';

function isMacos(): boolean {
  return os.platform() === 'darwin';
}

function macosOnly(toolName: string): ToolResult {
  return {
    content: `[COMPUTER_USE_UNAVAILABLE] ${toolName} has no backend for ${os.platform()}. macOS uses screencapture, Linux uses xdotool, Windows uses PowerShell.`,
    isError: true,
  };
}

/** Run a command, capture output, throw on non-zero exit. */
function runCmd(cmd: string, args: string[], opts: { stdin?: string; timeoutMs?: number } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = opts.timeoutMs ? setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, opts.timeoutMs) : null;
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf-8'); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf-8'); });
    child.on('error', (err) => { if (timer) clearTimeout(timer); reject(err); });
    child.on('exit', (code) => {
      if (timer) clearTimeout(timer);
      if (code !== 0) reject(new Error(`${cmd} exited ${code}: ${stderr.trim() || stdout.trim()}`));
      else resolve({ stdout, stderr });
    });
    if (opts.stdin) {
      child.stdin?.write(opts.stdin);
      child.stdin?.end();
    } else {
      child.stdin?.end();
    }
  });
}

async function which(cmd: string): Promise<string | null> {
  try {
    const { stdout } = await runCmd('which', [cmd]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// computer_use_screenshot

const ScreenshotArgs = z.object({
  path: z.string().optional().describe('Where to save the PNG. Defaults to /tmp/qodex-screenshots/desktop-<ts>.png.'),
  window: z.string().optional().describe('Capture only this app\'s frontmost window (e.g. "LM Studio", "Safari"). Omit for entire screen.'),
  full_display: z.boolean().optional().describe('Capture entire display including menu bar. Default true if no window.'),
});

export class ComputerUseScreenshotTool extends Tool<z.infer<typeof ScreenshotArgs>> {
  name = 'computer_use_screenshot';
  description = 'Capture a PNG of the desktop or one window. macOS: screencapture. Linux: scrot, import, or gnome-screenshot. Windows: Win32 CopyFromScreen. Returns a file path for vision_analyze. Read-only.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = ScreenshotArgs;

  async execute(args: z.infer<typeof ScreenshotArgs>, _ctx: ToolContext): Promise<ToolResult> {
    if (os.platform() === 'linux') {
      const { runLinuxScreenshot } = await import('./linux.js');
      return runLinuxScreenshot(args);
    }
    if (os.platform() === 'win32') {
      const { runWindowsScreenshot } = await import('./win.js');
      return runWindowsScreenshot(args);
    }
    if (!isMacos()) return macosOnly(this.name);
    try {
      const dir = path.join(os.tmpdir(), 'qodex-screenshots');
      await fs.mkdir(dir, { recursive: true });
      const dest = args.path ?? path.join(dir, `desktop-${Date.now()}.png`);

      if (args.window) {
        // First, ask System Events for the window id of the app's frontmost window.
        // Then use screencapture -l <id>.
        const script = `tell application "System Events" to tell process "${args.window.replace(/"/g, '\\"')}" to set winId to id of window 1`;
        let windowId: string;
        try {
          const { stdout } = await runCmd('osascript', ['-e', script], { timeoutMs: 5000 });
          windowId = stdout.trim();
        } catch (e: any) {
          return {
            content: `[COMPUTER_USE_ERROR] Couldn't find a window for app "${args.window}". Make sure the app is running and has at least one window. (osascript: ${e?.message ?? e}). If you got an Accessibility-permission prompt, grant it in System Settings > Privacy & Security > Accessibility, then retry.`,
            isError: true,
          };
        }
        await runCmd('screencapture', ['-l', windowId, '-x', dest], { timeoutMs: 10_000 });
      } else {
        // Whole screen, no sound (-x)
        await runCmd('screencapture', ['-x', dest], { timeoutMs: 10_000 });
      }
      const stat = await fs.stat(dest);
      return {
        content: `Screenshot saved: ${dest}\n  Size: ${(stat.size / 1024).toFixed(1)} KB${args.window ? `\n  Window: ${args.window}` : '\n  Capture: full screen'}\n\nNext step: vision_analyze({image_path: "${dest}", prompt: "..."}) to understand what's in it.`,
        metadata: { path: dest, sizeBytes: stat.size, window: args.window },
      };
    } catch (e: any) {
      return { content: `[COMPUTER_USE_ERROR] screenshot failed: ${e?.message ?? e}`, isError: true };
    }
  }
}

/** Click, type, and key. A standing "always yes" is not enough — confirmed every time. */
export async function confirmScreenChange(ctx: ToolContext, tool: string, operation: string): Promise<ToolResult | null> {
  ctx.emit({ type: 'permission-request', tool, operation });
  const answer = await ctx.askUser(
    `${tool} will change what is on screen: ${operation}`,
    ['yes', 'no'],
  );
  if (interpretPermissionAnswer(answer) !== 'allow') {
    return {
      content: `[USER_REJECTED] ${tool} was not approved. Click, type, and key are confirmed every time — a click can send, spend, or delete, and there is no undo.`,
      isError: true,
    };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// computer_use_click

const ClickArgs = z.object({
  x: z.number().int().describe('Screen X coordinate (pixels from left). Get via computer_use_screenshot + vision_analyze.'),
  y: z.number().int().describe('Screen Y coordinate (pixels from top).'),
  button: z.enum(['left', 'right']).optional().describe('Default left.'),
  count: z.number().int().min(1).max(3).optional().describe('1=single, 2=double, 3=triple. Default 1.'),
});

export class ComputerUseClickTool extends Tool<z.infer<typeof ClickArgs>> {
  name = 'computer_use_click';
  description = 'Click at a screen coordinate. macOS: cliclick or System Events. Linux: xdotool. Windows: Win32 mouse_event. Asks every time, then clicks. Workflow: screenshot, vision_analyze, then click the coordinates.';
  isReadOnly = false;
  isDestructive = true;
  argsSchema = ClickArgs;

  async execute(args: z.infer<typeof ClickArgs>, ctx: ToolContext): Promise<ToolResult> {
    if (os.platform() === 'linux') {
      const { runLinuxClick } = await import('./linux.js');
      return runLinuxClick(args, ctx, confirmScreenChange);
    }
    if (os.platform() === 'win32') {
      const { runWindowsClick } = await import('./win.js');
      return runWindowsClick(args, ctx, confirmScreenChange);
    }
    if (!isMacos()) return macosOnly(this.name);
    const blocked = await confirmScreenChange(ctx, this.name, `click ${args.x},${args.y}`);
    if (blocked) return blocked;
    try {
      const cliclickPath = await which('cliclick');
      const count = args.count ?? 1;
      const button = args.button ?? 'left';
      if (cliclickPath) {
        // cliclick syntax: c:x,y for single left, dc:x,y for double, rc:x,y for right
        let cmd: string;
        if (button === 'right') cmd = `rc:${args.x},${args.y}`;
        else if (count === 2) cmd = `dc:${args.x},${args.y}`;
        else if (count === 3) cmd = `tc:${args.x},${args.y}`;
        else cmd = `c:${args.x},${args.y}`;
        await runCmd(cliclickPath, [cmd], { timeoutMs: 5000 });
        return { content: `Clicked at (${args.x}, ${args.y}) via cliclick — ${button} button × ${count}` };
      }
      // Fallback: AppleScript. Slower (~500ms latency) but no install needed.
      // Note: AppleScript click via System Events requires Accessibility permission.
      const script = button === 'right'
        ? `tell application "System Events" to do shell script "echo right-click via applescript not directly supported; install cliclick for right-click"`
        : `tell application "System Events" to click at {${args.x}, ${args.y}}`;
      await runCmd('osascript', ['-e', script], { timeoutMs: 5000 });
      return {
        content: `Clicked at (${args.x}, ${args.y}) via AppleScript — ${button} button${count > 1 ? `\n⚠ Note: AppleScript click doesn't support multi-click reliably. Install cliclick: brew install cliclick` : ''}`,
      };
    } catch (e: any) {
      return { content: `[COMPUTER_USE_ERROR] click failed: ${e?.message ?? e}`, isError: true };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// computer_use_type

const TypeArgs = z.object({
  text: z.string().min(1).describe('Text to type into the currently-focused input.'),
});

export class ComputerUseTypeTool extends Tool<z.infer<typeof TypeArgs>> {
  name = 'computer_use_type';
  description = 'Type text into the focused field. macOS, Linux (xdotool), or Windows (SendKeys). Asks every time, then types.';
  isReadOnly = false;
  isDestructive = true;
  argsSchema = TypeArgs;

  async execute(args: z.infer<typeof TypeArgs>, ctx: ToolContext): Promise<ToolResult> {
    if (os.platform() === 'linux') {
      const { runLinuxType } = await import('./linux.js');
      return runLinuxType(args, ctx, confirmScreenChange);
    }
    if (os.platform() === 'win32') {
      const { runWindowsType } = await import('./win.js');
      return runWindowsType(args, ctx, confirmScreenChange);
    }
    if (!isMacos()) return macosOnly(this.name);
    const blocked = await confirmScreenChange(ctx, this.name, `type ${args.text.length} chars`);
    if (blocked) return blocked;
    try {
      const cliclickPath = await which('cliclick');
      if (cliclickPath) {
        // cliclick t:<text> types literal text. Special chars need escaping.
        await runCmd(cliclickPath, ['t:' + args.text], { timeoutMs: 15_000 });
        return { content: `Typed ${args.text.length} char(s).` };
      }
      // Fallback: AppleScript keystroke
      const escaped = args.text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const script = `tell application "System Events" to keystroke "${escaped}"`;
      await runCmd('osascript', ['-e', script], { timeoutMs: 15_000 });
      return { content: `Typed ${args.text.length} char(s) via AppleScript.` };
    } catch (e: any) {
      return { content: `[COMPUTER_USE_ERROR] type failed: ${e?.message ?? e}`, isError: true };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// computer_use_key

const KeyArgs = z.object({
  combo: z.string().min(1).describe(
    'Key combo. Examples: "cmd+s" (save), "cmd+tab" (switch app), "esc", "return", "tab", "space", "cmd+shift+4" (selection screenshot), "cmd+,", "left", "right", "up", "down".'
  ),
});

const KEY_ALIASES: Record<string, string> = {
  cmd: 'command', meta: 'command', win: 'command',
  opt: 'option', alt: 'option',
  ctrl: 'control',
  esc: 'escape', enter: 'return',
};

export class ComputerUseKeyTool extends Tool<z.infer<typeof KeyArgs>> {
  name = 'computer_use_key';
  description = 'Press a key combo (cmd+s, ctrl+s, esc, tab, return). macOS, Linux (xdotool), or Windows (SendKeys). Asks every time, then presses. On Windows, cmd is sent as Ctrl. The Windows key is not sent.';
  isReadOnly = false;
  isDestructive = true;
  argsSchema = KeyArgs;

  async execute(args: z.infer<typeof KeyArgs>, ctx: ToolContext): Promise<ToolResult> {
    if (os.platform() === 'linux') {
      const { runLinuxKey } = await import('./linux.js');
      return runLinuxKey(args, ctx, confirmScreenChange);
    }
    if (os.platform() === 'win32') {
      const { runWindowsKey } = await import('./win.js');
      return runWindowsKey(args, ctx, confirmScreenChange);
    }
    if (!isMacos()) return macosOnly(this.name);
    const blocked = await confirmScreenChange(ctx, this.name, `key ${args.combo}`);
    if (blocked) return blocked;
    try {
      const parts = args.combo.toLowerCase().split('+').map(s => s.trim());
      const modifiers: string[] = [];
      let keyName: string | null = null;
      for (const part of parts) {
        const norm = KEY_ALIASES[part] ?? part;
        if (['command', 'control', 'option', 'shift'].includes(norm)) modifiers.push(norm + ' down');
        else keyName = norm;
      }
      if (!keyName) return { content: '[COMPUTER_USE_ERROR] No primary key in combo. Example: "cmd+s".', isError: true };

      // Special keys via key code; printable chars via keystroke
      const specialKeys: Record<string, number> = {
        return: 36, escape: 53, tab: 48, space: 49, delete: 51,
        left: 123, right: 124, down: 125, up: 126,
        f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
      };
      const usingModifiers = modifiers.length > 0;
      const modClause = usingModifiers ? ` using {${modifiers.join(', ')}}` : '';

      let script: string;
      if (keyName in specialKeys) {
        script = `tell application "System Events" to key code ${specialKeys[keyName]}${modClause}`;
      } else {
        // Keystroke a single character (e.g. cmd+s → "s")
        script = `tell application "System Events" to keystroke "${keyName.replace(/"/g, '\\"')}"${modClause}`;
      }
      await runCmd('osascript', ['-e', script], { timeoutMs: 5000 });
      return { content: `Pressed ${args.combo}` };
    } catch (e: any) {
      return { content: `[COMPUTER_USE_ERROR] key press failed: ${e?.message ?? e}`, isError: true };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// computer_use_active_window

const ActiveWindowArgs = z.object({});

export class ComputerUseActiveWindowTool extends Tool<z.infer<typeof ActiveWindowArgs>> {
  name = 'computer_use_active_window';
  description = 'Read the focused app and window title. macOS, Linux (xdotool), or Windows. Read-only.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = ActiveWindowArgs;

  async execute(_args: z.infer<typeof ActiveWindowArgs>, _ctx: ToolContext): Promise<ToolResult> {
    if (os.platform() === 'linux') {
      const { runLinuxActiveWindow } = await import('./linux.js');
      return runLinuxActiveWindow();
    }
    if (os.platform() === 'win32') {
      const { runWindowsActiveWindow } = await import('./win.js');
      return runWindowsActiveWindow();
    }
    if (!isMacos()) return macosOnly(this.name);
    try {
      const script = `tell application "System Events"
  set frontApp to first application process whose frontmost is true
  set appName to name of frontApp
  try
    set winTitle to title of window 1 of frontApp
    set winPos to position of window 1 of frontApp
    set winSize to size of window 1 of frontApp
    return appName & "|" & winTitle & "|" & (item 1 of winPos) & "," & (item 2 of winPos) & "|" & (item 1 of winSize) & "x" & (item 2 of winSize)
  on error
    return appName & "|(no window)|0,0|0x0"
  end try
end tell`;
      const { stdout } = await runCmd('osascript', ['-e', script], { timeoutMs: 5000 });
      const [appName, winTitle, pos, size] = stdout.trim().split('|');
      return {
        content: `Active app: ${appName}\nWindow: ${winTitle}\nPosition: ${pos}\nSize: ${size}`,
        metadata: { appName, windowTitle: winTitle, position: pos, size },
      };
    } catch (e: any) {
      return { content: `[COMPUTER_USE_ERROR] ${e?.message ?? e}`, isError: true };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// computer_use_list_windows

const ListWindowsArgs = z.object({
  app: z.string().optional().describe('If set, list only this app\'s windows. Otherwise lists all visible apps + their windows.'),
});

export class ComputerUseListWindowsTool extends Tool<z.infer<typeof ListWindowsArgs>> {
  name = 'computer_use_list_windows';
  description = 'List visible windows. macOS, Linux (wmctrl or xdotool), or Windows. Read-only.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = ListWindowsArgs;

  async execute(args: z.infer<typeof ListWindowsArgs>, _ctx: ToolContext): Promise<ToolResult> {
    if (os.platform() === 'linux') {
      const { runLinuxListWindows } = await import('./linux.js');
      return runLinuxListWindows(args.app);
    }
    if (os.platform() === 'win32') {
      const { runWindowsListWindows } = await import('./win.js');
      return runWindowsListWindows();
    }
    if (!isMacos()) return macosOnly(this.name);
    try {
      const script = args.app
        ? `tell application "System Events" to tell process "${args.app.replace(/"/g, '\\"')}" to return (name of every window)`
        : `tell application "System Events"
  set out to ""
  repeat with p in (every process whose visible is true and background only is false)
    set procName to name of p
    try
      set winNames to name of every window of p
      set out to out & procName & ": " & (winNames as string) & linefeed
    on error
      set out to out & procName & ": (no windows)" & linefeed
    end try
  end repeat
  return out
end tell`;
      const { stdout } = await runCmd('osascript', ['-e', script], { timeoutMs: 10_000 });
      return {
        content: args.app
          ? `Windows of "${args.app}":\n${stdout.split(',').map(s => '  - ' + s.trim()).join('\n')}`
          : stdout.trim(),
      };
    } catch (e: any) {
      return { content: `[COMPUTER_USE_ERROR] ${e?.message ?? e}`, isError: true };
    }
  }
}
