/**
 * Mail accounts — IMAP/SMTP settings plus the app password / OAuth2 token, stored in
 * ONE encrypted file (QODEX_MAIL_ACCOUNTS_FILE, 0600) under the vault key.
 *
 * `list()` / `get()` return summaries without secret material; only `credentials()`
 * returns the password / token, for the transport factory (service.ts) and the
 * `qodex mail test` command. Nothing that holds a secret is ever returned by a tool.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { writeFileAtomic } from '../utils/atomic-write.js';
import { withLock } from '../utils/file-lock.js';
import { QODEX_MAIL_ACCOUNTS_FILE } from './paths.js';
import { getPreset, type MailEndpoint } from './presets.js';
import { decryptMailDoc, encryptMailDoc, loadVaultKey } from './secrets.js';

export type MailAuthKind = 'password' | 'xoauth2';

/** Folder names the account uses (special-use detection fills the rest). */
export interface MailFolders {
  inbox?: string;
  drafts?: string;
  sent?: string;
  archive?: string;
  trash?: string;
}

/** Non-secret account settings. */
export interface MailAccountConfig {
  /** Short label ("work", "personal"), unique case-insensitively. */
  name: string;
  /** The From address. */
  email: string;
  displayName?: string;
  /** Login user name (usually the email address). */
  user: string;
  /** Preset id or 'custom'. */
  provider: string;
  imap: MailEndpoint;
  smtp: MailEndpoint;
  auth: MailAuthKind;
  /** Plain-text connections allowed (only for a loopback bridge such as Proton Mail Bridge). */
  allowInsecure?: boolean;
  /** The provider files sent mail into Sent by itself. */
  savesSent?: boolean;
  folders?: MailFolders;
  createdAt: string;
  updatedAt?: string;
}

export interface MailAccountSecret {
  password?: string;
  accessToken?: string;
}

/** What `list()` / `get()` show: settings + which secrets exist, never their values. */
export interface MailAccountSummary extends MailAccountConfig {
  isDefault: boolean;
  hasPassword: boolean;
  hasToken: boolean;
}

export interface MailAccountInput {
  name: string;
  email: string;
  displayName?: string;
  user?: string;
  /** Preset id / alias, or 'custom' (then imap + smtp are required). */
  provider?: string;
  imap?: Partial<MailEndpoint>;
  smtp?: Partial<MailEndpoint>;
  password?: string;
  accessToken?: string;
  allowInsecure?: boolean;
  folders?: MailFolders;
  makeDefault?: boolean;
}

interface StoredAccount extends MailAccountConfig {
  secret: MailAccountSecret;
}

interface MailAccountsDoc {
  version: 1;
  default?: string;
  accounts: StoredAccount[];
}

const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}._@+-]{0,63}$/u;
const EMAIL_RE = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;
const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$|^\[[0-9A-Fa-f:.]+\]$/;

export function validateAccountName(name: string): string {
  const n = String(name ?? '').trim();
  if (!NAME_RE.test(n)) throw new Error('[MAIL_INVALID] account names are 1-64 letters/digits and . _ @ + - (starting with a letter or digit)');
  return n;
}

/** A single plain email address (no display name, no header-breaking characters). PURE. */
export function isEmailAddress(s: string): boolean {
  const t = String(s ?? '').trim();
  return t.length <= 254 && EMAIL_RE.test(t) && !/[\r\n]/.test(t);
}

export function isLoopbackHost(host: string): boolean {
  const h = String(host ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

function endpoint(kind: 'imap' | 'smtp', given: Partial<MailEndpoint> | undefined, fallback: MailEndpoint | undefined): MailEndpoint {
  const host = String(given?.host ?? fallback?.host ?? '').trim();
  if (!host || !HOST_RE.test(host)) throw new Error(`[MAIL_INVALID] ${kind.toUpperCase()} host "${host || '(none)'}" is not a host name`);
  const secureDefault = fallback?.secure ?? (kind === 'imap' ? true : true);
  const secure = typeof given?.secure === 'boolean' ? given.secure : secureDefault;
  const portDefault = fallback && fallback.host === host && fallback.secure === secure
    ? fallback.port
    : kind === 'imap' ? (secure ? 993 : 143) : (secure ? 465 : 587);
  const port = Number(given?.port ?? portDefault);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`[MAIL_INVALID] ${kind.toUpperCase()} port ${given?.port} is not a port number`);
  return { host, port, secure };
}

function summarize(a: StoredAccount, def: string | undefined): MailAccountSummary {
  const { secret, ...cfg } = a;
  return {
    ...cfg,
    imap: { ...cfg.imap }, smtp: { ...cfg.smtp }, folders: cfg.folders ? { ...cfg.folders } : undefined,
    isDefault: !!def && def.toLowerCase() === a.name.toLowerCase(),
    hasPassword: !!secret?.password, hasToken: !!secret?.accessToken,
  };
}

export class MailAccountStore {
  readonly file: string;
  readonly keyFile?: string;
  readonly vaultFile?: string;

  constructor(opts: { file?: string; keyFile?: string; vaultFile?: string } = {}) {
    this.file = opts.file ?? QODEX_MAIL_ACCOUNTS_FILE;
    this.keyFile = opts.keyFile;
    this.vaultFile = opts.vaultFile;
  }

  private key(create: boolean): Promise<Buffer | null> {
    return loadVaultKey({ keyFile: this.keyFile, vaultFile: this.vaultFile, create, guardFiles: [this.file] });
  }

  private async load(create = false): Promise<{ doc: MailAccountsDoc; key: Buffer | null }> {
    let raw: string | null = null;
    try {
      raw = await fs.readFile(this.file, 'utf-8');
    } catch (e: any) {
      if (e?.code !== 'ENOENT') throw e;
    }
    const key = await this.key(create);
    if (raw === null) return { doc: { version: 1, accounts: [] }, key };
    if (!key) throw new Error('[MAIL_KEY_MISSING] the vault key file is missing');
    let env: unknown;
    try { env = JSON.parse(raw); } catch { throw new Error('[MAIL_ACCOUNTS_CORRUPT] the mail accounts file is not valid JSON'); }
    const doc = decryptMailDoc<MailAccountsDoc>(env, key);
    return { doc: { version: 1, default: doc.default, accounts: Array.isArray(doc.accounts) ? doc.accounts : [] }, key };
  }

  private async save(doc: MailAccountsDoc, key: Buffer): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await writeFileAtomic(this.file, JSON.stringify(encryptMailDoc(doc, key), null, 2) + '\n', { mode: 0o600 });
  }

  private lockPath(): string {
    return this.file + '.lock';
  }

  /** Add (or with `replace`, overwrite) an account. Returns its summary. */
  async add(input: MailAccountInput, opts: { replace?: boolean } = {}): Promise<MailAccountSummary> {
    const name = validateAccountName(input.name);
    const email = String(input.email ?? '').trim();
    if (!isEmailAddress(email)) throw new Error(`[MAIL_INVALID] "${email}" is not an email address`);
    const providerRaw = String(input.provider ?? 'custom').trim().toLowerCase() || 'custom';
    const preset = providerRaw === 'custom' ? null : getPreset(providerRaw);
    if (providerRaw !== 'custom' && !preset) throw new Error(`[MAIL_INVALID] unknown provider "${input.provider}" — use a preset (qodex mail presets) or custom`);
    if (!preset && (!input.imap?.host || !input.smtp?.host)) throw new Error('[MAIL_INVALID] a custom account needs both an IMAP and an SMTP host');
    const imap = endpoint('imap', input.imap, preset?.imap);
    const smtp = endpoint('smtp', input.smtp, preset?.smtp);
    const allowInsecure = !!(input.allowInsecure ?? preset?.allowInsecure);
    for (const [kind, ep] of [['IMAP', imap], ['SMTP', smtp]] as const) {
      if (allowInsecure && !ep.secure && !isLoopbackHost(ep.host)) {
        throw new Error(`[MAIL_INVALID] plain (unencrypted) ${kind} is only allowed to this machine (a local bridge); ${ep.host} must use TLS`);
      }
    }
    const password = input.password ? String(input.password) : undefined;
    const accessToken = input.accessToken ? String(input.accessToken).trim() : undefined;
    if (!password && !accessToken) throw new Error('[MAIL_INVALID] an app password (or an OAuth2 access token) is required');
    const user = String(input.user ?? '').trim() || email;
    if (/[\r\n]/.test(user)) throw new Error('[MAIL_INVALID] the user name contains a line break');
    const displayName = input.displayName?.replace(/[\r\n"]/g, ' ').trim() || undefined;

    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    return withLock(this.lockPath(), async () => {
      const { doc, key } = await this.load(true);
      if (!key) throw new Error('[MAIL_KEY_MISSING] could not create the vault key');
      const idx = doc.accounts.findIndex(a => a.name.toLowerCase() === name.toLowerCase());
      if (idx >= 0 && !opts.replace) throw new Error(`[MAIL_EXISTS] an account named "${doc.accounts[idx].name}" already exists (use --force to replace it)`);
      const now = new Date().toISOString();
      const entry: StoredAccount = {
        name, email, displayName, user,
        provider: preset?.id ?? 'custom',
        imap, smtp,
        auth: accessToken ? 'xoauth2' : 'password',
        ...(allowInsecure ? { allowInsecure: true } : {}),
        savesSent: preset?.savesSent ?? false,
        ...(input.folders ? { folders: { ...input.folders } } : {}),
        createdAt: idx >= 0 ? doc.accounts[idx].createdAt : now,
        ...(idx >= 0 ? { updatedAt: now } : {}),
        secret: { ...(password ? { password } : {}), ...(accessToken ? { accessToken } : {}) },
      };
      if (idx >= 0) doc.accounts[idx] = entry; else doc.accounts.push(entry);
      if (input.makeDefault || !doc.default || !doc.accounts.some(a => a.name.toLowerCase() === doc.default!.toLowerCase())) doc.default = name;
      await this.save(doc, key);
      return summarize(entry, doc.default);
    });
  }

  /** Accounts without secrets, default first then by name. */
  async list(): Promise<MailAccountSummary[]> {
    const { doc } = await this.load(false);
    return doc.accounts.map(a => summarize(a, doc.default))
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
  }

  /** One account (default when `name` is omitted), without secrets. */
  async get(name?: string): Promise<MailAccountSummary | null> {
    const { doc } = await this.load(false);
    const a = this.pick(doc, name);
    return a ? summarize(a, doc.default) : null;
  }

  /** Settings + secret, for the transport only. Never return this from a tool. */
  async credentials(name?: string): Promise<{ account: MailAccountSummary; secret: MailAccountSecret } | null> {
    const { doc } = await this.load(false);
    const a = this.pick(doc, name);
    return a ? { account: summarize(a, doc.default), secret: { ...a.secret } } : null;
  }

  async remove(name: string): Promise<boolean> {
    try { await fs.access(this.file); } catch { return false; }
    return withLock(this.lockPath(), async () => {
      const { doc, key } = await this.load(false);
      const n = String(name ?? '').trim().toLowerCase();
      const next = doc.accounts.filter(a => a.name.toLowerCase() !== n);
      if (next.length === doc.accounts.length || !key) return false;
      const def = doc.default && doc.default.toLowerCase() !== n ? doc.default : next[0]?.name;
      await this.save({ version: 1, default: def, accounts: next }, key);
      return true;
    });
  }

  async setDefault(name: string): Promise<boolean> {
    try { await fs.access(this.file); } catch { return false; }
    return withLock(this.lockPath(), async () => {
      const { doc, key } = await this.load(false);
      const a = this.pick(doc, name);
      if (!a || !key) return false;
      doc.default = a.name;
      await this.save(doc, key);
      return true;
    });
  }

  private pick(doc: MailAccountsDoc, name?: string): StoredAccount | null {
    const n = String(name ?? '').trim().toLowerCase();
    if (n) return doc.accounts.find(a => a.name.toLowerCase() === n || a.email.toLowerCase() === n) ?? null;
    const def = doc.default?.toLowerCase();
    return doc.accounts.find(a => a.name.toLowerCase() === def) ?? doc.accounts[0] ?? null;
  }
}

let instance: MailAccountStore | null = null;

/** The process-wide accounts store at the default path. */
export function getMailAccounts(): MailAccountStore {
  if (!instance) instance = new MailAccountStore();
  return instance;
}

/** Test hook. */
export function setMailAccountsForTests(s: MailAccountStore | null): void {
  instance = s;
}
