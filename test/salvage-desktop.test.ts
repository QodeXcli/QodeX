/**
 * Desktop control — fixes salvaged from a desktop reviewer's stranded working
 * tree (b5a8e06) that HEAD did not already have in another form:
 *   - X11 full-screen capture uses the first screenshot tool that WORKS, not
 *     the first one installed (a broken scrot no longer blocks `import`).
 * Fakes only (setDesktopExec) — no real input.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, existsSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { setDesktopExec, type ExecOptions, type ExecResult } from '../src/tools/computer/exec.js';
import { X11Backend, type BackendDeps } from '../src/tools/computer/backends/index.js';

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
