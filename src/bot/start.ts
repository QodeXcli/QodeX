/**
 * Wire config + env into running bot transports.
 *
 * Tokens are SECRETS → read from process.env (i.e. ~/.qodex/.env), never from config.
 * Allowlists are non-secret → read from config (`bot.<platform>.allowedUsers`). A platform
 * starts only when it's enabled, has a token, AND has a non-empty allowlist (deny-by-default).
 * The agent runs in the directory `qodex bot` was launched from — that's the project it edits.
 */
import type { QodexConfig } from '../config/defaults.js';
import type { ModelRouter } from '../llm/router.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { PermissionEngine } from '../security/permissions.js';
import type { Transport } from './types.js';
import type { AllowConfig } from './auth.js';
import { BotGateway } from './gateway.js';
import { QodexAgentRunner } from './runner.js';
import { TelegramTransport } from './adapters/telegram.js';

export interface StartBotsDeps {
  config: QodexConfig;
  router: ModelRouter;
  registry: ToolRegistry;
  permissions: PermissionEngine;
  cwd?: string;
}
export type BotPlatformFlag = 'telegram' | 'discord' | 'slack' | 'whatsapp' | 'signal';
export interface StartBotsOptions {
  telegram?: boolean;
  discord?: boolean;
  slack?: boolean;
  whatsapp?: boolean;
  signal?: boolean;
}

export async function startBots(deps: StartBotsDeps, opts: StartBotsOptions = {}): Promise<void> {
  const cwd = deps.cwd ?? process.cwd();
  const botCfg: any = (deps.config as any).bot ?? {};
  const allow: AllowConfig = {
    telegram: { allowedUsers: botCfg.telegram?.allowedUsers ?? [] },
    discord: { allowedUsers: botCfg.discord?.allowedUsers ?? [] },
    slack: { allowedUsers: botCfg.slack?.allowedUsers ?? [] },
    whatsapp: { allowedUsers: botCfg.whatsapp?.allowedUsers ?? [] },
    signal: { allowedUsers: botCfg.signal?.allowedUsers ?? [] },
  };
  const anyFlag = !!(opts.telegram || opts.discord || opts.slack || opts.whatsapp || opts.signal);
  const want = (p: BotPlatformFlag) => !anyFlag || !!opts[p];

  const transports: Transport[] = [];
  const notes: string[] = [];

  if (want('telegram') && (botCfg.telegram?.enabled ?? false)) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) notes.push('telegram is enabled but TELEGRAM_BOT_TOKEN is missing — add it to ~/.qodex/.env');
    else if (!allow.telegram!.allowedUsers!.length) notes.push('telegram allowlist is empty — set bot.telegram.allowedUsers (deny-by-default means nobody can use it)');
    else transports.push(new TelegramTransport(token));
  }

  if (want('discord') && (botCfg.discord?.enabled ?? false)) {
    const token = process.env.DISCORD_TOKEN;
    if (!token) notes.push('discord is enabled but DISCORD_TOKEN is missing — add it to ~/.qodex/.env');
    else if (!allow.discord!.allowedUsers!.length) notes.push('discord allowlist is empty — set bot.discord.allowedUsers');
    else {
      try {
        const { createDiscordTransport } = await import('./adapters/discord.js');
        transports.push(await createDiscordTransport(token));
      } catch (e: any) { notes.push(e?.message ?? 'discord transport failed'); }
    }
  }

  if (want('whatsapp') && (botCfg.whatsapp?.enabled ?? false)) {
    const token = process.env.WHATSAPP_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
    if (!token || !phoneNumberId || !verifyToken) {
      notes.push('whatsapp is enabled but WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_VERIFY_TOKEN are missing — add them to ~/.qodex/.env (Cloud API, not WhatsApp Web)');
    } else if (!allow.whatsapp!.allowedUsers!.length) {
      notes.push('whatsapp allowlist is empty — set bot.whatsapp.allowedUsers to phone numbers (E.164 digits, no +)');
    } else {
      const { WhatsAppTransport } = await import('./adapters/whatsapp.js');
      transports.push(new WhatsAppTransport({
        token,
        phoneNumberId,
        verifyToken,
        appSecret: process.env.WHATSAPP_APP_SECRET,
      }));
    }
  }

  if (want('signal') && (botCfg.signal?.enabled ?? false)) {
    const account = process.env.SIGNAL_ACCOUNT;
    if (!account) notes.push('signal is enabled but SIGNAL_ACCOUNT is missing — the +E164 of the signal-cli daemon');
    else if (!allow.signal!.allowedUsers!.length) notes.push('signal allowlist is empty — set bot.signal.allowedUsers to +E164 numbers');
    else {
      const { createSignalTransport } = await import('./adapters/signal.js');
      const rpc = process.env.SIGNAL_CLI_RPC ?? '127.0.0.1:7583';
      const [rpcHost, rpcPortRaw] = rpc.split(':');
      transports.push(createSignalTransport({
        account,
        rpcHost,
        rpcPort: rpcPortRaw ? Number(rpcPortRaw) : 7583,
        restUrl: process.env.SIGNAL_CLI_URL,
      }));
    }
  }

  if (want('slack') && (botCfg.slack?.enabled ?? false)) {
    const appToken = process.env.SLACK_APP_TOKEN;
    const botToken = process.env.SLACK_BOT_TOKEN;
    if (!appToken || !botToken) notes.push('slack is enabled but SLACK_APP_TOKEN / SLACK_BOT_TOKEN is missing — add both to ~/.qodex/.env');
    else if (!allow.slack!.allowedUsers!.length) notes.push('slack allowlist is empty — set bot.slack.allowedUsers');
    else {
      try {
        const { createSlackTransport } = await import('./adapters/slack.js');
        transports.push(await createSlackTransport(appToken, botToken));
      } catch (e: any) { notes.push(e?.message ?? 'slack transport failed'); }
    }
  }

  for (const n of notes) console.error('⚠️  ' + n);
  if (!transports.length) {
    console.error('No bot transports started. Enable bot.<platform> in config, put the token(s) in ~/.qodex/.env, and add allowed user ids.');
    return;
  }

  const runner = new QodexAgentRunner({ config: deps.config, router: deps.router, registry: deps.registry, permissions: deps.permissions, cwd });
  const gateway = new BotGateway({ transports, agent: runner, allow });
  await gateway.start();
  console.error(`🤖 QodeX bot running on: ${transports.map(t => t.platform).join(', ')} · project=${cwd} · Ctrl-C to stop`);

  const shutdown = () => void gateway.stop().finally(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await new Promise<never>(() => {}); // run until killed
}
