import { describe, it, expect } from 'vitest';
import {
  TelegramApi, TelegramApiError, TelegramAbortError, buildMultipart, redactToken, maskToken, looksLikeBotToken,
  type FetchLike,
} from '../src/channels/telegram/api.js';

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0';

interface Captured { url: string; init: RequestInit }

function fakeFetch(respond: (method: string, body: any, init: RequestInit) => Response | Promise<Response>): { fetch: FetchLike; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetch: FetchLike = async (url, init = {}) => {
    calls.push({ url, init });
    const method = url.split('/').pop()!;
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    return respond(method, body, init);
  };
  return { fetch, calls };
}

const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('TelegramApi requests', () => {
  it('posts JSON to <base>/bot<token>/<method> and unwraps result', async () => {
    const { fetch, calls } = fakeFetch((m) => ok(m === 'getMe' ? { id: 1, username: 'qx_bot' } : { message_id: 7, date: 1, chat: { id: 5, type: 'private' } }));
    const api = new TelegramApi({ token: TOKEN, apiBase: 'https://tg.example/', fetch });
    expect((await api.getMe()).username).toBe('qx_bot');
    expect(calls[0].url).toBe(`https://tg.example/bot${TOKEN}/getMe`);
    expect(calls[0].init.method).toBe('POST');

    const kb = { inline_keyboard: [[{ text: 'Yes', callback_data: 'ap:x:0' }]] };
    const msg = await api.sendMessage(5, '<b>hi</b>', { replyMarkup: kb });
    expect(msg.message_id).toBe(7);
    const body = JSON.parse(String(calls[1].init.body));
    expect(body).toEqual({ chat_id: 5, text: '<b>hi</b>', parse_mode: 'HTML', reply_markup: kb, disable_web_page_preview: true });
    expect((calls[1].init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('omits parse_mode for plain text and builds getUpdates params', async () => {
    const { fetch, calls } = fakeFetch((m) => ok(m === 'getUpdates' ? [] : { message_id: 1, date: 1, chat: { id: 1, type: 'private' } }));
    const api = new TelegramApi({ token: TOKEN, fetch });
    await api.sendMessage(1, 'plain', { parseMode: null });
    expect(JSON.parse(String(calls[0].init.body)).parse_mode).toBeUndefined();
    await api.getUpdates({ offset: 42, timeout: 25, allowedUpdates: ['message', 'callback_query'] });
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ offset: 42, timeout: 25, allowed_updates: ['message', 'callback_query'] });
  });

  it('editMessageText without replyMarkup removes the keyboard; answerCallbackQuery caps text', async () => {
    const { fetch, calls } = fakeFetch(() => ok(true));
    const api = new TelegramApi({ token: TOKEN, fetch });
    await api.editMessageText(5, 9, 'done');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ chat_id: 5, message_id: 9, text: 'done', parse_mode: 'HTML', disable_web_page_preview: true });
    await api.answerCallbackQuery('cq1', { text: 'x'.repeat(500) });
    expect(JSON.parse(String(calls[1].init.body)).text.length).toBe(200);
  });

  it('rejects a bad apiBase and an empty token', () => {
    expect(() => new TelegramApi({ token: '' })).toThrow(/TELEGRAM_NOT_CONFIGURED/);
    expect(() => new TelegramApi({ token: TOKEN, apiBase: 'ftp://x' })).toThrow(/TELEGRAM_BAD_CONFIG/);
    expect(() => new TelegramApi({ token: '12/34' })).toThrow(/TELEGRAM_BAD_TOKEN/);
  });
});

describe('multipart sendPhoto', () => {
  it('builds a well-formed multipart/form-data body by hand', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0xff, 0xd9]);
    const mp = buildMultipart({ chat_id: 42, caption: 'Shop — سبد خرید', parse_mode: 'HTML', skipped: undefined },
      { field: 'photo', filename: 'a"b\r\n.jpg', contentType: 'image/jpeg', data: jpeg }, 'BOUNDARY123');
    expect(mp.contentType).toBe('multipart/form-data; boundary=BOUNDARY123');
    const head =
      '--BOUNDARY123\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n42\r\n' +
      '--BOUNDARY123\r\nContent-Disposition: form-data; name="caption"\r\n\r\nShop — سبد خرید\r\n' +
      '--BOUNDARY123\r\nContent-Disposition: form-data; name="parse_mode"\r\n\r\nHTML\r\n' +
      '--BOUNDARY123\r\nContent-Disposition: form-data; name="photo"; filename="a_b__.jpg"\r\nContent-Type: image/jpeg\r\n\r\n';
    const expected = Buffer.concat([Buffer.from(head, 'utf-8'), jpeg, Buffer.from('\r\n--BOUNDARY123--\r\n', 'utf-8')]);
    expect(mp.body.equals(expected)).toBe(true);
    expect(mp.body.toString('utf-8')).not.toContain('skipped');
  });

  it('re-rolls the boundary when a field contains it', () => {
    const mp = buildMultipart({ caption: 'xx--BOUND--xx' }, { field: 'photo', filename: 'a.jpg', contentType: 'image/jpeg', data: Buffer.from([1]) }, 'BOUND');
    expect(mp.boundary).not.toBe('BOUND');
    expect(mp.contentType).toContain(mp.boundary);
  });

  it('sendPhoto posts the multipart body with the right content type', async () => {
    const { fetch, calls } = fakeFetch(() => ok({ message_id: 3, date: 1, chat: { id: 9, type: 'private' } }));
    const api = new TelegramApi({ token: TOKEN, fetch });
    const jpeg = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);
    await api.sendPhoto(9, jpeg, { caption: '<b>Shop</b>', filename: 'screen.jpg' });
    const init = calls[0].init;
    const ct = (init.headers as Record<string, string>)['Content-Type'];
    const boundary = /boundary=(.+)$/.exec(ct)![1];
    const body = init.body as Buffer;
    expect(Buffer.isBuffer(body)).toBe(true);
    const text = body.toString('latin1');
    expect(text.startsWith(`--${boundary}\r\n`)).toBe(true);
    expect(text).toContain('name="chat_id"\r\n\r\n9\r\n');
    expect(text).toContain('name="parse_mode"\r\n\r\nHTML\r\n');
    expect(text).toContain('name="photo"; filename="screen.jpg"\r\nContent-Type: image/jpeg\r\n\r\n');
    expect(body.includes(jpeg)).toBe(true);
    expect(text.endsWith(`\r\n--${boundary}--\r\n`)).toBe(true);
  });
});

describe('errors and token redaction', () => {
  it('maps Telegram errors and never leaks the token', async () => {
    const { fetch } = fakeFetch(() => new Response(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }), { status: 401 }));
    const api = new TelegramApi({ token: TOKEN, fetch });
    const err = await api.getMe().catch((e) => e);
    expect(err).toBeInstanceOf(TelegramApiError);
    expect(err.isUnauthorized).toBe(true);
    expect(err.message).toMatch(/^\[TELEGRAM_UNAUTHORIZED\] getMe failed \(HTTP 401\): Unauthorized/);
    expect(err.message).not.toContain(TOKEN);
  });

  it('redacts the token from transport errors that echo the URL', async () => {
    const fetch: FetchLike = async (url) => {
      const e = new Error(`fetch failed for ${url}`);
      (e as any).cause = { code: 'ECONNRESET' };
      throw e;
    };
    const api = new TelegramApi({ token: TOKEN, fetch });
    const err = await api.sendMessage(1, 'x').catch((e) => e);
    expect(err).toBeInstanceOf(TelegramApiError);
    expect(err.status).toBe(0);
    expect(err.isRetryable).toBe(true);
    expect(err.message).toContain('[TELEGRAM_NETWORK]');
    expect(err.message).toContain('ECONNRESET');
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toContain('AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0');
    expect(err.message).toContain('bot<redacted>');
  });

  it('treats an HTML 502 as retryable and parses 429 retry_after and 409 conflicts', async () => {
    let n = 0;
    const { fetch } = fakeFetch(() => {
      n++;
      if (n === 1) return new Response('<html><body><h1>502 Bad Gateway</h1></body></html>', { status: 502, statusText: 'Bad Gateway' });
      if (n === 2) return new Response(JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests: retry after 7', parameters: { retry_after: 7 } }), { status: 429 });
      return new Response(JSON.stringify({ ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' }), { status: 409 });
    });
    const api = new TelegramApi({ token: TOKEN, fetch });
    const e1 = await api.getUpdates().catch((e) => e);
    expect(e1.status).toBe(502);
    expect(e1.isRetryable).toBe(true);
    expect(e1.message).toContain('Bad Gateway');
    const e2 = await api.getUpdates().catch((e) => e);
    expect(e2.isRateLimited).toBe(true);
    expect(e2.retryAfterSec).toBe(7);
    const e3 = await api.getUpdates().catch((e) => e);
    expect(e3.isConflict).toBe(true);
    expect(e3.message).toContain('[TELEGRAM_CONFLICT]');
  });

  it('times out and distinguishes caller aborts', async () => {
    const hang: FetchLike = (_url, init) => new Promise((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
    });
    const api = new TelegramApi({ token: TOKEN, fetch: hang, requestTimeoutMs: 30 });
    const t = await api.getMe().catch((e) => e);
    expect(t).toBeInstanceOf(TelegramApiError);
    expect(t.message).toMatch(/timed out/);

    const ac = new AbortController();
    const p = api.getUpdates({ timeout: 25, signal: ac.signal }).catch((e) => e);
    ac.abort();
    expect(await p).toBeInstanceOf(TelegramAbortError);
  });

  it('flags HTML parse errors and not-modified edits', async () => {
    const { fetch } = fakeFetch((m) => new Response(JSON.stringify({
      ok: false, error_code: 400,
      description: m === 'sendMessage' ? "Bad Request: can't parse entities: Unsupported start tag" : 'Bad Request: message is not modified',
    }), { status: 400 }));
    const api = new TelegramApi({ token: TOKEN, fetch });
    expect((await api.sendMessage(1, '<x>').catch((e) => e)).isParseError).toBe(true);
    expect((await api.editMessageText(1, 2, 'same').catch((e) => e)).isNotModified).toBe(true);
  });

  it('tracks Telegram\'s clock from the Date header and flags over-long messages', async () => {
    const serverMs = Date.parse('2026-01-02T03:04:05Z');
    const { fetch } = fakeFetch((m) => m === 'getMe'
      ? new Response(JSON.stringify({ ok: true, result: { id: 1 } }), { status: 200, headers: { Date: new Date(serverMs).toUTCString() } })
      : new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: message is too long' }), { status: 400 }));
    const api = new TelegramApi({ token: TOKEN, fetch });
    expect(api.serverNow()).toBeNull();
    await api.getMe();
    const now = api.serverNow()!;
    expect(now).toBeGreaterThanOrEqual(serverMs);
    expect(now - serverMs).toBeLessThan(5000);
    const err = await api.sendMessage(1, 'x').catch((e) => e);
    expect(err.isTooLong).toBe(true);
    expect(err.isParseError).toBe(false);
  });

  it('redactToken / maskToken / looksLikeBotToken', () => {
    expect(redactToken(`see https://api.telegram.org/bot${TOKEN}/getMe`)).toBe('see https://api.telegram.org/bot<redacted>/getMe');
    expect(redactToken(`token=${TOKEN}`, TOKEN)).toBe('token=<redacted>');
    expect(redactToken('nothing secret 12:34')).toBe('nothing secret 12:34');
    expect(maskToken(TOKEN)).toBe('123456789:AA…(redacted)');
    expect(maskToken(TOKEN)).not.toContain('dqTc');
    expect(maskToken('')).toBe('(not set)');
    expect(looksLikeBotToken(TOKEN)).toBe(true);
    expect(looksLikeBotToken('hello')).toBe(false);
    expect(looksLikeBotToken('12345:short')).toBe(false);
  });
});

describe('against a real local HTTP server', () => {
  it('round-trips JSON calls and a multipart photo that a real parser accepts', async () => {
    const http = await import('http');
    const seen: Array<{ url: string; ct: string; body: Buffer }> = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        seen.push({ url: req.url ?? '', ct: String(req.headers['content-type'] ?? ''), body: Buffer.concat(chunks) });
        const method = (req.url ?? '').split('/').pop();
        res.setHeader('Content-Type', 'application/json');
        if (method === 'getMe') res.end(JSON.stringify({ ok: true, result: { id: 1, username: 'local_bot' } }));
        else if (method === 'sendPhoto') res.end(JSON.stringify({ ok: true, result: { message_id: 9, date: 1, chat: { id: 5, type: 'private' } } }));
        else { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: chat not found' })); }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as any).port;
    try {
      const api = new TelegramApi({ token: TOKEN, apiBase: `http://127.0.0.1:${port}`, fetch: (u, i) => fetch(u, i) });
      expect((await api.getMe()).username).toBe('local_bot');
      expect(seen[0].url).toBe(`/bot${TOKEN}/getMe`);

      // Bytes include CRLF and "--" to make sure the boundary handling is exact.
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x0d, 0x0a, 0x2d, 0x2d, 0xff, 0xd9]);
      await api.sendPhoto(5, jpeg, { caption: 'سبد خرید — <b>Cart</b>', filename: 'shot.jpg' });
      const form = await new Response(seen[1].body, { headers: { 'content-type': seen[1].ct } }).formData();
      expect(form.get('chat_id')).toBe('5');
      expect(form.get('caption')).toBe('سبد خرید — <b>Cart</b>');
      expect(form.get('parse_mode')).toBe('HTML');
      const photo = form.get('photo') as any;
      expect(photo.name).toBe('shot.jpg');
      expect(photo.type).toBe('image/jpeg');
      expect(Buffer.from(await photo.arrayBuffer()).equals(jpeg)).toBe(true);

      const err = await api.sendMessage(5, 'x').catch((e) => e);
      expect(err).toBeInstanceOf(TelegramApiError);
      expect(err.status).toBe(400);
      expect(err.message).toContain('chat not found');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
