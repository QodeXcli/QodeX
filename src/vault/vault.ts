/**
 * Credential vault — secrets the agent can USE but never SEE.
 *
 * Storage: QODEX_VAULT_FILE holds one AES-256-GCM encrypted JSON document
 * (random 96-bit IV per write, auth tag, versioned envelope, AAD bound to the
 * format). The 256-bit key lives in a SEPARATE file, QODEX_VAULT_KEY_FILE, mode
 * 0600, created on first use — so a copied vault.json alone is useless. Both
 * paths are injectable for tests. Writes are atomic (temp + fsync + rename) and
 * serialized across processes with an advisory lock.
 *
 * Entries: {id, name, origins[], username?, secret, totp? (base32), note?,
 * createdAt}. `list()` never returns secret material. `get()` is for the vault
 * tool only — its value goes straight into a page field, never into a tool
 * result.
 *
 * Origins bind each credential to the sites it belongs to (anti-phishing):
 * `matchOrigin(pageUrl, origins)` accepts the exact host or a subdomain, https
 * only (http allowed for localhost), with an optional port pin. Multi-tenant
 * hosting suffixes (github.io, vercel.app, ...) only match exactly, because
 * their subdomains belong to different people.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { QODEX_VAULT_FILE, QODEX_VAULT_KEY_FILE } from '../config/paths.js';
import { writeFileAtomic } from '../utils/atomic-write.js';
import { withLock } from '../utils/file-lock.js';
import { parseTotpInput, type TotpAlgorithm } from './totp.js';

export interface VaultEntry {
  id: string;
  name: string;
  origins: string[];
  username?: string;
  /** Password / secret. */
  secret: string;
  /** TOTP seed, canonical base32. */
  totp?: string;
  /** Non-default TOTP parameters (from an otpauth:// URI). */
  totpDigits?: number;
  totpPeriod?: number;
  totpAlgorithm?: TotpAlgorithm;
  note?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface VaultEntryInput {
  name: string;
  origins: string[];
  username?: string;
  secret: string;
  /** Base32 seed or otpauth://totp/ URI. */
  totp?: string;
  note?: string;
}

/** What may be shown (CLI) — no secret material. */
export interface VaultEntrySummary {
  id: string;
  name: string;
  origins: string[];
  username?: string;
  hasUsername: boolean;
  hasSecret: boolean;
  hasTotp: boolean;
  note?: string;
  createdAt: string;
  updatedAt?: string;
}

interface VaultEnvelope {
  format: 'qodex-vault';
  version: 1;
  cipher: 'aes-256-gcm';
  iv: string;
  tag: string;
  data: string;
}

const AAD = Buffer.from('qodex-vault:v1');

// ── crypto ──────────────────────────────────────────────────────────────────

/** Encrypt entries with a 32-byte key. PURE (random IV). */
export function encryptVault(entries: VaultEntry[], key: Buffer): VaultEnvelope {
  if (key.length !== 32) throw new Error('[VAULT_KEY_INVALID] vault key must be 32 bytes');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const data = Buffer.concat([cipher.update(JSON.stringify({ entries }), 'utf-8'), cipher.final()]);
  return {
    format: 'qodex-vault', version: 1, cipher: 'aes-256-gcm',
    iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64'),
  };
}

/** Decrypt an envelope. Throws `[VAULT_DECRYPT_FAILED]` for a wrong key or tampered file. */
export function decryptVault(env: unknown, key: Buffer): VaultEntry[] {
  const e = env as Partial<VaultEnvelope>;
  if (!e || e.format !== 'qodex-vault' || e.version !== 1 || e.cipher !== 'aes-256-gcm' || !e.iv || !e.tag || typeof e.data !== 'string') {
    throw new Error('[VAULT_CORRUPT] the vault file is not a QodeX vault (unknown format)');
  }
  let plain: string;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(e.iv, 'base64'));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(e.tag, 'base64'));
    plain = Buffer.concat([decipher.update(Buffer.from(e.data, 'base64')), decipher.final()]).toString('utf-8');
  } catch {
    throw new Error('[VAULT_DECRYPT_FAILED] could not decrypt the vault — wrong key file or the vault was modified');
  }
  const parsed = JSON.parse(plain) as { entries?: VaultEntry[] };
  return Array.isArray(parsed.entries) ? parsed.entries : [];
}

// ── origins ─────────────────────────────────────────────────────────────────

/** Hosting suffixes whose subdomains belong to different owners: match exactly only. */
const MULTI_TENANT_SUFFIXES = [
  'github.io', 'gitlab.io', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'herokuapp.com', 'web.app',
  'firebaseapp.com', 'appspot.com', 'azurewebsites.net', 'cloudfront.net', 's3.amazonaws.com', 'blogspot.com',
  'wordpress.com', 'myshopify.com', 'tumblr.com', 'wixsite.com', 'glitch.me', 'repl.co', 'replit.app', 'onrender.com',
  'fly.dev', 'surge.sh', 'ngrok.io', 'ngrok-free.app', 'ngrok.app', 'trycloudflare.com', 'loca.lt', 'deno.dev',
  'railway.app', 'up.railway.app', 'framer.website', 'notion.site', 'carrd.co', 'webflow.io', 'ir.cloud', 'liara.run',
];

export interface NormalizedOrigin {
  /** ASCII host without a leading "www.". */
  host: string;
  /** Port pin ('' = any default port). */
  port: string;
  /** Scheme pin, if the origin was written with one. */
  scheme?: 'http' | 'https';
  /** Exact-host only (multi-tenant hosting suffix). */
  exact: boolean;
}

function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/** Parse "github.com", "https://accounts.google.com/x", "*.example.com", "localhost:3000". Null if unusable. */
export function normalizeOrigin(input: string): NormalizedOrigin | null {
  let s = String(input ?? '').trim();
  if (!s) return null;
  s = s.replace(/^\*\./, '');
  const m = s.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  let scheme: 'http' | 'https' | undefined;
  if (m) {
    const sc = m[1].toLowerCase();
    if (sc !== 'http' && sc !== 'https') return null;
    scheme = sc;
  }
  let u: URL;
  try { u = new URL(m ? s : `https://${s}`); } catch { return null; }
  let host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host.includes('*')) return null;
  host = host.replace(/^www\./, '');
  if (scheme === 'http' && !isLoopback(host)) return null;
  // The suffix itself AND every tenant under it (me.github.io, mybucket.s3.amazonaws.com):
  // names below a tenant can belong to someone else (S3 bucket "evil.mybucket").
  const exact = MULTI_TENANT_SUFFIXES.some(sfx => host === sfx || host.endsWith('.' + sfx));
  return { host, port: u.port, scheme, exact };
}

/** Human-readable canonical form of an origin entry. */
export function formatOrigin(o: NormalizedOrigin): string {
  return `${o.scheme === 'http' ? 'http://' : ''}${o.host}${o.port ? ':' + o.port : ''}`;
}

export type OriginMatch = { ok: true; origin: string } | { ok: false; reason: string };

/** Is `pageUrl` one of the entry's origins (exact host or subdomain, https unless localhost)? PURE. */
export function matchOrigin(pageUrl: string, origins: string[]): OriginMatch {
  let u: URL;
  try { u = new URL(String(pageUrl ?? '')); } catch { return { ok: false, reason: `the page URL "${pageUrl || '(none)'}" is not a web page` }; }
  const scheme = u.protocol.replace(/:$/, '');
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (scheme !== 'https' && !(scheme === 'http' && isLoopback(host))) {
    return { ok: false, reason: `the page is not served over https (${scheme}://${host || ''})` };
  }
  const bare = host.replace(/^www\./, '');
  const port = u.port;
  for (const raw of origins ?? []) {
    const o = normalizeOrigin(raw);
    if (!o) continue;
    if (o.port && o.port !== port) continue;
    if (o.scheme && o.scheme !== scheme) continue;
    const hostOk = bare === o.host || host === o.host || (!o.exact && host.endsWith('.' + o.host));
    if (hostOk) return { ok: true, origin: formatOrigin(o) };
  }
  return { ok: false, reason: `${host} is not one of this entry's sites (${(origins ?? []).join(', ') || 'none'})` };
}

// ── store ───────────────────────────────────────────────────────────────────

const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._@+-]{0,63}$/u;

export function validateEntryName(name: string): string {
  const n = String(name ?? '').trim();
  if (!NAME_RE.test(n)) {
    throw new Error('[VAULT_INVALID] entry names are 1-64 letters/digits and . _ @ + - (starting with a letter or digit)');
  }
  return n;
}

function newId(): string {
  return 'v_' + randomBytes(6).toString('base64url');
}

function summarize(e: VaultEntry): VaultEntrySummary {
  return {
    id: e.id, name: e.name, origins: [...e.origins], username: e.username,
    hasUsername: !!e.username, hasSecret: !!e.secret, hasTotp: !!e.totp,
    note: e.note, createdAt: e.createdAt, updatedAt: e.updatedAt,
  };
}

export class Vault {
  readonly file: string;
  readonly keyFile: string;

  constructor(opts: { file?: string; keyFile?: string } = {}) {
    this.file = opts.file ?? QODEX_VAULT_FILE;
    this.keyFile = opts.keyFile ?? QODEX_VAULT_KEY_FILE;
  }

  private async exists(p: string): Promise<boolean> {
    try { await fs.access(p); return true; } catch { return false; }
  }

  /** Read the key; create it (0600) on first use when `create` and no vault exists yet. */
  private async key(create: boolean): Promise<Buffer | null> {
    try {
      const text = (await fs.readFile(this.keyFile, 'utf-8')).trim();
      const key = Buffer.from(text, 'base64');
      if (key.length !== 32) throw new Error('[VAULT_KEY_INVALID] the vault key file is damaged (expected 32 bytes of base64)');
      if (process.platform !== 'win32') {
        try {
          const st = await fs.stat(this.keyFile);
          if ((st.mode & 0o077) !== 0) await fs.chmod(this.keyFile, 0o600);
        } catch { /* best effort */ }
      }
      return key;
    } catch (e: any) {
      if (e?.code !== 'ENOENT') throw e;
    }
    if (await this.exists(this.file)) {
      throw new Error(`[VAULT_KEY_MISSING] ${this.file} exists but its key file ${this.keyFile} is missing — restore the key file, or delete the vault to start over`);
    }
    if (!create) return null;
    await fs.mkdir(path.dirname(this.keyFile), { recursive: true, mode: 0o700 });
    const key = randomBytes(32);
    try {
      const fh = await fs.open(this.keyFile, 'wx', 0o600);
      try { await fh.writeFile(key.toString('base64') + '\n'); await fh.sync(); } finally { await fh.close(); }
      return key;
    } catch (e: any) {
      if (e?.code === 'EEXIST') return this.key(false); // another process won the race
      throw e;
    }
  }

  private async load(create = false): Promise<{ entries: VaultEntry[]; key: Buffer | null }> {
    const key = await this.key(create);
    let raw: string;
    try {
      raw = await fs.readFile(this.file, 'utf-8');
    } catch (e: any) {
      if (e?.code === 'ENOENT') return { entries: [], key };
      throw e;
    }
    if (!key) throw new Error(`[VAULT_KEY_MISSING] ${this.keyFile} is missing`);
    let env: unknown;
    try { env = JSON.parse(raw); } catch { throw new Error('[VAULT_CORRUPT] the vault file is not valid JSON'); }
    return { entries: decryptVault(env, key), key };
  }

  private async save(entries: VaultEntry[], key: Buffer): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await writeFileAtomic(this.file, JSON.stringify(encryptVault(entries, key), null, 2) + '\n', { mode: 0o600 });
  }

  private lockPath(): string {
    return this.file + '.lock';
  }

  /** Add (or with `replace`, overwrite) an entry. Returns its summary. */
  async add(input: VaultEntryInput, opts: { replace?: boolean } = {}): Promise<VaultEntrySummary> {
    const name = validateEntryName(input.name);
    const origins = [...new Set((input.origins ?? []).map(o => {
      const n = normalizeOrigin(o);
      if (!n) throw new Error(`[VAULT_INVALID] "${o}" is not a usable origin — use a site like github.com or https://accounts.google.com (http only for localhost)`);
      return formatOrigin(n);
    }))];
    if (!origins.length) throw new Error('[VAULT_INVALID] at least one origin (site) is required — the vault only fills a secret on its own sites');
    const secret = String(input.secret ?? '');
    if (!secret) throw new Error('[VAULT_INVALID] the secret is empty');
    let totp: ReturnType<typeof parseTotpInput> | undefined;
    if (input.totp !== undefined && String(input.totp).trim()) totp = parseTotpInput(input.totp);
    const username = input.username?.trim() || undefined;
    const note = input.note?.trim() || undefined;

    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    return withLock(this.lockPath(), async () => {
      const { entries, key } = await this.load(true);
      if (!key) throw new Error('[VAULT_KEY_MISSING] could not create the vault key');
      const idx = entries.findIndex(e => e.name.toLowerCase() === name.toLowerCase());
      if (idx >= 0 && !opts.replace) throw new Error(`[VAULT_EXISTS] an entry named "${entries[idx].name}" already exists (use --force to replace it)`);
      const now = new Date().toISOString();
      const entry: VaultEntry = {
        id: idx >= 0 ? entries[idx].id : newId(),
        name, origins, username, secret, note,
        createdAt: idx >= 0 ? entries[idx].createdAt : now,
        ...(idx >= 0 ? { updatedAt: now } : {}),
      };
      if (totp) {
        entry.totp = totp.secret;
        if (totp.digits !== 6) entry.totpDigits = totp.digits;
        if (totp.period !== 30) entry.totpPeriod = totp.period;
        if (totp.algorithm !== 'sha1') entry.totpAlgorithm = totp.algorithm;
      }
      if (idx >= 0) entries[idx] = entry; else entries.push(entry);
      await this.save(entries, key);
      return summarize(entry);
    });
  }

  /** Entries without secret material, sorted by name. */
  async list(): Promise<VaultEntrySummary[]> {
    const { entries } = await this.load(false);
    return entries.map(summarize).sort((a, b) => a.name.localeCompare(b.name));
  }

  async names(): Promise<string[]> {
    return (await this.list()).map(e => e.name);
  }

  /** Full entry (secret included) — for the vault tool only. Case-insensitive name. */
  async get(name: string): Promise<VaultEntry | null> {
    const { entries } = await this.load(false);
    const n = String(name ?? '').trim().toLowerCase();
    return entries.find(e => e.name.toLowerCase() === n) ?? null;
  }

  async remove(name: string): Promise<boolean> {
    if (!(await this.exists(this.file))) return false;
    return withLock(this.lockPath(), async () => {
      const { entries, key } = await this.load(false);
      const n = String(name ?? '').trim().toLowerCase();
      const next = entries.filter(e => e.name.toLowerCase() !== n);
      if (next.length === entries.length || !key) return false;
      await this.save(next, key);
      return true;
    });
  }
}

let instance: Vault | null = null;

/** The process-wide vault at the default paths. */
export function getVault(): Vault {
  if (!instance) instance = new Vault();
  return instance;
}

/** Test hook: point the tools at a temp vault (or null to reset). */
export function setVaultForTests(v: Vault | null): void {
  instance = v;
}
