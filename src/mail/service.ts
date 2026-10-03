/**
 * MailService — resolves an account name to a connected MailTransport (one cached per
 * account), and knows every secret it has loaded so tool output and errors can be
 * scrubbed of them (`scrub`, `errorText`).
 *
 * Tools and the CLI go through `getMailService()`; tests inject accounts, drafts and a
 * transport factory (setMailServiceForTests).
 */

import { getMailAccounts, type MailAccountSecret, type MailAccountStore, type MailAccountSummary } from './accounts.js';
import { getDraftStore, type DraftStore } from './drafts.js';
import { ImapSmtpTransport } from './imap-smtp.js';
import { safeErrorMessage, scrubSecrets } from './secrets.js';
import type { MailTransport } from './types.js';

export type MailTransportFactory = (account: MailAccountSummary, secret: MailAccountSecret) => MailTransport;

export const defaultTransportFactory: MailTransportFactory = (account, secret) => new ImapSmtpTransport({ account, secret });

export interface MailServiceOptions {
  accounts?: () => MailAccountStore;
  drafts?: () => DraftStore;
  factory?: MailTransportFactory;
}

/** Shown when no account is configured. */
export const NO_ACCOUNT_HINT =
  'No mail account is set up. Ask the user to add one in a terminal: qodex mail add <name> --provider gmail|outlook|yahoo|icloud|… (the app password is typed hidden, never in chat).';

export class MailService {
  private transports = new Map<string, MailTransport>();
  private knownSecrets: Array<{ user: string; values: string[] }> = [];

  constructor(private readonly opts: MailServiceOptions = {}) {}

  accounts(): MailAccountStore {
    return this.opts.accounts ? this.opts.accounts() : getMailAccounts();
  }

  drafts(): DraftStore {
    return this.opts.drafts ? this.opts.drafts() : getDraftStore();
  }

  /** The account (default when omitted). Throws `[MAIL_NO_ACCOUNT]` / `[MAIL_ACCOUNT_NOT_FOUND]`. */
  async account(name?: string): Promise<MailAccountSummary> {
    const store = this.accounts();
    const a = await store.get(name);
    if (a) return a;
    const all = await store.list();
    if (!all.length) throw new Error(`[MAIL_NO_ACCOUNT] ${NO_ACCOUNT_HINT}`);
    throw new Error(`[MAIL_ACCOUNT_NOT_FOUND] no mail account "${String(name).slice(0, 64)}" — accounts: ${all.map(x => x.name).join(', ')}`);
  }

  /** A transport for the account (cached), plus the account summary. */
  async transport(name?: string): Promise<{ account: MailAccountSummary; transport: MailTransport }> {
    const account = await this.account(name);
    const key = account.name.toLowerCase();
    const cached = this.transports.get(key);
    if (cached) return { account, transport: cached };
    const cred = await this.accounts().credentials(account.name);
    if (!cred) throw new Error(`[MAIL_ACCOUNT_NOT_FOUND] no mail account "${account.name}"`);
    this.remember(cred.account.user, cred.secret);
    const transport = (this.opts.factory ?? defaultTransportFactory)(cred.account, cred.secret);
    this.transports.set(key, transport);
    return { account: cred.account, transport };
  }

  /** Make a transport for a one-off check (not cached), e.g. `qodex mail test`. */
  async freshTransport(name?: string): Promise<{ account: MailAccountSummary; transport: MailTransport }> {
    const cred = await this.accounts().credentials(name);
    if (!cred) {
      await this.account(name); // throws the right error
      throw new Error(`[MAIL_ACCOUNT_NOT_FOUND] no mail account "${String(name)}"`);
    }
    this.remember(cred.account.user, cred.secret);
    return { account: cred.account, transport: (this.opts.factory ?? defaultTransportFactory)(cred.account, cred.secret) };
  }

  private remember(user: string, secret: MailAccountSecret): void {
    const values = [secret.password, secret.accessToken].filter((v): v is string => !!v);
    if (values.length) this.knownSecrets.push({ user, values });
  }

  /** Remove every loaded password / token (all encodings) from `text`. */
  scrub(text: string): string {
    let out = String(text ?? '');
    for (const s of this.knownSecrets) out = scrubSecrets(out, s.values, s.user);
    return out;
  }

  /** A safe one-line error message for a tool result. */
  errorText(e: unknown): string {
    const all = this.knownSecrets.flatMap(s => s.values);
    const users = this.knownSecrets.map(s => s.user);
    let msg = safeErrorMessage(e, all);
    for (const u of users) msg = scrubSecrets(msg, all, u);
    return msg;
  }

  /** Drop a cached transport (after an auth failure or account change). */
  async forget(name: string): Promise<void> {
    const key = String(name ?? '').toLowerCase();
    const t = this.transports.get(key);
    this.transports.delete(key);
    try { await t?.close(); } catch { /* ignore */ }
  }

  async closeAll(): Promise<void> {
    const all = [...this.transports.values()];
    this.transports.clear();
    await Promise.all(all.map(t => t.close().catch(() => {})));
  }
}

let instance: MailService | null = null;

export function getMailService(): MailService {
  if (!instance) instance = new MailService();
  return instance;
}

/** Test hook. */
export function setMailServiceForTests(s: MailService | null): void {
  instance = s;
}
