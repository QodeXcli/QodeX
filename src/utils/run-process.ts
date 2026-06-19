import crossSpawn from 'cross-spawn';

/**
 * Shared helper for tools that wrap an external CLI (docker, ffmpeg, aws, gh, …).
 *
 * Why this exists: every CLI-wrapping tool needs the same things — spawn without
 * a shell (so args aren't re-parsed / injected), capture stdout+stderr, enforce a
 * timeout with a real kill, cap output size, and turn a missing binary (ENOENT)
 * into a clear "<bin> not installed" result instead of an opaque throw. Centralizing
 * it keeps every tool consistent and means the "command not found" UX is identical
 * everywhere (same pattern the browser tools use for a missing Chromium).
 *
 * No shell is used: args are passed as an array. This is deliberate — these tools
 * take structured args, not free-form command strings (that's what the `shell`
 * tool is for, with its own permission gate).
 */

export interface RunProcessOptions {
  /** Working directory. Defaults to process.cwd(). */
  cwd?: string;
  /** Extra env vars merged over process.env. */
  env?: Record<string, string>;
  /** Max wall-clock time in ms before SIGTERM (then SIGKILL). Default 120_000. */
  timeoutMs?: number;
  /** Cap on captured stdout+stderr bytes. Default ~256KB. */
  maxOutputBytes?: number;
  /** Optional stdin to write to the child. */
  stdin?: string;
}

export interface RunProcessResult {
  /** Exit code, or null if killed by signal/timeout. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** True if the process was killed because it exceeded timeoutMs. */
  timedOut: boolean;
  /** True if the binary itself was not found (ENOENT). */
  notFound: boolean;
  /** Convenience: code === 0 && !timedOut && !notFound. */
  ok: boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT = 256 * 1024;

/**
 * Spawn `bin` with `args`, no shell, capturing output with a hard timeout.
 * Never throws for ordinary failures (non-zero exit, timeout, missing binary) —
 * those are reported in the result so the calling tool can format a clean message.
 */
export function runProcess(
  bin: string,
  args: string[],
  opts: RunProcessOptions = {},
): Promise<RunProcessResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutput = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;

  return new Promise<RunProcessResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;

    const child = crossSpawn(bin, args, {
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, ...(opts.env ?? {}) },
      shell: false,
    });

    const finish = (r: Omit<RunProcessResult, 'ok'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...r, ok: r.code === 0 && !r.timedOut && !r.notFound });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // Escalate if it ignores SIGTERM.
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, 3000);
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutBytes < maxOutput) {
        stdout += chunk.toString('utf8');
        stdoutBytes += chunk.length;
        if (stdoutBytes >= maxOutput) stdout += '\n…[output truncated]';
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes < maxOutput) {
        stderr += chunk.toString('utf8');
        stderrBytes += chunk.length;
        if (stderrBytes >= maxOutput) stderr += '\n…[output truncated]';
      }
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      // ENOENT = binary not installed / not on PATH.
      if (err.code === 'ENOENT') {
        finish({ code: null, stdout, stderr, timedOut: false, notFound: true });
      } else {
        finish({ code: null, stdout, stderr: stderr + `\n[spawn error: ${err.message}]`, timedOut, notFound: false });
      }
    });

    child.on('close', (code) => {
      finish({ code, stdout, stderr, timedOut, notFound: false });
    });

    if (opts.stdin !== undefined) {
      child.stdin?.write(opts.stdin);
      child.stdin?.end();
    }
  });
}

/**
 * Standard "binary not installed" message body for a tool result, so every
 * CLI-wrapping tool surfaces the same clear guidance instead of a stack trace.
 */
export function notInstalledMessage(bin: string, installHint: string): string {
  return `\`${bin}\` is not installed or not on PATH.\n${installHint}`;
}
