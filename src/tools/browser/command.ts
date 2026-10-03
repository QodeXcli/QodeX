/**
 * `qodex browser …` — manage the dedicated QodeX Browser from the shell.
 *
 *   qodex browser open [url]          open the agent's browser VISIBLY with its persistent
 *                                     profile so you can log in by hand; the agent reuses
 *                                     those logins later. Enter / Ctrl+C / closing the
 *                                     window ends it (the profile is saved).
 *   qodex browser status              Playwright + executable discovery + profiles at a glance
 *   qodex browser profiles            list persistent profiles (size, last use, in use?)
 *   qodex browser reset-profile <n>   delete a profile (forget its logins) — asks first
 *   qodex browser close               stop QodeX browsers left running (e.g. after a crash)
 *                                     that still lock a profile
 *
 * No agent bootstrap: the command loads ~/.qodex/.env + config itself and sets
 * the active config so the browser manager sees `browser:` settings.
 *
 * Mount: `program.addCommand(buildBrowserCommand())` in src/index.ts.
 */

import { Command } from 'commander';
import { promises as fs } from 'fs';
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import { QODEX_BROWSER_PROFILES_DIR, QODEX_BROWSER_DOWNLOADS_DIR, browserProfileDir, sanitizeName } from '../../config/paths.js';
import { resolveBrowserConfig } from '../../config/agent-config.js';
import { getBus } from '../../control/bus.js';
import type { BrowserManager } from './types.js';

export interface BrowserCommandDeps {
  /** Profiles base dir (tests). Default ~/.qodex/browser/profiles. */
  profilesDir?: string;
  /** Downloads dir (tests). Default ~/.qodex/browser/downloads. */
  downloadsDir?: string;
  /** Browser manager to use for `open` (tests inject a fake). Default: the process manager. */
  manager?: () => Promise<BrowserManager>;
  /** Load ~/.qodex/.env + config and set it active. Tests replace it with a no-op. */
  loadConfig?: () => Promise<unknown>;
  /** Yes/no question (reset-profile). Default: readline on the TTY. */
  confirm?: (question: string) => Promise<boolean>;
  /** Wait until the user is done in `open` (Enter / Ctrl+C / window closed). */
  waitForUser?: (mgr: BrowserManager) => Promise<void>;
  /** Output sinks (tests capture). */
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** Process exit for the long-running `open` (tests pass a no-op). */
  exit?: (code: number) => void;
}

export interface ProfileLock {
  locked: boolean;
  pid?: number;
  host?: string;
  /** Lock file left behind by a crashed browser (same host, process gone). */
  stale?: boolean;
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; }
}

/** Is a Chromium user-data dir in use? Reads Chromium's SingletonLock (`<host>-<pid>`). */
export async function profileLockInfo(dir: string): Promise<ProfileLock> {
  try {
    const target = await fs.readlink(path.join(dir, 'SingletonLock'));
    const m = /^(.*)-(\d+)$/.exec(target);
    if (!m) return { locked: true };
    const host = m[1];
    const pid = Number(m[2]);
    if (host !== os.hostname()) return { locked: true, pid, host };
    const alive = isAlive(pid);
    return alive ? { locked: true, pid, host } : { locked: false, pid, host, stale: true };
  } catch { /* no SingletonLock symlink */ }
  if (process.platform === 'win32') {
    // Chromium holds `lockfile` open exclusively while running; opening it is the probe.
    try {
      const fh = await fs.open(path.join(dir, 'lockfile'), 'r+');
      await fh.close();
      return { locked: false };
    } catch (e: any) {
      if (e?.code === 'EBUSY' || e?.code === 'EPERM' || e?.code === 'EACCES') return { locked: true };
    }
  }
  return { locked: false };
}

/** Recursive size of a directory, capped so huge profiles don't stall the command. */
async function dirSize(dir: string, maxEntries = 20_000): Promise<{ bytes: number; partial: boolean }> {
  let bytes = 0;
  let seen = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: fsSync.Dirent[];
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (++seen > maxEntries) return { bytes, partial: true };
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        try { bytes += (await fs.stat(p)).size; } catch { /* vanished */ }
      }
    }
  }
  return { bytes, partial: false };
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export interface ProfileRow {
  name: string;
  dir: string;
  bytes: number;
  partialSize: boolean;
  modified: Date | null;
  lock: ProfileLock;
}

/** Persistent profiles under `base` (one directory each). */
export async function listProfiles(base: string): Promise<ProfileRow[]> {
  let names: string[] = [];
  try {
    names = (await fs.readdir(base, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name).sort();
  } catch { return []; }
  const rows: ProfileRow[] = [];
  for (const name of names) {
    const dir = path.join(base, name);
    const size = await dirSize(dir);
    let modified: Date | null = null;
    try { modified = (await fs.stat(dir)).mtime; } catch { /* ignore */ }
    rows.push({ name, dir, bytes: size.bytes, partialSize: size.partial, modified, lock: await profileLockInfo(dir) });
  }
  return rows;
}

/** Command line of a pid if it can be read (Linux /proc, else `ps`). */
function commandLineOf(pid: number): string | null {
  try {
    if (process.platform === 'linux') return fsSync.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
    if (process.platform === 'darwin' || process.platform === 'freebsd' || process.platform === 'openbsd') {
      return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 3000 });
    }
  } catch { /* gone or not permitted */ }
  return null;
}

async function defaultLoadConfig(): Promise<unknown> {
  try {
    const { loadEnvFileIntoProcess } = await import('../../setup/env-writer.js');
    await loadEnvFileIntoProcess();
  } catch { /* no .env */ }
  const { loadConfig, setActiveConfig } = await import('../../config/loader.js');
  const cfg = await loadConfig(process.cwd());
  setActiveConfig(cfg);
  return cfg;
}

async function defaultConfirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer: string = await new Promise(resolve => rl.question(`${question} [y/N] `, resolve));
    return /^(y|yes|بله|آره)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/**
 * Wait for Enter / Ctrl+C / Ctrl+D on the terminal, or for the browser window to
 * be closed. Uses raw mode on a TTY so Ctrl+C arrives as a key (no SIGINT
 * listener is installed).
 */
export function defaultWaitForUser(_mgr: BrowserManager): Promise<void> {
  return new Promise<void>(resolve => {
    const stdin = process.stdin;
    let finished = false;
    const unsub = getBus().subscribe(ev => {
      if (ev.kind === 'browser' && ev.type === 'closed') finish();
    });
    const onData = (chunk: Buffer | string) => {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (/[\r\n\x03\x04]/.test(s)) finish();
    };
    // A closed stdin (piped input that ended, </dev/null) counts as Ctrl+D.
    const onEnd = () => finish();
    const raw = !!stdin.isTTY && typeof (stdin as any).setRawMode === 'function';
    function finish(): void {
      if (finished) return;
      finished = true;
      unsub();
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      if (raw) { try { (stdin as any).setRawMode(false); } catch { /* ignore */ } }
      stdin.pause();
      resolve();
    }
    if (raw) (stdin as any).setRawMode(true);
    stdin.on('data', onData);
    stdin.once('end', onEnd);
    stdin.resume();
  });
}

export function buildBrowserCommand(deps: BrowserCommandDeps = {}): Command {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  const profilesDir = deps.profilesDir ?? QODEX_BROWSER_PROFILES_DIR;
  const downloadsDir = deps.downloadsDir ?? QODEX_BROWSER_DOWNLOADS_DIR;
  const loadCfg = deps.loadConfig ?? defaultLoadConfig;

  const getManager = async (): Promise<BrowserManager> => {
    if (deps.manager) return deps.manager();
    const { getBrowserManager, setBrowserManagerForTests } = await import('./types.js');
    if (deps.profilesDir || deps.downloadsDir) {
      const { QodexBrowserManager } = await import('./session.js');
      const m = new QodexBrowserManager({ profilesDir, downloadsDir });
      setBrowserManagerForTests(m);
      return m;
    }
    return getBrowserManager();
  };

  const cmd = new Command('browser');
  cmd.description("Manage QodeX's own browser (persistent profile, logins, downloads)");
  // `qodex browser <not a subcommand>` lands here (the root command takes a free-form
  // prompt, so a prompt starting with "browser" would otherwise fail obscurely).
  cmd
    .argument('[words...]')
    .action((words: string[]) => {
      if (!words?.length) { out(cmd.helpInformation().trimEnd()); return; }
      err(
        `Unknown browser subcommand "${words[0]}". Subcommands: open, status, profiles, reset-profile, close.\n` +
        `To give QodeX a task that starts with the word "browser", quote it: qodex "browser ${words.join(' ')}"`,
      );
      process.exitCode = 1;
    });

  cmd
    .command('open [url]')
    .description('Open the QodeX browser visibly with its profile so you can log in; the agent reuses the session')
    .option('-p, --profile <name>', 'Profile to open (default: browser.profile, normally "default")')
    .action(async (url: string | undefined, opts: { profile?: string }) => {
      const exit = deps.exit ?? ((c: number) => process.exit(c));
      const cfg = resolveBrowserConfig((await loadCfg()) ?? null);
      if (!cfg.cdpUrl) {
        // Logging in to a throwaway fallback profile would be useless: refuse instead.
        const name = sanitizeName(opts.profile ?? cfg.profile) || 'default';
        const lock = await profileLockInfo(browserProfileDir(name, profilesDir));
        if (lock.locked) {
          err(
            `Profile "${name}" is in use by another browser${lock.pid ? ` (pid ${lock.pid})` : ''} — probably a running QodeX session. ` +
            'Close it first (browser_close in that session, or `qodex browser close`), then run this again.',
          );
          exit(1);
          return;
        }
      }
      const mgr = await getManager();
      const { normalizeUrl } = await import('./session.js');
      out(`Opening the QodeX browser${opts.profile ? ` (profile "${sanitizeName(opts.profile)}")` : ''}…`);
      try {
        await mgr.restart({ headless: false, ...(opts.profile ? { profile: opts.profile } : {}) });
        if (url) {
          const page = await mgr.activePage();
          try {
            await page.goto(normalizeUrl(url), { waitUntil: 'domcontentloaded', timeout: 30_000 });
          } catch (e: any) {
            err(`Could not open ${url}: ${String(e?.message ?? e).split('\n')[0]}`);
          }
        }
      } catch (e: any) {
        err(String(e?.message ?? e));
        exit(1);
        return;
      }
      const st = mgr.status() as ReturnType<BrowserManager['status']> & { notice?: string };
      out(`✓ Browser open — profile "${st.profile}"${st.executable ? ` (${st.executable})` : ''}`);
      if (st.notice) out(`  Note: ${st.notice}`);
      out('  Log in to the sites you want QodeX to use; cookies and logins are saved in this profile and reused by the agent.');
      out('  Press Enter here (or close the browser window) when you are done.');
      await (deps.waitForUser ?? defaultWaitForUser)(mgr);
      await mgr.close().catch(() => {});
      out('✓ Browser closed — the profile is saved.');
      exit(0);
    });

  cmd
    .command('status')
    .description('Show Playwright, browser executable discovery and profile state')
    .action(async () => {
      const cfgRaw = await loadCfg();
      const cfg = resolveBrowserConfig(cfgRaw ?? null);
      const { isPlaywrightAvailable, redactCdpUrl } = await import('./session.js');
      const { resolveBrowserExecutable, missingBrowserHint } = await import('./launcher.js');
      const hasPw = await isPlaywrightAvailable();
      let pwVersion = '';
      let pwExe = '';
      if (hasPw) {
        try { pwVersion = createRequire(import.meta.url)('playwright/package.json').version; } catch { /* unknown */ }
        try {
          const name = 'playwright';
          const mod: any = await import(name);
          pwExe = String((mod.chromium ?? mod.default?.chromium)?.executablePath?.() ?? '');
        } catch { /* ignore */ }
      }
      const exe = resolveBrowserExecutable({ executablePath: cfg.executablePath, channel: cfg.channel, playwrightExecutablePath: pwExe, headless: cfg.headless });
      const profileDir = browserProfileDir(cfg.profile, profilesDir);
      const lock = await profileLockInfo(profileDir);
      const profiles = await listProfiles(profilesDir);
      out('QodeX Browser');
      out(`  Playwright:  ${hasPw ? `installed${pwVersion ? ` v${pwVersion}` : ''}` : 'NOT installed — npm install playwright'}`);
      if (cfg.cdpUrl) out(`  Mode:        attach to your Chrome over CDP at ${redactCdpUrl(cfg.cdpUrl)}`);
      else {
        out(`  Executable:  ${exe.executablePath ?? (exe.channel ? `channel "${exe.channel}"` : 'none found')}${exe.source !== 'none' ? `  [${exe.source}]` : ''}`);
        if (exe.source === 'none') out(`               ${missingBrowserHint()}`);
        for (const w of exe.warnings ?? []) out(`  Warning:     ${w}`);
        const mode = cfg.headlessMode === 'auto'
          ? 'auto (a visible window in the interactive TUI on a desktop, headless for --print / missions / no display)'
          : cfg.headless ? 'headless' : 'visible window';
        out(`  Mode:        ${mode}${cfg.stealth ? ', stealth' : ''}, viewport ${cfg.viewport.width}x${cfg.viewport.height}`);
      }
      out(`  Profile:     ${sanitizeName(cfg.profile) || 'default'} → ${profileDir}${lock.locked ? `  (IN USE${lock.pid ? ` by pid ${lock.pid}` : ''})` : ''}`);
      out(`  Profiles:    ${profiles.length} in ${profilesDir}`);
      out(`  Downloads:   ${downloadsDir}`);
      out(`  Dialogs:     ${cfg.dialogPolicy}; snapshot after action: ${cfg.snapshotAfterAction ? 'on' : 'off'}`);
    });

  cmd
    .command('profiles')
    .alias('ls')
    .description('List persistent browser profiles')
    .action(async () => {
      const rows = await listProfiles(profilesDir);
      if (!rows.length) {
        out(`No browser profiles yet (${profilesDir}). The first browser_* call or \`qodex browser open\` creates "default".`);
        return;
      }
      out(`${rows.length} profile(s) in ${profilesDir}:`);
      for (const r of rows) {
        const when = r.modified ? r.modified.toISOString().replace('T', ' ').slice(0, 16) : '?';
        const state = r.lock.locked ? `in use${r.lock.pid ? ` (pid ${r.lock.pid})` : ''}` : r.lock.stale ? 'stale lock' : 'idle';
        out(`  ${r.name.padEnd(24)} ${(r.partialSize ? '≥' : '') + fmtBytes(r.bytes)}`.padEnd(40) + `  ${when}  ${state}`);
      }
    });

  cmd
    .command('reset-profile <name>')
    .description('Delete a browser profile (forgets its logins and cookies)')
    .option('-y, --yes', 'Do not ask for confirmation')
    .action(async (name: string, opts: { yes?: boolean }) => {
      const clean = sanitizeName(name);
      if (!clean) { err('Invalid profile name.'); process.exitCode = 1; return; }
      const dir = browserProfileDir(clean, profilesDir);
      if (!fsSync.existsSync(dir)) { err(`No profile "${clean}" in ${profilesDir}.`); process.exitCode = 1; return; }
      const lock = await profileLockInfo(dir);
      if (lock.locked) {
        err(`Profile "${clean}" is in use${lock.pid ? ` by pid ${lock.pid}` : ''}. Close that browser first (qodex browser close).`);
        process.exitCode = 1;
        return;
      }
      const ok = opts.yes || await (deps.confirm ?? defaultConfirm)(`Delete browser profile "${clean}" (${dir}) and all its logins?`);
      if (!ok) { out('Cancelled.'); return; }
      await fs.rm(dir, { recursive: true, force: true });
      out(`✓ Deleted profile "${clean}".`);
    });

  cmd
    .command('close')
    .description('Stop QodeX browsers still running (e.g. after a crash) that lock a profile')
    .action(async () => {
      const mgr = (await import('./types.js')).peekBrowserManager();
      if (mgr?.isRunning()) { await mgr.close(); out('✓ Closed the browser of this process.'); }
      const rows = await listProfiles(profilesDir);
      let stopped = 0;
      for (const r of rows) {
        if (!r.lock.locked || !r.lock.pid || r.lock.host !== os.hostname()) continue;
        const cmdline = commandLineOf(r.lock.pid);
        if (!cmdline || !cmdline.includes(r.dir)) {
          out(`  ${r.name}: in use by pid ${r.lock.pid}, which could not be verified as a QodeX browser — left running.`);
          continue;
        }
        try {
          process.kill(r.lock.pid, 'SIGTERM');
          stopped++;
          out(`  ✓ ${r.name}: stopped browser pid ${r.lock.pid}`);
        } catch (e: any) {
          out(`  ${r.name}: could not stop pid ${r.lock.pid}: ${e?.message ?? e}`);
        }
      }
      if (!stopped) out(rows.some(r => r.lock.locked) ? 'No QodeX browser could be stopped safely.' : 'No QodeX browser is running.');
    });

  return cmd;
}
