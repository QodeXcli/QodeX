/**
 * Windows desktop backend — Windows PowerShell 5.1 (ships with Windows 10/11)
 * plus a few user32 calls compiled with Add-Type:
 *
 *   mouse       SetCursorPos + mouse_event (buttons, wheel, horizontal wheel)
 *   keys        keybd_event (supports the Win key, which SendKeys can't press)
 *   text        System.Windows.Forms.SendKeys (escaping +^%~(){}[]) for ASCII;
 *               clipboard + ctrl+v for Unicode (Persian), previous clipboard restored
 *   screenshots System.Drawing CopyFromScreen (+ high-quality downscale)
 *   windows     GetForegroundWindow/GetWindowText/GetWindowRect, Get-Process
 *               MainWindowTitle, WScript.Shell AppActivate + SetForegroundWindow
 *   open        Start-Process (apps on PATH / App Paths, files, URLs), falling
 *               back to Start-menu shortcuts by name
 *
 * The process calls SetProcessDPIAware first, so screenshots, cursor positions
 * and SetCursorPos all use physical pixels (scale 1 unless downscaled).
 *
 * Every call is `powershell -NoProfile -NonInteractive -Command -` with the
 * script on stdin. The script travels base64-encoded (UTF-8) inside a one-line
 * loader: stdin is read in the console's OEM code page (which would mangle
 * Persian text) and line-by-line (which breaks multi-line blocks).
 */

import { promises as fs } from 'fs';
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
  isJpegPath,
  parseKeyCombo,
  pickWindow,
  windowMatches,
  windowNotFound,
} from './types.js';
import { which } from '../exec.js';

export const POWERSHELL = 'powershell';
export const PS_ARGS = ['-NoProfile', '-NonInteractive', '-Command', '-'];

/** PowerShell single-quoted literal (doubles ' and the typographic quotes PS also treats as quotes). PURE. */
export function psQuote(s: string): string {
  return `'${String(s).replace(/['‘’‚‛]/g, m => m + m)}'`;
}

/** Escape text for SendKeys: wrap + ^ % ~ ( ) { } [ ] in braces; newline → {ENTER}, tab → {TAB}. PURE. */
export function escapeSendKeys(text: string): string {
  let out = '';
  for (const ch of String(text).replace(/\r\n?/g, '\n')) {
    if ('+^%~(){}[]'.includes(ch)) out += `{${ch}}`;
    else if (ch === '\n') out += '{ENTER}';
    else if (ch === '\t') out += '{TAB}';
    else out += ch;
  }
  return out;
}

/** One-line stdin loader that decodes and runs `script` (UTF-8, base64). PURE. */
export function powershellStdin(script: string): string {
  const b64 = Buffer.from(script, 'utf-8').toString('base64');
  return (
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; ' +
    "$ErrorActionPreference = 'Stop'; " +
    `try { & ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))) } ` +
    'catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }\r\n'
  );
}

/** Inverse of powershellStdin — the script a loader line runs (tests / debugging). PURE. */
export function decodePowerShellStdin(stdin: string): string | null {
  const m = stdin.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/);
  return m ? Buffer.from(m[1]!, 'base64').toString('utf-8') : null;
}

/** Loaded before every script: Forms/Drawing + user32 interop + DPI awareness. */
export const PS_PRELUDE = `Add-Type -AssemblyName System.Windows.Forms, System.Drawing
if (-not ('QodexDesktop' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class QodexDesktop {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  public static string Title(IntPtr h) { var sb = new StringBuilder(1024); GetWindowText(h, sb, 1024); return sb.ToString(); }
}
'@
}
[void][QodexDesktop]::SetProcessDPIAware()
function QxWin([IntPtr]$h) {
  $r = New-Object QodexDesktop+RECT
  [void][QodexDesktop]::GetWindowRect($h, [ref]$r)
  $procId = [uint32]0
  [void][QodexDesktop]::GetWindowThreadProcessId($h, [ref]$procId)
  $name = ''
  try { $name = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch {}
  [pscustomobject]@{ id = [string]$h.ToInt64(); title = [QodexDesktop]::Title($h); app = $name; pid = [int]$procId; x = $r.Left; y = $r.Top; width = ($r.Right - $r.Left); height = ($r.Bottom - $r.Top) }
}
`;

// mouse_event flags
const ME = { MOVE: 0x0001, LEFTDOWN: 0x0002, LEFTUP: 0x0004, RIGHTDOWN: 0x0008, RIGHTUP: 0x0010, MIDDLEDOWN: 0x0020, MIDDLEUP: 0x0040, WHEEL: 0x0800, HWHEEL: 0x1000 };
const BTN: Record<MouseButton, [number, number]> = {
  left: [ME.LEFTDOWN, ME.LEFTUP],
  right: [ME.RIGHTDOWN, ME.RIGHTUP],
  middle: [ME.MIDDLEDOWN, ME.MIDDLEUP],
};
const WHEEL_DELTA = 120;

/** Virtual-key codes; `true` = extended key (KEYEVENTF_EXTENDEDKEY). */
export const WIN_VK: Record<string, [number, boolean]> = {
  enter: [0x0d, false], escape: [0x1b, false], tab: [0x09, false], space: [0x20, false], backspace: [0x08, false],
  delete: [0x2e, true], insert: [0x2d, true], home: [0x24, true], end: [0x23, true], pageup: [0x21, true], pagedown: [0x22, true],
  up: [0x26, true], down: [0x28, true], left: [0x25, true], right: [0x27, true],
  capslock: [0x14, false], printscreen: [0x2c, true], menu: [0x5d, true], numlock: [0x90, true], scrolllock: [0x91, false], pause: [0x13, false],
  ctrl: [0x11, false], alt: [0x12, false], shift: [0x10, false], super: [0x5b, true],
  ',': [0xbc, false], '.': [0xbe, false], '/': [0xbf, false], ';': [0xba, false], "'": [0xde, false], '[': [0xdb, false],
  ']': [0xdd, false], '\\': [0xdc, false], '-': [0xbd, false], '=': [0xbb, false], '`': [0xc0, false],
};

function vkFor(key: string): [number, boolean] {
  const named = WIN_VK[key];
  if (named) return named;
  if (/^f([1-9]|1\d|2[0-4])$/.test(key)) return [0x70 + Number(key.slice(1)) - 1, false];
  if (/^[a-z]$/.test(key)) return [key.toUpperCase().charCodeAt(0), false];
  if (/^[0-9]$/.test(key)) return [key.charCodeAt(0), false];
  throw desktopError('COMPUTER_USE_ERROR', `windows: key "${key}" has no virtual-key mapping.`);
}

function kb(vk: number, ext: boolean, up: boolean): string {
  const flags = (ext ? 0x1 : 0) | (up ? 0x2 : 0);
  return `[QodexDesktop]::keybd_event([byte]0x${vk.toString(16)}, [byte]0, [uint32]${flags}, [UIntPtr]::Zero)`;
}

/** PowerShell statements pressing a combo with keybd_event. PURE. */
export function windowsKeyScript(c: ParsedCombo, repeat = 1, delayMs = 40): string {
  const mods = [...c.modifiers];
  let key = c.key;
  if (key === '+') { key = '='; if (!mods.includes('shift')) mods.push('shift'); }
  const modVks = mods.map(m => vkFor(m));
  const [vk, ext] = vkFor(key);
  const lines: string[] = modVks.map(([v, e]) => kb(v, e, false));
  for (let i = 0; i < repeat; i++) {
    lines.push(kb(vk, ext, false), kb(vk, ext, true));
    if (i < repeat - 1) lines.push(`Start-Sleep -Milliseconds ${delayMs}`);
  }
  lines.push(...[...modVks].reverse().map(([v, e]) => kb(v, e, true)));
  return lines.join('\n');
}

const r = (n: number) => Math.round(n);

/** Parse ConvertTo-Json output of one window or an array of windows. PURE. */
export function parseWindowsJson(out: string): WindowInfo[] {
  const text = out.replace(/^﻿/, '').trim();
  if (!text || text === 'null') return [];
  let data: any;
  try { data = JSON.parse(text); } catch { return []; }
  const arr = Array.isArray(data) ? data : [data];
  return arr.filter(w => w && typeof w === 'object').map(w => ({
    id: String(w.id ?? ''),
    title: String(w.title ?? ''),
    app: String(w.app ?? ''),
    pid: Number(w.pid) || undefined,
    bounds: Number.isFinite(Number(w.width)) ? { x: Number(w.x), y: Number(w.y), width: Number(w.width), height: Number(w.height) } : undefined,
    focused: w.focused === true ? true : w.focused === false ? false : undefined,
  }));
}

export class WindowsBackend extends CommandBackend implements DesktopBackend {
  readonly name = 'windows' as const;

  constructor(deps: BackendDeps) {
    super(deps);
  }

  async available(): Promise<BackendAvailability> {
    const ok = !!(await which(POWERSHELL));
    return {
      ok,
      missing: ok ? [] : ['powershell'],
      hint: ok ? '' : 'Windows PowerShell 5.1 ships with Windows — make sure %SystemRoot%\\System32\\WindowsPowerShell\\v1.0 is on PATH',
      notes: [
        'input: user32 (SetCursorPos, mouse_event, keybd_event) via PowerShell',
        'screenshots: System.Drawing (DPI-aware, physical pixels)',
        'Windows blocks input into apps running as Administrator unless QodeX runs elevated too.',
      ],
    };
  }

  /** Run a PowerShell script (prelude included); returns stdout. */
  async ps(script: string, timeoutMs = 30_000): Promise<string> {
    const res = await this.run(POWERSHELL, PS_ARGS, { stdin: powershellStdin(`${PS_PRELUDE}\n${script}`), timeoutMs });
    if (res.code !== 0) {
      if (res.code === 130) throw desktopError('ABORTED', 'windows: powershell aborted.');
      const msg = (res.stderr || res.stdout).replace(/^﻿/, '').trim().replace(/\s+/g, ' ').slice(0, 500);
      if (/^\[[A-Z_]+\]/.test(msg)) throw new Error(msg);
      throw desktopError('COMPUTER_USE_ERROR', `windows: powershell ${res.timedOut ? 'timed out' : `exited ${res.code}`}${msg ? `: ${msg}` : ''}`);
    }
    return res.stdout.replace(/^﻿/, '');
  }

  private async psJson<T = any>(script: string, timeoutMs?: number): Promise<T> {
    const out = (await this.ps(script, timeoutMs)).trim();
    try {
      return JSON.parse(out) as T;
    } catch {
      throw desktopError('COMPUTER_USE_ERROR', `windows: unexpected PowerShell output: ${out.slice(0, 200)}`);
    }
  }

  // ── screenshots ──

  async screenshot(opts: ScreenshotOptions): Promise<ScreenshotResult> {
    const notes: string[] = [];
    const dest = opts.path;
    await fs.mkdir(path.dirname(dest), { recursive: true });
    let win: WindowInfo | undefined;
    if (opts.window) {
      const wins = await this.listWindows();
      win = pickWindow(wins, opts.window);
      if (!win) throw windowNotFound(opts.window, wins);
      if (!win.bounds || win.bounds.x <= -30000 || win.bounds.width <= 0) {
        throw desktopError('COMPUTER_USE_ERROR', `windows: "${win.title}" is minimized. Call computer_use_focus_window first.`);
      }
    }
    const b = win?.bounds;
    const region = b
      ? `$bx = ${r(b.x)}; $by = ${r(b.y)}; $bw = ${r(b.width)}; $bh = ${r(b.height)}`
      : '$sb = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bx = $sb.X; $by = $sb.Y; $bw = $sb.Width; $bh = $sb.Height';
    const fmt = isJpegPath(dest) ? 'Jpeg' : 'Png';
    const script = `${region}
$maxW = ${r(opts.maxWidth ?? 0)}
$bmp = [System.Drawing.Bitmap]::new($bw, $bh)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bx, $by, 0, 0, $bmp.Size)
$g.Dispose()
$out = $bmp
if ($maxW -gt 0 -and $bw -gt $maxW) {
  $nh = [int][Math]::Round($bh * $maxW / $bw)
  $out = [System.Drawing.Bitmap]::new($maxW, $nh)
  $g2 = [System.Drawing.Graphics]::FromImage($out)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.DrawImage($bmp, 0, 0, $maxW, $nh)
  $g2.Dispose()
  $bmp.Dispose()
}
$out.Save(${psQuote(dest)}, [System.Drawing.Imaging.ImageFormat]::${fmt})
$res = [pscustomobject]@{ width = $out.Width; height = $out.Height; srcWidth = $bw; x = $bx; y = $by }
$out.Dispose()
$res | ConvertTo-Json -Compress`;
    const res = await this.psJson<{ width: number; height: number; srcWidth: number; x: number; y: number }>(script, 45_000);
    return {
      path: dest,
      width: res.width,
      height: res.height,
      scale: res.width / res.srcWidth,
      origin: { x: res.x, y: res.y },
      window: win,
      notes,
    };
  }

  // ── geometry ──

  async screenSize(): Promise<Size> {
    const s = await this.psJson<{ width: number; height: number }>(
      '$sb = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds\n[pscustomobject]@{ width = $sb.Width; height = $sb.Height } | ConvertTo-Json -Compress',
    );
    return { width: s.width, height: s.height };
  }

  async cursor(): Promise<Point> {
    const p = await this.psJson<{ x: number; y: number }>(
      '$p = New-Object QodexDesktop+POINT\n[void][QodexDesktop]::GetCursorPos([ref]$p)\n[pscustomobject]@{ x = $p.X; y = $p.Y } | ConvertTo-Json -Compress',
    );
    return { x: p.x, y: p.y };
  }

  // ── input ──

  private me(flags: number, data = 0): string {
    return `[QodexDesktop]::mouse_event([uint32]0x${flags.toString(16)}, 0, 0, ${r(data)}, [UIntPtr]::Zero)`;
  }

  async click(x: number, y: number, opts: ClickOptions = {}): Promise<void> {
    const count = Math.max(1, Math.min(3, r(opts.count ?? 1)));
    const [down, up] = BTN[opts.button ?? 'left'];
    const lines = [`[void][QodexDesktop]::SetCursorPos(${r(x)}, ${r(y)})`, 'Start-Sleep -Milliseconds 30'];
    for (let i = 0; i < count; i++) {
      lines.push(this.me(down), this.me(up));
      if (i < count - 1) lines.push('Start-Sleep -Milliseconds 60');
    }
    await this.ps(lines.join('\n'));
  }

  async move(x: number, y: number): Promise<void> {
    await this.ps(`[void][QodexDesktop]::SetCursorPos(${r(x)}, ${r(y)})`);
  }

  async drag(x1: number, y1: number, x2: number, y2: number): Promise<void> {
    const steps = Math.max(4, Math.min(40, r(Math.hypot(x2 - x1, y2 - y1) / 25)));
    const pause = Math.max(60, this.inputDelay * 2);
    const lines = [`[void][QodexDesktop]::SetCursorPos(${r(x1)}, ${r(y1)})`, 'Start-Sleep -Milliseconds 30', this.me(ME.LEFTDOWN), `Start-Sleep -Milliseconds ${pause}`];
    for (let i = 1; i <= steps; i++) {
      lines.push(`[void][QodexDesktop]::SetCursorPos(${r(x1 + ((x2 - x1) * i) / steps)}, ${r(y1 + ((y2 - y1) * i) / steps)})`, 'Start-Sleep -Milliseconds 12');
    }
    lines.push(`Start-Sleep -Milliseconds ${pause}`, this.me(ME.LEFTUP));
    await this.ps(lines.join('\n'));
  }

  async scroll(dx: number, dy: number, at: Partial<Point> = {}): Promise<void> {
    const lines: string[] = [];
    if (at.x !== undefined && at.y !== undefined) lines.push(`[void][QodexDesktop]::SetCursorPos(${r(at.x)}, ${r(at.y)})`, 'Start-Sleep -Milliseconds 30');
    // WHEEL: positive = away from the user (up). HWHEEL: positive = right.
    if (r(dy)) lines.push(this.me(ME.WHEEL, -r(dy) * WHEEL_DELTA));
    if (r(dx)) lines.push(this.me(ME.HWHEEL, r(dx) * WHEEL_DELTA));
    if (!lines.length) return;
    await this.ps(lines.join('\n'));
  }

  async type(text: string, opts: TypeOptions = {}): Promise<{ method: 'type' | 'paste' }> {
    const method = opts.method ?? 'auto';
    if (method === 'paste' || (method === 'auto' && hasNonAscii(text))) {
      // One PowerShell round-trip: save clipboard (text / image / files), paste, restore.
      await this.ps(`$oldText = $null; $oldImage = $null; $oldFiles = $null
try {
  if ([System.Windows.Forms.Clipboard]::ContainsText()) { $oldText = [System.Windows.Forms.Clipboard]::GetText() }
  elseif ([System.Windows.Forms.Clipboard]::ContainsImage()) { $oldImage = [System.Windows.Forms.Clipboard]::GetImage() }
  elseif ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) { $oldFiles = [System.Windows.Forms.Clipboard]::GetFileDropList() }
} catch {}
[System.Windows.Forms.Clipboard]::SetText(${psQuote(text)})
Start-Sleep -Milliseconds 60
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 350
try {
  if ($null -ne $oldText) { [System.Windows.Forms.Clipboard]::SetText($oldText) }
  elseif ($null -ne $oldImage) { [System.Windows.Forms.Clipboard]::SetImage($oldImage) }
  elseif ($null -ne $oldFiles) { [System.Windows.Forms.Clipboard]::SetFileDropList($oldFiles) }
  else { [System.Windows.Forms.Clipboard]::Clear() }
} catch {}`, 30_000 + text.length * 2);
      return { method: 'paste' };
    }
    await this.ps(`[System.Windows.Forms.SendKeys]::SendWait(${psQuote(escapeSendKeys(text))})`, 30_000 + text.length * 30);
    return { method: 'type' };
  }

  async key(combo: string, opts: { repeat?: number } = {}): Promise<void> {
    const repeat = Math.max(1, Math.min(100, r(opts.repeat ?? 1)));
    await this.ps(windowsKeyScript(parseKeyCombo(combo), repeat, Math.max(10, this.inputDelay)));
  }

  // ── windows ──

  async activeWindow(): Promise<WindowInfo | null> {
    const out = await this.ps('$h = [QodexDesktop]::GetForegroundWindow()\nif ($h -eq [IntPtr]::Zero) { \'null\' } else { QxWin $h | ConvertTo-Json -Compress }');
    const w = parseWindowsJson(out)[0];
    return w ? { ...w, focused: true } : null;
  }

  async listWindows(app?: string): Promise<WindowInfo[]> {
    const out = await this.ps(`$fg = [string][QodexDesktop]::GetForegroundWindow().ToInt64()
$list = @(foreach ($p in Get-Process) {
  try {
    if ($p.MainWindowHandle -ne [IntPtr]::Zero -and $p.MainWindowTitle) {
      $w = QxWin $p.MainWindowHandle
      $w | Add-Member -NotePropertyName focused -NotePropertyValue ($w.id -eq $fg)
      $w
    }
  } catch {}
})
ConvertTo-Json -InputObject $list -Compress`);
    const wins = parseWindowsJson(out);
    return app ? wins.filter(w => windowMatches(w, app)) : wins;
  }

  async focusWindow(query: string): Promise<WindowInfo> {
    const wins = await this.listWindows();
    const w = pickWindow(wins, query);
    if (!w || !w.id) throw windowNotFound(query, wins);
    await this.ps(`$h = [IntPtr][int64]${psQuote(w.id)}
if ([QodexDesktop]::IsIconic($h)) { [void][QodexDesktop]::ShowWindow($h, 9) }
$procId = [uint32]0
[void][QodexDesktop]::GetWindowThreadProcessId($h, [ref]$procId)
try { [void](New-Object -ComObject WScript.Shell).AppActivate([int]$procId) } catch {}
[void][QodexDesktop]::SetForegroundWindow($h)`);
    return { ...w, focused: true };
  }

  async openApp(target: string): Promise<string> {
    const t = classifyOpenTarget(target, () => false);
    const kind = t.kind === 'path' || /^[a-z]:[\\/]/i.test(target) ? 'path' : t.kind;
    const value = kind === 'path' ? target : t.value;
    const out = await this.ps(`$t = ${psQuote(value)}
$kind = ${psQuote(kind)}
if ($kind -ne 'app') { Start-Process -FilePath $t; "Opened $t"; return }
try { Start-Process -FilePath $t -ErrorAction Stop; "Started $t"; return } catch {}
$dirs = @("$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs", "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs")
$cands = @(Get-ChildItem -LiteralPath $dirs -Filter *.lnk -Recurse -ErrorAction SilentlyContinue |
  Where-Object { $_.BaseName.IndexOf($t, [StringComparison]::OrdinalIgnoreCase) -ge 0 } |
  Sort-Object @{ Expression = { if ($_.BaseName -ieq $t) { 0 } else { 1 } } }, @{ Expression = { $_.BaseName.Length } })
if ($cands.Count -gt 0) { Start-Process -FilePath $cands[0].FullName; "Started $($cands[0].BaseName) (Start menu)"; return }
throw "[COMPUTER_USE_ERROR] windows: no app, command or Start-menu shortcut named '$t'. Use the executable name (notepad, calc, chrome), a full path, or a URL."`);
    return out.trim() || `Opened ${value}`;
  }

  // ── clipboard ──

  async clipboardGet(): Promise<string> {
    return this.ps('$c = $null\nif ([System.Windows.Forms.Clipboard]::ContainsText()) { $c = [System.Windows.Forms.Clipboard]::GetText() }\nif ($null -ne $c) { [Console]::Out.Write($c) }');
  }

  async clipboardSet(text: string): Promise<void> {
    if (text === '') await this.ps('[System.Windows.Forms.Clipboard]::Clear()');
    else await this.ps(`[System.Windows.Forms.Clipboard]::SetText(${psQuote(text)})`);
  }
}
