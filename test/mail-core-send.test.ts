/**
 * mail_send end to end through ToolRegistry.execute (Sentinel in place) into a REAL
 * local SMTP server (smtp-server): what arrives is exactly what the human approved —
 * recipients (envelope and headers), subject, body, In-Reply-To / References for a
 * reply — and nothing arrives without an approval.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ToolContext } from '../src/tools/base.js';
import { MailAccountStore } from '../src/mail/accounts.js';
import { DraftStore } from '../src/mail/drafts.js';
import { InMemoryMailTransport } from '../src/mail/fake.js';
import { ImapSmtpTransport } from '../src/mail/imap-smtp.js';
import { MailService, setMailServiceForTests } from '../src/mail/service.js';
import type { OutgoingMail, SendResult } from '../src/mail/types.js';
import { Sentinel, setSentinelForTests } from '../src/sentinel/guard.js';
import { DEFAULT_SENTINEL_CONFIG } from '../src/config/agent-config.js';
import { getApprovalBroker, setInteractiveHuman } from '../src/control/approvals.js';
import { setApprovalMode } from '../src/security/permissions.js';

const require = createRequire(import.meta.url);
const { SMTPServer } = require('smtp-server');
const { simpleParser } = require('mailparser');

const PASS = 'local-smtp-app-password-42';

interface Received { from: string; rcpt: string[]; raw: Buffer }
let server: any;
let port = 0;
let received: Received[] = [];

beforeAll(async () => {
  server = new SMTPServer({
    secure: false, disabledCommands: ['STARTTLS'], allowInsecureAuth: true, logger: false,
    onAuth(auth: any, _s: any, cb: any) {
      return auth.username === 'me@example.com' && auth.password === PASS ? cb(null, { user: 'me' }) : cb(new Error('Invalid login'));
    },
    onData(stream: any, session: any, cb: any) {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        received.push({ from: session.envelope.mailFrom.address, rcpt: session.envelope.rcptTo.map((r: any) => r.address), raw: Buffer.concat(chunks) });
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

/** IMAP side in memory (no IMAP server here), SMTP side real. */
class LocalSmtpTransport extends InMemoryMailTransport {
  constructor(private readonly smtp: ImapSmtpTransport) { super({ account: 'work' }); }
  override send(msg: OutgoingMail): Promise<SendResult> { return this.smtp.send(msg); }
}

let tmp: string;
let mailbox: LocalSmtpTransport;
let registry: ToolRegistry;
let interactive = true;

beforeEach(async () => {
  received = [];
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-mail-send-'));
  const keyFile = path.join(tmp, '.vault-key');
  const vaultFile = path.join(tmp, 'vault.json');
  const accounts = new MailAccountStore({ file: path.join(tmp, 'mail-accounts.enc'), keyFile, vaultFile });
  await accounts.add({
    name: 'work', email: 'me@example.com', displayName: 'Me Myself', provider: 'custom', password: PASS, allowInsecure: true,
    imap: { host: '127.0.0.1', port: 1, secure: false }, smtp: { host: '127.0.0.1', port, secure: false },
  });
  const drafts = new DraftStore({ dir: path.join(tmp, 'drafts'), keyFile, vaultFile });
  mailbox = undefined as any;
  setMailServiceForTests(new MailService({
    accounts: () => accounts, drafts: () => drafts,
    factory: (account, secret) => (mailbox = new LocalSmtpTransport(new ImapSmtpTransport({ account, secret, timeoutMs: 5000 }))),
  }));
  interactive = true;
  setInteractiveHuman(true);
  setApprovalMode('manual');
  getApprovalBroker().reset();
  setSentinelForTests(new Sentinel({ config: () => ({ ...DEFAULT_SENTINEL_CONFIG }), audit: null, interactive: () => interactive, browser: () => null }));
  registry = new ToolRegistry();
});
afterEach(async () => {
  setMailServiceForTests(null);
  setSentinelForTests(null);
  setInteractiveHuman(false);
  setApprovalMode('manual');
  await fs.rm(tmp, { recursive: true, force: true });
});

function ctxAnswering(answers: string[]) {
  const prompts: string[] = [];
  const ctx: ToolContext = {
    cwd: tmp, sessionId: 's', transaction: {} as any, permissions: { evaluate: () => 'allow' } as any,
    askUser: async (p: string) => { prompts.push(p); return answers.shift() ?? 'no'; },
    emit: () => {},
  };
  return { ctx, prompts };
}

async function ensureMailbox(ctx: ToolContext): Promise<LocalSmtpTransport> {
  await registry.execute('mail_list', {}, ctx);
  return mailbox;
}

describe('mail_send → real SMTP server', () => {
  it('a reply: nothing is delivered on "no"; on "yes" exactly the approved message, threaded', async () => {
    const { ctx, prompts } = ctxAnswering(['no', 'yes']);
    const box = await ensureMailbox(ctx);
    const orig = box.deliver({
      from: 'Alice Example <alice@example.org>', to: ['me@example.com'], subject: 'Contract draft v2',
      text: 'Could you confirm by Friday?', messageId: '<contract-v2@example.org>', references: ['<contract-v1@example.org>'],
    });
    const dr = await registry.execute('mail_draft', { reply_to_id: orig, body: 'Confirmed — see you Friday.\nMe' }, ctx);
    expect(dr.isError).toBeFalsy();
    const draftId = (dr.metadata as any).mail.draftId;

    const denied = await registry.execute('mail_send', { draft_id: draftId }, ctx);
    expect(denied.content).toMatch(/SENTINEL_DENIED/);
    expect(received).toHaveLength(0);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('alice@example.org');
    expect(prompts[0]).toContain('Re: Contract draft v2');
    expect(prompts[0]).toContain('Confirmed — see you Friday.');

    const sent = await registry.execute('mail_send', { draft_id: draftId }, ctx);
    expect(sent.isError).toBeFalsy();
    expect(sent.content).toContain('✓ Sent "Re: Contract draft v2"');
    expect(prompts).toHaveLength(2);
    expect(received).toHaveLength(1);
    const got = received[0];
    expect(got.from).toBe('me@example.com');
    expect(got.rcpt).toEqual(['alice@example.org']);
    const p = await simpleParser(got.raw);
    expect(p.from.value).toEqual([{ address: 'me@example.com', name: 'Me Myself' }]);
    expect(p.to.value.map((a: any) => a.address)).toEqual(['alice@example.org']);
    expect(p.cc).toBeUndefined();
    expect(p.subject).toBe('Re: Contract draft v2');
    expect(p.text.trim()).toBe('Confirmed — see you Friday.\nMe');
    expect(p.inReplyTo).toBe('<contract-v2@example.org>');
    expect(p.references).toEqual(['<contract-v1@example.org>', '<contract-v2@example.org>']);
    expect(p.attachments).toEqual([]);

    // The same draft is never sent twice.
    const again = await registry.execute('mail_send', { draft_id: draftId }, ctx);
    expect(again.content).toMatch(/MAIL_ALREADY_SENT/);
    expect(received).toHaveLength(1);
  });

  it('a new message: To/Cc in headers, Bcc only in the envelope, attachment bytes intact', async () => {
    await fs.writeFile(path.join(tmp, 'notes.txt'), 'line 1\nline 2\n');
    const { ctx } = ctxAnswering(['yes']);
    const r = await registry.execute('mail_send', {
      to: 'Bob <bob@example.org>', cc: 'carol@example.org', bcc: 'audit@example.com',
      subject: 'Weekly notes', body: 'Hi all,\nnotes attached.', attachments: ['notes.txt'],
    }, ctx);
    expect(r.isError).toBeFalsy();
    expect(received).toHaveLength(1);
    expect(received[0].rcpt.sort()).toEqual(['audit@example.com', 'bob@example.org', 'carol@example.org']);
    const p = await simpleParser(received[0].raw);
    expect(p.to.value.map((a: any) => a.address)).toEqual(['bob@example.org']);
    expect(p.cc.value.map((a: any) => a.address)).toEqual(['carol@example.org']);
    expect(p.bcc).toBeUndefined();
    expect(received[0].raw.toString()).not.toContain('audit@example.com');
    expect(p.subject).toBe('Weekly notes');
    expect(p.inReplyTo).toBeUndefined();
    expect(p.attachments.map((a: any) => [a.filename, a.content.toString()])).toEqual([['notes.txt', 'line 1\nline 2\n']]);
  });

  it('never sends without approval: no human present (auto mode, headless) → refused, nothing delivered', async () => {
    interactive = false;
    setInteractiveHuman(false);
    setApprovalMode('auto');
    const { ctx, prompts } = ctxAnswering(['yes', 'yes']); // an auto-answering host
    const r = await registry.execute('mail_send', { to: 'bob@example.org', subject: 'x', body: 'y' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/SENTINEL_BLOCKED/);
    expect(prompts).toEqual([]);
    expect(received).toHaveLength(0);
  });

  it('a wrong app password fails cleanly without leaking it', async () => {
    const { ctx } = ctxAnswering(['yes']);
    const svc = new MailService({
      accounts: () => ({
        get: async () => ({ name: 'work', email: 'me@example.com', user: 'me@example.com' }),
        list: async () => [],
        credentials: async () => ({
          account: { name: 'work', email: 'me@example.com', user: 'me@example.com', provider: 'custom', auth: 'password', allowInsecure: true, imap: { host: '127.0.0.1', port: 1, secure: false }, smtp: { host: '127.0.0.1', port, secure: false }, createdAt: '', isDefault: true, hasPassword: true, hasToken: false },
          secret: { password: 'totally-wrong-pass-0001' },
        }),
      }) as any,
      factory: (account, secret) => new LocalSmtpTransport(new ImapSmtpTransport({ account, secret, timeoutMs: 5000 })),
    });
    setMailServiceForTests(svc);
    const r = await registry.execute('mail_send', { to: 'bob@example.org', subject: 'x', body: 'y' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/MAIL_AUTH_FAILED/);
    expect(r.content).not.toContain('totally-wrong-pass-0001');
    expect(r.content).not.toContain(Buffer.from('totally-wrong-pass-0001').toString('base64'));
    expect(received).toHaveLength(0);
  });
});
