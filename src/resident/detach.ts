/**
 * Leave the resident running after this terminal closes.
 * The child is a real process. There is no cloud stand-in.
 */
import { spawn, type SpawnOptions } from 'child_process';
import { openSync } from 'fs';

export function residentChildArgs(argv: string[]): string[] {
  return argv.filter(a => a !== '--detach');
}

export function hangupPolicy(env: NodeJS.ProcessEnv = process.env): 'ignore' | 'default' {
  return env.QODEX_RESIDENT_DETACHED === '1' ? 'ignore' : 'default';
}

export function spawnResident(opts: {
  args: string[];
  logPath: string;
  execPath?: string;
  script?: string;
  spawnFn?: (cmd: string, args: string[], options: SpawnOptions) => { pid?: number; unref: () => void };
}): number {
  const fd = openSync(opts.logPath, 'a');
  const cmd = opts.execPath ?? process.execPath;
  const script = opts.script ?? process.argv[1];
  if (!script) throw new Error('detach needs the qodex script path');
  const child = (opts.spawnFn ?? spawn)(cmd, [script, ...opts.args], {
    detached: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, QODEX_RESIDENT_DETACHED: '1' },
    windowsHide: true,
  });
  child.unref();
  if (!child.pid) throw new Error('detach did not return a pid');
  return child.pid;
}
