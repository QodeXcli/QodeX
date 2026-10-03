/**
 * Telegram adapter — Transport over the Bot API via long-polling. Zero new dependencies
 * (uses global fetch). All behaviour lives in the gateway; this only marshals bytes.
 *
 * Deliberately sends PLAIN text (no parse_mode): MarkdownV2 requires escaping a dozen special
 * characters and throws on any miss — a perennial bot bug. Code fences in the agent's output
 * stay literal and readable; we never risk a 400 on an unescaped character.
 */
import type { Transport, Incoming, MessageRef, Button } from '../types.js';
import { logger } from '../../utils/logger.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class TelegramTransport implements Transport {
  readonly platform = 'telegram' as const;
  readonly maxLen = 4096;
  readonly minEditIntervalMs = 1100; // Telegram allows ~1 edit/s per chat
  private offset = 0;
  private running = false;

  constructor(private token: string) {}

  private async api(method: string, body: unknown): Promise<any> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  private keyboard(buttons?: Button[][]) {
    if (!buttons) return {};
    return { reply_markup: { inline_keyboard: buttons.map(row => row.map(b => ({ text: b.label, callback_data: b.data }))) } };
  }

  async start(onMessage: (m: Incoming) => void): Promise<void> {
    const me = await this.api('getMe', {});
    if (!me.ok) throw new Error(`Telegram getMe failed: ${me.description ?? 'bad token'}`);
    logger.info('telegram bot online', { username: me.result?.username });
    this.running = true;
    void this.loop(onMessage);
  }

  async stop(): Promise<void> { this.running = false; }

  private async loop(onMessage: (m: Incoming) => void): Promise<void> {
    while (this.running) {
      try {
        const res = await this.api('getUpdates', { offset: this.offset, timeout: 30, allowed_updates: ['message', 'callback_query'] });
        if (!res.ok) { await sleep(2000); continue; }
        for (const u of res.result) {
          this.offset = u.update_id + 1;
          if (u.message?.text) {
            onMessage({ platform: 'telegram', chatId: String(u.message.chat.id), userId: String(u.message.from?.id), userName: u.message.from?.username, text: u.message.text });
          } else if (u.message?.voice || u.message?.audio) {
            // Voice memo → transcribe (local-first) → feed as text. Fire-and-forget so the
            // poll loop keeps flowing; failures reply with a note instead of crashing.
            void this.handleVoice(u.message, onMessage);
          } else if (u.callback_query) {
            const cq = u.callback_query;
            onMessage({ platform: 'telegram', chatId: String(cq.message?.chat?.id), userId: String(cq.from?.id), text: '', callbackData: cq.data, callbackId: cq.id });
          }
        }
      } catch (e: any) {
        logger.warn('telegram poll error', { err: e?.message });
        await sleep(2000);
      }
    }
  }

  async send(chatId: string, text: string, buttons?: Button[][]): Promise<MessageRef> {
    const r = await this.api('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true, ...this.keyboard(buttons) });
    return { id: String(r.result?.message_id ?? '') };
  }

  /** Download a voice/audio message, transcribe it (local-first), and emit it as a text turn. */
  private async handleVoice(message: any, onMessage: (m: Incoming) => void): Promise<void> {
    const chatId = String(message.chat.id);
    const fileId = message.voice?.file_id ?? message.audio?.file_id;
    const { promises: fs } = await import('fs');
    const os = await import('os');
    const path = await import('path');
    let tmp = '';
    try {
      const gf = await this.api('getFile', { file_id: fileId });
      const filePath = gf?.result?.file_path;
      if (!filePath) throw new Error('getFile returned no path');
      const dl = await fetch(`https://api.telegram.org/file/bot${this.token}/${filePath}`);
      if (!dl.ok) throw new Error(`download ${dl.status}`);
      const buf = Buffer.from(await dl.arrayBuffer());
      tmp = path.join(os.tmpdir(), `qodex-voice-${Date.now()}-${fileId.slice(-8)}.${filePath.split('.').pop() ?? 'oga'}`);
      await fs.writeFile(tmp, buf);
      const { transcribeAudio } = await import('../../audio/transcribe.js');
      const text = await transcribeAudio(tmp);
      if (!text) throw new Error('empty transcript');
      // Confirm what was heard, then run the agent on it.
      await this.api('sendMessage', { chat_id: chatId, text: `🎙️ “${text.slice(0, 300)}”` }).catch(() => {});
      onMessage({ platform: 'telegram', chatId, userId: String(message.from?.id), userName: message.from?.username, text });
    } catch (e: any) {
      logger.warn('voice transcription failed', { err: e?.message });
      await this.api('sendMessage', { chat_id: chatId, text: `🎙️ Couldn’t transcribe that (${e?.message ?? 'error'}). Set QODEX_TRANSCRIBE_CMD or OPENAI_API_KEY — or just type.` }).catch(() => {});
    } finally {
      if (tmp) { const { promises: fsp } = await import('fs'); await fsp.unlink(tmp).catch(() => {}); }
    }
  }

  async edit(chatId: string, ref: MessageRef, text: string, buttons?: Button[][]): Promise<void> {
    const r = await this.api('editMessageText', { chat_id: chatId, message_id: Number(ref.id), text, disable_web_page_preview: true, ...this.keyboard(buttons) });
    // "message is not modified" is benign — the pump already dedupes, but races can still hit it.
    if (!r.ok && !/not modified/i.test(r.description ?? '')) logger.warn('telegram edit failed', { err: r.description });
  }

  async ackCallback(id: string): Promise<void> { await this.api('answerCallbackQuery', { callback_query_id: id }); }
  async typing(chatId: string): Promise<void> { await this.api('sendChatAction', { chat_id: chatId, action: 'typing' }); }

  /** Register the native `/` command menu (Telegram clients show it as a tappable picker + autocomplete). */
  async setCommands(commands: { command: string; description: string }[]): Promise<void> {
    const r = await this.api('setMyCommands', { commands });
    if (!r.ok) logger.warn('telegram setMyCommands failed', { err: r.description });
  }

  /** Upload a local image (a preview screenshot) with an optional caption + buttons (multipart). */
  async sendPhoto(chatId: string, photoPath: string, caption?: string, buttons?: Button[][]): Promise<MessageRef> {
    const { readFile } = await import('fs/promises');
    const bytes = await readFile(photoPath);                          // throws → caller falls back to text
    const form = new FormData();
    form.append('chat_id', chatId);
    if (caption) form.append('caption', caption);
    if (buttons) form.append('reply_markup', JSON.stringify(this.keyboard(buttons).reply_markup));
    form.append('photo', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), 'preview.png');
    const res = await fetch(`https://api.telegram.org/bot${this.token}/sendPhoto`, { method: 'POST', body: form });
    const r: any = await res.json();
    if (!r.ok) { logger.warn('telegram sendPhoto failed', { err: r.description }); throw new Error(r.description ?? 'sendPhoto failed'); }
    return { id: String(r.result?.message_id ?? '') };
  }
}
