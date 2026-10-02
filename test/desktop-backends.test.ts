/**
 * Desktop backends: platform selection, key-combo mapping, and the exact
 * command lines each backend runs — all through an injected fake command
 * runner (setDesktopExec). No real input is ever sent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { setDesktopExec, type ExecOptions, type ExecResult } from '../src/tools/computer/exec.js';
import {
  selectBackendName,
  parseKeyCombo,
  pickWindow,
  classifyOpenTarget,
  imageSizeFromBuffer,
  linuxInstallHint,
  X11Backend,
  MacosBackend,
  WindowsBackend,
  WaylandBackend,
  type BackendDeps,
} from '../src/tools/computer/backends/index.js';
import { x11KeyCombo, parseWmctrl, parseDesktopEntry, splitExec } from '../src/tools/computer/backends/x11.js';
import { appleScriptKey, jxaMouseScript, parseMacWindowLines } from '../src/tools/computer/backends/macos.js';
import {
  PS_ARGS,
  escapeSendKeys,
  psQuote,
  decodePowerShellStdin,
  powershellStdin,
  windowsKeyScript,
  parseWindowsJson,
} from '../src/tools/computer/backends/windows.js';
import { ydotoolKeyArgs, parseSwayTree, parseHyprClients } from '../src/tools/computer/backends/wayland.js';
import { unavailableMessage } from '../src/tools/computer/use.js';

interface Call { cmd: string; args: string[]; opts?: ExecOptions }
type Responder = (c: Call) => Partial<ExecResult> | void | Promise<Partial<ExecResult> | void>;

function fakeExec(responder?: Responder, missing: string[] = []) {
  const calls: Call[] = [];
  const spawned: Call[] = [];
  setDesktopExec({
    run: async (cmd, args, opts) => {
      const c = { cmd, args, opts };
      calls.push(c);
      const r = (await responder?.(c)) ?? {};
      return { stdout: '', stderr: '', code: 0, ...r };
    },
    which: async (cmd) => (missing.includes(cmd) ? null : `/usr/bin/${cmd}`),
    spawnDetached: async (cmd, args) => { spawned.push({ cmd, args }); },
  });
  return { calls, spawned };
}

/** Minimal PNG header with the given size (enough for size sniffing). */
function png(w: number, h: number): Buffer {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

const deps = (over: Partial<BackendDeps> = {}): BackendDeps => ({
  env: { DISPLAY: ':0', LANG: 'C' },
  platform: 'linux',
  inputDelayMs: 40,
  osRelease: 'ID=ubuntu\nID_LIKE=debian\n',
  ...over,
});

let tmp: string;
beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-desk-')); });
afterEach(async () => {
  setDesktopExec(null);
  await fs.rm(tmp, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('backend selection', () => {
  it('picks per platform / session type', () => {
    expect(selectBackendName('darwin', {})).toBe('macos');
    expect(selectBackendName('win32', {})).toBe('windows');
    expect(selectBackendName('linux', { DISPLAY: ':0' })).toBe('x11');
    expect(selectBackendName('linux', { WAYLAND_DISPLAY: 'wayland-0' })).toBe('wayland');
    expect(selectBackendName('linux', { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' })).toBe('x11');
    expect(selectBackendName('linux', {})).toBe('x11');
    expect(selectBackendName('freebsd', { DISPLAY: ':0' })).toBe('x11');
    expect(selectBackendName('aix', {})).toBeNull();
  });

  it('config desktop.backend overrides detection', () => {
    expect(selectBackendName('linux', { DISPLAY: ':0' }, 'wayland')).toBe('wayland');
    expect(selectBackendName('darwin', {}, 'x11')).toBe('x11');
  });
});

describe('key combos', () => {
  it('parses modifiers, aliases and special keys', () => {
    expect(parseKeyCombo('cmd+s')).toEqual({ modifiers: ['super'], key: 's' });
    expect(parseKeyCombo('Ctrl+Shift+PageUp')).toEqual({ modifiers: ['ctrl', 'shift'], key: 'pageup' });
    expect(parseKeyCombo('Return')).toEqual({ modifiers: [], key: 'enter' });
    expect(parseKeyCombo('esc')).toEqual({ modifiers: [], key: 'escape' });
    expect(parseKeyCombo('ctrl++')).toEqual({ modifiers: ['ctrl'], key: '+' });
    expect(parseKeyCombo('+')).toEqual({ modifiers: [], key: '+' });
    expect(parseKeyCombo('option+F5')).toEqual({ modifiers: ['alt'], key: 'f5' });
    expect(parseKeyCombo('super')).toEqual({ modifiers: [], key: 'super' });
    expect(parseKeyCombo('cmd+,')).toEqual({ modifiers: ['super'], key: ',' });
    expect(parseKeyCombo('Page Down')).toEqual({ modifiers: [], key: 'pagedown' });
  });

  it('rejects unusable combos with a [COMPUTER_USE_ERROR]', () => {
    expect(() => parseKeyCombo('')).toThrow(/\[COMPUTER_USE_ERROR\]/);
    expect(() => parseKeyCombo('a+b')).toThrow(/non-modifier/);
    expect(() => parseKeyCombo('ctrl+س')).toThrow(/computer_use_type/);
  });

  it('maps to xdotool keysyms', () => {
    expect(x11KeyCombo(parseKeyCombo('cmd+s'))).toBe('super+s');
    expect(x11KeyCombo(parseKeyCombo('ctrl+shift+pageup'))).toBe('ctrl+shift+Page_Up');
    expect(x11KeyCombo(parseKeyCombo('enter'))).toBe('Return');
    expect(x11KeyCombo(parseKeyCombo('ctrl++'))).toBe('ctrl+plus');
    expect(x11KeyCombo(parseKeyCombo('f5'))).toBe('F5');
    expect(x11KeyCombo(parseKeyCombo('cmd+,'))).toBe('super+comma');
    expect(x11KeyCombo(parseKeyCombo('backspace'))).toBe('BackSpace');
  });

  it('maps to Linux keycodes for ydotool', () => {
    expect(ydotoolKeyArgs(parseKeyCombo('ctrl+v'))).toEqual(['29:1', '47:1', '47:0', '29:0']);
    expect(ydotoolKeyArgs(parseKeyCombo('ctrl+shift+t'))).toEqual(['29:1', '42:1', '20:1', '20:0', '42:0', '29:0']);
    expect(ydotoolKeyArgs(parseKeyCombo('down'), 2)).toEqual(['108:1', '108:0', '108:1', '108:0']);
    expect(ydotoolKeyArgs(parseKeyCombo('+'))).toEqual(['42:1', '13:1', '13:0', '42:0']);
  });

  it('maps to AppleScript key codes / keystrokes', () => {
    expect(appleScriptKey(parseKeyCombo('cmd+shift+s'))).toContain('keystroke "s" using {command down, shift down}');
    expect(appleScriptKey(parseKeyCombo('enter'))).toContain('key code 36');
    expect(appleScriptKey(parseKeyCombo('backspace'))).toContain('key code 51');
    expect(appleScriptKey(parseKeyCombo('delete'))).toContain('key code 117');
    expect(appleScriptKey(parseKeyCombo('cmd+q'), 3)).toMatch(/repeat 3 times[\s\S]*keystroke "q" using \{command down\}/);
    expect(() => appleScriptKey(parseKeyCombo('printscreen'))).toThrow(/cmd\+shift\+3/);
  });

  it('maps to Windows virtual keys (incl. the Win key)', () => {
    const s = windowsKeyScript(parseKeyCombo('win+r'));
    expect(s.split('\n')).toEqual([
      '[QodexDesktop]::keybd_event([byte]0x5b, [byte]0, [uint32]1, [UIntPtr]::Zero)',
      '[QodexDesktop]::keybd_event([byte]0x52, [byte]0, [uint32]0, [UIntPtr]::Zero)',
      '[QodexDesktop]::keybd_event([byte]0x52, [byte]0, [uint32]2, [UIntPtr]::Zero)',
      '[QodexDesktop]::keybd_event([byte]0x5b, [byte]0, [uint32]3, [UIntPtr]::Zero)',
    ]);
    expect(windowsKeyScript(parseKeyCombo('ctrl+f4'))).toContain('[byte]0x73');
    expect(windowsKeyScript(parseKeyCombo('left'))).toContain('[byte]0x25, [byte]0, [uint32]1');
  });
});

describe('shared helpers', () => {
  it('pickWindow prefers exact title, then app, then substring, then focused', () => {
    const wins = [
      { title: 'Notes — draft', app: 'TextEdit' },
      { title: 'Terminal', app: 'Terminal' },
      { title: 'zsh — 80x24', app: 'Terminal', focused: true },
      { title: 'Inbox', app: 'Mail' },
    ];
    expect(pickWindow(wins, 'terminal')!.title).toBe('Terminal');
    expect(pickWindow(wins, 'mail')!.title).toBe('Inbox');
    expect(pickWindow(wins, 'draft')!.app).toBe('TextEdit');
    expect(pickWindow(wins, 'nope')).toBeUndefined();
  });

  it('classifies open targets', () => {
    const none = () => false;
    expect(classifyOpenTarget('https://example.com', none)).toEqual({ kind: 'url', value: 'https://example.com' });
    expect(classifyOpenTarget('github.com/foo', none)).toEqual({ kind: 'url', value: 'https://github.com/foo' });
    expect(classifyOpenTarget('localhost:3000', none)).toEqual({ kind: 'url', value: 'http://localhost:3000' });
    expect(classifyOpenTarget('mailto:a@b.co', none).kind).toBe('url');
    expect(classifyOpenTarget('/tmp/x.txt', none)).toEqual({ kind: 'path', value: '/tmp/x.txt' });
    expect(classifyOpenTarget('C:\\Users\\me\\a.docx', none).kind).toBe('path');
    expect(classifyOpenTarget('~/Documents', none).kind).toBe('path');
    expect(classifyOpenTarget('Visual Studio Code', none)).toEqual({ kind: 'app', value: 'Visual Studio Code' });
    expect(classifyOpenTarget('notes.txt', p => p === 'notes.txt').kind).toBe('path');
    expect(classifyOpenTarget('notes.txt', none).kind).toBe('app');
  });

  it('sniffs PNG/GIF/BMP/JPEG sizes', () => {
    expect(imageSizeFromBuffer(png(2880, 1800))).toEqual({ width: 2880, height: 1800 });
    const gif = Buffer.from('GIF89a\x40\x01\xf0\x00', 'latin1');
    expect(imageSizeFromBuffer(gif)).toEqual({ width: 320, height: 240 });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03]);
    expect(imageSizeFromBuffer(jpeg)).toEqual({ width: 800, height: 600 });
    expect(imageSizeFromBuffer(Buffer.from('nope'))).toBeNull();
  });

  it('builds distro-specific install hints', () => {
    const pk = [{ apt: 'xdotool', dnf: 'xdotool', pacman: 'xdotool' }, { apt: 'imagemagick', dnf: 'ImageMagick', pacman: 'imagemagick' }];
    expect(linuxInstallHint(pk, 'ID=fedora\n')).toBe('sudo dnf install xdotool ImageMagick');
    expect(linuxInstallHint(pk, 'ID=arch\n')).toBe('sudo pacman -S xdotool imagemagick');
    const generic = linuxInstallHint(pk, undefined);
    expect(generic).toContain('Debian/Ubuntu: sudo apt install xdotool imagemagick');
    expect(generic).toContain('Fedora:');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('x11 backend', () => {
  it('reports missing binaries with an install hint', async () => {
    fakeExec(undefined, ['xdotool', 'scrot', 'import', 'gnome-screenshot']);
    const b = new X11Backend(deps());
    const av = await b.available();
    expect(av.ok).toBe(false);
    expect(av.missing).toEqual(['xdotool', 'scrot|import|gnome-screenshot']);
    expect(av.hint).toBe('sudo apt install xdotool scrot');
    expect(unavailableMessage('x11', av)).toBe(
      '[COMPUTER_USE_UNAVAILABLE] x11: missing xdotool, scrot|import|gnome-screenshot. Install: sudo apt install xdotool scrot',
    );
  });

  it('needs a DISPLAY', async () => {
    fakeExec();
    const av = await new X11Backend(deps({ env: {} })).available();
    expect(av.ok).toBe(false);
    expect(av.missing).toEqual(['DISPLAY']);
    expect(unavailableMessage('x11', av)).toMatch(/^\[COMPUTER_USE_UNAVAILABLE\] x11: missing DISPLAY\. Fix: .*xvfb-run/);
  });

  it('is ok with xdotool + a screenshot tool, and notes optional tools', async () => {
    fakeExec(undefined, ['scrot', 'xclip', 'xsel', 'wmctrl', 'magick', 'convert']);
    const av = await new X11Backend(deps()).available();
    expect(av.ok).toBe(true);
    expect(av.notes.join('\n')).toMatch(/screenshots: import/);
    expect(av.notes.join('\n')).toMatch(/clipboard: unavailable/);
  });

  it('click / double right click / move', async () => {
    const { calls } = fakeExec();
    const b = new X11Backend(deps());
    await b.click(100, 200);
    await b.click(10.4, 20.6, { button: 'right', count: 2 });
    await b.move(5, 6);
    expect(calls.map(c => [c.cmd, ...c.args])).toEqual([
      ['xdotool', 'mousemove', '100', '200', 'click', '1'],
      ['xdotool', 'mousemove', '10', '21', 'click', '--repeat', '2', '--delay', '80', '3'],
      ['xdotool', 'mousemove', '5', '6'],
    ]);
  });

  it('drag holds the button through intermediate moves', async () => {
    const { calls } = fakeExec();
    await new X11Backend(deps()).drag(10, 20, 110, 220);
    expect(calls[0]!.args).toEqual([
      'mousemove', '10', '20', 'mousedown', '1', 'sleep', '0.08',
      'mousemove', '60', '120', 'sleep', '0.08',
      'mousemove', '110', '220', 'sleep', '0.08',
      'mouseup', '1',
    ]);
  });

  it('scroll maps directions to wheel buttons 4/5/6/7', async () => {
    const { calls } = fakeExec();
    const b = new X11Backend(deps());
    await b.scroll(0, 3, { x: 50, y: 60 });
    await b.scroll(0, -2);
    await b.scroll(4, 0);
    await b.scroll(-1, 0);
    expect(calls.map(c => c.args)).toEqual([
      ['mousemove', '50', '60', 'click', '--repeat', '3', '--delay', '40', '5'],
      ['click', '--repeat', '2', '--delay', '40', '4'],
      ['click', '--repeat', '4', '--delay', '40', '7'],
      ['click', '--repeat', '1', '--delay', '40', '6'],
    ]);
  });

  it('types with a UTF-8 locale and "--" before the text', async () => {
    const { calls } = fakeExec();
    const r = await new X11Backend(deps()).type('-rf سلام');
    expect(r.method).toBe('type');
    expect(calls[0]!.args).toEqual(['type', '--delay', '25', '--clearmodifiers', '--', '-rf سلام']);
    expect(calls[0]!.opts?.env?.LC_ALL).toBe('C.UTF-8');
    // An already-UTF-8 locale is left alone.
    const { calls: c2 } = fakeExec();
    await new X11Backend(deps({ env: { DISPLAY: ':0', LANG: 'fa_IR.UTF-8' } })).type('x');
    expect(c2[0]!.opts?.env?.LC_ALL).toBeUndefined();
  });

  it('falls back to clipboard paste when typing Persian fails, restoring the clipboard', async () => {
    const { calls } = fakeExec(c => {
      if (c.cmd === 'xdotool' && c.args[0] === 'type') return { code: 1, stderr: 'Invalid multi-byte sequence encountered' };
      if (c.cmd === 'xclip' && c.args.includes('-o')) return { stdout: 'previous' };
    });
    const r = await new X11Backend(deps()).type('سلام دنیا');
    expect(r.method).toBe('paste');
    const seq = calls.map(c => `${c.cmd} ${c.args.join(' ')}${c.opts?.stdin !== undefined ? ` <${c.opts.stdin}` : ''}`);
    expect(seq).toEqual([
      'xdotool type --delay 25 --clearmodifiers -- سلام دنیا',
      'xclip -selection clipboard -o',
      'xclip -selection clipboard <سلام دنیا',
      'xdotool key --clearmodifiers --delay 40 ctrl+v',
      'xclip -selection clipboard <previous',
    ]);
  });

  it('presses keys with repeat', async () => {
    const { calls } = fakeExec();
    await new X11Backend(deps()).key('cmd+s', { repeat: 2 });
    expect(calls[0]!.args).toEqual(['key', '--clearmodifiers', '--delay', '40', 'super+s', 'super+s']);
  });

  it('screenshots with scrot and downscales with ImageMagick (scale returned)', async () => {
    const dest = path.join(tmp, 'shot.png');
    const { calls } = fakeExec(async c => {
      if (c.cmd === 'scrot') await fs.writeFile(c.args[0]!, png(2560, 1440));
      if (c.cmd === 'magick') await fs.writeFile(c.args[0]!, png(1600, 900));
    });
    const shot = await new X11Backend(deps()).screenshot({ path: dest, maxWidth: 1600 });
    expect(calls.map(c => [c.cmd, ...c.args])).toEqual([
      ['scrot', dest],
      ['magick', dest, '-resize', '1600x', dest],
    ]);
    expect(shot).toMatchObject({ path: dest, width: 1600, height: 900, scale: 0.625, origin: { x: 0, y: 0 } });
  });

  it('notes when no scaler exists', async () => {
    const dest = path.join(tmp, 'shot.png');
    fakeExec(async c => { if (c.cmd === 'import') await fs.writeFile(c.args[2]!, png(2560, 1440)); }, ['scrot', 'magick', 'convert']);
    const shot = await new X11Backend(deps()).screenshot({ path: dest, maxWidth: 1600 });
    expect(shot.scale).toBe(1);
    expect(shot.notes.join(' ')).toMatch(/Not downscaled.*imagemagick/i);
  });

  it('captures a window with import and reports its origin', async () => {
    const dest = path.join(tmp, 'win.png');
    const wm = '0x03a00003  0 4242   100  50   800  600  host Mozilla Firefox\n0x01e00007  0 999    0    0    640  480  host Terminal\n';
    const { calls } = fakeExec(async c => {
      if (c.cmd === 'wmctrl') return { stdout: wm };
      if (c.cmd === 'ps') return { stdout: ' 4242 firefox\n  999 gnome-terminal\n' };
      if (c.cmd === 'xdotool' && c.args[0] === 'getactivewindow') return { stdout: '30408711\n' };
      if (c.cmd === 'import') await fs.writeFile(c.args[2]!, png(800, 600));
    });
    const shot = await new X11Backend(deps()).screenshot({ path: dest, window: 'firefox' });
    const imp = calls.find(c => c.cmd === 'import')!;
    expect(imp.args).toEqual(['-window', String(0x03a00003), dest]);
    expect(shot.origin).toEqual({ x: 100, y: 50 });
    expect(shot.window?.app).toBe('firefox');
  });

  it('lists windows via wmctrl + ps and marks the focused one', async () => {
    fakeExec(c => {
      if (c.cmd === 'wmctrl') return { stdout: '0x01e00007  0 999    10   20   640  480  host Terminal — zsh\n0x0000000a -1 0 0 0 10 10 N/A Desktop\n' };
      if (c.cmd === 'ps') return { stdout: '  999 gnome-terminal\n' };
      if (c.cmd === 'xdotool' && c.args[0] === 'getactivewindow') return { stdout: String(0x01e00007) };
    });
    const wins = await new X11Backend(deps()).listWindows();
    expect(wins[0]).toEqual({
      id: String(0x01e00007), title: 'Terminal — zsh', pid: 999, app: 'gnome-terminal',
      bounds: { x: 10, y: 20, width: 640, height: 480 }, focused: true,
    });
    expect(wins[1]!.focused).toBe(false);
  });

  it('focuses the best match with windowactivate', async () => {
    const { calls } = fakeExec(c => {
      if (c.cmd === 'wmctrl') return { stdout: '0x01e00007  0 999  0 0 640 480 host Inbox - Thunderbird\n' };
    });
    const w = await new X11Backend(deps()).focusWindow('thunderbird');
    expect(w.title).toBe('Inbox - Thunderbird');
    expect(calls.find(c => c.args[0] === 'windowactivate')!.args).toEqual(['windowactivate', String(0x01e00007)]);
  });

  it('WINDOW_NOT_FOUND lists open windows', async () => {
    fakeExec(c => { if (c.cmd === 'wmctrl') return { stdout: '0x1  0 1  0 0 10 10 host Calculator\n' }; });
    await expect(new X11Backend(deps()).focusWindow('photoshop')).rejects.toThrow(/\[WINDOW_NOT_FOUND\].*Calculator/);
  });

  it('clipboard via xclip (empty clipboard → "")', async () => {
    const { calls } = fakeExec(c => { if (c.args.includes('-o')) return { code: 1, stderr: 'Error: target STRING not available' }; });
    const b = new X11Backend(deps());
    expect(await b.clipboardGet()).toBe('');
    await b.clipboardSet('hi');
    expect(calls[1]).toMatchObject({ cmd: 'xclip', args: ['-selection', 'clipboard'], opts: { stdin: 'hi' } });
  });

  it('clipboard missing → [COMPUTER_USE_UNAVAILABLE] with install hint', async () => {
    fakeExec(undefined, ['xclip', 'xsel']);
    await expect(new X11Backend(deps()).clipboardGet()).rejects.toThrow('[COMPUTER_USE_UNAVAILABLE] x11: missing xclip|xsel. Install: sudo apt install xclip');
  });

  it('opens URLs with xdg-open and apps via .desktop entries', async () => {
    const appDir = path.join(tmp, 'applications');
    await fs.mkdir(appDir);
    await fs.writeFile(path.join(appDir, 'org.gnome.Calculator.desktop'), '[Desktop Entry]\nName=Calculator\nExec=gnome-calculator %U\nType=Application\n');
    const { calls, spawned } = fakeExec(undefined, ['gtk-launch']);
    const b = new X11Backend(deps({ desktopEntryDirs: [appDir] }));
    expect(await b.openApp('https://example.com')).toMatch(/xdg-open/);
    expect(await b.openApp('calculator')).toMatch(/Launched Calculator/);
    expect(spawned).toEqual([
      { cmd: 'xdg-open', args: ['https://example.com'] },
      { cmd: 'gnome-calculator', args: [] },
    ]);
    expect(calls).toEqual([]);
    // gtk-launch preferred when present
    const f2 = fakeExec();
    await new X11Backend(deps({ desktopEntryDirs: [appDir] })).openApp('Calculator');
    expect(f2.calls.map(c => [c.cmd, ...c.args])).toEqual([['gtk-launch', 'org.gnome.Calculator']]);
  });

  it('parses wmctrl, .desktop files and Exec lines', () => {
    expect(parseWmctrl('0x0280000a  0 1234  1 2 3 4 box My Title here')[0]).toMatchObject({ id: String(0x0280000a), title: 'My Title here', pid: 1234 });
    expect(parseDesktopEntry('[Desktop Entry]\nName=Foo\nExec=foo --x\nNoDisplay=true\n[Desktop Action new]\nName=Bar\n')).toEqual({ name: 'Foo', exec: 'foo --x', hidden: true });
    expect(splitExec('"/opt/My App/app" --flag %F %%')).toEqual(['/opt/My App/app', '--flag', '%']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('macOS backend', () => {
  const mac = (over: Partial<BackendDeps> = {}) => new MacosBackend(deps({ env: { HOME: '/Users/me' }, platform: 'darwin', ...over }));

  it('Retina: scale = screenshot px / logical screen width', async () => {
    const dest = path.join(tmp, 'retina.png');
    const { calls } = fakeExec(async c => {
      if (c.cmd === 'screencapture') await fs.writeFile(c.args[c.args.length - 1]!, png(2880, 1800));
      if (c.cmd === 'osascript' && c.args[1] === 'JavaScript' && /NSScreen/.test(c.args[3]!)) return { stdout: '{"width":1440,"height":900}\n' };
    });
    const shot = await mac().screenshot({ path: dest });
    expect(calls[0]).toMatchObject({ cmd: 'screencapture', args: ['-x', dest] });
    expect(shot).toMatchObject({ width: 2880, height: 1800, scale: 2, origin: { x: 0, y: 0 } });
  });

  it('Retina + downscale with sips: scale = new width / logical width', async () => {
    const dest = path.join(tmp, 'retina.png');
    const { calls } = fakeExec(async c => {
      if (c.cmd === 'screencapture') await fs.writeFile(dest, png(2880, 1800));
      if (c.cmd === 'osascript') return { stdout: '{"width":1440,"height":900}' };
      if (c.cmd === 'sips') await fs.writeFile(dest, png(1600, 1000));
    });
    const shot = await mac().screenshot({ path: dest, maxWidth: 1600 });
    expect(calls.find(c => c.cmd === 'sips')!.args).toEqual(['--resampleWidth', '1600', dest, '--out', dest]);
    expect(shot.width).toBe(1600);
    expect(shot.scale).toBeCloseTo(1600 / 1440, 6);
  });

  it('falls back to Finder desktop bounds for the logical size', async () => {
    fakeExec(c => {
      if (c.args[0] === '-l') return { code: 1, stderr: 'execution error' };
      if (c.cmd === 'osascript') return { stdout: '0, 0, 1512, 982\n' };
    });
    expect(await mac().screenSize()).toEqual({ width: 1512, height: 982 });
  });

  it('window capture uses the CGWindowID and the window origin', async () => {
    const dest = path.join(tmp, 'w.png');
    const { calls } = fakeExec(async c => {
      if (c.cmd === 'osascript' && /CGWindowListCopyWindowInfo/.test(c.args[3] ?? '')) {
        return { stdout: '{"id":4711,"app":"Safari","title":"Apple","x":100,"y":40,"width":800,"height":600}' };
      }
      if (c.cmd === 'screencapture') await fs.writeFile(dest, png(1600, 1200));
    });
    const shot = await mac().screenshot({ path: dest, window: 'safari' });
    expect(calls.find(c => c.cmd === 'screencapture')!.args).toEqual(['-x', '-o', '-l4711', dest]);
    expect(shot).toMatchObject({ scale: 2, origin: { x: 100, y: 40 } });
    expect(shot.window?.app).toBe('Safari');
  });

  it('clicks with cliclick (incl. negative coordinates) and falls back to CoreGraphics', async () => {
    const { calls } = fakeExec();
    await mac().click(100, 50);
    await mac().click(-20, 5, { count: 2 });
    await mac().click(1, 2, { button: 'right' });
    expect(calls.map(c => c.args)).toEqual([['c:100,50'], ['dc:=-20,5'], ['rc:1,2']]);
    const f2 = fakeExec(undefined, ['cliclick']);
    await mac().click(10, 20, { count: 2 });
    expect(f2.calls[0]!.cmd).toBe('osascript');
    expect(f2.calls[0]!.args.slice(0, 3)).toEqual(['-l', 'JavaScript', '-e']);
    const script = f2.calls[0]!.args[3]!;
    expect(script).toContain("ObjC.import('CoreGraphics')");
    expect(script).toContain('post(1, 10, 20, 0, 1);');
    expect(script).toContain('post(2, 10, 20, 0, 2);');
  });

  it('drag and scroll post CoreGraphics events', () => {
    const drag = jxaMouseScript([{ t: 'drag', x1: 0, y1: 0, x2: 100, y2: 0, steps: 4, pauseMs: 80 }]);
    expect(drag).toContain('post(1, 0, 0, 0, 1);');
    expect(drag).toContain('post(6, 50, 0, 0, 1);');
    expect(drag).toContain('post(2, 100, 0, 0, 1);');
    const scroll = jxaMouseScript([{ t: 'scroll', dx: 0, dy: 2, at: { x: 5, y: 6 } }]);
    expect(scroll).toContain('post(5, 5, 6, 0, 0);');
    expect(scroll).toContain('wheel(-6, 0);');
    expect(scroll).toContain('CGEventCreateScrollWheelEvent');
  });

  it('types Persian by pasting (cmd+v) and restores the clipboard', async () => {
    const { calls } = fakeExec(c => { if (c.cmd === 'pbpaste') return { stdout: 'old' }; });
    const r = await mac().type('سلام دنیا');
    expect(r.method).toBe('paste');
    expect(calls.map(c => c.cmd)).toEqual(['pbpaste', 'pbcopy', 'osascript', 'pbcopy']);
    expect(calls[1]!.opts?.stdin).toBe('سلام دنیا');
    expect(calls[1]!.opts?.env?.LC_ALL).toBe('en_US.UTF-8');
    expect(calls[2]!.args[1]).toContain('keystroke "v" using {command down}');
    expect(calls[3]!.opts?.stdin).toBe('old');
  });

  it('types ASCII with cliclick t:, pressing Enter between lines', async () => {
    const { calls } = fakeExec();
    await mac().type('ab\ncd');
    expect(calls.map(c => [c.cmd, c.args[0]!.slice(0, 40)])).toEqual([
      ['cliclick', 't:ab'],
      ['osascript', '-e'],
      ['cliclick', 't:cd'],
    ]);
    expect(calls[1]!.args[1]).toContain('key code 36');
  });

  it('opens apps / paths / URLs', async () => {
    const { calls } = fakeExec();
    await mac().openApp('Safari');
    await mac().openApp('https://example.com');
    await mac().openApp('~/Documents');
    expect(calls.map(c => [c.cmd, ...c.args])).toEqual([
      ['open', '-a', 'Safari'],
      ['open', 'https://example.com'],
      ['open', '/Users/me/Documents'],
    ]);
  });

  it('adds the permission hint to Accessibility errors', async () => {
    fakeExec(() => ({ code: 1, stderr: 'execution error: osascript is not allowed assistive access. (-25211)' }));
    await expect(mac().key('cmd+s')).rejects.toThrow(/Accessibility and Screen Recording/);
  });

  it('parses window lines from System Events', () => {
    const wins = parseMacWindowLines('Safari\tApple\t0\t25\t1200\t800\ttrue\t501\nFinder\tmissing value\t\t\t\t\tfalse\t300\n');
    expect(wins[0]).toEqual({ app: 'Safari', title: 'Apple', focused: true, bounds: { x: 0, y: 25, width: 1200, height: 800 }, pid: 501 });
    expect(wins[1]).toEqual({ app: 'Finder', title: '', focused: false, pid: 300 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Windows backend', () => {
  const win = () => new WindowsBackend(deps({ env: {}, platform: 'win32' }));
  const script = (c: { opts?: ExecOptions }) => decodePowerShellStdin(c.opts!.stdin!)!;

  it('runs `powershell -NoProfile -NonInteractive -Command -` with a base64 UTF-8 loader on stdin', async () => {
    const { calls } = fakeExec();
    await win().click(10, 20);
    expect(calls[0]!.cmd).toBe('powershell');
    expect(calls[0]!.args).toEqual(['-NoProfile', '-NonInteractive', '-Command', '-']);
    expect(PS_ARGS).toEqual(calls[0]!.args);
    const stdin = calls[0]!.opts!.stdin!;
    expect(stdin.split('\n').filter(Boolean)).toHaveLength(1); // a single line — no multi-line parsing quirks
    expect(stdin).toMatch(/^\[Console\]::OutputEncoding/);
    const s = script(calls[0]!);
    expect(s).toContain('SetProcessDPIAware');
    expect(s).toContain('[void][QodexDesktop]::SetCursorPos(10, 20)');
    expect(s).toContain('[QodexDesktop]::mouse_event([uint32]0x2, 0, 0, 0, [UIntPtr]::Zero)');
    expect(s).toContain('[QodexDesktop]::mouse_event([uint32]0x4, 0, 0, 0, [UIntPtr]::Zero)');
  });

  it('escapes SendKeys specials', () => {
    expect(escapeSendKeys('a+b^c%d~e(f)g{h}i[j]k\nl\tm')).toBe('a{+}b{^}c{%}d{~}e{(}f{)}g{{}h{}}i{[}j{]}k{ENTER}l{TAB}m');
    expect(escapeSendKeys('x\r\ny')).toBe('x{ENTER}y');
    expect(psQuote("it's ‘q’")).toBe("'it''s ‘‘q’’'");
  });

  it('types ASCII with SendKeys and Unicode via the clipboard', async () => {
    const { calls } = fakeExec();
    await win().type("Hi (there) it's 100%");
    expect(script(calls[0]!)).toContain("[System.Windows.Forms.SendKeys]::SendWait('Hi {(}there{)} it''s 100{%}')");
    const f2 = fakeExec();
    const r = await win().type('سلام دنیا');
    expect(r.method).toBe('paste');
    const s = script(f2.calls[0]!);
    expect(s).toContain("[System.Windows.Forms.Clipboard]::SetText('سلام دنیا')");
    expect(s).toContain("SendWait('^v')");
    expect(s).toMatch(/SetText\(\$oldText\)/);
  });

  it('scroll uses WHEEL / HWHEEL deltas', async () => {
    const { calls } = fakeExec();
    await win().scroll(0, 3, { x: 1, y: 2 });
    await win().scroll(-2, 0);
    expect(script(calls[0]!)).toContain('mouse_event([uint32]0x800, 0, 0, -360, [UIntPtr]::Zero)');
    expect(script(calls[0]!)).toContain('SetCursorPos(1, 2)');
    expect(script(calls[1]!)).toContain('mouse_event([uint32]0x1000, 0, 0, -240, [UIntPtr]::Zero)');
  });

  it('screenshot returns the scale computed by System.Drawing', async () => {
    const dest = path.join(tmp, 's.png');
    const { calls } = fakeExec(() => ({ stdout: '\uFEFF{"width":1600,"height":900,"srcWidth":2560,"x":0,"y":0}\r\n' }));
    const shot = await win().screenshot({ path: dest, maxWidth: 1600 });
    expect(shot).toMatchObject({ width: 1600, height: 900, scale: 0.625, origin: { x: 0, y: 0 } });
    const s = script(calls[0]!);
    expect(s).toContain('CopyFromScreen');
    expect(s).toContain('$maxW = 1600');
    expect(s).toContain(psQuote(dest));
  });

  it('surfaces PowerShell errors with their [CODE]', async () => {
    fakeExec(() => ({ code: 1, stderr: "[COMPUTER_USE_ERROR] windows: no app, command or Start-menu shortcut named 'zzz'." }));
    await expect(win().openApp('zzz')).rejects.toThrow(/^\[COMPUTER_USE_ERROR\] windows: no app/);
    fakeExec(() => ({ code: 1, stderr: 'Exception calling "SetText"' }));
    await expect(win().clipboardSet('x')).rejects.toThrow(/^\[COMPUTER_USE_ERROR\] windows: powershell exited 1/);
  });

  it('round-trips the stdin loader and parses window JSON', () => {
    expect(decodePowerShellStdin(powershellStdin('Write-Output "سلام"'))).toBe('Write-Output "سلام"');
    expect(parseWindowsJson('{"id":"123","title":"Untitled - Notepad","app":"notepad","pid":42,"x":0,"y":0,"width":800,"height":600}')[0])
      .toMatchObject({ id: '123', app: 'notepad', bounds: { width: 800 } });
    expect(parseWindowsJson('[]')).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Wayland backend', () => {
  const wl = (env: NodeJS.ProcessEnv = { WAYLAND_DISPLAY: 'wayland-0' }) => new WaylandBackend(deps({ env }));

  it('clicks via ydotool absolute move + click codes', async () => {
    const { calls } = fakeExec();
    await wl().click(10, 20);
    await wl().click(1, 2, { button: 'right', count: 2 });
    expect(calls.map(c => c.args)).toEqual([
      ['mousemove', '--absolute', '-x', '10', '-y', '20'],
      ['click', '0xC0'],
      ['mousemove', '--absolute', '-x', '1', '-y', '2'],
      ['click', '--repeat', '2', '--next-delay', '80', '0xC1'],
    ]);
  });

  it('drags with a relative move while the button is held', async () => {
    const { calls } = fakeExec();
    await wl().drag(10, 10, 110, 60);
    expect(calls.map(c => c.args)).toEqual([
      ['mousemove', '--absolute', '-x', '10', '-y', '10'],
      ['click', '0x40'],
      ['mousemove', '-x', '100', '-y', '50'],
      ['click', '0x80'],
    ]);
  });

  it('scrolls with wheel events (down = negative REL_WHEEL)', async () => {
    const { calls } = fakeExec();
    await wl().scroll(0, 3);
    await wl().scroll(2, 0);
    expect(calls.map(c => c.args)).toEqual([
      ['mousemove', '--wheel', '-x', '0', '-y', '-3'],
      ['mousemove', '--wheel', '-x', '2', '-y', '0'],
    ]);
  });

  it('pastes non-ASCII text through wl-copy', async () => {
    const { calls } = fakeExec(c => { if (c.cmd === 'wl-paste') return { stdout: 'prev' }; });
    expect((await wl().type('سلام')).method).toBe('paste');
    expect(calls.map(c => `${c.cmd} ${c.args.join(' ')}`)).toEqual([
      'wl-paste --no-newline',
      'wl-copy ',
      'ydotool key 29:1 47:1 47:0 29:0',
      'wl-copy ',
    ]);
    expect(calls[1]!.opts?.stdin).toBe('سلام');
    expect(calls[3]!.opts?.stdin).toBe('prev');
  });

  it('types ASCII with ydotool type', async () => {
    const { calls } = fakeExec();
    await wl().type('hello');
    expect(calls[0]!.args).toEqual(['type', '--key-delay', '25', '--', 'hello']);
  });

  it('explains the ydotool 0.1.x CLI', async () => {
    fakeExec(() => ({ code: 1, stderr: "mousemove: unrecognized option '--absolute'" }));
    await expect(wl().move(1, 2)).rejects.toThrow(/ydotool >= 1\.0/);
  });

  it('window tools are unsupported without sway / Hyprland', async () => {
    fakeExec(undefined, ['swaymsg', 'hyprctl']);
    await expect(wl().listWindows()).rejects.toThrow(/^\[COMPUTER_USE_UNSUPPORTED\] wayland:/);
    await expect(wl().focusWindow('x')).rejects.toThrow(/COMPUTER_USE_UNSUPPORTED/);
    const av = await wl().available();
    expect(av.ok).toBe(true);
    expect(av.notes.join('\n')).toMatch(/windows: not exposed/);
  });

  it('lists + focuses sway windows', async () => {
    const tree = JSON.stringify({
      type: 'root', nodes: [{ type: 'output', nodes: [{ type: 'workspace', nodes: [
        { type: 'con', id: 7, name: 'Inbox — Mozilla Thunderbird', app_id: 'thunderbird', pid: 10, focused: false, rect: { x: 0, y: 0, width: 960, height: 1080 } },
        { type: 'con', id: 9, name: 'foot', app_id: 'foot', pid: 11, focused: true, rect: { x: 960, y: 0, width: 960, height: 1080 } },
      ] }] }],
    });
    const { calls } = fakeExec(c => { if (c.cmd === 'swaymsg' && c.args.includes('get_tree')) return { stdout: tree }; }, ['hyprctl']);
    const b = wl({ WAYLAND_DISPLAY: 'wayland-1', SWAYSOCK: '/run/sway.sock' });
    expect((await b.activeWindow())!.app).toBe('foot');
    await b.focusWindow('thunderbird');
    expect(calls[calls.length - 1]!.args).toEqual(['[con_id=7]', 'focus']);
    expect(parseSwayTree(tree)).toHaveLength(2);
  });

  it('parses Hyprland clients', () => {
    const wins = parseHyprClients(JSON.stringify([{ address: '0xabc', at: [5, 6], size: [100, 200], class: 'kitty', title: 'zsh', pid: 3, focusHistoryID: 0 }]));
    expect(wins[0]).toEqual({ id: '0xabc', title: 'zsh', app: 'kitty', pid: 3, bounds: { x: 5, y: 6, width: 100, height: 200 }, focused: true });
  });

  it('reports missing ydotool / screenshot tools', async () => {
    fakeExec(undefined, ['ydotool', 'grim', 'gnome-screenshot', 'spectacle']);
    const av = await wl().available();
    expect(av.ok).toBe(false);
    expect(av.missing).toEqual(['ydotool', 'grim|gnome-screenshot|spectacle']);
    expect(av.hint).toMatch(/^sudo apt install ydotool grim; then start the daemon/);
  });
});
