/**
 * Regression test for the global-option collision in the CLI entrypoint.
 *
 * The root command defines `-m, --model` and `--json`. Under commander's default
 * (non-positional) parsing, the PARENT swallows those flags even when they're written
 * AFTER a subcommand that defines the same flag: `qodex schedule add --model x` used to
 * leave the subcommand's opts empty (the value landed in program.opts() and was silently
 * dropped). Affected: `offload --model`, `provider add --model`, `schedule add --model`,
 * `tokens --json`, `schedule tick --json`. Fixed via cmd.optsWithGlobals() in each action.
 *
 * The autonomy-contract root `--scope <path-prefix>` later re-introduced the same class
 * of bug against `mcp serve --scope <safe|all>` — security-relevant, because a swallowed
 * `--scope safe` silently falls back to config exposure (write-capable tools could leak
 * under config expose 'all'). The serve test below speaks real MCP over stdio.
 *
 * These tests spawn the REAL CLI (src/index.ts via tsx) with HOME pointed at a temp dir,
 * so they exercise the actual commander wiring end-to-end. Each spawn is ~15s on a slow
 * machine, hence the generous timeouts and only two representative subcommands (one
 * --model, one --json) — the other three share the identical mechanism and fix.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const ENTRY = path.join(ROOT, 'src', 'index.ts');

const tempHomes: string[] = [];
function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qodex-cli-flags-'));
  tempHomes.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempHomes) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

async function runCli(home: string, args: string[]) {
  return execFileAsync(process.execPath, [TSX, ENTRY, ...args], {
    env: { ...process.env, HOME: home, QODEX_SKIP_SETUP: '1' },
    timeout: 110_000,
  });
}

describe('CLI global-option collision (flags after a subcommand)', () => {
  it('schedule add --model pins the model (not swallowed by root -m/--model)', async () => {
    const home = makeTempHome();
    const { stdout } = await runCli(home, [
      'schedule', 'add',
      '--name', 'pin-test',
      '--cron', '@daily',
      '--prompt', 'hello',
      '--model', 'my-pinned-model',
    ]);
    expect(stdout).toContain('Scheduled "pin-test"');

    const Database = (await import('better-sqlite3')).default;
    const db = new Database(path.join(home, '.qodex', 'sessions.db'), { readonly: true });
    try {
      const row = db.prepare('SELECT model FROM schedules WHERE name = ?').get('pin-test') as { model: string | null };
      expect(row.model).toBe('my-pinned-model');
    } finally {
      db.close();
    }
  }, 120_000);

  it('schedule tick --json emits JSON (not swallowed by root --json)', async () => {
    const home = makeTempHome(); // fresh home: empty schedule DB, so nothing is due to run
    const { stdout } = await runCli(home, ['schedule', 'tick', '--json']);
    const lastLine = stdout.trim().split('\n').at(-1) ?? '';
    // Before the fix this printed the human summary "tick: ran=0, ..." instead of JSON.
    const parsed = JSON.parse(lastLine);
    expect(parsed).toHaveProperty('ranIds');
    expect(parsed).toHaveProperty('acquired');
  }, 120_000);

  it('mcp serve --scope all exposes write tools (not swallowed by root --scope)', async () => {
    const home = makeTempHome();
    // Fresh cwd so bootstrap's project-local .qodex/ lands in a temp dir, not the repo.
    const cwd = makeTempHome();
    const child = spawn(process.execPath, [TSX, ENTRY, 'mcp', 'serve', '--scope', 'all'], {
      env: { ...process.env, HOME: home, QODEX_SKIP_SETUP: '1' },
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      // The pipe buffers this until the server attaches its stdin reader.
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
      const reply = await new Promise<any>((resolve, reject) => {
        let out = '';
        let err = '';
        const timer = setTimeout(
          () => reject(new Error(`no tools/list reply; stderr tail: ${err.slice(-500)}`)),
          110_000,
        );
        child.stderr.on('data', (d) => { err += String(d); });
        child.stdout.on('data', (d) => {
          out += String(d);
          for (const line of out.split('\n')) {
            if (!line.trim()) continue;
            try {
              const msg = JSON.parse(line);
              if (msg.id === 1) { clearTimeout(timer); resolve(msg); return; }
            } catch { /* partial line — keep buffering */ }
          }
        });
        child.on('error', (e) => { clearTimeout(timer); reject(e); });
        child.on('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`server exited early (code ${code}); stderr tail: ${err.slice(-500)}`));
        });
      });
      const names = (reply.result.tools as Array<{ name: string }>).map(t => t.name);
      // Default config exposure is 'safe' (read-only). Before the fix the root
      // --scope <path-prefix> swallowed the value, serve's opts arrived empty, and the
      // server fell back to 'safe' — so write-capable tools were MISSING despite
      // --scope all. (Mirror-image of the security failure: --scope safe under config
      // expose 'all' exposed write tools. Same flag, same delivery path.)
      expect(names).toContain('write_file');
      expect(names).toContain('shell');
      expect(names).toContain('read_file'); // sanity: list isn't degenerate
    } finally {
      child.removeAllListeners('exit');
      child.kill();
    }
  }, 120_000);
});
