/**
 * H2 hand-off surfaces — Telegram: the hand-off card (screenshot clipped to the
 * challenge, Done / Can't-solve, one URL button with the scoped link), the
 * BUTTON_URL_INVALID fallbacks (LAN → Wi-Fi line without the token, loopback →
 * nothing), retraction on auto-resume, and the rule that the link token is never
 * in Telegram text, edits or logs — only in that one URL button.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TelegramApi, TelegramApiError, buildMultipart, type FetchLike, type TgUpdate } from '../src/channels/telegram/api.js';
import { TelegramPairingStore } from '../src/channels/telegram/pairing.js';
import { TelegramBot, padClip, type TelegramBotOptions, type TelegramHandoffLink, type TelegramMissionAdapter, type TelegramMissionApproval } from '../src/channels/telegram/bot.js';
import { formatHandoffCard, formatHandoffOutcome, handoffKeyboard, htmlToPlain, vendorLabel, formatOutcome } from '../src/channels/telegram/format.js';
import { ApprovalBroker, getApprovalBroker, type ApprovalResult } from '../src/control/approvals.js';
import { getBus } from '../src/control/bus.js';
import { startControlCenter, stopControlCenter } from '../src/control/server.js';
import { handoffOwner } from '../src/control/handoff.js';
import { setBrowserManagerForTests, type BrowserManager, type ScreenshotClip } from '../src/tools/browser/types.js';

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0';
const OWNER = 1001;
const LINK_TOKEN = 'Zq3_' + 'x'.repeat(35) + 'Kk9-';

interface Call { method: string; body: any }

function multipartFields(raw: Buffer): Record<string, string> {
  const text = raw.toString('utf8');
  const out: Record<string, string> = {};
  const re = /name="([^"]+)"\r\n\r\n([\s\S]*?)\r\n--/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out[m[1]!] = m[2]!;
  return out;
}

class FakeTg {
  calls: Call[] = [];
  rejectUrl: (url: string) => boolean = () => false;
  photoError = '';
  editCaptionError = '';
  private msgId = 700;

  fetch: FetchLike = async (url, init = {}) => {
    const method = url.split('/').pop()!;
    let body: any = {};
    if (typeof init.body === 'string') body = JSON.parse(init.body);
    else if (init.body) {
      body = multipartFields(Buffer.from(init.body as any));
      body.photoBytes = Buffer.from(init.body as any).length;
      if (body.reply_markup) body.reply_markup = JSON.parse(body.reply_markup);
    }
    this.calls.push({ method, body });
    const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    const bad = (description: string) => new Response(JSON.stringify({ ok: false, error_code: 400, description }), { status: 400 });
    const buttons: any[] = (body.reply_markup?.inline_keyboard ?? []).flat();
    switch (method) {
      case 'getMe': return ok({ id: 999, is_bot: true, first_name: 'QodeX', username: 'qx_test_bot' });
      case 'getUpdates':
        if (body.timeout !== 0) await new Promise(r => setTimeout(r, 30));
        return ok([]);
      case 'sendPhoto':
        if (buttons.some(b => b.url && this.rejectUrl(b.url))) return bad('Bad Request: BUTTON_URL_INVALID');
        if (this.photoError) return bad(this.photoError);
        return ok({ message_id: this.msgId++, date: 1, chat: { id: Number(body.chat_id), type: 'private' }, caption: body.caption });
      case 'sendMessage':
        if (buttons.some(b => b.url && this.rejectUrl(b.url))) return bad('Bad Request: BUTTON_URL_INVALID');
        return ok({ message_id: this.msgId++, date: 1, chat: { id: Number(body.chat_id), type: 'private' }, text: body.text });
      case 'editMessageCaption':
        if (this.editCaptionError) return bad(this.editCaptionError);
        return ok(true);
      case 'editMessageText':
      case 'editMessageReplyMarkup':
      case 'deleteMessage':
      case 'answerCallbackQuery':
        return ok(true);
      default:
        return new Response(JSON.stringify({ ok: false, error_code: 404, description: 'Not Found' }), { status: 404 });
    }
  };

  of(method: string): Call[] { return this.calls.filter(c => c.method === method); }
}

async function waitUntil<T>(fn: () => T | undefined | null | false, timeoutMs = 4000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out');
    await new Promise(r => setTimeout(r, 5));
  }
}

let dir: string;
let tg: FakeTg;
let pairing: TelegramPairingStore;
let broker: ApprovalBroker;
let bot: TelegramBot | null;
let logs: string[];
let clips: Array<ScreenshotClip | undefined>;
let browserRunning: boolean;
let revoked: number;

const fakeBrowser = (): BrowserManager => ({
  isRunning: () => browserRunning,
  screenshotJpeg: async (_q?: number, o?: { clip?: ScreenshotClip }) => { clips.push(o?.clip); return Buffer.from([0xff, 0xd8, 0xff, 0xd9]); },
  status: () => ({ running: true, mode: 'launch', headless: true, profile: 'x', tabs: [], takeover: false, downloadsDir: '/tmp' }),
  activeUrl: () => 'https://shop.example/',
} as unknown as BrowserManager);

function link(base: TelegramHandoffLink['base'], host: string): TelegramHandoffLink {
  return {
    url: `${host}/?h=${LINK_TOKEN}&handoff=ho_1`,
    base,
    plainUrl: `${host}/?handoff=ho_1`,
    expiresAt: Date.now() + 10 * 60_000,
    revoke: () => { revoked++; },
  };
}

async function pairOwner(lang = 'en'): Promise<void> {
  const { code } = await pairing.createPairingCode();
  expect((await pairing.consumeCode(code, { chatId: OWNER, username: 'alice', lang })).ok).toBe(true);
}

async function startBot(opts: Partial<TelegramBotOptions> = {}): Promise<TelegramBot> {
  bot = new TelegramBot({
    api: new TelegramApi({ token: TOKEN, fetch: tg.fetch }),
    pairing,
    broker,
    browser: fakeBrowser,
    tickMs: 20,
    sleep: async () => {},
    random: () => 0.5,
    log: (_l, m) => { logs.push(m); },
    ...opts,
  });
  await bot.start();
  return bot;
}

function raise(b: ApprovalBroker = broker, id = 'ho_1', extra: Record<string, unknown> = {}): Promise<ApprovalResult> {
  return b.request({
    prompt: 'A bot check (Cloudflare Turnstile) on shop.example needs you.',
    options: ['done', 'cancel'], source: 'browser', category: 'challenge', risk: 'medium', timeoutMs: 60_000,
    meta: { handoff: { id, host: 'shop.example', vendor: 'turnstile', state: 'needs-human', tabIndex: 0, frameBox: { x: 500, y: 300, width: 300, height: 65 }, linkTtlSec: 600, ...extra } },
  });
}

/** Every place the token could leak: text, captions, edits — only a card's URL button may carry it. */
function assertTokenOnlyInUrlButtons(token: string): void {
  for (const c of tg.calls) {
    const { reply_markup, ...rest } = c.body ?? {};
    expect(JSON.stringify(rest), `${c.method} body`).not.toContain(token);
    const buttons: any[] = (reply_markup?.inline_keyboard ?? []).flat();
    for (const b of buttons) {
      expect(String(b.text ?? '')).not.toContain(token);
      expect(String(b.callback_data ?? '')).not.toContain(token);
      if (String(b.url ?? '').includes(token)) expect(['sendPhoto', 'sendMessage']).toContain(c.method);
    }
  }
  expect(logs.join('\n')).not.toContain(token);
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-tg-handoff-'));
  tg = new FakeTg();
  pairing = new TelegramPairingStore({ file: path.join(dir, 'telegram.json') });
  broker = new ApprovalBroker();
  bot = null;
  logs = [];
  clips = [];
  browserRunning = true;
  revoked = 0;
  getBus().reset();
});

afterEach(async () => {
  await bot?.stop();
  broker.reset();
  getBus().reset();
});

describe('Telegram hand-off card', () => {
  it('sends a clipped screenshot with Done / Can\'t and one URL button; no reply hint', async () => {
    await pairOwner();
    await startBot({ handoffLink: async () => link('tunnel', 'https://abc.trycloudflare.com') });
    const pr = raise();
    const card = await waitUntil(() => tg.of('sendPhoto')[0]);
    expect(clips[0]).toEqual(padClip({ x: 500, y: 300, width: 300, height: 65 }));
    expect(clips[0]).toEqual({ x: 476, y: 253, width: 348, height: 160 });
    const kb = card.body.reply_markup.inline_keyboard;
    expect(kb[0]).toEqual([{ text: '🖐 Open live view', url: `https://abc.trycloudflare.com/?h=${LINK_TOKEN}&handoff=ho_1` }]);
    const id = broker.pending()[0]!.id;
    expect(kb[1]).toEqual([{ text: '✅ Done', callback_data: `ap:${id}:0` }, { text: '✖️ Can\'t solve it', callback_data: `ap:${id}:1` }]);
    const caption = htmlToPlain(card.body.caption);
    expect(caption).toContain('A bot check needs you');
    expect(caption).toContain('shop.example · Cloudflare Turnstile');
    expect(caption).toContain('QodeX continues by itself');
    expect(caption).toMatch(/stops working in 10 min/);
    expect(caption).not.toMatch(/reply/i);
    expect(caption.length).toBeLessThan(1024);
    // Done from the phone
    await bot!.handleUpdate({ update_id: 1, callback_query: { id: 'cq1', from: { id: OWNER, first_name: 'A' }, message: { message_id: card.body.message_id ?? 700, date: 0, chat: { id: OWNER, type: 'private' }, caption: 'x' }, data: `ap:${id}:0` } } as TgUpdate);
    expect(await pr).toEqual({ answer: 'done', by: 'telegram' });
    const edit = await waitUntil(() => tg.of('editMessageCaption')[0]);
    expect(htmlToPlain(edit.body.caption)).toContain('Marked as solved');
    expect(edit.body.reply_markup).toEqual({ inline_keyboard: [] });
    assertTokenOnlyInUrlButtons(LINK_TOKEN);
  });

  it('is retracted on auto-resume: "✓ Challenge cleared, continuing", keyboard (and link) gone', async () => {
    await pairOwner('fa');
    await startBot({ handoffLink: async () => link('tunnel', 'https://abc.trycloudflare.com') });
    const pr = raise();
    await waitUntil(() => tg.of('sendPhoto')[0]);
    const id = broker.pending()[0]!.id;
    expect(broker.resolve(id, 'done', 'challenge-cleared')).toBe(true);
    expect(await pr).toEqual({ answer: 'done', by: 'challenge-cleared' });
    const edit = await waitUntil(() => tg.of('editMessageCaption')[0]);
    expect(htmlToPlain(edit.body.caption)).toContain('✓ بررسی برطرف شد، ادامه می‌دهیم');
    expect(edit.body.reply_markup).toEqual({ inline_keyboard: [] });
    expect(JSON.stringify(edit.body)).not.toContain(LINK_TOKEN);
    assertTokenOnlyInUrlButtons(LINK_TOKEN);
  });

  it('falls back on BUTTON_URL_INVALID: a LAN link becomes a Wi-Fi line WITHOUT the token, once', async () => {
    await pairOwner();
    tg.rejectUrl = (u) => /^http:\/\/(192\.168|10\.|127\.)/.test(u);
    await startBot({ handoffLink: async () => link('lan', 'http://192.168.1.5:7420') });
    const pr = raise();
    const card = await waitUntil(() => tg.of('sendPhoto').find(c => !c.body.reply_markup.inline_keyboard.flat().some((b: any) => b.url)));
    expect(tg.of('sendPhoto').length).toBe(2); // one refused, one delivered — never 8 retries
    expect(revoked).toBe(1);
    const caption = htmlToPlain(card.body.caption);
    expect(caption).toContain('Open the control center on this Wi-Fi: http://192.168.1.5:7420/?handoff=ho_1');
    expect(caption).not.toContain(LINK_TOKEN);
    await new Promise(r => setTimeout(r, 80)); // a few ticks: nothing is re-sent
    expect(tg.of('sendPhoto').length).toBe(2);
    broker.cancel(broker.pending()[0]!.id);
    await pr;
    assertTokenOnlyInUrlButtons(LINK_TOKEN);
  });

  it('a refused loopback link is never shown as text', async () => {
    await pairOwner();
    tg.rejectUrl = (u) => u.startsWith('http://127.0.0.1');
    await startBot({ handoffLink: async () => link('loopback', 'http://127.0.0.1:7420') });
    const pr = raise();
    const card = await waitUntil(() => tg.of('sendPhoto').find(c => !c.body.reply_markup.inline_keyboard.flat().some((b: any) => b.url)));
    const caption = htmlToPlain(card.body.caption);
    expect(caption).not.toContain('127.0.0.1');
    expect(caption).toContain('/control');
    broker.cancel(broker.pending()[0]!.id);
    await pr;
    assertTokenOnlyInUrlButtons(LINK_TOKEN);
  });

  it('without a browser it is a text card; an uneditable photo card is deleted on retract', async () => {
    await pairOwner();
    browserRunning = false;
    await startBot({ handoffLink: async () => null });
    const pr = raise();
    const card = await waitUntil(() => tg.of('sendMessage').find(c => c.body.reply_markup));
    expect(htmlToPlain(card.body.text)).toContain('A bot check needs you');
    expect(card.body.reply_markup.inline_keyboard).toHaveLength(1); // Done / Can't only
    broker.resolve(broker.pending()[0]!.id, 'done', 'challenge-cleared');
    await pr;
    const edit = await waitUntil(() => tg.of('editMessageText')[0]);
    expect(htmlToPlain(edit.body.text)).toContain('Challenge cleared, continuing');

    browserRunning = true;
    tg.editCaptionError = "Bad Request: message can't be edited";
    const pr2 = raise(broker, 'ho_2');
    await waitUntil(() => tg.of('sendPhoto')[0]);
    broker.resolve(broker.pending()[0]!.id, 'done', 'challenge-cleared');
    await pr2;
    await waitUntil(() => tg.of('deleteMessage')[0]);
  });

  it('a photo Telegram refuses still goes out as a text card', async () => {
    await pairOwner();
    tg.photoError = 'Bad Request: PHOTO_INVALID_DIMENSIONS';
    await startBot({ handoffLink: async () => null });
    const pr = raise();
    await waitUntil(() => tg.of('sendMessage').find(c => c.body.reply_markup));
    expect(tg.of('sendPhoto').length).toBe(1);
    broker.cancel(broker.pending()[0]!.id);
    await pr;
  });

  it('a detached mission\'s hand-off: text card, no screenshot or link from this process', async () => {
    await pairOwner();
    const approvals: TelegramMissionApproval[] = [{ id: 'mapp_1', missionId: 'm_1', prompt: 'A bot check on shop.example needs you.', options: ['done', 'cancel'], category: 'challenge', risk: 'medium' }];
    const resolved: Array<[string, string]> = [];
    const missions = {
      async list() { return []; }, async start() { return { id: 'x' }; }, async cancel() { return true; }, async status() { return null; },
      async pendingApprovals() { return approvals; },
      async resolveApproval(id: string, answer: string) { resolved.push([id, answer]); approvals.length = 0; return true; },
    } as unknown as TelegramMissionAdapter;
    let minted = 0;
    await startBot({ missions, handoffLink: async () => { minted++; return null; } });
    const card = await waitUntil(() => tg.of('sendMessage').find(c => c.body.reply_markup));
    expect(tg.of('sendPhoto')).toEqual([]);
    expect(clips).toEqual([]);
    expect(minted).toBe(0);
    const text = htmlToPlain(card.body.text);
    expect(text).toContain('m_1');
    expect(text).not.toMatch(/reply/i);
    await bot!.handleUpdate({ update_id: 2, callback_query: { id: 'cq2', from: { id: OWNER, first_name: 'A' }, message: { message_id: card.body.message_id ?? 700, date: 0, chat: { id: OWNER, type: 'private' }, text: 'x' }, data: card.body.reply_markup.inline_keyboard[0][0].callback_data } } as TgUpdate);
    expect(resolved).toEqual([['mapp_1', 'done']]);
  });

  it('with the real control center: a loopback link button is refused, the card still arrives, no token anywhere', async () => {
    await stopControlCenter();
    const global = getApprovalBroker();
    global.reset();
    const mgr = { ...fakeBrowser(), isTakeover: () => true, status: () => ({ running: true, mode: 'launch', headless: true, profile: 'x', tabs: [], takeover: true, takeoverBy: handoffOwner('ho_1'), downloadsDir: '/tmp' }) } as unknown as BrowserManager;
    setBrowserManagerForTests(mgr);
    const info = await startControlCenter({ port: 0, token: 'telegram-handoff-token-0123456789' });
    try {
      await pairOwner();
      tg.rejectUrl = (u) => u.startsWith('http://127.0.0.1');
      broker = global;
      await startBot({ browser: () => mgr });
      const pr = raise(global);
      const card = await waitUntil(() => tg.of('sendPhoto').find(c => !c.body.reply_markup.inline_keyboard.flat().some((b: any) => b.url)), 8000);
      const refused = tg.of('sendPhoto').find(c => c.body.reply_markup.inline_keyboard.flat().some((b: any) => b.url));
      expect(refused).toBeDefined();
      const url = refused!.body.reply_markup.inline_keyboard[0][0].url as string;
      expect(url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${info.port}/\\?h=[A-Za-z0-9_-]{43}&handoff=ho_1$`));
      const token = new URL(url).searchParams.get('h')!;
      // the refused link was revoked at once
      const r = await fetch(`http://127.0.0.1:${info.port}/api/state?h=${token}`);
      expect(r.status).toBe(401);
      expect(htmlToPlain(card.body.caption)).not.toContain('127.0.0.1');
      global.cancel(global.pending()[0]!.id);
      await pr;
      assertTokenOnlyInUrlButtons(token);
    } finally {
      await bot?.stop();
      bot = null;
      await stopControlCenter();
      setBrowserManagerForTests(null);
      global.reset();
    }
  });
});

describe('hand-off card with the browser controller\'s meta shape', () => {
  it('accepts frameBox {x, y, w, h}; a plain step hand-off asks for Done', async () => {
    await pairOwner();
    await startBot({ handoffLink: async () => null });
    const pr = broker.request({
      prompt: '🧩 QodeX needs you in the browser: solve the CAPTCHA\nAnswer "done" when finished or "cancel" to give up.',
      options: ['done', 'cancel'], source: 'browser_request_human', category: 'challenge', risk: 'medium', timeoutMs: 60_000,
      meta: { handoff: { id: 'ho_h1', host: 'shop.example', vendor: 'datadome', state: 'needs-human', tabIndex: 0, frameBox: { x: 10, y: 20, w: 400, h: 300 }, linkTtlSec: 300 } },
    });
    await waitUntil(() => tg.of('sendPhoto')[0]);
    expect(clips[0]).toEqual(padClip({ x: 10, y: 20, width: 400, height: 300 }));
    broker.cancel(broker.pending()[0]!.id);
    await pr;
    const step = broker.request({
      prompt: 'Do the 2FA step', options: ['done', 'cancel'], source: 'browser_request_human', category: 'challenge', timeoutMs: 60_000,
      meta: { handoff: { id: 'ho_step', host: 'bank.example', tabIndex: 0, linkTtlSec: 300 } },
    });
    const card = await waitUntil(() => tg.of('sendPhoto')[1]);
    expect(htmlToPlain(card.body.caption)).toContain('QodeX needs you in the browser');
    expect(htmlToPlain(card.body.caption)).toContain('then tap Done');
    expect(clips[1]).toBeUndefined(); // no box: the whole viewport
    broker.cancel(broker.pending()[0]!.id);
    await step;
  });
});

describe('hand-off formatting', () => {
  it('formats cards and outcomes in both languages, without links in text', () => {
    const en = htmlToPlain(formatHandoffCard({ host: 'a.example', vendor: 'hcaptcha' }, 'en', { linkTtlMin: 5 }));
    expect(en).toContain('a.example · hCaptcha');
    expect(en).toContain('5 min');
    const fa = htmlToPlain(formatHandoffCard({ host: 'a.example', vendor: 'datadome' }, 'fa', { lanUrl: 'http://10.0.0.2:7420/?handoff=ho_1&k=SECRETSECRETSECRET' }));
    expect(fa).toContain('Wi-Fi');
    expect(fa).not.toContain('SECRETSECRETSECRET');
    expect(vendorLabel('perimeterx')).toBe('HUMAN (PerimeterX)');
    expect(formatHandoffOutcome({ answer: 'done', by: 'challenge-cleared' }, 'en')).toBe('✓ Challenge cleared, continuing');
    expect(formatHandoffOutcome({ answer: 'cancel', by: 'timeout' }, 'en')).toMatch(/in time/);
    expect(formatHandoffOutcome({ answer: 'cancel', by: 'telegram' }, 'fa')).toContain('صرف‌نظر');
    expect(formatHandoffOutcome({ answer: 'cancel', by: 'abort' }, 'en')).toMatch(/stopped/);
    expect(formatOutcome({ answer: 'done', by: 'challenge-cleared' }, ['done', 'cancel'], 'en')).toContain('auto-resume');
    const kb = handoffKeyboard('ap_x', ['done', 'cancel'], 'en');
    expect(kb.inline_keyboard).toEqual([[{ text: '✅ Done', callback_data: 'ap:ap_x:0' }, { text: '✖️ Can\'t solve it', callback_data: 'ap:ap_x:1' }]]);
  });

  it('sendPhoto carries the keyboard; caption/markup edits and delete exist', async () => {
    const t = new FakeTg();
    const api = new TelegramApi({ token: TOKEN, fetch: t.fetch });
    await api.sendPhoto(5, Buffer.from([1, 2, 3]), { caption: 'c', replyMarkup: { inline_keyboard: [[{ text: 'x', url: 'https://a.example/' }]] } });
    expect(t.calls[0]!.body.reply_markup).toEqual({ inline_keyboard: [[{ text: 'x', url: 'https://a.example/' }]] });
    await api.editMessageCaption(5, 9, 'new');
    expect(t.calls[1]!.body).toMatchObject({ chat_id: 5, message_id: 9, caption: 'new', reply_markup: { inline_keyboard: [] } });
    await api.editMessageReplyMarkup(5, 9);
    expect(t.calls[2]!.body.reply_markup).toEqual({ inline_keyboard: [] });
    await api.deleteMessage(5, 9);
    expect(t.calls[3]).toMatchObject({ method: 'deleteMessage', body: { chat_id: 5, message_id: 9 } });
    const err = new TelegramApiError({ method: 'sendPhoto', status: 400, description: 'Bad Request: BUTTON_URL_INVALID' });
    expect(err.isButtonUrlInvalid).toBe(true);
    expect(new TelegramApiError({ method: 'x', status: 400, description: 'Bad Request: chat not found' }).isButtonUrlInvalid).toBe(false);
    expect(buildMultipart({ reply_markup: '{"a":1}' }, { field: 'photo', filename: 'a.jpg', contentType: 'image/jpeg', data: Buffer.from([1]) }).body.toString()).toContain('name="reply_markup"');
  });
});
