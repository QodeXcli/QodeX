/**
 * `qodex control` — run the Control Center in the foreground and print its private
 * link(s). The page shows THIS process's browser: take over + enter a URL to open
 * the agent's persistent browser profile (e.g. to log in to a site once so the agent
 * can reuse the session), watch it live, and answer approvals raised in-process.
 * (The TUI's `/control` and mission workers start their own control center for
 * their own browser/approvals; that wiring lives in the integration step.)
 *
 * No bootstrap(): this command loads ~/.qodex/.env + config and calls
 * setActiveConfig itself, and never imports the agent loop. It does install ONE
 * SIGINT listener, and that listener always exits: the CLI entry (src/index.ts)
 * statically imports the tool registry, whose process-registry module adds a
 * non-exiting SIGINT listener — without ours Ctrl+C would be ignored here.
 *
 * Note: the root program owns `-p/--print`, `--json`, `-m`, `-y`, `-r`, `-c`, and
 * commander parses those anywhere on the line, so this subcommand deliberately has
 * no short flags and reads `--json` through optsWithGlobals().
 */

import { Command } from 'commander';
import type { ControlCenterOptions, SteerHandler } from './server.js';

/** Upper bound for a graceful stop (control center + browser profile flush). */
const STOP_TIMEOUT_MS = 6000;

export interface ControlCommandDeps {
  /**
   * Runs after config is loaded and before the server starts — the integration uses
   * it to register control actions (e.g. `missions.list` / `missions.cancel` backed
   * by the mission DB) so the dashboard's Missions panel works from this process.
   */
  setup?: () => void | Promise<void>;
  /** How steering notes are delivered. Default: none (no agent runs in this process). */
  onSteer?: SteerHandler;
}

interface ControlCliOptions {
  port?: string;
  host?: string;
  lan?: boolean;
  tunnel?: boolean;
  title?: string;
  lang?: string;
}

/** Parse/validate the CLI flags into server options. PURE (exported for tests). */
export function controlOptionsFromCli(opts: ControlCliOptions): { ok: true; options: ControlCenterOptions } | { ok: false; error: string } {
  const out: ControlCenterOptions = {};
  if (opts.port !== undefined) {
    const n = Number(opts.port);
    if (!/^\d+$/.test(String(opts.port).trim()) || !Number.isInteger(n) || n < 0 || n > 65535) {
      return { ok: false, error: `[INVALID_PORT] --port must be 0-65535 (got "${opts.port}")` };
    }
    out.port = n;
  }
  if (opts.host !== undefined) {
    const h = String(opts.host).trim();
    if (!h || /[\s/]/.test(h)) return { ok: false, error: `[INVALID_HOST] --host must be an address such as 127.0.0.1 or 0.0.0.0 (got "${opts.host}")` };
    out.host = h;
  }
  if (opts.lang !== undefined) {
    const l = String(opts.lang).trim().toLowerCase();
    if (l !== 'en' && l !== 'fa') return { ok: false, error: `[INVALID_LANG] --lang must be en or fa (got "${opts.lang}")` };
    out.lang = l;
  }
  if (opts.title !== undefined && String(opts.title).trim()) out.title = String(opts.title).trim();
  if (opts.lan) out.lan = true;
  if (opts.tunnel) out.tunnel = true;
  return { ok: true, options: out };
}

export function buildControlCommand(deps: ControlCommandDeps = {}): Command {
  const cmd = new Command('control');
  cmd
    .description('Open the QodeX Control Center: a private web page to watch the agent\'s browser live, take over, answer approvals and steer (always token-protected)')
    .option('--port <port>', 'Port to listen on (default: config control.port = 7420; a free port is used when it is busy)')
    .option('--host <host>', 'Bind address (default: config control.host = 127.0.0.1)')
    .option('--lan', 'Also serve on your local network (binds 0.0.0.0); the link still requires its token')
    .option('--tunnel', 'Also open a public link through cloudflared or ngrok; the link still requires its token')
    .option('--title <title>', 'Dashboard title')
    .option('--lang <lang>', 'Dashboard language: en | fa (default: the viewer\'s browser language)')
    .action(async (opts: ControlCliOptions, command: Command) => {
      const globals = (typeof command?.optsWithGlobals === 'function' ? command.optsWithGlobals() : {}) as { json?: boolean };
      await runControlCommand(opts, { json: !!globals.json }, deps);
    });
  return cmd;
}

async function runControlCommand(opts: ControlCliOptions, flags: { json: boolean }, deps: ControlCommandDeps): Promise<void> {
  const parsed = controlOptionsFromCli(opts);
  if (!parsed.ok) {
    console.error(`✗ ${parsed.error}`);
    process.exit(1);
  }

  // Ctrl+C / SIGTERM handling first, so they work during setup too.
  const stop = installStopHandlers();

  // Same environment as a bootstrapped run: ~/.qodex/.env (e.g. QODEX_BROWSER_EXECUTABLE)
  // then the merged config — without starting providers, MCP servers or the agent.
  try {
    const { ensureQodexHome } = await import('../config/loader.js');
    await ensureQodexHome();
  } catch { /* non-fatal: the browser manager creates what it needs */ }
  try {
    const { loadEnvFileIntoProcess } = await import('../setup/env-writer.js');
    await loadEnvFileIntoProcess();
  } catch { /* no ~/.qodex/.env */ }
  try {
    const { loadConfig, setActiveConfig } = await import('../config/loader.js');
    setActiveConfig(await loadConfig(process.cwd()));
  } catch (e) {
    console.error(`⚠ Could not load config, using defaults: ${(e as Error)?.message ?? String(e)}`);
  }

  if (deps.setup) {
    try {
      await deps.setup();
    } catch (e) {
      console.error(`⚠ Control-center setup hook failed: ${(e as Error)?.message ?? String(e)}`);
    }
  }

  const { startControlCenter, describeControlCenter } = await import('./server.js');
  let info;
  try {
    info = await startControlCenter({ ...parsed.options, onSteer: deps.onSteer ?? (() => false) });
  } catch (e) {
    console.error(`✗ Could not start the control center: ${(e as Error)?.message ?? String(e)}`);
    process.exit(1);
  }

  if (flags.json) {
    console.log(JSON.stringify(info));
  } else {
    const fa = parsed.options.lang === 'fa';
    console.log(describeControlCenter(info, fa ? 'fa' : 'en'));
    if (info.lan && !parsed.options.lan) {
      console.log(fa
        ? '   ⚠ روی همه رابط‌های شبکه گوش می‌دهد (control.host).'
        : '   ⚠ Listening on all network interfaces (control.host).');
    }
    console.log(fa
      ? '\n   این صفحه مرورگر همین پردازش را نشان می‌دهد: «گرفتن کنترل» را بزنید و آدرسی وارد کنید تا مرورگر اختصاصی QodeX (با پروفایل دائمی) باز شود.\n   برای توقف Ctrl+C بزنید (یا q و سپس Enter).'
      : '\n   This page shows the browser of THIS process: press "Take over" and enter a URL to open QodeX\'s dedicated\n   browser (persistent profile) — e.g. to log in to a site once so the agent can reuse the session.\n   Press Ctrl+C (or type q + Enter) to stop.');
  }

  // Stay in the foreground until Ctrl+C, SIGTERM or "q".
  if (process.stdin.isTTY) {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      if (/^\s*(q|quit|exit)\s*$/i.test(String(chunk))) void stop(0);
    });
    process.stdin.resume();
  }
  await new Promise<void>(() => { /* until stop() exits the process */ });
}

/**
 * Exit cleanly on Ctrl+C (130) / SIGTERM (0): stop the control center (releasing a
 * takeover it holds) and close the agent browser so its persistent profile is
 * flushed — bounded by STOP_TIMEOUT_MS. A second Ctrl+C exits at once.
 *
 * Why a SIGINT listener here at all: the CLI entry imports the tool registry,
 * whose process-registry module installs a SIGINT listener that does NOT exit —
 * with any listener present Node no longer exits on SIGINT by itself, so Ctrl+C
 * was silently ignored. This listener always exits, so it can't cause that trap.
 */
function installStopHandlers(): (code: number) => Promise<void> {
  let stopping = false;
  const stop = async (code: number) => {
    if (stopping) return;
    stopping = true;
    // Never hang on the way out (a wedged Chromium / stuck socket).
    const hard = setTimeout(() => process.exit(code), STOP_TIMEOUT_MS);
    hard.unref?.();
    try {
      const { stopControlCenter } = await import('./server.js');
      await stopControlCenter();
    } catch { /* ignore */ }
    try {
      // Close the agent browser gracefully so the persistent profile (cookies,
      // logins) is flushed to disk.
      const { peekBrowserManager } = await import('../tools/browser/types.js');
      const mgr = peekBrowserManager();
      if (mgr) await Promise.race([mgr.close(), new Promise(r => setTimeout(r, STOP_TIMEOUT_MS - 500))]);
    } catch { /* ignore */ }
    process.exit(code);
  };
  process.on('SIGINT', () => {
    if (stopping) process.exit(130);
    void stop(130);
  });
  process.once('SIGTERM', () => { void stop(0); });
  return stop;
}
