/**
 * Bot process lifecycle — start/stop the Telegram/Discord/Slack bot as a detached background
 * process, tracked by a PID file, so the dashboard can run it without holding the terminal.
 *
 * The bot is `qodex bot` (deny-by-default auth, tokens from ~/.qodex/.env). We spawn it detached
 * and record its PID; stop sends SIGTERM; status checks liveness with `kill(pid, 0)`.
 *
 * pidFilePath / parsePid are PURE; the rest is best-effort process I/O.
 */
import { spawn } from 'cross-spawn';
import { promises as fs } from 'fs';
import * as path from 'path';
import { QODEX_HOME } from '../config/defaults.js';

export function pidFilePath(): string { return path.join(QODEX_HOME, 'bot.pid'); }

/** Parse a PID from a pidfile body. PURE. */
export function parsePid(raw: string | null | undefined): number | null {
  const n = parseInt(String(raw ?? '').trim(), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Is a pid alive? (kill 0 probes without signalling.) */
export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; }
}

export interface BotStatus { running: boolean; pid?: number }

export async function botStatus(): Promise<BotStatus> {
  const pid = parsePid(await fs.readFile(pidFilePath(), 'utf-8').catch(() => null));
  if (pid && isAlive(pid)) return { running: true, pid };
  return { running: false };
}

function resolveCliPath(): string {
  return process.env.QODEX_CLI_PATH || 'qodex';
}

export async function startBot(cwd: string): Promise<{ ok: boolean; message: string }> {
  const cur = await botStatus();
  if (cur.running) return { ok: false, message: `Bot already running (pid ${cur.pid}).` };
  try {
    await fs.mkdir(QODEX_HOME, { recursive: true });
    const child = spawn(resolveCliPath(), ['bot'], { cwd, detached: true, stdio: 'ignore' });
    child.unref();
    if (!child.pid) return { ok: false, message: 'Could not spawn the bot process.' };
    await fs.writeFile(pidFilePath(), String(child.pid), 'utf-8');
    return { ok: true, message: `Bot started (pid ${child.pid}). It needs a token + allowlist in config to actually connect.` };
  } catch (e: any) {
    return { ok: false, message: `Failed to start bot: ${e?.message ?? e}` };
  }
}

export async function stopBot(): Promise<{ ok: boolean; message: string }> {
  const cur = await botStatus();
  if (!cur.running || !cur.pid) { await fs.unlink(pidFilePath()).catch(() => {}); return { ok: false, message: 'Bot is not running.' }; }
  try {
    process.kill(cur.pid, 'SIGTERM');
    await fs.unlink(pidFilePath()).catch(() => {});
    return { ok: true, message: `Stopped the bot (pid ${cur.pid}).` };
  } catch (e: any) {
    return { ok: false, message: `Couldn't stop pid ${cur.pid}: ${e?.message ?? e}` };
  }
}
