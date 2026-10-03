/**
 * One-way Telegram notifications from processes that do NOT run the bot — the
 * detached mail watcher, a mission worker that auto-replied. Sends to every
 * paired chat with the configured bot token (sendMessage only: it never polls,
 * so it does not fight the bot's getUpdates in another process).
 *
 * When a bot runs in THIS process it already hears `{kind:'mail'}` bus events,
 * so nothing is sent here (no duplicates). Respects `telegram.notify: false`.
 * Never throws; the token never reaches logs (TelegramApi redacts errors).
 */

import { TelegramApi, TelegramApiError, type FetchLike } from './api.js';
import { TelegramPairingStore } from './pairing.js';
import { NotificationLimiter } from './bot.js';
import { htmlToPlain, langOf, truncate, type Lang, type NoticeView } from './format.js';
import { formatMailNotice } from './mail.js';
import { resolveTelegramConfig } from '../../config/agent-config.js';
import { getActiveConfig } from '../../config/loader.js';
import { logger } from '../../utils/logger.js';

export interface TelegramNotifierOptions {
  config?: unknown;
  env?: NodeJS.ProcessEnv;
  token?: string;
  pairingFile?: string;
  fetch?: FetchLike;
  /** Is a bot running in this process? Default: the channel's own registry. */
  botRunning?: () => boolean | Promise<boolean>;
}

const limiter = new NotificationLimiter(20, 60_000);

let overrides: TelegramNotifierOptions | null = null;
/** Test hook: options used by every notifyMailEventTelegram call (null = defaults). */
export function setTelegramNotifierForTests(o: TelegramNotifierOptions | null): void {
  overrides = o;
}

async function botRunningHere(): Promise<boolean> {
  try {
    const m = await import('./index.js');
    return !!m.getTelegramBot();
  } catch {
    return false;
  }
}

/**
 * Send `build(lang)` to every paired chat. Returns how many chats got it.
 * `important` notices bypass the rate limit.
 */
export async function notifyPairedChats(build: (lang: Lang) => NoticeView | null, opts: TelegramNotifierOptions = {}): Promise<number> {
  const o = { ...(overrides ?? {}), ...opts };
  try {
    if (await (o.botRunning ?? botRunningHere)()) return 0;
    const cfg = resolveTelegramConfig(o.config ?? getActiveConfig());
    if (!cfg.notify) return 0;
    const env = o.env ?? process.env;
    const token = String(o.token ?? env[cfg.botTokenEnv] ?? '').trim();
    if (!token) return 0;
    const chats = await new TelegramPairingStore({ file: o.pairingFile }).listChats();
    if (!chats.length) return 0;
    const probe = build('en');
    if (!probe) return 0;
    const now = Date.now();
    if (probe.important) limiter.record(now);
    else if (!limiter.take(now)) return 0;
    const api = new TelegramApi({ token, apiBase: cfg.apiBase, fetch: o.fetch });
    let sent = 0;
    for (const chat of chats) {
      const n = build(langOf(chat.lang));
      if (!n) continue;
      try {
        await api.sendMessage(chat.chatId, n.text);
        sent++;
      } catch (err) {
        if (err instanceof TelegramApiError && (err.isParseError || err.isTooLong)) {
          try { await api.sendMessage(chat.chatId, truncate(htmlToPlain(n.text), 4000), { parseMode: null }); sent++; } catch { /* give up */ }
        } else {
          logger.debug('Telegram notification failed', { err: api.redact(err instanceof Error ? err.message : String(err)) });
        }
      }
    }
    return sent;
  } catch (err) {
    logger.debug('Telegram notifier unavailable', { err: err instanceof Error ? err.message.slice(0, 200) : String(err) });
    return 0;
  }
}

/** Fan-out target for src/grants/mail-events.ts. */
export async function notifyMailEventTelegram(ev: { type: string; data: unknown; bridged?: boolean }, opts: TelegramNotifierOptions = {}): Promise<number> {
  if (ev?.bridged) return 0;
  return notifyPairedChats((lang) => formatMailNotice(ev.type, ev.data, lang), opts);
}
