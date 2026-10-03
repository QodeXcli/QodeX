/**
 * Minimal Telegram Bot API client for QodeX's remote channel.
 *
 * Only the handful of methods the bot needs (getMe, getUpdates long-polling,
 * sendMessage, editMessageText, answerCallbackQuery, sendPhoto, webhook info),
 * over an injectable `fetch` so tests never touch the network. The default
 * transport is `proxyFetch`, which honors HTTPS_PROXY / NO_PROXY — important
 * for users who can only reach api.telegram.org through a local proxy.
 *
 * Security: the bot token is part of every request URL
 * (`<base>/bot<token>/<method>`). It must never reach logs or error messages,
 * so every error raised here passes through `redactToken`. `sendPhoto` builds
 * its multipart/form-data body by hand (Buffer + random boundary) — no deps.
 */

import { randomBytes } from 'crypto';
import { proxyFetch } from '../../utils/proxy-fetch.js';

/** fetch-compatible transport (global fetch, proxyFetch, or a test fake). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

// ── Telegram object shapes (only the fields QodeX reads) ─────────────────────

export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel' | string;
  username?: string;
  first_name?: string;
  title?: string;
}

export interface TgMessage {
  message_id: number;
  /** Unix seconds. */
  date: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  caption?: string;
  reply_to_message?: TgMessage;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
  chat_instance?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface TgWebhookInfo {
  url: string;
  pending_update_count?: number;
  last_error_message?: string;
}

// ── errors + redaction ───────────────────────────────────────────────────────

/** Matches anything shaped like a bot token (`123456789:AA...`), with or without the `bot` URL prefix. */
const TOKEN_SHAPE = /(bot)?\d{5,}:[A-Za-z0-9_-]{20,}/g;

/**
 * Remove a bot token from arbitrary text: the exact token (if known) and
 * anything token-shaped. PURE. Use on every string that may end up in a log,
 * an error message, or a terminal.
 */
export function redactToken(text: string, token?: string): string {
  let out = String(text ?? '');
  if (token && token.length >= 8) out = out.split(token).join('<redacted>');
  return out.replace(TOKEN_SHAPE, (_m, bot) => (bot ? 'bot<redacted>' : '<redacted>'));
}

/** Mask a token for display: `123456:AB…(redacted)`. Never returns the secret part. */
export function maskToken(token: string): string {
  const t = String(token ?? '').trim();
  if (!t) return '(not set)';
  const colon = t.indexOf(':');
  if (colon <= 0) return '***(redacted)';
  // Only the bot id (public, it's in the bot's t.me profile); no character of the secret part.
  return `${t.slice(0, colon)}:…(redacted)`;
}

/** Loose syntactic check of a BotFather token: `<digits>:<35-ish url-safe chars>`. */
export function looksLikeBotToken(token: string): boolean {
  return /^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(String(token ?? '').trim());
}

export interface TelegramApiErrorInit {
  method: string;
  /** HTTP status; 0 for transport failures (DNS, reset, timeout). */
  status: number;
  description: string;
  errorCode?: number;
  retryAfterSec?: number;
}

export class TelegramApiError extends Error {
  readonly method: string;
  readonly status: number;
  readonly description: string;
  readonly errorCode?: number;
  readonly retryAfterSec?: number;

  constructor(init: TelegramApiErrorInit) {
    const code = init.status === 0 ? 'TELEGRAM_NETWORK'
      : init.status === 401 || init.status === 404 ? 'TELEGRAM_UNAUTHORIZED'
        : init.status === 409 ? 'TELEGRAM_CONFLICT'
          : init.status === 429 ? 'TELEGRAM_RATE_LIMITED'
            : 'TELEGRAM_API';
    const where = init.status === 0 ? 'network error' : `HTTP ${init.status}`;
    super(`[${code}] ${init.method} failed (${where}): ${init.description}`);
    this.name = 'TelegramApiError';
    this.method = init.method;
    this.status = init.status;
    this.description = init.description;
    this.errorCode = init.errorCode;
    this.retryAfterSec = init.retryAfterSec;
  }

  /** Another getUpdates poller (or a webhook) owns this bot. */
  get isConflict(): boolean { return this.status === 409 || this.errorCode === 409; }
  /** The token was rejected — retrying is pointless. */
  get isUnauthorized(): boolean { return this.status === 401 || this.status === 404 || this.errorCode === 401; }
  get isRateLimited(): boolean { return this.status === 429 || this.errorCode === 429; }
  /** Transient: network, 5xx, 429, 409. */
  get isRetryable(): boolean {
    return this.status === 0 || this.status >= 500 || this.isRateLimited || this.isConflict;
  }
  /** Telegram could not parse our HTML entities (fall back to plain text). */
  get isParseError(): boolean { return this.status === 400 && /parse entities|can't parse|unsupported start tag/i.test(this.description); }
  /** Text over 4096 characters (after entity parsing) — resend shortened. */
  get isTooLong(): boolean { return this.status === 400 && /too long|MESSAGE_TOO_LONG/i.test(this.description); }
  /** editMessageText with identical content — harmless. */
  get isNotModified(): boolean { return this.status === 400 && /message is not modified/i.test(this.description); }
}

/** Abort error thrown when the caller's signal fires (distinguishable from transport errors). */
export class TelegramAbortError extends Error {
  constructor(method: string) {
    super(`[ABORTED] ${method} aborted`);
    this.name = 'AbortError';
  }
}

// ── multipart ────────────────────────────────────────────────────────────────

export interface MultipartFile {
  field: string;
  filename: string;
  contentType: string;
  data: Buffer;
}

export interface MultipartBody {
  body: Buffer;
  contentType: string;
  boundary: string;
}

/** Strip characters that would break a Content-Disposition header. */
function safeHeaderValue(s: string): string {
  return String(s).replace(/[\r\n"\\]/g, '_');
}

/**
 * Build a multipart/form-data body by hand. Text fields are UTF-8; the file is
 * appended byte-for-byte. The boundary is random and re-rolled in the
 * (astronomically unlikely) case that it appears in a text field. PURE apart
 * from the randomness (injectable for tests).
 */
export function buildMultipart(
  fields: Record<string, string | number | undefined>,
  file: MultipartFile,
  boundary: string = '----qodex' + randomBytes(12).toString('hex'),
): MultipartBody {
  const textValues = Object.values(fields).filter((v) => v !== undefined).map(String);
  while (textValues.some((v) => v.includes(boundary))) {
    boundary = '----qodex' + randomBytes(12).toString('hex');
  }
  const CRLF = '\r\n';
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    parts.push(Buffer.from(
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="${safeHeaderValue(name)}"${CRLF}${CRLF}` +
      `${String(value)}${CRLF}`,
      'utf-8',
    ));
  }
  parts.push(Buffer.from(
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="${safeHeaderValue(file.field)}"; filename="${safeHeaderValue(file.filename)}"${CRLF}` +
    `Content-Type: ${safeHeaderValue(file.contentType)}${CRLF}${CRLF}`,
    'utf-8',
  ));
  parts.push(file.data);
  parts.push(Buffer.from(`${CRLF}--${boundary}--${CRLF}`, 'utf-8'));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}`, boundary };
}

// ── client ───────────────────────────────────────────────────────────────────

export interface TelegramApiOptions {
  token: string;
  /** Bot API base (config `telegram.apiBase`). Default https://api.telegram.org. */
  apiBase?: string;
  /** Transport. Default `proxyFetch`. */
  fetch?: FetchLike;
  /** Client-side timeout for normal calls (ms). Default 30s. */
  requestTimeoutMs?: number;
}

export interface SendMessageOptions {
  replyMarkup?: InlineKeyboardMarkup;
  /** Default 'HTML'. Pass null for plain text. */
  parseMode?: 'HTML' | null;
  disablePreview?: boolean;
  replyToMessageId?: number;
  signal?: AbortSignal;
}

export interface SendPhotoOptions {
  caption?: string;
  parseMode?: 'HTML' | null;
  filename?: string;
  contentType?: string;
  signal?: AbortSignal;
}

interface CallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  multipart?: MultipartBody;
}

export class TelegramApi {
  private readonly token: string;
  private readonly base: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  /** Last HTTP `Date` header from the API and the local time it arrived. */
  private serverDateMs: number | null = null;
  private serverDateAt = 0;

  constructor(opts: TelegramApiOptions) {
    const token = String(opts.token ?? '').trim();
    if (!token) throw new Error('[TELEGRAM_NOT_CONFIGURED] No bot token. Run `qodex telegram setup`.');
    if (/[\s/?#]/.test(token)) throw new Error('[TELEGRAM_BAD_TOKEN] The bot token contains invalid characters.');
    // The token travels in every request URL. `telegram.botTokenEnv` / `apiBase` can come
    // from a project's .qodex/config.yaml, so never send a value that is not even shaped
    // like a bot token (an API key in another env var) anywhere.
    if (!looksLikeBotToken(token)) {
      throw new Error('[TELEGRAM_BAD_TOKEN] The configured bot token is not shaped like a @BotFather token (<digits>:<secret>). Check telegram.botTokenEnv, or run `qodex telegram setup`.');
    }
    this.token = token;
    const base = (opts.apiBase || 'https://api.telegram.org').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(base)) throw new Error(`[TELEGRAM_BAD_CONFIG] telegram.apiBase must be an http(s) URL, got "${redactToken(base, token)}".`);
    this.base = base;
    this.fetchImpl = opts.fetch ?? ((input, init) => proxyFetch(input, init));
    this.timeoutMs = opts.requestTimeoutMs ?? 30_000;
  }

  /** Redact this client's token from any text. */
  redact(text: string): string {
    return redactToken(text, this.token);
  }

  /**
   * Telegram's clock (from the last response's `Date` header), advanced by the
   * local time elapsed since. null before any response carried one. Message
   * `date`s are server time, so age checks must not use a possibly skewed
   * local clock.
   */
  serverNow(): number | null {
    return this.serverDateMs === null ? null : this.serverDateMs + (Date.now() - this.serverDateAt);
  }

  getMe(signal?: AbortSignal): Promise<TgUser> {
    return this.call<TgUser>('getMe', {}, { signal });
  }

  /**
   * Long-poll for updates. Resolves after at most `timeout` seconds with
   * whatever arrived (possibly []). The HTTP timeout is set a bit above the
   * poll timeout so a slow proxy doesn't cut a healthy long-poll short.
   */
  getUpdates(opts: { offset?: number; timeout?: number; limit?: number; allowedUpdates?: string[]; signal?: AbortSignal } = {}): Promise<TgUpdate[]> {
    const timeout = Math.max(0, Math.floor(opts.timeout ?? 25));
    return this.call<TgUpdate[]>('getUpdates', {
      offset: opts.offset,
      timeout,
      limit: opts.limit,
      allowed_updates: opts.allowedUpdates,
    }, { signal: opts.signal, timeoutMs: (timeout + 15) * 1000 });
  }

  sendMessage(chatId: number | string, text: string, opts: SendMessageOptions = {}): Promise<TgMessage> {
    return this.call<TgMessage>('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: opts.parseMode === null ? undefined : (opts.parseMode ?? 'HTML'),
      reply_markup: opts.replyMarkup,
      disable_web_page_preview: opts.disablePreview ?? true,
      reply_to_message_id: opts.replyToMessageId,
    }, { signal: opts.signal });
  }

  /** Edit a message's text. Omitting `replyMarkup` removes the inline keyboard. */
  editMessageText(chatId: number | string, messageId: number, text: string, opts: Omit<SendMessageOptions, 'replyToMessageId'> = {}): Promise<TgMessage | true> {
    return this.call<TgMessage | true>('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: opts.parseMode === null ? undefined : (opts.parseMode ?? 'HTML'),
      reply_markup: opts.replyMarkup,
      disable_web_page_preview: opts.disablePreview ?? true,
    }, { signal: opts.signal });
  }

  answerCallbackQuery(callbackQueryId: string, opts: { text?: string; showAlert?: boolean; signal?: AbortSignal } = {}): Promise<true> {
    return this.call<true>('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text: opts.text ? opts.text.slice(0, 200) : undefined,
      show_alert: opts.showAlert || undefined,
    }, { signal: opts.signal });
  }

  /** Upload a photo (JPEG/PNG bytes) as multipart/form-data. */
  sendPhoto(chatId: number | string, photo: Buffer, opts: SendPhotoOptions = {}): Promise<TgMessage> {
    const mp = buildMultipart({
      chat_id: chatId,
      caption: opts.caption,
      parse_mode: opts.caption && opts.parseMode !== null ? (opts.parseMode ?? 'HTML') : undefined,
    }, {
      field: 'photo',
      filename: opts.filename ?? 'screen.jpg',
      contentType: opts.contentType ?? 'image/jpeg',
      data: photo,
    });
    return this.call<TgMessage>('sendPhoto', undefined, { signal: opts.signal, multipart: mp, timeoutMs: Math.max(this.timeoutMs, 60_000) });
  }

  getWebhookInfo(signal?: AbortSignal): Promise<TgWebhookInfo> {
    return this.call<TgWebhookInfo>('getWebhookInfo', {}, { signal });
  }

  /** Remove a webhook so long-polling works (getUpdates 409s while one is set). */
  deleteWebhook(opts: { dropPendingUpdates?: boolean; signal?: AbortSignal } = {}): Promise<true> {
    return this.call<true>('deleteWebhook', { drop_pending_updates: opts.dropPendingUpdates || undefined }, { signal: opts.signal });
  }

  // ── transport ──────────────────────────────────────────────────────────────

  private async call<T>(method: string, params: Record<string, unknown> | undefined, opts: CallOptions = {}): Promise<T> {
    const url = `${this.base}/bot${this.token}/${method}`;
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
    timer.unref?.();
    const onAbort = () => ac.abort();
    if (opts.signal) {
      if (opts.signal.aborted) { clearTimeout(timer); throw new TelegramAbortError(method); }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    let headers: Record<string, string>;
    let body: string | Buffer;
    if (opts.multipart) {
      headers = { 'Content-Type': opts.multipart.contentType };
      body = opts.multipart.body;
    } else {
      headers = { 'Content-Type': 'application/json' };
      body = JSON.stringify(dropUndefined(params ?? {}));
    }

    try {
      let res: Response;
      try {
        res = await this.fetchImpl(url, { method: 'POST', headers, body: body as any, signal: ac.signal });
      } catch (err: any) {
        if (opts.signal?.aborted) throw new TelegramAbortError(method);
        const detail = timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s` : describeFetchError(err);
        throw new TelegramApiError({ method, status: 0, description: this.redact(detail) });
      }
      try {
        const t = Date.parse(res.headers?.get?.('date') ?? '');
        if (Number.isFinite(t)) { this.serverDateMs = t; this.serverDateAt = Date.now(); }
      } catch { /* informational only */ }

      let text = '';
      try {
        text = await res.text();
      } catch (err: any) {
        if (opts.signal?.aborted) throw new TelegramAbortError(method);
        throw new TelegramApiError({ method, status: res.status || 0, description: this.redact(timedOut ? 'timed out reading response' : describeFetchError(err)) });
      }

      let json: any = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }

      if (!res.ok || !json || json.ok !== true) {
        const description = typeof json?.description === 'string'
          ? json.description
          : (res.statusText || text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) || 'unexpected response');
        const retry = Number(json?.parameters?.retry_after);
        throw new TelegramApiError({
          method,
          status: res.ok ? (Number(json?.error_code) || 500) : res.status,
          errorCode: typeof json?.error_code === 'number' ? json.error_code : undefined,
          description: this.redact(description),
          retryAfterSec: Number.isFinite(retry) && retry > 0 ? retry : undefined,
        });
      }
      return json.result as T;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }
}

function dropUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null) out[k] = v;
  return out;
}

/**
 * undici hides the useful part in a `.cause` chain ("fetch failed" →
 * "Request was cancelled." → "Proxy response (403) !== 200 when HTTP
 * Tunneling", or ECONNRESET / ENOTFOUND). Collect string codes and messages
 * down the chain so users behind proxies see the real reason.
 */
export function describeFetchError(err: any): string {
  const msg = String(err?.message ?? err ?? 'request failed');
  const details: string[] = [];
  let c = err?.cause;
  for (let depth = 0; c && depth < 5; depth++, c = c.cause) {
    const code = typeof c.code === 'string' ? c.code : '';
    const m = typeof c.message === 'string' ? c.message : (typeof c === 'string' ? c : '');
    for (const part of [m, code]) {
      if (part && !msg.includes(part) && !details.includes(part)) details.push(part);
    }
  }
  return details.length ? `${msg} (${details.join(' ← ')})` : msg;
}
