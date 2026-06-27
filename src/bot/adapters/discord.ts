/**
 * Discord adapter — Transport over discord.js. The library is an OPTIONAL, lazily-imported
 * dependency: the bot feature works on Telegram with zero installs, and only Discord needs
 * `npm i discord.js`. If it's missing we throw a one-line, actionable error.
 *
 * Discord renders GitHub-flavored Markdown natively, so the agent's fenced code blocks Just
 * Work. Buttons map to a single action row; a tap arrives as an Incoming with callbackData.
 */
import type { Transport, Incoming, MessageRef, Button } from '../types.js';
import { logger } from '../../utils/logger.js';

export async function createDiscordTransport(token: string): Promise<Transport> {
  let djs: any;
  try {
    djs = await import('discord.js' as any);
  } catch {
    throw new Error("Discord support needs the 'discord.js' package — run: npm i discord.js");
  }
  const { Client, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle, Events } = djs;

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  });

  const rows = (buttons?: Button[][]) =>
    (buttons ?? []).map(row => {
      const r = new ActionRowBuilder();
      for (const b of row) r.addComponents(new ButtonBuilder().setCustomId(b.data).setLabel(b.label).setStyle(ButtonStyle.Primary));
      return r;
    });

  const transport: Transport = {
    platform: 'discord',
    maxLen: 2000,
    minEditIntervalMs: 1200, // Discord ~5 edits / 5s

    async start(onMessage: (m: Incoming) => void) {
      client.on(Events.MessageCreate, (msg: any) => {
        if (msg.author?.bot) return;
        if (!msg.content) return;
        onMessage({ platform: 'discord', chatId: String(msg.channelId), userId: String(msg.author.id), userName: msg.author.username, text: msg.content });
      });
      client.on(Events.InteractionCreate, (i: any) => {
        if (!i.isButton?.()) return;
        onMessage({ platform: 'discord', chatId: String(i.channelId), userId: String(i.user.id), text: '', callbackData: i.customId, callbackId: i.id });
        i.deferUpdate?.().catch(() => {});
      });
      await new Promise<void>((resolve, reject) => {
        client.once(Events.ClientReady, (c: any) => { logger.info('discord bot online', { tag: c.user?.tag }); resolve(); });
        client.login(token).catch(reject);
      });
    },

    async stop() { await client.destroy(); },

    async send(chatId: string, text: string, buttons?: Button[][]): Promise<MessageRef> {
      const channel = await client.channels.fetch(chatId);
      const sent = await channel.send({ content: text, components: rows(buttons) });
      return { id: String(sent.id) };
    },

    async edit(chatId: string, ref: MessageRef, text: string, buttons?: Button[][]): Promise<void> {
      const channel = await client.channels.fetch(chatId);
      const msg = await channel.messages.fetch(ref.id);
      await msg.edit({ content: text, components: rows(buttons) });
    },

    async typing(chatId: string): Promise<void> {
      const channel = await client.channels.fetch(chatId).catch(() => null);
      await channel?.sendTyping?.().catch(() => {});
    },
  };

  return transport;
}
