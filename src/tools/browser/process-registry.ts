/**
 * Background process registry.
 *
 * Owns long-running processes (dev servers, watchers, build daemons) so the
 * agent can:
 *
 *   - Start a process detached from the foreground (npm run dev, php -S, vite, etc)
 *   - Read its stdout/stderr without blocking
 *   - Send it stdin (rare)
 *   - Stop it cleanly when done
 *
 * This is DIFFERENT from the bash tool, which runs commands to completion.
 * A dev server never completes — it sits and serves until killed.
 *
 * Per-session, processes are tracked by a user-supplied `name`. Re-starting
 * with the same name kills the old one first. Process exit hooks ensure
 * we don't leak servers if QodeX itself dies.
 *
 * Output buffers are capped (last 200KB per process) to avoid OOM on chatty
 * servers (looking at you, webpack-dev-server progress logs).
 */

import { spawn, type ChildProcess } from 'child_process';
import { logger } from '../../utils/logger.js';

const MAX_BUFFER_BYTES = 200_000;

interface ManagedProcess {
  name: string;
  command: string;
  cwd: string;
  startedAt: number;
  pid: number;
  child: ChildProcess;
  stdout: string;
  stderr: string;
  /** Combined log used for "tail" output regardless of stream. */
  combined: string;
  exitCode: number | null;
  exitSignal: string | null;
}

const processes = new Map<string, ManagedProcess>();

/** Truncate a buffer from the front, keeping the tail. */
function appendCapped(buf: string, chunk: string): string {
  const combined = buf + chunk;
  if (combined.length <= MAX_BUFFER_BYTES) return combined;
  // Drop the oldest 25% to avoid copying on every single line of output.
  const keepFrom = Math.floor(MAX_BUFFER_BYTES * 0.75);
  return '…[earlier output truncated]…\n' + combined.slice(combined.length - keepFrom);
}

export interface StartOptions {
  name: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  /** If a process with the same name is already running, kill it first. */
  replace?: boolean;
}

export interface ProcessInfo {
  name: string;
  command: string;
  cwd: string;
  pid: number;
  uptimeMs: number;
  exitCode: number | null;
  exitSignal: string | null;
  stdoutBytes: number;
  stderrBytes: number;
  alive: boolean;
}

export class DevServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DevServerError';
  }
}

export async function start(opts: StartOptions): Promise<ProcessInfo> {
  const existing = processes.get(opts.name);
  if (existing && existing.exitCode === null) {
    if (opts.replace) {
      await stop(opts.name);
    } else {
      throw new DevServerError(`Process '${opts.name}' is already running (pid ${existing.pid}). Pass replace=true to restart it.`);
    }
  }
  // Use shell: true so things like "npm run dev" and "php -S localhost:8000 -t public" work as-is.
  const child = spawn(opts.command, {
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, ...(opts.env ?? {}) },
    shell: true,
    detached: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (!child.pid) {
    throw new DevServerError(`Failed to spawn '${opts.command}'`);
  }

  const proc: ManagedProcess = {
    name: opts.name,
    command: opts.command,
    cwd: opts.cwd ?? process.cwd(),
    startedAt: Date.now(),
    pid: child.pid,
    child,
    stdout: '',
    stderr: '',
    combined: '',
    exitCode: null,
    exitSignal: null,
  };
  child.stdout?.on('data', (data: Buffer) => {
    const str = data.toString('utf-8');
    proc.stdout = appendCapped(proc.stdout, str);
    proc.combined = appendCapped(proc.combined, str);
  });
  child.stderr?.on('data', (data: Buffer) => {
    const str = data.toString('utf-8');
    proc.stderr = appendCapped(proc.stderr, str);
    proc.combined = appendCapped(proc.combined, str);
  });
  child.on('exit', (code, signal) => {
    proc.exitCode = code;
    proc.exitSignal = signal;
    logger.info(`Process '${opts.name}' exited`, { pid: proc.pid, code, signal });
  });
  child.on('error', (err) => {
    logger.warn(`Process '${opts.name}' error`, { err: err.message });
  });
  processes.set(opts.name, proc);
  logger.info(`Started process '${opts.name}'`, { pid: child.pid, command: opts.command });
  return infoFor(proc);
}

export function list(): ProcessInfo[] {
  return Array.from(processes.values()).map(infoFor);
}

export function get(name: string): ManagedProcess | undefined {
  return processes.get(name);
}

export async function stop(name: string, signalArg: NodeJS.Signals = 'SIGTERM'): Promise<boolean> {
  const proc = processes.get(name);
  if (!proc) return false;
  if (proc.exitCode !== null) return true; // already exited
  try {
    proc.child.kill(signalArg);
    // Wait up to 5s for graceful exit, then SIGKILL
    const exited = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 5000);
      proc.child.once('exit', () => {
        clearTimeout(timeout);
        resolve(true);
      });
    });
    if (!exited) {
      logger.warn(`Process '${name}' did not exit on ${signalArg}; sending SIGKILL`);
      proc.child.kill('SIGKILL');
    }
    return true;
  } catch (e: any) {
    logger.warn(`Failed to stop '${name}': ${e?.message}`);
    return false;
  }
}

export async function stopAll(): Promise<void> {
  await Promise.all(Array.from(processes.keys()).map(name => stop(name)));
}

export function tailLog(name: string, source: 'stdout' | 'stderr' | 'combined' = 'combined', maxBytes = 4000): string {
  const proc = processes.get(name);
  if (!proc) return `[no such process: ${name}]`;
  const buf = source === 'stdout' ? proc.stdout : source === 'stderr' ? proc.stderr : proc.combined;
  return buf.length > maxBytes ? buf.slice(buf.length - maxBytes) : buf;
}

export function sendInput(name: string, data: string): boolean {
  const proc = processes.get(name);
  if (!proc || proc.exitCode !== null) return false;
  proc.child.stdin?.write(data);
  return true;
}

function infoFor(proc: ManagedProcess): ProcessInfo {
  return {
    name: proc.name,
    command: proc.command,
    cwd: proc.cwd,
    pid: proc.pid,
    uptimeMs: Date.now() - proc.startedAt,
    exitCode: proc.exitCode,
    exitSignal: proc.exitSignal,
    stdoutBytes: proc.stdout.length,
    stderrBytes: proc.stderr.length,
    alive: proc.exitCode === null,
  };
}

// Cleanup on QodeX exit
process.on('exit', () => {
  for (const proc of processes.values()) {
    if (proc.exitCode === null) {
      try { proc.child.kill('SIGTERM'); } catch { /* ignore */ }
    }
  }
});
process.on('SIGINT', () => {
  for (const proc of processes.values()) {
    if (proc.exitCode === null) {
      try { proc.child.kill('SIGTERM'); } catch { /* ignore */ }
    }
  }
});
