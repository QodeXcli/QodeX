/**
 * computer_use_* tool layer: config gating, availability errors, screenshot →
 * screen coordinate mapping (Retina, downscale, window origin), bounds
 * checks, tool flags/schemas, and the computer_use_agent sub-agent tool.
 * Backends are fakes (setDesktopBackendForTests / setDesktopExec).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ToolContext } from '../src/tools/base.js';
import { setActiveConfig, getActiveConfig } from '../src/config/loader.js';
import { setSubAgentRunner } from '../src/tools/builtin/task.js';
import { getBus } from '../src/control/bus.js';
import { setDesktopExec } from '../src/tools/computer/exec.js';
import {
  COMPUTER_TOOL_CLASSES,
  COMPUTER_TOOL_NAMES,
  ComputerUseScreenshotTool,
  ComputerUseClickTool,
  ComputerUseTypeTool,
  ComputerUseScrollTool,
  ComputerUseDragTool,
  ComputerUseClipboardTool,
  ComputerUseOpenTool,
  ComputerUseScreenInfoTool,
  ComputerUseKeyTool,
  ComputerUseFocusWindowTool,
  ComputerUseListWindowsTool,
  ComputerUseAgentTool,
  desktopStatusText,
} from '../src/tools/computer/index.js';
import {
  MacosBackend,
  setDesktopBackendForTests,
  setDesktopScreenshotsDir,
  resetDesktopState,
  type DesktopBackend,
  type ScreenshotOptions,
  type ScreenshotResult,
  type WindowInfo,
  type BackendAvailability,
} from '../src/tools/computer/backends/index.js';

type Rec = { op: string; args: unknown[] };

class FakeBackend implements DesktopBackend {
  readonly name = 'x11' as const;
  calls: Rec[] = [];
  availability: BackendAvailability = { ok: true, missing: [], hint: '', notes: ['screenshots: scrot', 'clipboard: xclip'] };
  shot = { width: 800, height: 600, scale: 1, origin: { x: 0, y: 0 } };
  windows: WindowInfo[] = [{ title: 'Inbox', app: 'thunderbird', focused: true }];
  clipboard = 'clip text';
  private rec(op: string, ...args: unknown[]) { this.calls.push({ op, args }); }
  async available() { return this.availability; }
  async screenshot(o: ScreenshotOptions): Promise<ScreenshotResult> {
    this.rec('screenshot', o);
    return { path: o.path, width: this.shot.width, height: this.shot.height, scale: this.shot.scale, origin: this.shot.origin, notes: [] };
  }
  async screenSize() { return { width: 1920, height: 1080 }; }
  async cursor() { return { x: 100, y: 200 }; }
  async click(x: number, y: number, o?: unknown) { this.rec('click', x, y, o); }
  async move(x: number, y: number) { this.rec('move', x, y); }
  async drag(...a: number[]) { this.rec('drag', ...a); }
  async scroll(dx: number, dy: number, at?: unknown) { this.rec('scroll', dx, dy, at); }
  async type(text: string, o?: { method?: string }) { this.rec('type', text, o); return { method: (o?.method === 'paste' ? 'paste' : 'type') as 'type' | 'paste' }; }
  async key(combo: string, o?: unknown) { this.rec('key', combo, o); }
  async activeWindow() { return this.windows[0] ?? null; }
  async listWindows() { return this.windows; }
  async focusWindow(q: string) { this.rec('focus', q); return { ...this.windows[0]!, focused: true }; }
  async openApp(t: string) { this.rec('open', t); return `Opened ${t}`; }
  async clipboardGet() { return this.clipboard; }
  async clipboardSet(t: string) { this.rec('clipboardSet', t); }
}

function makeCtx(cwd: string, signal = new AbortController().signal): ToolContext {
  return {
    cwd, sessionId: 'test', transaction: {} as any,
    permissions: { evaluate: () => 'allow' } as any,
    askUser: async () => 'yes', emit: () => {}, signal,
  } as ToolContext;
}

let dir: string;
let fake: FakeBackend;
const prevConfig = getActiveConfig();

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-desktools-'));
  setDesktopScreenshotsDir(dir);
  resetDesktopState();
  fake = new FakeBackend();
  setDesktopBackendForTests(fake);
  setSubAgentRunner(null);
});
afterEach(async () => {
  setDesktopBackendForTests(null);
  setDesktopScreenshotsDir(null);
  setDesktopExec(null);
  setSubAgentRunner(null);
  resetDesktopState();
  setActiveConfig(prevConfig as any);
  await fs.rm(dir, { recursive: true, force: true });
});

describe('tool surface', () => {
  it('exports every tool with a unique computer_use_ name and an object schema', () => {
    expect(COMPUTER_TOOL_NAMES).toHaveLength(COMPUTER_TOOL_CLASSES.length);
    expect(new Set(COMPUTER_TOOL_NAMES).size).toBe(COMPUTER_TOOL_NAMES.length);
    for (const name of COMPUTER_TOOL_NAMES) expect(name).toMatch(/^computer_use_[a-z_]+$/);
    for (const name of [
      'computer_use_screenshot', 'computer_use_click', 'computer_use_type', 'computer_use_key', 'computer_use_active_window',
      'computer_use_list_windows', 'computer_use_move', 'computer_use_drag', 'computer_use_scroll', 'computer_use_clipboard',
      'computer_use_open', 'computer_use_screen_info', 'computer_use_focus_window', 'computer_use_locate', 'computer_use_agent',
    ]) expect(COMPUTER_TOOL_NAMES).toContain(name);
    for (const T of COMPUTER_TOOL_CLASSES) {
      const t = new T();
      const params = t.schema().function.parameters as any;
      expect(params.type).toBe('object');
      expect(t.description.length).toBeGreaterThan(40);
    }
  });

  it('read-only only for pure observers; screenshot/locate deliberately not read-only', () => {
    const byName = new Map(COMPUTER_TOOL_CLASSES.map(T => { const t = new T(); return [t.name, t] as const; }));
    const readOnly = [...byName.values()].filter(t => t.isReadOnly).map(t => t.name).sort();
    expect(readOnly).toEqual(['computer_use_active_window', 'computer_use_list_windows', 'computer_use_screen_info']);
    expect(byName.get('computer_use_screenshot')!.isReadOnly).toBe(false);
    expect(byName.get('computer_use_locate')!.isReadOnly).toBe(false);
    for (const n of ['computer_use_click', 'computer_use_type', 'computer_use_key', 'computer_use_move', 'computer_use_drag', 'computer_use_scroll', 'computer_use_open', 'computer_use_clipboard', 'computer_use_agent']) {
      expect(byName.get(n)!.isDestructive).toBe(true);
    }
    for (const n of ['computer_use_active_window', 'computer_use_list_windows', 'computer_use_clipboard', 'computer_use_locate']) {
      expect(byName.get(n)!.untrustedOutput).toBe(true);
    }
    expect(byName.get('computer_use_agent')!.timeoutSeconds).toBe(0);
  });

  it('descriptions keep .describe() text in the JSON schema', () => {
    const p = new ComputerUseClickTool().schema().function.parameters as any;
    expect(p.properties.x.description).toMatch(/screenshot/);
    expect(p.properties.button.enum).toEqual(['left', 'right', 'middle']);
    expect(p.properties.button.description).toBeTruthy();
    expect(p.required).toEqual(['x', 'y']);
  });
});

describe('gating', () => {
  it('desktop.enabled: false → [COMPUTER_USE_DISABLED] (agent included)', async () => {
    setActiveConfig({ desktop: { enabled: false } } as any);
    const r1 = await new ComputerUseClickTool().execute({ x: 1, y: 1 }, makeCtx(dir));
    expect(r1.isError).toBe(true);
    expect(r1.content).toMatch(/^\[COMPUTER_USE_DISABLED\]/);
    setSubAgentRunner(async () => { throw new Error('must not run'); });
    const r2 = await new ComputerUseAgentTool().execute({ task: 'x' }, makeCtx(dir));
    expect(r2.content).toMatch(/^\[COMPUTER_USE_DISABLED\]/);
    expect(fake.calls).toEqual([]);
  });

  it('unavailable backend → [COMPUTER_USE_UNAVAILABLE] listing missing binaries', async () => {
    fake.availability = { ok: false, missing: ['xdotool', 'scrot|import|gnome-screenshot'], hint: 'sudo apt install xdotool scrot', notes: [] };
    const r = await new ComputerUseScreenshotTool().execute({}, makeCtx(dir));
    expect(r.content).toBe('[COMPUTER_USE_UNAVAILABLE] x11: missing xdotool, scrot|import|gnome-screenshot. Install: sudo apt install xdotool scrot');
    expect(fake.calls).toEqual([]);
  });

  it('aborted signal → [ABORTED] without touching the desktop', async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await new ComputerUseClickTool().execute({ x: 1, y: 1 }, makeCtx(dir, ac.signal));
    expect(r.content).toMatch(/^\[ABORTED\]/);
    expect(fake.calls).toEqual([]);
  });

  it('backend errors keep their [CODE]; others are wrapped', async () => {
    fake.focusWindow = async () => { throw new Error('[WINDOW_NOT_FOUND] No window matches "x".'); };
    expect((await new ComputerUseFocusWindowTool().execute({ query: 'x' }, makeCtx(dir))).content).toBe('[WINDOW_NOT_FOUND] No window matches "x".');
    fake.key = async () => { throw new Error('boom'); };
    expect((await new ComputerUseKeyTool().execute({ combo: 'enter' }, makeCtx(dir))).content).toBe('[COMPUTER_USE_ERROR] computer_use_key failed: boom');
  });
});

describe('coordinates', () => {
  it('without a screenshot, coordinates pass through (with a note)', async () => {
    const r = await new ComputerUseClickTool().execute({ x: 10.6, y: 20 }, makeCtx(dir));
    expect(fake.calls).toEqual([{ op: 'click', args: [11, 20, { button: 'left', count: 1 }] }]);
    expect(r.content).toMatch(/no screenshot yet/);
  });

  it('maps through the last screenshot scale and window origin', async () => {
    fake.shot = { width: 1600, height: 1200, scale: 2, origin: { x: 100, y: 50 } };
    const shot = await new ComputerUseScreenshotTool().execute({ window: 'Safari' }, makeCtx(dir));
    expect(shot.isError).toBeFalsy();
    expect(shot.content).toMatch(/scale 2\.000 is applied automatically/);
    expect((fake.calls[0]!.args[0] as ScreenshotOptions).maxWidth).toBe(1600);
    expect((fake.calls[0]!.args[0] as ScreenshotOptions).path.startsWith(dir)).toBe(true);
    await new ComputerUseClickTool().execute({ x: 200, y: 100, button: 'right', count: 2 }, makeCtx(dir));
    await new ComputerUseDragTool().execute({ from_x: 0, from_y: 0, to_x: 400, to_y: 400 }, makeCtx(dir));
    await new ComputerUseScrollTool().execute({ direction: 'down', amount: 3, x: 20, y: 40 }, makeCtx(dir));
    await new ComputerUseScrollTool().execute({ direction: 'left' }, makeCtx(dir));
    expect(fake.calls.slice(1)).toEqual([
      { op: 'click', args: [200, 100, { button: 'right', count: 2 }] },
      { op: 'drag', args: [100, 50, 300, 250] },
      { op: 'scroll', args: [0, 3, { x: 110, y: 70 }] },
      { op: 'scroll', args: [-5, 0, {}] },
    ]);
  });

  it('rejects coordinates outside the last screenshot', async () => {
    await new ComputerUseScreenshotTool().execute({}, makeCtx(dir));
    const r = await new ComputerUseClickTool().execute({ x: 900, y: 10 }, makeCtx(dir));
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/^\[COMPUTER_USE_ERROR\] \(900, 10\) is outside the last screenshot \(800×600 px\)/);
    expect(fake.calls.filter(c => c.op === 'click')).toEqual([]);
  });

  it('macOS Retina end-to-end: 2880px capture → downscaled to 1600 → clicks mapped to points', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    let dest = '';
    setDesktopExec({
      run: async (cmd, args) => {
        calls.push({ cmd, args });
        const header = (w: number, h: number) => {
          const b = Buffer.alloc(33);
          b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4); b.writeUInt32BE(13, 8);
          b.write('IHDR', 12, 'ascii'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
          return b;
        };
        if (cmd === 'screencapture') { dest = args[args.length - 1]!; await fs.writeFile(dest, header(2880, 1800)); }
        if (cmd === 'sips') await fs.writeFile(dest, header(1600, 1000));
        if (cmd === 'osascript') return { stdout: '{"width":1440,"height":900}', stderr: '', code: 0 };
        return { stdout: '', stderr: '', code: 0 };
      },
    });
    setDesktopBackendForTests(new MacosBackend({ env: {}, platform: 'darwin', inputDelayMs: 40 }));
    const shot = await new ComputerUseScreenshotTool().execute({}, makeCtx(dir));
    expect(shot.content).toMatch(/1600×1000 px/);
    expect(shot.metadata!.scale).toBeCloseTo(1600 / 1440, 6);
    await new ComputerUseClickTool().execute({ x: 800, y: 450 }, makeCtx(dir));
    expect(calls[calls.length - 1]).toEqual({ cmd: 'cliclick', args: ['c:720,405'] });
  });
});

describe('individual tools', () => {
  it('type never echoes the text and the bus event carries no text', async () => {
    const events: any[] = [];
    const unsub = getBus().subscribe(e => events.push(e));
    const r = await new ComputerUseTypeTool().execute({ text: 'hunter2-secret', submit: true }, makeCtx(dir));
    unsub();
    expect(r.content).toBe('✓ Typed 14 character(s) and pressed Enter. Take computer_use_screenshot to verify.');
    expect(fake.calls).toEqual([{ op: 'type', args: ['hunter2-secret', { method: 'auto' }] }, { op: 'key', args: ['enter', undefined] }]);
    const ev = events.find(e => e.kind === 'agent' && e.source === 'desktop');
    expect(ev.data.tool).toBe('computer_use_type');
    expect(JSON.stringify(events)).not.toContain('hunter2');
  });

  it('screenshot only writes image paths (relative to the working dir)', async () => {
    const bad = await new ComputerUseScreenshotTool().execute({ path: 'src/index.ts' }, makeCtx(dir));
    expect(bad.isError).toBe(true);
    expect(bad.content).toMatch(/must end with \.png, \.jpg or \.jpeg/);
    expect(fake.calls).toEqual([]);
    const ok = await new ComputerUseScreenshotTool().execute({ path: 'shots/a.PNG' }, makeCtx(dir));
    expect(ok.isError).toBeFalsy();
    expect((fake.calls[0]!.args[0] as ScreenshotOptions).path).toBe(path.join(dir, 'shots', 'a.PNG'));
  });

  it('clipboard get/set', async () => {
    const get = await new ComputerUseClipboardTool().execute({ action: 'get' }, makeCtx(dir));
    expect(get.content).toBe('Clipboard (9 characters):\nclip text');
    const bad = await new ComputerUseClipboardTool().execute({ action: 'set' }, makeCtx(dir));
    expect(bad.isError).toBe(true);
    await new ComputerUseClipboardTool().execute({ action: 'set', text: 'سلام' }, makeCtx(dir));
    expect(fake.calls).toEqual([{ op: 'clipboardSet', args: ['سلام'] }]);
  });

  it('open resolves relative paths against the working dir; apps/URLs pass through', async () => {
    await fs.writeFile(path.join(dir, 'report.pdf'), 'x');
    await new ComputerUseOpenTool().execute({ target: 'report.pdf' }, makeCtx(dir));
    await new ComputerUseOpenTool().execute({ target: './missing.txt' }, makeCtx(dir));
    await new ComputerUseOpenTool().execute({ target: 'Calculator' }, makeCtx(dir));
    await new ComputerUseOpenTool().execute({ target: 'https://example.com/a' }, makeCtx(dir));
    expect(fake.calls.map(c => c.args[0])).toEqual([
      path.join(dir, 'report.pdf'),
      path.join(dir, 'missing.txt'),
      'Calculator',
      'https://example.com/a',
    ]);
  });

  it('screen_info reports backend, screen, pointer, mapping and capabilities', async () => {
    let r = await new ComputerUseScreenInfoTool().execute({}, makeCtx(dir));
    expect(r.content).toContain('Backend: x11');
    expect(r.content).toContain('Screen: 1920×1080');
    expect(r.content).toContain('Pointer: screen (100, 200)');
    expect(r.content).toContain('Last screenshot: none yet');
    expect(r.content).toContain('screenshots: scrot');
    fake.shot = { width: 960, height: 540, scale: 0.5, origin: { x: 0, y: 0 } };
    await new ComputerUseScreenshotTool().execute({}, makeCtx(dir));
    r = await new ComputerUseScreenInfoTool().execute({}, makeCtx(dir));
    expect(r.content).toContain('= (50, 100) in the last screenshot');
    expect(r.content).toMatch(/scale 0\.500/);
  });

  it('desktopStatusText summarizes the backend, or the missing binaries', async () => {
    expect(await desktopStatusText(dir)).toContain('Backend: x11');
    fake.availability = { ok: false, missing: ['xdotool'], hint: 'sudo apt install xdotool', notes: [] };
    expect(await desktopStatusText(dir)).toBe('[COMPUTER_USE_UNAVAILABLE] x11: missing xdotool. Install: sudo apt install xdotool');
  });

  it('list_windows formats windows', async () => {
    const r = await new ComputerUseListWindowsTool().execute({}, makeCtx(dir));
    expect(r.content).toBe('1 window(s):\n- [focused] "Inbox" · app: thunderbird');
  });
});

describe('computer_use_agent', () => {
  it('without a sub-agent runner → [SUBAGENT_DISABLED] with direct-tool guidance', async () => {
    const r = await new ComputerUseAgentTool().execute({ task: 'open settings' }, makeCtx(dir));
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/^\[SUBAGENT_DISABLED\][\s\S]*computer_use_screenshot → computer_use_locate/);
  });

  it('dispatches a computer-role sub-agent with an operating guide', async () => {
    let got: any = null;
    setSubAgentRunner(async (prompt, opts) => {
      got = { prompt, opts };
      return { finalText: 'Dark mode is on (screenshot shows the toggle enabled).', toolCallsRun: 7, ok: true, modelUsed: 'm' };
    });
    const r = await new ComputerUseAgentTool().execute({ task: 'Turn on dark mode in system settings' }, makeCtx(dir));
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/^\[COMPUTER_AGENT_DONE\] 7 tool call\(s\)/);
    expect(r.content).toContain('Dark mode is on');
    expect(got.opts.role).toBe('computer');
    expect(got.opts.maxIterations).toBe(30);
    expect(got.opts.sessionId).toMatch(/^test\/computer-\d+$/);
    expect(got.prompt).toContain('TASK: Turn on dark mode in system settings');
    expect(got.prompt).toContain('computer_use_locate');
    expect(got.prompt).toMatch(/untrusted DATA/);
    expect(got.prompt).toContain('screenshots: scrot');
  });

  it('reports sub-agent failures with the partial report', async () => {
    setSubAgentRunner(async () => ({ finalText: 'opened the app', toolCallsRun: 3, ok: false, error: 'budget exhausted' }));
    const r = await new ComputerUseAgentTool().execute({ task: 'x', max_steps: 5 }, makeCtx(dir));
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/^\[COMPUTER_AGENT_FAILED\][\s\S]*budget exhausted[\s\S]*opened the app/);
  });
});
