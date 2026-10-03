/**
 * Desktop command runner: real spawns of `node` (always available) for
 * stdout/stderr/exit codes, stdin, env, timeouts, aborts and daemonizing
 * children; PATH lookup; and the setDesktopExec fake routing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  runCommand,
  which,
  spawnDetached,
  setDesktopExec,
  utf8Env,
  describeFailure,
  realRunCommand,
  isDesktopExecFaked,
} from '../src/tools/computer/exec.js';

const NODE = process.execPath;

afterEach(() => setDesktopExec(null));

describe('runCommand (real)', () => {
  it('captures stdout, stderr and the exit code without throwing', async () => {
    const r = await runCommand(NODE, ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)']);
    expect(r).toMatchObject({ stdout: 'out', stderr: 'err', code: 3 });
  });

  it('writes stdin as UTF-8 (Persian survives)', async () => {
    const r = await runCommand(NODE, ['-e', 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(s.toUpperCase()))'], { stdin: 'abc سلام' });
    expect(r.stdout).toBe('ABC سلام');
    expect(r.code).toBe(0);
  });

  it('passes env', async () => {
    const r = await runCommand(NODE, ['-e', 'process.stdout.write(process.env.QX_T || "")'], { env: { ...process.env, QX_T: 'v1' } });
    expect(r.stdout).toBe('v1');
  });

  it('times out with code 124', async () => {
    const r = await runCommand(NODE, ['-e', 'setTimeout(()=>{}, 10000)'], { timeoutMs: 300 });
    expect(r.code).toBe(124);
    expect(r.timedOut).toBe(true);
    expect(describeFailure('node', r)).toBe('node timed out');
  }, 10_000);

  it('aborts with code 130', async () => {
    const ac = new AbortController();
    const p = runCommand(NODE, ['-e', 'setTimeout(()=>{}, 10000)'], { signal: ac.signal, timeoutMs: 0 });
    setTimeout(() => ac.abort(), 100);
    const r = await p;
    expect(r.code).toBe(130);
    expect(r.stderr).toMatch(/aborted/);
  }, 10_000);

  it('missing command → code 127', async () => {
    const r = await runCommand('qodex-definitely-not-a-command', []);
    expect(r.code).toBe(127);
    expect(describeFailure('qodex-definitely-not-a-command', r)).toMatch(/not found/);
  });

  it.skipIf(process.platform === 'win32')('returns soon after the child exits even if a daemonized grandchild keeps the pipes (xclip/wl-copy)', async () => {
    const script = [
      'const { spawn } = require("child_process");',
      'spawn(process.execPath, ["-e", "setTimeout(()=>{}, 4000)"], { stdio: ["ignore", "inherit", "inherit"], detached: true }).unref();',
      'process.stdout.write("parent done");',
    ].join('\n');
    const t0 = Date.now();
    const r = await realRunCommand(NODE, ['-e', script], { timeoutMs: 8000 });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('parent done');
    expect(Date.now() - t0).toBeLessThan(3000);
  }, 10_000);
});

describe('which (real)', () => {
  it.skipIf(process.platform === 'win32')('finds executables on PATH and rejects missing ones', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-which-'));
    try {
      const bin = path.join(dir, 'qx-fake-tool');
      await fs.writeFile(bin, '#!/bin/sh\necho hi\n', { mode: 0o755 });
      await fs.writeFile(path.join(dir, 'qx-not-exec'), 'x', { mode: 0o644 });
      const prev = process.env.PATH;
      process.env.PATH = `${dir}${path.delimiter}${prev}`;
      try {
        expect(await which('qx-fake-tool')).toBe(bin);
        if (process.platform !== 'win32') expect(await which('qx-not-exec')).toBeNull();
        expect(await which('qodex-definitely-not-a-command')).toBeNull();
        expect(await which(bin)).toBe(bin);
      } finally {
        process.env.PATH = prev;
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('setDesktopExec', () => {
  it('routes run/which/spawnDetached to the fake (with safe defaults)', async () => {
    const seen: string[] = [];
    setDesktopExec({ run: async (cmd, args) => { seen.push(`${cmd} ${args.join(' ')}`); return { stdout: 'ok', stderr: '', code: 0 }; } });
    expect(isDesktopExecFaked()).toBe(true);
    expect((await runCommand('xdotool', ['getdisplaygeometry'])).stdout).toBe('ok');
    expect(await which('anything')).toBe('/usr/bin/anything');
    await spawnDetached('xdg-open', ['https://x.test']);
    expect(seen).toEqual(['xdotool getdisplaygeometry', 'xdg-open https://x.test']);
    setDesktopExec(null);
    expect(isDesktopExecFaked()).toBe(false);
  });

  it('utf8Env adds a UTF-8 locale only when missing', () => {
    expect(utf8Env({ LANG: 'C' }).LC_ALL).toBe('C.UTF-8');
    expect(utf8Env({}, 'en_US.UTF-8').LC_ALL).toBe('en_US.UTF-8');
    const env = { LANG: 'fa_IR.UTF-8' };
    expect(utf8Env(env)).toBe(env);
    expect(utf8Env({ LC_ALL: 'en_US.utf8' }).LC_ALL).toBe('en_US.utf8');
  });
});
