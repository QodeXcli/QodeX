import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { InMemoryMailTransport } from '../src/mail/fake.js';
import { DraftStore, canonicalJson, isDraftId, newMessageId, type DraftInput } from '../src/mail/drafts.js';
import {
  describeOutgoingMail, formatOutgoingPrompt, parseAddressList, resolveOutgoingMail, summarizeOutgoingMail,
} from '../src/mail/outgoing.js';
import { asSpecialFolder, formatAddress, makeMessageId, parseMessageId } from '../src/mail/types.js';

let tmp: string;
let drafts: DraftStore;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-mail-model-'));
  drafts = new DraftStore({ dir: path.join(tmp, 'drafts'), keyFile: path.join(tmp, '.vault-key'), vaultFile: path.join(tmp, 'vault.json') });
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const baseDraft = (over: Partial<DraftInput> = {}): DraftInput => ({
  account: 'work', from: 'me@example.com', to: ['bob@example.org'], cc: [], bcc: [], subject: 'Hi', body: 'Hello Bob', attachments: [], ...over,
});

describe('message ids', () => {
  it('round-trips folder#uid, including folders with #', () => {
    expect(makeMessageId('INBOX', 7)).toBe('INBOX#7');
    expect(parseMessageId('INBOX#7')).toEqual({ folder: 'INBOX', uid: 7 });
    expect(parseMessageId('Projects/#1#42')).toEqual({ folder: 'Projects/#1', uid: 42 });
    expect(parseMessageId('12')).toEqual({ folder: 'INBOX', uid: 12 });
    expect(parseMessageId('INBOX#x')).toBeNull();
    expect(parseMessageId('#5')).toBeNull();
    expect(parseMessageId('A\r\nB#5')).toBeNull();
    expect(asSpecialFolder('Spam')).toBe('junk');
    expect(asSpecialFolder('Archive')).toBe('archive');
    expect(asSpecialFolder('Clients')).toBeNull();
    expect(formatAddress({ name: 'Bob', address: 'b@x.org' })).toBe('Bob <b@x.org>');
  });
});

describe('InMemoryMailTransport', () => {
  it('lists newest first with unread / query filters, reads, flags and moves', async () => {
    const t = new InMemoryMailTransport({ account: 'work' });
    const a = t.deliver({ from: 'Alice <alice@x.org>', subject: 'Invoice 42', text: 'Please pay', flags: ['\\Seen'] });
    const b = t.deliver({ from: 'bob@y.org', subject: 'Lunch?', text: 'Tomorrow at noon', attachments: [{ filename: 'menu.pdf', contentType: 'application/pdf', content: 'PDF' }] });
    const all = await t.list({});
    expect(all.map(m => m.id)).toEqual([b, a]);
    expect(all[0].hasAttachments).toBe(true);
    expect((await t.list({ unreadOnly: true })).map(m => m.id)).toEqual([b]);
    expect((await t.search('invoice')).map(m => m.id)).toEqual([a]);
    const full = await t.fetch(b);
    expect(full!.text).toBe('Tomorrow at noon');
    expect(full!.attachments).toEqual([{ index: 0, filename: 'menu.pdf', contentType: 'application/pdf', size: 3 }]);
    expect((await t.fetchAttachment(b, { filename: 'menu.pdf' }))!.content.toString()).toBe('PDF');
    await t.flag(b, { seen: true, flagged: true });
    expect((await t.fetch(b))!.flags.sort()).toEqual(['\\Flagged', '\\Seen']);
    const moved = await t.move(a, 'archive');
    expect(moved.folder).toBe('Archive');
    expect(await t.fetch(a)).toBeNull();
    expect((await t.fetch(moved.id!))!.subject).toBe('Invoice 42');
    await expect(t.move(b, 'Nowhere')).rejects.toThrow(/MAIL_FOLDER_NOT_FOUND/);
    expect((await t.folders()).find(f => f.specialUse === 'drafts')!.path).toBe('Drafts');
  });

  it('appends drafts unless the account has no Drafts folder', async () => {
    const t = new InMemoryMailTransport();
    const r = await t.appendDraft({ from: { address: 'me@x.org' }, to: ['a@b.co'], cc: [], bcc: [], subject: 's', text: 't', attachments: [] });
    expect(r!.folder).toBe('Drafts');
    expect((await t.list({ folder: 'drafts' }))[0].flags).toContain('\\Draft');
    const n = new InMemoryMailTransport({ noDrafts: true });
    expect(await n.appendDraft({ from: { address: 'me@x.org' }, to: ['a@b.co'], cc: [], bcc: [], subject: 's', text: 't', attachments: [] })).toBeNull();
  });
});

describe('InMemoryMailTransport watch support', () => {
  it('status counts and waitForNew wakes on delivery, times out, aborts and ends on close', async () => {
    const t = new InMemoryMailTransport();
    t.deliver({ from: 'a@x.org', subject: 'old', flags: ['\\Seen'] });
    expect(await t.status('inbox')).toEqual({ folder: 'INBOX', messages: 1, unseen: 0, uidNext: 2, uidValidity: '1' });
    const waiting = t.waitForNew('INBOX', { timeoutMs: 5000 });
    t.deliver({ from: 'b@x.org', subject: 'new' });
    expect(await waiting).toEqual({ changed: true, reason: 'exists' });
    expect((await t.list({ sinceUid: 1 })).map(m => m.subject)).toEqual(['new']);
    expect(await t.waitForNew('INBOX', { timeoutMs: 10 })).toEqual({ changed: false, reason: 'timeout' });
    const ac = new AbortController();
    const aborted = t.waitForNew('INBOX', { signal: ac.signal });
    ac.abort();
    expect(await aborted).toEqual({ changed: false, reason: 'abort' });
    const other = t.waitForNew('Archive', { timeoutMs: 5000 });
    t.deliver({ from: 'c@x.org' }); // INBOX, not Archive
    const closing = t.close();
    expect(await other).toEqual({ changed: false, reason: 'closed' });
    await closing;
  });
});

describe('DraftStore', () => {
  it('creates immutable signed drafts with a pre-assigned Message-ID', async () => {
    const d = await drafts.create(baseDraft());
    expect(isDraftId(d.id)).toBe(true);
    expect(d.messageId).toMatch(/^<qodex\..+@example\.com>$/);
    expect(await drafts.get(d.id)).toEqual(d);
    if (process.platform !== 'win32') expect((await fs.stat(path.join(drafts.dir, `${d.id}.json`))).mode & 0o777).toBe(0o600);
    expect((await drafts.list('work')).map(x => x.id)).toEqual([d.id]);
    expect(await drafts.list('other')).toEqual([]);
  });

  it('refuses a draft edited or forged on disk', async () => {
    const d = await drafts.create(baseDraft({ reply: { id: 'INBOX#1', messageId: '<m1@x>', threadSender: 'bob@example.org', references: ['<m1@x>'], subject: 'Q', injectionFlagged: true } }));
    const file = path.join(drafts.dir, `${d.id}.json`);
    const doc = JSON.parse(await fs.readFile(file, 'utf-8'));
    doc.draft.to = ['attacker@evil.example'];
    await fs.writeFile(file, JSON.stringify(doc));
    await expect(drafts.get(d.id)).rejects.toThrow(/MAIL_DRAFT_TAMPERED/);
    // Clearing the injection flag is tampering too.
    const d2 = await drafts.create(baseDraft({ reply: { id: 'INBOX#1', messageId: '<m1@x>', threadSender: 'bob@example.org', references: [], subject: 'Q', injectionFlagged: true } }));
    const f2 = path.join(drafts.dir, `${d2.id}.json`);
    const doc2 = JSON.parse(await fs.readFile(f2, 'utf-8'));
    doc2.draft.reply.injectionFlagged = false;
    await fs.writeFile(f2, JSON.stringify(doc2));
    await expect(drafts.get(d2.id)).rejects.toThrow(/MAIL_DRAFT_TAMPERED/);
    // A forged file with a made-up MAC.
    await fs.writeFile(path.join(drafts.dir, 'd_forged123.json'), JSON.stringify({ format: 'qodex-mail-draft', version: 1, draft: { ...d, id: 'd_forged123' }, mac: 'ab'.repeat(32) }));
    await expect(drafts.get('d_forged123')).rejects.toThrow(/MAIL_DRAFT_TAMPERED/);
    // Tampered drafts are skipped by list().
    expect(await drafts.list()).toEqual([]);
    // Ids are validated (no path traversal).
    await expect(drafts.get('../../etc/passwd')).rejects.toThrow(/not a draft id/);
  });

  it('marks a draft sent exactly once', async () => {
    const d = await drafts.create(baseDraft());
    expect(await drafts.markSent(d.id, { messageId: d.messageId, accepted: ['bob@example.org'] })).toBe(true);
    expect(await drafts.markSent(d.id, { messageId: d.messageId, accepted: [] })).toBe(false);
    expect((await drafts.sentInfo(d.id))!.accepted).toEqual(['bob@example.org']);
  });

  it('canonicalJson is key-order independent', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }));
    expect(newMessageId('x@sub.example.com')).toMatch(/@sub\.example\.com>$/);
  });
});

describe('describeOutgoingMail (pure helper for Sentinel)', () => {
  it('describes a new message from fields', () => {
    const d = describeOutgoingMail({ to: 'Bob <bob@example.org>, carol@example.org', bcc: 'boss@example.com', subject: 'Report', body: 'See attached', attachments: ['/tmp/r.pdf'] });
    expect(d.to).toEqual(['bob@example.org', 'carol@example.org']);
    expect(d.bcc).toEqual(['boss@example.com']);
    expect(d.isReplyTo).toBeUndefined();
    expect(d.attachments).toEqual([{ name: 'r.pdf', path: '/tmp/r.pdf', fromDisk: true }]);
    expect(d.extraRecipients).toEqual(['bob@example.org', 'carol@example.org', 'boss@example.com']);
    expect(d.problems).toEqual([]);
    expect(summarizeOutgoingMail(d)).toContain('bcc boss@example.com');
    expect(summarizeOutgoingMail(d)).toContain('new message');
    expect(formatOutgoingPrompt(d).join('\n')).toContain('Body (12 chars): See attached');
  });

  it('describes a same-thread reply from a draft, and flags extra recipients', async () => {
    const reply = { id: 'INBOX#3', messageId: '<orig@x.org>', threadSender: 'alice@x.org', references: ['<orig@x.org>'], subject: 'Q', injectionFlagged: false };
    const d1 = await drafts.create(baseDraft({ to: ['alice@x.org'], subject: 'Re: Q', reply }));
    const plain = describeOutgoingMail({ draft_id: d1.id }, d1);
    expect(plain.isReplyTo).toEqual({ account: 'work', messageId: '<orig@x.org>', threadSender: 'alice@x.org', injectionFlagged: false });
    expect(plain.extraRecipients).toEqual([]);
    expect(plain.from).toBe('me@example.com');
    const d2 = await drafts.create(baseDraft({ to: ['alice@x.org'], cc: ['eve@evil.example'], subject: 'Re: Q', reply: { ...reply, injectionFlagged: true } }));
    const wide = describeOutgoingMail({ draft_id: d2.id }, d2);
    expect(wide.extraRecipients).toEqual(['eve@evil.example']);
    expect(wide.isReplyTo!.injectionFlagged).toBe(true);
    expect(formatOutgoingPrompt(wide).join('\n')).toMatch(/outside the thread: eve@evil\.example/);
    expect(summarizeOutgoingMail(wide)).toContain('flagged for prompt injection');
  });

  it('reports problems instead of guessing', async () => {
    const d = await drafts.create(baseDraft());
    expect(describeOutgoingMail({ draft_id: d.id, to: 'x@y.co' }, d).problems[0]).toMatch(/either draft_id or the message fields/);
    expect(describeOutgoingMail({ draft_id: d.id, account: 'other' }, d).problems[0]).toMatch(/belongs to account "work"/);
    expect(describeOutgoingMail({ draft_id: d.id }).problems).toEqual([`draft ${d.id} is not loaded`]);
    expect(describeOutgoingMail({ subject: 'x' }).problems).toContain('no recipient');
    expect(describeOutgoingMail({ to: 'not-an-address', body: 'x' }).problems[0]).toMatch(/not an email address/);
    expect(describeOutgoingMail({ to: 'a@b.co', subject: 'a\r\nBcc: x@y.z', body: 'x' }).problems).toContain('the subject contains a line break');
    expect(describeOutgoingMail({ to: 'a@b.co' }).problems).toContain('empty message (no subject and no body)');
    expect(parseAddressList(['a@b.co; c@d.co', 'a@b.co'])).toEqual(['a@b.co', 'c@d.co']);
  });

  it('resolveOutgoingMail loads the draft and turns store errors into problems', async () => {
    const d = await drafts.create(baseDraft());
    const ok = await resolveOutgoingMail({ draft_id: d.id }, { drafts });
    expect(ok.draft!.id).toBe(d.id);
    expect(ok.description.to).toEqual(['bob@example.org']);
    expect(ok.description.problems).toEqual([]);
    const missing = await resolveOutgoingMail({ draft_id: 'd_missing123' }, { drafts });
    expect(missing.description.problems[0]).toMatch(/MAIL_DRAFT_NOT_FOUND/);
    const bad = await resolveOutgoingMail({ draft_id: '../x' }, { drafts });
    expect(bad.description.problems[0]).toMatch(/not a draft id/);
  });
});
