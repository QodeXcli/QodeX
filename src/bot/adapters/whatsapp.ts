/**
 * WhatsApp adapter — official Cloud API only (Graph + webhook).
 *
 * No whatsapp-web.js / Baileys: those scrape WhatsApp Web, break ToS, and get
 * numbers banned. This adapter talks to graph.facebook.com like any Business app.
 *
 * Secrets ( ~/.qodex/.env ): WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID,
 * WHATSAPP_VERIFY_TOKEN. Optional WHATSAPP_APP_SECRET verifies webhook POSTs.
 *
 * WhatsApp cannot edit a message in place. StreamPump edits become *delta*
 * follow-ups so we do not reprint the whole answer every 2s.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { createHmac, timingSafeEqual } from 'crypto';
import type { Transport, Incoming, MessageRef, Button } from '../types.js';
import { logger } from '../../utils/logger.js';

const GRAPH = 'https://graph.facebook.com/v21.0';

export interface WhatsAppOpts {
  token: string;
  phoneNumberId: string;
  verifyToken: string;
  appSecret?: string;
  port?: number;
  host?: string;
}

export interface WhatsAppChange {
  from?: string;
  text?: string;
  buttonId?: string;
  buttonTitle?: string;
}

/** PURE — pull inbound turns out of a Cloud API webhook body. */
export function parseWhatsAppWebhook(body: unknown): WhatsAppChange[] {
  const out: WhatsAppChange[] = [];
  const entries = (body as any)?.entry;
  if (!Array.isArray(entries)) return out;
  for (const entry of entries) {
    const changes = entry?.changes;
    if (!Array.isArray(changes)) continue;
    for (const ch of changes) {
      const msgs = ch?.value?.messages;
      if (!Array.isArray(msgs)) continue;
      for (const m of msgs) {
        const from = m?.from ? String(m.from) : undefined;
        if (!from) continue;
        if (m.type === 'text' && m.text?.body) {
          out.push({ from, text: String(m.text.body) });
        } else if (m.type === 'interactive') {
          const btn = m.interactive?.button_reply ?? m.interactive?.list_reply;
          if (btn?.id || btn?.title) {
            out.push({
              from,
              text: String(btn.title ?? ''),
              buttonId: btn.id ? String(btn.id) : undefined,
              buttonTitle: btn.title ? String(btn.title) : undefined,
            });
          }
        }
      }
    }
  }
  return out;
}

export function verifyWhatsAppSignature(raw: string, header: string | undefined, appSecret: string): boolean {
  if (!header) return false;
  const got = header.startsWith('sha256=') ? header.slice(7) : header;
  const expect = createHmac('sha256', appSecret).update(raw).digest('hex');
  try {
    const a = Buffer.from(got, 'hex');
    const b = Buffer.from(expect, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function title20(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= 20 ? t : t.slice(0, 19) + '…';
}

export class WhatsAppTransport implements Transport {
  readonly platform = 'whatsapp' as const;
  readonly maxLen = 4096;
  readonly minEditIntervalMs = 2200;
  private server: Server | null = null;
  private lastText = new Map<string, string>();
  private seq = 0;

  constructor(private opts: WhatsAppOpts) {}

  private async graph(path: string, body: unknown): Promise<any> {
    const res = await fetch(`${GRAPH}/${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.opts.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  async start(onMessage: (m: Incoming) => void): Promise<void> {
    const port = this.opts.port ?? Number(process.env.WHATSAPP_WEBHOOK_PORT ?? 8787);
    const host = this.opts.host ?? '0.0.0.0';
    this.server = createServer((req, res) => void this.handleHttp(req, res, onMessage));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, host, () => resolve());
    });
    logger.info('whatsapp cloud api webhook listening', { host, port });
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (!s) return;
    await new Promise<void>(resolve => s.close(() => resolve()));
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse, onMessage: (m: Incoming) => void): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET') {
      const mode = url.searchParams.get('hub.mode');
      const token = url.searchParams.get('hub.verify_token');
      const challenge = url.searchParams.get('hub.challenge') ?? '';
      if (mode === 'subscribe' && token === this.opts.verifyToken) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(challenge);
        return;
      }
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }
    const raw = await readBody(req);
    if (this.opts.appSecret) {
      const sig = req.headers['x-hub-signature-256'];
      const header = Array.isArray(sig) ? sig[0] : sig;
      if (!verifyWhatsAppSignature(raw, header, this.opts.appSecret)) {
        res.writeHead(401);
        res.end('bad signature');
        return;
      }
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw || '{}'); } catch {
      res.writeHead(400);
      res.end('bad json');
      return;
    }
    for (const ch of parseWhatsAppWebhook(parsed)) {
      onMessage({
        platform: 'whatsapp',
        chatId: ch.from!,
        userId: ch.from!,
        text: ch.buttonId ? '' : (ch.text ?? ''),
        callbackData: ch.buttonId,
      });
    }
    res.writeHead(200);
    res.end('ok');
  }

  async send(chatId: string, text: string, buttons?: Button[][]): Promise<MessageRef> {
    const to = chatId.replace(/^\+/, '');
    const flat = (buttons ?? []).flat().slice(0, 3);
    const payload: any = { messaging_product: 'whatsapp', to };
    if (flat.length) {
      payload.type = 'interactive';
      payload.interactive = {
        type: 'button',
        body: { text: text.slice(0, 1024) || ' ' },
        action: {
          buttons: flat.map(b => ({
            type: 'reply',
            reply: { id: b.data.slice(0, 256), title: title20(b.label) },
          })),
        },
      };
    } else {
      payload.type = 'text';
      payload.text = { body: text || ' ' };
    }
    const r = await this.graph(`${this.opts.phoneNumberId}/messages`, payload);
    if (r?.error) logger.warn('whatsapp send failed', { err: r.error?.message });
    const id = String(r?.messages?.[0]?.id ?? `wa${++this.seq}`);
    this.lastText.set(id, text);
    return { id };
  }

  async edit(_chatId: string, ref: MessageRef, text: string): Promise<void> {
    const prev = this.lastText.get(ref.id) ?? '';
    this.lastText.set(ref.id, text);
    const delta = text.startsWith(prev) ? text.slice(prev.length) : '';
    if (!delta.trim()) return;
    await this.send(_chatId, delta);
  }

  async typing(): Promise<void> { /* Cloud API has no typing indicator */ }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
