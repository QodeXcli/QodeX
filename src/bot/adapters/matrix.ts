/**
 * Matrix adapter — Transport over the Client-Server API. Zero extra dependencies.
 *
 * The homeserver is the one in MATRIX_HOMESERVER (https, or http on localhost).
 * The access token is the user's. This process does not run a homeserver and it
 * does not decrypt encrypted rooms. A backlog from the first sync is not replayed.
 */
import { randomBytes } from 'crypto';
import type { Transport, Incoming, MessageRef, Button } from '../types.js';
import { logger } from '../../utils/logger.js';

const API = '/_matrix/client/v3';

export function matrixHomeserver(raw: string): string | null {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return null; }
  if (url.username || url.password || url.search || url.hash) return null;
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;
  return url.origin;
}

export function isMatrixRoomId(id: string): boolean {
  return /^![^:\s]+:[^\s]+$/.test(id);
}

/** Follow https://spec.matrix.org .well-known/matrix/client. Failure keeps the given origin. */
export async function resolveMatrixBase(homeserver: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const origin = matrixHomeserver(homeserver);
  if (!origin) throw new Error('MATRIX_HOMESERVER must be https://your-server or http://127.0.0.1:port — no user, password, or path');
  if (!origin.startsWith('https:')) return origin;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 4000);
  try {
    const res = await fetchImpl(`${origin}/.well-known/matrix/client`, { signal: ac.signal });
    if (!res.ok) return origin;
    const body = await res.json().catch(() => null) as { 'm.homeserver'?: { base_url?: string } } | null;
    const delegated = matrixHomeserver(body?.['m.homeserver']?.base_url ?? '');
    return delegated ?? origin;
  } catch {
    return origin;
  } finally {
    clearTimeout(timer);
  }
}

export function eventsFromSync(payload: unknown, selfId: string): Incoming[] {
  const rooms = (payload as { rooms?: { join?: Record<string, unknown> } } | null)?.rooms?.join;
  if (!rooms) return [];
  const out: Incoming[] = [];
  for (const [roomId, room] of Object.entries(rooms)) {
    if (!isMatrixRoomId(roomId)) continue;
    const events = (room as { timeline?: { events?: unknown[] } }).timeline?.events;
    if (!Array.isArray(events)) continue;
    for (const ev of events) {
      const event = ev as { type?: string; sender?: string; content?: { msgtype?: string; body?: string; 'm.relates_to'?: { rel_type?: string } } };
      if (event.type !== 'm.room.message') continue;
      if (!event.sender || event.sender === selfId || !event.sender.startsWith('@')) continue;
      const content = event.content;
      if (!content || content.msgtype !== 'm.text' || typeof content.body !== 'string' || !content.body.trim()) continue;
      const rel = content['m.relates_to']?.rel_type;
      if (rel === 'm.replace' || rel === 'm.annotation') continue;
      out.push({ platform: 'matrix', chatId: roomId, userId: event.sender, text: content.body });
    }
  }
  return out;
}

function choiceLine(buttons?: Button[][]): string {
  const labels = buttons?.flat().map(b => b.label).filter(Boolean) ?? [];
  return labels.length ? `\n\n${labels.join(' · ')}` : '';
}

export function matrixTextBody(text: string, buttons?: Button[][]): { msgtype: 'm.text'; body: string } {
  return { msgtype: 'm.text', body: text + choiceLine(buttons) };
}

export function matrixReplaceBody(eventId: string, text: string, buttons?: Button[][]): Record<string, unknown> {
  const body = text + choiceLine(buttons);
  return {
    msgtype: 'm.text',
    body: `* ${body}`,
    'm.new_content': { msgtype: 'm.text', body },
    'm.relates_to': { rel_type: 'm.replace', event_id: eventId },
  };
}

export class MatrixTransport implements Transport {
  readonly platform = 'matrix' as const;
  readonly maxLen = 4000;
  readonly minEditIntervalMs = 1000;
  private base: string;
  private token: string;
  private fetchImpl: typeof fetch;
  private userId = '';
  private since = '';
  private running = false;
  private ac = new AbortController();

  constructor(opts: { base: string; token: string; fetchImpl?: typeof fetch }) {
    const base = matrixHomeserver(opts.base);
    if (!base) throw new Error('matrix base is not a homeserver origin');
    if (!opts.token.trim()) throw new Error('matrix access token is empty');
    this.base = base;
    this.token = opts.token.trim();
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async call(method: string, path: string, body?: unknown): Promise<any> {
    const res = await this.fetchImpl(`${this.base}${API}${path}`, {
      method,
      signal: this.ac.signal,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({})) as { error?: string; errcode?: string; user_id?: string; next_batch?: string; event_id?: string };
    if (!res.ok) {
      const err = data?.error || data?.errcode || `HTTP ${res.status}`;
      throw new Error(String(err));
    }
    return data;
  }

  async start(onMessage: (m: Incoming) => void): Promise<void> {
    const me = await this.call('GET', '/account/whoami');
    if (typeof me?.user_id !== 'string' || !me.user_id.startsWith('@')) {
      throw new Error('Matrix whoami did not return a user id');
    }
    this.userId = me.user_id;
    const first = await this.call('GET', '/sync?timeout=0');
    if (typeof first?.next_batch !== 'string' || !first.next_batch) {
      throw new Error('Matrix sync returned no next_batch');
    }
    this.since = first.next_batch;
    logger.info('matrix bot online', { user: this.userId });
    this.running = true;
    void this.loop(onMessage);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.ac.abort();
  }

  private async loop(onMessage: (m: Incoming) => void): Promise<void> {
    while (this.running) {
      try {
        const page = await this.call('GET', `/sync?timeout=30000&since=${encodeURIComponent(this.since)}`);
        if (typeof page?.next_batch === 'string') this.since = page.next_batch;
        for (const m of eventsFromSync(page, this.userId)) onMessage(m);
      } catch (e: any) {
        if (!this.running || e?.name === 'AbortError') return;
        logger.warn('matrix sync error', { err: e?.message });
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  private async sendEvent(roomId: string, body: unknown): Promise<MessageRef> {
    if (!isMatrixRoomId(roomId)) throw new Error('not a matrix room id');
    const txn = randomBytes(8).toString('hex');
    const data = await this.call('PUT', `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txn}`, body);
    if (typeof data?.event_id !== 'string') throw new Error('Matrix send returned no event id');
    return { id: data.event_id };
  }

  async send(chatId: string, text: string, buttons?: Button[][]): Promise<MessageRef> {
    return this.sendEvent(chatId, matrixTextBody(text, buttons));
  }

  async edit(chatId: string, ref: MessageRef, text: string, buttons?: Button[][]): Promise<void> {
    if (!ref.id.startsWith('$')) {
      await this.send(chatId, text, buttons);
      return;
    }
    await this.sendEvent(chatId, matrixReplaceBody(ref.id, text, buttons));
  }

  async typing(chatId: string): Promise<void> {
    if (!this.userId || !isMatrixRoomId(chatId)) return;
    await this.call('PUT', `/rooms/${encodeURIComponent(chatId)}/typing/${encodeURIComponent(this.userId)}`, {
      typing: true,
      timeout: 20000,
    }).catch(() => {});
  }
}
