/**
 * Slack adapter — Transport over Socket Mode (a WebSocket the bot dials OUT to Slack), so it
 * works from a laptop or a private server with NO public URL — the same "no inbound" property
 * as Telegram long-poll and the Discord gateway.
 *
 * The Slack SDKs are OPTIONAL, lazily-imported deps: Telegram works with zero installs; Slack
 * needs `npm i @slack/socket-mode @slack/web-api`. Missing ⇒ a one-line, actionable error.
 *
 * Two tokens (both secrets, from ~/.qodex/.env):
 *   SLACK_APP_TOKEN  (xapp-…)  — opens the Socket Mode connection.
 *   SLACK_BOT_TOKEN  (xoxb-…)  — authorizes Web API calls (chat.postMessage / chat.update).
 *
 * Slack renders its own mrkdwn; the agent's fenced code blocks survive as triple-backtick
 * blocks. Buttons map to a single Block Kit `actions` row; a tap arrives as a `block_actions`
 * interactive event over the same socket and is acked immediately.
 */
import type { Transport, Incoming, MessageRef, Button } from '../types.js';
import { logger } from '../../utils/logger.js';

export async function createSlackTransport(appToken: string, botToken: string): Promise<Transport> {
  let SocketModeClient: any, WebClient: any;
  try {
    ({ SocketModeClient } = await import('@slack/socket-mode' as any));
    ({ WebClient } = await import('@slack/web-api' as any));
  } catch {
    throw new Error("Slack support needs the Slack SDKs — run: npm i @slack/socket-mode @slack/web-api");
  }

  const socket = new SocketModeClient({ appToken });
  const web = new WebClient(botToken);

  // Map our button grid to a Block Kit actions block (one row of buttons). Slack needs a text
  // block alongside it; the caller's text becomes a section above the actions.
  const blocksFor = (text: string, buttons?: Button[][]) => {
    const blocks: any[] = [{ type: 'section', text: { type: 'mrkdwn', text: text || ' ' } }];
    const flat = (buttons ?? []).flat();
    if (flat.length) {
      blocks.push({
        type: 'actions',
        elements: flat.slice(0, 5).map(b => ({ type: 'button', text: { type: 'plain_text', text: b.label }, action_id: b.data, value: b.data })),
      });
    }
    return blocks;
  };

  const transport: Transport = {
    platform: 'slack',
    maxLen: 3000,            // Slack accepts more, but ~3k keeps a section block readable
    minEditIntervalMs: 1100, // Slack Web API ~1 req/s per channel

    async start(onMessage: (m: Incoming) => void) {
      // Inbound messages (Events API delivered over the socket).
      socket.on('message', async ({ event, ack }: any) => {
        try { await ack?.(); } catch { /* best-effort */ }
        if (!event || event.subtype === 'bot_message' || event.bot_id) return; // ignore our own + other bots
        if (!event.text) return;
        onMessage({ platform: 'slack', chatId: String(event.channel), userId: String(event.user ?? ''), text: String(event.text) });
      });
      // Button taps.
      socket.on('interactive', async ({ body, ack }: any) => {
        try { await ack?.(); } catch { /* best-effort */ }
        if (body?.type !== 'block_actions') return;
        const action = body.actions?.[0];
        if (!action) return;
        onMessage({
          platform: 'slack',
          chatId: String(body.channel?.id ?? body.container?.channel_id ?? ''),
          userId: String(body.user?.id ?? ''),
          text: '',
          callbackData: String(action.action_id ?? action.value ?? ''),
        });
      });
      await socket.start();
      logger.info('slack bot online (socket mode)');
    },

    async stop() { try { await socket.disconnect(); } catch { /* already down */ } },

    async send(chatId: string, text: string, buttons?: Button[][]): Promise<MessageRef> {
      const r: any = await web.chat.postMessage({ channel: chatId, text: text || ' ', blocks: blocksFor(text, buttons) });
      return { id: String(r.ts ?? '') };
    },

    async edit(chatId: string, ref: MessageRef, text: string, buttons?: Button[][]): Promise<void> {
      await web.chat.update({ channel: chatId, ts: ref.id, text: text || ' ', blocks: blocksFor(text, buttons) });
    },
  };

  return transport;
}
