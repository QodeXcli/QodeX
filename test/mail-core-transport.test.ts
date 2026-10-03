/**
 * ImapSmtpTransport: SMTP against a REAL local smtp-server; IMAP mapping against a
 * scripted imapflow double (no IMAP server is reachable here) with the real mailparser.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import { EventEmitter } from 'events';
import type { AddressInfo } from 'net';
import { ImapSmtpTransport, hasAttachmentPart, htmlToText } from '../src/mail/imap-smtp.js';
import type { MailAccountSummary } from '../src/mail/accounts.js';

const require = createRequire(import.meta.url);
const { SMTPServer } = require('smtp-server');
const { simpleParser } = require('mailparser');

const PASS = 'smtp-app-pass-123456';

interface Received { from: string; rcpt: string[]; raw: Buffer; user?: string }
let server: any;
let port = 0;
let received: Received[] = [];
let authAttempts: Array<{ user: string; pass: string }> = [];

beforeAll(async () => {
  server = new SMTPServer({
    secure: false, disabledCommands: ['STARTTLS'], allowInsecureAuth: true, authOptional: false, logger: false,
    onAuth(auth: any, _s: any, cb: any) {
      authAttempts.push({ user: auth.username, pass: auth.password });
      if (auth.username === 'me@example.com' && auth.password === PASS) return cb(null, { user: auth.username });
      return cb(Object.assign(new Error(`Invalid username or password for ${auth.password}`), { responseCode: 535 }));
    },
    onData(stream: any, session: any, cb: any) {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        received.push({ from: session.envelope.mailFrom.address, rcpt: session.envelope.rcptTo.map((r: any) => r.address), raw: Buffer.concat(chunks), user: session.user });
        cb(null, 'Queued');
      });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(resolve));
});
beforeEach(() => {
  received = [];
  authAttempts = [];
});

function account(over: Partial<MailAccountSummary> = {}): MailAccountSummary {
  return {
    name: 'local', email: 'me@example.com', user: 'me@example.com', provider: 'custom', auth: 'password',
    imap: { host: '127.0.0.1', port: 1, secure: false }, smtp: { host: '127.0.0.1', port, secure: false },
    allowInsecure: true, createdAt: new Date().toISOString(), isDefault: true, hasPassword: true, hasToken: false, ...over,
  };
}

describe('SMTP send through a real local smtp-server', () => {
  it('delivers exactly the message: recipients, subject, body, threading headers, attachments; Bcc only in the envelope', async () => {
    const t = new ImapSmtpTransport({ account: account(), secret: { password: PASS }, timeoutMs: 5000 });
    const r = await t.send({
      from: { name: 'Me', address: 'me@example.com' },
      to: ['alice@example.org'], cc: ['carol@example.org'], bcc: ['boss@example.com'],
      subject: 'Re: Quarterly report — سلام', text: 'Thanks Alice,\nsee attached.',
      inReplyTo: '<orig-1@example.org>', references: ['<root@example.org>', '<orig-1@example.org>'],
      messageId: '<qodex.test.1@example.com>',
      attachments: [{ filename: 'report.csv', content: Buffer.from('a,b\n1,2\n'), contentType: 'text/csv' }],
    });
    expect(r.messageId).toBe('<qodex.test.1@example.com>');
    expect(r.accepted.sort()).toEqual(['alice@example.org', 'boss@example.com', 'carol@example.org']);
    expect(r.rejected).toEqual([]);
    expect(received).toHaveLength(1);
    const got = received[0];
    expect(got.user).toBe('me@example.com');
    expect(got.from).toBe('me@example.com');
    expect(got.rcpt.sort()).toEqual(['alice@example.org', 'boss@example.com', 'carol@example.org']);
    const parsed = await simpleParser(got.raw);
    expect(parsed.subject).toBe('Re: Quarterly report — سلام');
    expect(parsed.text.trim()).toBe('Thanks Alice,\nsee attached.');
    expect(parsed.to.value.map((a: any) => a.address)).toEqual(['alice@example.org']);
    expect(parsed.cc.value.map((a: any) => a.address)).toEqual(['carol@example.org']);
    expect(parsed.bcc).toBeUndefined();
    expect(got.raw.toString()).not.toMatch(/^bcc:/im);
    expect(parsed.inReplyTo).toBe('<orig-1@example.org>');
    expect(parsed.references).toEqual(['<root@example.org>', '<orig-1@example.org>']);
    expect(parsed.messageId).toBe('<qodex.test.1@example.com>');
    expect(parsed.attachments.map((a: any) => [a.filename, a.content.toString()])).toEqual([['report.csv', 'a,b\n1,2\n']]);
  });

  it('a refused login reports MAIL_AUTH_FAILED without the password in any form', async () => {
    const bad = 'Wr0ng-Pass-Value-99';
    const t = new ImapSmtpTransport({ account: account(), secret: { password: bad }, timeoutMs: 5000 });
    let err: any;
    try {
      await t.send({ from: { address: 'me@example.com' }, to: ['a@example.org'], cc: [], bcc: [], subject: 's', text: 't', attachments: [] });
    } catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(authAttempts.map(a => a.pass)).toContain(bad); // it really tried
    expect(err.message).toMatch(/^\[MAIL_AUTH_FAILED\]/);
    for (const form of [bad, Buffer.from(bad).toString('base64'), Buffer.from(`\u0000me@example.com\u0000${bad}`).toString('base64')]) {
      expect(err.message).not.toContain(form);
      expect(String(err.stack)).not.toContain(form);
    }
    expect(received).toHaveLength(0);
  });

  it('test() verifies SMTP and reports IMAP failures scrubbed', async () => {
    const t = new ImapSmtpTransport({ account: account(), secret: { password: PASS }, timeoutMs: 2000 });
    const r = await t.test();
    expect(r.smtp).toEqual({ ok: true });
    expect(r.imap.ok).toBe(false); // nothing listens on port 1
    expect(r.imap.error).not.toContain(PASS);
    await t.close();
  });

  it('builds RFC 5322 drafts that keep Bcc', async () => {
    const t = new ImapSmtpTransport({ account: account(), secret: { password: PASS } });
    const raw = await t.compose({ from: { address: 'me@example.com' }, to: ['a@example.org'], cc: [], bcc: ['b@example.org'], subject: 'Draft', text: 'body', attachments: [] }, true);
    const p = await simpleParser(raw);
    expect(p.bcc.value[0].address).toBe('b@example.org');
    expect(p.subject).toBe('Draft');
  });
});

// ── IMAP mapping with a scripted imapflow double ────────────────────────────

const RAW = Buffer.from([
  'From: Alice <alice@example.org>',
  'To: me@example.com',
  'Reply-To: alice.work@example.org',
  'Subject: Invoice',
  'Message-ID: <inv-1@example.org>',
  'In-Reply-To: <prev@example.com>',
  'References: <root@example.com> <prev@example.com>',
  'Date: Fri, 02 Oct 2026 10:00:00 +0000',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="b1"',
  '',
  '--b1',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>Hello <b>there</b></p><p>Pay by Friday</p>',
  '--b1',
  'Content-Type: application/pdf; name="inv.pdf"',
  'Content-Disposition: attachment; filename="inv.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('%PDF-1.4 fake').toString('base64'),
  '--b1--',
  '',
].join('\r\n'));

function fakeImapModule(log: string[], opts: { failLogin?: string } = {}) {
  class FakeImapFlow {
    usable = false;
    constructor(public options: any) { log.push(`new auth=${options.auth.pass ? 'pass' : 'token'} starttls=${options.doSTARTTLS}`); }
    on() { return this; }
    async connect() {
      if (opts.failLogin) throw Object.assign(new Error(`Authentication failed: LOGIN "me@example.com" "${opts.failLogin}"`), { authenticationFailed: true, response: `NO [AUTHENTICATIONFAILED] ${opts.failLogin}` });
      this.usable = true;
    }
    async list() {
      return [
        { path: 'INBOX', specialUse: '\\Inbox', flags: new Set() },
        { path: '[Gmail]/Drafts', specialUse: '\\Drafts', flags: new Set() },
        { path: '[Gmail]/All Mail', specialUse: '\\All', flags: new Set() },
        { path: '[Gmail]', flags: new Set(['\\Noselect']) },
        { path: 'Clients', flags: new Set() },
      ];
    }
    async getMailboxLock(folder: string, o: any) { log.push(`lock ${folder} ro=${!!o?.readOnly}`); return { release: () => log.push('release') }; }
    async search(c: any) { log.push(`search ${JSON.stringify(c)}`); return [3, 7, 9]; }
    async *fetch(uids: number[], q: any) {
      log.push(`fetch ${uids.join(',')} snippetBytes=${q.source?.maxLength}`);
      for (const uid of uids) {
        yield {
          uid, flags: new Set(uid === 9 ? [] : ['\\Seen']), size: RAW.length, internalDate: new Date('2026-10-02T10:00:00Z'),
          envelope: { subject: `S${uid}`, messageId: `<m${uid}@x>`, from: [{ name: 'A', address: 'alice@example.org' }], to: [{ address: 'me@example.com' }] },
          bodyStructure: { childNodes: [{ type: 'text/html' }, { type: 'application/pdf', disposition: 'attachment' }] },
          source: RAW,
        };
      }
    }
    async fetchOne(uid: string) { log.push(`fetchOne ${uid}`); return uid === '404' ? false : { uid: Number(uid), flags: new Set(['\\Seen']), envelope: {}, source: RAW, size: RAW.length }; }
    async messageFlagsAdd(uid: string, f: string[]) { log.push(`+flags ${uid} ${f.join(' ')}`); return true; }
    async messageFlagsRemove(uid: string, f: string[]) { log.push(`-flags ${uid} ${f.join(' ')}`); return true; }
    async messageMove(uid: string, to: string) { log.push(`move ${uid} ${to}`); return { uidMap: new Map([[Number(uid), 55]]) }; }
    async append(folder: string, raw: Buffer, flags: string[]) { log.push(`append ${folder} ${flags.join(' ')} bcc=${/^bcc:/im.test(raw.toString())}`); return { destination: folder, uid: 12 }; }
    async messageDelete(uid: string) { log.push(`delete ${uid}`); return true; }
    async logout() { log.push('logout'); }
    close() { log.push('close'); }
  }
  return async () => ({ ImapFlow: FakeImapFlow });
}

describe('IMAP mapping (imapflow double + real mailparser)', () => {
  it('lists newest first with flags, snippets and attachment hints', async () => {
    const log: string[] = [];
    const t = new ImapSmtpTransport({ account: account({ imap: { host: 'imap.example.com', port: 143, secure: false }, allowInsecure: false }), secret: { password: PASS }, loaders: { imapflow: fakeImapModule(log) } });
    const rows = await t.list({ unreadOnly: true, query: 'invoice', limit: 2 });
    expect(log[0]).toBe('new auth=pass starttls=true'); // port 143 to a remote host: STARTTLS mandatory
    expect(log).toContain('lock INBOX ro=true');
    expect(log).toContain('search {"seen":false,"text":"invoice"}');
    expect(log).toContain('fetch 7,9 snippetBytes=16384');
    expect(rows.map(r => r.id)).toEqual(['INBOX#9', 'INBOX#7']);
    expect(rows[0].flags).toEqual([]);
    expect(rows[1].flags).toEqual(['\\Seen']);
    expect(rows[0].snippet).toBe('Hello there Pay by Friday');
    expect(rows[0].hasAttachments).toBe(true);
    expect(rows[0].from).toEqual([{ name: 'A', address: 'alice@example.org' }]);
  });

  it('reads a message (HTML → text, threading headers, attachments) and its attachment bytes', async () => {
    const log: string[] = [];
    const t = new ImapSmtpTransport({ account: account(), secret: { password: PASS }, loaders: { imapflow: fakeImapModule(log) } });
    const m = await t.fetch('INBOX#9');
    expect(m!.subject).toBe('Invoice');
    expect(m!.text).toMatch(/Hello there/);
    expect(m!.text).toMatch(/Pay by Friday/);
    expect(m!.replyTo).toEqual([{ address: 'alice.work@example.org' }]);
    expect(m!.inReplyTo).toBe('<prev@example.com>');
    expect(m!.references).toEqual(['<root@example.com>', '<prev@example.com>']);
    expect(m!.messageId).toBe('<inv-1@example.org>');
    expect(m!.attachments).toEqual([{ index: 0, filename: 'inv.pdf', contentType: 'application/pdf', size: 13 }]);
    expect((await t.fetchAttachment('INBOX#9', { filename: 'inv.pdf' }))!.content.toString()).toBe('%PDF-1.4 fake');
    expect(await t.fetch('INBOX#404')).toBeNull();
    await expect(t.fetch('nonsense')).rejects.toThrow(/MAIL_NOT_FOUND/);
  });

  it('flags, moves to special folders, appends drafts with Bcc and deletes', async () => {
    const log: string[] = [];
    const t = new ImapSmtpTransport({ account: account(), secret: { password: PASS }, loaders: { imapflow: fakeImapModule(log) } });
    await t.flag('INBOX#9', { seen: true, flagged: false });
    expect(log).toContain('+flags 9 \\Seen');
    expect(log).toContain('-flags 9 \\Flagged');
    expect(await t.move('INBOX#9', 'archive')).toEqual({ folder: '[Gmail]/All Mail', id: '[Gmail]/All Mail#55' });
    expect(await t.move('INBOX#3', 'clients')).toEqual({ folder: 'Clients', id: 'Clients#55' });
    await expect(t.move('INBOX#3', 'trash')).rejects.toThrow(/no trash folder/);
    await expect(t.move('INBOX#3', '[Gmail]')).rejects.toThrow(/MAIL_FOLDER_NOT_FOUND/); // \Noselect
    const r = await t.appendDraft({ from: { address: 'me@example.com' }, to: ['a@example.org'], cc: [], bcc: ['b@example.org'], subject: 's', text: 't', attachments: [] });
    expect(r).toEqual({ folder: '[Gmail]/Drafts', uid: 12 });
    expect(log).toContain('append [Gmail]/Drafts \\Draft \\Seen bcc=true');
    expect(await t.appendSent({ from: { address: 'me@example.com' }, to: ['a@example.org'], cc: [], bcc: [], subject: 's', text: 't', attachments: [] })).toBeNull(); // no Sent folder
    await t.deleteMessage('[Gmail]/Drafts#12');
    expect(log).toContain('delete 12');
    await t.close();
    expect(log[log.length - 1]).toBe('logout');
  });

  it('a refused IMAP login is MAIL_AUTH_FAILED and scrubbed', async () => {
    const pw = 'imap-secret-pass-77';
    const t = new ImapSmtpTransport({ account: account(), secret: { password: pw }, loaders: { imapflow: fakeImapModule([], { failLogin: pw }) } });
    const err: any = await t.list({}).catch(e => e);
    expect(err.message).toMatch(/^\[MAIL_AUTH_FAILED\]/);
    expect(err.message).not.toContain(pw);
    const check = await t.test();
    expect(check.imap.ok).toBe(false);
    expect(JSON.stringify(check)).not.toContain(pw);
  });

  it('OAuth2 tokens go to XOAUTH2 auth; helpers', async () => {
    const log: string[] = [];
    const t = new ImapSmtpTransport({ account: account({ auth: 'xoauth2' }), secret: { accessToken: 'tok-123456' }, loaders: { imapflow: fakeImapModule(log) } });
    await t.folders();
    expect(log[0]).toMatch(/auth=token/);
    expect(htmlToText('<style>x{}</style><p>a&amp;b</p><br>c')).toBe('a&b\n\nc');
    // Decoded once: an escaped entity stays an entity, it never turns into markup.
    expect(htmlToText('<p>&amp;lt;script&amp;gt; &amp;amp;</p>')).toBe('&lt;script&gt; &amp;');
    expect(hasAttachmentPart({ childNodes: [{ childNodes: [{ disposition: 'ATTACHMENT' }] }] })).toBe(true);
    expect(hasAttachmentPart({ childNodes: [{ disposition: 'inline' }] })).toBe(false);
  });
});

describe('IMAP watch support (IDLE on its own connection)', () => {
  function watchModule(log: string[]) {
    const clients: any[] = [];
    class W extends EventEmitter {
      usable = false;
      constructor(public options: any) { super(); clients.push(this); log.push(`new idleFallback=${options.missingIdleCommand ?? '-'}`); }
      async connect() { this.usable = true; }
      async list() { return [{ path: 'INBOX', specialUse: '\\Inbox', flags: new Set() }]; }
      async status(p: string) { log.push(`status ${p}`); return { path: p, messages: 3, unseen: 1, uidNext: 10, uidValidity: 777n }; }
      async getMailboxLock(p: string) { log.push(`lock ${p}`); return { release: () => log.push('release') }; }
      idle() { log.push('idle'); return new Promise(() => {}); }
      async logout() { log.push('logout'); this.emit('close'); }
      close() { log.push('close'); }
    }
    return { loader: async () => ({ ImapFlow: W }), clients };
  }

  it('status maps counters; waitForNew resolves on a growing EXISTS and logs out', async () => {
    const log: string[] = [];
    const m = watchModule(log);
    const t = new ImapSmtpTransport({ account: account(), secret: { password: PASS }, loaders: { imapflow: m.loader } });
    expect(await t.status('inbox')).toEqual({ folder: 'INBOX', messages: 3, unseen: 1, uidNext: 10, uidValidity: '777' });
    const p = t.waitForNew('INBOX', { timeoutMs: 5000 });
    await new Promise(r => setTimeout(r, 20));
    const idleClient = m.clients[m.clients.length - 1];
    expect(idleClient).not.toBe(m.clients[0]); // a dedicated connection
    idleClient.emit('exists', { path: 'INBOX', count: 3, prevCount: 3 }); // not growing: ignored
    idleClient.emit('exists', { path: 'INBOX', count: 4, prevCount: 3 });
    expect(await p).toEqual({ changed: true, reason: 'exists' });
    expect(log).toContain('new idleFallback=NOOP');
    expect(log).toContain('idle');
    expect(log[log.length - 1]).toBe('logout');
    expect(await t.waitForNew('INBOX', { timeoutMs: 10 })).toEqual({ changed: false, reason: 'timeout' });
    const ac = new AbortController();
    ac.abort();
    expect(await t.waitForNew('INBOX', { signal: ac.signal })).toEqual({ changed: false, reason: 'abort' });
    await t.close();
  });
});
