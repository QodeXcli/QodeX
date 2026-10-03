/**
 * `qodex vault ...` — manage the encrypted credential vault from the terminal.
 *
 *   qodex vault add <name> --origin <site>... [--username u] [--totp] [--note n] [--force]
 *   qodex vault list [--json]
 *   qodex vault rm <name>
 *
 * Secrets are NEVER taken as command-line arguments (they would land in shell
 * history and `ps`). On a terminal they are typed with echo off; when stdin is
 * not a TTY the first line is the secret and, with --totp, the second line is
 * the TOTP seed (base32 or an otpauth:// URI) — e.g.
 *   printf '%s\n%s\n' "$PW" "$SEED" | qodex vault add github --origin github.com --totp
 *
 * No bootstrap/config needed: the vault lives at QODEX_VAULT_FILE with its key
 * in QODEX_VAULT_KEY_FILE (0600).
 */

import { Command } from 'commander';
import { getVault, normalizeOrigin, type Vault } from './vault.js';
import { parseTotpInput } from './totp.js';

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

export function buildVaultCommand(deps: { vault?: () => Vault; io?: Partial<VaultCommandIO> } = {}): Command {
  const io: VaultCommandIO = { ...DEFAULT_IO, ...deps.io };
  const vault = () => (deps.vault ? deps.vault() : getVault());
  const fail = (e: unknown) => {
    io.err(`✗ ${(e as any)?.message ?? e}`);
    process.exitCode = 1;
  };

  const cmd = new Command('vault');
  cmd.description('Encrypted credential vault: logins the agent can fill (browser_fill_secret) but never see');

  cmd
    .command('add <name>')
    .description('Store a login. The secret is typed hidden (or read from stdin), never passed as an argument')
    .requiredOption('-o, --origin <sites...>', 'site(s) where it may be used, e.g. github.com https://accounts.google.com (comma or space separated)')
    .option('-u, --username <username>', 'username / email to store with it')
    .option('--totp', 'also store a 2FA (TOTP) seed — base32 or an otpauth:// URI')
    .option('--note <text>', 'a note shown in `qodex vault list`')
    .option('-f, --force', 'replace an existing entry with the same name')
    .action(async (name: string, opts: { origin?: string[] | string; username?: string; totp?: boolean; note?: string; force?: boolean }) => {
      try {
        const origins = splitOrigins(opts.origin);
        for (const o of origins) {
          const n = normalizeOrigin(o);
          if (!n) throw new Error(`[VAULT_INVALID] "${o}" is not a usable site — use e.g. github.com or https://accounts.google.com (http only for localhost)`);
          if (n.exact) io.out(`  note: ${n.host} is shared hosting — only that exact host will match, not its subdomains.`);
        }
        let secret = '';
        let totp: string | undefined;
        if (io.isTTY()) {
          secret = await io.readHidden(`Password / secret for "${name}" (hidden): `);
          if (!secret) throw new Error('[VAULT_INVALID] the secret is empty');
          const again = await io.readHidden('Repeat it: ');
          if (again !== secret) throw new Error('[VAULT_INVALID] the two entries did not match — nothing was saved');
          if (opts.totp) totp = (await io.readHidden('TOTP seed (base32 or otpauth:// URI, hidden): ')).trim();
        } else {
          const lines = (await io.readStdin()).split(/\r?\n/);
          secret = lines[0] ?? '';
          if (opts.totp) totp = (lines[1] ?? '').trim();
          if (!secret) throw new Error('[VAULT_INVALID] no secret on stdin (first line)');
        }
        if (opts.totp) {
          if (!totp) throw new Error('[VAULT_INVALID] --totp was given but no TOTP seed was provided');
          parseTotpInput(totp); // validate before saving
        }
        const saved = await vault().add({ name, origins, username: opts.username, secret, totp, note: opts.note }, { replace: !!opts.force });
        const fields = [saved.hasUsername && 'username', saved.hasSecret && 'password', saved.hasTotp && 'totp'].filter(Boolean).join(', ');
        io.out(`✓ Saved "${saved.name}" — sites: ${saved.origins.join(', ')} — fields: ${fields}`);
        io.out('  The agent can fill it with browser_fill_secret on those sites; it never sees the value.');
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
          io.out(JSON.stringify(entries.map(e => ({ name: e.name, origins: e.origins, username: e.username, totp: e.hasTotp, note: e.note, createdAt: e.createdAt })), null, 2));
          return;
        }
        if (!entries.length) {
          io.out('The vault is empty. Add a login with: qodex vault add <name> --origin <site> [--username <u>] [--totp]');
          return;
        }
        io.out(`${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}:`);
        for (const e of entries) {
          const fields = [e.hasUsername && 'username', e.hasSecret && 'password', e.hasTotp && 'totp'].filter(Boolean).join(', ');
          io.out(`  ● ${e.name}${e.username ? `  (${e.username})` : ''}`);
          io.out(`      sites: ${e.origins.join(', ')}   fields: ${fields}${e.note ? `   note: ${e.note}` : ''}`);
        }
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
