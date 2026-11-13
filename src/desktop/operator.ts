/**
 * The person at this machine. These actions run immediately.
 * The model still goes through computer_use_* and the sentinel.
 * A raw shell is not added here: that is the terminal they already have.
 */
import type { ToolContext } from '../tools/base.js';
import {
  ComputerUseActiveWindowTool,
  ComputerUseClickTool,
  ComputerUseKeyTool,
  ComputerUseListWindowsTool,
  ComputerUseTypeTool,
} from '../tools/computer/use.js';

export type OperatorCommand =
  | { kind: 'click'; x: number; y: number; button: 'left' | 'right'; count: number }
  | { kind: 'keystroke'; text: string }
  | { kind: 'key'; combo: string }
  | { kind: 'windows' }
  | { kind: 'front' }
  | { kind: 'focus'; app: string };

const MODS = new Set(['cmd', 'command', 'meta', 'win', 'super', 'ctrl', 'control', 'alt', 'opt', 'option', 'shift']);

export function parseOperator(fields: Record<string, string>): { ok: true; command: OperatorCommand } | { ok: false; error: string } {
  const kind = (fields.kind ?? '').trim();
  if (kind === 'windows') return { ok: true, command: { kind: 'windows' } };
  if (kind === 'front') return { ok: true, command: { kind: 'front' } };
  if (kind === 'click') {
    const x = Number(fields.x);
    const y = Number(fields.y);
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > 20000 || y > 20000) {
      return { ok: false, error: 'click needs integer x and y from 0 to 20000' };
    }
    const button = fields.button === 'right' ? 'right' : fields.button === 'left' || !fields.button ? 'left' : null;
    if (!button) return { ok: false, error: 'button is left or right' };
    const count = fields.count ? Number(fields.count) : 1;
    if (!Number.isInteger(count) || count < 1 || count > 3) return { ok: false, error: 'count is 1, 2, or 3' };
    return { ok: true, command: { kind: 'click', x, y, button, count } };
  }
  if (kind === 'keystroke') {
    const text = fields.text ?? '';
    if (text.length < 1 || text.length > 2000 || text.includes('\u0000')) return { ok: false, error: 'keystroke is 1–2000 characters' };
    return { ok: true, command: { kind: 'keystroke', text } };
  }
  if (kind === 'key') {
    const combo = (fields.combo ?? '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9+._-]{0,40}$/.test(combo)) return { ok: false, error: 'key combo is letters, digits, and plus' };
    const parts = combo.split('+').filter(Boolean);
    if (!parts.some(part => !MODS.has(part))) return { ok: false, error: 'key combo needs a key, not only modifiers' };
    return { ok: true, command: { kind: 'key', combo } };
  }
  if (kind === 'focus') {
    const app = (fields.app ?? '').trim();
    if (app.length < 1 || app.length > 80 || /[\r\n\t"\\]/.test(app)) return { ok: false, error: 'focus needs an app or window name' };
    return { ok: true, command: { kind: 'focus', app } };
  }
  return { ok: false, error: 'unknown operator action' };
}

/** How to raise one app. The name is an argument, not shell syntax. */
export function focusLaunch(platform: string, app: string): { cmd: string; args: string[] } | { error: string } {
  if (app.length < 1 || /[\r\n\t"\\]/.test(app)) return { error: 'bad app name' };
  if (platform === 'darwin') {
    const esc = app.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return { cmd: 'osascript', args: ['-e', `tell application "System Events" to set frontmost of process "${esc}" to true`] };
  }
  if (platform === 'linux') return { cmd: 'wmctrl', args: ['-a', app] };
  if (platform === 'win32') {
    const q = app.replace(/'/g, "''");
    return {
      cmd: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command',
        `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class QxFocus { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n); }'; $p = Get-Process -Name '${q}' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1; if (-not $p) { Write-Error 'no window'; exit 2 }; [void][QxFocus]::ShowWindow($p.MainWindowHandle, 9); if (-not [QxFocus]::SetForegroundWindow($p.MainWindowHandle)) { exit 3 }`],
    };
  }
  return { error: `no focus backend for ${platform}` };
}

function operatorContext(): ToolContext {
  return {
    cwd: process.cwd(),
    sessionId: 'desktop-operator',
    transaction: null as never,
    permissions: null as never,
    askUser: async () => 'yes',
    emit: () => {},
  };
}

export async function runOperator(command: OperatorCommand): Promise<{ content: string; isError?: boolean }> {
  const ctx = operatorContext();
  if (command.kind === 'click') return new ComputerUseClickTool().execute(command, ctx);
  if (command.kind === 'keystroke') return new ComputerUseTypeTool().execute({ text: command.text }, ctx);
  if (command.kind === 'key') return new ComputerUseKeyTool().execute({ combo: command.combo }, ctx);
  if (command.kind === 'windows') return new ComputerUseListWindowsTool().execute({}, ctx);
  if (command.kind === 'front') return new ComputerUseActiveWindowTool().execute({}, ctx);
  const launch = focusLaunch(process.platform, command.app);
  if ('error' in launch) return { content: `[COMPUTER_USE_ERROR] ${launch.error}`, isError: true };
  const { spawn } = await import('child_process');
  const ran = await new Promise<{ code: number; stderr: string }>(resolve => {
    const child = spawn(launch.cmd, launch.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf-8'); });
    child.on('error', err => resolve({ code: 127, stderr: err.message }));
    child.on('exit', code => resolve({ code: code ?? 1, stderr }));
  });
  if (ran.code !== 0) {
    return { content: `[COMPUTER_USE_ERROR] focus failed: ${ran.stderr.trim() || launch.cmd + ' exited ' + ran.code}`, isError: true };
  }
  return { content: `Focused ${command.app}.` };
}
