/**
 * The real MailTransport: IMAP through imapflow, SMTP through nodemailer, MIME parsing
 * through mailparser. All three are optionalDependencies and imported dynamically
 * (like playwright), typed loosely.
 *
 * Security:
 *   - TLS always, except plain connections to a LOOPBACK host when the account allows
 *     it (Proton Mail Bridge). Port 587 / 143 accounts must upgrade with STARTTLS.
 *   - Certificates are verified (tests may pass `tls.rejectUnauthorized=false` for a
 *     local self-signed server).
 *   - Library logging is off, and every error is rebuilt from a scrubbed message
 *     (safeErrorMessage), so a password / token / AUTH blob can't escape in an error.
 *   - nodemailer may not read local files or fetch URLs on its own
 *     (disableFileAccess / disableUrlAccess): attachments are passed as bytes the tool
 *     read itself after its own checks.
 */

import type { MailAccountSecret, MailAccountSummary } from './accounts.js';
import { isLoopbackHost } from './accounts.js';
import { safeErrorMessage, scrubSecrets } from './secrets.js';
import {
  asSpecialFolder, makeMessageId, parseMessageId,
  type AppendResult, type FolderInfo, type ListQuery, type MailAddress, type MailAttachmentData, type MailMessage,
  type FolderStatus, type MailSummary, type MailTransport, type OutgoingMail, type SendResult, type SpecialFolder, type TransportCheck,
  type WaitResult,
} from './types.js';

export interface ImapSmtpOptions {
  account: MailAccountSummary;
  secret: MailAccountSecret;
  /** Connection / greeting timeout, ms. Default 30 s. */
  timeoutMs?: number;
  /** TLS overrides (tests: a local self-signed server). */
  tls?: { rejectUnauthorized?: boolean };
  /** Module loaders (tests). */
  loaders?: {
    imapflow?: () => Promise<any>;
    nodemailer?: () => Promise<any>;
    mailparser?: () => Promise<any>;
    composer?: () => Promise<any>;
  };
}

/** Largest message source parsed for mail_read (bytes). */
const MAX_SOURCE = 30 * 1024 * 1024;
/** Bytes of each message parsed for a list snippet. */
const SNIPPET_BYTES = 16 * 1024;

async function load(name: string): Promise<any> {
  try {
    return await import(name);
  } catch {
    throw new Error(`[MAIL_UNAVAILABLE] the "${name}" package is not installed (it is an optional dependency) — reinstall QodeX with optional dependencies: npm i -g qodex --include=optional`);
  }
}

const loadImapFlow = () => load('imapflow');
const loadNodemailer = () => load('nodemailer');
const loadMailparser = () => load('mailparser');
const loadComposer = () => load('nodemailer/lib/mail-composer');

function pick(mod: any, name: string): any {
  return mod?.[name] ?? mod?.default?.[name] ?? (name === 'default' ? mod?.default : undefined);
}

function toAddr(list: any): MailAddress[] {
  const arr = Array.isArray(list) ? list : list?.value ?? [];
  const out: MailAddress[] = [];
  for (const a of arr) {
    if (a?.group) { out.push(...toAddr(a.group)); continue; }
    if (a?.address) out.push({ address: String(a.address), ...(a.name ? { name: String(a.name) } : {}) });
  }
  return out;
}

const SPECIAL_USE: Record<string, SpecialFolder> = {
  '\\inbox': 'inbox', '\\drafts': 'drafts', '\\sent': 'sent', '\\archive': 'archive', '\\all': 'archive', '\\trash': 'trash', '\\junk': 'junk',
};

/** Folder-name fallbacks when the server doesn't advertise SPECIAL-USE. */
const NAME_HINTS: Record<SpecialFolder, RegExp> = {
  inbox: /^inbox$/i,
  drafts: /(^|[/.])(drafts?|entwürfe|brouillons|borradores)$/i,
  sent: /(^|[/.])(sent( items| mail| messages)?|gesendet|envoy[ée]s)$/i,
  archive: /(^|[/.])(archive|archives|all mail)$/i,
  trash: /(^|[/.])(trash|deleted( items| messages)?|bin|papierkorb|corbeille)$/i,
  junk: /(^|[/.])(junk|spam|junk e-?mail|bulk mail)$/i,
};

/** Minimal HTML → text fallback (mailparser normally provides text). PURE. */
export function htmlToText(html: string): string {
  return String(html ?? '')
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

export class ImapSmtpTransport implements MailTransport {
  readonly account: string;
  private client: any = null;
  private connecting: Promise<any> | null = null;
  private folderCache: FolderInfo[] | null = null;

  constructor(private readonly opts: ImapSmtpOptions) {
    this.account = opts.account.name;
  }

  private get secrets(): Array<string | undefined> {
    return [this.opts.secret.password, this.opts.secret.accessToken];
  }

  /** A clean error: code + scrubbed one-line message. Never carries the original (it may hold secrets). */
  private fail(kind: 'IMAP' | 'SMTP', e: unknown): Error {
    const msg = safeErrorMessage(e, this.secrets, this.opts.account.user);
    if (/^\[MAIL_[A-Z_]+\]/.test(msg)) return new Error(msg);
    const auth = (e as any)?.authenticationFailed || (e as any)?.code === 'EAUTH' || /auth(entication)?\s*fail|invalid (login|credentials)|\b535\b|LOGIN failed/i.test(msg);
    if (auth) {
      return new Error(`[MAIL_AUTH_FAILED] ${kind} sign-in for "${this.account}" was refused (${msg}). Check the app password: qodex mail add ${this.account} --force`);
    }
    return new Error(`[MAIL_${kind}_ERROR] ${msg}`);
  }

  private tls(host: string): Record<string, unknown> {
    return { servername: /^[\d.:[\]]+$/.test(host) ? undefined : host, ...(this.opts.tls ?? {}) };
  }

  private plainAllowed(host: string): boolean {
    return !!this.opts.account.allowInsecure && isLoopbackHost(host);
  }

  private imapOptions(): Record<string, unknown> {
    const a = this.opts.account;
    const s = this.opts.secret;
    const ep = a.imap;
    const t = this.opts.timeoutMs ?? 30_000;
    return {
      host: ep.host, port: ep.port, secure: ep.secure,
      // Non-TLS port: STARTTLS is mandatory unless this is a local bridge.
      ...(ep.secure ? {} : { doSTARTTLS: this.plainAllowed(ep.host) ? undefined : true }),
      auth: s.accessToken ? { user: a.user, accessToken: s.accessToken } : { user: a.user, pass: s.password ?? '' },
      tls: this.tls(ep.host),
      logger: false, emitLogs: false, disableAutoIdle: true,
      connectionTimeout: t, greetingTimeout: Math.min(t, 15_000), socketTimeout: 120_000,
    };
  }

  private async imap(): Promise<any> {
    if (this.client?.usable) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const mod = await (this.opts.loaders?.imapflow ?? loadImapFlow)();
      const ImapFlow = pick(mod, 'ImapFlow') ?? pick(mod, 'default');
      const c = new ImapFlow(this.imapOptions());
      c.on?.('error', () => { /* surfaced through the failing call */ });
      try {
        await c.connect();
      } catch (e) {
        try { c.close?.(); } catch { /* ignore */ }
        throw this.fail('IMAP', e);
      }
      this.client = c;
      return c;
    })();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  /** Run `fn` with the folder selected (EXAMINE for read-only). */
  private async withFolder<T>(folder: string, readOnly: boolean, fn: (c: any) => Promise<T>): Promise<T> {
    const c = await this.imap();
    let lock: any;
    try {
      lock = await c.getMailboxLock(folder, { readOnly });
    } catch (e) {
      throw this.fail('IMAP', e);
    }
    try {
      return await fn(c);
    } catch (e) {
      throw this.fail('IMAP', e);
    } finally {
      try { lock.release(); } catch { /* ignore */ }
    }
  }

  async folders(): Promise<FolderInfo[]> {
    if (this.folderCache) return this.folderCache;
    const c = await this.imap();
    let list: any[];
    try { list = await c.list(); } catch (e) { throw this.fail('IMAP', e); }
    const out: FolderInfo[] = [];
    for (const f of list ?? []) {
      if (f?.flags?.has?.('\\Noselect')) continue;
      const path = String(f.path);
      const special = SPECIAL_USE[String(f.specialUse ?? '').toLowerCase()] ?? (path.toUpperCase() === 'INBOX' ? 'inbox' : undefined);
      out.push({ path, ...(special ? { specialUse: special } : {}) });
    }
    this.folderCache = out;
    return out;
  }

  /** A folder path from a special name or a path (case-insensitive). */
  private async resolveFolder(dest: string): Promise<string> {
    const configured = this.opts.account.folders;
    const sp = asSpecialFolder(dest);
    if (sp === 'inbox') return 'INBOX';
    const all = await this.folders();
    if (sp) {
      const fromCfg = configured?.[sp as keyof typeof configured];
      if (fromCfg) return fromCfg;
      const hit = all.find(f => f.specialUse === sp) ?? all.find(f => NAME_HINTS[sp].test(f.path));
      if (!hit) throw new Error(`[MAIL_FOLDER_NOT_FOUND] the "${this.account}" mailbox has no ${sp} folder — pass a folder name (see mail_list folder)`);
      return hit.path;
    }
    const exact = all.find(f => f.path === dest) ?? all.find(f => f.path.toLowerCase() === String(dest).toLowerCase());
    if (!exact) throw new Error(`[MAIL_FOLDER_NOT_FOUND] no folder "${String(dest).slice(0, 80)}" in "${this.account}" (folders: ${all.slice(0, 12).map(f => f.path).join(', ')})`);
    return exact.path;
  }

  private async parse(source: Buffer): Promise<any> {
    const mod = await (this.opts.loaders?.mailparser ?? loadMailparser)();
    const simpleParser = pick(mod, 'simpleParser');
    return simpleParser(source, { skipImageLinks: true, skipTextLinks: true });
  }

  private summaryFrom(folder: string, m: any, snippet?: string, hasAttachments?: boolean): MailSummary {
    const env = m.envelope ?? {};
    const date = env.date ?? m.internalDate;
    return {
      id: makeMessageId(folder, Number(m.uid)), folder, uid: Number(m.uid),
      ...(env.messageId ? { messageId: String(env.messageId) } : {}),
      from: toAddr(env.from), to: toAddr(env.to), subject: String(env.subject ?? ''),
      ...(date ? { date: new Date(date).toISOString() } : {}),
      flags: [...(m.flags ?? [])].map(String),
      ...(snippet !== undefined ? { snippet } : {}),
      ...(hasAttachments !== undefined ? { hasAttachments } : {}),
      ...(typeof m.size === 'number' ? { size: m.size } : {}),
    };
  }

  async list(q: ListQuery): Promise<MailSummary[]> {
    const folder = await this.resolveFolder(q.folder || 'inbox');
    const limit = Math.max(1, Math.min(q.limit ?? 20, 100));
    return this.withFolder(folder, true, async (c) => {
      const criteria: Record<string, unknown> = {};
      if (q.unreadOnly) criteria.seen = false;
      if (q.query) criteria.text = q.query;
      if (q.sinceUid) criteria.uid = `${q.sinceUid + 1}:*`;
      if (!Object.keys(criteria).length) criteria.all = true;
      let uids: number[] = ((await c.search(criteria, { uid: true })) || []).map(Number);
      if (q.sinceUid) uids = uids.filter(u => u > q.sinceUid!); // "n:*" always matches the newest message
      uids.sort((a, b) => a - b);
      const chosen = uids.slice(-limit);
      if (!chosen.length) return [];
      const rows: MailSummary[] = [];
      for await (const m of c.fetch(chosen, {
        uid: true, envelope: true, flags: true, internalDate: true, size: true, bodyStructure: true,
        source: { maxLength: SNIPPET_BYTES },
      }, { uid: true })) {
        let snippet: string | undefined;
        try {
          if (m.source) {
            const p = await this.parse(m.source);
            snippet = String(p.text || (p.html ? htmlToText(p.html) : '')).replace(/\s+/g, ' ').trim().slice(0, 160);
          }
        } catch { /* snippet is best-effort */ }
        rows.push(this.summaryFrom(folder, m, snippet, hasAttachmentPart(m.bodyStructure)));
      }
      return rows.sort((a, b) => b.uid - a.uid);
    });
  }

  search(query: string, opts: Omit<ListQuery, 'query'> = {}): Promise<MailSummary[]> {
    return this.list({ ...opts, query });
  }

  private async fetchParsed(id: string): Promise<{ folder: string; m: any; parsed: any } | null> {
    const p = parseMessageId(id);
    if (!p) throw new Error(`[MAIL_NOT_FOUND] "${String(id).slice(0, 80)}" is not a message id (folder#uid from mail_list)`);
    const folder = await this.resolveFolder(p.folder);
    return this.withFolder(folder, true, async (c) => {
      const m = await c.fetchOne(String(p.uid), { uid: true, envelope: true, flags: true, internalDate: true, size: true, source: { maxLength: MAX_SOURCE } }, { uid: true });
      if (!m) return null;
      const parsed = await this.parse(m.source ?? Buffer.alloc(0));
      return { folder, m, parsed };
    });
  }

  async fetch(id: string): Promise<MailMessage | null> {
    const r = await this.fetchParsed(id);
    if (!r) return null;
    const { folder, m, parsed } = r;
    const atts = (parsed.attachments ?? []) as any[];
    const text = String(parsed.text || (parsed.html ? htmlToText(String(parsed.html)) : '') || '');
    const headers: Record<string, string> = {};
    for (const h of ['auto-submitted', 'list-id', 'list-unsubscribe', 'precedence', 'x-auto-response-suppress']) {
      const v = parsed.headers?.get?.(h);
      if (v) headers[h] = typeof v === 'string' ? v : String(v?.text ?? v?.value ?? JSON.stringify(v)).slice(0, 300);
    }
    const refs = parsed.references ? (Array.isArray(parsed.references) ? parsed.references : [parsed.references]) : [];
    return {
      ...this.summaryFrom(folder, m, text.replace(/\s+/g, ' ').trim().slice(0, 160), atts.length > 0),
      messageId: parsed.messageId ?? m.envelope?.messageId,
      subject: String(parsed.subject ?? m.envelope?.subject ?? ''),
      from: toAddr(parsed.from) .length ? toAddr(parsed.from) : toAddr(m.envelope?.from),
      to: toAddr(parsed.to).length ? toAddr(parsed.to) : toAddr(m.envelope?.to),
      cc: toAddr(parsed.cc),
      replyTo: toAddr(parsed.replyTo),
      ...(parsed.inReplyTo ? { inReplyTo: String(parsed.inReplyTo) } : {}),
      references: refs.map(String),
      text,
      attachments: atts.map((a, i) => ({
        index: i, filename: String(a.filename || `attachment-${i + 1}`), contentType: String(a.contentType || 'application/octet-stream'),
        size: Number(a.size ?? a.content?.length ?? 0), ...(a.related || a.contentDisposition === 'inline' ? { inline: true } : {}),
      })),
      ...(Object.keys(headers).length ? { headers } : {}),
    };
  }

  async fetchAttachment(id: string, which: { index?: number; filename?: string }): Promise<MailAttachmentData | null> {
    const r = await this.fetchParsed(id);
    if (!r) return null;
    const atts = (r.parsed.attachments ?? []) as any[];
    const idx = typeof which.index === 'number' ? which.index : atts.findIndex((a, i) => String(a.filename || `attachment-${i + 1}`) === which.filename);
    const a = idx >= 0 ? atts[idx] : undefined;
    if (!a) return null;
    return { filename: String(a.filename || `attachment-${idx + 1}`), contentType: String(a.contentType || 'application/octet-stream'), content: Buffer.from(a.content ?? []) };
  }

  async flag(id: string, change: { seen?: boolean; flagged?: boolean; answered?: boolean }): Promise<void> {
    const p = parseMessageId(id);
    if (!p) throw new Error(`[MAIL_NOT_FOUND] "${String(id).slice(0, 80)}" is not a message id`);
    const folder = await this.resolveFolder(p.folder);
    await this.withFolder(folder, false, async (c) => {
      const add: string[] = []; const del: string[] = [];
      const put = (f: string, on: boolean | undefined) => { if (on === true) add.push(f); else if (on === false) del.push(f); };
      put('\\Seen', change.seen); put('\\Flagged', change.flagged); put('\\Answered', change.answered);
      if (add.length) await c.messageFlagsAdd(String(p.uid), add, { uid: true });
      if (del.length) await c.messageFlagsRemove(String(p.uid), del, { uid: true });
    });
  }

  async move(id: string, dest: string): Promise<{ folder: string; id?: string }> {
    const p = parseMessageId(id);
    if (!p) throw new Error(`[MAIL_NOT_FOUND] "${String(id).slice(0, 80)}" is not a message id`);
    const from = await this.resolveFolder(p.folder);
    const to = await this.resolveFolder(dest);
    if (from === to) return { folder: to, id: makeMessageId(to, p.uid) };
    return this.withFolder(from, false, async (c) => {
      const r = await c.messageMove(String(p.uid), to, { uid: true });
      if (!r) throw new Error(`[MAIL_NOT_FOUND] message ${id} is not in ${from} any more`);
      const newUid = r?.uidMap?.get?.(p.uid);
      return { folder: to, ...(newUid ? { id: makeMessageId(to, Number(newUid)) } : {}) };
    });
  }

  /** RFC 5322 bytes of `msg` (Bcc kept for drafts so the user sees it). */
  async compose(msg: OutgoingMail, keepBcc = false): Promise<Buffer> {
    const mod = await (this.opts.loaders?.composer ?? loadComposer)();
    const MailComposer = pick(mod, 'default') ?? mod;
    const compiled = new MailComposer(this.mailOptions(msg)).compile();
    if (keepBcc) compiled.keepBcc = true;
    return new Promise<Buffer>((resolve, reject) => compiled.build((err: unknown, out: Buffer) => (err ? reject(err) : resolve(out))));
  }

  private mailOptions(msg: OutgoingMail): Record<string, unknown> {
    return {
      from: msg.from.name ? { name: msg.from.name, address: msg.from.address } : msg.from.address,
      to: msg.to, cc: msg.cc, bcc: msg.bcc,
      subject: msg.subject, text: msg.text,
      ...(msg.inReplyTo ? { inReplyTo: msg.inReplyTo } : {}),
      ...(msg.references?.length ? { references: msg.references } : {}),
      ...(msg.messageId ? { messageId: msg.messageId } : {}),
      date: msg.date ?? new Date(),
      attachments: msg.attachments.map(a => ({ filename: a.filename, content: a.content, ...(a.contentType ? { contentType: a.contentType } : {}) })),
      disableFileAccess: true, disableUrlAccess: true,
    };
  }

  private async appendTo(sp: SpecialFolder, msg: OutgoingMail, flags: string[], keepBcc: boolean): Promise<AppendResult | null> {
    let folder: string;
    try {
      folder = await this.resolveFolder(sp);
    } catch (e: any) {
      if (String(e?.message ?? '').startsWith('[MAIL_FOLDER_NOT_FOUND]')) return null;
      throw e;
    }
    const raw = await this.compose(msg, keepBcc);
    const c = await this.imap();
    try {
      const r = await c.append(folder, raw, flags);
      if (!r) return null;
      return { folder: String(r.destination ?? r.path ?? folder), ...(r.uid ? { uid: Number(r.uid) } : {}) };
    } catch (e) {
      throw this.fail('IMAP', e);
    }
  }

  appendDraft(msg: OutgoingMail): Promise<AppendResult | null> {
    return this.appendTo('drafts', msg, ['\\Draft', '\\Seen'], true);
  }

  appendSent(msg: OutgoingMail): Promise<AppendResult | null> {
    return this.appendTo('sent', msg, ['\\Seen'], false);
  }

  async deleteMessage(id: string): Promise<void> {
    const p = parseMessageId(id);
    if (!p) return;
    const folder = await this.resolveFolder(p.folder);
    await this.withFolder(folder, false, async (c) => { await c.messageDelete(String(p.uid), { uid: true }); });
  }

  private async smtp(): Promise<any> {
    const a = this.opts.account;
    const s = this.opts.secret;
    const ep = a.smtp;
    const t = this.opts.timeoutMs ?? 30_000;
    const mod = await (this.opts.loaders?.nodemailer ?? loadNodemailer)();
    const createTransport = pick(mod, 'createTransport');
    return createTransport({
      host: ep.host, port: ep.port, secure: ep.secure,
      // Non-TLS port: STARTTLS is mandatory unless this is a local bridge.
      ...(ep.secure ? {} : this.plainAllowed(ep.host) ? { ignoreTLS: false } : { requireTLS: true }),
      auth: s.accessToken ? { type: 'OAuth2', user: a.user, accessToken: s.accessToken } : { user: a.user, pass: s.password ?? '' },
      tls: this.tls(ep.host),
      logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true,
      connectionTimeout: t, greetingTimeout: Math.min(t, 15_000), socketTimeout: 120_000,
    });
  }

  async send(msg: OutgoingMail): Promise<SendResult> {
    const transporter = await this.smtp();
    try {
      const info = await transporter.sendMail(this.mailOptions(msg));
      const list = (v: unknown) => (Array.isArray(v) ? v : []).map((x: any) => String(x?.address ?? x));
      return {
        messageId: String(info?.messageId ?? msg.messageId ?? ''),
        accepted: list(info?.accepted), rejected: list(info?.rejected),
        ...(info?.response ? { response: scrubSecrets(String(info.response), this.secrets, this.opts.account.user).slice(0, 200) } : {}),
      };
    } catch (e) {
      throw this.fail('SMTP', e);
    } finally {
      try { transporter.close?.(); } catch { /* ignore */ }
    }
  }

  async test(): Promise<TransportCheck> {
    const out: TransportCheck = { imap: { ok: false }, smtp: { ok: false } };
    try {
      await this.imap();
      out.imap = { ok: true };
    } catch (e: any) {
      out.imap = { ok: false, error: safeErrorMessage(e, this.secrets, this.opts.account.user) };
    }
    let transporter: any;
    try {
      transporter = await this.smtp();
      await transporter.verify();
      out.smtp = { ok: true };
    } catch (e: any) {
      out.smtp = { ok: false, error: this.fail('SMTP', e).message };
    } finally {
      try { transporter?.close?.(); } catch { /* ignore */ }
    }
    return out;
  }

  async status(folder: string): Promise<FolderStatus> {
    const path = await this.resolveFolder(folder || 'inbox');
    const c = await this.imap();
    try {
      const st = await c.status(path, { messages: true, unseen: true, uidNext: true, uidValidity: true });
      return {
        folder: path, messages: Number(st?.messages ?? 0), unseen: Number(st?.unseen ?? 0),
        uidNext: Number(st?.uidNext ?? 0), uidValidity: String(st?.uidValidity ?? ''),
      };
    } catch (e) {
      throw this.fail('IMAP', e);
    }
  }

  /**
   * IMAP IDLE on a dedicated connection (the shared one stays free for list / fetch):
   * resolves on the first EXISTS that grows the folder, on timeout, or on abort. Servers
   * without IDLE get imapflow's NOOP polling. Default timeout 25 min (servers drop IDLE ~29).
   */
  async waitForNew(folder: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<WaitResult> {
    if (opts.signal?.aborted) return { changed: false, reason: 'abort' };
    const path = await this.resolveFolder(folder || 'inbox');
    const mod = await (this.opts.loaders?.imapflow ?? loadImapFlow)();
    const ImapFlow = pick(mod, 'ImapFlow') ?? pick(mod, 'default');
    const c = new ImapFlow({ ...this.imapOptions(), missingIdleCommand: 'NOOP' });
    c.on?.('error', () => { /* ends the wait below */ });
    try {
      await c.connect();
    } catch (e) {
      try { c.close?.(); } catch { /* ignore */ }
      throw this.fail('IMAP', e);
    }
    let lock: any;
    try {
      lock = await c.getMailboxLock(path, { readOnly: true });
      return await new Promise<WaitResult>((resolve) => {
        let done = false;
        const finish = (r: WaitResult) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          c.off?.('exists', onExists);
          c.off?.('close', onClose);
          resolve(r);
        };
        const onExists = (ev: any) => { if (Number(ev?.count ?? 0) > Number(ev?.prevCount ?? 0)) finish({ changed: true, reason: 'exists' }); };
        const onClose = () => finish({ changed: false, reason: 'closed' });
        const timer = setTimeout(() => finish({ changed: false, reason: 'timeout' }), opts.timeoutMs ?? 25 * 60_000);
        timer.unref?.();
        c.on?.('exists', onExists);
        c.on?.('close', onClose);
        opts.signal?.addEventListener('abort', () => finish({ changed: false, reason: 'abort' }), { once: true });
        Promise.resolve(c.idle?.()).catch(() => finish({ changed: false, reason: 'closed' }));
      });
    } catch (e) {
      throw this.fail('IMAP', e);
    } finally {
      try { lock?.release(); } catch { /* ignore */ }
      try { await c.logout(); } catch { try { c.close?.(); } catch { /* ignore */ } }
    }
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = null;
    this.folderCache = null;
    if (!c) return;
    try { await c.logout(); } catch { try { c.close?.(); } catch { /* ignore */ } }
  }
}

/** Does a BODYSTRUCTURE contain an attachment part? PURE. */
export function hasAttachmentPart(node: any): boolean {
  if (!node) return false;
  const disp = String(node.disposition ?? '').toLowerCase();
  if (disp === 'attachment') return true;
  if (Array.isArray(node.childNodes)) return node.childNodes.some(hasAttachmentPart);
  return false;
}
