/**
 * RFC 6238 TOTP (and RFC 4226 HOTP) for the credential vault — so the agent can
 * complete 2-step logins with `browser_fill_secret {field: 'totp'}` without the
 * code (or the seed) ever entering the model's context. PURE (time injectable).
 *
 * Defaults match every authenticator app: HMAC-SHA1, 30 s period, 6 digits.
 * Secrets are base32 (RFC 4648, case-insensitive, spaces/dashes/padding
 * ignored); `otpauth://totp/...` URIs from QR codes are accepted too.
 */

import { createHmac } from 'crypto';

export type TotpAlgorithm = 'sha1' | 'sha256' | 'sha512';

export interface TotpOptions {
  /** Unix time in milliseconds. Default Date.now(). */
  time?: number;
  /** Time step in seconds. Default 30. */
  period?: number;
  /** Code length. Default 6. */
  digits?: number;
  algorithm?: TotpAlgorithm;
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Decode RFC 4648 base32. Throws `[TOTP_INVALID]` on bad characters. */
export function base32Decode(input: string): Buffer {
  const clean = String(input ?? '').toUpperCase().replace(/[\s-]+/g, '').replace(/=+$/, '');
  if (!clean) throw new Error('[TOTP_INVALID] empty base32 secret');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error(`[TOTP_INVALID] "${ch}" is not a base32 character`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Encode bytes as unpadded RFC 4648 base32. */
export function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** RFC 4226 HOTP over a raw key. */
export function hotp(key: Uint8Array, counter: number | bigint, opts: { digits?: number; algorithm?: TotpAlgorithm } = {}): string {
  const digits = opts.digits ?? 6;
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(opts.algorithm ?? 'sha1', Buffer.from(key)).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** RFC 6238 TOTP for a raw key. */
export function totpFromKey(key: Uint8Array, opts: TotpOptions = {}): string {
  const period = opts.period ?? 30;
  const t = Math.floor((opts.time ?? Date.now()) / 1000 / period);
  return hotp(key, t, { digits: opts.digits, algorithm: opts.algorithm });
}

/** RFC 6238 TOTP for a base32 secret. */
export function totp(secretBase32: string, opts: TotpOptions = {}): string {
  return totpFromKey(base32Decode(secretBase32), opts);
}

/** Seconds left before the current code rolls over. */
export function totpRemainingSeconds(period = 30, time = Date.now()): number {
  const s = time / 1000;
  return period - (s % period);
}

export interface TotpSpec {
  /** Canonical base32 (uppercase, no spaces/padding). */
  secret: string;
  digits: number;
  period: number;
  algorithm: TotpAlgorithm;
  issuer?: string;
  label?: string;
}

/**
 * Accept a base32 secret or an `otpauth://totp/Label?secret=...&digits=&period=&algorithm=`
 * URI and return a validated spec. Throws `[TOTP_INVALID]` with a reason.
 */
export function parseTotpInput(input: string): TotpSpec {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('[TOTP_INVALID] empty TOTP secret');
  if (/^otpauth:/i.test(raw)) {
    let u: URL;
    try { u = new URL(raw); } catch { throw new Error('[TOTP_INVALID] malformed otpauth:// URI'); }
    if (u.hostname.toLowerCase() !== 'totp') throw new Error('[TOTP_INVALID] only otpauth://totp/ URIs are supported (not HOTP)');
    const secret = u.searchParams.get('secret') ?? '';
    const digits = Number(u.searchParams.get('digits') ?? 6);
    const period = Number(u.searchParams.get('period') ?? 30);
    const algo = (u.searchParams.get('algorithm') ?? 'SHA1').toLowerCase();
    if (![6, 7, 8].includes(digits)) throw new Error('[TOTP_INVALID] digits must be 6, 7 or 8');
    if (!Number.isFinite(period) || period < 10 || period > 300) throw new Error('[TOTP_INVALID] period must be 10-300 seconds');
    if (!['sha1', 'sha256', 'sha512'].includes(algo)) throw new Error('[TOTP_INVALID] algorithm must be SHA1, SHA256 or SHA512');
    let label: string | undefined;
    try { label = decodeURIComponent(u.pathname.replace(/^\/+/, '')) || undefined; } catch { label = undefined; }
    const spec = parseTotpInput(secret);
    return { ...spec, digits, period, algorithm: algo as TotpAlgorithm, issuer: u.searchParams.get('issuer') ?? undefined, label };
  }
  const key = base32Decode(raw);
  if (key.length < 10) throw new Error('[TOTP_INVALID] secret is too short (expected at least 16 base32 characters)');
  return { secret: base32Encode(key), digits: 6, period: 30, algorithm: 'sha1' };
}
