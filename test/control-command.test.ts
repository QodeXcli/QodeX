/**
 * `qodex control` runs in the foreground until Ctrl+C. The real CLI imports the
 * tool registry at startup, and process-registry installs a SIGINT listener that
 * does NOT exit — which silently disabled Ctrl+C for this command. This runs the
 * command in a child process with such a listener already installed and checks
 * that Ctrl+C (SIGINT) still stops it and frees the port.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const commandModule = pathToFileURL(path.resolve(here, '../src/control/command.ts')).href;
let tsxLoader = '';
try { tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href; } catch { tsxLoader = ''; }

const children: ChildProcess[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const c of children.splice(0)) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

function waitFor<T>(fn: () => T | null | undefined, ms: number): Promise<T | null> {
  return new Promise(resolve => {
    const t0 = Date.now();
    const tick = () => {
      const v = fn();
      if (v) return resolve(v);
      if (Date.now() - t0 > ms) return resolve(null);
      setTimeout(tick, 50);
    };
    tick();
  });
}

describe('qodex control (foreground process)', () => {
  it.skipIf(!tsxLoader)('stops on Ctrl+C even when another module already listens for SIGINT', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-ctl-cmd-'));
    dirs.push(tmp);
    const script = path.join(tmp, 'run-control.mts');
    await fs.writeFile(script, [
      "// Same as src/tools/browser/process-registry.ts (imported by the CLI at startup): a SIGINT listener that never exits.",
      "process.on('SIGINT', () => { process.stdout.write('[other SIGINT listener ran]\\n'); });",
      `const { buildControlCommand } = await import(${JSON.stringify(commandModule)});`,
      "await buildControlCommand().parseAsync(['--port', '0'], { from: 'user' });",
    ].join('\n'));

    const env: Record<string, string | undefined> = { ...process.env, HOME: tmp, USERPROFILE: tmp, QODEX_CONTROL_TOKEN: undefined, FORCE_COLOR: '0' };
    delete env.QODEX_CONTROL_TOKEN;
    const child = spawn(process.execPath, ['--import', tsxLoader, script], { cwd: tmp, env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let out = '';
    child.stdout!.on('data', (c: Buffer) => { out += c.toString(); });
    child.stderr!.on('data', (c: Buffer) => { out += c.toString(); });
    let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    child.on('exit', (code, signal) => { exit = { code, signal }; });

    const url = await waitFor(() => /http:\/\/127\.0\.0\.1:\d+\/\?k=[A-Za-z0-9._~-]+/.exec(out)?.[0], 45_000);
    expect(url, out).toBeTruthy();
    const u = new URL(url!);
    const token = u.searchParams.get('k')!;
    const state = await fetch(`${u.origin}/api/state`, { headers: { authorization: `Bearer ${token}` } });
    expect(state.status).toBe(200);

    child.kill('SIGINT');
    const ended = await waitFor(() => exit, 15_000);
    expect(ended, `still running after SIGINT; output:\n${out}`).toBeTruthy();
    expect(ended!.code).toBe(130);
    // The server is gone with it.
    await expect(fetch(`${u.origin}/api/state`, { headers: { authorization: `Bearer ${token}` } })).rejects.toThrow();
  }, 90_000);
});
