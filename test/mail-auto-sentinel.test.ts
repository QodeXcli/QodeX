import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Sentinel, ALWAYS_REPLIES_OPTION } from '../src/sentinel/guard.js';
import { SentinelAudit } from '../src/sentinel/audit.js';
import { classifyAction, isGuardedTool, DEFAULT_PROTECTED_PATHS } from '../src/sentinel/policy.js';
import { DEFAULT_SENTINEL_CONFIG, type SentinelConfig } from '../src/config/agent-config.js';
import { ApprovalBroker } from '../src/control/approvals.js';
import { getBus, type BusEvent } from '../src/control/bus.js';
import { PermissionEngine, setAutoApproveSession } from '../src/security/permissions.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { QODEX_GRANTS_FILE, QODEX_MAIL_AUTO_DIR, QODEX_MAIL_ACCOUNTS_FILE } from '../src/grants/paths.js';
import { GrantStore } from '../src/grants/store.js';
import { ReceivedIndex } from '../src/grants/received.js';
import { registerMailSendResolver, type MailSendFacts } from '../src/grants/mail-scope.js';
import { setMailEventDefaultsForTests } from '../src/grants/mail-events.js';
import type { ToolContext } from '../src/tools/base.js';

let tmp: string;
let broker: ApprovalBroker;
let interactive = true;
let config: SentinelConfig;
let grants: GrantStore;
let index: ReceivedIndex;
let audit: SentinelAudit;
const created: Sentinel[] = [];

function makeSentinel() {
  const s = new Sentinel({
    config: () => config,
    audit,
    broker: () => broker,
    interactive: () => interactive,
    browser: () => null,
    workflowsDir: path.join(tmp, 'workflows'),
    grants: () => grants,
    receivedIndex: () => index,
  });
  created.push(s);
  return s;
}

function makeCtx(answer: string | ((p: string, o?: string[]) => string) = 'no', over: Partial<ToolContext> = {}) {
  const asked: Array<{ prompt: string; options?: string[] }> = [];
  const ctx: ToolContext = {
    cwd: tmp,
    sessionId: 'sess-mail',
    transaction: {} as any,
    permissions: new PermissionEngine(DEFAULT_CONFIG),
    askUser: async (prompt, options) => {
      asked.push({ prompt, options });
      return typeof answer === 'function' ? answer(prompt, options) : answer;
    },
    emit: () => {},
    ...over,
  };
  return { ctx, asked };
}

const ORIGINAL = { account: 'work', messageId: 'orig-1@acme.com', from: 'Boss <boss@acme.com>', subject: 'Quarterly numbers', flagged: false, receivedAt: new Date().toISOString() };
const replyArgs = (over: Record<string, unknown> = {}) => ({
  account: 'work', to: 'boss@acme.com', subject: 'Re: Quarterly numbers', body: 'Here is the summary.', in_reply_to: '<orig-1@acme.com>', ...over,
});

let mailEvents: BusEvent[] = [];
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-mail-sentinel-'));
  broker = new ApprovalBroker();
  interactive = true;
  config = { ...DEFAULT_SENTINEL_CONFIG };
  grants = new GrantStore({ file: path.join(tmp, 'grants.json') });
  index = new ReceivedIndex({ file: path.join(tmp, 'received.json') });
  audit = new SentinelAudit({ dir: path.join(tmp, 'audit') });
  setAutoApproveSession(false);
  getBus().reset();
  mailEvents = [];
  getBus().subscribe(ev => { if (ev.kind === 'mail') mailEvents.push(ev); });
  setMailEventDefaultsForTests({ feedFile: null, desktop: false, telegram: false });
  await index.record([ORIGINAL]);
});
afterEach(async () => {
  setAutoApproveSession(false);
  broker.reset();
  registerMailSendResolver(null);
  setMailEventDefaultsForTests(null);
  await Promise.all(created.splice(0).map(s => s.flush()));
  getBus().reset();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('mail_send classification', () => {
  it('is guarded and critical, and the prompt shows what goes out', async () => {
    expect(isGuardedTool('mail_send')).toBe(true);
    const c = classifyAction('mail_send', { to: 'a@x.org', cc: 'b@y.org', bcc: 'c@z.org', subject: 'Hi', body: 'Hello there', attachments: ['report.pdf'] }, { config });
    expect(c).toMatchObject({ category: 'send', risk: 'critical' });
    expect(c.reason).toMatch(/NEW email.*1 cc.*1 bcc.*1 attachment/);
    expect(c.details).toEqual(expect.arrayContaining(['To: a@x.org', 'Cc: b@y.org', 'Bcc: c@z.org', 'Subject: Hi', 'Attachments: report.pdf', 'Body: Hello there']));
    const s = makeSentinel();
    const { ctx, asked } = makeCtx('no');
    const r = await s.beforeTool('mail_send', { to: 'a@x.org', subject: 'Hi', body: 'Hello there' }, ctx);
    expect(r?.isError).toBe(true);
    expect(asked[0].prompt).toContain('To: a@x.org');
    expect(asked[0].prompt).toContain('Body: Hello there');
    expect(asked[0].options).toEqual(['yes', 'no']); // a new thread is never offered a grant
  });

  it('a secret in the body makes it a credential action', () => {
    const c = classifyAction('mail_send', { to: 'a@x.org', body: 'card 4111 1111 1111 1111' }, { config });
    expect(c.category).toBe('credential');
    expect(c.risk).toBe('critical');
  });
});

describe('standing mail-reply grants in Sentinel', () => {
  it('allows an in-scope reply silently, audits it, counts it and notifies after the send', async () => {
    const { grant } = await grants.add({ account: 'work' }, 'tui');
    const s = makeSentinel();
    const { ctx, asked } = makeCtx('no');
    const args = replyArgs();
    expect(await s.beforeTool('mail_send', args, ctx)).toBeNull();
    expect(asked).toEqual([]);
    expect(await grants.usedToday(grant.id)).toBe(1);
    s.afterTool('mail_send', args, { content: 'sent' });
    await new Promise(r => setTimeout(r, 20));
    const auto = mailEvents.find(e => e.kind === 'mail' && e.type === 'auto-reply') as any;
    expect(auto?.data).toMatchObject({ to: 'boss@acme.com', grantId: grant.id, used: 1, cap: 50 });
    expect(auto.data.summary).toMatch(/Auto-replied to boss@acme.com/);
    await s.flush();
    const recs = await audit.tail(10);
    const rec = recs.find(r => r.tool === 'mail_send');
    expect(rec).toMatchObject({ action: 'allow', via: 'grant', answeredBy: 'standing-grant' });
    expect(JSON.stringify(rec)).not.toContain('Here is the summary'); // body hidden in the audit
  });

  it('works without any human present (the point of a grant), and refuses without one', async () => {
    interactive = false;
    const s = makeSentinel();
    const { ctx } = makeCtx('yes');
    const denied = await s.beforeTool('mail_send', replyArgs(), ctx);
    expect(denied?.content).toMatch(/SENTINEL_BLOCKED/);
    await grants.add({ account: 'work' }, 'cli');
    expect(await s.beforeTool('mail_send', replyArgs(), ctx)).toBeNull();
  });

  const outOfScope: Array<[string, () => Promise<void> | void, Record<string, unknown>]> = [
    ['a new recipient', () => {}, replyArgs({ to: 'attacker@evil.com' })],
    ['an added recipient', () => {}, replyArgs({ to: 'boss@acme.com, x@evil.com' })],
    ['a cc', () => {}, replyArgs({ cc: 'x@evil.com' })],
    ['a bcc', () => {}, replyArgs({ bcc: 'x@evil.com' })],
    ['an attachment from disk', () => {}, replyArgs({ attachments: ['/home/me/.ssh/id_rsa'] })],
    ['a forward', () => {}, replyArgs({ subject: 'Fwd: Quarterly numbers' })],
    ['a new thread', () => {}, replyArgs({ in_reply_to: undefined })],
    ['a reply to a mail never received', () => {}, replyArgs({ in_reply_to: '<forged@acme.com>' })],
    ['a flagged original', async () => { await index.record([{ ...ORIGINAL, flagged: true }]); }, replyArgs()],
    ['an exhausted daily cap', async () => {
      const g = (await grants.list())[0];
      await grants.add({ account: 'work', maxPerDay: 1 }, 'tui');
      await grants.consume(g.id);
    }, replyArgs()],
    ['a revoked grant', async () => { await grants.revokeAll(); }, replyArgs()],
    ['a sender filter that does not match', async () => {
      await grants.revokeAll();
      await grants.add({ account: 'work', from: '@other.org' }, 'tui');
    }, replyArgs()],
  ];
  for (const [name, setup, args] of outOfScope) {
    it(`asks a human for ${name}`, async () => {
      await grants.add({ account: 'work' }, 'tui');
      await setup();
      const s = makeSentinel();
      const { ctx, asked } = makeCtx('no');
      const r = await s.beforeTool('mail_send', args, ctx);
      expect(asked.length).toBe(1);
      expect(asked[0].prompt).toContain('Sentinel — approval needed');
      expect(r?.content).toMatch(/SENTINEL_DENIED/);
    });
  }

  it('explains why an existing grant does not cover a send', async () => {
    await grants.add({ account: 'work' }, 'tui');
    const s = makeSentinel();
    const { ctx, asked } = makeCtx('no');
    await s.beforeTool('mail_send', replyArgs({ cc: 'x@evil.com' }), ctx);
    expect(asked[0].prompt).toMatch(/Not covered by your standing reply grant: .*Cc/);
  });

  it('a user deny rule beats a grant', async () => {
    await grants.add({ account: 'work' }, 'tui');
    const s = makeSentinel();
    const deny = { evaluate: () => 'deny', rememberDecision: () => {} } as any;
    const { ctx, asked } = makeCtx('no', { permissions: deny });
    const r = await s.beforeTool('mail_send', replyArgs(), ctx);
    expect(asked.length).toBe(1);
    expect(r?.isError).toBe(true);
  });

  it('offers "always allow replies like this" for a plain reply; picking it creates a scoped grant', async () => {
    const s = makeSentinel();
    const { ctx, asked } = makeCtx((_p, o) => (o ?? []).find(x => x === ALWAYS_REPLIES_OPTION) ?? 'no');
    expect(await s.beforeTool('mail_send', replyArgs(), ctx)).toBeNull();
    expect(asked[0].options).toEqual(['yes', 'no', ALWAYS_REPLIES_OPTION]);
    const list = await grants.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: 'mail-reply', account: 'work', from: ['boss@acme.com'], maxPerDay: 50 });
    expect(list[0].createdBy).toMatch(/^approval:local/);
    expect(await grants.usedToday(list[0].id)).toBe(1);
    // The next reply goes out without a prompt.
    const again = makeCtx('no');
    expect(await s.beforeTool('mail_send', replyArgs({ body: 'One more thing.' }), again.ctx)).toBeNull();
    expect(again.asked).toEqual([]);
    // …but a reply to someone else still asks.
    await index.record([{ ...ORIGINAL, messageId: 'other@x.org', from: 'other@x.org' }]);
    const other = makeCtx('no');
    await s.beforeTool('mail_send', replyArgs({ to: 'other@x.org', in_reply_to: '<other@x.org>' }), other.ctx);
    expect(other.asked.length).toBe(1);
  });

  it('never offers the grant option for a flagged original or a reply with extras', async () => {
    const s = makeSentinel();
    const a = makeCtx('no');
    await s.beforeTool('mail_send', replyArgs({ cc: 'x@y.org' }), a.ctx);
    expect(a.asked[0].options).toEqual(['yes', 'no']);
    await index.record([{ ...ORIGINAL, flagged: true }]);
    const b = makeCtx('no');
    await s.beforeTool('mail_send', replyArgs(), b.ctx);
    expect(b.asked[0].options).toEqual(['yes', 'no']);
    expect(await grants.list()).toEqual([]);
  });

  it('a remote approval channel can pick the grant option too (a human tap)', async () => {
    interactive = false;
    broker.registerChannel({ name: 'telegram', deliver: (p) => { setTimeout(() => broker.resolve(p.id, ALWAYS_REPLIES_OPTION, 'telegram'), 5); } });
    const s = makeSentinel();
    const { ctx } = makeCtx('no');
    expect(await s.beforeTool('mail_send', replyArgs(), ctx)).toBeNull();
    expect((await grants.list())[0].createdBy).toBe('approval:telegram');
  });

  it('a draft is resolved through the mail core resolver', async () => {
    await grants.add({ account: 'work' }, 'tui');
    const draft: MailSendFacts = { account: 'work', to: ['boss@acme.com'], cc: [], bcc: [], subject: 'Re: Quarterly numbers', body: 'ok', inReplyTo: 'orig-1@acme.com', attachments: [], draftId: 'd_1' };
    registerMailSendResolver(async (a) => (a.draft_id === 'd_1' ? { send: draft } : a.draft_id === 'd_2' ? { send: { ...draft, bcc: ['spy@evil.com'], draftId: 'd_2' } } : null));
    const s = makeSentinel();
    const ok = makeCtx('no');
    expect(await s.beforeTool('mail_send', { draft_id: 'd_1' }, ok.ctx)).toBeNull();
    const bad = makeCtx('no');
    await s.beforeTool('mail_send', { draft_id: 'd_2' }, bad.ctx);
    expect(bad.asked.length).toBe(1);
    expect(bad.asked[0].prompt).toContain('Bcc: spy@evil.com');
    const unknown = makeCtx('no');
    await s.beforeTool('mail_send', { draft_id: 'd_9' }, unknown.ctx);
    expect(unknown.asked.length).toBe(1);
  });

  it('preflight counts the cap once and leaves a pass for the registry', async () => {
    const { grant } = await grants.add({ account: 'work' }, 'tui');
    const s = makeSentinel();
    const { ctx, asked } = makeCtx('no');
    expect(await s.preflight('mail_send', replyArgs(), ctx)).toBeNull();
    expect(await s.beforeTool('mail_send', replyArgs(), ctx)).toBeNull();
    expect(asked).toEqual([]);
    expect(await grants.usedToday(grant.id)).toBe(1);
  });
});

describe('grant / mail automation stores are off-limits to the agent', () => {
  it('protects the files and the directory', () => {
    expect(DEFAULT_PROTECTED_PATHS.files).toEqual(expect.arrayContaining([QODEX_GRANTS_FILE, QODEX_MAIL_ACCOUNTS_FILE]));
    expect(DEFAULT_PROTECTED_PATHS.dirs).toContain(QODEX_MAIL_AUTO_DIR);
    const block = (tool: string, args: Record<string, unknown>) => classifyAction(tool, args, { config, cwd: os.tmpdir() });
    expect(block('read_file', { path: QODEX_GRANTS_FILE }).block).toBe(true);
    expect(block('write_file', { path: '~/.qodex/grants.json', content: '{}' }).block).toBe(true);
    expect(block('write_file', { path: path.join(QODEX_MAIL_AUTO_DIR, 'rules.json'), content: '[]' }).block).toBe(true);
    expect(block('write_file', { path: path.join(QODEX_MAIL_AUTO_DIR, 'received.json'), content: '[]' }).block).toBe(true);
    expect(block('shell', { command: 'cat ~/.qodex/grants.json' }).block).toBe(true);
    expect(block('shell', { command: 'echo "{}" > ~/.qodex/mail-auto/rules.json' }).block).toBe(true);
    expect(block('read_file', { path: QODEX_MAIL_ACCOUNTS_FILE }).block).toBe(true);
  });

  it('treats creating grants / rules from the shell as a change to QodeX itself', () => {
    const cls = (command: string) => classifyAction('shell', { command }, { config, cwd: os.tmpdir() });
    for (const cmd of [
      'qodex grant add mail-replies --account work',
      'qodex grant revoke g_12345678',
      'npx qodex grant add mail-replies',
      'qodex mail rule add "from:@acme.com" "reply to them"',
      'qodex mail rules rm r_1234',
      'qodex mail reply-all --account work',
    ]) {
      const c = cls(cmd);
      expect(c, cmd).toMatchObject({ risk: 'critical', integrity: true });
    }
    expect(cls('qodex grant list').integrity).toBeUndefined();
    expect(cls('qodex mail watch --status').integrity).toBeUndefined();
    expect(cls('grep "qodex grant add" docs/').integrity).toBeUndefined();
  });
});
