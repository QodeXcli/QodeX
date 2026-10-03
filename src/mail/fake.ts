/**
 * In-memory MailTransport for tests and offline development. Folders hold messages
 * with UIDs; `send` records what would have been sent; `deliver` simulates new mail
 * arriving (watcher tests). Special-use folders: INBOX, Drafts, Sent, Archive, Trash, Junk.
 */

import { randomBytes } from 'crypto';
import {
  asSpecialFolder, makeMessageId, parseMessageId,
  type AppendResult, type FolderInfo, type ListQuery, type MailAddress, type MailAttachmentData, type MailMessage,
  type FolderStatus, type MailSummary, type MailTransport, type OutgoingMail, type SendResult, type SpecialFolder, type TransportCheck,
  type WaitResult,
} from './types.js';

export interface FakeMessageInput {
  from: string | MailAddress;
  to?: Array<string | MailAddress>;
  cc?: Array<string | MailAddress>;
  replyTo?: Array<string | MailAddress>;
  subject?: string;
  text?: string;
  date?: string | Date;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  flags?: string[];
  attachments?: Array<{ filename: string; contentType?: string; content: Buffer | string; inline?: boolean }>;
  headers?: Record<string, string>;
}

interface StoredMessage {
  uid: number;
  msg: Omit<MailMessage, 'id' | 'folder' | 'uid'>;
  data: MailAttachmentData[];
}

const SPECIAL: Record<SpecialFolder, string> = {
  inbox: 'INBOX', drafts: 'Drafts', sent: 'Sent', archive: 'Archive', trash: 'Trash', junk: 'Junk',
};

function addr(a: string | MailAddress): MailAddress {
  if (typeof a !== 'string') return { ...a };
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(a);
  return m ? { name: m[1] || undefined, address: m[2] } : { address: a.trim() };
}

export interface FakeTransportOptions {
  account?: string;
  /** No Drafts folder (appendDraft → null). */
  noDrafts?: boolean;
  /** Throw this from every network-ish call (error-leak tests). */
  failWith?: Error;
}

export class InMemoryMailTransport implements MailTransport {
  readonly account: string;
  private boxes = new Map<string, { nextUid: number; messages: StoredMessage[] }>();
  private waiters: Array<{ folder: string; wake: (r?: WaitResult) => void }> = [];
  /** UIDVALIDITY of every folder (tests may change it to simulate a renumbering). */
  uidValidity = '1';
  /** Everything send() accepted, in order. */
  readonly sent: OutgoingMail[] = [];
  /** Drafts appended to the server. */
  readonly appendedDrafts: OutgoingMail[] = [];
  closed = false;
  failWith?: Error;

  constructor(private readonly opts: FakeTransportOptions = {}) {
    this.account = opts.account ?? 'fake';
    this.failWith = opts.failWith;
    for (const [k, f] of Object.entries(SPECIAL)) {
      if (k === 'drafts' && opts.noDrafts) continue;
      this.boxes.set(f, { nextUid: 1, messages: [] });
    }
  }

  private check(): void {
    if (this.failWith) throw this.failWith;
  }

  private box(folder: string) {
    const b = this.boxes.get(folder) ?? [...this.boxes.entries()].find(([k]) => k.toLowerCase() === folder.toLowerCase())?.[1];
    if (!b) throw new Error(`[MAIL_FOLDER_NOT_FOUND] no folder "${folder}"`);
    return b;
  }

  private resolveFolder(dest: string): string {
    const sp = asSpecialFolder(dest);
    if (sp) {
      const f = SPECIAL[sp];
      if (!this.boxes.has(f)) throw new Error(`[MAIL_FOLDER_NOT_FOUND] this account has no ${sp} folder`);
      return f;
    }
    const hit = [...this.boxes.keys()].find(k => k.toLowerCase() === dest.toLowerCase());
    if (!hit) throw new Error(`[MAIL_FOLDER_NOT_FOUND] no folder "${dest}"`);
    return hit;
  }

  /** Add a folder (tests). */
  addFolder(name: string): void {
    if (!this.boxes.has(name)) this.boxes.set(name, { nextUid: 1, messages: [] });
  }

  /** Simulate a message arriving in `folder` (default INBOX). Returns its id. */
  deliver(input: FakeMessageInput, folder = 'INBOX'): string {
    const b = this.box(folder);
    const uid = b.nextUid++;
    const attachments = (input.attachments ?? []).map((a, i) => {
      const content = Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content);
      return { info: { index: i, filename: a.filename, contentType: a.contentType ?? 'application/octet-stream', size: content.length, ...(a.inline ? { inline: true } : {}) }, data: { filename: a.filename, contentType: a.contentType ?? 'application/octet-stream', content } };
    });
    const msg: StoredMessage['msg'] = {
      messageId: input.messageId ?? `<${randomBytes(6).toString('hex')}@fake.example>`,
      from: [addr(input.from)],
      to: (input.to ?? []).map(addr),
      cc: (input.cc ?? []).map(addr),
      replyTo: (input.replyTo ?? []).map(addr),
      subject: input.subject ?? '',
      date: new Date(input.date ?? Date.now()).toISOString(),
      flags: [...(input.flags ?? [])],
      text: input.text ?? '',
      inReplyTo: input.inReplyTo,
      references: [...(input.references ?? [])],
      attachments: attachments.map(a => a.info),
      hasAttachments: attachments.length > 0,
      size: (input.text ?? '').length + attachments.reduce((n, a) => n + a.data.content.length, 0),
      headers: input.headers ? { ...input.headers } : undefined,
    };
    b.messages.push({ uid, msg, data: attachments.map(a => a.data) });
    const name = this.resolveFolderName(folder);
    const woken = this.waiters.filter(w => w.folder.toLowerCase() === name.toLowerCase());
    this.waiters = this.waiters.filter(w => !woken.includes(w));
    for (const w of woken) w.wake();
    return makeMessageId(name, uid);
  }

  async status(folder: string): Promise<FolderStatus> {
    this.check();
    const name = this.resolveFolder(folder);
    const b = this.box(name);
    return {
      folder: name, messages: b.messages.length, unseen: b.messages.filter(m => !m.msg.flags.includes('\\Seen')).length,
      uidNext: b.nextUid, uidValidity: this.uidValidity,
    };
  }

  waitForNew(folder: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<WaitResult> {
    this.check();
    const name = this.resolveFolder(folder);
    return new Promise<WaitResult>((resolve) => {
      let done = false;
      const finish = (r: WaitResult) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.waiters = this.waiters.filter(w => w !== waiter);
        resolve(r);
      };
      const waiter = { folder: name, wake: (r?: WaitResult) => finish(r ?? { changed: true, reason: 'exists' }) };
      const timer = setTimeout(() => finish({ changed: false, reason: 'timeout' }), opts.timeoutMs ?? 60_000);
      timer.unref?.();
      if (opts.signal?.aborted) { finish({ changed: false, reason: 'abort' }); return; }
      opts.signal?.addEventListener('abort', () => finish({ changed: false, reason: 'abort' }), { once: true });
      this.waiters.push(waiter);
    });
  }

  private resolveFolderName(folder: string): string {
    return [...this.boxes.keys()].find(k => k.toLowerCase() === folder.toLowerCase()) ?? folder;
  }

  private find(id: string): { folder: string; stored: StoredMessage } | null {
    const p = parseMessageId(id);
    if (!p) return null;
    const folder = this.resolveFolderName(p.folder);
    const b = this.boxes.get(folder);
    const stored = b?.messages.find(m => m.uid === p.uid);
    return stored ? { folder, stored } : null;
  }

  private summary(folder: string, s: StoredMessage): MailSummary {
    const m = s.msg;
    return {
      id: makeMessageId(folder, s.uid), folder, uid: s.uid, messageId: m.messageId,
      from: m.from, to: m.to, subject: m.subject, date: m.date, flags: [...m.flags],
      snippet: m.text.replace(/\s+/g, ' ').trim().slice(0, 160), hasAttachments: m.hasAttachments, size: m.size,
    };
  }

  async list(q: ListQuery): Promise<MailSummary[]> {
    this.check();
    const folder = this.resolveFolder(q.folder || 'inbox');
    const needle = (q.query ?? '').trim().toLowerCase();
    const rows = this.box(folder).messages.filter(s => {
      if (q.unreadOnly && s.msg.flags.includes('\\Seen')) return false;
      if (q.sinceUid && s.uid <= q.sinceUid) return false;
      if (!needle) return true;
      const hay = [s.msg.subject, s.msg.text, ...s.msg.from.map(a => `${a.name ?? ''} ${a.address}`)].join(' ').toLowerCase();
      return hay.includes(needle);
    });
    const limit = Math.max(1, Math.min(q.limit ?? 20, 200));
    return rows.slice(-limit).reverse().map(s => this.summary(folder, s));
  }

  search(query: string, opts: Omit<ListQuery, 'query'> = {}): Promise<MailSummary[]> {
    return this.list({ ...opts, query });
  }

  async fetch(id: string): Promise<MailMessage | null> {
    this.check();
    const f = this.find(id);
    if (!f) return null;
    const m = f.stored.msg;
    return {
      ...this.summary(f.folder, f.stored),
      cc: m.cc, replyTo: m.replyTo, inReplyTo: m.inReplyTo, references: [...m.references], text: m.text,
      attachments: m.attachments.map(a => ({ ...a })), headers: m.headers ? { ...m.headers } : undefined,
    };
  }

  async fetchAttachment(id: string, which: { index?: number; filename?: string }): Promise<MailAttachmentData | null> {
    this.check();
    const f = this.find(id);
    if (!f) return null;
    const list = f.stored.data;
    const hit = typeof which.index === 'number' ? list[which.index] : list.find(a => a.filename === which.filename);
    return hit ? { ...hit, content: Buffer.from(hit.content) } : null;
  }

  async flag(id: string, change: { seen?: boolean; flagged?: boolean; answered?: boolean }): Promise<void> {
    this.check();
    const f = this.find(id);
    if (!f) throw new Error(`[MAIL_NOT_FOUND] no message ${id}`);
    const flags = new Set(f.stored.msg.flags);
    const set = (flag: string, on: boolean | undefined) => { if (on === true) flags.add(flag); else if (on === false) flags.delete(flag); };
    set('\\Seen', change.seen);
    set('\\Flagged', change.flagged);
    set('\\Answered', change.answered);
    f.stored.msg.flags = [...flags];
  }

  async move(id: string, dest: string): Promise<{ folder: string; id?: string }> {
    this.check();
    const f = this.find(id);
    if (!f) throw new Error(`[MAIL_NOT_FOUND] no message ${id}`);
    const target = this.resolveFolder(dest);
    if (target === f.folder) return { folder: target, id };
    const src = this.box(f.folder);
    src.messages = src.messages.filter(m => m !== f.stored);
    const t = this.box(target);
    const uid = t.nextUid++;
    t.messages.push({ ...f.stored, uid });
    return { folder: target, id: makeMessageId(target, uid) };
  }

  private append(folder: string, msg: OutgoingMail, flags: string[]): AppendResult {
    const b = this.box(folder);
    const uid = b.nextUid++;
    b.messages.push({
      uid,
      msg: {
        messageId: msg.messageId, from: [msg.from], to: msg.to.map(a => ({ address: a })), cc: msg.cc.map(a => ({ address: a })),
        replyTo: [], subject: msg.subject, date: (msg.date ?? new Date()).toISOString(), flags,
        text: msg.text, inReplyTo: msg.inReplyTo, references: [...(msg.references ?? [])],
        attachments: msg.attachments.map((a, i) => ({ index: i, filename: a.filename, contentType: a.contentType ?? 'application/octet-stream', size: a.content.length })),
        hasAttachments: msg.attachments.length > 0, size: msg.text.length,
      },
      data: msg.attachments.map(a => ({ filename: a.filename, contentType: a.contentType ?? 'application/octet-stream', content: a.content })),
    });
    return { folder, uid };
  }

  async appendDraft(msg: OutgoingMail): Promise<AppendResult | null> {
    this.check();
    if (!this.boxes.has('Drafts')) return null;
    this.appendedDrafts.push(msg);
    return this.append('Drafts', msg, ['\\Draft', '\\Seen']);
  }

  async appendSent(msg: OutgoingMail): Promise<AppendResult | null> {
    this.check();
    return this.append('Sent', msg, ['\\Seen']);
  }

  async deleteMessage(id: string): Promise<void> {
    this.check();
    const f = this.find(id);
    if (!f) return;
    const b = this.box(f.folder);
    b.messages = b.messages.filter(m => m !== f.stored);
  }

  async send(msg: OutgoingMail): Promise<SendResult> {
    this.check();
    this.sent.push(msg);
    return {
      messageId: msg.messageId ?? `<${randomBytes(6).toString('hex')}@fake.example>`,
      accepted: [...msg.to, ...msg.cc, ...msg.bcc], rejected: [], response: '250 OK (fake)',
    };
  }

  async folders(): Promise<FolderInfo[]> {
    this.check();
    const special = new Map(Object.entries(SPECIAL).map(([k, v]) => [v, k as SpecialFolder]));
    return [...this.boxes.keys()].map(path => ({ path, ...(special.has(path) ? { specialUse: special.get(path) } : {}) }));
  }

  async test(): Promise<TransportCheck> {
    if (this.failWith) {
      const error = String(this.failWith.message);
      return { imap: { ok: false, error }, smtp: { ok: false, error } };
    }
    return { imap: { ok: true }, smtp: { ok: true } };
  }

  async close(): Promise<void> {
    this.closed = true;
    const waiting = this.waiters;
    this.waiters = [];
    for (const w of waiting) w.wake({ changed: false, reason: 'closed' });
  }
}
