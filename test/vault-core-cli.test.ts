import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { buildVaultCommand, type VaultCommandIO } from '../src/vault/command.js';
import { Vault, encryptVault } from '../src/vault/vault.js';
import { VaultKeyStore, type CommandRunner } from '../src/vault/keystore.js';
import { parseCsv, planImport, detectFormat, toEntryName, EXPORT_FILE_RE } from '../src/vault/import.js';

const CHROME = [
  'name,url,username,password,note',
  'github.com,https://github.com/login,octo,"pa,ss""word-1",',
  'accounts.google.com,https://accounts.google.com/signin,me@gmail.com,G00gle-Secret!,',
  'android,android://abc@com.example.app/,appuser,AppSecret-1,',
  'plain,http://insecure.example/login,httpuser,HttpSecret-1,',
  'local,http://localhost:3000/,dev,DevSecret-1,',
  'nopass,https://nopass.example/,someone,,',
  'github.com,https://github.com/,second,SecondSecret-2,',
].join('\r\n') + '\r\n';

const FIREFOX = [
  '"url","username","password","httpRealm","formActionOrigin","guid","timeCreated","timeLastUsed","timePasswordChanged"',
  '"https://www.mozilla.org","fx","FoxSecret-1",,"https://www.mozilla.org","{0a}","1","2","3"',
].join('\n');

const BITWARDEN = [
  'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp',
  ',,login,GitHub (work),recovery codes 1234,,0,https://github.com,octo,BwSecret-1,JBSWY3DPEHPK3PXP',
  ',,note,My Note,text,,0,,,,',
  ',,login,Steam,,,0,https://store.steampowered.com,gamer,SteamSecret-1,steam://ABCDEF',
].join('\n');

const ONEPASSWORD = [
  'Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes',
  'Example,https://example.com,ex,OpSecret-1,otpauth://totp/Example:ex?secret=JBSWY3DPEHPK3PXP&issuer=Example,false,false,,',
].join('\n');

const ALL_SECRETS = ['pa,ss"word-1', 'G00gle-Secret!', 'AppSecret-1', 'HttpSecret-1', 'DevSecret-1', 'SecondSecret-2', 'FoxSecret-1', 'BwSecret-1', 'SteamSecret-1', 'OpSecret-1', 'recovery codes'];

describe('CSV parsing and export detection', () => {
  it('parses RFC 4180 quoting, CRLF, embedded newlines and a BOM', () => {
    expect(parseCsv('\uFEFFa,b\r\n"x,1","he said ""hi"""\n"multi\nline",z')).toEqual([['a', 'b'], ['x,1', 'he said "hi"'], ['multi\nline', 'z']]);
    expect(parseCsv('a,b\n\n1,2\n')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('errors name the row, never the content', () => {
    const e1 = (() => { try { parseCsv('a,b\nx,"TopSecret-Unclosed'); return null; } catch (e) { return e as Error; } })();
    expect(e1!.message).toMatch(/VAULT_IMPORT_INVALID.*row 2/);
    expect(e1!.message).not.toContain('TopSecret');
    const e2 = (() => { try { planImport('foo,bar\nTopSecret-xyz,1'); return null; } catch (e) { return e as Error; } })();
    expect(e2!.message).toMatch(/VAULT_IMPORT_INVALID.*unknown CSV layout/);
    expect(e2!.message).not.toContain('TopSecret');
  });

  it('detects the four formats', () => {
    for (const [csv, fmt] of [[CHROME, 'chrome'], [FIREFOX, 'firefox'], [BITWARDEN, 'bitwarden'], [ONEPASSWORD, '1password']] as const) {
      expect(detectFormat(parseCsv(csv)[0])).toBe(fmt);
    }
  });

  it('maps Chrome rows, skips app / http / password-less rows by count, makes names unique', () => {
    const p = planImport(CHROME);
    expect(p.format).toBe('chrome');
    expect(p.rows).toBe(7);
    expect(p.entries.map(e => [e.name, e.origins[0], e.username])).toEqual([
      ['github.com', 'github.com', 'octo'],
      ['accounts.google.com', 'accounts.google.com', 'me@gmail.com'],
      ['local', 'http://localhost:3000', 'dev'],
      ['github.com-2', 'github.com', 'second'],
    ]);
    expect(p.entries[0].secret).toBe('pa,ss"word-1');
    expect(p.skipped).toMatchObject({ 'app-or-no-url': 1, 'insecure-http': 1, 'no-password': 1 });
  });

  it('Bitwarden: logins only, TOTP kept, non-TOTP seeds dropped and counted, notes never imported', () => {
    const p = planImport(BITWARDEN);
    expect(p.entries.map(e => e.name)).toEqual(['GitHub -work', 'Steam']);
    expect(p.entries[0]).toMatchObject({ totp: 'JBSWY3DPEHPK3PXP', username: 'octo' });
    expect(p.entries[1].totp).toBeUndefined();
    expect(p.totpDropped).toBe(1);
    expect(p.skipped['not-a-login']).toBe(1);
    expect(JSON.stringify(p.entries)).not.toContain('recovery codes');
    expect(p.entries[0].note).toBeUndefined();
  });

  it('Firefox and 1Password', () => {
    expect(planImport(FIREFOX).entries[0]).toMatchObject({ name: 'mozilla.org', origins: ['mozilla.org'], username: 'fx' });
    expect(planImport(ONEPASSWORD).entries[0]).toMatchObject({ name: 'Example', origins: ['example.com'], totp: expect.stringContaining('otpauth://') });
    expect(() => planImport(FIREFOX, 'bitwarden')).toThrow(/does not look like a bitwarden export/);
  });

  it('entry names are always valid vault names', () => {
    expect(toEntryName('  (My) Bank / Login!  ')).toBe('My- Bank - Login');
    expect(toEntryName('بانک ملت')).toBe('بانک ملت');
    expect(toEntryName('x'.repeat(100))).toHaveLength(64);
  });

  it('knows the export file names Sentinel protects', () => {
    for (const f of ['/home/u/Downloads/Chrome Passwords.csv', 'C:\\Users\\u\\Downloads\\Microsoft Edge Passwords.csv', '/tmp/logins.csv', '/x/bitwarden_export_20261003.csv', '/x/1PasswordExport-ABC.csv', '/x/backup.1pux']) {
      expect(EXPORT_FILE_RE.test(f), f).toBe(true);
    }
    for (const f of ['/x/passwords-report.csv', '/x/src/logins.ts', '/x/data.csv']) expect(EXPORT_FILE_RE.test(f), f).toBe(false);
  });
});

// ── CLI ─────────────────────────────────────────────────────────────────────

let tmp: string;
let vault: Vault;
let out: string[];
let err: string[];
let ks: (() => VaultKeyStore) | undefined;

function run(args: string[], io: Partial<VaultCommandIO> = {}) {
  const cmd = buildVaultCommand({ vault: () => vault, io: { out: l => out.push(l), err: l => err.push(l), ...io }, keystore: ks, mailAccountsFile: path.join(tmp, 'mail-accounts.enc') });
  cmd.exitOverride();
  return cmd.parseAsync(args, { from: 'user' });
}
const stdin = (text: string): Partial<VaultCommandIO> => ({ isTTY: () => false, readStdin: async () => text });

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-vault-core-cli-'));
  vault = new Vault({ file: path.join(tmp, 'vault.json'), keyFile: path.join(tmp, '.vault-key') });
  out = [];
  err = [];
  ks = undefined;
  process.exitCode = 0;
});
afterEach(async () => {
  process.exitCode = 0;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('qodex vault import', () => {
  it('dry-run reports counts only and writes nothing', async () => {
    const f = path.join(tmp, 'Chrome Passwords.csv');
    await fs.writeFile(f, CHROME);
    await run(['import', f, '--dry-run']);
    expect(err).toEqual([]);
    const text = out.join('\n');
    expect(text).toMatch(/\(dry run\) Would import 4 of 7 rows from a chrome export: 4 new/);
    expect(text).toMatch(/1 app \/ no web address, 1 plain http \(not https\), 1 without a password/);
    for (const s of [...ALL_SECRETS, 'octo', 'me@gmail.com']) expect(text).not.toContain(s);
    await expect(fs.access(path.join(tmp, 'vault.json'))).rejects.toThrow();
    await expect(fs.access(path.join(tmp, '.vault-key'))).rejects.toThrow();
  });

  it('imports, tells the user to delete the export, and handles conflicts', async () => {
    const f = path.join(tmp, 'bitwarden_export_1.csv');
    await fs.writeFile(f, BITWARDEN);
    await run(['import', f]);
    expect(err).toEqual([]);
    expect(out.join('\n')).toMatch(/✓ Imported 2 of 3 rows from a bitwarden export: 2 new/);
    expect(out.join('\n')).toMatch(/1 2FA seed\(s\) were not standard TOTP/);
    expect(out.join('\n')).toContain(`delete it now (and empty the trash): ${f}`);
    for (const s of ALL_SECRETS) expect(out.join('\n')).not.toContain(s);
    expect(await vault.get('GitHub -work')).toMatchObject({ secret: 'BwSecret-1', totp: 'JBSWY3DPEHPK3PXP', username: 'octo' });

    out = [];
    await run(['import', f]);
    expect(out[0]).toMatch(/Imported 0 of 3 rows.*2 already in the vault \(skipped\)/);
    out = [];
    await run(['import', f, '--on-conflict', 'rename']);
    expect(out[0]).toMatch(/2 renamed/);
    expect(await vault.names()).toContain('Steam-2');
  });

  it('rejects unknown formats / files without echoing content', async () => {
    const f = path.join(tmp, 'weird.csv');
    await fs.writeFile(f, 'a,b\nTopSecret-1,2\n');
    await run(['import', f]);
    expect(err.at(-1)).toMatch(/VAULT_IMPORT_INVALID/);
    expect(err.join('\n')).not.toContain('TopSecret');
    await run(['import', path.join(tmp, 'missing.csv')]);
    expect(err.at(-1)).toMatch(/VAULT_IMPORT_INVALID.*cannot read/);
    await run(['import', f, '--format', 'keepass']);
    expect(err.at(-1)).toMatch(/unknown format/);
    expect(process.exitCode).toBe(1);
  });
});

describe('qodex vault edit / rotate', () => {
  beforeEach(async () => {
    await vault.add({ name: 'github', origins: ['github.com'], username: 'octo', secret: 'old-pw-1', totp: 'JBSWY3DPEHPK3PXP', note: 'n' });
  });

  it('edit changes metadata only', async () => {
    await run(['edit', 'github', '--add-origin', 'gist.github.com', '--login-url', 'https://github.com/login', '--clear-note', '--username', 'octo2']);
    expect(err).toEqual([]);
    expect(out[0]).toBe('✓ Updated "github" — sites: github.com, gist.github.com — fields: username, password, totp — login: https://github.com/login');
    expect(await vault.get('github')).toMatchObject({ secret: 'old-pw-1', totp: 'JBSWY3DPEHPK3PXP', username: 'octo2' });
    expect((await vault.get('github'))!.note).toBeUndefined();
    await run(['edit', 'github', '--rename', 'gh']);
    expect(await vault.names()).toEqual(['gh']);
    await run(['edit', 'gh']);
    expect(err.at(-1)).toMatch(/nothing to change/);
    await run(['edit', 'gh', '--login-url', 'https://evil.example/login']);
    expect(err.at(-1)).toMatch(/VAULT_INVALID/);
  });

  it('rotate reads the new secret from stdin, keeps the rest, and can undo', async () => {
    await run(['rotate', 'github'], stdin('new-pw-2\n'));
    expect(out.at(-1)).toMatch(/✓ "github" has a new password \(the old one is kept: qodex vault rotate github --undo\)/);
    expect(out.join('\n')).not.toContain('new-pw-2');
    expect(await vault.get('github')).toMatchObject({ secret: 'new-pw-2', previousSecret: 'old-pw-1', username: 'octo', totp: 'JBSWY3DPEHPK3PXP' });
    await run(['rotate', 'github', '--undo']);
    expect((await vault.get('github'))!.secret).toBe('old-pw-1');
    await run(['rotate', 'github', '--totp-only'], stdin('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ\n'));
    expect(await vault.get('github')).toMatchObject({ secret: 'old-pw-1', totp: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' });
    await run(['rotate', 'github', '--clear-totp']);
    expect((await vault.get('github'))!.totp).toBeUndefined();
    await run(['rotate', 'github'], { isTTY: () => true, readHidden: async () => 'typed-pw-3' });
    expect((await vault.get('github'))!.secret).toBe('typed-pw-3');
    await run(['rotate', 'missing'], stdin('x-123\n'));
    expect(err.at(-1)).toMatch(/VAULT_NOT_FOUND/);
  });
});

describe('qodex vault key', () => {
  /** Minimal fake macOS keychain. */
  function fakeKeychain() {
    const items = new Map<string, string>();
    const argv: string[] = [];
    const runner: CommandRunner = async (cmd, args, opts = {}) => {
      argv.push([cmd, ...args].join(' '));
      if (args[0] === 'list-keychains') return { code: 0, stdout: '', stderr: '' };
      if (args[0] === '-i') {
        const m = /-a (\S+) -s (\S+) .* -w (\S+)/.exec(opts.input ?? '');
        items.set(`${m![2]}|${m![1]}`, m![3]);
        return { code: 0, stdout: '', stderr: '' };
      }
      const k = `${args[args.indexOf('-s') + 1]}|${args[args.indexOf('-a') + 1]}`;
      if (args[0] === 'find-generic-password') return items.has(k) ? { code: 0, stdout: items.get(k)! + '\n', stderr: '' } : { code: 44, stdout: '', stderr: 'not found' };
      if (args[0] === 'delete-generic-password') { items.delete(k); return { code: 0, stdout: '', stderr: '' }; }
      return { code: null, stdout: '', stderr: 'ENOENT' };
    };
    return { items, argv, runner };
  }

  it('status and migrate keychain → file without ever printing the key', async () => {
    const fk = fakeKeychain();
    ks = () => new VaultKeyStore({ keyFile: path.join(tmp, '.vault-key'), runner: fk.runner, platform: 'darwin', env: {} });
    vault = new Vault({ file: path.join(tmp, 'vault.json'), keyFile: path.join(tmp, '.vault-key'), keystore: ks() });
    await vault.add({ name: 'a', origins: ['a.example'], secret: 'pw-a1' });
    const key = (await fs.readFile(path.join(tmp, '.vault-key'), 'utf-8')).trim();

    await run(['key', 'status']);
    expect(out[0]).toMatch(/^Vault key: key file — /);
    expect(out.join('\n')).toMatch(/● file\s+available/);
    expect(out.join('\n')).toMatch(/○ windows\s+unavailable: only on Windows/);

    out = [];
    await run(['key', 'migrate', 'keychain']);
    expect(err).toEqual([]);
    expect(out[0]).toBe('✓ Moved the vault key from the key file to the macOS Keychain. The vault, mail accounts and drafts use it from now on.');
    await expect(fs.access(path.join(tmp, '.vault-key'))).rejects.toThrow();
    expect((await new Vault({ file: path.join(tmp, 'vault.json'), keyFile: path.join(tmp, '.vault-key'), keystore: ks() }).get('a'))!.secret).toBe('pw-a1');

    out = [];
    await run(['key', 'migrate', 'file']);
    expect(out[0]).toMatch(/from the macOS Keychain to the key file/);
    expect((await fs.readFile(path.join(tmp, '.vault-key'), 'utf-8')).trim()).toBe(key);
    expect([...out, ...err, ...fk.argv].join('\n')).not.toContain(key);
  });

  it('refuses to migrate a key that does not open the vault, and unknown backends', async () => {
    const fk = fakeKeychain();
    ks = () => new VaultKeyStore({ keyFile: path.join(tmp, '.vault-key'), runner: fk.runner, platform: 'darwin', env: {} });
    await fs.writeFile(path.join(tmp, 'vault.json'), JSON.stringify(encryptVault([], randomBytes(32))));
    await fs.writeFile(path.join(tmp, '.vault-key'), randomBytes(32).toString('base64'));
    await run(['key', 'migrate', 'macos']);
    expect(err.at(-1)).toMatch(/VAULT_DECRYPT_FAILED/);
    expect(fk.items.size).toBe(0);
    await run(['key', 'migrate', 'floppy']);
    expect(err.at(-1)).toMatch(/unknown backend/);
  });
});
