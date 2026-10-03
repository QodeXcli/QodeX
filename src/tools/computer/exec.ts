/**
 * Command runner shared by every desktop-control backend (macOS, X11, Wayland,
 * Windows).
 *
 * All native input/screenshot work is done by spawning small OS tools
 * (`xdotool`, `screencapture`, `powershell`, ...). Routing every spawn through
 * this module gives us one place to:
 *   - never throw for a non-zero exit (callers decide what a failure means),
 *   - bound runtime (timeouts) and honor an AbortSignal,
 *   - survive helpers that daemonize and keep our pipes open (`xclip`, `wl-copy`
 *     fork a child that serves the clipboard — we resolve shortly after the
 *     direct child exits instead of waiting for the pipes to close),
 *   - and swap the whole thing for a fake in tests: `setDesktopExec(fake)`.
 *     Tests NEVER drive real input; they assert the exact argv the backends
 *     would run.
 *
 * `which()` scans PATH itself (honoring PATHEXT on Windows) instead of
 * spawning `which`, which doesn't exist on Windows.
 */

import { spawn, type ChildProcess } from 'child_process';
import { promises as fs, constants as fsConstants } from 'fs';
import * as path from 'path';

export interface ExecResult {
  stdout: string;
  stderr: string;
  /** Exit code. 124 = timed out, 127 = command not found, 130 = aborted. */
  code: number;
  timedOut?: boolean;
}

export interface ExecOptions {
  /** Written to the child's stdin (UTF-8), then stdin is closed. */
  stdin?: string;
  /** Kill the child after this long. Default 15s. 0 = no timeout. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  signal?: AbortSignal;
  /** Cap captured stdout/stderr (bytes each). Default 8 MiB. */
  maxOutputBytes?: number;
}

export interface SpawnDetachedOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export type RunFn = (cmd: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;
export type WhichFn = (cmd: string) => Promise<string | null>;
export type SpawnDetachedFn = (cmd: string, args: string[], opts?: SpawnDetachedOptions) => Promise<void>;

export interface DesktopExec {
  run: RunFn;
  which: WhichFn;
  spawnDetached: SpawnDetachedFn;
}

/**
 * A test fake. Only `run` is required:
 *   - missing `which` → every binary is "installed" at /usr/bin/<cmd>,
 *   - missing `spawnDetached` → routed through `run` (so it is recorded, never
 *     really spawned).
 */
export interface DesktopExecFake {
  run: RunFn;
  which?: WhichFn;
  spawnDetached?: SpawnDetachedFn;
}

export const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT = 8 * 1024 * 1024;
/** How long to wait for pipes to close after the direct child exited. */
const EXIT_GRACE_MS = 250;

let fake: DesktopExec | null = null;

/** Dependency-injection hook used by tests (and only tests). `null` restores the real runner. */
export function setDesktopExec(f: DesktopExecFake | null): void {
  if (!f) { fake = null; return; }
  const run = f.run;
  fake = {
    run,
    which: f.which ?? (async (cmd: string) => `/usr/bin/${cmd}`),
    spawnDetached: f.spawnDetached ?? (async (cmd, args, opts) => { await run(cmd, args, { env: opts?.env, cwd: opts?.cwd }); }),
  };
}

/** True while a fake runner is installed (lets callers skip real-fs-only work). */
export function isDesktopExecFaked(): boolean {
  return fake !== null;
}

/** Run a command and capture its output. Never rejects. */
export function runCommand(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  if (fake) return fake.run(cmd, args, opts);
  return realRunCommand(cmd, args, opts);
}

/** Locate an executable on PATH. Returns its absolute path, or null. */
export function which(cmd: string): Promise<string | null> {
  if (fake) return fake.which(cmd);
  return realWhich(cmd);
}

/** Start a GUI program that must outlive us (an app, a browser for a URL). */
export function spawnDetached(cmd: string, args: string[], opts: SpawnDetachedOptions = {}): Promise<void> {
  if (fake) return fake.spawnDetached(cmd, args, opts);
  return realSpawnDetached(cmd, args, opts);
}

/** First command of `cmds` that exists on PATH (in order), or null. */
export async function firstAvailable(cmds: readonly string[]): Promise<string | null> {
  for (const c of cmds) {
    if (await which(c)) return c;
  }
  return null;
}

/** Which of `cmds` are missing from PATH. */
export async function missingCommands(cmds: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of cmds) {
    if (!(await which(c))) out.push(c);
  }
  return out;
}

/**
 * `env` with a UTF-8 locale. Several tools (xdotool type, pbcopy) mangle or
 * reject non-ASCII text — e.g. Persian — when the process locale is C/POSIX,
 * which is common for daemons, cron and IDE-spawned processes.
 */
export function utf8Env(env: NodeJS.ProcessEnv = process.env, fallback = 'C.UTF-8'): NodeJS.ProcessEnv {
  const current = env.LC_ALL || env.LC_CTYPE || env.LANG || '';
  if (/utf-?8/i.test(current)) return env;
  return { ...env, LC_ALL: fallback };
}

/** One-line, length-bounded description of a failed command for error messages. */
export function describeFailure(cmd: string, r: ExecResult): string {
  const detail = (r.stderr.trim() || r.stdout.trim()).replace(/\s+/g, ' ').slice(0, 400);
  if (r.timedOut) return `${cmd} timed out`;
  if (r.code === 127) return `${cmd} not found (${detail || 'not on PATH'})`;
  if (r.code === 130 && /aborted/i.test(r.stderr)) return `${cmd} aborted`;
  return `${cmd} exited ${r.code}${detail ? `: ${detail}` : ''}`;
}

// ── real implementations ─────────────────────────────────────────────────────

export function realRunCommand(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve) => {
    const maxBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let exitCode: number | null = null;
    let killTimer: NodeJS.Timeout | null = null;
    let graceTimer: NodeJS.Timeout | null = null;
    let child: ChildProcess | null = null;

    const onAbort = () => {
      aborted = true;
      try { child?.kill('SIGTERM'); } catch { /* already gone */ }
      // Escalate if the child ignores SIGTERM.
      setTimeout(() => { try { child?.kill('SIGKILL'); } catch { /* gone */ } }, 1000).unref();
    };

    const finish = (code: number, extraErr = '') => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (graceTimer) clearTimeout(graceTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      // A daemonized grandchild (xclip, wl-copy) may still hold our pipes —
      // release them so this process can exit.
      try { child?.stdout?.destroy(); } catch { /* ignore */ }
      try { child?.stderr?.destroy(); } catch { /* ignore */ }
      let stderr = Buffer.concat(err).toString('utf-8');
      if (extraErr) stderr = stderr ? `${stderr}\n${extraErr}` : extraErr;
      let finalCode = code;
      if (timedOut) { finalCode = 124; stderr = stderr ? `${stderr}\ntimed out after ${timeoutMs}ms` : `timed out after ${timeoutMs}ms`; }
      else if (aborted) { finalCode = 130; stderr = stderr ? `${stderr}\naborted` : 'aborted'; }
      resolve({ stdout: Buffer.concat(out).toString('utf-8'), stderr, code: finalCode, ...(timedOut ? { timedOut: true } : {}) });
    };

    if (opts.signal?.aborted) {
      resolve({ stdout: '', stderr: 'aborted', code: 130 });
      return;
    }

    try {
      child = spawn(cmd, args, {
        env: opts.env ?? process.env,
        cwd: opts.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e: any) {
      resolve({ stdout: '', stderr: String(e?.message ?? e), code: e?.code === 'ENOENT' ? 127 : 126 });
      return;
    }

    child.on('error', (e: NodeJS.ErrnoException) => {
      finish(e.code === 'ENOENT' ? 127 : 126, e.message);
    });
    child.stdout?.on('data', (d: Buffer) => {
      if (outBytes >= maxBytes) return;
      outBytes += d.length;
      out.push(outBytes > maxBytes ? d.subarray(0, d.length - (outBytes - maxBytes)) : d);
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (errBytes >= maxBytes) return;
      errBytes += d.length;
      err.push(errBytes > maxBytes ? d.subarray(0, d.length - (errBytes - maxBytes)) : d);
    });
    child.on('exit', (code, sig) => {
      exitCode = code ?? (sig ? 128 + (sig === 'SIGKILL' ? 9 : 15) : 1);
      graceTimer = setTimeout(() => finish(exitCode ?? 1), EXIT_GRACE_MS);
    });
    child.on('close', (code, sig) => {
      finish(code ?? exitCode ?? (sig ? 128 + (sig === 'SIGKILL' ? 9 : 15) : 1));
    });

    if (timeoutMs > 0) {
      killTimer = setTimeout(() => {
        timedOut = true;
        try { child?.kill('SIGKILL'); } catch { /* gone */ }
        // If even SIGKILL doesn't produce 'close' (pipes held), settle anyway.
        setTimeout(() => finish(124), 500);
      }, timeoutMs);
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdin?.on('error', () => { /* EPIPE when the child exits early — ignore */ });
    if (opts.stdin !== undefined) child.stdin?.end(opts.stdin, 'utf-8');
    else child.stdin?.end();
  });
}

function pathExts(): string[] {
  if (process.platform !== 'win32') return [''];
  const raw = process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD';
  return ['', ...raw.split(';').filter(Boolean).map(e => e.toLowerCase())];
}

async function isExecutableFile(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    if (!st.isFile()) return false;
    if (process.platform === 'win32') return true;
    await fs.access(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function realWhich(cmd: string): Promise<string | null> {
  if (!cmd) return null;
  const exts = pathExts();
  const hasExt = process.platform === 'win32' && /\.[a-z0-9]+$/i.test(cmd);
  if (cmd.includes('/') || (process.platform === 'win32' && cmd.includes('\\'))) {
    for (const ext of hasExt ? [''] : exts) {
      if (await isExecutableFile(cmd + ext)) return path.resolve(cmd + ext);
    }
    return null;
  }
  const dirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of hasExt ? [''] : exts) {
      const candidate = path.join(dir.replace(/^"|"$/g, ''), cmd + ext);
      if (await isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

export function realSpawnDetached(cmd: string, args: string[], opts: SpawnDetachedOptions = {}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        env: opts.env ?? process.env,
        cwd: opts.cwd,
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
    } catch (e: any) {
      reject(new Error(`${cmd}: ${e?.message ?? e}`));
      return;
    }
    child.once('error', (e) => reject(new Error(`${cmd}: ${e.message}`)));
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
