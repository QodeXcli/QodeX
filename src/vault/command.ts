/**
 * `qodex vault ...` — manage the encrypted credential vault from the terminal.
 *
 *   qodex vault add <name> --origin <site>... [--username u] [--totp] [--note n] [--login-url u] [--force]
 *   qodex vault list [--json]
 *   qodex vault edit <name> [--add-origin s…] [--remove-origin s…] [--origin s… (replace)]
 *                           [--username u | --clear-username] [--note n | --clear-note]
 *                           [--login-url u | --clear-login-url] [--rename new]
 *   qodex vault rotate <name> [--totp | --totp-only | --clear-totp | --undo]
 *   qodex vault import <file.csv> [--format chrome|firefox|bitwarden|1password|auto] [--dry-run]
 *                                 [--on-conflict skip|replace|rename]
 *   qodex vault key status | migrate <file|keychain|macos|secret-service|windows>
 *   qodex vault rm <name>
 *
 * Secrets are NEVER taken as command-line arguments (they would land in shell
 * history and `ps`). On a terminal they are typed with echo off; when stdin is
 * not a TTY the first line is the secret and, with --totp, the second line is
 * the TOTP seed (base32 or an otpauth:// URI) — e.g.
 *   printf '%s\n%s\n' "$PW" "$SEED" | qodex vault add github --origin github.com --totp
 *
 * Every subcommand that CHANGES the vault or its key is human-only: Sentinel blocks the
 * agent from running it (policy.ts QODEX_SELF_CHANGE_RE); `vault list` / `vault key status`
 * stay readable.
 */

import { Command } from 'commander';
import { promises as fs } from 'fs';
import * as path from 'path';
import { QODEX_MAIL_ACCOUNTS_FILE } from '../mail/paths.js';
import { decryptMailDoc } from '../mail/secrets.js';
import { decryptVault, getVault, normalizeOrigin, type ImportConflict, type Vault, type VaultEntryPatch } from './vault.js';
import { parseTotpInput } from './totp.js';
import { IMPORT_FORMATS, planImport, type ImportFormat } from './import.js';
import { KEY_BACKENDS, isKeyBackendName, keyBackendLabel, vaultKeyStore, type KeyBackendName, type VaultKeyStore } from './keystore.js';

export interface VaultCommandIO {
  isTTY: () => boolean;
  /** Read one line with echo off. */
  readHidden: (prompt: string) => Promise<string>;
  /** Read all of stdin (non-TTY). */
  readStdin: () => Promise<string>;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** Read one line from a TTY with echo off. Ctrl+C exits (130), Ctrl+D / Enter finish. */
export function readHiddenLine(prompt: string, stdin: NodeJS.ReadStream = process.stdin, stdout: NodeJS.WriteStream = process.stdout): Promise<string> {
  stdout.write(prompt);
  return new Promise((resolve) => {
    let buf = '';
    let escape = false;
    const wasRaw = !!stdin.isRaw;
    const cleanup = () => {
      stdin.removeListener('data', onData);
      try { stdin.setRawMode?.(wasRaw); } catch { /* ignore */ }
      stdin.pause();
    };
    const onData = (chunk: Buffer | string) => {
      for (const ch of String(chunk)) {
        const code = ch.charCodeAt(0);
        if (escape) { if (/[A-Za-z~]/.test(ch)) escape = false; continue; } // swallow arrow keys etc.
        if (code === 27) { escape = true; continue; }
        if (code === 13 || code === 10 || code === 4) { cleanup(); stdout.write('\n'); resolve(buf); return; }
        if (code === 3) { cleanup(); stdout.write('\n'); process.exit(130); }
        if (code === 127 || code === 8) { buf = [...buf].slice(0, -1).join(''); continue; }
        if (code === 21) { buf = ''; continue; } // Ctrl+U
        if (code < 32) continue;
        buf += ch;
      }
    };
    try { stdin.setRawMode?.(true); } catch { /* not a TTY */ }
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.resume();
  });
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
  return Buffer.concat(chunks).toString('utf8');
}

const DEFAULT_IO: VaultCommandIO = {
  isTTY: () => !!process.stdin.isTTY,
  readHidden: (p) => readHiddenLine(p),
  readStdin: readAllStdin,
  out: (l) => console.log(l),
  err: (l) => console.error(l),
};

function splitOrigins(v: string[] | string | undefined): string[] {
  const list = Array.isArray(v) ? v : v ? [v] : [];
  return list.flatMap(s => s.split(',')).map(s => s.trim()).filter(Boolean);
}

function checkOrigins(origins: string[], io: VaultCommandIO): void {
  for (const o of origins) {
    const n = normalizeOrigin(o);
    if (!n) throw new Error(`[VAULT_INVALID] "${o}" is not a usable site — use e.g. github.com or https://accounts.google.com (http only for localhost)`);
    if (n.exact) io.out(`  note: ${n.host} is shared hosting — only that exact host will match, not its subdomains.`);
  }
}

function fieldList(e: { hasUsername: boolean; hasSecret: boolean; hasTotp: boolean }): string {
  return [e.hasUsername && 'username', e.hasSecret && 'password', e.hasTotp && 'totp'].filter(Boolean).join(', ');
}

/** Largest CSV export accepted (a password export is a few hundred KB at most). */
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

export function buildVaultCommand(deps: { vault?: () => Vault; io?: Partial<VaultCommandIO>; keystore?: () => VaultKeyStore; mailAccountsFile?: string } = {}): Command {
  const io: VaultCommandIO = { ...DEFAULT_IO, ...deps.io };
  const vault = () => (deps.vault ? deps.vault() : getVault());
  const keystore = () => (deps.keystore ? deps.keystore() : vaultKeyStore({ keyFile: vault().keyFile }));
  const fail = (e: unknown) => {
    io.err(`✗ ${String((e as any)?.message ?? e).split('\n')[0]}`);
    process.exitCode = 1;
  };
  /** A secret typed twice with echo off (TTY), or line `line` of stdin. */
  const readSecret = async (prompt: string, stdinLines: () => Promise<string[]>, line: number): Promise<string> => {
    if (io.isTTY()) {
      const s = await io.readHidden(prompt);
      if (!s) throw new Error('[VAULT_INVALID] the secret is empty');
      const again = await io.readHidden('Repeat it: ');
      if (again !== s) throw new Error('[VAULT_INVALID] the two entries did not match — nothing was saved');
      return s;
    }
    const s = (await stdinLines())[line] ?? '';
    if (!s) throw new Error(`[VAULT_INVALID] no secret on stdin (line ${line + 1})`);
    return s;
  };
  const readSeed = async (stdinLines: () => Promise<string[]>, line: number): Promise<string> => {
    const seed = io.isTTY()
      ? (await io.readHidden('TOTP seed (base32 or otpauth:// URI, hidden): ')).trim()
      : ((await stdinLines())[line] ?? '').trim();
    if (!seed) throw new Error('[VAULT_INVALID] no TOTP seed was provided');
    parseTotpInput(seed); // validate before saving
    return seed;
  };
  const stdinOnce = () => {
    let lines: Promise<string[]> | null = null;
    return () => (lines ??= io.readStdin().then(t => t.split(/\r?\n/)));
  };

  const cmd = new Command('vault');
  cmd.description('Encrypted credential vault: logins the agent can fill (browser_login / browser_fill_secret) but never see');

  cmd
    .command('add <name>')
    .description('Store a login. The secret is typed hidden (or read from stdin), never passed as an argument')
    .requiredOption('-o, --origin <sites...>', 'site(s) where it may be used, e.g. github.com https://accounts.google.com (comma or space separated)')
    .option('-u, --username <username>', 'username / email to store with it')
    .option('--totp', 'also store a 2FA (TOTP) seed — base32 or an otpauth:// URI')
    .option('--note <text>', 'a note shown in `qodex vault list`')
    .option('--login-url <url>', 'the sign-in page (on one of the sites) browser_login opens')
    .option('-f, --force', 'replace an existing entry with the same name (fields not given are dropped; prefer edit / rotate)')
    .action(async (name: string, opts: { origin?: string[] | string; username?: string; totp?: boolean; note?: string; loginUrl?: string; force?: boolean }) => {
      try {
        const origins = splitOrigins(opts.origin);
        checkOrigins(origins, io);
        const lines = stdinOnce();
        const secret = await readSecret(`Password / secret for "${name}" (hidden): `, lines, 0);
        const totp = opts.totp ? await readSeed(lines, 1) : undefined;
        const saved = await vault().add({ name, origins, username: opts.username, secret, totp, note: opts.note, loginUrl: opts.loginUrl }, { replace: !!opts.force });
        io.out(`✓ Saved "${saved.name}" — sites: ${saved.origins.join(', ')} — fields: ${fieldList(saved)}`);
        io.out('  The agent can sign in with it (browser_login / browser_fill_secret) on those sites; it never sees the value.');
      } catch (e) {
        fail(e);
      }
    });

  cmd
    .command('list')
    .alias('ls')
    .description('List stored logins (names, sites, which fields exist — never values)')
    .option('--json', 'machine-readable output')
    .action(async (opts: { json?: boolean }) => {
      try {
        const entries = await vault().list();
        if (opts.json) {
          io.out(JSON.stringify(entries.map(e => ({
            name: e.name, origins: e.origins, username: e.username, totp: e.hasTotp, note: e.note, loginUrl: e.loginUrl,
            createdAt: e.createdAt, rotatedAt: e.rotatedAt, lastUsedAt: e.lastUsedAt,
          })), null, 2));
          return;
        }
        if (!entries.length) {
          io.out('The vault is empty. Add a login with: qodex vault add <name> --origin <site> [--username <u>] [--totp]   (or import: qodex vault import <export.csv>)');
          return;
        }
        io.out(`${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}:`);
        for (const e of entries) {
          io.out(`  ● ${e.name}${e.username ? `  (${e.username})` : ''}`);
          io.out(`      sites: ${e.origins.join(', ')}   fields: ${fieldList(e)}${e.note ? `   note: ${e.note}` : ''}`);
          const when = [e.loginUrl && `login: ${e.loginUrl}`, e.rotatedAt && `rotated ${e.rotatedAt.slice(0, 10)}`, e.lastUsedAt && `last used ${e.lastUsedAt.slice(0, 10)}`].filter(Boolean);
          if (when.length) io.out(`      ${when.join('   ')}`);
        }
      } catch (e) {
        fail(e);
      }
    });

  cmd
    .command('edit <name>')
    .description('Change an entry\'s sites, username, note or login page without touching its secret')
    .option('--origin <sites...>', 'replace the site list')
    .option('--add-origin <sites...>', 'add site(s)')
    .option('--remove-origin <sites...>', 'remove site(s)')
    .option('-u, --username <username>', 'set the username')
    .option('--clear-username', 'remove the username')
    .option('--note <text>', 'set the note')
    .option('--clear-note', 'remove the note')
    .option('--login-url <url>', 'set the sign-in page (must be on one of the sites)')
    .option('--clear-login-url', 'remove the sign-in page')
    .option('--rename <new>', 'rename the entry')
    .action(async (name: string, opts: {
      origin?: string[] | string; addOrigin?: string[] | string; removeOrigin?: string[] | string; username?: string; clearUsername?: boolean;
      note?: string; clearNote?: boolean; loginUrl?: string; clearLoginUrl?: boolean; rename?: string;
    }) => {
      try {
        const patch: VaultEntryPatch = {};
        if (opts.origin !== undefined) { patch.origins = splitOrigins(opts.origin); checkOrigins(patch.origins, io); }
        if (opts.addOrigin !== undefined) { patch.addOrigins = splitOrigins(opts.addOrigin); checkOrigins(patch.addOrigins, io); }
        if (opts.removeOrigin !== undefined) patch.removeOrigins = splitOrigins(opts.removeOrigin);
        if (opts.clearUsername) patch.username = null; else if (opts.username !== undefined) patch.username = opts.username;
        if (opts.clearNote) patch.note = null; else if (opts.note !== undefined) patch.note = opts.note;
        if (opts.clearLoginUrl) patch.loginUrl = null; else if (opts.loginUrl !== undefined) patch.loginUrl = opts.loginUrl;
        if (opts.rename !== undefined) patch.name = opts.rename;
        if (!Object.keys(patch).length) throw new Error('[VAULT_INVALID] nothing to change — see qodex vault edit --help');
        const s = await vault().update(name, patch);
        io.out(`✓ Updated "${s.name}" — sites: ${s.origins.join(', ')} — fields: ${fieldList(s)}${s.loginUrl ? ` — login: ${s.loginUrl}` : ''}`);
      } catch (e) {
        fail(e);
      }
    });

  cmd
    .command('rotate <name>')
    .description('Replace an entry\'s password (typed hidden / stdin) keeping everything else; the old one is kept for --undo')
    .option('--totp', 'also replace the TOTP seed (second hidden prompt / stdin line 2)')
    .option('--totp-only', 'replace only the TOTP seed')
    .option('--clear-totp', 'remove the TOTP seed (turn off 2FA filling)')
    .option('--undo', 'switch back to the previous password (after a password change the site rejected)')
    .action(async (name: string, opts: { totp?: boolean; totpOnly?: boolean; clearTotp?: boolean; undo?: boolean }) => {
      try {
        const patch: VaultEntryPatch = {};
        const lines = stdinOnce();
        if (opts.undo) patch.restorePrevious = true;
        else if (opts.clearTotp) patch.totp = null;
        else if (opts.totpOnly) patch.totp = await readSeed(lines, 0);
        else {
          patch.secret = await readSecret(`New password / secret for "${name}" (hidden): `, lines, 0);
          if (opts.totp) patch.totp = await readSeed(lines, 1);
        }
        const s = await vault().update(name, patch);
        const what = opts.undo ? 'is back on its previous password' : opts.clearTotp ? 'no longer has a TOTP seed' : opts.totpOnly ? 'has a new TOTP seed' : `has a new password${opts.totp ? ' and TOTP seed' : ''} (the old one is kept: qodex vault rotate ${s.name} --undo)`;
        io.out(`✓ "${s.name}" ${what}.`);
      } catch (e) {
        fail(e);
      }
    });

  cmd
    .command('import <file>')
    .description('Import logins from a Chrome / Firefox / Bitwarden / 1Password CSV export (then delete the export!)')
    .option('--format <format>', `export format: ${IMPORT_FORMATS.join(' | ')} | auto`, 'auto')
    .option('--dry-run', 'only report what would be imported')
    .option('--on-conflict <mode>', 'when a name already exists: skip | replace | rename', 'skip')
    .action(async (file: string, opts: { format?: string; dryRun?: boolean; onConflict?: string }) => {
      try {
        const format = String(opts.format ?? 'auto').toLowerCase();
        if (format !== 'auto' && !(IMPORT_FORMATS as readonly string[]).includes(format)) throw new Error(`[VAULT_INVALID] unknown format "${format.slice(0, 20)}" — use ${IMPORT_FORMATS.join(', ')} or auto`);
        const onConflict = String(opts.onConflict ?? 'skip').toLowerCase();
        if (!['skip', 'replace', 'rename'].includes(onConflict)) throw new Error('[VAULT_INVALID] --on-conflict must be skip, replace or rename');
        const abs = path.resolve(file);
        // One handle for the checks and the read: the file checked is the file imported.
        let fh;
        try { fh = await fs.open(abs, 'r'); } catch { throw new Error(`[VAULT_IMPORT_INVALID] cannot read ${abs}`); }
        let csv: string;
        try {
          const st = await fh.stat();
          if (!st.isFile() || st.size > MAX_IMPORT_BYTES) throw new Error('[VAULT_IMPORT_INVALID] not a CSV export file (missing, a directory, or larger than 20 MB)');
          csv = await fh.readFile('utf-8');
          if (Buffer.byteLength(csv, 'utf-8') > MAX_IMPORT_BYTES) throw new Error('[VAULT_IMPORT_INVALID] not a CSV export file (larger than 20 MB)');
        } finally {
          await fh.close().catch(() => {});
        }
        const plan = planImport(csv, format as ImportFormat | 'auto');
        const r = await vault().addMany(plan.entries, { onConflict: onConflict as ImportConflict, dryRun: !!opts.dryRun });
        const skipped = Object.entries(plan.skipped).filter(([, n]) => n > 0)
          .map(([why, n]) => `${n} ${({ 'app-or-no-url': 'app / no web address', 'insecure-http': 'plain http (not https)', 'no-password': 'without a password', 'not-a-login': 'not logins', invalid: 'invalid' } as Record<string, string>)[why] ?? why}`);
        const verb = opts.dryRun ? 'Would import' : 'Imported';
        io.out(`${opts.dryRun ? '(dry run) ' : '✓ '}${verb} ${r.added.length + r.renamed.length + r.replaced.length} of ${plan.rows} rows from a ${plan.format} export`
          + `: ${r.added.length} new, ${r.renamed.length} renamed, ${r.replaced.length} replaced, ${r.skipped.length} already in the vault (skipped).`);
        if (skipped.length) io.out(`  Not importable: ${skipped.join(', ')}.`);
        if (r.invalid.length) io.out(`  ${r.invalid.length} row(s) rejected (rows ${r.invalid.slice(0, 10).map(x => plan.rowOf[x.index]).join(', ')}${r.invalid.length > 10 ? ', …' : ''}).`);
        if (plan.totpDropped) io.out(`  ${plan.totpDropped} 2FA seed(s) were not standard TOTP and were left out.`);
        io.out('  Notes are not imported. The agent can now sign in with these entries; it never sees the values.');
        io.out(`  ⚠ The export file holds every password in plain text — delete it now (and empty the trash): ${abs}`);
      } catch (e) {
        fail(e);
      }
    });

  const key = cmd.command('key').description('Where the vault key is kept: the key file or the OS keychain');
  key
    .command('status')
    .description('Show which backend holds the vault key (never the key)')
    .action(async () => {
      try {
        const st = await keystore().status();
        io.out(`Vault key: ${keyBackendLabel(st.backend)} — ${st.location}`);
        io.out(`  ${st.present ? '✓ present' : '✗ NOT FOUND'}${st.fingerprintOk === false ? ' — ✗ does not match the recorded key' : st.fingerprintOk ? ' (matches the recorded fingerprint)' : ''}${st.recorded ? '' : ' (no keystore record yet)'}`);
        if (st.error) io.out(`  error: ${st.error}`);
        for (const b of st.backends) io.out(`  ${b.name === st.backend ? '●' : '○'} ${b.name.padEnd(14)} ${b.unavailable ? `unavailable: ${b.unavailable}` : 'available'}`);
        io.out('  Move it: qodex vault key migrate <file|keychain|macos|secret-service|windows>');
      } catch (e) {
        fail(e);
      }
    });
  key
    .command('migrate <backend>')
    .description('Move the vault key (used by the vault, mail accounts and drafts) to another backend; "keychain" = this OS\'s keychain')
    .action(async (backend: string) => {
      try {
        const ks = keystore();
        let target = String(backend ?? '').trim().toLowerCase();
        if (target === 'keychain' || target === 'os') target = ks.nativeBackend() ?? '';
        if (!isKeyBackendName(target)) throw new Error(`[VAULT_INVALID] unknown backend "${String(backend).slice(0, 30)}" — use keychain or one of ${KEY_BACKENDS.join(', ')}`);
        const v = vault();
        const mailFile = deps.mailAccountsFile ?? QODEX_MAIL_ACCOUNTS_FILE;
        const r = await ks.migrate(target as KeyBackendName, {
          guardFiles: [v.file, mailFile],
          // Never move a key that does not open what it protects.
          verify: async (k) => {
            const readJson = async (f: string) => { try { return JSON.parse(await fs.readFile(f, 'utf-8')); } catch (e: any) { if (e?.code === 'ENOENT') return undefined; throw new Error(`[VAULT_CORRUPT] ${f} is not valid JSON`); } };
            const vEnv = await readJson(v.file);
            if (vEnv !== undefined) decryptVault(vEnv, k);
            const mEnv = await readJson(mailFile);
            if (mEnv !== undefined) decryptMailDoc(mEnv, k);
          },
        });
        if (!r.changed) { io.out(`✓ The vault key is already in the ${keyBackendLabel(r.to)}.`); return; }
        io.out(r.minted
          ? `✓ Created a new vault key in the ${keyBackendLabel(r.to)}.`
          : `✓ Moved the vault key from the ${keyBackendLabel(r.from)} to the ${keyBackendLabel(r.to)}. The vault, mail accounts and drafts use it from now on.`);
        for (const w of r.warnings) io.out(`  ⚠ ${w}`);
        if (r.to !== 'file') io.out('  Keep this in mind: if the keychain is reset, the vault cannot be opened. qodex vault key migrate file moves it back.');
      } catch (e) {
        fail(e);
      }
    });

  cmd
    .command('rm <name>')
    .alias('remove')
    .description('Delete a stored login')
    .action(async (name: string) => {
      try {
        if (await vault().remove(name)) io.out(`✓ Removed "${name}" from the vault.`);
        else { io.err(`✗ No vault entry named "${name}".`); process.exitCode = 1; }
      } catch (e) {
        fail(e);
      }
    });

  return cmd;
}
