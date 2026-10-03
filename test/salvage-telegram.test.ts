/**
 * Salvage of the stranded Telegram review (snapshot 99767a4 of wip/telegram-r,
 * whose agent died before committing). Each test is tagged with its ledger item
 * and checks the BEHAVIOR that review asked for against the current code — some
 * of it landed later in another form, the rest is ported alongside these tests.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { getEventListeners } from 'events';
import { TelegramApi, TelegramApiError, TelegramAbortError, type FetchLike, type TgUpdate } from '../src/channels/telegram/api.js';
import { TelegramPairingStore } from '../src/channels/telegram/pairing.js';
import { TelegramBot, type TelegramBotOptions, type TelegramMissionAdapter, type TelegramMissionApproval } from '../src/channels/telegram/bot.js';
import {
  escapeHtml, esc, truncate, htmlToPlain, approvalKeyboard, formatMissionStatus, formatSentinelNotice, strings,
} from '../src/channels/telegram/format.js';
import { buildTelegramCommand, readHiddenLine, type TelegramCommandDeps } from '../src/channels/telegram/command.js';
import { ApprovalBroker } from '../src/control/approvals.js';
import { getBus } from '../src/control/bus.js';

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0';
const OWNER = 1001;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

// ── fake Bot API (enforces the real text rules: valid UTF-8, ≤ 4096 after entity parsing) ──

interface Call { method: string; body: any; result?: any }

function validateText(body: any): Response | null {
  const text = String(body.text ?? '');
  const fail = (description: string) => new Response(JSON.stringify({ ok: false, error_code: 400, description }), { status: 400 });
  if (LONE_SURROGATE.test(text)) return fail('Bad Request: strings must be encoded in UTF-8');
  const visible = body.parse_mode === 'HTML' ? htmlToPlain(text) : text;
  if (visible.length > 4096) return fail('Bad Request: message is too long');
  return null;
}

class FakeTelegram {
  calls: Call[] = [];
  scripted: Array<() => Response> = [];
  private queue: TgUpdate[] = [];
  private waiters: Array<() => void> = [];
  private msgId = 500;
  private updateId = 1;

  fetch: FetchLike = async (url, init = {}) => {
    const method = url.split('/').pop()!;
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    const call: Call = { method, body };
    this.calls.push(call);
    const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    switch (method) {
      case 'getMe': return ok({ id: 999, is_bot: true, first_name: 'QodeX', username: 'qx_test_bot' });
      case 'getUpdates': {
        if (this.scripted.length) return this.scripted.shift()!();
        if (body.timeout === 0) return ok([]);
        await this.waitForUpdates(init.signal ?? undefined);
        return ok(this.queue.splice(0));
      }
      case 'sendMessage': {
        const bad = validateText(body);
        if (bad) return bad;
        call.result = { message_id: this.msgId++, date: Math.floor(Date.now() / 1000), chat: { id: Number(body.chat_id), type: 'private' }, text: body.text };
        return ok(call.result);
      }
      case 'editMessageText': {
        const bad = validateText(body);
        return bad ?? ok(true);
      }
      case 'answerCallbackQuery':
      case 'deleteWebhook':
        return ok(true);
      default:
        return new Response(JSON.stringify({ ok: false, error_code: 404, description: 'Not Found' }), { status: 404 });
    }
  };

  private waitForUpdates(signal?: AbortSignal): Promise<void> {
    if (this.queue.length) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(() => { signal?.removeEventListener('abort', onAbort); resolve(); });
    });
  }

  push(u: Omit<TgUpdate, 'update_id'>): void {
    this.queue.push({ update_id: this.updateId++, ...u } as TgUpdate);
    for (const f of this.waiters.splice(0)) f();
  }

  text(chatId: number, text: string, opts: { username?: string; replyTo?: number; lang?: string } = {}): void {
    this.push({
      message: {
        message_id: this.msgId++,
        date: Math.floor(Date.now() / 1000),
        chat: { id: chatId, type: 'private' },
        from: { id: chatId, first_name: 'Alice', username: opts.username ?? 'alice', language_code: opts.lang ?? 'en' },
        text,
        reply_to_message: opts.replyTo !== undefined ? { message_id: opts.replyTo, date: 0, chat: { id: chatId, type: 'private' } } : undefined,
      },
    });
  }

  callback(chatId: number, data: string, messageId: number): void {
    this.push({
      callback_query: {
        id: `cq${this.updateId}`,
        from: { id: chatId, first_name: 'X', username: 'alice' },
        message: { message_id: messageId, date: 0, chat: { id: chatId, type: 'private' }, text: 'card' },
        data,
      },
    });
  }

  sent(chatId?: number): Call[] {
    return this.calls.filter((c) => c.method === 'sendMessage' && (chatId === undefined || c.body.chat_id === chatId));
  }
  of(method: string): Call[] {
    return this.calls.filter((c) => c.method === method);
  }
}

async function waitUntil<T>(fn: () => T | undefined | null | false, timeoutMs = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function fakeMissions(over: Partial<TelegramMissionAdapter> = {}) {
  const a = {
    resolved: [] as Array<[string, string, string]>,
    approvals: [] as TelegramMissionApproval[],
    async list() { return []; },
    async start() { return { id: 'm_new', status: 'planning' }; },
    async cancel() { return true; },
    async status() { return null; },
    async pendingApprovals() { return a.approvals; },
    async resolveApproval(id: string, answer: string, by: string) {
      a.resolved.push([id, answer, by]);
      const had = a.approvals.some((x) => x.id === id);
      a.approvals = a.approvals.filter((x) => x.id !== id);
      return had;
    },
    ...over,
  };
  return a as TelegramMissionAdapter & typeof a;
}

let dir: string;
let tg: FakeTelegram;
let pairing: TelegramPairingStore;
let broker: ApprovalBroker;
let sleeps: number[];

async function pairChat(chatId = OWNER, username = 'alice'): Promise<void> {
  const { code } = await pairing.createPairingCode();
  expect((await pairing.consumeCode(code, { chatId, username, lang: 'en' })).ok).toBe(true);
}

function newBot(opts: Partial<TelegramBotOptions> = {}): TelegramBot {
  return new TelegramBot({
    api: new TelegramApi({ token: TOKEN, fetch: tg.fetch }),
    pairing,
    broker,
    tickMs: 20,
    sleep: async (ms) => { sleeps.push(ms); },
    random: () => 0.5,
    log: () => {},
    ...opts,
  });
}

const bots: TelegramBot[] = [];
async function startBot(opts: Partial<TelegramBotOptions> = {}): Promise<TelegramBot> {
  const b = newBot(opts);
  bots.push(b);
  await b.start();
  return b;
}

beforeEach(async () => {
  for (const b of bots.splice(0)) await b.stop();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-tg-salvage-'));
  tg = new FakeTelegram();
  pairing = new TelegramPairingStore({ file: path.join(dir, 'telegram.json') });
  broker = new ApprovalBroker();
  sleeps = [];
  getBus().reset();
});

// ── api.ts ───────────────────────────────────────────────────────────────────

describe('salvage: api', () => {
  const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });

  it('A1: a raw MESSAGE_TOO_LONG description counts as too long', () => {
    expect(new TelegramApiError({ method: 'sendMessage', status: 400, description: 'Bad Request: message is too long' }).isTooLong).toBe(true);
    expect(new TelegramApiError({ method: 'sendMessage', status: 400, description: 'Bad Request: MESSAGE_TOO_LONG' }).isTooLong).toBe(true);
    expect(new TelegramApiError({ method: 'sendMessage', status: 400, description: 'Bad Request: chat not found' }).isTooLong).toBe(false);
  });

  it('A2: accepts the positional getUpdates(offset, timeout, signal) form', async () => {
    const bodies: any[] = [];
    const api = new TelegramApi({ token: TOKEN, fetch: async (_u, init) => { bodies.push(JSON.parse(String(init?.body))); return ok([]); } });
    await api.getUpdates(42, 0);
    expect(bodies[0]).toEqual({ offset: 42, timeout: 0 });
    const ac = new AbortController();
    ac.abort();
    expect(await api.getUpdates(undefined, 25, ac.signal).catch((e) => e)).toBeInstanceOf(TelegramAbortError);
  });

  it('A3: caps callback answers without splitting a surrogate pair', async () => {
    const bodies: any[] = [];
    const api = new TelegramApi({ token: TOKEN, fetch: async (_u, init) => { bodies.push(JSON.parse(String(init?.body))); return ok(true); } });
    await api.answerCallbackQuery('cq', { text: 'a'.repeat(199) + '😀😀' });
    expect(bodies[0].text).not.toMatch(LONE_SURROGATE);
    expect(bodies[0].text.length).toBeLessThanOrEqual(200);
  });
});

// ── format.ts ────────────────────────────────────────────────────────────────

describe('salvage: format', () => {
  it('F1: escapeHtml never passes a lone surrogate through (Telegram rejects invalid UTF-8)', () => {
    expect(escapeHtml('broken \ud83d title')).not.toMatch(LONE_SURROGATE);
    expect(escapeHtml('tail \ude00')).not.toMatch(LONE_SURROGATE);
    expect(escapeHtml('ok 😀 <b>')).toBe('ok 😀 &lt;b&gt;');
    // The plain-text fallback (bot send/edit) is well-formed too, at the same length.
    expect(htmlToPlain('<b>x</b> \ud83d y')).not.toMatch(LONE_SURROGATE);
    expect(htmlToPlain('<b>x</b> \ud83d y')).toHaveLength(5);
  });

  it('F2: truncate never cuts a surrogate pair', () => {
    expect(truncate('aaaaaaaa😀b', 10)).not.toMatch(LONE_SURROGATE);
    expect(esc('x'.repeat(2998) + '😀😀', 3000)).not.toMatch(LONE_SURROGATE);
    for (let n = 1; n < 12; n++) expect(truncate('😀'.repeat(8), n)).not.toMatch(LONE_SURROGATE);
  });

  it('F6: never emits an empty keyboard row', () => {
    expect(approvalKeyboard('ap_x', [], 'en').inline_keyboard).toEqual([]);
  });

  it('F7: keeps a worst-case mission status within 4096 characters after entity parsing', () => {
    const out = formatMissionStatus({
      id: 'm_big', goal: 'g&'.repeat(1000), status: 'failed',
      steps: Array.from({ length: 15 }, (_, i) => ({ title: `step ${i} ${'<x>'.repeat(100)}`, status: 'done' })),
      milestones: Array.from({ length: 8 }, () => 'm'.repeat(400)),
      liveUrl: 'https://live.example/' + 'u'.repeat(500),
      error: 'e'.repeat(3000),
      report: 'r'.repeat(6000),
      pendingApprovals: 2,
      costUsd: 1.5,
    }, 'fa');
    expect(htmlToPlain(out).length).toBeLessThanOrEqual(4096);
    expect(out).toContain('m_big');
    expect(out).toContain(strings('fa').report); // the report still gets room
    expect(out).toContain('… +۳'); // steps beyond the cap are counted, not dropped silently
    const small = formatMissionStatus({ id: 'm1', goal: 'g', status: 'running', report: 'done & dusted' }, 'en');
    expect(small).toContain('done &amp; dusted');
  });

  it('F8: recognises a Sentinel deny decision nested under `decision`', () => {
    const n = formatSentinelNotice('decision', {
      decision: { action: 'deny', classification: { category: 'payment', summary: 'pay on shaparak.ir', risk: 'critical' }, message: 'x' },
      tool: 'browser_click',
    }, 'en');
    expect(n?.text).toContain('Sentinel blocked');
    expect(n?.text).toContain('pay on shaparak.ir');
    expect(formatSentinelNotice('decision', { decision: { action: 'allow', classification: {} } }, 'en')).toBeNull();
  });
});

// ── bot.ts ───────────────────────────────────────────────────────────────────

describe('salvage: bot', () => {
  it('B1: a card from a previous bot process can never answer a different approval (no alias reuse)', async () => {
    await pairChat();
    const missions = fakeMissions();
    const idA = 'mission:m_1:step-2:approval-1'; // contains ':' → needs a short alias
    missions.approvals = [{ id: idA, missionId: 'm_1', prompt: 'Buy item A?', options: ['yes', 'no'], category: 'purchase' }];
    const first = await startBot({ missions });
    const cardA = await waitUntil(() => tg.sent(OWNER).find((c) => c.body.reply_markup));
    const dataA = cardA.body.reply_markup.inline_keyboard[0][0].callback_data as string;
    expect(dataA.startsWith('ap:~')).toBe(true);
    expect(Buffer.byteLength(dataA)).toBeLessThanOrEqual(64);
    await first.stop();

    // A was answered elsewhere; a DIFFERENT approval is pending when the bot restarts.
    missions.approvals = [{ id: 'mission:m_2:step-1:approval-1', missionId: 'm_2', prompt: 'Pay for item B?', options: ['yes', 'no'], category: 'payment' }];
    await startBot({ missions });
    await waitUntil(() => tg.sent(OWNER).filter((c) => c.body.reply_markup).length === 2);
    tg.callback(OWNER, dataA, cardA.result.message_id);
    const ack = await waitUntil(() => tg.of('answerCallbackQuery')[0]);
    expect(ack.body.text).toContain('no longer pending');
    expect(missions.resolved).toEqual([]);
  });

  it('B2: a typed reply with Arabic letter forms or trailing punctuation still answers the card', async () => {
    await pairChat();
    await startBot();
    const p1 = broker.request({ prompt: 'Approve?', options: ['yes', 'no'], timeoutMs: 5000 });
    const c1 = await waitUntil(() => tg.sent(OWNER).find((c) => c.body.reply_markup && c.result));
    tg.text(OWNER, 'yes.', { replyTo: c1.result.message_id });
    expect(await p1).toEqual({ answer: 'yes', by: 'telegram' });
    const p2 = broker.request({ prompt: 'Approve again?', options: ['yes', 'no'], timeoutMs: 5000 });
    const c2 = await waitUntil(() => tg.sent(OWNER).filter((c) => c.body.reply_markup && c.result)[1]);
    tg.text(OWNER, 'تاييد!', { replyTo: c2.result.message_id }); // Arabic-keyboard ي
    expect(await p2).toEqual({ answer: 'yes', by: 'telegram' });
  });

  it('B3: does not leak abort listeners on the caller signal across start/stop', async () => {
    const ac = new AbortController();
    const b = newBot({ tickMs: 60_000 });
    for (let i = 0; i < 3; i++) {
      await b.start(ac.signal);
      await b.stop();
    }
    expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0);
  });

  it('B4: stop() during start-up resolves only once the bot is fully detached', async () => {
    await pairChat();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const missions = fakeMissions({ async pendingApprovals() { await gate; return []; } });
    const b = newBot({ missions, tickMs: 60_000 });
    const started = b.start().catch((e) => e);
    await waitUntil(() => broker.channelNames().length === 1);
    const stopping = b.stop();
    setTimeout(release, 30);
    await stopping;
    expect(b.isRunning()).toBe(false);
    expect(broker.channelNames()).toEqual([]);
    await started;
    await new Promise((res) => setTimeout(res, 30));
    expect(b.isRunning()).toBe(false);
    expect(broker.channelNames()).toEqual([]);
  });

  it('B5: survives a malformed getUpdates result (backs off instead of dying or spinning)', async () => {
    await pairChat();
    tg.scripted.push(() => new Response(JSON.stringify({ ok: true, result: { weird: true } }), { status: 200 }));
    const b = await startBot();
    tg.text(OWNER, '/help');
    await waitUntil(() => tg.sent(OWNER).length === 1);
    expect(b.isRunning()).toBe(true);
    expect(sleeps).toEqual([1000]);
  });

  it('B6: an in-flight tick cannot re-register the approval channel after stop()', async () => {
    await pairChat();
    let gateOn = false;
    let release: (() => void) | null = null;
    class SlowPairing extends TelegramPairingStore {
      override async listChats() {
        if (gateOn) await new Promise<void>((r) => { release = r; });
        return super.listChats();
      }
    }
    const b = await startBot({ pairing: new SlowPairing({ file: path.join(dir, 'telegram.json') }), tickMs: 60_000 });
    expect(broker.channelNames()).toEqual(['telegram']);
    gateOn = true;
    const t = b.tick();
    await waitUntil(() => release !== null);
    await b.stop();
    expect(broker.channelNames()).toEqual([]);
    gateOn = false;
    release!();
    await t;
    expect(broker.channelNames()).toEqual([]);
    expect(broker.hasRemoteChannel()).toBe(false);
  });

  it('B6b: a tick interrupted by stop() sends nothing afterwards', async () => {
    await pairChat();
    let calls = 0;
    let gateAt = -1;
    let release: (() => void) | null = null;
    class SlowPairing extends TelegramPairingStore {
      override async listChats() {
        if (++calls === gateAt) await new Promise<void>((r) => { release = r; });
        return super.listChats();
      }
    }
    const base = tg.fetch;
    let failCard = true;
    tg.fetch = async (url, init) => {
      if (failCard && url.endsWith('/sendMessage') && JSON.parse(String(init?.body)).reply_markup) {
        failCard = false; // the first card fails → a retry is due on the next tick
        return new Response('<html>502</html>', { status: 502, statusText: 'Bad Gateway' });
      }
      return base(url, init);
    };
    let feed = false;
    const missions = fakeMissions({
      async eventsSince(after: number | null) {
        if (after === null || !feed) return { events: [], cursor: 0 };
        return { events: [{ id: 1, missionId: 'm_done', type: 'completed', data: {} }], cursor: 1 };
      },
    });
    missions.approvals = [{ id: 'ma_1', missionId: 'm_1', prompt: 'Pay?', options: ['yes', 'no'] }];
    let skew = 0;
    const b = await startBot({ pairing: new SlowPairing({ file: path.join(dir, 'telegram.json') }), missions, tickMs: 60_000, now: () => Date.now() + skew });
    expect(failCard).toBe(false);
    feed = true;
    skew += 61_000;
    gateAt = calls + 2; // refreshChannel, then the retry's lookup → held while we stop
    const t = b.tick();
    await waitUntil(() => release !== null);
    const before = tg.sent().length;
    await b.stop();
    release!();
    await t;
    await new Promise((res) => setTimeout(res, 30));
    expect(tg.sent().length).toBe(before); // no retried card, no mission notice from a stopped bot
  });

  it('B7: tells already-paired chats when a new chat pairs', async () => {
    await pairChat();
    await startBot();
    const { code } = await pairing.createPairingCode();
    tg.text(2002, `/pair ${code}`, { username: 'mallory' });
    await waitUntil(() => tg.sent(2002).length === 1);
    const alert = await waitUntil(() => tg.sent(OWNER)[0]);
    expect(alert.body.text).toContain('@mallory');
    expect(alert.body.text).toContain('qodex telegram unpair 2002');
  });

  it('B8: does not leave a live card for an approval that ended before it was delivered', async () => {
    await pairChat();
    await startBot();
    const ac = new AbortController();
    ac.abort();
    const r = await broker.request({ prompt: 'Pay 5,000,000 Rial?', options: ['yes', 'no'], category: 'payment', signal: ac.signal });
    expect(r.by).toBe('abort');
    await new Promise((res) => setTimeout(res, 80));
    for (const c of tg.sent(OWNER).filter((x) => x.body.reply_markup && x.result)) {
      expect(tg.of('editMessageText').some((e) => e.body.message_id === c.result.message_id)).toBe(true);
    }
  });

  it('B9: retries an approval card whose delivery failed with a transient 502', async () => {
    await pairChat();
    const base = tg.fetch;
    let failures = 0;
    tg.fetch = async (url, init) => {
      if (url.endsWith('/sendMessage') && JSON.parse(String(init?.body)).reply_markup && failures < 2) {
        failures++;
        return new Response('<html>502 Bad Gateway</html>', { status: 502, statusText: 'Bad Gateway' });
      }
      return base(url, init);
    };
    await startBot();
    const pr = broker.request({ prompt: 'Place the order?', options: ['yes', 'no'], category: 'purchase', timeoutMs: 10_000 });
    const card = await waitUntil(() => tg.sent(OWNER).find((c) => c.body.reply_markup && c.result));
    expect(failures).toBe(2);
    tg.callback(OWNER, `ap:${broker.pending()[0].id}:0`, card.result.message_id);
    expect(await pr).toEqual({ answer: 'yes', by: 'telegram' });
    await new Promise((res) => setTimeout(res, 60));
    expect(tg.sent(OWNER).filter((c) => c.body.reply_markup && c.result)).toHaveLength(1);
  });

  it('B9b: a card that reached one paired chat but failed for another is retried for that chat', async () => {
    await pairChat(OWNER, 'alice');
    await pairChat(2002, 'bob');
    const base = tg.fetch;
    let failures = 0;
    tg.fetch = async (url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (url.endsWith('/sendMessage') && body.reply_markup && body.chat_id === 2002 && failures < 2) {
        failures++;
        return new Response('<html>502 Bad Gateway</html>', { status: 502, statusText: 'Bad Gateway' });
      }
      return base(url, init);
    };
    await startBot();
    const pr = broker.request({ prompt: 'Place the order?', options: ['yes', 'no'], category: 'purchase', timeoutMs: 10_000 });
    await waitUntil(() => tg.sent(OWNER).find((c) => c.body.reply_markup && c.result));
    const bobCard = await waitUntil(() => tg.sent(2002).find((c) => c.body.reply_markup && c.result));
    expect(failures).toBe(2);
    expect(tg.sent(OWNER).filter((c) => c.body.reply_markup && c.result)).toHaveLength(1); // no duplicate for alice
    tg.callback(2002, `ap:${broker.pending()[0].id}:1`, bobCard.result.message_id);
    expect(await pr).toEqual({ answer: 'no', by: 'telegram' });
  });

  it('B9c: gives up on a chat that keeps failing instead of resending the card every tick', async () => {
    await pairChat();
    const base = tg.fetch;
    let blocked = 0;
    let unblocked = false;
    tg.fetch = async (url, init) => {
      if (!unblocked && url.endsWith('/sendMessage') && JSON.parse(String(init?.body)).reply_markup) {
        blocked++;
        return new Response(JSON.stringify({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }), { status: 403 });
      }
      return base(url, init);
    };
    let skew = 0; // jump the bot's clock past every backoff
    const missions = fakeMissions();
    missions.approvals = [{ id: 'ma_blocked', missionId: 'm_1', prompt: 'Pay?', options: ['yes', 'no'] }];
    const logs: string[] = [];
    await startBot({ missions, now: () => Date.now() + skew, log: (_l, m) => logs.push(m) });
    for (let i = 0; i < 14; i++) { skew += 61_000; await new Promise((r) => setTimeout(r, 40)); }
    expect(blocked).toBe(8);
    expect(logs.filter((l) => l.includes('giving up delivering approval ma_blocked'))).toHaveLength(1);
    // /approvals still re-sends it on demand.
    unblocked = true;
    tg.text(OWNER, '/approvals');
    await waitUntil(() => tg.sent(OWNER).find((c) => c.body.reply_markup && c.result));
  });

  it('B10: a failed mission-approval write keeps the card answerable', async () => {
    await pairChat();
    const missions = fakeMissions();
    missions.approvals = [{ id: 'ma_err', missionId: 'm_1', prompt: 'Submit the order?', options: ['yes', 'no'], category: 'purchase' }];
    const realResolve = missions.resolveApproval;
    let fail = true;
    missions.resolveApproval = async (id, answer, by) => {
      if (fail) throw new Error('SQLITE_BUSY: database is locked');
      return realResolve(id, answer, by);
    };
    await startBot({ missions });
    const card = await waitUntil(() => tg.sent(OWNER).find((c) => c.body.reply_markup));
    tg.callback(OWNER, 'ap:ma_err:0', card.result.message_id);
    const ack = await waitUntil(() => tg.of('answerCallbackQuery')[0]);
    expect(ack.body.text).not.toContain('no longer pending');
    expect(ack.body.text).toMatch(/try again/i);
    await new Promise((res) => setTimeout(res, 60));
    expect(tg.of('editMessageText')).toHaveLength(0);
    fail = false;
    tg.callback(OWNER, 'ap:ma_err:0', card.result.message_id);
    await waitUntil(() => missions.resolved.length === 1);
    const edit = await waitUntil(() => tg.of('editMessageText')[0]);
    expect(edit.body.text).toContain('✅ Approved');
  });

  it('B11: a mission approval without options still gets yes/no buttons and resolves', async () => {
    await pairChat();
    const missions = fakeMissions();
    missions.approvals = [{ id: 'ma_noopt', missionId: 'm_1', prompt: 'Continue?', options: [], category: 'other' }];
    await startBot({ missions });
    const card = await waitUntil(() => tg.sent(OWNER).find((c) => c.body.reply_markup && c.result));
    expect(card.body.reply_markup.inline_keyboard[0].map((b: any) => b.callback_data)).toEqual(['ap:ma_noopt:0', 'ap:ma_noopt:1']);
    tg.callback(OWNER, 'ap:ma_noopt:1', card.result.message_id);
    await waitUntil(() => missions.resolved.length === 1);
    expect(missions.resolved[0][1]).toBe('no');
  });

  it('B12: /status <id> with a huge mission and a reply hint listing very many options still arrive', async () => {
    await pairChat();
    const missions = fakeMissions({
      async status(id: string) {
        return {
          id, goal: 'g'.repeat(2000), status: 'failed',
          steps: Array.from({ length: 15 }, (_, i) => ({ title: `step ${i} ${'x'.repeat(300)}`, status: 'done' })),
          milestones: Array.from({ length: 8 }, () => 'm'.repeat(400)),
          liveUrl: 'https://live.example/' + 'u'.repeat(500),
          error: 'e'.repeat(3000),
          report: 'r'.repeat(6000),
        };
      },
    });
    await startBot({ missions });
    tg.text(OWNER, '/status m_big');
    const reply = await waitUntil(() => tg.sent(OWNER).find((c) => c.result));
    expect(reply.body.text).toContain('m_big');

    const options = ['yes', 'no', ...Array.from({ length: 150 }, (_, i) => `option-number-${i}-${'z'.repeat(30)}`)];
    const pr = broker.request({ prompt: 'Pick one', options, timeoutMs: 5000 });
    const card = await waitUntil(() => tg.sent(OWNER).find((c) => c.body.reply_markup && c.result));
    tg.text(OWNER, 'hmm, not sure', { replyTo: card.result.message_id });
    await waitUntil(() => tg.sent(OWNER).filter((c) => c.result).length === 3);
    broker.resolve(broker.pending()[0].id, 'no', 'test');
    await pr;
  });

  it('B13: a mission card with an emoji at the truncation boundary is still delivered (valid UTF-8)', async () => {
    await pairChat();
    const missions = fakeMissions();
    missions.approvals = [{ id: 'ma_emoji', missionId: 'm_1', prompt: 'a'.repeat(2998) + '😀😀 tail', options: ['yes', 'no'], category: 'send' }];
    await startBot({ missions });
    const card = await waitUntil(() => tg.sent(OWNER).find((c) => c.body.reply_markup && c.result));
    expect(card.body.text).not.toMatch(LONE_SURROGATE);
  });
});

// ── command.ts / index.ts ────────────────────────────────────────────────────

describe('salvage: command + process singleton', () => {
  let pairingFile: string;
  const longPoll: FetchLike = async (url, init) => {
    const method = url.split('/').pop()!;
    const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    if (method === 'getMe') return ok({ id: 999, is_bot: true, first_name: 'QodeX', username: 'qx_test_bot' });
    if (method === 'getUpdates' && JSON.parse(String(init?.body)).timeout > 0) {
      return new Promise<Response>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    }
    if (method === 'getUpdates') return ok([]);
    if (method === 'getWebhookInfo') return ok({ url: '' });
    return ok(true);
  };

  function harness(over: Partial<TelegramCommandDeps> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const exits: number[] = [];
    const deps: TelegramCommandDeps = {
      fetch: longPoll,
      pairingFile,
      env: { TELEGRAM_BOT_TOKEN: TOKEN },
      print: (l) => out.push(l),
      printErr: (l) => err.push(l),
      exit: (c) => { exits.push(c); },
      saveSecret: async () => '/home/u/.qodex/.env',
      loadConfig: async () => ({}),
      readSecret: async () => TOKEN,
      ...over,
    };
    const run = (...args: string[]) => buildTelegramCommand(deps).parseAsync(args, { from: 'user' });
    return { out, err, exits, run, all: () => [...out, ...err].join('\n') };
  }

  beforeEach(async () => {
    pairingFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'qx-tg-salvage-cmd-')), 'telegram.json');
  });

  it('C1: readHiddenLine returns the first line of a pipe that stays open (no wait for EOF)', async () => {
    const input = new PassThrough();
    const p = readHiddenLine('Bot token: ', input as any, new PassThrough() as any);
    input.write(`${TOKEN}\nsomething else`);
    const r = await Promise.race([p, new Promise((res) => setTimeout(() => res('TIMEOUT'), 1000))]);
    expect(r).toBe(TOKEN);
    input.destroy();

    const input2 = new PassThrough();
    const p2 = readHiddenLine('Bot token: ', input2 as any, new PassThrough() as any);
    input2.end(TOKEN);
    expect(await p2).toBe(TOKEN);
  });

  it('C2: setup never prints a token typed at the hidden prompt, even on an unexpected error', async () => {
    const h = harness({
      readSecret: async () => TOKEN,
      saveSecret: async () => { throw new Error(`EACCES: cannot write TELEGRAM_BOT_TOKEN=${TOKEN}`); },
    });
    await h.run('setup');
    expect(h.exits).toEqual([1]);
    expect(h.all()).not.toContain(TOKEN);
  });

  it('C3: refuses to mint a pairing code without a terminal (an agent shell must not get one)', async () => {
    const h = harness({ isInteractive: () => false } as Partial<TelegramCommandDeps>);
    await h.run('pair', '--json');
    expect(h.exits).toEqual([1]);
    expect(h.err.join('\n')).toContain('[TELEGRAM_PAIR_NEEDS_TERMINAL]');
    expect(h.out.join('\n')).not.toMatch(/\d{6}/);
    expect(await new TelegramPairingStore({ file: pairingFile }).pendingCodeCount()).toBe(0);
  });

  it('C4: start prints no pairing code when there is no terminal', async () => {
    const h = harness({ isInteractive: () => false } as Partial<TelegramCommandDeps>);
    const run = h.run('start');
    await waitUntil(() => h.out.join('\n').includes('Missions:'));
    const { stopTelegramBot } = await import('../src/channels/telegram/index.js');
    await stopTelegramBot();
    await run;
    const text = h.all();
    expect(text).toContain('@qx_test_bot is running');
    expect(text).not.toMatch(/start=\d{6}/);
    expect(text).not.toMatch(/\/pair \d{6}/);
    expect(text).toContain('qodex telegram pair');
    expect(await new TelegramPairingStore({ file: pairingFile }).pendingCodeCount()).toBe(0);
  });

  it('I1: stopTelegramBot() during start-up stops the bot that was still starting', async () => {
    const { startTelegramBot, stopTelegramBot, getTelegramBot, telegramSlashCommand } = await import('../src/channels/telegram/index.js');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow: FetchLike = async (url, init) => {
      if (url.endsWith('/getMe')) await gate;
      return longPoll(url, init);
    };
    const starting = startTelegramBot({ config: {}, env: { TELEGRAM_BOT_TOKEN: TOKEN }, pairingFile, fetch: slow }).catch((e) => e);
    const stopping = telegramSlashCommand('stop', { config: {}, env: { TELEGRAM_BOT_TOKEN: TOKEN }, pairingFile, fetch: slow });
    setTimeout(release, 20);
    expect(await stopping).toContain('stopped');
    const h = await starting;
    try {
      expect(getTelegramBot()).toBeNull();
      if (h && !(h instanceof Error)) expect(h.bot.isRunning()).toBe(false);
    } finally {
      await stopTelegramBot();
    }
  });
});
