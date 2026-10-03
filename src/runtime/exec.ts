/**
 * Run a shell command on the configured backend (local or docker).
 * Streaming callbacks are optional; the returned buffers are always capped.
 */

import crossSpawn from 'cross-spawn';
import { spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import { childEnv } from '../secrets/sanitize.js';
import { logger } from '../utils/logger.js';
import { buildDockerRunArgs, dockerArgsAreSafe, resolveDockerConfig } from './docker-args.js';
import type {
  DockerRuntimeConfig,
  ExecRequest,
  ExecResult,
  ExecutionRuntime,
  RuntimeBackend,
  RuntimeConfig,
} from './types.js';

const MAX_OUTPUT_BYTES = 60_000;

function collect(
  backend: RuntimeBackend,
  bin: string,
  args: string[],
  req: ExecRequest,
  spawnOpts: { cwd?: string; shell?: boolean },
): Promise<ExecResult> {
  return new Promise(resolve => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;

    const proc = crossSpawn(bin, args, {
      cwd: spawnOpts.cwd,
      env: childEnv({ FORCE_COLOR: '0' }),
      shell: spawnOpts.shell ?? false,
      signal: req.signal,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGTERM'); } catch { /* */ }
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* */ } }, 2000);
    }, req.timeoutMs);

    proc.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutBytes < MAX_OUTPUT_BYTES) {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      } else {
        truncated = true;
      }
      for (const line of chunk.toString('utf-8').split('\n')) {
        if (line) req.onStdoutLine?.(line);
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes < MAX_OUTPUT_BYTES) {
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
      } else {
        truncated = true;
      }
      for (const line of chunk.toString('utf-8').split('\n')) {
        if (line) req.onStderrLine?.(line);
      }
    });

    proc.on('error', err => {
      clearTimeout(timer);
      const notFound = (err as NodeJS.ErrnoException).code === 'ENOENT';
      resolve({
        code: null,
        signal: null,
        stdout: '',
        stderr: err.message,
        timedOut: false,
        truncated: false,
        backend,
        unavailable: notFound
          ? `${bin} not found`
          : err.message,
      });
    });

    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal: signal ?? null,
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
        timedOut,
        truncated,
        backend,
      });
    });
  });
}

export function localRuntime(): ExecutionRuntime {
  return {
    backend: 'local',
    exec(req) {
      return collect('local', req.command, [], req, { cwd: req.cwd, shell: true });
    },
  };
}

export function dockerRuntime(docker?: Partial<DockerRuntimeConfig>): ExecutionRuntime {
  const cfg = resolveDockerConfig(docker);
  return {
    backend: 'docker',
    async exec(req) {
      const name = `qodex-rt-${randomBytes(4).toString('hex')}`;
      const args = buildDockerRunArgs({
        hostCwd: req.cwd,
        command: req.command,
        name,
        docker: cfg,
      });
      if (!dockerArgsAreSafe(args)) {
        return {
          code: null, signal: null, stdout: '', stderr: '',
          timedOut: false, truncated: false, backend: 'docker',
          unavailable: 'refusing docker argv that would expose the host control plane',
        };
      }
      logger.info('Runtime: docker exec', { image: cfg.image, network: cfg.network, name });

      const onAbort = () => {
        try { spawnSync('docker', ['kill', name], { stdio: 'ignore' }); } catch { /* */ }
      };
      if (req.signal) {
        if (req.signal.aborted) onAbort();
        else req.signal.addEventListener('abort', onAbort, { once: true });
      }
      try {
        return await collect('docker', 'docker', args, req, { shell: false });
      } finally {
        req.signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}

export function resolveRuntime(cfg?: { runtime?: RuntimeConfig } | null): ExecutionRuntime {
  const backend = cfg?.runtime?.backend === 'docker' ? 'docker' : 'local';
  return backend === 'docker' ? dockerRuntime(cfg?.runtime?.docker) : localRuntime();
}

export function formatExecResult(cmd: string, r: ExecResult): { content: string; isError: boolean } {
  if (r.unavailable) {
    const hint = r.backend === 'docker'
      ? 'Install Docker or set runtime.backend: local.'
      : '';
    return {
      content: `[SANDBOX_UNAVAILABLE] runtime.backend is ${r.backend} but the command could not start: ${r.unavailable}${hint ? ` ${hint}` : ''}`,
      isError: true,
    };
  }
  const parts: string[] = [];
  if (r.backend === 'docker') parts.push('[runtime:docker]');
  parts.push(`$ ${cmd}`);
  if (r.stdout.trim()) parts.push(r.stdout.trim());
  if (r.stderr.trim()) parts.push(`[stderr]\n${r.stderr.trim()}`);
  if (r.truncated) parts.push(`[output truncated at ~${MAX_OUTPUT_BYTES} bytes]`);
  if (r.signal) {
    parts.push(`[killed by signal: ${r.signal}${r.timedOut || r.signal === 'SIGTERM' ? ` (likely timeout)` : ''}]`);
  } else {
    parts.push(`[exit code: ${r.code}]`);
  }
  return { content: parts.join('\n'), isError: r.code !== 0 || r.timedOut };
}
