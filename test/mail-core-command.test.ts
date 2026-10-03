import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Command } from 'commander';
import { buildMailCommand, parseHostPort, type MailCommandIO } from '../src/mail/command.js';
import { MailAccountStore } from '../src/mail/accounts.js';
import { MailService } from '../src/mail/service.js';
import { InMemoryMailTransport } from '../src/mail/fake.js';

const PW = 'abcd-efgh-ijkl-mnop';

let tmp: string;
let store: MailAccountStore;
let out: string[];
let err: string[];
let fake: InMemoryMailTransport;

function run(args: string[], io: Partial<MailCommandIO> = {}, opts: { root?: boolean } = {}) {
  const cmd = buildMailCommand({
    accounts: () => store,
    service: () => new MailService({ accounts: () => store, factory: () => fake }),
    io: { out: l => out.push(l), err: l => err.push(l), isTTY: () => false, readStdin: async () => '', ...io },
  });
  cmd.exitOverride();
  if (!opts.root) return cmd.parseAsync(args, { from: 'user' });
  // Mounted like src/index.ts: the root also defines --json and -p.
  const root = new Command('qodex').option('-p, --print <prompt>').option('--json').exitOverride();
  root.addCommand(cmd);
  return root.parseAsync(['mail', ...args], { from: 'user' });
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-mail-cmd-'));
  store = new MailAccountStore({ file: path.join(tmp, 'mail-accounts.enc'), keyFile: path.join(tmp, '.vault-key'), vaultFile: path.join(tmp, 'vault.json') });
  fake = new InMemoryMailTransport({ account: 'personal' });
  out = [];
  err = [];
  process.exitCode = 0;
});
afterEach(async () => {
  process.exitCode = 0;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('qodex mail', () => {
  it('adds from stdin with the preset detected from the address; list never shows the password', async () => {
    await run(['add', 'personal', '--email', 'me@gmail.com', '--display-name', 'Me'], { readStdin: async () => `${PW}\nignored\n` });
    expect(err).toEqual([]);
    expect(out[0]).toBe('✓ Saved mail account "personal" (default):');
    expect(out.join('\n')).toContain('IMAP imap.gmail.com:993 (TLS) · SMTP smtp.gmail.com:465 (TLS)');
    expect((await store.credentials('personal'))!.secret.password).toBe(PW);

    out = [];
    await run(['list']);
    expect(out.join('\n')).toContain('● personal (default) — Me <me@gmail.com>');
    out.push(...err);
    await run(['list', '--json'], {}, { root: true }); // --json after the subcommand, root also defines it
    const json = JSON.parse(out[out.length - 1]);
    expect(json[0]).toMatchObject({ name: 'personal', email: 'me@gmail.com', provider: 'gmail', auth: 'password', default: true });
    expect(out.join('\n')).not.toContain(PW);
    expect(await fs.readFile(store.file, 'utf-8')).not.toContain(PW);
  });

  it('on a terminal: asks for the address, explains app passwords and reads the password hidden', async () => {
    const prompts: string[] = [];
    await run(['add', 'icloud'], {
      isTTY: () => true,
      readLine: async (p) => { prompts.push(p); return 'me@icloud.com'; },
      readHidden: async (p) => { prompts.push(p); return PW; },
    });
    expect(err).toEqual([]);
    expect(prompts[0]).toBe('Email address: ');
    expect(prompts[1]).toBe('App password for me@icloud.com (hidden): ');
    const text = out.join('\n');
    expect(text).toContain('needs an APP PASSWORD');
    expect(text).toContain('account.apple.com');
    expect(text).toContain('App Password');
    expect(text).not.toContain(PW);
    expect((await store.get('icloud'))!.provider).toBe('icloud');
  });

  it('custom servers, OAuth2 tokens and the local bridge', async () => {
    await run(['add', 'corp', '--email', 'me@corp.example', '--provider', 'custom', '--imap', 'mail.corp.example:143', '--smtp', 'mail.corp.example:587', '--user', 'me', '--oauth-token', '--default'], { readStdin: async () => 'ya29.token-value\n' });
    expect(err).toEqual([]);
    const corp = (await store.get('corp'))!;
    expect(corp).toMatchObject({ provider: 'custom', user: 'me', auth: 'xoauth2', isDefault: true });
    expect(corp.imap).toEqual({ host: 'mail.corp.example', port: 143, secure: false });
    expect(corp.smtp).toEqual({ host: 'mail.corp.example', port: 587, secure: false });
    expect(out.join('\n')).toContain('mail.corp.example:143 (STARTTLS)');
    out = [];
    await run(['add', 'proton', '--email', 'me@proton.me'], { readStdin: async () => 'bridge-pass\n' });
    expect(out.join('\n')).toContain('127.0.0.1:1143 (plain, local only)');
    // A custom account without servers on a pipe is an error.
    err = [];
    await run(['add', 'x', '--email', 'x@unknown.example'], { readStdin: async () => 'p\n' });
    expect(err[0]).toMatch(/custom account needs both an IMAP and an SMTP host/);
    expect(process.exitCode).toBe(1);
  });

  it('errors never echo the password', async () => {
    await run(['add', 'bad', '--email', 'nope'], { readStdin: async () => `${PW}\n` });
    expect(err[0]).toMatch(/--email|not an email/);
    await run(['add', 'bad2', '--email', 'a@gmail.com', '--provider', 'bogus'], { readStdin: async () => `${PW}\n` });
    expect(err.join('\n')).toContain('unknown provider "bogus"');
    await run(['add', 'bad3', '--email', 'a@gmail.com'], { readStdin: async () => '\n' });
    expect(err.join('\n')).toContain('no app password was given');
    expect([...out, ...err].join('\n')).not.toContain(PW);
  });

  it('test: signs in through the transport; failures are scrubbed and set the exit code', async () => {
    await run(['add', 'personal', '--email', 'me@gmail.com'], { readStdin: async () => `${PW}\n` });
    out = [];
    await run(['test']);
    expect(out.join('\n')).toContain('✓ IMAP signed in');
    expect(out.join('\n')).toContain('✓ SMTP signed in');
    expect(process.exitCode).toBe(0);
    expect(fake.closed).toBe(true);

    out = [];
    fake = new InMemoryMailTransport({ failWith: new Error(`535 Authentication failed for ${PW} / ${Buffer.from(PW).toString('base64')}`) });
    await run(['test', 'personal', '--json'], {}, { root: true });
    const r = JSON.parse(out.join('\n'));
    expect(r.imap.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(PW);
    expect(JSON.stringify(r)).not.toContain(Buffer.from(PW).toString('base64'));
    expect(process.exitCode).toBe(1);

    process.exitCode = 0;
    out = [];
    await run(['test', 'personal']);
    expect(out.join('\n')).toContain('Sign-in was refused');
    expect(out.join('\n')).toContain('apppasswords');
    expect(out.join('\n')).not.toContain(PW);

    err = [];
    await run(['test', 'ghost']);
    expect(err[0]).toMatch(/MAIL_ACCOUNT_NOT_FOUND/);
  });

  it('add --test, default, remove and presets', async () => {
    await run(['add', 'a', '--email', 'a@yahoo.com', '--test'], { readStdin: async () => `${PW}\n` });
    expect(out.join('\n')).toContain('✓ SMTP signed in');
    await run(['add', 'b', '--email', 'b@fastmail.com'], { readStdin: async () => `${PW}\n` });
    out = [];
    await run(['default', 'b']);
    expect(out[0]).toContain('"b" is now the default');
    expect((await store.get())!.name).toBe('b');
    await run(['remove', 'a']);
    expect((await store.list()).map(x => x.name)).toEqual(['b']);
    await run(['rm', 'a']);
    expect(err.join('\n')).toContain('No mail account named "a"');
    out = [];
    await run(['presets']);
    const text = out.join('\n');
    for (const id of ['gmail', 'outlook', 'office365', 'yahoo', 'icloud', 'yandex', 'zoho', 'fastmail', 'aol', 'gmx', 'proton-bridge', 'custom']) expect(text).toContain(id);
    out = [];
    await run(['presets', '--json'], {}, { root: true });
    expect(JSON.parse(out.join('\n')).length).toBeGreaterThanOrEqual(11);
  });

  it('parseHostPort', () => {
    expect(parseHostPort('imap.x.org')).toEqual({ host: 'imap.x.org' });
    expect(parseHostPort('imap.x.org:993')).toEqual({ host: 'imap.x.org', port: 993, secure: true });
    expect(parseHostPort('smtp.x.org:587')).toEqual({ host: 'smtp.x.org', port: 587, secure: false });
    expect(parseHostPort('[::1]:1143')).toEqual({ host: '[::1]', port: 1143, secure: false });
    expect(parseHostPort('')).toBeUndefined();
    expect(() => parseHostPort('a:b:c')).toThrow(/host or host:port/);
  });
});
