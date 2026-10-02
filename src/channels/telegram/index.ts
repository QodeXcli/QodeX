/**
 * Telegram channel — public surface.
 *
 * `startTelegramBot()` is the one-call entry point the integration uses from the
 * TUI (`/telegram start`), headless runs and `qodex telegram start`: it reads
 * `telegram.*` config + the token from the env var named by
 * `telegram.botTokenEnv` (stored in ~/.qodex/.env by `qodex telegram setup`),
 * and keeps ONE bot per process (two getUpdates pollers on the same token
 * would fight with HTTP 409s). `telegramSlashCommand()` implements the
 * `/telegram start|stop|status|pair` slash command on top of it.
 *
 * Import `buildTelegramCommand` from './command.js' directly when mounting the
 * CLI: that module is light, while this index pulls in the bot + config loader.
 */

import { TelegramApi, maskToken, redactToken, type FetchLike } from './api.js';
import { TelegramPairingStore } from './pairing.js';
import { TelegramBot, type TelegramBotOptions, type TelegramMissionAdapter } from './bot.js';
import { resolveTelegramConfig } from '../../config/agent-config.js';
import { getActiveConfig } from '../../config/loader.js';
import { getBus } from '../../control/bus.js';

export * from './api.js';
export * from './pairing.js';
export * from './format.js';
export * from './bot.js';
export { buildTelegramCommand, type TelegramCommandDeps } from './command.js';

export interface StartTelegramBotOptions {
  /** QodexConfig (or anything with a `telegram` section). Default: the active config. */
  config?: unknown;
  /** Where to read the token env var from. Default process.env. */
  env?: NodeJS.ProcessEnv;
  /** Explicit token (overrides the env var). */
  token?: string;
  /** Missions bridge (Module E). Without it, /mission etc. reply "not available". */
  missionAdapter?: TelegramMissionAdapter | null;
  fetch?: FetchLike;
  /** Pairing state file (tests). Default ~/.qodex/channels/telegram.json. */
  pairingFile?: string;
  /** Stops the bot when aborted. */
  signal?: AbortSignal;
  /** Delete a configured webhook first (getUpdates 409s while one is set). */
  dropWebhook?: boolean;
  /** Extra TelegramBot options (rate limits, tick interval, logger...). */
  botOptions?: Partial<Omit<TelegramBotOptions, 'api' | 'pairing'>>;
}

export interface RunningTelegramBot {
  bot: TelegramBot;
  /** The bot's @username (without @), or its numeric id. */
  username: string;
  /** Settles when polling stops; rejects on a fatal error (revoked token). */
  done: Promise<void>;
  stop(): Promise<void>;
}

let current: RunningTelegramBot | null = null;
let starting: Promise<RunningTelegramBot> | null = null;

/**
 * Start the process-wide Telegram bot (idempotent: returns the running one).
 * Throws `[TELEGRAM_NOT_CONFIGURED]` when no token is set, or the API error
 * when Telegram rejects the token / is unreachable.
 */
export async function startTelegramBot(opts: StartTelegramBotOptions = {}): Promise<RunningTelegramBot> {
  if (current) return current;
  if (starting) return starting;
  starting = (async () => {
    const cfg = resolveTelegramConfig(opts.config ?? getActiveConfig());
    const env = opts.env ?? process.env;
    const token = String(opts.token ?? env[cfg.botTokenEnv] ?? '').trim();
    if (!token) {
      throw new Error(`[TELEGRAM_NOT_CONFIGURED] No bot token in $${cfg.botTokenEnv}. Run \`qodex telegram setup\` first.`);
    }
    const api = new TelegramApi({ token, apiBase: cfg.apiBase, fetch: opts.fetch });
    if (opts.dropWebhook) await api.deleteWebhook({ signal: opts.signal });
    const pairing = new TelegramPairingStore({ file: opts.pairingFile });
    const bot = new TelegramBot({
      notify: cfg.notify,
      ...opts.botOptions,
      api,
      pairing,
      missions: opts.missionAdapter ?? null,
    });
    const me = await bot.start(opts.signal);
    const done = bot.done();
    const handle: RunningTelegramBot = {
      bot,
      username: me.username ?? String(me.id),
      done,
      stop: () => bot.stop(),
    };
    current = handle;
    done.then(clear, clear);
    function clear() { if (current === handle) current = null; }
    return handle;
  })();
  try {
    return await starting;
  } finally {
    starting = null;
  }
}

/** The running bot in this process, if any. */
export function getTelegramBot(): RunningTelegramBot | null {
  return current;
}

/** Stop the running bot (no-op when none). */
export async function stopTelegramBot(): Promise<void> {
  const c = current;
  current = null;
  if (c) await c.stop();
}

export interface TelegramSlashOptions {
  /** Missions bridge factory (same one `qodex telegram start` uses). */
  missionAdapter?: () => Promise<TelegramMissionAdapter | null>;
  config?: unknown;
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  pairingFile?: string;
}

/**
 * Handler for the TUI/headless `/telegram [start|stop|status|pair]` slash
 * command. Returns the message to show. Runs the bot INSIDE the current
 * process, so approvals raised by this session (Sentinel, edit approvals)
 * reach the paired phone too. The bot logs to ~/.qodex/qodex.log (never to
 * stdout, which would corrupt the Ink UI); fatal stops surface as a bus notice.
 */
export async function telegramSlashCommand(arg: string, opts: TelegramSlashOptions = {}): Promise<string> {
  const sub = (arg.trim().split(/\s+/)[0] || 'status').toLowerCase();
  const cfg = resolveTelegramConfig(opts.config ?? getActiveConfig());
  const env = opts.env ?? process.env;
  const pairing = () => new TelegramPairingStore({ file: opts.pairingFile });
  const usage = 'Usage: /telegram start | stop | status | pair';

  switch (sub) {
    case 'start':
    case 'on': {
      if (current) return `Telegram bot @${current.username} is already running in this session.`;
      let adapter: TelegramMissionAdapter | null = null;
      let note = '';
      if (opts.missionAdapter) {
        try { adapter = await opts.missionAdapter(); } catch (err) { note = `\n⚠ Missions unavailable: ${err instanceof Error ? err.message : String(err)}`; }
      }
      try {
        const h = await startTelegramBot({ config: opts.config, env, missionAdapter: adapter, fetch: opts.fetch, pairingFile: opts.pairingFile });
        h.done.catch((err) => {
          getBus().publish({ kind: 'notice', level: 'error', message: `Telegram bot stopped: ${err instanceof Error ? err.message : String(err)}` });
        });
        const chats = await h.bot.pairing.listChats();
        const pairHint = chats.length
          ? `Paired chats: ${chats.length}. Approvals from this session will also be sent there.`
          : 'No chat is paired yet — run /telegram pair.';
        return `✓ Telegram bot @${h.username} is running in this session. ${pairHint}${note}`;
      } catch (err) {
        const token = String(env[cfg.botTokenEnv] ?? '');
        return `✗ ${redactToken(err instanceof Error ? err.message : String(err), token)}`;
      }
    }
    case 'stop':
    case 'off': {
      if (!current) return 'Telegram bot is not running in this session.';
      const name = current.username;
      await stopTelegramBot();
      return `✓ Telegram bot @${name} stopped.`;
    }
    case 'pair': {
      const { code, expiresAt } = await pairing().createPairingCode();
      const until = new Date(expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const name = current?.username;
      const how = name
        ? `Open https://t.me/${name}?start=${code} — or send /pair ${code} to @${name} in a private chat.`
        : `Send /pair ${code} to your bot in a private chat (start it first: /telegram start).`;
      return `Pairing code: ${code} (single use, valid until ${until}).\n${how}`;
    }
    case 'status': {
      const token = String(env[cfg.botTokenEnv] ?? '').trim();
      const chats = await pairing().listChats();
      const lines = [
        `Token: ${token ? maskToken(token) : `not set — run \`qodex telegram setup\``} [$${cfg.botTokenEnv}]`,
        current ? `Bot: @${current.username} running in this session` : 'Bot: not running in this session (/telegram start)',
        `Paired chats: ${chats.length}${chats.length ? ' — ' + chats.map((c) => (c.username ? '@' + c.username : String(c.chatId))).join(', ') : ''}`,
      ];
      return lines.join('\n');
    }
    default:
      return usage;
  }
}
