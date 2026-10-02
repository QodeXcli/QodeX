import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TelegramPairingStore, normalizeCode } from '../src/channels/telegram/pairing.js';

let dir: string;
let file: string;
let clock: number;
const now = () => clock;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-tg-pair-'));
  file = path.join(dir, 'channels', 'telegram.json');
  clock = 1_700_000_000_000;
});

const chat = (chatId: number, extra: Record<string, string> = {}) => ({ chatId, username: 'alice', lang: 'en', ...extra });

describe('TelegramPairingStore', () => {
  it('creates 6-digit one-time codes stored only as hashes (0600)', async () => {
    const store = new TelegramPairingStore({ file, now });
    const { code, expiresAt } = await store.createPairingCode();
    expect(code).toMatch(/^\d{6}$/);
    expect(expiresAt).toBe(clock + 10 * 60_000);
    const raw = await fs.readFile(file, 'utf-8');
    expect(raw).not.toContain(code);
    expect(JSON.parse(raw).codes[0].hash).toMatch(/^[0-9a-f]{64}$/);
    if (process.platform !== 'win32') {
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    }
    expect(await store.pendingCodeCount()).toBe(1);
  });

  it('pairs with the right code exactly once; rejects wrong codes', async () => {
    const store = new TelegramPairingStore({ file, now });
    const { code } = await store.createPairingCode();
    const wrong = code === '000000' ? '111111' : '000000';
    expect(await store.consumeCode(wrong, chat(1))).toEqual({ ok: false, reason: 'invalid' });
    expect(await store.isPaired(1)).toBe(false);
    expect(await store.consumeCode('12ab', chat(1))).toEqual({ ok: false, reason: 'malformed' });

    const r = await store.consumeCode(code, chat(1, { lang: 'fa-IR' }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.alreadyPaired).toBe(false);
      expect(r.chat).toMatchObject({ chatId: 1, username: 'alice', lang: 'fa-IR', pairedAt: clock });
    }
    expect(await store.isPaired(1)).toBe(true);
    // Single use: the same code can't pair a second chat.
    expect(await store.consumeCode(code, chat(2))).toEqual({ ok: false, reason: 'invalid' });
    expect(await store.isPaired(2)).toBe(false);
    // An already-paired chat is reported as such.
    const again = await store.consumeCode('999999', chat(1));
    expect(again.ok && again.alreadyPaired).toBe(true);
  });

  it('expires codes after 10 minutes', async () => {
    const store = new TelegramPairingStore({ file, now });
    const { code } = await store.createPairingCode();
    clock += 10 * 60_000 + 1;
    expect(await store.consumeCode(code, chat(1))).toEqual({ ok: false, reason: 'expired' });
    expect(await store.isPaired(1)).toBe(false);
    expect(await store.pendingCodeCount()).toBe(0);
  });

  it('accepts Persian/Arabic digits and separators', async () => {
    expect(normalizeCode('۱۲۳ ۴۵۶')).toBe('123456');
    expect(normalizeCode('٧٨٩-٠١٢')).toBe('789012');
    const store = new TelegramPairingStore({ file, now });
    const { code } = await store.createPairingCode();
    const fa = code.replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
    expect((await store.consumeCode(fa, chat(7))).ok).toBe(true);
  });

  it('locks a chat out after 5 wrong codes within an hour', async () => {
    const store = new TelegramPairingStore({ file, now });
    const { code } = await store.createPairingCode();
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) expect((await store.consumeCode(wrong, chat(3))).ok).toBe(false);
    expect(await store.consumeCode(code, chat(3))).toEqual({ ok: false, reason: 'locked' });
    // Another chat can still use the code.
    expect((await store.consumeCode(code, chat(4))).ok).toBe(true);
    clock += 60 * 60_000 + 1;
    const { code: code2 } = await store.createPairingCode();
    expect((await store.consumeCode(code2, chat(3))).ok).toBe(true);
  });

  it('burns every outstanding code after too many wrong guesses across chats', async () => {
    const store = new TelegramPairingStore({ file, now, maxGlobalFailures: 6 });
    const { code } = await store.createPairingCode();
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 6; i++) await store.consumeCode(wrong, chat(100 + i));
    expect(await store.pendingCodeCount()).toBe(0);
    expect(await store.consumeCode(code, chat(200))).toEqual({ ok: false, reason: 'invalid' });
  });

  it('shares state across instances (CLI pair + running bot) and unpairs', async () => {
    const cli = new TelegramPairingStore({ file, now });
    const bot = new TelegramPairingStore({ file, now });
    const { code } = await cli.createPairingCode();
    expect((await bot.consumeCode(code, chat(10))).ok).toBe(true);
    expect(await cli.isPaired(10)).toBe(true);
    await bot.updateChat(10, { lang: 'fa', langPinned: true });
    expect(await cli.getChat(10)).toMatchObject({ lang: 'fa', langPinned: true });
    expect(await cli.unpair(10)).toBe(true);
    expect(await bot.isPaired(10)).toBe(false);
    expect(await cli.unpair(10)).toBe(false);
  });

  it('survives a corrupt state file', async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{not json');
    const store = new TelegramPairingStore({ file, now });
    expect(await store.listChats()).toEqual([]);
    const { code } = await store.createPairingCode();
    expect((await store.consumeCode(code, chat(1))).ok).toBe(true);
    expect(await store.unpairAll()).toBe(1);
  });
});
