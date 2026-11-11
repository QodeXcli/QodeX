/**
 * X11 desktop control. Real xdotool / scrot / import — no display is faked.
 * Click, type, and key are confirmed by the caller before these run.
 */
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ToolContext, ToolResult } from '../base.js';

type Confirm = (ctx: ToolContext, tool: string, operation: string) => Promise<ToolResult | null>;

export function mapKeyCombo(combo: string): string {
  const parts = combo.toLowerCase().split('+').map(s => s.trim()).filter(Boolean);
  return parts.map(p => {
    if (p === 'cmd' || p === 'command' || p === 'meta' || p === 'win' || p === 'super') return 'super';
    if (p === 'opt' || p === 'alt' || p === 'option') return 'alt';
    if (p === 'ctrl' || p === 'control') return 'ctrl';
    if (p === 'esc' || p === 'escape') return 'Escape';
    if (p === 'enter' || p === 'return') return 'Return';
    if (p === 'tab') return 'Tab';
    if (p === 'space') return 'space';
    if (p === 'left') return 'Left';
    if (p === 'right') return 'Right';
    if (p === 'up') return 'Up';
    if (p === 'down') return 'Down';
    return p;
  }).join('+');
}

export function x11ClickArgs(x: number, y: number, button: 'left' | 'right', count: number): string[] {
  const args = ['mousemove', '--sync', String(x), String(y), 'click'];
  if (count > 1) args.push('--repeat', String(count), '--delay', '80');
  args.push(button === 'right' ? '3' : '1');
  return args;
}

export function x11TypeArgs(text: string): string[] {
  return ['type', '--delay', '12', '--', text];
}

export function x11KeyArgs(combo: string): string[] {
  return ['key', '--', mapKeyCombo(combo)];
}

function runCmd(cmd: string, args: string[], timeoutMs = 10_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf-8'); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf-8'); });
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('exit', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${cmd} exited ${code}: ${stderr.trim() || stdout.trim()}`));
      else resolve({ stdout, stderr });
    });
  });
}

async function which(cmd: string): Promise<string | null> {
  try {
    const { stdout } = await runCmd('which', [cmd], 3000);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function missing(what: string): ToolResult {
  return {
    content: `[COMPUTER_USE_UNAVAILABLE] ${what} The Linux backend is implemented; the binary is not installed.`,
    isError: true,
  };
}

export async function runLinuxScreenshot(args: { path?: string; window?: string }): Promise<ToolResult> {
  const scrot = await which('scrot');
  const magick = await which('import');
  const gnome = await which('gnome-screenshot');
  const xdotool = await which('xdotool');
  if (!scrot && !magick && !gnome) return missing('Linux screenshot needs scrot, ImageMagick import, or gnome-screenshot.');
  const dir = path.join(os.tmpdir(), 'qodex-screenshots');
  await fs.mkdir(dir, { recursive: true });
  const dest = args.path ?? path.join(dir, `desktop-${Date.now()}.png`);
  try {
    if (args.window && xdotool && magick) {
      const { stdout } = await runCmd(xdotool, ['search', '--name', args.window]);
      const id = stdout.trim().split('\n').filter(Boolean)[0];
      if (!id) return { content: `[COMPUTER_USE_ERROR] no window named "${args.window}"`, isError: true };
      await runCmd(magick, ['-window', id, dest]);
    } else if (scrot) {
      await runCmd(scrot, [dest]);
    } else if (magick) {
      await runCmd(magick, ['-window', 'root', dest]);
    } else {
      await runCmd(gnome!, ['-f', dest]);
    }
    const stat = await fs.stat(dest);
    return { content: `Screenshot saved: ${dest}\n  Size: ${(stat.size / 1024).toFixed(1)} KB`, metadata: { path: dest, sizeBytes: stat.size } };
  } catch (e: any) {
    return { content: `[COMPUTER_USE_ERROR] screenshot failed: ${e?.message ?? e}`, isError: true };
  }
}

export async function runLinuxClick(
  args: { x: number; y: number; button?: 'left' | 'right'; count?: number },
  ctx: ToolContext,
  confirm: Confirm,
): Promise<ToolResult> {
  const blocked = await confirm(ctx, 'computer_use_click', `click ${args.x},${args.y}`);
  if (blocked) return blocked;
  const bin = await which('xdotool');
  if (!bin) return missing('Linux click needs xdotool (apt install xdotool).');
  try {
    await runCmd(bin, x11ClickArgs(args.x, args.y, args.button ?? 'left', args.count ?? 1));
    return { content: `Clicked at (${args.x}, ${args.y}) via xdotool.` };
  } catch (e: any) {
    return { content: `[COMPUTER_USE_ERROR] click failed: ${e?.message ?? e}`, isError: true };
  }
}

export async function runLinuxType(args: { text: string }, ctx: ToolContext, confirm: Confirm): Promise<ToolResult> {
  const blocked = await confirm(ctx, 'computer_use_type', `type ${args.text.length} chars`);
  if (blocked) return blocked;
  const bin = await which('xdotool');
  if (!bin) return missing('Linux type needs xdotool.');
  try {
    await runCmd(bin, x11TypeArgs(args.text), 15_000);
    return { content: `Typed ${args.text.length} char(s) via xdotool.` };
  } catch (e: any) {
    return { content: `[COMPUTER_USE_ERROR] type failed: ${e?.message ?? e}`, isError: true };
  }
}

export async function runLinuxKey(args: { combo: string }, ctx: ToolContext, confirm: Confirm): Promise<ToolResult> {
  const blocked = await confirm(ctx, 'computer_use_key', `key ${args.combo}`);
  if (blocked) return blocked;
  const bin = await which('xdotool');
  if (!bin) return missing('Linux key needs xdotool.');
  try {
    await runCmd(bin, x11KeyArgs(args.combo));
    return { content: `Pressed ${args.combo} via xdotool (${mapKeyCombo(args.combo)}).` };
  } catch (e: any) {
    return { content: `[COMPUTER_USE_ERROR] key failed: ${e?.message ?? e}`, isError: true };
  }
}

export async function runLinuxActiveWindow(): Promise<ToolResult> {
  const bin = await which('xdotool');
  if (!bin) return missing('Linux window info needs xdotool.');
  try {
    const { stdout } = await runCmd(bin, ['getactivewindow', 'getwindowname', 'getwindowgeometry']);
    return { content: stdout.trim() || 'Active window (no title).' };
  } catch (e: any) {
    return { content: `[COMPUTER_USE_ERROR] ${e?.message ?? e}`, isError: true };
  }
}

export async function runLinuxListWindows(app?: string): Promise<ToolResult> {
  const wmctrl = await which('wmctrl');
  if (wmctrl) {
    try {
      const { stdout } = await runCmd(wmctrl, ['-lx']);
      const lines = stdout.split('\n').filter(l => !app || l.toLowerCase().includes(app.toLowerCase()));
      return { content: lines.join('\n').trim() || 'No matching windows.' };
    } catch (e: any) {
      return { content: `[COMPUTER_USE_ERROR] ${e?.message ?? e}`, isError: true };
    }
  }
  const xdotool = await which('xdotool');
  if (!xdotool) return missing('Linux window list needs wmctrl or xdotool.');
  try {
    const args = app ? ['search', '--name', app, 'getwindowname'] : ['search', '--onlyvisible', '--name', '.', 'getwindowname'];
    const { stdout } = await runCmd(xdotool, args);
    return { content: stdout.trim() || 'No matching windows.' };
  } catch (e: any) {
    return { content: `[COMPUTER_USE_ERROR] ${e?.message ?? e}`, isError: true };
  }
}
