/**
 * Email adapter — IMAP in, one SMTP letter out.
 *
 * The user's own server. No Gmail OAuth and no webmail scraper. A stream of
 * edits becomes one letter after the text settles, because SMTP cannot edit.
 * The first poll records UIDNEXT and does not replay what was already there.
 */
import { randomBytes } from 'crypto';
import type { Button, Incoming, MessageRef, Transport } from '../types.js';
import { logger } from '../../utils/logger.js';
import { buildSmtpData, parseAddress, replySubject } from '../email/parse.js';
import { imapPoll, smtpSend, type ImapHit, type MailLogin } from '../email/wire.js';

interface Draft { to: string; text: string; timer: { cancel(): void }; }

export class EmailTransport implements Transport {
  readonly platform = 'email' as const;
  readonly maxLen = 8000;
  readonly minEditIntervalMs = 1500;
  private from: string;
  private cursor = 0;
  private primed = false;
  private running = false;
  private ac = new AbortController();
  private threads = new Map<string, { subject: string; messageId: string }>();
  private drafts = new Map<string, Draft>();
  private pollMs: number;
  private flushMs: number;
  private poll: (cursor: number, primed: boolean) => Promise<{ cursor: number; messages: ImapHit[] }>;
  private deliver: (msg: { to: string; subject: string; text: string; inReplyTo?: string }) => Promise<void>;
  private later: (fn: () => void, ms: number) => { cancel(): void };

  constructor(opts: {
    from: string;
    imap: MailLogin;
    smtp: MailLogin;
    pollMs?: number;
    flushMs?: number;
    poll?: EmailTransport['poll'];
    deliver?: EmailTransport['deliver'];
    later?: EmailTransport['later'];
  }) {
    const from = parseAddress(opts.from);
    if (!from) throw new Error('EMAIL_FROM is not an email address');
    this.from = from;
    this.pollMs = opts.pollMs ?? 10_000;
    this.flushMs = opts.flushMs ?? 1500;
    this.poll = opts.poll ?? ((cursor, primed) => imapPoll(opts.imap, cursor, primed));
    this.deliver = opts.deliver ?? (async msg => {
      const domain = this.from.split('@')[1] || 'localhost';
      const data = buildSmtpData({
        from: this.from,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        messageId: `<${randomBytes(8).toString('hex')}@${domain}>`,
        inReplyTo: msg.inReplyTo,
      });
      await smtpSend({ ...opts.smtp, from: this.from, to: msg.to, data });
    });
    this.later = opts.later ?? ((fn, ms) => {
      const timer = setTimeout(fn, ms);
      return { cancel: () => clearTimeout(timer) };
    });
  }

  async start(onMessage: (m: Incoming) => void): Promise<void> {
    const first = await this.poll(this.cursor, false);
    this.cursor = first.cursor;
    this.primed = true;
    this.running = true;
    logger.info('email bot online', { from: this.from });
    void this.loop(onMessage);
  }

  async stop(): Promise<void> {
    this.running = false;
    const pending = [...this.drafts.keys()];
    for (const id of pending) await this.flush(id);
    this.ac.abort();
  }

  private async loop(onMessage: (m: Incoming) => void): Promise<void> {
    while (this.running) {
      await this.sleep(this.pollMs);
      if (!this.running) return;
      try {
        const page = await this.poll(this.cursor, true);
        this.cursor = page.cursor;
        for (const message of page.messages) {
          if (message.from === this.from) continue;
          this.threads.set(message.from, { subject: message.subject, messageId: message.messageId });
          onMessage({ platform: 'email', chatId: message.from, userId: message.from, text: message.text });
        }
      } catch (err: any) {
        if (!this.running) return;
        logger.warn('email poll failed', { err: err?.message });
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(resolve, ms);
      this.ac.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }

  private shown(text: string, buttons?: Button[][]): string {
    const labels = buttons?.flat().map(b => b.label).filter(Boolean) ?? [];
    return labels.length ? `${text}\n\n${labels.join(' · ')}` : text;
  }

  private arm(id: string, to: string, text: string): void {
    const prev = this.drafts.get(id);
    prev?.timer.cancel();
    const timer = this.later(() => { void this.flush(id); }, this.flushMs);
    this.drafts.set(id, { to, text, timer });
  }

  private async flush(id: string): Promise<void> {
    const draft = this.drafts.get(id);
    if (!draft) return;
    draft.timer.cancel();
    this.drafts.delete(id);
    const who = parseAddress(draft.to);
    if (!who) {
      logger.warn('email send refused: bad recipient');
      return;
    }
    const thread = this.threads.get(who);
    try {
      await this.deliver({
        to: who,
        subject: replySubject(thread?.subject ?? ''),
        text: draft.text,
        inReplyTo: thread?.messageId || undefined,
      });
    } catch (err: any) {
      logger.warn('email send failed', { err: err?.message });
    }
  }

  async send(chatId: string, text: string, buttons?: Button[][]): Promise<MessageRef> {
    const id = randomBytes(6).toString('hex');
    this.arm(id, chatId, this.shown(text, buttons));
    return { id };
  }

  async edit(chatId: string, ref: MessageRef, text: string, buttons?: Button[][]): Promise<void> {
    this.arm(ref.id, chatId, this.shown(text, buttons));
  }
}
