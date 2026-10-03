import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TelegramApi, type FetchLike, type TgUpdate } from '../src/channels/telegram/api.js';
import { TelegramPairingStore } from '../src/channels/telegram/pairing.js';
import { TelegramBot, type TelegramBotOptions, type TelegramMissionAdapter, type TelegramMissionApproval } from '../src/channels/telegram/bot.js';
import { htmlToPlain } from '../src/channels/telegram/format.js';
import { ApprovalBroker } from '../src/control/approvals.js';
import { getBus } from '../src/control/bus.js';
import { registerStopHandler } from '../src/control/emergency-stop.js';
import type { BrowserManager } from '../src/tools/browser/types.js';
import { MissionStore } from '../src/missions/store.js';
import { createTelegramMissionAdapter } from '../src/missions/telegram-adapter.js';
import { resolveBrowserExecutable } from '../src/tools/browser/launcher.js';
import { QodexBrowserManager } from '../src/tools/browser/session.js';

let pw: any = null;
try { pw = await import('playwright'); } catch { pw = null; }
let pwExe = '';
try { pwExe = String(pw?.chromium?.executablePath?.() ?? ''); } catch { pwExe = ''; }
const chromiumExe = resolveBrowserExecutable({ playwrightExecutablePath: pwExe, headless: true });
const chromium = !!pw && !!(chromiumExe.executablePath || chromiumExe.channel);

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0';
const OWNER = 1001;

interface Call { method: string; body: any; raw: unknown; headers: Record<string, string>; result?: any }

/** In-memory Telegram Bot API: records calls, serves queued updates to long-polls. */
class FakeTelegram {
  calls: Call[] = [];
  private queue: TgUpdate[] = [];
  private waiters: Array<() => void> = [];
  /** Scripted getUpdates responses (consumed first). */
  scripted: Array<() => Response> = [];
  private msgId = 500;
  private updateId = 1;
  /** Server clock for the HTTP Date header (like api.telegram.org sends). Unset = no header. */
  serverDate: (() => number) | null = null;

  fetch: FetchLike = async (url, init = {}) => {
    const method = url.split('/').pop()!;
    const headers = (init.headers ?? {}) as Record<string, string>;
    let body: any = {};
    if (typeof init.body === 'string') body = JSON.parse(init.body);
    const call: Call = { method, body, raw: init.body, headers };
    this.calls.push(call);
    const resHeaders: Record<string, string> = this.serverDate ? { Date: new Date(this.serverDate()).toUTCString() } : {};
    const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: resHeaders });
    // Telegram's real limit: 4096 characters AFTER entity parsing.
    if ((method === 'sendMessage' || method === 'editMessageText') && typeof body.text === 'string') {
      const visible = body.parse_mode === 'HTML' ? htmlToPlain(body.text) : body.text;
      if (visible.length > 4096) {
        call.result = 'too-long';
        return new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: message is too long' }), { status: 400 });
      }
    }
    switch (method) {
      case 'getMe': return ok({ id: 999, is_bot: true, first_name: 'QodeX', username: 'qx_test_bot' });
      case 'getUpdates': {
        if (this.scripted.length) return this.scripted.shift()!();
        if (body.timeout === 0) return ok([]);
        await this.waitForUpdates(init.signal ?? undefined);
        return ok(this.queue.splice(0));
      }
      case 'sendMessage':
      case 'sendPhoto':
        call.result = { message_id: this.msgId++, date: Math.floor(Date.now() / 1000), chat: { id: Number(body.chat_id ?? 0), type: 'private' }, text: body.text };
        return ok(call.result);
      case 'editMessageText':
      case 'answerCallbackQuery':
      case 'deleteWebhook':
        return ok(true);
      case 'getWebhookInfo':
        return ok({ url: '' });
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

  push(u: Omit<TgUpdate, 'update_id'>): number {
    const id = this.updateId++;
    this.queue.push({ update_id: id, ...u } as TgUpdate);
    const w = this.waiters.splice(0);
    for (const f of w) f();
    return id;
  }

  text(chatId: number, text: string, opts: { lang?: string; username?: string; date?: number; replyTo?: number; type?: string } = {}): number {
    return this.push({
      message: {
        message_id: this.msgId++,
        date: opts.date ?? Math.floor(Date.now() / 1000),
        chat: { id: chatId, type: opts.type ?? 'private' },
        from: { id: chatId, first_name: 'Alice', username: opts.username ?? 'alice', language_code: opts.lang ?? 'en' },
        text,
        reply_to_message: opts.replyTo !== undefined ? { message_id: opts.replyTo, date: 0, chat: { id: chatId, type: 'private' } } : undefined,
      },
    });
  }

  callback(chatId: number, data: string, messageId: number, fromId = chatId): number {
    return this.push({
      callback_query: {
        id: `cq${this.updateId}`,
        from: { id: fromId, first_name: 'X', username: 'alice' },
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

function fakeMissions(over: Partial<TelegramMissionAdapter> = {}): TelegramMissionAdapter & { started: string[]; cancelled: string[]; resolved: Array<[string, string, string]>; approvals: TelegramMissionApproval[] } {
  const a = {
    started: [] as string[],
    cancelled: [] as string[],
    resolved: [] as Array<[string, string, string]>,
    approvals: [] as TelegramMissionApproval[],
    async list() { return [{ id: 'm_abcdef', goal: 'Compare monitor prices', status: 'running' }, { id: 'm_zz9', goal: 'old', status: 'completed' }]; },
    async start(goal: string) { a.started.push(goal); return { id: 'm_new1', status: 'planning' }; },
    async cancel(id: string) { a.cancelled.push(id); return true; },
    async status(id: string) { return id === 'm_abcdef' ? { id, goal: 'Compare monitor prices', status: 'running', steps: [{ title: 'search', status: 'done' }] } : null; },
    async pendingApprovals() { return a.approvals; },
    async resolveApproval(id: string, answer: string, by: string) {
      a.resolved.push([id, answer, by]);
      const had = a.approvals.some((x) => x.id === id);
      a.approvals = a.approvals.filter((x) => x.id !== id);
      return had;
    },
    ...over,
  };
  return a;
}

let dir: string;
let tg: FakeTelegram;
let pairing: TelegramPairingStore;
let broker: ApprovalBroker;
let bot: TelegramBot | null;
let sleeps: number[];

async function pairOwner(chatId = OWNER, lang = 'en'): Promise<void> {
  const { code } = await pairing.createPairingCode();
  const r = await pairing.consumeCode(code, { chatId, username: 'alice', lang });
  expect(r.ok).toBe(true);
}

async function startBot(opts: Partial<TelegramBotOptions> = {}): Promise<TelegramBot> {
  bot = new TelegramBot({
    api: new TelegramApi({ token: TOKEN, fetch: tg.fetch }),
    pairing,
    broker,
    tickMs: 20,
    sleep: async (ms) => { sleeps.push(ms); },
    random: () => 0.5,
    log: () => {},
    ...opts,
  });
  await bot.start();
  return bot;
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-tg-bot-'));
  tg = new FakeTelegram();
  pairing = new TelegramPairingStore({ file: path.join(dir, 'telegram.json') });
  broker = new ApprovalBroker();
  bot = null;
  sleeps = [];
  getBus().reset();
});

afterEach(async () => {
  await bot?.stop();
  broker.reset();
  getBus().reset();
});

describe('pairing gate', () => {
  it('ignores commands from unpaired chats and explains pairing on /start', async () => {
    const missions = fakeMissions();
    await startBot({ missions });
    tg.text(7, '/mission buy a laptop');
    await waitUntil(() => tg.sent(7).length === 1);
    expect(tg.sent(7)[0].body.text).toContain('not paired');
    tg.text(7, '/status');
    tg.text(7, '/start');
    await waitUntil(() => tg.sent(7).length === 2);
    expect(tg.sent(7)[1].body.text).toContain('qodex telegram pair');
    expect(missions.started).toEqual([]);
    expect(broker.channelNames()).toEqual([]);
  });

  it('pairs with the right code (wrong one rejected), then accepts commands', async () => {
    const missions = fakeMissions();
    await startBot({ missions });
    const { code } = await pairing.createPairingCode();
    const wrong = code === '000000' ? '111111' : '000000';
    tg.text(OWNER, `/pair ${wrong}`);
    await waitUntil(() => tg.sent(OWNER).length === 1);
    expect(tg.sent(OWNER)[0].body.text).toContain('invalid or expired');
    expect(await pairing.isPaired(OWNER)).toBe(false);

    tg.text(OWNER, `/pair ${code}`);
    await waitUntil(() => tg.sent(OWNER).length === 2);
    expect(tg.sent(OWNER)[1].body.text).toContain('Paired!');
    expect(await pairing.isPaired(OWNER)).toBe(true);
    expect(broker.channelNames()).toEqual(['telegram']);

    tg.text(OWNER, '/mission find the cheapest flight to Mashhad');
    await waitUntil(() => tg.sent(OWNER).length === 3);
    expect(missions.started).toEqual(['find the cheapest flight to Mashhad']);
    expect(tg.sent(OWNER)[2].body.text).toContain('<code>m_new1</code>');
  });

  it('pairs through the t.me deep link (/start <code>) and refuses group chats', async () => {
    await startBot();
    const { code } = await pairing.createPairingCode();
    tg.text(-55, `/pair ${code}`, { type: 'group' });
    await waitUntil(() => tg.sent(-55).length === 1);
    expect(tg.sent(-55)[0].body.text).toContain('private chats');
    expect(await pairing.isPaired(-55)).toBe(false);
    tg.text(OWNER, `/start ${code}`);
    await waitUntil(() => tg.sent(OWNER).length === 1);
    expect(await pairing.isPaired(OWNER)).toBe(true);
  });

  it('ignores stale messages queued before the bot started', async () => {
    await pairOwner();
    const missions = fakeMissions();
    await startBot({ missions });
    tg.text(OWNER, '/mission stale goal', { date: Math.floor(Date.now() / 1000) - 3600 });
    tg.text(OWNER, '/help');
    await waitUntil(() => tg.sent(OWNER).length === 1);
    expect(tg.sent(OWNER)[0].body.text).toContain('QodeX remote control');
    expect(missions.started).toEqual([]);
  });

  it('/unpair disconnects the chat and unregisters the approval channel', async () => {
    await pairOwner();
    await startBot();
    expect(broker.channelNames()).toEqual(['telegram']);
    tg.text(OWNER, '/unpair');
    await waitUntil(() => tg.sent(OWNER).length === 1);
    expect(await pairing.isPaired(OWNER)).toBe(false);
    expect(broker.channelNames()).toEqual([]);
  });
});

describe('approvals', () => {
  it('delivers broker approvals with an inline keyboard and resolves them by callback', async () => {
    await pairOwner();
    await startBot();
    const pr = broker.request({ prompt: 'Click "Place order" for <b>$999</b>?', options: ['yes', 'no'], category: 'purchase', risk: 'critical', source: 'browser_click' });
    const card = await waitUntil(() => tg.sent(OWNER).find((c) => c.body.reply_markup));
    const id = broker.pending()[0].id;
    expect(card.body.parse_mode).toBe('HTML');
    expect(card.body.text).toContain('Approval needed');
    expect(card.body.text).toContain('&lt;b&gt;$999&lt;/b&gt;');
    expect(card.body.reply_markup.inline_keyboard[0]).toEqual([
      { text: '✅ Yes', callback_data: `ap:${id}:0` },
      { text: '❌ No', callback_data: `ap:${id}:1` },
    ]);
    const cardMsgId = card.result.message_id as number;

    tg.callback(OWNER, `ap:${id}:0`, cardMsgId);
    expect(await pr).toEqual({ answer: 'yes', by: 'telegram' });
    const edit = await waitUntil(() => tg.of('editMessageText').find((c) => c.body.message_id === cardMsgId));
    expect(edit.body.text).toContain('✅ Approved');
    expect(edit.body.text).toContain('via Telegram');
    expect(edit.body.reply_markup).toBeUndefined();
    const ack = await waitUntil(() => tg.of('answerCallbackQuery')[0]);
    expect(ack.body.text).toContain('Yes');
  });

  it('retract edits the card when another channel answers first', async () => {
    await pairOwner();
    await startBot();
    const pr = broker.request({ prompt: 'Send the email?', options: ['yes', 'no'], category: 'send' });
    await waitUntil(() => tg.sent(OWNER).find((c) => c.body.reply_markup));
    const id = broker.pending()[0].id;
    expect(broker.resolve(id, 'deny', 'control')).toBe(true);
    expect(await pr).toEqual({ answer: 'no', by: 'control' });
    const edit = await waitUntil(() => tg.of('editMessageText')[0]);
    expect(edit.body.text).toContain('⛔ Denied');
    expect(edit.body.text).toContain('control center');
    // A late tap on the old card is reported as expired.
    tg.callback(OWNER, `ap:${id}:0`, edit.body.message_id);
    const ack = await waitUntil(() => tg.of('answerCallbackQuery')[0]);
    expect(ack.body.text).toContain('no longer pending');
  });

  it('rejects callbacks from other chats', async () => {
    await pairOwner();
    await startBot();
    const pr = broker.request({ prompt: 'Pay?', options: ['yes', 'no'], category: 'payment', timeoutMs: 5000 });
    await waitUntil(() => tg.sent(OWNER).find((c) => c.body.reply_markup));
    const id = broker.pending()[0].id;
    tg.callback(4242, `ap:${id}:0`, 501);
    const ack = await waitUntil(() => tg.of('answerCallbackQuery')[0]);
    expect(ack.body.text).toBe('Not authorized.');
    // Forwarded card tapped by someone else inside the owner's chat id is also refused.
    tg.callback(OWNER, `ap:${id}:0`, 501, 4242);
    await waitUntil(() => tg.of('answerCallbackQuery').length === 2);
    expect(broker.pending()).toHaveLength(1);
    broker.resolve(id, 'no', 'test');
    await pr;
  });

  it('accepts a text reply to the card (Persian yes)', async () => {
    await pairOwner(OWNER, 'fa');
    await startBot();
    const pr = broker.request({ prompt: 'ارسال پیام؟', options: ['yes', 'no'], category: 'send' });
    const card = await waitUntil(() => tg.sent(OWNER).find((c) => c.body.reply_markup));
    expect(card.body.text).toContain('نیاز به تأیید');
    expect(card.body.text).toContain('<i>ارسال</i>');
    expect(card.body.reply_markup.inline_keyboard[0][0].text).toBe('✅ بله');
    const cardMsgId = card.result.message_id as number;
    tg.text(OWNER, 'بله', { lang: 'fa', replyTo: cardMsgId });
    expect(await pr).toEqual({ answer: 'yes', by: 'telegram' });
    const edit = await waitUntil(() => tg.of('editMessageText')[0]);
    expect(edit.body.text).toContain('تأیید شد');
  });

  it('does not register the channel while nobody is paired (unattended runs fail safe)', async () => {
    await startBot();
    expect(broker.hasRemoteChannel()).toBe(false);
    expect(await broker.request({ prompt: 'buy?', options: ['yes', 'no'] })).toEqual({ answer: 'no', by: 'fallback' });
    expect(tg.sent()).toHaveLength(0);
  });

  it('delivers mission-DB approvals from the adapter and resolves them through it', async () => {
    await pairOwner();
    const missions = fakeMissions();
    missions.approvals = [{ id: 'ma_1', missionId: 'm_abcdef', prompt: 'Pay 120,000 Toman on zarinpal?', options: ['yes', 'no'], category: 'payment' }];
    await startBot({ missions });
    const card = await waitUntil(() => tg.sent(OWNER).find((c) => c.body.reply_markup));
    expect(card.body.text).toContain('<code>m_abcdef</code>');
    expect(card.body.reply_markup.inline_keyboard[0][1].callback_data).toBe('ap:ma_1:1');
    const cardMsgId = card.result.message_id as number;
    tg.callback(OWNER, 'ap:ma_1:1', cardMsgId);
    await waitUntil(() => missions.resolved.length === 1);
    expect(missions.resolved[0]).toEqual(['ma_1', 'no', 'telegram:@alice']);
    const edit = await waitUntil(() => tg.of('editMessageText').find((c) => c.body.message_id === cardMsgId));
    expect(edit.body.text).toContain('⛔ Denied');
    // Not re-delivered on later ticks.
    await new Promise((r) => setTimeout(r, 80));
    expect(tg.sent(OWNER).filter((c) => c.body.reply_markup)).toHaveLength(1);
  });

  it('does not mislabel a mission card while its own answer is still being written', async () => {
    await pairOwner();
    const missions = fakeMissions();
    missions.approvals = [{ id: 'ma_slow', missionId: 'm_1', prompt: 'Submit the form?', options: ['yes', 'no'], category: 'send' }];
    missions.resolveApproval = async (id, answer, by) => {
      missions.resolved.push([id, answer, by]);
      missions.approvals = [];
      await new Promise((r) => setTimeout(r, 120)); // several ticks pass meanwhile
      return true;
    };
    await startBot({ missions });
    const card = await waitUntil(() => tg.sent(OWNER).find((c) => c.body.reply_markup));
    tg.callback(OWNER, 'ap:ma_slow:0', card.result.message_id);
    const edit = await waitUntil(() => tg.of('editMessageText')[0]);
    expect(edit.body.text).toContain('✅ Approved');
    await new Promise((r) => setTimeout(r, 60));
    expect(tg.of('editMessageText').map((c) => c.body.text).join('\n')).not.toContain('No longer pending');
  });

  it('edits an untracked card (sent before a restart) after answering it', async () => {
    await pairOwner();
    const missions = fakeMissions();
    missions.approvals = [{ id: 'ma_old', missionId: 'm_1', prompt: 'Buy it?', options: ['yes', 'no'], category: 'purchase' }];
    await startBot({ missions });
    const card = await waitUntil(() => tg.sent(OWNER).find((c) => c.body.reply_markup));
    const oldCardId = 42; // a card from the previous bot process
    tg.callback(OWNER, 'ap:ma_old:0', oldCardId);
    await waitUntil(() => tg.of('editMessageText').length === 2);
    const edited = tg.of('editMessageText').map((c) => c.body.message_id).sort();
    expect(edited).toEqual([oldCardId, card.result.message_id].sort());
    expect(missions.resolved).toEqual([['ma_old', 'yes', 'telegram:@alice']]);
  });

  it('marks a mission approval resolved elsewhere when it leaves the pending list', async () => {
    await pairOwner();
    const missions = fakeMissions();
    missions.approvals = [{ id: 'ma_2', missionId: 'm_1', prompt: 'Post the tweet?', options: ['yes', 'no'], category: 'send' }];
    await startBot({ missions });
    await waitUntil(() => tg.sent(OWNER).find((c) => c.body.reply_markup));
    missions.approvals = [];
    const edit = await waitUntil(() => tg.of('editMessageText')[0]);
    expect(edit.body.text).toContain('No longer pending');
  });

  it('/approvals re-sends pending approvals to the asking chat', async () => {
    await pairOwner();
    const missions = fakeMissions();
    await startBot({ missions });
    tg.text(OWNER, '/approvals');
    await waitUntil(() => tg.sent(OWNER).length === 1);
    expect(tg.sent(OWNER)[0].body.text).toContain('No pending approvals');
    missions.approvals = [{ id: 'ma_3', missionId: 'm_1', prompt: 'Delete the draft?', options: ['yes', 'no'], category: 'delete' }];
    await waitUntil(() => tg.sent(OWNER).length === 2);
    tg.text(OWNER, '/approvals');
    await waitUntil(() => tg.sent(OWNER).length === 3);
    expect(tg.sent(OWNER)[2].body.reply_markup.inline_keyboard[0][0].callback_data).toBe('ap:ma_3:0');
  });
});

describe('commands', () => {
  it('/status, /missions, /cancel <prefix>, /status <id>', async () => {
    await pairOwner();
    const missions = fakeMissions();
    await startBot({ missions });
    tg.text(OWNER, '/status');
    await waitUntil(() => tg.sent(OWNER).length === 1);
    const st = tg.sent(OWNER)[0].body.text;
    expect(st).toContain('@qx_test_bot');
    expect(st).toContain('Browser: not running');
    expect(st).toContain('<b>1</b> active');
    expect(st).toContain('m_abcdef');

    tg.text(OWNER, '/missions');
    await waitUntil(() => tg.sent(OWNER).length === 2);
    expect(tg.sent(OWNER)[1].body.text).toContain('m_zz9');

    tg.text(OWNER, '/cancel m_abc');
    await waitUntil(() => tg.sent(OWNER).length === 3);
    expect(missions.cancelled).toEqual(['m_abcdef']);
    expect(tg.sent(OWNER)[2].body.text).toContain('Cancellation requested');

    tg.text(OWNER, '/status m_abcdef');
    await waitUntil(() => tg.sent(OWNER).length === 4);
    expect(tg.sent(OWNER)[3].body.text).toContain('search');

    tg.text(OWNER, '/cancel');
    await waitUntil(() => tg.sent(OWNER).length === 5);
    expect(tg.sent(OWNER)[4].body.text).toContain('Usage');
  });

  it('/stop runs the emergency stop; /stop all also cancels active missions', async () => {
    await pairOwner();
    const missions = fakeMissions();
    let stopped = 0;
    const off = registerStopHandler('tg test run', () => { stopped++; return 'the running task'; });
    try {
      await startBot({ missions });
      tg.text(OWNER, '/stop');
      await waitUntil(() => tg.sent(OWNER).length === 1);
      expect(stopped).toBe(1);
      expect(tg.sent(OWNER)[0].body.text).toContain('the running task');
      expect(tg.sent(OWNER)[0].body.text).toContain('/stop all');
      expect(missions.cancelled).toEqual([]);

      tg.text(OWNER, '/stop all');
      await waitUntil(() => tg.sent(OWNER).length === 2);
      expect(missions.cancelled).toEqual(['m_abcdef']);
      expect(tg.sent(OWNER)[1].body.text).toContain('mission m_abcdef');
    } finally { off(); }
  });

  it('replies "not available" for mission commands without an adapter', async () => {
    await pairOwner();
    await startBot();
    tg.text(OWNER, '/mission do things');
    await waitUntil(() => tg.sent(OWNER).length === 1);
    expect(tg.sent(OWNER)[0].body.text).toContain('not available');
  });

  it('localizes to Persian from language_code and /lang', async () => {
    await pairOwner(OWNER, 'fa-IR');
    await startBot();
    tg.text(OWNER, '/help', { lang: 'fa-IR' });
    await waitUntil(() => tg.sent(OWNER).length === 1);
    expect(tg.sent(OWNER)[0].body.text).toContain('کنترل از راه دور QodeX');
    tg.text(OWNER, '/lang en', { lang: 'fa-IR' });
    await waitUntil(() => tg.sent(OWNER).length === 2);
    tg.text(OWNER, '/help', { lang: 'fa-IR' });
    await waitUntil(() => tg.sent(OWNER).length === 3);
    expect(tg.sent(OWNER)[2].body.text).toContain('QodeX remote control');
    expect((await pairing.getChat(OWNER))?.langPinned).toBe(true);
  });

  it('/screen sends a JPEG of the active tab as multipart', async () => {
    await pairOwner();
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
    const fakeMgr = {
      isRunning: () => true,
      screenshotJpeg: async () => jpeg,
      activeUrl: () => 'https://shop.example/cart?a=1&b=2',
      status: () => ({ running: true, mode: 'launch', headless: true, profile: 'default', tabs: [{ index: 0, id: 't1', url: 'https://shop.example/cart?a=1&b=2', title: 'Cart <3>', active: true }], takeover: false, downloadsDir: '/tmp' }),
    } as unknown as BrowserManager;
    await startBot({ browser: () => fakeMgr });
    tg.text(OWNER, '/screen');
    const photo = await waitUntil(() => tg.of('sendPhoto')[0]);
    expect(photo.headers['Content-Type']).toMatch(/^multipart\/form-data; boundary=/);
    const raw = photo.raw as Buffer;
    expect(raw.includes(jpeg)).toBe(true);
    const text = raw.toString('utf-8');
    expect(text).toContain(`name="chat_id"\r\n\r\n${OWNER}\r\n`);
    expect(text).toContain('Cart &lt;3&gt;\nhttps://shop.example/cart?a=1&amp;b=2');
    expect(text).toContain('filename="qodex-screen.jpg"');
  });

  it('/screen without a browser explains instead of launching one', async () => {
    await pairOwner();
    await startBot({ browser: () => null });
    tg.text(OWNER, '/screen');
    await waitUntil(() => tg.sent(OWNER).length === 1);
    expect(tg.sent(OWNER)[0].body.text).toContain('No browser is running');
    expect(tg.of('sendPhoto')).toHaveLength(0);
  });

  it('falls back to plain text when Telegram rejects the HTML', async () => {
    await pairOwner();
    const base = tg.fetch;
    let rejected = 0;
    tg.fetch = async (url, init) => {
      if (url.endsWith('/sendMessage') && JSON.parse(String(init?.body)).parse_mode === 'HTML' && rejected === 0) {
        rejected++;
        return new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: can't parse entities" }), { status: 400 });
      }
      return base(url, init);
    };
    await startBot();
    tg.text(OWNER, '/help');
    const plain = await waitUntil(() => tg.calls.find((c) => c.method === 'sendMessage' && c.body.parse_mode === undefined));
    expect(plain.body.text).toContain('QodeX remote control');
    expect(plain.body.text).not.toContain('<b>');
  });
});

describe('notifications', () => {
  it('forwards mission milestones + Sentinel blocks from the bus, rate-limited', async () => {
    await pairOwner();
    await startBot({ notifyRateLimit: { max: 2, windowMs: 60_000 } });
    const bus = getBus();
    bus.publish({ kind: 'mission', missionId: 'm_1', type: 'milestone', data: { title: 'Logged in' } });
    bus.publish({ kind: 'mission', missionId: 'm_1', type: 'step-start', data: {} });
    bus.publish({ kind: 'sentinel', type: 'decision', data: { action: 'deny', category: 'payment', summary: 'pay on shaparak.ir' } });
    bus.publish({ kind: 'sentinel', type: 'decision', data: { action: 'allow', category: 'navigation' } });
    bus.publish({ kind: 'mission', missionId: 'm_1', type: 'milestone', data: { title: 'Cart filled' } });
    bus.publish({ kind: 'mission', missionId: 'm_1', type: 'milestone', data: { title: 'Address set' } });
    bus.publish({ kind: 'mission', missionId: 'm_1', type: 'completed', data: { report: 'Order ready for review' } });
    await waitUntil(() => tg.sent(OWNER).length === 3);
    await new Promise((r) => setTimeout(r, 30));
    const texts = tg.sent(OWNER).map((c) => c.body.text as string);
    expect(texts).toHaveLength(3);
    expect(texts[0]).toContain('Logged in');
    expect(texts[1]).toContain('Sentinel blocked');
    expect(texts[2]).toContain('Mission completed');
    expect(texts[2]).toContain('2 earlier notification(s) were skipped');
  });

  it('honors notify=false', async () => {
    await pairOwner();
    await startBot({ notify: false });
    getBus().publish({ kind: 'mission', missionId: 'm_1', type: 'completed', data: {} });
    tg.text(OWNER, '/help');
    await waitUntil(() => tg.sent(OWNER).length === 1);
    expect(tg.sent(OWNER)[0].body.text).toContain('remote control');
  });

  it('uses the adapter event feed (detached missions) instead of the bus when available', async () => {
    await pairOwner();
    let events: Array<{ id: number; missionId: string; type: string; data?: unknown }> = [
      { id: 1, missionId: 'm_old', type: 'completed', data: {} },
    ];
    const calls: Array<number | null> = [];
    const missions = fakeMissions({
      async eventsSince(after: number | null) {
        calls.push(after);
        if (after === null) return { events: [], cursor: 1 };
        const out = events.filter((e) => e.id > after);
        return { events: out, cursor: Math.max(after, ...events.map((e) => e.id)) };
      },
    });
    await startBot({ missions });
    expect(calls[0]).toBeNull();
    getBus().publish({ kind: 'mission', missionId: 'm_bus', type: 'completed', data: {} });
    events = [...events, { id: 2, missionId: 'm_new', type: 'failed', data: { error: 'login wall' } }];
    const msg = await waitUntil(() => tg.sent(OWNER)[0]);
    expect(msg.body.text).toContain('Mission failed');
    expect(msg.body.text).toContain('m_new');
    await new Promise((r) => setTimeout(r, 60));
    const all = tg.sent(OWNER).map((c) => c.body.text as string).join('\n');
    expect(all).not.toContain('m_old');
    expect(all).not.toContain('m_bus');
    expect(tg.sent(OWNER)).toHaveLength(1);
  });
});

describe('polling resilience', () => {
  it('backs off on 502 / 409 / 429 and keeps polling', async () => {
    await pairOwner();
    tg.scripted.push(
      () => new Response('<html>502 Bad Gateway</html>', { status: 502, statusText: 'Bad Gateway' }),
      () => new Response('<html>502 Bad Gateway</html>', { status: 502, statusText: 'Bad Gateway' }),
      () => new Response(JSON.stringify({ ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' }), { status: 409 }),
      () => new Response(JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 3 } }), { status: 429 }),
    );
    const notices: string[] = [];
    getBus().subscribe((ev) => { if (ev.kind === 'notice') notices.push(ev.message); });
    await startBot();
    tg.text(OWNER, '/help');
    await waitUntil(() => tg.sent(OWNER).length === 1);
    expect(sleeps).toEqual([1000, 2000, 5000, 3000]);
    expect(notices.some((n) => n.includes('another process is polling'))).toBe(true);
  });

  it('caps the backoff and adds jitter', () => {
    const b = new TelegramBot({ api: new TelegramApi({ token: TOKEN, fetch: tg.fetch }), pairing, broker, random: () => 1, log: () => {} });
    expect(b.backoffDelay(1, new Error('x'))).toBe(1200);
    expect(b.backoffDelay(20, new Error('x'))).toBe(72000);
  });

  it('stops with [TELEGRAM_UNAUTHORIZED] when the token is revoked, without leaking it', async () => {
    tg.scripted.push(() => new Response(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }), { status: 401 }));
    const b = await startBot();
    const err = await b.done().catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('[TELEGRAM_UNAUTHORIZED]');
    expect(err.message).not.toContain(TOKEN);
    expect(b.isRunning()).toBe(false);
  });

  it('advances the offset and confirms it on stop', async () => {
    await pairOwner();
    const b = await startBot();
    const id = tg.text(OWNER, '/help');
    await waitUntil(() => tg.sent(OWNER).length === 1);
    await b.stop();
    const confirm = tg.of('getUpdates').filter((c) => c.body.offset === id + 1);
    expect(confirm.length).toBeGreaterThanOrEqual(1);
    expect(confirm[confirm.length - 1].body.timeout).toBe(0);
    expect(broker.channelNames()).toEqual([]);
  });
});

describe.skipIf(!chromium)('with the real QodeX browser (local pages only)', () => {
  it('/screen sends a real JPEG of the active tab; /status masks tokens in its URL; a busy page times out', async () => {
    const http = await import('http');
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      if ((req.url ?? '').startsWith('/busy')) {
        res.end('<title>Busy</title><h1>busy</h1><script>setTimeout(() => { const e = Date.now() + 8000; while (Date.now() < e) {} }, 50)</script>');
        return;
      }
      res.end('<title>Cart &lt;3&gt; — سبد خرید</title><h1 style="font-size:64px">Checkout</h1>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    const mgr = new QodexBrowserManager({
      profilesDir: path.join(dir, 'profiles'),
      downloadsDir: path.join(dir, 'downloads'),
      config: { headless: true },
    });
    try {
      await mgr.ensure();
      const page = await mgr.activePage();
      await page.goto(`${base}/cb?access_token=ya29.AbCdEfGhIjKlMnOpQrStUv&step=2`);
      await pairOwner();
      await startBot({ browser: () => mgr, screenshotTimeoutMs: 1500 });

      tg.text(OWNER, '/screen');
      const photo = await waitUntil(() => tg.of('sendPhoto')[0], 15_000);
      const ct = photo.headers['Content-Type'];
      const form = await new Response(photo.raw as Buffer, { headers: { 'content-type': ct } }).formData();
      const file = form.get('photo') as any;
      const bytes = Buffer.from(await file.arrayBuffer());
      expect(bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true); // JPEG SOI
      expect(bytes.length).toBeGreaterThan(1000);
      const caption = String(form.get('caption'));
      expect(caption).toContain('Cart &lt;3&gt; — سبد خرید');
      expect(caption).toContain(`${base}/cb`);
      expect(caption).not.toContain('ya29.');

      tg.text(OWNER, '/status');
      const st = await waitUntil(() => tg.sent(OWNER).find((c) => String(c.body.text).includes('Browser: running')));
      expect(st.body.text).toContain('1 tab(s)');
      expect(st.body.text).not.toContain('ya29.');

      // A page stuck in a script: /screen gives up instead of blocking the bot for 30s.
      await page.goto(`${base}/busy`);
      await new Promise((r) => setTimeout(r, 200));
      const t0 = Date.now();
      tg.text(OWNER, '/screen');
      const failed = await waitUntil(() => tg.sent(OWNER).find((c) => String(c.body.text).includes('Screenshot failed')), 15_000);
      expect(Date.now() - t0).toBeLessThan(8000);
      expect(failed.body.text).toContain('SCREENSHOT_TIMEOUT');
      expect(failed.body.text).not.toMatch(/\u001b\[/);
    } finally {
      await bot?.stop();
      await mgr.close();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 60_000);
});

describe('with the real mission store', () => {
  it('delivers a detached mission approval, records the answer in the DB, and reports completion', async () => {
    const store = new MissionStore(path.join(dir, 'sessions.db'));
    const missions = createTelegramMissionAdapter({ store, defaultCwd: dir });
    await pairOwner();
    await startBot({ missions });
    const m = store.create({ goal: 'buy a desk lamp', cwd: dir });
    store.createApproval({ id: 'ap_lamp', missionId: m.id, prompt: 'Pay $30 on <shop.example>?', options: ['yes', 'no'], category: 'payment', risk: 'critical' });
    const card = await waitUntil(() => tg.sent(OWNER).find((c) => c.body.reply_markup));
    expect(card.body.text).toContain('Pay $30 on &lt;shop.example&gt;?');
    expect(card.body.text).toContain(`<code>${m.id}</code>`);
    tg.callback(OWNER, 'ap:ap_lamp:0', card.result.message_id);
    await waitUntil(() => store.getApproval('ap_lamp')!.status !== 'pending');
    expect(store.getApproval('ap_lamp')).toMatchObject({ status: 'approved', answer: 'yes', resolved_by: 'telegram:@alice' });
    const edit = await waitUntil(() => tg.of('editMessageText').find((e) => e.body.message_id === card.result.message_id));
    expect(edit.body.text).toContain('✅ Approved');

    store.update(m.id, { report: 'Lamp ordered, arrives Tuesday' });
    store.setStatus(m.id, 'completed');
    const done = await waitUntil(() => tg.sent(OWNER).find((c) => String(c.body.text).includes('Mission completed')));
    expect(done.body.text).toContain('Lamp ordered, arrives Tuesday');
    // Only one approval card ever went out.
    expect(tg.sent(OWNER).filter((c) => c.body.reply_markup)).toHaveLength(1);
  });
});

describe('adversarial review', () => {
  it('does not leave a live card when the approval is answered before delivery finishes', async () => {
    await pairOwner();
    await startBot();
    // A local asker that answers at once (headless policy), and an already-aborted request.
    const r = await broker.request({ prompt: 'Write notes.md?', options: ['yes', 'no'] }, async () => 'yes');
    expect(r).toEqual({ answer: 'yes', by: 'local' });
    const ac = new AbortController();
    ac.abort();
    expect(await broker.request({ prompt: 'Pay?', options: ['yes', 'no'], signal: ac.signal })).toEqual({ answer: 'no', by: 'abort' });
    await new Promise((res) => setTimeout(res, 80));
    // Every card that was sent must have been edited to its outcome (no dangling buttons).
    const cards = tg.sent(OWNER).filter((c) => c.body.reply_markup);
    for (const c of cards) {
      expect(tg.of('editMessageText').some((e) => e.body.message_id === c.result.message_id)).toBe(true);
    }
  });

  it('a double tap keeps the real outcome on the card (not "answered elsewhere")', async () => {
    await pairOwner();
    await startBot();
    const pr = broker.request({ prompt: 'Buy?', options: ['yes', 'no'], category: 'purchase' });
    const card = await waitUntil(() => tg.sent(OWNER).find((c) => c.body.reply_markup));
    const id = broker.pending()[0].id;
    const msgId = card.result.message_id as number;
    tg.callback(OWNER, `ap:${id}:0`, msgId);
    tg.callback(OWNER, `ap:${id}:0`, msgId);
    expect(await pr).toEqual({ answer: 'yes', by: 'telegram' });
    await waitUntil(() => tg.of('answerCallbackQuery').length === 2);
    await new Promise((res) => setTimeout(res, 50));
    const edits = tg.of('editMessageText').filter((e) => e.body.message_id === msgId);
    expect(edits.length).toBeGreaterThan(0);
    expect(edits[edits.length - 1].body.text).toContain('✅ Approved');
    expect(edits.map((e) => e.body.text).join('\n')).not.toContain('No longer pending');
  });

  it('sends one card per approval when it is pending in both the broker and the mission DB', async () => {
    await pairOwner();
    const missions = fakeMissions();
    await startBot({ missions });
    // An in-process mission mirrors its broker approval into the DB with the same id.
    const pr = broker.request({ prompt: 'Submit order?', options: ['yes', 'no'], source: 'mission:m_1', meta: { missionId: 'm_1' }, timeoutMs: 10_000 });
    await waitUntil(() => tg.sent(OWNER).find((c) => c.body.reply_markup));
    const id = broker.pending()[0].id;
    missions.approvals = [{ id, missionId: 'm_1', prompt: 'Submit order?', options: ['yes', 'no'] }];
    await new Promise((res) => setTimeout(res, 80));
    tg.text(OWNER, '/approvals');
    await waitUntil(() => tg.sent(OWNER).length >= 2);
    tg.text(OWNER, '/status');
    await waitUntil(() => tg.sent(OWNER).some((c) => String(c.body.text).includes('Approvals pending')));
    await new Promise((res) => setTimeout(res, 50));
    const cards = tg.sent(OWNER).filter((c) => c.body.reply_markup);
    expect(cards).toHaveLength(2); // the original delivery + exactly one from /approvals
    const status = tg.sent(OWNER).find((c) => String(c.body.text).includes('Approvals pending'))!;
    expect(status.body.text).toContain('Approvals pending: <b>1</b>');
    broker.resolve(id, 'no', 'test');
    await pr;
  });

  it('does not double-deliver when the tick sees a mirrored mission row while the broker card is in flight', async () => {
    // The broker delivery's pairing read is slow, so a tick sees the mirrored row first.
    let slowNext = false;
    class SlowPairing extends TelegramPairingStore {
      async listChats() {
        if (slowNext) { slowNext = false; await new Promise((r) => setTimeout(r, 150)); }
        return super.listChats();
      }
    }
    pairing = new SlowPairing({ file: path.join(dir, 'telegram.json') });
    await pairOwner();
    const missions = fakeMissions();
    await startBot({ missions });
    slowNext = true;
    const pr = broker.request({ prompt: 'Book the flight?', options: ['yes', 'no'], meta: { missionId: 'm_1' }, timeoutMs: 10_000 });
    const id = broker.pending()[0].id;
    missions.approvals = [{ id, missionId: 'm_1', prompt: 'Book the flight?', options: ['yes', 'no'] }];
    await waitUntil(() => tg.sent(OWNER).find((c) => c.body.reply_markup));
    await new Promise((res) => setTimeout(res, 300));
    expect(tg.sent(OWNER).filter((c) => c.body.reply_markup)).toHaveLength(1);
    broker.resolve(id, 'no', 'test');
    await pr;
  });

  it('still answers /status <id> when the mission report is huge', async () => {
    await pairOwner();
    const missions = fakeMissions({
      async status(id: string) {
        return {
          id, goal: 'G'.repeat(600), status: 'completed',
          steps: Array.from({ length: 15 }, (_, i) => ({ title: `step ${i} ` + 'x'.repeat(110), status: 'done' })),
          milestones: Array.from({ length: 5 }, () => 'm'.repeat(200)),
          error: 'e'.repeat(800), report: 'r'.repeat(5000), liveUrl: 'http://127.0.0.1:7420/',
        };
      },
    });
    await startBot({ missions });
    tg.text(OWNER, '/status m_big');
    await waitUntil(() => tg.sent(OWNER).length >= 1);
    await new Promise((res) => setTimeout(res, 30));
    const delivered = tg.sent(OWNER).filter((c) => c.result && c.result !== 'too-long');
    expect(delivered).toHaveLength(1);
    expect(htmlToPlain(delivered[0].body.text)).toContain('step 0');
  });

  it('never sends the control-center access key of a mission live view to Telegram', async () => {
    await pairOwner();
    const missions = fakeMissions({
      async status(id: string) { return { id, goal: 'g', status: 'running', liveUrl: 'http://127.0.0.1:7420/?k=SECRETKEY123456' }; },
    });
    await startBot({ missions });
    tg.text(OWNER, '/status m_1');
    await waitUntil(() => tg.sent(OWNER).length === 1);
    expect(tg.sent(OWNER)[0].body.text).not.toContain('SECRETKEY123456');
    expect(tg.sent(OWNER)[0].body.text).toContain('127.0.0.1:7420');
  });

  it('bounds the replies an unpaired stranger can trigger (no flood amplification)', async () => {
    await startBot();
    for (let i = 0; i < 15; i++) tg.text(66, '/start');
    for (let i = 0; i < 15; i++) tg.text(66, '/pair 12');
    for (let c = 0; c < 60; c++) tg.text(1000 + c, '/start');
    // The whole flood arrives in one batch; the next poll starts once it has been handled.
    await waitUntil(() => tg.calls.filter((c) => c.method === 'getUpdates').length >= 2);
    await new Promise((res) => setTimeout(res, 100));
    expect(tg.sent(66).length).toBeLessThanOrEqual(5);
    expect(tg.sent().length).toBeLessThanOrEqual(40);
    // The owner can still pair afterwards.
    const { code } = await pairing.createPairingCode();
    tg.text(OWNER, `/pair ${code}`);
    await waitUntil(() => tg.sent(OWNER).some((c) => String(c.body.text).includes('Paired!')));
  });

  it('does not ignore fresh commands when the local clock runs ahead of Telegram', async () => {
    await pairOwner();
    tg.serverDate = () => Date.now();
    const missions = fakeMissions();
    await startBot({ missions, now: () => Date.now() + 10 * 60_000 });
    tg.text(OWNER, '/mission stale goal', { date: Math.floor(Date.now() / 1000) - 3600 });
    tg.text(OWNER, '/mission fresh goal');
    await waitUntil(() => tg.sent(OWNER).length === 1);
    expect(missions.started).toEqual(['fresh goal']);
  });

  it('/screen gives up on a hung page instead of blocking approvals', async () => {
    await pairOwner();
    const hung = {
      isRunning: () => true,
      screenshotJpeg: () => new Promise<Buffer>(() => {}),
      activeUrl: () => 'about:blank',
      status: () => ({ running: true, mode: 'launch', headless: true, profile: 'default', tabs: [], takeover: false, downloadsDir: '/tmp' }),
    } as unknown as BrowserManager;
    await startBot({ browser: () => hung, screenshotTimeoutMs: 50 } as Partial<TelegramBotOptions>);
    tg.text(OWNER, '/screen');
    const pr = broker.request({ prompt: 'Pay?', options: ['yes', 'no'], timeoutMs: 5000 });
    const card = await waitUntil(() => tg.sent(OWNER).find((c) => c.body.reply_markup));
    tg.callback(OWNER, `ap:${broker.pending()[0].id}:1`, card.result.message_id);
    expect(await pr).toEqual({ answer: 'no', by: 'telegram' });
    const failed = await waitUntil(() => tg.sent(OWNER).find((c) => String(c.body.text).includes('Screenshot failed')));
    expect(failed.body.text).toContain('SCREENSHOT_TIMEOUT');
  });

  it('keeps the buttons and asks to retry when recording a mission answer fails', async () => {
    await pairOwner();
    const missions = fakeMissions();
    missions.approvals = [{ id: 'ma_busy', missionId: 'm_1', prompt: 'Pay?', options: ['yes', 'no'] }];
    let fail = true;
    missions.resolveApproval = async (id, answer, by) => {
      if (fail) { fail = false; throw new Error('SQLITE_BUSY: database is locked'); }
      missions.resolved.push([id, answer, by]);
      missions.approvals = [];
      return true;
    };
    await startBot({ missions });
    const card = await waitUntil(() => tg.sent(OWNER).find((c) => c.body.reply_markup));
    const msgId = card.result.message_id as number;
    tg.callback(OWNER, 'ap:ma_busy:0', msgId);
    const ack = await waitUntil(() => tg.of('answerCallbackQuery')[0]);
    expect(ack.body.text).not.toContain('no longer pending');
    expect(tg.of('editMessageText').filter((e) => e.body.message_id === msgId)).toHaveLength(0);
    tg.callback(OWNER, 'ap:ma_busy:0', msgId);
    await waitUntil(() => missions.resolved.length === 1);
    const edit = await waitUntil(() => tg.of('editMessageText').find((e) => e.body.message_id === msgId));
    expect(edit.body.text).toContain('✅ Approved');
  });

  it('labels approvals that expired with their mission as cancelled, not denied by a person', async () => {
    await pairOwner();
    await startBot();
    const pr = broker.request({ prompt: 'Upload?', options: ['yes', 'no'] });
    await waitUntil(() => tg.sent(OWNER).find((c) => c.body.reply_markup));
    broker.resolve(broker.pending()[0].id, 'no', 'worker-exited');
    await pr;
    const edit = await waitUntil(() => tg.of('editMessageText')[0]);
    expect(edit.body.text).toContain('Cancelled');
    expect(edit.body.text).not.toContain('Denied');
  });

  it('logs a failing mission store once instead of every tick', async () => {
    await pairOwner();
    const logs: string[] = [];
    const missions = fakeMissions({ async pendingApprovals() { throw new Error('SQLITE_CANTOPEN'); } });
    await startBot({ missions, log: (_l, m) => logs.push(m) });
    await new Promise((res) => setTimeout(res, 200)); // ~10 ticks
    expect(logs.filter((l) => l.includes('SQLITE_CANTOPEN')).length).toBe(1);
  });

  it('retries a broker approval card that could not be sent (Telegram briefly unreachable)', async () => {
    await pairOwner();
    const base = tg.fetch;
    let down = true;
    let failed = 0;
    tg.fetch = async (url, init) => {
      if (down && url.endsWith('/sendMessage')) { failed++; throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } }); }
      return base(url, init);
    };
    await startBot();
    const pr = broker.request({ prompt: 'Pay 50 EUR?', options: ['yes', 'no'], category: 'payment', timeoutMs: 10_000 });
    await waitUntil(() => failed >= 2); // the first try and its retry both failed
    down = false;
    const card = await waitUntil(() => tg.sent(OWNER).find((c) => c.body.reply_markup && c.result));
    tg.callback(OWNER, `ap:${broker.pending()[0].id}:0`, card.result.message_id);
    expect(await pr).toEqual({ answer: 'yes', by: 'telegram' });
  });

  it('does not echo a Sentinel denial the user just made on Telegram', async () => {
    await pairOwner();
    await startBot();
    getBus().publish({ kind: 'sentinel', type: 'decision', data: { action: 'deny', via: 'human', category: 'payment', summary: 'pay', answeredBy: 'telegram' } });
    getBus().publish({ kind: 'sentinel', type: 'decision', data: { action: 'deny', via: 'timeout', category: 'send', summary: 'send mail', answeredBy: 'timeout' } });
    const n = await waitUntil(() => tg.sent(OWNER)[0]);
    await new Promise((res) => setTimeout(res, 50));
    expect(tg.sent(OWNER)).toHaveLength(1);
    expect(n.body.text).toContain('send mail');
  });

  it('does not repeat a terminal mission notice published twice on the bus', async () => {
    await pairOwner();
    await startBot();
    const bus = getBus();
    bus.publish({ kind: 'mission', missionId: 'm_9', type: 'status', data: { from: 'running', to: 'completed', status: 'completed' } });
    bus.publish({ kind: 'mission', missionId: 'm_9', type: 'completed', data: { status: 'completed', report: 'done' } });
    await waitUntil(() => tg.sent(OWNER).length >= 1);
    await new Promise((res) => setTimeout(res, 50));
    expect(tg.sent(OWNER).filter((c) => String(c.body.text).includes('Mission completed'))).toHaveLength(1);
  });
});
