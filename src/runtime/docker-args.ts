/**
 * PURE docker-run argv builder. No spawn, no I/O — the sandbox contract lives here
 * so tests can pin "never mount the docker socket / host home".
 */

import * as path from 'path';
import type { DockerRuntimeConfig } from './types.js';

export const DEFAULT_SANDBOX_IMAGE = 'node:22-bookworm';
export const DEFAULT_SANDBOX_WORKDIR = '/workspace';

export function resolveDockerConfig(partial?: Partial<DockerRuntimeConfig>): DockerRuntimeConfig {
  return {
    image: partial?.image?.trim() || DEFAULT_SANDBOX_IMAGE,
    network: partial?.network === 'bridge' ? 'bridge' : 'none',
    memory: partial?.memory?.trim() || '2g',
    cpus: partial?.cpus?.trim() || '2',
    workdir: partial?.workdir?.trim() || DEFAULT_SANDBOX_WORKDIR,
    user: partial?.user?.trim() || undefined,
  };
}

/** Host path must be absolute so the bind cannot silently follow the bot's launch dir. */
export function assertAbsoluteHostCwd(hostCwd: string): string {
  const abs = path.resolve(hostCwd);
  if (!path.isAbsolute(abs)) throw new Error(`sandbox host cwd must be absolute, got ${hostCwd}`);
  return abs;
}

export function buildDockerRunArgs(opts: {
  hostCwd: string;
  command: string;
  name: string;
  docker?: Partial<DockerRuntimeConfig>;
}): string[] {
  const cfg = resolveDockerConfig(opts.docker);
  const host = assertAbsoluteHostCwd(opts.hostCwd);
  const workdir = cfg.workdir || DEFAULT_SANDBOX_WORKDIR;
  const args = [
    'run', '--rm', '-i',
    '--name', opts.name,
    '-v', `${host}:${workdir}`,
    '-w', workdir,
    '--network', cfg.network ?? 'none',
    '--memory', cfg.memory ?? '2g',
    '--cpus', cfg.cpus ?? '2',
    '--pids-limit', '256',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '-e', `HOME=${workdir}`,
    '-e', 'LANG=C.UTF-8',
    '-e', 'TERM=dumb',
  ];
  if (cfg.user) args.push('--user', cfg.user);
  args.push(cfg.image, 'sh', '-lc', opts.command);
  return args;
}

/** Guardrail: the argv we hand docker must never expose the host control plane. */
export function dockerArgsAreSafe(args: string[]): boolean {
  const joined = args.join('\n');
  if (/docker\.sock/i.test(joined)) return false;
  if (args.includes('--privileged')) return false;
  if (args.includes('--pid=host') || args.includes('--network=host')) return false;
  return true;
}
