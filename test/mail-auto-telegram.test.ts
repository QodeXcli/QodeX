import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TelegramApi, type FetchLike, type TgUpdate } from '../src/channels/telegram/api.js';
import { TelegramPairingStore } from '../src/channels/telegram/pairing.js';
import { TelegramBot } from '../src/channels/telegram/bot.js';
import { formatMailNotice } from '../src/channels/telegram/mail.js';
import { notifyMailEventTelegram } from '../src/channels/telegram/notifier.js';
import { ApprovalBroker } from '../src/control/approvals.js';
import { getBus } from '../src/control/bus.js';
import { GrantStore, setGrantStoreForTests } from '../src/grants/store.js';
import { MailRuleStore, setMailRuleStoreForTests } from '../src/mail/rules.js';
import { setMailEventDefaultsForTests } from '../src/grants/mail-events.js';

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0';
const OWNER = 1001;
const STRANGER = 2002;

class FakeTelegram {
  sent: Array<{ chat: number; text: string; parse?: string }> = [];
  private waiters: Array<() => void> = [];
  fetch: FetchLike = async (url, init = {}) => {
    const method = url.split('/').pop()!;
    const body: any = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    switch (method) {
      case 'getMe': return ok({ id: 999, is_bot: true, first_name: 'QodeX', username: 'qx_test_bot' });
      case 'getUpdates':
        if (body.timeout === 0) return ok([]);
        await new Promise<void>((resolve, reject) => {
          const signal = init.signal;
          const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          if (signal?.aborted) return onAbort();
          signal?.addEventListener('abort', onAbort, { once: true });
          this.waiters.push(resolve);
        });
        return ok([]);
      case 'sendMessage':
        this.sent.push({ chat: Number(body.chat_id), text: String(body.text), parse: body.parse_mode });
        return ok({ message_id: this.sent.length + 100, date: Math.floor(Date.now() / 1000), chat: { id: Number(body.chat_id), type: 'private' }, text: body.text });
      default:
        return ok(true);
    }
  };
}

let tmp: string;
let fake: FakeTelegram;
let pairing: TelegramPairingStore;
let grants: GrantStore;
let rules: MailRuleStore;
let bot: TelegramBot | null = null;

function message(chatId: number, text: string): TgUpdate {
  return { update_id: Math.floor(Math.random() * 1e6), message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'private' }, from: { id: chatId, first_name: 'A', username: chatId === OWNER ? 'alice' : 'mallory', language_code: 'en' }, text } } as TgUpdate;
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-mail-tg-'));
  fake = new FakeTelegram();
  pairing = new TelegramPairingStore({ file: path.join(tmp, 'telegram.json') });
  const { code } = await pairing.createPairingCode();
  expect((await pairing.consumeCode(code, { chatId: OWNER, username: 'alice', lang: 'en' })).ok).toBe(true);
  grants = new GrantStore({ file: path.join(tmp, 'grants.json') });
  rules = new MailRuleStore({ file: path.join(tmp, 'rules.json') });
  setGrantStoreForTests(grants);
  setMailRuleStoreForTests(rules);
  setMailEventDefaultsForTests({ feedFile: null, desktop: false, telegram: false });
  getBus().reset();
});
afterEach(async () => {
  await bot?.stop();
  bot = null;
  setGrantStoreForTests(null);
  setMailRuleStoreForTests(null);
  setMailEventDefaultsForTests(null);
  getBus().reset();
  await fs.rm(tmp, { recursive: true, force: true });
});

function makeBot(): TelegramBot {
  bot = new TelegramBot({
    api: new TelegramApi({ token: TOKEN, fetch: fake.fetch }),
    pairing, broker: new ApprovalBroker(), browser: () => null, tickMs: 60_000,
    log: () => {},
  });
  return bot;
}

describe('Telegram /allow and /mail', () => {
  it('a paired chat creates, lists and revokes a standing reply grant', async () => {
    const b = makeBot();
    await b.handleUpdate(message(OWNER, '/allow mail-replies --account work --from @acme.com --max-per-day 5'));
    const [g] = await grants.list();
    expect(g).toMatchObject({ kind: 'mail-reply', account: 'work', from: ['@acme.com'], maxPerDay: 5, createdBy: 'telegram:@alice' });
    expect(fake.sent.at(-1)?.text).toContain(`Created standing grant ${g.id}`);
    await b.handleUpdate(message(OWNER, '/allow'));
    expect(fake.sent.at(-1)?.text).toContain(g.id);
    await b.handleUpdate(message(OWNER, `/allow revoke ${g.id}`));
    expect(fake.sent.at(-1)?.text).toContain(`Revoked ${g.id}`);
    expect(await grants.list()).toEqual([]);
  });

  it('an unpaired chat can do nothing', async () => {
    const b = makeBot();
    await b.handleUpdate(message(STRANGER, '/allow mail-replies'));
    await b.handleUpdate(message(STRANGER, '/mail reply-all'));
    expect(await grants.list()).toEqual([]);
    expect(await rules.list()).toEqual([]);
  });

  it('/mail rule add with quoted conditions and task, and /mail reply-all', async () => {
    const b = makeBot();
    await b.handleUpdate(message(OWNER, '/mail rule add "from:@acme.com subject:invoice" "save the PDF and tell me the total"'));
    const [r] = await rules.list();
    expect(r).toMatchObject({ match: { from: ['@acme.com'], subject: ['invoice'] }, task: 'save the PDF and tell me the total', createdBy: 'telegram:@alice' });
    await b.handleUpdate(message(OWNER, '/mail reply-all --account work'));
    expect((await grants.list())[0]).toMatchObject({ account: 'work', createdBy: 'telegram:@alice' });
    expect((await rules.list()).some(x => x.preset === 'reply-all')).toBe(true);
    await b.handleUpdate(message(OWNER, '/mail rule add nonsense'));
    expect(fake.sent.at(-1)?.text).toMatch(/MAIL_RULE_BAD_INPUT/);
  });

  it('mail events reach the paired chat, escaped; bridged copies are not re-sent', async () => {
    const b = makeBot();
    await b.start();
    getBus().publish({ kind: 'mail', type: 'new-mail', data: { account: 'work', from: 'Eve <eve@x.org>', subject: '<b>hi</b>', snippet: '<script>alert(1)</script> click', summary: 'New mail' } });
    getBus().publish({ kind: 'mail', type: 'new-mail', data: { account: 'work', from: 'b@x.org', subject: 'bridged', bridged: true } });
    await new Promise(r => setTimeout(r, 50));
    const notices = fake.sent.filter(s => s.chat === OWNER && s.text.includes('New mail'));
    expect(notices).toHaveLength(1);
    expect(notices[0].text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(notices[0].text).toContain('&lt;b&gt;hi&lt;/b&gt;');
    expect(notices[0].text).not.toContain('<script>');
  });
});

describe('Telegram mail notices', () => {
  it('formats each event type in both languages', () => {
    for (const lang of ['en', 'fa'] as const) {
      expect(formatMailNotice('new-mail', { from: 'a@b.org', subject: 's', snippet: 'x', flagged: true }, lang)?.important).toBe(true);
      expect(formatMailNotice('auto-reply', { to: 'a@b.org', subject: 'Re: s', grantId: 'g_1', used: 1, cap: 50 }, lang)?.text).toContain('g_1');
      expect(formatMailNotice('rule-draft-only', { ruleId: 'r_1', from: 'a@b.org' }, lang)?.important).toBe(true);
      expect(formatMailNotice('grant-created', { grantId: 'g_2', summary: 'mail replies' }, lang)?.text).toContain('/allow revoke');
      expect(formatMailNotice('watch-started', {}, lang)).toBeNull();
    }
    expect(formatMailNotice('new-mail', { snippet: 'card 4111 1111 1111 1111' }, 'en')?.text).not.toContain('4111 1111 1111 1111');
  });

  it('the direct notifier (no bot in this process) sends to paired chats only when a token is set', async () => {
    const opts = { botRunning: () => false, pairingFile: path.join(tmp, 'telegram.json'), fetch: fake.fetch, config: { telegram: {} } };
    expect(await notifyMailEventTelegram({ type: 'auto-reply', data: { to: 'boss@acme.com', subject: 'Re: Q3' } }, { ...opts, env: {} })).toBe(0);
    expect(await notifyMailEventTelegram({ type: 'auto-reply', data: { to: 'boss@acme.com', subject: 'Re: Q3' } }, { ...opts, env: { TELEGRAM_BOT_TOKEN: TOKEN } })).toBe(1);
    expect(fake.sent.at(-1)).toMatchObject({ chat: OWNER });
    expect(fake.sent.at(-1)?.text).toContain('boss@acme.com');
    expect(await notifyMailEventTelegram({ type: 'auto-reply', data: {}, bridged: true }, { ...opts, env: { TELEGRAM_BOT_TOKEN: TOKEN } })).toBe(0);
    expect(await notifyMailEventTelegram({ type: 'auto-reply', data: {} }, { ...opts, botRunning: () => true, env: { TELEGRAM_BOT_TOKEN: TOKEN } })).toBe(0);
    expect(await notifyMailEventTelegram({ type: 'auto-reply', data: {} }, { ...opts, config: { telegram: { notify: false } }, env: { TELEGRAM_BOT_TOKEN: TOKEN } })).toBe(0);
  });
});
