/**
 * Tiny git invocation helper. Returns structured results (exitCode + stdout + stderr).
 * Honors AbortSignal so the agent loop's per-tool abort kills the git process cleanly.
 *
 * We always pass `--no-pager` and `-c color.ui=false` so output is deterministic and parseable.
 * We also pass `-C <cwd>` so the caller's cwd is honored regardless of how spawn resolved it.
 */
import { spawn } from 'cross-spawn';
import { logger } from '../../utils/logger.js';

export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface GitOptions {
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Optional stdin content (used by `git commit -F -` style invocations). */
  stdin?: string;
}

export async function git(args: string[], opts: GitOptions): Promise<GitResult> {
  const fullArgs = [
    '-C', opts.cwd,
    '--no-pager',
    '-c', 'color.ui=false',
    ...args,
  ];
  const timeoutMs = opts.timeoutMs ?? 60_000;

  return new Promise<GitResult>((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn('git', fullArgs, {
        signal: opts.signal,
        stdio: [opts.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
    } catch (e: any) {
      resolve({
        exitCode: 127,
        stdout: '',
        stderr: `git spawn failed: ${e.message}`,
        timedOut: false,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const settle = (r: GitResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      resolve(r);
    };

    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    if (opts.stdin !== undefined && proc.stdin) {
      proc.stdin.write(opts.stdin);
      proc.stdin.end();
    }

    const termTimer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGTERM'); } catch {}
    }, timeoutMs);
    const killTimer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
    }, timeoutMs + 2000);

    proc.on('close', (code, signal) => {
      const exitCode = code ?? (signal === 'SIGTERM' ? 124 : signal === 'SIGKILL' ? 137 : 130);
      settle({ exitCode, stdout, stderr, timedOut });
    });
    proc.on('error', (e: any) => {
      // ENOENT (git not installed) is the most common case
      if (e?.code === 'ENOENT') {
        settle({ exitCode: 127, stdout: '', stderr: 'git not found in PATH', timedOut: false });
        return;
      }
      logger.warn('git invocation error', { err: e?.message });
      settle({ exitCode: e?.code ?? 1, stdout, stderr: (stderr + '\n' + (e?.message ?? '')).trim(), timedOut: false });
    });
  });
}

/**
 * Run git, return stdout on success or throw a useful error including stderr.
 * For tools that want a clean exception flow rather than checking exitCode.
 */
export async function gitOrThrow(args: string[], opts: GitOptions): Promise<string> {
  const r = await git(args, opts);
  if (r.exitCode !== 0) {
    const msg = (r.stderr || r.stdout || `git ${args.join(' ')} exited ${r.exitCode}`).trim();
    throw new Error(msg);
  }
  return r.stdout;
}

/** Quick check: is this directory inside a git repo? */
export async function isGitRepo(cwd: string, signal?: AbortSignal): Promise<boolean> {
  const r = await git(['rev-parse', '--is-inside-work-tree'], { cwd, signal, timeoutMs: 5000 });
  return r.exitCode === 0 && r.stdout.trim() === 'true';
}
