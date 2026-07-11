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
 * These tests spawn the REAL CLI (src/index.ts via tsx) with HOME pointed at a temp dir,
 * so they exercise the actual commander wiring end-to-end. Each spawn is ~15s on a slow
 * machine, hence the generous timeouts and only two representative subcommands (one
 * --model, one --json) — the other three share the identical mechanism and fix.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFile } from 'child_process';
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
});
