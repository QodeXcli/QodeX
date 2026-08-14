import { describe, it, expect } from 'vitest';
import * as path from 'path';
import {
  buildDockerRunArgs,
  dockerArgsAreSafe,
  resolveDockerConfig,
  DEFAULT_SANDBOX_IMAGE,
} from '../src/runtime/docker-args.js';
import { formatExecResult, localRuntime, resolveRuntime } from '../src/runtime/exec.js';

describe('docker sandbox argv', () => {
  const host = '/work/app';

  it('bind-mounts the project and defaults to no network', () => {
    const args = buildDockerRunArgs({ hostCwd: host, command: 'npm test', name: 'qodex-rt-x' });
    expect(args.slice(0, 3)).toEqual(['run', '--rm', '-i']);
    expect(args).toContain(`${host}:/workspace`);
    expect(args).toContain('--network');
    expect(args[args.indexOf('--network') + 1]).toBe('none');
    expect(args).toContain('--cap-drop');
    expect(args[args.indexOf('--cap-drop') + 1]).toBe('ALL');
    expect(args.at(-4)).toBe(DEFAULT_SANDBOX_IMAGE);
    expect(args.slice(-3)).toEqual(['sh', '-lc', 'npm test']);
  });

  it('never exposes docker.sock, host net, or privileged', () => {
    const args = buildDockerRunArgs({ hostCwd: host, command: 'true', name: 'n' });
    expect(dockerArgsAreSafe(args)).toBe(true);
    expect(args.join(' ')).not.toMatch(/docker\.sock/);
    expect(args).not.toContain('--privileged');
    expect(args.join(' ')).not.toMatch(/\/Users\//);
    expect(args.join(' ')).not.toMatch(/\/home\//);
  });

  it('uses the configured image and can open the network', () => {
    const args = buildDockerRunArgs({
      hostCwd: host,
      command: 'curl example.com',
      name: 'n',
      docker: { image: 'python:3.12', network: 'bridge' },
    });
    expect(args).toContain('python:3.12');
    expect(args[args.indexOf('--network') + 1]).toBe('bridge');
  });

  it('rejects a relative host cwd before docker sees it', () => {
    // path.resolve makes it absolute — the helper always returns absolute
    const abs = path.resolve('rel');
    const args = buildDockerRunArgs({ hostCwd: 'rel', command: 'true', name: 'n' });
    expect(args.join('\n')).toContain(abs);
    expect(path.isAbsolute(args[args.indexOf('-v') + 1]!.split(':')[0]!)).toBe(true);
  });
});

describe('resolveRuntime', () => {
  it('defaults to local', () => {
    expect(resolveRuntime().backend).toBe('local');
    expect(resolveRuntime({ runtime: { backend: 'local' } }).backend).toBe('local');
  });
  it('selects docker when configured', () => {
    expect(resolveRuntime({ runtime: { backend: 'docker' } }).backend).toBe('docker');
  });
  it('fills docker defaults', () => {
    expect(resolveDockerConfig(undefined).image).toBe(DEFAULT_SANDBOX_IMAGE);
    expect(resolveDockerConfig({ network: 'bridge' }).network).toBe('bridge');
  });
});

describe('local runtime', () => {
  it('runs a command in the given cwd', async () => {
    const r = await localRuntime().exec({ command: 'echo sandbox-ok', cwd: process.cwd(), timeoutMs: 5000 });
    expect(r.backend).toBe('local');
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/sandbox-ok/);
  });
});

describe('formatExecResult', () => {
  it('marks a missing docker backend clearly', () => {
    const { content, isError } = formatExecResult('ls', {
      code: null, signal: null, stdout: '', stderr: '',
      timedOut: false, truncated: false, backend: 'docker', unavailable: 'docker not found',
    });
    expect(isError).toBe(true);
    expect(content).toMatch(/SANDBOX_UNAVAILABLE/);
    expect(content).toMatch(/runtime\.backend: local/);
  });
});
