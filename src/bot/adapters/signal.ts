/**
 * Signal adapter — self-hosted signal-cli, not an unofficial phone clone.
 *
 * Signal has no Telegram-style Bot API. The supported way to run a *your-number*
 * daemon is signal-cli (JSON-RPC). You control the process; we only speak RPC.
 *
 *   signal-cli -a +15551234567 daemon --tcp 127.0.0.1:7583
 *
 * Secrets / env: SIGNAL_ACCOUNT (+E164), SIGNAL_CLI_RPC (host:port, default
 * 127.0.0.1:7583). Optional SIGNAL_CLI_URL uses the HTTP REST wrapper instead.
 *
 * Signal has no inline buttons and cannot edit in place. Buttons are printed
 * as a numbered list (the gateway already accepts a typed "yes"/"1"). Edits
 * are delta follow-ups, same as WhatsApp.
 */

import * as net from 'net';
import type { Transport, Incoming, MessageRef, Button } from '../types.js';
import { logger } from '../../utils/logger.js';

export interface SignalOpts {
  account: string;
  rpcHost?: string;
  rpcPort?: number;
  restUrl?: string;
}

/** PURE — map a signal-cli receive payload to a chat turn. */
export function parseSignalReceive(payload: unknown): { from: string; text: string } | null {
  const env = (payload as any)?.envelope ?? (payload as any)?.params?.envelope ?? payload;
  const from = String(env?.sourceNumber ?? env?.source ?? env?.sourceName ?? '').trim();
  const text = String(env?.dataMessage?.message ?? env?.dataMessage?.reaction?.emoji ?? '').trim();
  if (!from || !text) return null;
  return { from, text };
}

export function formatSignalButtons(text: string, buttons?: Button[][]): string {
  const flat = (buttons ?? []).flat();
  if (!flat.length) return text;
  const lines = flat.map((b, i) => `  ${i + 1}. ${b.label}`);
  return `${text}\n\nReply with a number or the option name:\n${lines.join('\n')}`;
}

export function createSignalTransport(opts: SignalOpts): Transport {
  const account = opts.account.startsWith('+') ? opts.account : `+${opts.account}`;
  const host = opts.rpcHost ?? '127.0.0.1';
  const port = opts.rpcPort ?? 7583;
  const restUrl = opts.restUrl?.replace(/\/$/, '');
  let socket: net.Socket | null = null;
  let buf = '';
  let rpcId = 0;
  const pending = new Map<number, (v: any) => void>();
  const lastText = new Map<string, string>();
  let seq = 0;
  let onMsg: ((m: Incoming) => void) | null = null;
  let running = false;

  const emitLine = (line: string) => {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id != null && pending.has(Number(msg.id))) {
      pending.get(Number(msg.id))!(msg);
      pending.delete(Number(msg.id));
      return;
    }
    if (msg.method === 'receive' || msg.params?.envelope) {
      const hit = parseSignalReceive(msg.params ?? msg);
      if (hit && onMsg) {
        onMsg({ platform: 'signal', chatId: hit.from, userId: hit.from, text: hit.text });
      }
    }
  };

  const rpc = (method: string, params: Record<string, unknown>): Promise<any> => {
    if (!socket) return Promise.reject(new Error('signal-cli rpc is not connected'));
    const id = ++rpcId;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { pending.delete(id); reject(new Error(`signal-cli ${method} timed out`)); }, 15_000);
      pending.set(id, v => { clearTimeout(t); resolve(v); });
      socket!.write(JSON.stringify({ jsonrpc: '2.0', method, id, params }) + '\n');
    });
  };

  return {
    platform: 'signal',
    maxLen: 2000,
    minEditIntervalMs: 2200,

    async start(onMessage) {
      onMsg = onMessage;
      running = true;
      if (restUrl) {
        logger.info('signal rest receive loop', { restUrl });
        void pollRest(restUrl, account, onMessage, () => running);
        return;
      }
      socket = net.connect({ host, port });
      await new Promise<void>((resolve, reject) => {
        socket!.once('connect', () => resolve());
        socket!.once('error', err => reject(new Error(
          `signal-cli RPC at ${host}:${port} failed (${err.message}). Start it with: ` +
          `signal-cli -a ${account} daemon --tcp ${host}:${port}`,
        )));
      });
      socket.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        let idx: number;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (line) emitLine(line);
        }
      });
      socket.on('error', err => logger.warn('signal rpc error', { err: err.message }));
      logger.info('signal-cli rpc online', { account, host, port });
    },

    async stop() {
      running = false;
      onMsg = null;
      socket?.destroy();
      socket = null;
    },

    async send(chatId, text, buttons) {
      const body = formatSignalButtons(text, buttons);
      const to = chatId.startsWith('+') ? chatId : `+${chatId}`;
      if (restUrl) {
        const r = await fetch(`${restUrl}/v2/send`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: body, number: account, recipients: [to] }),
        });
        if (!r.ok) logger.warn('signal rest send failed', { status: r.status });
      } else {
        const res = await rpc('send', { account, recipient: [to], message: body });
        if (res?.error) logger.warn('signal send failed', { err: res.error?.message ?? res.error });
      }
      const id = `sig${++seq}`;
      lastText.set(id, text);
      return { id };
    },

    async edit(chatId, ref, text) {
      const prev = lastText.get(ref.id) ?? '';
      lastText.set(ref.id, text);
      const delta = text.startsWith(prev) ? text.slice(prev.length) : '';
      if (!delta.trim()) return;
      await this.send(chatId, delta);
    },
  };
}

async function pollRest(
  restUrl: string,
  account: string,
  onMessage: (m: Incoming) => void,
  still: () => boolean,
): Promise<void> {
  const encoded = encodeURIComponent(account);
  while (still()) {
    try {
      const r = await fetch(`${restUrl}/v1/receive/${encoded}`);
      if (!r.ok) { await sleep(2000); continue; }
      const data = await r.json();
      const rows = Array.isArray(data) ? data : [data];
      for (const row of rows) {
        const hit = parseSignalReceive(row);
        if (hit) onMessage({ platform: 'signal', chatId: hit.from, userId: hit.from, text: hit.text });
      }
    } catch {
      await sleep(2000);
    }
    await sleep(800);
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
