/**
 * `qodex telegram ...` — connect a Telegram bot to QodeX.
 *
 *   qodex telegram setup [--token T]     verify a @BotFather token (getMe) and store it in ~/.qodex/.env
 *   qodex telegram pair [--json]         print a one-time 6-digit pairing code (10 min) + deep link
 *   qodex telegram start [--drop-webhook] [--no-missions]
 *                                        run the bot in the foreground (Ctrl+C to stop)
 *   qodex telegram status [--offline]    token (masked), bot account, paired chats (default subcommand)
 *   qodex telegram unpair <chatId|@user> | --all
 *
 * No bootstrap: the command loads ~/.qodex/.env and the config itself, so it
 * stays fast and never starts MCP servers or the model router. The token is
 * read with a hidden prompt (or from stdin when piped) — passing `--token` works
 * but lands in shell history. Missions are reached through an injected adapter
 * factory (the integration wires the missions module).
 *
 * Heavy modules are imported lazily inside each action so mounting this
 * command in src/index.ts costs nothing at startup.
 */

import { Command } from 'commander';
import type { FetchLike } from './api.js';
import type { TelegramMissionAdapter } from './bot.js';
import type { TelegramConfig } from '../../config/agent-config.js';

export interface TelegramCommandDeps {
  /** Missions bridge factory (integration wires Module E). */
  missionAdapter?: () => Promise<TelegramMissionAdapter>;
  /** Test hooks — production uses the defaults. */
  fetch?: FetchLike;
  pairingFile?: string;
  env?: NodeJS.ProcessEnv;
  print?: (line: string) => void;
  printErr?: (line: string) => void;
  readSecret?: (prompt: string) => Promise<string>;
  saveSecret?: (key: string, value: string) => Promise<string>;
  /** Returns the merged QodexConfig. Default: load ~/.qodex/.env + loadConfig(cwd) + setActiveConfig. */
  loadConfig?: () => Promise<unknown>;
  exit?: (code: number) => void;
  /** Is a human at a terminal? Default: stdin is a TTY. Gates printing pairing codes. */
  isInteractive?: () => boolean;
}

/**
 * A pairing code hands a Telegram account the power to approve purchases, start
 * missions and see the browser. QodeX's own shell tool runs commands with piped
 * stdio, so codes are only ever printed when stdin is a terminal: a
 * prompt-injected agent running `qodex telegram pair --json` (or `start`) gets
 * nothing to exfiltrate. (`qodex telegram pair --json | jq` in a terminal still works.)
 */
const PAIR_NEEDS_TERMINAL =
  '✗ [TELEGRAM_PAIR_NEEDS_TERMINAL] Run `qodex telegram pair` yourself in a terminal (or /telegram pair in the QodeX UI). ' +
  'Pairing codes are never printed when stdin is not a terminal, so an automated agent or script cannot mint one.';

interface Ctx {
  cfg: TelegramConfig;
  env: NodeJS.ProcessEnv;
  raw: unknown;
}

/**
 * Read a line without echoing it (raw TTY). When stdin is not a TTY (piped),
 * reads the first line of stdin instead: `echo "$TOKEN" | qodex telegram setup`.
 * The piped case returns as soon as a newline arrives — waiting for EOF would
 * hang forever on a pipe that is never closed (supervisors, IDE terminals).
 */
export async function readHiddenLine(
  prompt: string,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<string> {
  const stdin = input as NodeJS.ReadStream;
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    return new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const firstLine = () => Buffer.concat(chunks).toString('utf-8').split(/\r?\n/)[0] ?? '';
      const done = (fn: () => void) => {
        stdin.removeListener('data', onData);
        stdin.removeListener('end', onEnd);
        stdin.removeListener('error', onError);
        stdin.pause();
        fn();
      };
      function onData(c: string | Buffer) {
        const b = Buffer.isBuffer(c) ? c : Buffer.from(String(c));
        chunks.push(b);
        if (b.includes(0x0a)) done(() => resolve(firstLine()));
      }
      function onEnd() { done(() => resolve(firstLine())); }
      function onError(err: Error) { done(() => reject(err)); }
      stdin.on('data', onData);
      stdin.once('end', onEnd);
      stdin.once('error', onError);
      stdin.resume();
    });
  }
  return new Promise<string>((resolve, reject) => {
    output.write(prompt);
    let buf = '';
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    const finish = (fn: () => void) => {
      stdin.removeListener('data', onData);
      try { stdin.setRawMode(wasRaw); } catch { /* ignore */ }
      stdin.pause();
      output.write('\n');
      fn();
    };
    function onData(chunk: string | Buffer) {
      for (const ch of String(chunk)) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') { finish(() => resolve(buf)); return; }
        if (ch === '\u0003') { finish(() => reject(new Error('[CANCELLED] Cancelled.'))); return; }
        if (ch === '\u007f' || ch === '\b') { buf = buf.slice(0, -1); continue; }
        if (ch < ' ') continue;
        buf += ch;
      }
    }
    stdin.on('data', onData);
  });
}

function describeChat(c: { chatId: number; username?: string; firstName?: string; lang?: string; pairedAt?: number }): string {
  const who = c.username ? `@${c.username}` : (c.firstName ?? '');
  const since = c.pairedAt ? new Date(c.pairedAt).toISOString().slice(0, 16).replace('T', ' ') : '';
  return [String(c.chatId), who, c.lang ? `lang=${c.lang}` : '', since ? `since ${since}` : ''].filter(Boolean).join('  ');
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function buildTelegramCommand(deps: TelegramCommandDeps = {}): Command {
  const print = deps.print ?? ((l: string) => console.log(l));
  const printErr = deps.printErr ?? ((l: string) => console.error(l));
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const interactive = deps.isInteractive ?? (() => Boolean(process.stdin.isTTY));

  const loadCtx = async (): Promise<Ctx> => {
    let raw: unknown;
    if (deps.loadConfig) {
      raw = await deps.loadConfig();
    } else {
      const { loadEnvFileIntoProcess } = await import('../../setup/env-writer.js');
      await loadEnvFileIntoProcess().catch(() => 0);
      const { loadConfig, setActiveConfig } = await import('../../config/loader.js');
      const cfg = await loadConfig(process.cwd());
      setActiveConfig(cfg);
      raw = cfg;
    }
    const { resolveTelegramConfig } = await import('../../config/agent-config.js');
    return { cfg: resolveTelegramConfig(raw), env: deps.env ?? process.env, raw };
  };

  const pairingStore = async () => {
    const { TelegramPairingStore } = await import('./pairing.js');
    return new TelegramPairingStore({ file: deps.pairingFile });
  };

  const makeApi = async (token: string, cfg: TelegramConfig, timeoutMs?: number) => {
    const { TelegramApi } = await import('./api.js');
    return new TelegramApi({ token, apiBase: cfg.apiBase, fetch: deps.fetch, requestTimeoutMs: timeoutMs });
  };

  const cmd = new Command('telegram');
  cmd.description('Control QodeX from Telegram — approve actions, start/cancel missions, see status and screenshots from your phone');

  // ── setup ──────────────────────────────────────────────────────────────────
  cmd
    .command('setup')
    .description('Connect a bot from @BotFather: verify the token and store it in ~/.qodex/.env')
    .option('--token <token>', 'Bot token (prefer the hidden prompt: command-line arguments end up in shell history)')
    .action(async (opts: { token?: string }) => {
      const { redactToken, looksLikeBotToken } = await import('./api.js');
      try {
        const { cfg, env } = await loadCtx();
        let token = (opts.token ?? '').trim();
        if (!token) {
          if (process.stdin.isTTY && !deps.readSecret) {
            print('Create a bot: open Telegram → @BotFather → /newbot, then paste the token it gives you.');
          }
          token = (await (deps.readSecret ?? readHiddenLine)('Bot token (hidden): ')).trim();
        }
        if (!token) { printErr('✗ No token given.'); exit(1); return; }
        if (!looksLikeBotToken(token)) {
          printErr('✗ That does not look like a bot token (expected something like 123456789:AAH…, from @BotFather).');
          exit(1);
          return;
        }
        const api = await makeApi(token, cfg, 20_000);
        let me;
        try {
          me = await api.getMe();
        } catch (err) {
          printErr(`✗ Could not verify the token: ${redactToken(errText(err), token)}`);
          printErr('  If Telegram is blocked on your network, set HTTPS_PROXY (QodeX honors it) or telegram.apiBase in ~/.qodex/config.yaml.');
          exit(1);
          return;
        }
        const save = deps.saveSecret ?? (async (k: string, v: string) => (await import('../../setup/env-writer.js')).setEnvKey(k, v));
        const file = await save(cfg.botTokenEnv, token);
        env[cfg.botTokenEnv] = token;
        print(`✓ Connected to @${me.username ?? me.id}. Token saved to ${file} as ${cfg.botTokenEnv} (chmod 600).`);
        try {
          const wh = await api.getWebhookInfo();
          if (wh?.url) {
            print(`⚠ This bot has a webhook set. QodeX uses long-polling — start it with: qodex telegram start --drop-webhook`);
          }
        } catch { /* informational only */ }
        print('');
        print('Next:');
        print('  1. qodex telegram start      # run the bot (keep it running)');
        print('  2. qodex telegram pair       # get a one-time code, then send /pair <code> to the bot');
        exit(0);
      } catch (err) {
        printErr(`✗ ${redactToken(errText(err), opts.token)}`);
        exit(/\[CANCELLED\]/.test(errText(err)) ? 130 : 1);
      }
    });

  // ── pair ───────────────────────────────────────────────────────────────────
  cmd
    .command('pair')
    .description('Print a one-time pairing code (valid 10 minutes) for a private Telegram chat')
    .option('--json', 'Machine-readable output')
    .action(async (opts: { json?: boolean }) => {
      try {
        if (!interactive()) { printErr(PAIR_NEEDS_TERMINAL); exit(1); return; }
        const { cfg, env } = await loadCtx();
        const store = await pairingStore();
        const { code, expiresAt } = await store.createPairingCode();
        const token = String(env[cfg.botTokenEnv] ?? '').trim();
        let username: string | undefined;
        if (token) {
          try { username = (await (await makeApi(token, cfg, 8000)).getMe()).username; } catch { /* offline is fine */ }
        }
        const link = username ? `https://t.me/${username}?start=${code}` : undefined;
        if (opts.json) {
          print(JSON.stringify({ code, expiresAt, bot: username ?? null, link: link ?? null }));
          exit(0);
          return;
        }
        const until = new Date(expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        print(`Pairing code: ${code}   (single use, valid until ${until})`);
        if (username) {
          print(`Open ${link}`);
          print(`  — or send  /pair ${code}  to @${username} in a private chat.`);
        } else {
          print(`Send  /pair ${code}  to your bot in a private chat.`);
        }
        if (!token) print('(No bot token configured yet — run `qodex telegram setup` first.)');
        print('The bot must be running to receive it: qodex telegram start');
        exit(0);
      } catch (err) {
        printErr(`✗ ${errText(err)}`);
        exit(1);
      }
    });

  // ── start ──────────────────────────────────────────────────────────────────
  cmd
    .command('start')
    .description('Run the Telegram bot in the foreground (Ctrl+C to stop)')
    .option('--drop-webhook', 'Delete a webhook configured on this bot before polling')
    .option('--no-missions', 'Do not connect to the mission store')
    .action(async (opts: { dropWebhook?: boolean; missions?: boolean }) => {
      const { redactToken } = await import('./api.js');
      let token = '';
      let code = 0;
      const ac = new AbortController();
      const onTerm = () => ac.abort();
      // Ctrl+C. Node exits on SIGINT by itself only while NOTHING listens for it, and
      // the CLI entry imports modules that do (the tool registry's process registry
      // installs a cleanup listener that never exits) — which would leave "Press Ctrl+C
      // to stop" doing nothing. So: when a listener already exists, stop the bot
      // (confirming the update offset) and exit 130 ourselves; a second Ctrl+C exits at
      // once. When none exists we add none, keeping Node's default.
      let interrupted = false;
      let force: NodeJS.Timeout | null = null;
      const onInt = () => {
        if (interrupted) { exit(130); return; }
        interrupted = true;
        ac.abort();
        force = setTimeout(() => exit(130), 5000);
        force.unref?.();
      };
      const ownSigint = process.listenerCount('SIGINT') > 0;
      try {
        const { cfg, env, raw } = await loadCtx();
        token = String(env[cfg.botTokenEnv] ?? '').trim();
        if (!token) {
          printErr(`✗ [TELEGRAM_NOT_CONFIGURED] No bot token in $${cfg.botTokenEnv}. Run: qodex telegram setup`);
          exit(1);
          return;
        }
        let adapter: TelegramMissionAdapter | null = null;
        if (deps.missionAdapter && opts.missions !== false) {
          try { adapter = await deps.missionAdapter(); } catch (err) {
            printErr(`⚠ Missions unavailable: ${errText(err)}`);
          }
        }
        const { startTelegramBot } = await import('./index.js');
        const stamp = () => new Date().toISOString().slice(11, 19);
        // SIGTERM → graceful stop.
        process.once('SIGTERM', onTerm);
        if (ownSigint) process.on('SIGINT', onInt);
        const handle = await startTelegramBot({
          config: raw,
          env,
          token,
          missionAdapter: adapter,
          fetch: deps.fetch,
          pairingFile: deps.pairingFile,
          signal: ac.signal,
          dropWebhook: !!opts.dropWebhook,
          botOptions: {
            log: (level, m) => (level === 'info' ? print : printErr)(`[${stamp()}] ${m}`),
          },
        });
        print(`✓ QodeX Telegram bot @${handle.username} is running (pid ${process.pid}). Press Ctrl+C to stop.`);
        const store = handle.bot.pairing;
        const chats = await store.listChats();
        if (!chats.length) {
          const { code: pairCode } = await store.createPairingCode();
          print(`No chats paired yet. Open https://t.me/${handle.username}?start=${pairCode}`);
          print(`  — or send  /pair ${pairCode}  to @${handle.username} in a private chat (valid 10 minutes).`);
        } else {
          print(`Paired chats: ${chats.map((c) => (c.username ? '@' + c.username : String(c.chatId))).join(', ')}`);
        }
        print(adapter ? 'Missions: connected (/mission, /missions, /cancel, approvals).' : 'Missions: not connected — only approvals raised in this process reach Telegram.');
        try {
          await handle.done;
        } catch (err) {
          printErr(`✗ ${redactToken(errText(err), token)}`);
          code = 1;
        }
      } catch (err) {
        printErr(`✗ ${redactToken(errText(err), token)}`);
        code = 1;
      } finally {
        process.removeListener('SIGTERM', onTerm);
        if (ownSigint) process.removeListener('SIGINT', onInt);
        if (force) clearTimeout(force);
      }
      exit(interrupted && code === 0 ? 130 : code);
    });

  // ── status ─────────────────────────────────────────────────────────────────
  cmd
    .command('status', { isDefault: true })
    .description('Show the Telegram setup: token (masked), bot account, paired chats')
    .option('--offline', "Don't contact Telegram")
    .action(async (opts: { offline?: boolean }) => {
      const { maskToken, redactToken } = await import('./api.js');
      let token = '';
      try {
        const { cfg, env } = await loadCtx();
        token = String(env[cfg.botTokenEnv] ?? '').trim();
        print(`Token:    ${token ? maskToken(token) : '(not set — run `qodex telegram setup`)'}   [$${cfg.botTokenEnv}]`);
        print(`API:      ${cfg.apiBase}`);
        print(`Notify:   ${cfg.notify ? 'on' : 'off'}`);
        if (token && !opts.offline) {
          try {
            const api = await makeApi(token, cfg, 10_000);
            const me = await api.getMe();
            print(`Bot:      @${me.username ?? '?'} (id ${me.id})`);
            try {
              const wh = await api.getWebhookInfo();
              if (wh?.url) print('Webhook:  set — start the bot with --drop-webhook to use long-polling');
            } catch { /* informational */ }
          } catch (err) {
            print(`Bot:      unreachable — ${redactToken(errText(err), token)}`);
          }
        }
        const store = await pairingStore();
        const chats = await store.listChats();
        print(`Paired:   ${chats.length} chat(s)`);
        for (const c of chats) print(`  • ${describeChat(c)}`);
        const pending = await store.pendingCodeCount();
        if (pending) print(`Codes:    ${pending} unused pairing code(s) outstanding`);
        if (!chats.length) print('Pair a chat: qodex telegram pair');
        exit(0);
      } catch (err) {
        printErr(`✗ ${redactToken(errText(err), token)}`);
        exit(1);
      }
    });

  // ── unpair ─────────────────────────────────────────────────────────────────
  cmd
    .command('unpair [chat]')
    .description('Disconnect a paired chat (by chat id or @username), or every chat with --all')
    .option('--all', 'Unpair every chat')
    .action(async (chat: string | undefined, opts: { all?: boolean }) => {
      try {
        const store = await pairingStore();
        if (opts.all) {
          const n = await store.unpairAll();
          print(`✓ Unpaired ${n} chat(s).`);
          exit(0);
          return;
        }
        const arg = (chat ?? '').trim();
        if (!arg) { printErr('✗ Usage: qodex telegram unpair <chatId|@username>  (or --all)'); exit(1); return; }
        let chatId = Number(arg);
        if (!Number.isSafeInteger(chatId)) {
          const name = arg.replace(/^@/, '').toLowerCase();
          const match = (await store.listChats()).find((c) => c.username?.toLowerCase() === name);
          if (!match) { printErr(`✗ No paired chat matches "${arg}". See: qodex telegram status`); exit(1); return; }
          chatId = match.chatId;
        }
        const ok = await store.unpair(chatId);
        if (ok) { print(`✓ Unpaired chat ${chatId}.`); exit(0); }
        else { printErr(`✗ Chat ${chatId} is not paired.`); exit(1); }
      } catch (err) {
        printErr(`✗ ${errText(err)}`);
        exit(1);
      }
    });

  return cmd;
}
