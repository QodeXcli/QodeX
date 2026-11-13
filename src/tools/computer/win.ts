/**
 * Windows desktop control via PowerShell and Win32. No third-party binary.
 * Coordinates are integers. Paths and typed text are single-quoted.
 * Click, type, and key are confirmed by the caller before these run.
 */
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ToolContext, ToolResult } from '../base.js';

type Confirm = (ctx: ToolContext, tool: string, operation: string) => Promise<ToolResult | null>;

export function psQuote(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/** SendKeys body. `cmd` is Ctrl on Windows — there is no Command key. `null` if unmapped. */
export function windowsSendKeys(combo: string): string | null {
  const parts = combo.toLowerCase().split('+').map(s => s.trim()).filter(Boolean);
  let prefix = '';
  let key = '';
  for (const p of parts) {
    if (p === 'ctrl' || p === 'control' || p === 'cmd' || p === 'command' || p === 'meta') prefix += '^';
    else if (p === 'alt' || p === 'opt' || p === 'option') prefix += '%';
    else if (p === 'shift') prefix += '+';
    else if (p === 'win' || p === 'super') return null;
    else key = p;
  }
  if (!key) return null;
  const named: Record<string, string> = {
    enter: '{ENTER}', return: '{ENTER}', esc: '{ESC}', escape: '{ESC}',
    tab: '{TAB}', space: ' ', left: '{LEFT}', right: '{RIGHT}', up: '{UP}', down: '{DOWN}',
  };
  if (named[key]) return prefix + named[key];
  if (key.length === 1) return prefix + ('+^%~(){}'.includes(key) ? `{${key}}` : key);
  return prefix + `{${key.toUpperCase()}}`;
}

export function windowsClickScript(x: number, y: number, button: 'left' | 'right', count: number): string {
  const down = button === 'right' ? '0x0008' : '0x0002';
  const up = button === 'right' ? '0x0010' : '0x0004';
  const n = Math.max(1, Math.min(3, Math.trunc(count)));
  return `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class QodeXInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);
}
"@
[QodeXInput]::SetCursorPos(${Math.trunc(x)}, ${Math.trunc(y)})
for ($i = 0; $i -lt ${n}; $i++) {
  [QodeXInput]::mouse_event(${down}, 0, 0, 0, 0)
  [QodeXInput]::mouse_event(${up}, 0, 0, 0, 0)
}
`.trim();
}

export function windowsTypeScript(text: string): string {
  const literal = [...text].map(ch => {
    if (ch === '\n' || ch === '\r') return '{ENTER}';
    if ('+^%~(){}'.includes(ch)) return `{${ch}}`;
    return ch;
  }).join('');
  return `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(${psQuote(literal)})`;
}

/** Win32 virtual keys. Only codes we name. An unknown key is not guessed. */
const WIN_VK: Record<string, number> = {
  ctrl: 0x11, control: 0x11, cmd: 0x11, command: 0x11, meta: 0x11,
  alt: 0x12, opt: 0x12, option: 0x12,
  shift: 0x10,
  enter: 0x0D, return: 0x0D, esc: 0x1B, escape: 0x1B, tab: 0x09, space: 0x20,
  left: 0x25, up: 0x26, right: 0x27, down: 0x28,
  a: 0x41, b: 0x42, c: 0x43, d: 0x44, e: 0x45, f: 0x46, g: 0x47, h: 0x48,
  i: 0x49, j: 0x4A, k: 0x4B, l: 0x4C, m: 0x4D, n: 0x4E, o: 0x4F, p: 0x50,
  q: 0x51, r: 0x52, s: 0x53, t: 0x54, u: 0x55, v: 0x56, w: 0x57, x: 0x58,
  y: 0x59, z: 0x5A,
};

/**
 * The Windows key is not a SendKeys token. keybd_event can press it.
 * The combo must include one real key. Integers only, so the name is not shell.
 */
export function windowsWinScript(combo: string): string | null {
  const parts = combo.toLowerCase().split('+').map(s => s.trim()).filter(Boolean);
  if (!parts.some(p => p === 'win' || p === 'super')) return null;
  const rest = parts.filter(p => p !== 'win' && p !== 'super');
  if (rest.length === 0) return null;
  const codes = rest.map(p => WIN_VK[p]);
  if (codes.some(c => c === undefined)) return null;
  const hex = (n: number) => '0x' + n.toString(16).toUpperCase();
  const downs = [0x5B, ...codes as number[]];
  const ups = [...downs].reverse();
  const calls = [
    ...downs.map(c => `[QodeXKey]::Send(${hex(c)}, 0)`),
    ...ups.map(c => `[QodeXKey]::Send(${hex(c)}, 2)`),
  ];
  return `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class QodeXKey {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, int dwFlags, int dwExtraInfo);
  public static void Send(int vk, int flags) { keybd_event((byte)vk, 0, flags, 0); }
}
"@
${calls.join('\n')}
`.trim();
}

export function windowsKeyScript(combo: string): string | null {
  const win = windowsWinScript(combo);
  if (win) return win;
  const keys = windowsSendKeys(combo);
  if (!keys) return null;
  return `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(${psQuote(keys)})`;
}

export function windowsShotScript(dest: string): string {
  return `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$bds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $bds.Width, $bds.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bds.Location, [System.Drawing.Point]::Empty, $bds.Size)
$bmp.Save(${psQuote(dest)}, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
`.trim();
}

function runPowershell(script: string, timeoutMs = 15_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf-8'); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf-8'); });
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('exit', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`powershell exited ${code}: ${stderr.trim() || stdout.trim()}`));
      else resolve({ stdout, stderr });
    });
  });
}

async function shotDest(requested?: string): Promise<string> {
  const dir = path.join(os.tmpdir(), 'qodex-screenshots');
  await fs.mkdir(dir, { recursive: true });
  return requested ?? path.join(dir, `desktop-${Date.now()}.png`);
}

export async function runWindowsScreenshot(args: { path?: string }): Promise<ToolResult> {
  const dest = await shotDest(args.path);
  try {
    await runPowershell(windowsShotScript(dest));
    const stat = await fs.stat(dest);
    return { content: `Screenshot saved: ${dest}\n  Size: ${(stat.size / 1024).toFixed(1)} KB`, metadata: { path: dest, sizeBytes: stat.size } };
  } catch (e: any) {
    return { content: `[COMPUTER_USE_ERROR] screenshot failed: ${e?.message ?? e}`, isError: true };
  }
}

export async function runWindowsClick(
  args: { x: number; y: number; button?: 'left' | 'right'; count?: number },
  ctx: ToolContext,
  confirm: Confirm,
): Promise<ToolResult> {
  const blocked = await confirm(ctx, 'computer_use_click', `click ${args.x},${args.y}`);
  if (blocked) return blocked;
  try {
    await runPowershell(windowsClickScript(args.x, args.y, args.button ?? 'left', args.count ?? 1));
    return { content: `Clicked at (${args.x}, ${args.y}) via Win32.` };
  } catch (e: any) {
    return { content: `[COMPUTER_USE_ERROR] click failed: ${e?.message ?? e}`, isError: true };
  }
}

export async function runWindowsType(args: { text: string }, ctx: ToolContext, confirm: Confirm): Promise<ToolResult> {
  const blocked = await confirm(ctx, 'computer_use_type', `type ${args.text.length} chars`);
  if (blocked) return blocked;
  try {
    await runPowershell(windowsTypeScript(args.text));
    return { content: `Typed ${args.text.length} char(s) via SendKeys.` };
  } catch (e: any) {
    return { content: `[COMPUTER_USE_ERROR] type failed: ${e?.message ?? e}`, isError: true };
  }
}

export async function runWindowsKey(args: { combo: string }, ctx: ToolContext, confirm: Confirm): Promise<ToolResult> {
  const blocked = await confirm(ctx, 'computer_use_key', `key ${args.combo}`);
  if (blocked) return blocked;
  const script = windowsKeyScript(args.combo);
  if (!script) {
    return { content: `[COMPUTER_USE_ERROR] combo "${args.combo}" is not mapped.`, isError: true };
  }
  try {
    await runPowershell(script);
    const note = /\b(cmd|command|meta)\b/i.test(args.combo) ? ' cmd was sent as Ctrl.' : '';
    return { content: `Pressed ${args.combo} via SendKeys.${note}` };
  } catch (e: any) {
    return { content: `[COMPUTER_USE_ERROR] key failed: ${e?.message ?? e}`, isError: true };
  }
}

export async function runWindowsActiveWindow(): Promise<ToolResult> {
  const script = `
Add-Type -TypeDefinition @"
using System; using System.Text; using System.Runtime.InteropServices;
public class QodeXWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
}
"@
$h = [QodeXWin]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[void][QodeXWin]::GetWindowText($h, $sb, $sb.Capacity)
Write-Output $sb.ToString()
`.trim();
  try {
    const { stdout } = await runPowershell(script);
    return { content: `Active window: ${stdout.trim() || '(untitled)'}` };
  } catch (e: any) {
    return { content: `[COMPUTER_USE_ERROR] ${e?.message ?? e}`, isError: true };
  }
}

export async function runWindowsListWindows(): Promise<ToolResult> {
  const script = `Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { $_.ProcessName + ': ' + $_.MainWindowTitle }`;
  try {
    const { stdout } = await runPowershell(script);
    return { content: stdout.trim() || 'No titled windows.' };
  } catch (e: any) {
    return { content: `[COMPUTER_USE_ERROR] ${e?.message ?? e}`, isError: true };
  }
}
