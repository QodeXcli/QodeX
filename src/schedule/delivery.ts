/**
 * Schedule delivery — push a finished run's result to a chat channel.
 *
 * The scheduler already runs unattended; this closes the loop so the result reaches your
 * PHONE, not just a desktop notification. A schedule's `deliver` field is a target string
 * like `telegram:<chatId>` or `discord:<channelId>`; after the run we send a compact
 * summary there. Best-effort: a delivery failure never affects the run itself.
 *
 * We talk to the platform REST APIs DIRECTLY (global fetch, no gateway, no extra deps) so
 * the headless `qodex schedule tick` process stays light — it does not log in a Discord
 * gateway client just to post one message. Tokens come from ~/.qodex/.env, the same place
 * the bot reads them: TELEGRAM_BOT_TOKEN and DISCORD_TOKEN.
 *
 * The parsing + formatting helpers are PURE and unit-tested; only `deliverRun` does I/O.
 */
import { logger } from '../utils/logger.js';

export interface DeliveryTarget {
  platform: 'telegram' | 'discord';
  chatId: string;
}

const MAX_LEN: Record<DeliveryTarget['platform'], number> = { telegram: 4096, discord: 2000 };

/** Parse a `telegram:<id>` / `discord:<id>` target. Returns null when malformed/unknown. PURE. */
export function parseDeliveryTarget(s: string | undefined | null): DeliveryTarget | null {
  if (!s) return null;
  const m = /^\s*(telegram|discord)\s*:\s*(\S.*?)\s*$/i.exec(s);
  if (!m) return null;
  return { platform: m[1]!.toLowerCase() as DeliveryTarget['platform'], chatId: m[2]! };
}

/** Build the chat summary for a finished run. PURE. Pulls out a recipe's final status line
 *  (e.g. `VERIFIED-PR: opened …`) and leads with it, since that's the headline a user wants. */
export function formatRunSummary(opts: {
  name: string;
  status: 'success' | 'error' | 'skipped';
  exitCode: number;
  durationSec: number;
  tail: string;
  recipe?: string | null;
}): string {
  const icon = opts.status === 'success' ? '✅' : opts.status === 'skipped' ? '⏭️' : '❌';
  const head = `${icon} QodeX schedule: ${opts.name}`;
  const meta = opts.status === 'success'
    ? `done in ${opts.durationSec}s`
    : `${opts.status} (exit ${opts.exitCode}) after ${opts.durationSec}s`;
  const lines = [head, meta];
  // Surface a recipe verdict line if present (VERIFIED-PR: …).
  const verdict = /^VERIFIED-PR:.*$/im.exec(opts.tail)?.[0];
  if (verdict) lines.push('', verdict.trim());
  else if (opts.tail.trim()) lines.push('', opts.tail.trim());
  return lines.join('\n');
}

/** Hard-truncate to a platform's message limit, keeping the head (the verdict lives there). PURE. */
export function clampForPlatform(text: string, platform: DeliveryTarget['platform']): string {
  const max = MAX_LEN[platform];
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

/**
 * Send `text` to a parsed target. Best-effort: loads ~/.qodex/.env so tokens are present
 * even though this runs outside the main bootstrap, then posts via the platform REST API.
 * Returns true on a confirmed send, false otherwise (never throws).
 */
export async function deliverRun(target: DeliveryTarget, text: string): Promise<boolean> {
  try {
    try {
      const { loadEnvFileIntoProcess } = await import('../setup/env-writer.js');
      await loadEnvFileIntoProcess();
    } catch { /* best-effort */ }

    const body = clampForPlatform(text, target.platform);
    if (target.platform === 'telegram') {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      if (!token) { logger.warn('schedule delivery skipped: TELEGRAM_BOT_TOKEN missing'); return false; }
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: target.chatId, text: body, disable_web_page_preview: true }),
      });
      const r: any = await res.json().catch(() => ({}));
      if (!r.ok) { logger.warn('telegram delivery failed', { err: r.description }); return false; }
      return true;
    }
    // discord
    const token = process.env.DISCORD_TOKEN;
    if (!token) { logger.warn('schedule delivery skipped: DISCORD_TOKEN missing'); return false; }
    const res = await fetch(`https://discord.com/api/v10/channels/${target.chatId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bot ${token}` },
      body: JSON.stringify({ content: body }),
    });
    if (!res.ok) { logger.warn('discord delivery failed', { status: res.status }); return false; }
    return true;
  } catch (e: any) {
    logger.warn('schedule delivery error', { err: e?.message });
    return false;
  }
}
