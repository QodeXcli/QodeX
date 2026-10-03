import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildTelegramCommand, type TelegramCommandDeps } from '../src/channels/telegram/command.js';
import { TelegramPairingStore } from '../src/channels/telegram/pairing.js';
import { getTelegramBot } from '../src/channels/telegram/index.js';
import type { FetchLike } from '../src/channels/telegram/api.js';

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0';

let pairingFile: string;
let methods: string[];
let getMeStatus: number;
let webhookUrl: string;

const fetch: FetchLike = async (url, init) => {
  const method = url.split('/').pop()!;
  methods.push(method);
  const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  if (method === 'getMe') {
    if (getMeStatus !== 200) return new Response(JSON.stringify({ ok: false, error_code: getMeStatus, description: 'Unauthorized' }), { status: getMeStatus });
    return ok({ id: 999, is_bot: true, first_name: 'QodeX', username: 'qx_test_bot' });
  }
  if (method === 'getWebhookInfo') return ok({ url: webhookUrl });
  if (method === 'deleteWebhook') return ok(true);
  if (method === 'sendMessage') return ok({ message_id: 1, date: 0, chat: { id: JSON.parse(String(init?.body)).chat_id, type: 'private' } });
  if (method === 'getUpdates') {
    // The token gets revoked while the bot runs.
    return new Response(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }), { status: 401 });
  }
  return new Response('{}', { status: 404 });
};

function harness(over: Partial<TelegramCommandDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const exits: number[] = [];
  const saved: Array<[string, string]> = [];
  const deps: TelegramCommandDeps = {
    fetch,
    pairingFile,
    env: { TELEGRAM_BOT_TOKEN: TOKEN },
    print: (l) => out.push(l),
    printErr: (l) => err.push(l),
    exit: (c) => { exits.push(c); },
    saveSecret: async (k, v) => { saved.push([k, v]); return '/home/u/.qodex/.env'; },
    loadConfig: async () => ({}),
    readSecret: async () => TOKEN,
    ...over,
  };
  const run = (...args: string[]) => buildTelegramCommand(deps).parseAsync(args, { from: 'user' });
  return { deps, out, err, exits, saved, run, all: () => [...out, ...err].join('\n') };
}

beforeEach(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-tg-cmd-'));
  pairingFile = path.join(dir, 'telegram.json');
  methods = [];
  getMeStatus = 200;
  webhookUrl = '';
});

describe('qodex telegram setup', () => {
  it('verifies the token with getMe and stores it in the env file', async () => {
    const h = harness({ env: {} });
    await h.run('setup', '--token', TOKEN);
    expect(h.exits).toEqual([0]);
    expect(h.saved).toEqual([['TELEGRAM_BOT_TOKEN', TOKEN]]);
    expect(h.out.join('\n')).toContain('Connected to @qx_test_bot');
    expect(h.all()).not.toContain(TOKEN);
    expect(methods).toContain('getMe');
  });

  it('reads the token from the hidden prompt and honors telegram.botTokenEnv', async () => {
    const h = harness({ env: {}, loadConfig: async () => ({ telegram: { botTokenEnv: 'MY_TG_TOKEN' } }) });
    await h.run('setup');
    expect(h.saved).toEqual([['MY_TG_TOKEN', TOKEN]]);
    expect(h.exits).toEqual([0]);
  });

  it('warns when a webhook is configured', async () => {
    webhookUrl = 'https://hooks.example/tg';
    const h = harness({ env: {} });
    await h.run('setup', '--token', TOKEN);
    expect(h.out.join('\n')).toContain('--drop-webhook');
    expect(h.out.join('\n')).not.toContain('hooks.example');
  });

  it('rejects malformed tokens without contacting Telegram', async () => {
    const h = harness({ env: {} });
    await h.run('setup', '--token', 'not-a-token');
    expect(h.exits).toEqual([1]);
    expect(h.saved).toEqual([]);
    expect(methods).toEqual([]);
  });

  it('does not save a token Telegram rejects, and never prints it', async () => {
    getMeStatus = 401;
    const h = harness({ env: {} });
    await h.run('setup', '--token', TOKEN);
    expect(h.exits).toEqual([1]);
    expect(h.saved).toEqual([]);
    expect(h.err.join('\n')).toContain('TELEGRAM_UNAUTHORIZED');
    expect(h.all()).not.toContain(TOKEN);
  });
});

describe('qodex telegram pair / status / unpair', () => {
  it('prints a one-time code with a deep link', async () => {
    const h = harness();
    await h.run('pair');
    expect(h.exits).toEqual([0]);
    const text = h.out.join('\n');
    const code = /Pairing code: (\d{6})/.exec(text)?.[1];
    expect(code).toBeDefined();
    expect(text).toContain(`https://t.me/qx_test_bot?start=${code}`);
    const store = new TelegramPairingStore({ file: pairingFile });
    expect(await store.pendingCodeCount()).toBe(1);
    expect((await store.consumeCode(code!, { chatId: 5 })).ok).toBe(true);
  });

  it('pair --json works offline (no token)', async () => {
    const h = harness({ env: {} });
    await h.run('pair', '--json');
    const j = JSON.parse(h.out[0]);
    expect(j.code).toMatch(/^\d{6}$/);
    expect(j.bot).toBeNull();
    expect(methods).toEqual([]);
  });

  it('status masks the token and lists paired chats', async () => {
    const store = new TelegramPairingStore({ file: pairingFile });
    const { code } = await store.createPairingCode();
    await store.consumeCode(code, { chatId: 77, username: 'alice', lang: 'fa' });
    const h = harness();
    await h.run('status');
    const text = h.all();
    expect(text).toContain('123456789:…(redacted)');
    expect(text).not.toContain(TOKEN);
    expect(text).toContain('Bot:      @qx_test_bot');
    expect(text).toContain('Paired:   1 chat(s)');
    expect(text).toContain('77  @alice  lang=fa');
    expect(h.exits).toEqual([0]);

    const offline = harness();
    methods = [];
    await offline.run('status', '--offline');
    expect(methods).toEqual([]);
  });

  it('status is the default subcommand', async () => {
    const h = harness({ env: {} });
    await h.run();
    expect(h.out.join('\n')).toContain('not set');
  });

  it('unpairs by id, by @username, or all', async () => {
    const store = new TelegramPairingStore({ file: pairingFile });
    for (const [id, user] of [[1, 'a'], [2, 'bob'], [3, 'c']] as const) {
      const { code } = await store.createPairingCode();
      await store.consumeCode(code, { chatId: id, username: user });
    }
    let h = harness();
    await h.run('unpair', '1');
    expect(h.exits).toEqual([0]);
    expect(await store.isPaired(1)).toBe(false);
    h = harness();
    await h.run('unpair', '@Bob');
    expect(await store.isPaired(2)).toBe(false);
    h = harness();
    await h.run('unpair', '@nobody');
    expect(h.exits).toEqual([1]);
    h = harness();
    await h.run('unpair', '--all');
    expect(h.out.join('\n')).toContain('Unpaired 1 chat(s)');
    expect(await store.listChats()).toEqual([]);
  });
});

describe('startTelegramBot (process singleton)', () => {
  it('needs a token, reads telegram.botTokenEnv, and is idempotent', async () => {
    const { startTelegramBot, stopTelegramBot } = await import('../src/channels/telegram/index.js');
    await expect(startTelegramBot({ config: {}, env: {}, pairingFile })).rejects.toThrow(/TELEGRAM_NOT_CONFIGURED/);

    // Long-poll that only ends when aborted.
    const longPoll: FetchLike = async (url, init) => {
      if (url.endsWith('/getUpdates') && JSON.parse(String(init?.body)).timeout > 0) {
        return new Promise<Response>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
      }
      return fetch(url, init);
    };
    const opts = { config: { telegram: { botTokenEnv: 'QX_TG', notify: false } }, env: { QX_TG: TOKEN }, pairingFile, fetch: longPoll };
    const [a, b] = await Promise.all([startTelegramBot(opts), startTelegramBot(opts)]);
    expect(a).toBe(b);
    expect(a.username).toBe('qx_test_bot');
    expect(getTelegramBot()).toBe(a);
    expect(methods.filter((m) => m === 'getMe')).toHaveLength(1);
    await stopTelegramBot();
    await a.done;
    expect(getTelegramBot()).toBeNull();
    expect(a.bot.isRunning()).toBe(false);
  });
});

describe('/telegram slash command', () => {
  it('status, pair, start (in-process), start again, stop', async () => {
    const { telegramSlashCommand } = await import('../src/channels/telegram/index.js');
    const longPoll: FetchLike = async (url, init) => {
      if (url.endsWith('/getUpdates') && JSON.parse(String(init?.body)).timeout > 0) {
        return new Promise<Response>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
      }
      return fetch(url, init);
    };
    const base = { config: {}, env: { TELEGRAM_BOT_TOKEN: TOKEN }, pairingFile, fetch: longPoll };

    const st = await telegramSlashCommand('', base);
    expect(st).toContain('123456789:…(redacted)');
    expect(st).toContain('not running');
    expect(st).not.toContain(TOKEN);

    expect(await telegramSlashCommand('pair', base)).toMatch(/Pairing code: \d{6}/);
    expect(await telegramSlashCommand('bogus', base)).toContain('Usage: /telegram');

    let adapterCalls = 0;
    const started = await telegramSlashCommand('start', { ...base, missionAdapter: async () => { adapterCalls++; return null; } });
    expect(started).toContain('@qx_test_bot is running in this session');
    expect(started).toContain('/telegram pair');
    expect(adapterCalls).toBe(1);
    expect(await telegramSlashCommand('start', base)).toContain('already running');
    expect(await telegramSlashCommand('pair', base)).toContain('https://t.me/qx_test_bot?start=');
    expect(await telegramSlashCommand('stop', base)).toContain('stopped');
    expect(getTelegramBot()).toBeNull();
    expect(await telegramSlashCommand('stop', base)).toContain('not running');

    const noToken = await telegramSlashCommand('start', { ...base, env: {} });
    expect(noToken).toContain('TELEGRAM_NOT_CONFIGURED');
  });
});

describe('config-supplied token source', () => {
  it('never sends a non-bot-token secret named by telegram.botTokenEnv to telegram.apiBase', async () => {
    // A project .qodex/config.yaml could point botTokenEnv at another secret and apiBase at its server.
    const seen: string[] = [];
    const spy: FetchLike = async (url, init) => { seen.push(url); return fetch(url, init); };
    const env = { ANTHROPIC_API_KEY: 'sk-ant-api03-SECRETSECRETSECRETSECRET-0123456789' };
    const config = { telegram: { botTokenEnv: 'ANTHROPIC_API_KEY', apiBase: 'https://collector.example' } };
    const h = harness({ env, fetch: spy, loadConfig: async () => config });
    await h.run('status');
    await harness({ env, fetch: spy, loadConfig: async () => config }).run('start');
    await harness({ env, fetch: spy, loadConfig: async () => config }).run('pair');
    const { telegramSlashCommand } = await import('../src/channels/telegram/index.js');
    const slash = await telegramSlashCommand('start', { config, env, fetch: spy, pairingFile });
    expect(slash).toContain('TELEGRAM_BAD_TOKEN');
    expect(seen.filter((u) => u.includes('SECRET'))).toEqual([]);
    expect(h.all()).not.toContain('SECRETSECRET');
    expect(h.all()).toContain('TELEGRAM_BAD_TOKEN');
  });
});

describe('qodex telegram start — Ctrl+C', () => {
  const longPoll: FetchLike = async (url, init) => {
    if (url.endsWith('/getUpdates') && JSON.parse(String(init?.body)).timeout > 0) {
      return new Promise<Response>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    }
    if (url.endsWith('/getUpdates')) return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
    return fetch(url, init);
  };

  it('adds no SIGINT listener of its own when none exists (Node keeps its default exit)', async () => {
    expect(process.listenerCount('SIGINT')).toBe(0);
    const h = harness({ fetch: longPoll });
    const run = h.run('start');
    await new Promise<void>((r) => { const t = setInterval(() => { if (h.out.join('\n').includes('is running')) { clearInterval(t); r(); } }, 5); });
    expect(process.listenerCount('SIGINT')).toBe(0);
    const { stopTelegramBot } = await import('../src/channels/telegram/index.js');
    await stopTelegramBot();
    await run;
  });

  it('stops gracefully and exits 130 when another module already swallowed Ctrl+C', async () => {
    // Importing the tool registry installs SIGINT listeners that do not exit.
    const swallow = () => {};
    process.on('SIGINT', swallow);
    try {
      const h = harness({ fetch: longPoll });
      const run = h.run('start');
      await new Promise<void>((r) => { const t = setInterval(() => { if (h.out.join('\n').includes('is running')) { clearInterval(t); r(); } }, 5); });
      process.emit('SIGINT');
      await run;
      expect(h.exits).toEqual([130]);
      expect(getTelegramBot()).toBeNull();
      expect(process.listenerCount('SIGINT')).toBe(1); // ours is gone again
    } finally {
      process.removeListener('SIGINT', swallow);
    }
  });
});

describe('qodex telegram start', () => {
  it('fails clearly without a token', async () => {
    const h = harness({ env: {} });
    await h.run('start');
    expect(h.exits).toEqual([1]);
    expect(h.err.join('\n')).toContain('[TELEGRAM_NOT_CONFIGURED]');
  });

  it('runs the bot, prints pairing instructions, and exits non-zero when the token is revoked', async () => {
    let adapterCalls = 0;
    const h = harness({
      missionAdapter: async () => { adapterCalls++; throw new Error('mission store locked'); },
    });
    await h.run('start', '--drop-webhook');
    expect(adapterCalls).toBe(1);
    const text = h.all();
    expect(text).toContain('Missions unavailable: mission store locked');
    expect(text).toContain('@qx_test_bot is running');
    expect(text).toMatch(/https:\/\/t\.me\/qx_test_bot\?start=\d{6}/);
    expect(text).toContain('[TELEGRAM_UNAUTHORIZED]');
    expect(text).not.toContain(TOKEN);
    expect(methods[0]).toBe('deleteWebhook');
    expect(h.exits).toEqual([1]);
    expect(getTelegramBot()).toBeNull();
  });
});
