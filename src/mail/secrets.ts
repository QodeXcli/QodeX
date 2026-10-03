/**
 * Mail secrets: encryption of the accounts file with the VAULT KEY, a derived key for
 * signing local drafts, and scrubbing of passwords / tokens out of any text.
 *
 * The accounts document is encrypted with the same 256-bit key file the credential vault
 * uses (QODEX_VAULT_KEY_FILE, 0600) but with its own envelope format and AAD, so the
 * accounts file can never be loaded as a vault (browser_fill_secret only ever reads the
 * vault) and the vault can never be loaded as an accounts file.
 *
 * Secrets must never reach a tool result, a log line, the bus, an audit record or an
 * error message. Libraries echo server replies in their errors, and an AUTH exchange
 * carries the password base64-encoded, so `scrubSecrets` removes every encoding of a
 * secret we know about (raw, base64, SASL PLAIN, XOAUTH2, URL-encoded).
 */

import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { QODEX_VAULT_FILE, QODEX_VAULT_KEY_FILE } from '../config/paths.js';

export interface MailEnvelope {
  format: 'qodex-mail-accounts';
  version: 1;
  cipher: 'aes-256-gcm';
  iv: string;
  tag: string;
  data: string;
}

const AAD = Buffer.from('qodex-mail-accounts:v1');

/** Encrypt any JSON document with a 32-byte key. PURE (random IV). */
export function encryptMailDoc(doc: unknown, key: Buffer): MailEnvelope {
  if (key.length !== 32) throw new Error('[MAIL_KEY_INVALID] the vault key must be 32 bytes');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const data = Buffer.concat([cipher.update(JSON.stringify(doc), 'utf-8'), cipher.final()]);
  return {
    format: 'qodex-mail-accounts', version: 1, cipher: 'aes-256-gcm',
    iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64'),
  };
}

/** Decrypt an envelope. Throws `[MAIL_DECRYPT_FAILED]` for a wrong key or a modified file. */
export function decryptMailDoc<T = unknown>(env: unknown, key: Buffer): T {
  const e = env as Partial<MailEnvelope>;
  if (!e || e.format !== 'qodex-mail-accounts' || e.version !== 1 || e.cipher !== 'aes-256-gcm' || !e.iv || !e.tag || typeof e.data !== 'string') {
    throw new Error('[MAIL_ACCOUNTS_CORRUPT] the mail accounts file has an unknown format');
  }
  let plain: string;
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(e.iv, 'base64'));
    d.setAAD(AAD);
    d.setAuthTag(Buffer.from(e.tag, 'base64'));
    plain = Buffer.concat([d.update(Buffer.from(e.data, 'base64')), d.final()]).toString('utf-8');
  } catch {
    throw new Error('[MAIL_DECRYPT_FAILED] could not decrypt the mail accounts file — wrong vault key file, or the file was modified');
  }
  return JSON.parse(plain) as T;
}

// ── the vault key ───────────────────────────────────────────────────────────

export interface KeyPaths {
  /** The vault key file (default QODEX_VAULT_KEY_FILE). */
  keyFile?: string;
  /** The vault file: when it exists but the key is gone, a new key must NOT be minted. */
  vaultFile?: string;
}

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

/**
 * Read the vault key; with `create`, make it (0600) when neither it nor a vault exists.
 * Mirrors Vault's own key handling so both agree on one key file.
 */
export async function loadVaultKey(opts: KeyPaths & { create?: boolean; guardFiles?: string[] } = {}): Promise<Buffer | null> {
  const keyFile = opts.keyFile ?? QODEX_VAULT_KEY_FILE;
  const vaultFile = opts.vaultFile ?? QODEX_VAULT_FILE;
  try {
    const key = Buffer.from((await fs.readFile(keyFile, 'utf-8')).trim(), 'base64');
    if (key.length !== 32) throw new Error('[MAIL_KEY_INVALID] the vault key file is damaged (expected 32 bytes of base64)');
    if (process.platform !== 'win32') {
      try {
        const st = await fs.stat(keyFile);
        if ((st.mode & 0o077) !== 0) await fs.chmod(keyFile, 0o600);
      } catch { /* best effort */ }
    }
    return key;
  } catch (e: any) {
    if (e?.code !== 'ENOENT') throw e;
  }
  for (const f of [vaultFile, ...(opts.guardFiles ?? [])]) {
    if (await exists(f)) {
      throw new Error(`[MAIL_KEY_MISSING] ${f} exists but the vault key file ${keyFile} is missing — restore the key file (or remove the encrypted files to start over)`);
    }
  }
  if (!opts.create) return null;
  await fs.mkdir(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  const key = randomBytes(32);
  try {
    const fh = await fs.open(keyFile, 'wx', 0o600);
    try { await fh.writeFile(key.toString('base64') + '\n'); await fh.sync(); } finally { await fh.close(); }
    return key;
  } catch (e: any) {
    if (e?.code === 'EEXIST') return loadVaultKey({ ...opts, create: false });
    throw e;
  }
}

/** A purpose-bound subkey (HKDF-SHA256), e.g. for signing drafts. PURE. */
export function deriveKey(key: Buffer, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', key, Buffer.from('qodex-mail'), Buffer.from(purpose), 32));
}

/** HMAC-SHA256 (hex). PURE. */
export function hmac(key: Buffer, text: string): string {
  return createHmac('sha256', key).update(text, 'utf-8').digest('hex');
}

/** Constant-time hex compare. PURE. */
export function sameMac(a: string, b: string): boolean {
  const x = Buffer.from(String(a ?? ''), 'hex');
  const y = Buffer.from(String(b ?? ''), 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

// ── scrubbing ───────────────────────────────────────────────────────────────

/** Shortest secret worth scrubbing (shorter ones would mangle ordinary text). */
const MIN_SCRUB = 3;
export const SCRUBBED = '***';

const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64');

/**
 * Every encoding of a secret that could show up in a library error or protocol trace:
 * raw, base64, URL-encoded, the SASL PLAIN / LOGIN blobs and the XOAUTH2 blob. PURE.
 */
export function secretForms(secret: string | undefined | null, user?: string): string[] {
  const s = String(secret ?? '');
  if (s.length < MIN_SCRUB) return [];
  const forms = new Set<string>([s, b64(s), encodeURIComponent(s), JSON.stringify(s).slice(1, -1)]);
  if (user) {
    forms.add(b64(`\u0000${user}\u0000${s}`));
    forms.add(b64(`${user}\u0000${user}\u0000${s}`));
    forms.add(b64(`user=${user}\u0001auth=Bearer ${s}\u0001\u0001`));
  }
  // base64 without padding (some traces strip it).
  for (const f of [...forms]) if (f.endsWith('=')) forms.add(f.replace(/=+$/, ''));
  return [...forms].filter(f => f.length >= MIN_SCRUB).sort((a, b) => b.length - a.length);
}

/** Replace every occurrence of every form of `secrets` with ***. PURE. */
export function scrubSecrets(text: string, secrets: Array<string | undefined | null>, user?: string): string {
  let out = String(text ?? '');
  if (!out) return out;
  const forms = [...new Set(secrets.flatMap(s => secretForms(s, user)))].sort((a, b) => b.length - a.length);
  for (const f of forms) if (out.includes(f)) out = out.split(f).join(SCRUBBED);
  return out;
}

/**
 * Error text that is safe to show: secrets scrubbed, AUTH protocol lines dropped, one
 * line, capped. Library errors (imapflow, nodemailer) can echo server responses. PURE.
 */
export function safeErrorMessage(err: unknown, secrets: Array<string | undefined | null>, user?: string): string {
  const raw = String((err as any)?.message ?? err ?? 'unknown error');
  const extra = [(err as any)?.response, (err as any)?.responseText, (err as any)?.serverResponseCode]
    .filter(v => typeof v === 'string' && v && !raw.includes(v as string)) as string[];
  let msg = [raw, ...extra].join(' — ');
  msg = scrubSecrets(msg, secrets, user);
  // Never echo an AUTH exchange, whatever it contains.
  msg = msg.replace(/\bAUTH(?:ENTICATE)?\s+(PLAIN|LOGIN|XOAUTH2|OAUTHBEARER|CRAM-MD5)\s+\S+/gi, 'AUTH $1 ***')
    .replace(/\bLOGIN\s+"[^"]*"\s+"[^"]*"/g, 'LOGIN *** ***');
  return msg.replace(/\s+/g, ' ').trim().slice(0, 300);
}
