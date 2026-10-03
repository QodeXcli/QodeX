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
import { vaultKeyStore, type VaultKeyStore } from './keystore.js';
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
  /** Where to log in (must be on one of the origins); browser_login starts here. */
  loginUrl?: string;
  /** The secret before the last rotation (undo a password change the site rejected). */
  previousSecret?: string;
  rotatedAt?: string;
  /** Last time a tool filled this entry into a page. */
  lastUsedAt?: string;
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
  loginUrl?: string;
}

/**
 * Merge-patch for `update()`: a field left undefined is kept, `null` removes an optional
 * field, a value replaces it. Changing `secret` keeps the old one as `previousSecret`.
 */
export interface VaultEntryPatch {
  /** Rename the entry. */
  name?: string;
  /** Replace the whole origin list. */
  origins?: string[];
  addOrigins?: string[];
  removeOrigins?: string[];
  username?: string | null;
  /** Rotate the secret (the old one is kept as previousSecret). */
  secret?: string;
  /** New TOTP seed (base32 / otpauth://), or null to remove 2FA. */
  totp?: string | null;
  note?: string | null;
  loginUrl?: string | null;
  /** Swap the secret back to previousSecret (undo the last rotation). */
  restorePrevious?: boolean;
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
  hasPreviousSecret: boolean;
  note?: string;
  loginUrl?: string;
  rotatedAt?: string;
  lastUsedAt?: string;
  createdAt: string;
  updatedAt?: string;
}

export type ImportConflict = 'skip' | 'replace' | 'rename';

export interface AddManyResult {
  added: string[];
  replaced: string[];
  renamed: Array<{ from: string; to: string }>;
  skipped: string[];
  /** Inputs that were not valid: index + reason (never a value). */
  invalid: Array<{ index: number; reason: string }>;
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
    hasUsername: !!e.username, hasSecret: !!e.secret, hasTotp: !!e.totp, hasPreviousSecret: !!e.previousSecret,
    note: e.note, loginUrl: e.loginUrl, rotatedAt: e.rotatedAt, lastUsedAt: e.lastUsedAt,
    createdAt: e.createdAt, updatedAt: e.updatedAt,
  };
}

function normalizeOrigins(list: string[]): string[] {
  return [...new Set((list ?? []).map(o => {
    const n = normalizeOrigin(o);
    if (!n) throw new Error(`[VAULT_INVALID] "${String(o).slice(0, 80)}" is not a usable origin — use a site like github.com or https://accounts.google.com (http only for localhost)`);
    return formatOrigin(n);
  }))];
}

/** A login URL on one of `origins` (https, or http on loopback). Returns the canonical href. */
function validateLoginUrl(url: string, origins: string[]): string {
  let u: URL;
  try { u = new URL(String(url ?? '').trim()); } catch { throw new Error('[VAULT_INVALID] the login URL is not a URL'); }
  const m = matchOrigin(u.href, origins);
  if (!m.ok) throw new Error(`[VAULT_INVALID] the login URL must be on one of the entry's sites: ${m.reason}`);
  return u.href;
}

function applyTotp(entry: VaultEntry, input: string | null | undefined): void {
  if (input === undefined) return;
  delete entry.totp; delete entry.totpDigits; delete entry.totpPeriod; delete entry.totpAlgorithm;
  if (input === null || !String(input).trim()) return;
  const t = parseTotpInput(input);
  entry.totp = t.secret;
  if (t.digits !== 6) entry.totpDigits = t.digits;
  if (t.period !== 30) entry.totpPeriod = t.period;
  if (t.algorithm !== 'sha1') entry.totpAlgorithm = t.algorithm;
}

type FreshEntry = Omit<VaultEntry, 'id' | 'createdAt'>;

/** Validate an input into a fresh entry (no id/dates yet). Throws [VAULT_INVALID] / TOTP errors. */
function entryFromInput(input: VaultEntryInput): FreshEntry {
  const name = validateEntryName(input.name);
  const origins = normalizeOrigins(input.origins ?? []);
  if (!origins.length) throw new Error('[VAULT_INVALID] at least one origin (site) is required — the vault only fills a secret on its own sites');
  const secret = String(input.secret ?? '');
  if (!secret) throw new Error('[VAULT_INVALID] the secret is empty');
  const e: FreshEntry = { name, origins, secret };
  const username = input.username?.trim();
  if (username) e.username = username;
  const note = input.note?.trim();
  if (note) e.note = note;
  if (input.loginUrl !== undefined && String(input.loginUrl).trim()) e.loginUrl = validateLoginUrl(input.loginUrl, origins);
  applyTotp(e as VaultEntry, input.totp);
  return e;
}

/** `base`, or `base-2`, `base-3`… — the first name not in `taken` (lower-cased). */
function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; i < 10_000; i++) {
    const suffix = `-${i}`;
    const cand = base.slice(0, 64 - suffix.length) + suffix;
    if (!taken.has(cand.toLowerCase())) return cand;
  }
  throw new Error('[VAULT_INVALID] could not find a free entry name');
}

/** `old` overwritten by `fresh`: same id / creation date, the old secret kept when it changes. */
function replaced(old: VaultEntry, fresh: FreshEntry, now: string): VaultEntry {
  const entry: VaultEntry = { id: old.id, ...fresh, createdAt: old.createdAt, updatedAt: now };
  if (old.secret !== entry.secret) { entry.previousSecret = old.secret; entry.rotatedAt = now; }
  if (old.lastUsedAt) entry.lastUsedAt = old.lastUsedAt;
  return entry;
}

export class Vault {
  readonly file: string;
  readonly keyFile: string;
  private keystore: VaultKeyStore | null;

  constructor(opts: { file?: string; keyFile?: string; keystore?: VaultKeyStore } = {}) {
    this.file = opts.file ?? QODEX_VAULT_FILE;
    this.keyFile = opts.keyFile ?? opts.keystore?.keyFile ?? QODEX_VAULT_KEY_FILE;
    this.keystore = opts.keystore ?? null;
  }

  private async exists(p: string): Promise<boolean> {
    try { await fs.access(p); return true; } catch { return false; }
  }

  /**
   * The vault key from the shared keystore (key file or OS keychain, see keystore.ts).
   * A key is minted only on a fresh install when `create` is set; a missing key with an
   * existing vault (or a keystore record) is `[VAULT_KEY_MISSING]`.
   */
  private async key(create: boolean): Promise<Buffer | null> {
    if (!this.keystore) this.keystore = vaultKeyStore({ keyFile: this.keyFile });
    return this.keystore.load({ create, guardFiles: [this.file] });
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

  /**
   * Add (or with `replace`, overwrite) an entry. Returns its summary. Replacing keeps the
   * id and creation date, and the old secret as previousSecret when it changes; fields
   * that are not supplied are dropped (use `update()` to change some fields only).
   */
  async add(input: VaultEntryInput, opts: { replace?: boolean } = {}): Promise<VaultEntrySummary> {
    const fresh = entryFromInput(input);
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    return withLock(this.lockPath(), async () => {
      const { entries, key } = await this.load(true);
      if (!key) throw new Error('[VAULT_KEY_MISSING] could not create the vault key');
      const idx = entries.findIndex(e => e.name.toLowerCase() === fresh.name.toLowerCase());
      if (idx >= 0 && !opts.replace) throw new Error(`[VAULT_EXISTS] an entry named "${entries[idx].name}" already exists (use --force to replace it, or qodex vault edit / rotate to change it)`);
      const now = new Date().toISOString();
      const entry = idx >= 0 ? replaced(entries[idx], fresh, now) : { id: newId(), ...fresh, createdAt: now };
      if (idx >= 0) entries[idx] = entry; else entries.push(entry);
      await this.save(entries, key);
      return summarize(entry);
    });
  }

  /**
   * Merge-patch an existing entry (see VaultEntryPatch): change some fields, rotate the
   * secret or the TOTP seed without losing the rest. `[VAULT_NOT_FOUND]` when absent.
   */
  async update(name: string, patch: VaultEntryPatch): Promise<VaultEntrySummary> {
    const shown = String(name ?? '').slice(0, 64);
    if (!(await this.exists(this.file))) throw new Error(`[VAULT_NOT_FOUND] no vault entry named "${shown}"`);
    if (patch.secret !== undefined && !String(patch.secret)) throw new Error('[VAULT_INVALID] the secret is empty');
    if (patch.secret !== undefined && patch.restorePrevious) throw new Error('[VAULT_INVALID] give a new secret or restore the previous one, not both');
    return withLock(this.lockPath(), async () => {
      const { entries, key } = await this.load(false);
      if (!key) throw new Error('[VAULT_KEY_MISSING] the vault key is missing');
      const n = String(name ?? '').trim().toLowerCase();
      const idx = entries.findIndex(e => e.name.toLowerCase() === n);
      if (idx < 0) throw new Error(`[VAULT_NOT_FOUND] no vault entry named "${shown}"`);
      const now = new Date().toISOString();
      const e: VaultEntry = { ...entries[idx], origins: [...entries[idx].origins] };

      if (patch.name !== undefined) {
        const nn = validateEntryName(patch.name);
        if (entries.some((x, i) => i !== idx && x.name.toLowerCase() === nn.toLowerCase())) throw new Error(`[VAULT_EXISTS] an entry named "${nn}" already exists`);
        e.name = nn;
      }
      if (patch.origins !== undefined) e.origins = normalizeOrigins(patch.origins);
      if (patch.addOrigins?.length) e.origins = [...new Set([...e.origins, ...normalizeOrigins(patch.addOrigins)])];
      if (patch.removeOrigins?.length) {
        const drop = new Set(normalizeOrigins(patch.removeOrigins));
        e.origins = e.origins.filter(o => !drop.has(o));
      }
      if (!e.origins.length) throw new Error('[VAULT_INVALID] an entry needs at least one origin (site)');
      if (patch.username !== undefined) e.username = patch.username === null ? undefined : (String(patch.username).trim() || undefined);
      if (patch.note !== undefined) e.note = patch.note === null ? undefined : (String(patch.note).trim() || undefined);
      if (patch.loginUrl !== undefined) {
        e.loginUrl = patch.loginUrl === null || !String(patch.loginUrl).trim() ? undefined : validateLoginUrl(patch.loginUrl, e.origins);
      }
      // A login URL that is no longer on one of the sites is dropped, never kept pointing elsewhere.
      if (e.loginUrl && !matchOrigin(e.loginUrl, e.origins).ok) e.loginUrl = undefined;
      applyTotp(e, patch.totp);
      if (patch.restorePrevious) {
        if (!e.previousSecret) throw new Error(`[VAULT_INVALID] "${e.name}" has no previous secret to restore`);
        [e.secret, e.previousSecret] = [e.previousSecret, e.secret];
        e.rotatedAt = now;
      } else if (patch.secret !== undefined && String(patch.secret) !== e.secret) {
        e.previousSecret = e.secret;
        e.secret = String(patch.secret);
        e.rotatedAt = now;
      }
      e.updatedAt = now;
      const clean = JSON.parse(JSON.stringify(e)) as VaultEntry; // drop undefined fields
      entries[idx] = clean;
      await this.save(entries, key);
      return summarize(clean);
    });
  }

  /**
   * Add many entries under ONE lock and ONE write (an import of 1,000 rows must not
   * re-encrypt the vault 1,000 times). Invalid inputs are reported by index, never by value.
   * `dryRun` validates and reports what would happen without writing (or creating a key).
   */
  async addMany(inputs: VaultEntryInput[], opts: { onConflict?: ImportConflict; dryRun?: boolean } = {}): Promise<AddManyResult> {
    const onConflict = opts.onConflict ?? 'skip';
    const res: AddManyResult = { added: [], replaced: [], renamed: [], skipped: [], invalid: [] };
    const valid: FreshEntry[] = [];
    inputs.forEach((input, index) => {
      try {
        valid.push(entryFromInput(input));
      } catch (e: any) {
        res.invalid.push({ index, reason: String(e?.message ?? e).replace(/^\[[A-Z_]+\]\s*/, '').split('\n')[0].slice(0, 160) });
      }
    });
    const apply = (entries: VaultEntry[]): boolean => {
      const taken = new Set(entries.map(e => e.name.toLowerCase()));
      const now = new Date().toISOString();
      let changed = false;
      for (const fresh of valid) {
        const idx = entries.findIndex(e => e.name.toLowerCase() === fresh.name.toLowerCase());
        if (idx < 0) {
          entries.push({ id: newId(), ...fresh, createdAt: now });
          taken.add(fresh.name.toLowerCase());
          res.added.push(fresh.name);
        } else if (onConflict === 'skip') {
          res.skipped.push(fresh.name);
          continue;
        } else if (onConflict === 'rename') {
          const to = uniqueName(fresh.name, taken);
          entries.push({ id: newId(), ...fresh, name: to, createdAt: now });
          taken.add(to.toLowerCase());
          res.renamed.push({ from: fresh.name, to });
        } else {
          entries[idx] = replaced(entries[idx], fresh, now);
          res.replaced.push(fresh.name);
        }
        changed = true;
      }
      return changed;
    };
    if (opts.dryRun) {
      const { entries } = await this.load(false);
      apply(entries);
      return res;
    }
    if (!valid.length) return res;
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    return withLock(this.lockPath(), async () => {
      const { entries, key } = await this.load(true);
      if (!key) throw new Error('[VAULT_KEY_MISSING] could not create the vault key');
      if (apply(entries)) await this.save(entries, key);
      return res;
    });
  }

  /** Record that an entry was just used (best effort, at most once a minute per entry). */
  async touch(name: string): Promise<void> {
    if (!(await this.exists(this.file))) return;
    await withLock(this.lockPath(), async () => {
      const { entries, key } = await this.load(false);
      const e = entries.find(x => x.name.toLowerCase() === String(name ?? '').trim().toLowerCase());
      if (!e || !key) return;
      if (e.lastUsedAt && Date.now() - Date.parse(e.lastUsedAt) < 60_000) return;
      e.lastUsedAt = new Date().toISOString();
      await this.save(entries, key);
    });
  }

  /** Summaries of the entries that may be filled on `url` (same origin rules as filling). */
  async findByOrigin(url: string): Promise<VaultEntrySummary[]> {
    const list = await this.list();
    return list.filter(e => matchOrigin(url, e.origins).ok);
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
