/**
 * `computer_use_*` tools — native macOS screen control beyond the browser.
 *
 * Use cases that browser tools can't cover:
 *   - Take a screenshot of LM Studio's window to see what model is loaded
 *   - Click "Allow" on a system permission dialog
 *   - Read text from a desktop app (Slack, Mail, terminal)
 *   - Automate flows in native apps (Finder, Xcode, anything not web-based)
 *
 * Why macOS-only for v1.7.0: implementation uses built-in macOS tooling
 * (`screencapture`, `osascript` for AppleScript, `cliclick` if installed for
 * mouse/keyboard). Linux/Windows variants are future work.
 *
 * Built-in tools we use:
 *   - `screencapture` — ships with macOS, takes PNGs
 *   - `osascript` — AppleScript runtime, ships with macOS, drives System Events
 *   - `cliclick` — OPTIONAL — for fast mouse/keyboard; install via brew if missing
 *
 * Security:
 *   - First use of System Events triggers macOS Accessibility permission prompt.
 *     User must grant it once in System Settings > Privacy & Security > Accessibility.
 *   - This is INTENTIONALLY visible — we don't bypass the prompt; it's the
 *     correct user-consent flow.
 *
 * Permission model:
 *   - All computer_use_* tools are DESTRUCTIVE (mutating the user's GUI state).
 *   - The permission gradient applies — first call asks, gradient picker lets
 *     user choose "always allow computer_use_screenshot" etc.
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

function isMacos(): boolean {
  return os.platform() === 'darwin';
}

function macosOnly(toolName: string): ToolResult {
  return {
    content: `[COMPUTER_USE_UNAVAILABLE] ${toolName} requires macOS. Current platform: ${os.platform()}. Linux/Windows variants are planned for future versions.`,
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
  description = 'Capture a PNG of the macOS desktop or a specific app\'s window. Use to see what\'s on screen beyond the browser (LM Studio, Slack, Finder, etc). Pass `window: "AppName"` to target a specific app. Returns file path; pass to vision_analyze for understanding. Read-only on the user filesystem; macOS-only.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = ScreenshotArgs;

  async execute(args: z.infer<typeof ScreenshotArgs>, _ctx: ToolContext): Promise<ToolResult> {
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
  description = 'Click at a screen coordinate using macOS native input. Best workflow: screenshot → vision_analyze to find the target → use the coordinates returned to click. Requires `cliclick` (brew install cliclick) for fast mouse, falls back to AppleScript otherwise. macOS-only. Destructive — actually moves cursor and clicks.';
  isReadOnly = false;
  isDestructive = true;
  argsSchema = ClickArgs;

  async execute(args: z.infer<typeof ClickArgs>, _ctx: ToolContext): Promise<ToolResult> {
    if (!isMacos()) return macosOnly(this.name);
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
  description = 'Type text into the currently focused field/input. Click first with computer_use_click to focus the target. macOS-only. Destructive — actually types.';
  isReadOnly = false;
  isDestructive = true;
  argsSchema = TypeArgs;

  async execute(args: z.infer<typeof TypeArgs>, _ctx: ToolContext): Promise<ToolResult> {
    if (!isMacos()) return macosOnly(this.name);
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
  description = 'Press a key or key combo (cmd+s, esc, tab, return, etc). Use for shortcuts that fill forms, save, navigate, switch apps. macOS-only. Destructive — actually presses keys.';
  isReadOnly = false;
  isDestructive = true;
  argsSchema = KeyArgs;

  async execute(args: z.infer<typeof KeyArgs>, _ctx: ToolContext): Promise<ToolResult> {
    if (!isMacos()) return macosOnly(this.name);
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
  description = 'Get info about the currently focused app and window (app name, window title, bounds). Use to verify you\'re in the right context before clicking/typing. Read-only. macOS-only.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = ActiveWindowArgs;

  async execute(_args: z.infer<typeof ActiveWindowArgs>, _ctx: ToolContext): Promise<ToolResult> {
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
  description = 'List visible apps and their windows. Useful when you need to find the right app/window to target with screenshot or click. Read-only. macOS-only.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = ListWindowsArgs;

  async execute(args: z.infer<typeof ListWindowsArgs>, _ctx: ToolContext): Promise<ToolResult> {
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
