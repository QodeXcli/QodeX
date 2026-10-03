/**
 * `qodex mail …` — set up mail accounts from the terminal.
 *
 *   qodex mail add <name> [--email a@b] [--provider gmail|outlook|…|custom] [--imap host[:port]] [--smtp host[:port]]
 *                         [--user login] [--display-name n] [--oauth-token] [--local-plain] [--default] [--force] [--test] [--json]
 *   qodex mail list [--json]
 *   qodex mail remove <name>
 *   qodex mail test [name] [--json]
 *   qodex mail default <name>
 *   qodex mail presets [--json]
 *
 * The app password (or OAuth2 access token) is NEVER a command-line argument (shell
 * history, `ps`): on a terminal it is typed with echo off; otherwise it is the first line
 * of stdin, e.g.  printf '%s\n' "$APP_PW" | qodex mail add work --email me@gmail.com
 *
 * Accounts are stored encrypted with the vault key in ~/.qodex/mail-accounts.enc (0600).
 */

import { Command } from 'commander';
import * as readline from 'readline';
import { readHiddenLine } from '../vault/command.js';
import { getMailAccounts, isEmailAddress, type MailAccountStore, type MailAccountSummary } from './accounts.js';
import { APP_PASSWORD_NOTE_FA, MAIL_PRESETS, MAIL_PRESET_IDS, detectPreset, getPreset, type MailEndpoint } from './presets.js';
import { safeErrorMessage } from './secrets.js';
import { MailService, getMailService } from './service.js';

export interface MailCommandIO {
  isTTY: () => boolean;
  /** Read one line with echo off. */
  readHidden: (prompt: string) => Promise<string>;
  /** Read one visible line. */
  readLine: (prompt: string) => Promise<string>;
  /** Read all of stdin (non-TTY). */
  readStdin: () => Promise<string>;
  out: (line: string) => void;
  err: (line: string) => void;
}

function readVisibleLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(prompt, (answer) => { rl.close(); resolve(answer); });
  });
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
  return Buffer.concat(chunks).toString('utf8');
}

const DEFAULT_IO: MailCommandIO = {
  isTTY: () => !!process.stdin.isTTY,
  readHidden: (p) => readHiddenLine(p),
  readLine: readVisibleLine,
  readStdin: readAllStdin,
  out: (l) => console.log(l),
  err: (l) => console.error(l),
};

/** "host", "host:port", "[::1]:993" → endpoint parts; implicit TLS from the port. PURE. */
export function parseHostPort(s: string | undefined): Partial<MailEndpoint> | undefined {
  const t = String(s ?? '').trim();
  if (!t) return undefined;
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d{1,5}))?$/.exec(t);
  if (!m) throw new Error(`[MAIL_INVALID] "${t}" is not host or host:port`);
  const host = m[1];
  if (!m[2]) return { host };
  const port = Number(m[2]);
  // 993 / 465 are implicit TLS; 143 / 587 / 25 / bridge ports upgrade with STARTTLS.
  const secure = port === 993 || port === 465 ? true : [143, 587, 25, 2525, 1143, 1025].includes(port) ? false : true;
  return { host, port, secure };
}

function describeEndpoint(e: MailEndpoint, plainOk: boolean): string {
  return `${e.host}:${e.port} (${e.secure ? 'TLS' : plainOk ? 'plain, local only' : 'STARTTLS'})`;
}

function accountLine(a: MailAccountSummary): string[] {
  return [
    `  ● ${a.name}${a.isDefault ? ' (default)' : ''} — ${a.displayName ? `${a.displayName} <${a.email}>` : a.email}`,
    `      provider: ${a.provider} · login: ${a.user} · auth: ${a.auth === 'xoauth2' ? 'OAuth2 token' : 'app password'}`,
    `      IMAP ${describeEndpoint(a.imap, !!a.allowInsecure)} · SMTP ${describeEndpoint(a.smtp, !!a.allowInsecure)}`,
  ];
}

function publicAccount(a: MailAccountSummary): Record<string, unknown> {
  return {
    name: a.name, email: a.email, displayName: a.displayName, user: a.user, provider: a.provider, auth: a.auth,
    imap: a.imap, smtp: a.smtp, default: a.isDefault, createdAt: a.createdAt, updatedAt: a.updatedAt,
  };
}

export function buildMailCommand(deps: { accounts?: () => MailAccountStore; service?: () => MailService; io?: Partial<MailCommandIO> } = {}): Command {
  const io: MailCommandIO = { ...DEFAULT_IO, ...deps.io };
  const accounts = () => (deps.accounts ? deps.accounts() : getMailAccounts());
  const service = () => (deps.service ? deps.service() : deps.accounts ? new MailService({ accounts: deps.accounts }) : getMailService());
  const fail = (e: unknown, secrets: string[] = []) => {
    io.err(`✗ ${safeErrorMessage(e, secrets)}`);
    process.exitCode = 1;
  };

  const cmd = new Command('mail');
  cmd.description('Mail accounts the agent can read, draft and (with your approval) send from — IMAP/SMTP, app passwords stored encrypted');

  cmd
    .command('add <name>')
    .description('Add a mail account. The app password is typed hidden (or read from stdin), never passed as an argument')
    .option('-e, --email <address>', 'the email address (From)')
    .option('--provider <id>', `provider preset: ${MAIL_PRESET_IDS.join(', ')} (default: detected from the address)`)
    .option('-u, --user <login>', 'login name if it differs from the address')
    .option('--display-name <name>', 'name shown in From')
    .option('--imap <host[:port]>', 'IMAP server (custom provider, or override the preset)')
    .option('--smtp <host[:port]>', 'SMTP server (custom provider, or override the preset)')
    .option('--oauth-token', 'read an OAuth2 access token (XOAUTH2) instead of an app password')
    .option('--local-plain', 'allow unencrypted connections to a local bridge on 127.0.0.1 (Proton Mail Bridge)')
    .option('--default', 'make this the default account')
    .option('-f, --force', 'replace an existing account with the same name')
    .option('--test', 'sign in to IMAP and SMTP after saving')
    .option('--json', 'machine-readable output')
    .action(async (name: string, _o: unknown, command: Command) => {
      // optsWithGlobals(): the root command also defines --json, and commander lets the parent
      // take a flag it knows even when it is written after the subcommand.
      const opts = command.optsWithGlobals() as {
        email?: string; provider?: string; user?: string; displayName?: string; imap?: string; smtp?: string;
        oauthToken?: boolean; localPlain?: boolean; default?: boolean; force?: boolean; test?: boolean; json?: boolean;
      };
      let secret = '';
      try {
        const tty = io.isTTY();
        let email = opts.email?.trim() ?? '';
        if (!email && tty) email = (await io.readLine('Email address: ')).trim();
        if (!isEmailAddress(email)) throw new Error(`[MAIL_INVALID] ${email ? `"${email}" is not an email address` : '--email is required'}`);

        let provider = opts.provider?.trim().toLowerCase();
        if (!provider) provider = detectPreset(email)?.id;
        if (!provider && tty && !opts.imap) {
          provider = (await io.readLine(`Provider (${MAIL_PRESET_IDS.join(', ')}) [custom]: `)).trim().toLowerCase() || 'custom';
        }
        provider = provider || 'custom';
        const preset = provider === 'custom' ? null : getPreset(provider);
        if (provider !== 'custom' && !preset) throw new Error(`[MAIL_INVALID] unknown provider "${provider}" — one of: ${MAIL_PRESET_IDS.join(', ')}`);

        let imapArg = opts.imap;
        let smtpArg = opts.smtp;
        if (!preset && tty) {
          if (!imapArg) imapArg = (await io.readLine('IMAP server (host[:port], e.g. mail.example.com:993): ')).trim();
          if (!smtpArg) smtpArg = (await io.readLine('SMTP server (host[:port], e.g. mail.example.com:465): ')).trim();
        }
        const imap = parseHostPort(imapArg);
        const smtp = parseHostPort(smtpArg);

        const what = opts.oauthToken ? 'OAuth2 access token' : 'app password';
        if (tty && !opts.json) {
          if (preset) {
            io.out(`${preset.label}: ${preset.appPassword === 'required' ? 'needs an APP PASSWORD (your normal password will be refused once 2-step sign-in is on).' : preset.appPassword === 'recommended' ? 'an app password (or an OAuth2 token) is recommended.' : ''}`);
            io.out(`  ${preset.help}`);
          } else {
            io.out('Custom server: use the password your provider gives mail apps (often an "app password").');
          }
          io.out(`  ${APP_PASSWORD_NOTE_FA}`);
          secret = (await io.readHidden(`${what[0].toUpperCase()}${what.slice(1)} for ${email} (hidden): `)).trim();
        } else {
          secret = ((await io.readStdin()).split(/\r?\n/)[0] ?? '').trim();
        }
        if (!secret) throw new Error(`[MAIL_INVALID] no ${what} was given${tty ? '' : ' (first line of stdin)'}`);

        const saved = await accounts().add({
          name, email, provider, user: opts.user, displayName: opts.displayName,
          imap, smtp, allowInsecure: opts.localPlain ? true : undefined,
          ...(opts.oauthToken ? { accessToken: secret } : { password: secret }),
          makeDefault: !!opts.default,
        }, { replace: !!opts.force });

        let result: CheckResult | null = null;
        if (opts.test) {
          const svc = service();
          const { transport } = await svc.freshTransport(saved.name);
          try { result = cleanCheck(await transport.test(), (m) => safeErrorMessage(svc.errorText(m), [secret], saved.user)); } finally { await transport.close().catch(() => {}); }
        }
        if (opts.json) {
          io.out(JSON.stringify({ ...publicAccount(saved), ...(result ? { test: result } : {}) }, null, 2));
        } else {
          io.out(`✓ Saved mail account "${saved.name}"${saved.isDefault ? ' (default)' : ''}:`);
          for (const l of accountLine(saved).slice(1)) io.out(l);
          io.out(`  The ${what} is stored encrypted (vault key) — the agent can use the account but never sees it.`);
          if (result) printCheck(io, saved.name, result, [secret], saved.provider);
          else io.out(`  Check the sign-in with: qodex mail test ${saved.name}`);
        }
        if (result && (!result.imap.ok || !result.smtp.ok)) process.exitCode = 1;
      } catch (e) {
        fail(e, [secret]);
      } finally {
        secret = '';
      }
    });

  cmd
    .command('list')
    .alias('ls')
    .description('List mail accounts (never shows passwords)')
    .option('--json', 'machine-readable output')
    .action(async (_o: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as { json?: boolean };
      try {
        const all = await accounts().list();
        if (opts.json) { io.out(JSON.stringify(all.map(publicAccount), null, 2)); return; }
        if (!all.length) { io.out('No mail accounts. Add one with: qodex mail add <name> --email you@example.com'); return; }
        io.out(`${all.length} mail account${all.length === 1 ? '' : 's'}:`);
        for (const a of all) for (const l of accountLine(a)) io.out(l);
      } catch (e) {
        fail(e);
      }
    });

  cmd
    .command('remove <name>')
    .alias('rm')
    .description('Delete a mail account and its stored password')
    .action(async (name: string) => {
      try {
        if (await accounts().remove(name)) io.out(`✓ Removed mail account "${name}".`);
        else { io.err(`✗ No mail account named "${name}".`); process.exitCode = 1; }
      } catch (e) {
        fail(e);
      }
    });

  cmd
    .command('default <name>')
    .description('Make an account the default one')
    .action(async (name: string) => {
      try {
        if (await accounts().setDefault(name)) io.out(`✓ "${name}" is now the default mail account.`);
        else { io.err(`✗ No mail account named "${name}".`); process.exitCode = 1; }
      } catch (e) {
        fail(e);
      }
    });

  cmd
    .command('test [name]')
    .description('Sign in to IMAP and SMTP (nothing is sent or changed)')
    .option('--json', 'machine-readable output')
    .action(async (name: string | undefined, _o: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as { json?: boolean };
      const svc = service();
      try {
        const { account, transport } = await svc.freshTransport(name);
        let clean: CheckResult;
        try { clean = cleanCheck(await transport.test(), (m) => svc.errorText(m)); } finally { await transport.close().catch(() => {}); }
        if (opts.json) io.out(JSON.stringify({ account: account.name, ...clean }, null, 2));
        else {
          io.out(`Testing "${account.name}" (${account.email})…`);
          io.out(`  IMAP ${describeEndpoint(account.imap, !!account.allowInsecure)}`);
          io.out(`  SMTP ${describeEndpoint(account.smtp, !!account.allowInsecure)}`);
          printCheck(io, account.name, clean, [], account.provider);
        }
        if (!clean.imap.ok || !clean.smtp.ok) process.exitCode = 1;
      } catch (e) {
        io.err(`✗ ${svc.errorText(e)}`);
        process.exitCode = 1;
      }
    });

  cmd
    .command('presets')
    .description('Show the provider presets and how to get an app password for each')
    .option('--json', 'machine-readable output')
    .action((_o: unknown, command: Command) => {
      const opts = command.optsWithGlobals() as { json?: boolean };
      if (opts.json) { io.out(JSON.stringify(MAIL_PRESETS, null, 2)); return; }
      for (const p of MAIL_PRESETS) {
        io.out(`  ${p.id.padEnd(14)} ${p.label} — IMAP ${p.imap.host}:${p.imap.port} · SMTP ${p.smtp.host}:${p.smtp.port} · app password: ${p.appPassword}`);
        io.out(`  ${''.padEnd(14)} ${p.help}`);
      }
      io.out(`  ${'custom'.padEnd(14)} any IMAP/SMTP server: --imap host[:port] --smtp host[:port]`);
      io.out(`  ${APP_PASSWORD_NOTE_FA}`);
    });

  return cmd;
}

type CheckResult = { imap: { ok: boolean; error?: string }; smtp: { ok: boolean; error?: string } };

/** A transport check with every error message passed through `scrub`. */
function cleanCheck(r: CheckResult, scrub: (m: string) => string): CheckResult {
  const one = (x: { ok: boolean; error?: string }) => (x.ok ? { ok: true } : { ok: false, error: scrub(x.error ?? 'failed') });
  return { imap: one(r.imap), smtp: one(r.smtp) };
}

function printCheck(io: MailCommandIO, name: string, r: CheckResult, secrets: string[], provider?: string): void {
  const line = (kind: string, x: { ok: boolean; error?: string }) =>
    io.out(`  ${x.ok ? '✓' : '✗'} ${kind} ${x.ok ? 'signed in' : safeErrorMessage(x.error ?? 'failed', secrets)}`);
  line('IMAP', r.imap);
  line('SMTP', r.smtp);
  if (!r.imap.ok || !r.smtp.ok) {
    const p = getPreset(provider ?? '');
    const authFail = /AUTH_FAILED|auth|login|credential|535/i.test(`${r.imap.error ?? ''} ${r.smtp.error ?? ''}`);
    if (authFail) io.out(`  Sign-in was refused. ${p ? p.help : 'Use the app password your provider issues for mail apps.'} Then: qodex mail add ${name} --force`);
  }
}
