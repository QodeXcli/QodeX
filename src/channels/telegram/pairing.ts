/**
 * Telegram pairing: which chats may control this QodeX, and the one-time codes
 * used to add one.
 *
 * Bots are publicly discoverable, so a chat must prove it belongs to the user
 * before it can approve purchases, start missions, or see the browser. The
 * user runs `qodex telegram pair` locally, which prints a 6-digit code (valid
 * 10 minutes, single use); sending `/pair <code>` from a PRIVATE chat pairs it.
 *
 * Hardening:
 *   - Codes are stored only as salted SHA-256 hashes, compared in constant time.
 *   - Per-chat lockout: 5 wrong codes within an hour locks that chat for an hour.
 *   - Global cap: 20 wrong guesses (from any chats) invalidate every outstanding
 *     code, so a botnet can't brute-force the 10^6 space inside the expiry
 *     window (≤ 20 / 1,000,000 success odds per code).
 *   - State lives in `QODEX_CHANNELS_DIR/telegram.json` (0600, atomic writes,
 *     cross-process lock) — `qodex telegram pair` and a running bot in another
 *     process share it, and `unpair` takes effect on the bot's next message.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'crypto';
import { QODEX_CHANNELS_DIR } from '../../config/paths.js';
import { writeFileAtomic } from '../../utils/atomic-write.js';
import { withLock } from '../../utils/file-lock.js';

export const DEFAULT_TELEGRAM_STATE_FILE = path.join(QODEX_CHANNELS_DIR, 'telegram.json');

export interface PairedChat {
  chatId: number;
  username?: string;
  firstName?: string;
  /** Telegram `language_code` (e.g. 'fa', 'en-US') or a /lang override. */
  lang?: string;
  /** True when the user chose the language with /lang (don't auto-update it). */
  langPinned?: boolean;
  pairedAt: number;
}

interface CodeRecord {
  hash: string;
  salt: string;
  createdAt: number;
  expiresAt: number;
}

interface FailureRecord {
  count: number;
  since: number;
}

interface PairingState {
  version: 1;
  chats: PairedChat[];
  codes: CodeRecord[];
  /** Failed attempts per chat id (string key). */
  failures: Record<string, FailureRecord>;
  /** Failed attempts since the last code was created (any chat). */
  globalFailures: number;
}

export type ConsumeResult =
  | { ok: true; chat: PairedChat; alreadyPaired: boolean }
  | { ok: false; reason: 'malformed' | 'invalid' | 'expired' | 'locked' };

export interface PairingChatInfo {
  chatId: number;
  username?: string;
  firstName?: string;
  lang?: string;
}

export interface TelegramPairingStoreOptions {
  /** State file. Default `~/.qodex/channels/telegram.json`. */
  file?: string;
  now?: () => number;
  /** Code lifetime. Default 10 minutes. */
  codeTtlMs?: number;
  /** Wrong codes per chat before a lockout. Default 5. */
  maxFailuresPerChat?: number;
  /** Lockout / failure window. Default 1 hour. */
  failureWindowMs?: number;
  /** Wrong codes (all chats) before every outstanding code is invalidated. Default 20. */
  maxGlobalFailures?: number;
}

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** Normalize a typed code: Persian/Arabic-Indic digits → ASCII, drop spaces/dashes. PURE. */
export function normalizeCode(input: string): string {
  return String(input ?? '')
    .replace(/[۰-۹]/g, (d) => String(PERSIAN_DIGITS.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d)))
    .replace(/[\s‌\-_.]/g, '');
}

function hashCode(code: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${code}`).digest('hex');
}

function sameHash(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb);
}

function emptyState(): PairingState {
  return { version: 1, chats: [], codes: [], failures: {}, globalFailures: 0 };
}

/** Coerce whatever is on disk into a valid state (never trust the file). */
function sanitizeState(raw: unknown): PairingState {
  const s = emptyState();
  if (!raw || typeof raw !== 'object') return s;
  const r = raw as Record<string, unknown>;
  if (Array.isArray(r.chats)) {
    for (const c of r.chats) {
      if (!c || typeof c !== 'object') continue;
      const cc = c as Record<string, unknown>;
      const chatId = Number(cc.chatId);
      if (!Number.isSafeInteger(chatId)) continue;
      if (s.chats.some((x) => x.chatId === chatId)) continue;
      s.chats.push({
        chatId,
        username: typeof cc.username === 'string' ? cc.username : undefined,
        firstName: typeof cc.firstName === 'string' ? cc.firstName : undefined,
        lang: typeof cc.lang === 'string' ? cc.lang : undefined,
        langPinned: cc.langPinned === true ? true : undefined,
        pairedAt: Number(cc.pairedAt) || 0,
      });
    }
  }
  if (Array.isArray(r.codes)) {
    for (const c of r.codes) {
      if (!c || typeof c !== 'object') continue;
      const cc = c as Record<string, unknown>;
      if (typeof cc.hash !== 'string' || typeof cc.salt !== 'string') continue;
      s.codes.push({ hash: cc.hash, salt: cc.salt, createdAt: Number(cc.createdAt) || 0, expiresAt: Number(cc.expiresAt) || 0 });
    }
  }
  if (r.failures && typeof r.failures === 'object' && !Array.isArray(r.failures)) {
    for (const [k, v] of Object.entries(r.failures as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue;
      const vv = v as Record<string, unknown>;
      s.failures[k] = { count: Number(vv.count) || 0, since: Number(vv.since) || 0 };
    }
  }
  s.globalFailures = Number(r.globalFailures) || 0;
  return s;
}

export class TelegramPairingStore {
  readonly file: string;
  private readonly now: () => number;
  private readonly codeTtlMs: number;
  private readonly maxFailuresPerChat: number;
  private readonly failureWindowMs: number;
  private readonly maxGlobalFailures: number;

  constructor(opts: TelegramPairingStoreOptions = {}) {
    this.file = opts.file ?? DEFAULT_TELEGRAM_STATE_FILE;
    this.now = opts.now ?? Date.now;
    this.codeTtlMs = opts.codeTtlMs ?? 10 * 60_000;
    this.maxFailuresPerChat = opts.maxFailuresPerChat ?? 5;
    this.failureWindowMs = opts.failureWindowMs ?? 60 * 60_000;
    this.maxGlobalFailures = opts.maxGlobalFailures ?? 20;
  }

  /** Create a fresh one-time code. Only its hash is stored. */
  async createPairingCode(): Promise<{ code: string; expiresAt: number }> {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const salt = randomBytes(16).toString('hex');
    const now = this.now();
    const expiresAt = now + this.codeTtlMs;
    await this.mutate((s) => {
      this.prune(s);
      s.codes.push({ hash: hashCode(code, salt), salt, createdAt: now, expiresAt });
      // Keep a handful at most: the newest codes are the ones the user is looking at.
      if (s.codes.length > 5) s.codes.splice(0, s.codes.length - 5);
      s.globalFailures = 0;
    });
    return { code, expiresAt };
  }

  /**
   * Try to pair `chat` with `code`. One-time: a matching code is removed.
   * Failures count toward the per-chat lockout and the global cap.
   */
  async consumeCode(code: string, chat: PairingChatInfo): Promise<ConsumeResult> {
    const norm = normalizeCode(code);
    const now = this.now();
    return this.mutate<ConsumeResult>((s) => {
      this.prune(s);
      const existing = s.chats.find((c) => c.chatId === chat.chatId);
      if (existing) return { ok: true, chat: existing, alreadyPaired: true };

      const key = String(chat.chatId);
      const fail = s.failures[key];
      if (fail && now - fail.since < this.failureWindowMs && fail.count >= this.maxFailuresPerChat) {
        return { ok: false, reason: 'locked' };
      }
      if (!/^\d{6}$/.test(norm)) return { ok: false, reason: 'malformed' };

      const idx = s.codes.findIndex((c) => sameHash(c.hash, hashCode(norm, c.salt)));
      if (idx >= 0 && s.codes[idx].expiresAt > now) {
        s.codes.splice(idx, 1);
        delete s.failures[key];
        const paired: PairedChat = {
          chatId: chat.chatId,
          username: chat.username,
          firstName: chat.firstName,
          lang: chat.lang,
          pairedAt: now,
        };
        s.chats.push(paired);
        return { ok: true, chat: paired, alreadyPaired: false };
      }

      // Wrong or expired: count it.
      const rec = fail && now - fail.since < this.failureWindowMs ? fail : { count: 0, since: now };
      rec.count += 1;
      s.failures[key] = rec;
      s.globalFailures += 1;
      if (s.globalFailures >= this.maxGlobalFailures) {
        // Possible brute force across many chats: burn every outstanding code.
        s.codes = [];
        s.globalFailures = 0;
      }
      if (idx >= 0) {
        s.codes.splice(idx, 1);
        return { ok: false, reason: 'expired' };
      }
      return { ok: false, reason: 'invalid' };
    });
  }

  async isPaired(chatId: number): Promise<boolean> {
    const s = await this.read();
    return s.chats.some((c) => c.chatId === chatId);
  }

  async getChat(chatId: number): Promise<PairedChat | null> {
    const s = await this.read();
    return s.chats.find((c) => c.chatId === chatId) ?? null;
  }

  async listChats(): Promise<PairedChat[]> {
    return (await this.read()).chats;
  }

  /** Remove a chat. Returns false if it was not paired. */
  async unpair(chatId: number): Promise<boolean> {
    return this.mutate((s) => {
      const before = s.chats.length;
      s.chats = s.chats.filter((c) => c.chatId !== chatId);
      return s.chats.length !== before;
    });
  }

  /** Remove every paired chat. Returns how many were removed. */
  async unpairAll(): Promise<number> {
    return this.mutate((s) => {
      const n = s.chats.length;
      s.chats = [];
      return n;
    });
  }

  /** Update username / language of a paired chat (no-op if not paired). */
  async updateChat(chatId: number, patch: Partial<Pick<PairedChat, 'username' | 'firstName' | 'lang' | 'langPinned'>>): Promise<void> {
    await this.mutate((s) => {
      const c = s.chats.find((x) => x.chatId === chatId);
      if (!c) return;
      if (patch.username !== undefined) c.username = patch.username;
      if (patch.firstName !== undefined) c.firstName = patch.firstName;
      if (patch.lang !== undefined) c.lang = patch.lang;
      if (patch.langPinned !== undefined) c.langPinned = patch.langPinned || undefined;
    });
  }

  /** Number of unexpired codes waiting to be used. */
  async pendingCodeCount(): Promise<number> {
    const s = await this.read();
    const now = this.now();
    return s.codes.filter((c) => c.expiresAt > now).length;
  }

  // ── persistence ────────────────────────────────────────────────────────────

  /** Read the state (no lock needed — writes are atomic renames). Missing/corrupt → empty. */
  async read(): Promise<PairingState> {
    try {
      const raw = await fs.readFile(this.file, 'utf-8');
      return sanitizeState(JSON.parse(raw));
    } catch {
      return emptyState();
    }
  }

  private async mutate<T>(fn: (s: PairingState) => T): Promise<T> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    return withLock(this.file + '.lock', async () => {
      const s = await this.read();
      const before = JSON.stringify(s);
      const result = fn(s);
      const after = JSON.stringify(s, null, 2);
      if (JSON.stringify(s) !== before) {
        await writeFileAtomic(this.file, after + '\n', { mode: 0o600, encoding: 'utf-8' });
      }
      return result;
    }, { retries: 100, intervalMs: 50, staleMs: 10_000 });
  }

  /** Drop codes long past expiry (kept 1h after expiry to report "expired") and stale failure records. */
  private prune(s: PairingState): void {
    const now = this.now();
    s.codes = s.codes.filter((c) => c.expiresAt + 60 * 60_000 > now);
    for (const [k, f] of Object.entries(s.failures)) {
      if (now - f.since >= this.failureWindowMs) delete s.failures[k];
    }
  }
}
