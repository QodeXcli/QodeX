import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import {
  VaultKeyStore, getVaultKey, keyFingerprint, setKeyStoreDefaultsForTests, spawnRunner,
  type CommandRunner, type RunResult,
} from '../src/vault/keystore.js';
import { Vault } from '../src/vault/vault.js';
import { MailAccountStore } from '../src/mail/accounts.js';
import { DraftStore } from '../src/mail/drafts.js';
import { loadVaultKey } from '../src/mail/secrets.js';

/**
 * A fake OS keychain world: emulates `security` (macOS), `secret-tool` (libsecret) and
 * PowerShell DPAPI closely enough to drive the real backends, and records every call so
 * tests can assert that no key ever travels in argv.
 */
class FakeOs {
  items = new Map<string, string>();
  calls: Array<{ cmd: string; args: string[]; input: string }> = [];
  locked = false;
  corruptWrites = false;
  echoInputOnError = false;

  private key(service: string, account: string) { return `${service}|${account}`; }

  runner: CommandRunner = async (cmd, args, opts = {}): Promise<RunResult> => {
    const input = opts.input ?? '';
    this.calls.push({ cmd, args: [...args], input });
    const flag = (list: string[], f: string) => { const i = list.indexOf(f); return i >= 0 ? list[i + 1] : undefined; };
    if (cmd === 'security') {
      if (args[0] === 'list-keychains') return { code: 0, stdout: '"/Users/me/Library/Keychains/login.keychain-db"\n', stderr: '' };
      if (this.locked) return { code: 51, stdout: '', stderr: 'security: SecKeychainSearchCopyNext: User interaction is not allowed.' };
      if (args[0] === '-i') {
        if (this.echoInputOnError) return { code: 1, stdout: '', stderr: `security: bad command: ${input}` };
        for (const line of input.split('\n').filter(Boolean)) {
          const toks = [...line.matchAll(/"([^"]*)"|(\S+)/g)].map(m => m[1] ?? m[2]);
          if (toks[0] !== 'add-generic-password') return { code: 1, stdout: '', stderr: 'unknown command' };
          const value = flag(toks, '-w')!;
          this.items.set(this.key(flag(toks, '-s')!, flag(toks, '-a')!), this.corruptWrites ? randomBytes(32).toString('base64') : value);
        }
        return { code: 0, stdout: '', stderr: '' };
      }
      const k = this.key(flag(args, '-s')!, flag(args, '-a')!);
      if (args[0] === 'find-generic-password') {
        const v = this.items.get(k);
        return v ? { code: 0, stdout: v + '\n', stderr: '' } : { code: 44, stdout: '', stderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.' };
      }
      if (args[0] === 'delete-generic-password') {
        return this.items.delete(k) ? { code: 0, stdout: '', stderr: '' } : { code: 44, stdout: '', stderr: 'not found' };
      }
    }
    if (cmd === 'secret-tool') {
      const k = this.key(flag(args, 'service')!, flag(args, 'account')!);
      if (this.locked && args[0] !== 'search') return { code: 2, stdout: '', stderr: 'secret-tool: Cannot create an item in a locked collection' };
      if (args[0] === 'search') return { code: this.items.has(k) ? 0 : 1, stdout: '', stderr: '' };
      if (args[0] === 'store') { this.items.set(k, this.corruptWrites ? randomBytes(32).toString('base64') : input); return { code: 0, stdout: '', stderr: '' }; }
      if (args[0] === 'lookup') { const v = this.items.get(k); return v ? { code: 0, stdout: v, stderr: '' } : { code: 1, stdout: '', stderr: '' }; }
      if (args[0] === 'clear') { this.items.delete(k); return { code: 0, stdout: '', stderr: '' }; }
    }
    if (cmd === 'powershell.exe') {
      if (input.includes('"dpapi-ok"')) return { code: 0, stdout: 'dpapi-ok\r\n', stderr: '' };
      const m = input.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/);
      const op = /::Protect\(/.test(input) ? 'protect' : /::Unprotect\(/.test(input) ? 'unprotect' : null;
      if (!m || !op || this.locked) return { code: 1, stdout: '', stderr: 'Exception calling "Unprotect": Key not valid for use in specified state.' };
      const data = Buffer.from(m[1], 'base64');
      // "DPAPI": a reversible transform tagged with a header, never the raw key.
      const out = op === 'protect'
        ? Buffer.concat([Buffer.from('DPAPI1'), Buffer.from(data.map(b => b ^ 0x5a))])
        : (data.subarray(0, 6).toString() === 'DPAPI1' ? Buffer.from(data.subarray(6).map(b => b ^ 0x5a)) : null);
      if (!out) return { code: 1, stdout: '', stderr: 'bad blob' };
      return { code: 0, stdout: (op === 'protect' || !this.corruptWrites ? out : randomBytes(32)).toString('base64') + '\r\n', stderr: '' };
    }
    return { code: null, stdout: '', stderr: 'ENOENT' };
  };

  /** Every argv any program ever got, joined. */
  argv(): string { return this.calls.map(c => [c.cmd, ...c.args].join(' ')).join('\n'); }
}

let tmp: string;
let keyFile: string;
let vaultFile: string;
let fake: FakeOs;

const store = (platform: NodeJS.Platform = 'darwin', env: NodeJS.ProcessEnv = {}) =>
  new VaultKeyStore({ keyFile, runner: fake.runner, platform, env });

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-keystore-'));
  keyFile = path.join(tmp, '.vault-key');
  vaultFile = path.join(tmp, 'vault.json');
  fake = new FakeOs();
});
afterEach(async () => {
  setKeyStoreDefaultsForTests(null);
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('file backend (real files)', () => {
  it('mints a 0600 key and records the backend on a fresh install', async () => {
    const ks = store('linux');
    expect(await ks.load({ create: false })).toBeNull();
    const key = await ks.load({ create: true, guardFiles: [vaultFile] });
    expect(key!.length).toBe(32);
    expect(ks.keystoreFile).toBe(path.join(tmp, 'vault-keystore.json'));
    const rec = JSON.parse(await fs.readFile(ks.keystoreFile, 'utf-8'));
    expect(rec).toMatchObject({ format: 'qodex-vault-keystore', version: 1, backend: 'file', fingerprint: keyFingerprint(key!) });
    expect(JSON.stringify(rec)).not.toContain(key!.toString('base64'));
    if (process.platform !== 'win32') {
      expect((await fs.stat(keyFile)).mode & 0o077).toBe(0);
      expect((await fs.stat(ks.keystoreFile)).mode & 0o077).toBe(0);
    }
    expect((await ks.load({ create: true }))!.equals(key!)).toBe(true);
  });

  it('a missing key file is never re-minted once the record exists (even with no vault yet)', async () => {
    const ks = store('linux');
    await ks.load({ create: true });
    await fs.rm(keyFile);
    await expect(ks.load({ create: true })).rejects.toThrow(/VAULT_KEY_MISSING/);
    await expect(fs.access(keyFile)).rejects.toThrow();
    // Mail sees the same record and refuses with its own code.
    await expect(loadVaultKey({ keyFile, vaultFile, create: true })).rejects.toThrow(/MAIL_KEY_MISSING/);
    await expect(fs.access(keyFile)).rejects.toThrow();
  });

  it('a legacy install (key file, no record) keeps working and gets a record on the next write', async () => {
    const legacy = randomBytes(32);
    await fs.writeFile(keyFile, legacy.toString('base64') + '\n', { mode: 0o600 });
    const ks = store('linux');
    expect((await ks.load({ create: false }))!.equals(legacy)).toBe(true);
    await expect(fs.access(ks.keystoreFile)).rejects.toThrow(); // reads never create files
    expect((await ks.load({ create: true }))!.equals(legacy)).toBe(true);
    expect(JSON.parse(await fs.readFile(ks.keystoreFile, 'utf-8')).backend).toBe('file');
  });

  it('concurrent first uses agree on ONE key', async () => {
    const keys = await Promise.all([1, 2, 3, 4].map(() => getVaultKey({ keyFile, vaultFile, create: true })));
    for (const k of keys) expect(k!.equals(keys[0]!)).toBe(true);
  });

  it('a damaged record is reported, never treated as a fresh install', async () => {
    const ks = store('linux');
    await fs.writeFile(ks.keystoreFile, '{oops');
    await expect(ks.load({ create: true })).rejects.toThrow(/VAULT_KEYSTORE_CORRUPT/);
    await expect(fs.access(keyFile)).rejects.toThrow();
  });
});

describe('migration with fake OS keychains', () => {
  it('file → macOS Keychain → file round-trips; the vault opens at every step; the key never hits argv', async () => {
    setKeyStoreDefaultsForTests({ runner: fake.runner, platform: 'darwin', env: {} });
    const vault = new Vault({ file: vaultFile, keyFile });
    await vault.add({ name: 'github', origins: ['github.com'], username: 'octo', secret: 'Sup3r-Secret!' });
    const original = (await fs.readFile(keyFile, 'utf-8')).trim();

    const ks = store('darwin');
    const verified: string[] = [];
    const r = await ks.migrate('macos', { guardFiles: [vaultFile], verify: async k => { verified.push(keyFingerprint(k)); } });
    expect(r).toMatchObject({ from: 'file', to: 'macos', changed: true, minted: false, warnings: [] });
    expect(verified).toHaveLength(1);
    await expect(fs.access(keyFile)).rejects.toThrow(); // the plaintext key file is gone
    expect(JSON.parse(await fs.readFile(ks.keystoreFile, 'utf-8')).backend).toBe('macos');
    expect([...fake.items.values()]).toEqual([original]);
    expect((await new Vault({ file: vaultFile, keyFile }).get('github'))!.secret).toBe('Sup3r-Secret!');

    // Without the key file, a write path must still use the keychain — not mint a new key.
    await new Vault({ file: vaultFile, keyFile }).add({ name: 'b', origins: ['b.example'], secret: 'bbb' });
    await expect(fs.access(keyFile)).rejects.toThrow();

    const back = await store('darwin').migrate('file');
    expect(back).toMatchObject({ from: 'macos', to: 'file', changed: true });
    expect((await fs.readFile(keyFile, 'utf-8')).trim()).toBe(original);
    expect(fake.items.size).toBe(0);
    expect((await new Vault({ file: vaultFile, keyFile }).names()).sort()).toEqual(['b', 'github']);

    expect(fake.argv()).not.toContain(original);
    const adds = fake.calls.filter(c => c.args[0] === '-i');
    expect(adds.length).toBe(1);
    expect(adds[0].input).toContain(original); // only ever on stdin
  });

  it('secret-service: refused without D-Bus (nothing changes), works with it, secret on stdin', async () => {
    const key = await store('linux').load({ create: true });
    await expect(store('linux', {}).migrate('secret-service')).rejects.toThrow(/VAULT_KEYCHAIN_UNAVAILABLE.*D-Bus/);
    expect((await fs.readFile(keyFile, 'utf-8')).trim()).toBe(key!.toString('base64'));
    expect(JSON.parse(await fs.readFile(store('linux').keystoreFile, 'utf-8')).backend).toBe('file');

    const env = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' };
    await store('linux', env).migrate('secret-service');
    await expect(fs.access(keyFile)).rejects.toThrow();
    expect((await store('linux', env).load({ create: true }))!.equals(key!)).toBe(true);
    expect(fake.argv()).not.toContain(key!.toString('base64'));
    expect(fake.calls.find(c => c.args[0] === 'store')!.input).toBe(key!.toString('base64'));

    await store('linux', env).migrate('file');
    expect((await store('linux').load({}))!.equals(key!)).toBe(true);
  });

  it('windows: DPAPI-sealed blob (0600, no raw key), script on stdin, round trip', async () => {
    const key = await store('win32').load({ create: true });
    const ks = store('win32');
    await ks.migrate('windows');
    const blob = (await fs.readFile(ks.dpapiFile, 'utf-8')).trim();
    expect(blob).not.toContain(key!.toString('base64'));
    expect(Buffer.from(blob, 'base64').subarray(0, 6).toString()).toBe('DPAPI1');
    await expect(fs.access(keyFile)).rejects.toThrow();
    expect((await store('win32').load({}))!.equals(key!)).toBe(true);
    expect(fake.calls.every(c => c.args.join(' ') === '-NoProfile -NonInteractive -Command -')).toBe(true);
    expect(fake.argv()).not.toContain(key!.toString('base64'));
    await store('win32').migrate('file');
    await expect(fs.access(ks.dpapiFile)).rejects.toThrow();
    expect((await store('win32').load({}))!.equals(key!)).toBe(true);
  });

  it('a read-back mismatch aborts: record unchanged, key file kept', async () => {
    const key = await store('darwin').load({ create: true });
    fake.corruptWrites = true;
    await expect(store('darwin').migrate('macos')).rejects.toThrow(/VAULT_KEY_MIGRATE_FAILED/);
    expect((await fs.readFile(keyFile, 'utf-8')).trim()).toBe(key!.toString('base64'));
    expect(JSON.parse(await fs.readFile(store('darwin').keystoreFile, 'utf-8')).backend).toBe('file');
  });

  it('a failing verify (wrong key for the vault) aborts before anything is stored', async () => {
    await store('darwin').load({ create: true });
    await expect(store('darwin').migrate('macos', { verify: async () => { throw new Error('[VAULT_DECRYPT_FAILED] nope'); } })).rejects.toThrow(/VAULT_DECRYPT_FAILED/);
    expect(fake.items.size).toBe(0);
  });

  it('the record says macos but the item is gone: VAULT_KEY_MISSING, never a new key', async () => {
    const vault = new Vault({ file: vaultFile, keyFile, keystore: store('darwin') });
    await vault.add({ name: 'a', origins: ['a.example'], secret: 'sss' });
    await store('darwin').migrate('macos');
    fake.items.clear();
    const ks = store('darwin');
    await expect(ks.load({ create: true })).rejects.toThrow(/VAULT_KEY_MISSING/);
    await expect(new Vault({ file: path.join(tmp, 'other.json'), keyFile, keystore: store('darwin') }).add({ name: 'x', origins: ['x.example'], secret: 'xxx' })).rejects.toThrow(/VAULT_KEY_MISSING/);
    await expect(fs.access(keyFile)).rejects.toThrow();
    expect(fake.items.size).toBe(0);
  });

  it('a locked keychain is reported (no mint, no key in the message)', async () => {
    const key = await store('darwin').load({ create: true });
    await store('darwin').migrate('macos');
    fake.locked = true;
    const err = await store('darwin').load({ create: true }).catch((e: Error) => e);
    expect(String((err as Error).message)).toMatch(/VAULT_KEYCHAIN_UNAVAILABLE/);
    expect(String((err as Error).message)).not.toContain(key!.toString('base64'));
    await expect(fs.access(keyFile)).rejects.toThrow();
  });

  it('a different key in the keychain is caught by the fingerprint', async () => {
    await store('darwin').load({ create: true });
    await store('darwin').migrate('macos');
    for (const k of fake.items.keys()) fake.items.set(k, randomBytes(32).toString('base64'));
    await expect(store('darwin').load({})).rejects.toThrow(/VAULT_KEY_MISMATCH/);
  });

  it('a backend error that echoes its input never leaks the key', async () => {
    const key = await store('darwin').load({ create: true });
    fake.echoInputOnError = true;
    const err = await store('darwin').migrate('macos').catch((e: Error) => e);
    expect(String((err as Error).message)).toMatch(/VAULT_KEYCHAIN_UNAVAILABLE/);
    expect(String((err as Error).message)).not.toContain(key!.toString('base64'));
  });

  it('migrate on a fresh install creates the key directly in the keychain', async () => {
    const r = await store('darwin').migrate('macos', { guardFiles: [vaultFile] });
    expect(r).toMatchObject({ minted: true, changed: true, to: 'macos' });
    await expect(fs.access(keyFile)).rejects.toThrow();
    expect(fake.items.size).toBe(1);
  });

  it('refuses to migrate when the key is missing but encrypted data exists', async () => {
    await fs.writeFile(vaultFile, '{}');
    await expect(store('darwin').migrate('macos', { guardFiles: [vaultFile] })).rejects.toThrow(/VAULT_KEY_MISSING/);
    expect(fake.items.size).toBe(0);
  });

  it('status names the backend and never shows key material', async () => {
    const key = await store('darwin').load({ create: true });
    await store('darwin').migrate('macos');
    const st = await store('darwin').status();
    expect(st).toMatchObject({ backend: 'macos', recorded: true, present: true, fingerprintOk: true });
    expect(st.backends.find(b => b.name === 'macos')!.unavailable).toBeNull();
    expect(st.backends.find(b => b.name === 'windows')!.unavailable).toMatch(/Windows/);
    expect(JSON.stringify(st)).not.toContain(key!.toString('base64'));
  });
});

describe('one shared key for vault + mail accounts + drafts', () => {
  it('mail data written before a migration still opens after it (and after migrating back)', async () => {
    setKeyStoreDefaultsForTests({ runner: fake.runner, platform: 'darwin', env: {} });
    const accountsFile = path.join(tmp, 'mail-accounts.enc');
    const accounts = () => new MailAccountStore({ file: accountsFile, keyFile, vaultFile });
    const drafts = () => new DraftStore({ dir: path.join(tmp, 'drafts'), keyFile, vaultFile });
    await accounts().add({ name: 'work', email: 'me@gmail.com', provider: 'gmail', password: 'app-pass-1234' });
    const d = await drafts().create({ account: 'work', from: 'me@gmail.com', to: ['a@b.c'], cc: [], bcc: [], subject: 's', body: 'b', attachments: [] });
    const vault = new Vault({ file: vaultFile, keyFile });
    await vault.add({ name: 'site', origins: ['site.example'], secret: 'pw-123' });

    await store('darwin').migrate('macos', { guardFiles: [vaultFile, accountsFile] });
    await expect(fs.access(keyFile)).rejects.toThrow();
    expect((await accounts().list()).map(a => a.name)).toEqual(['work']);
    expect((await drafts().get(d.id))!.subject).toBe('s');
    expect((await new Vault({ file: vaultFile, keyFile }).get('site'))!.secret).toBe('pw-123');

    await store('darwin').migrate('file');
    expect((await accounts().list()).map(a => a.name)).toEqual(['work']);
    expect((await drafts().get(d.id))!.subject).toBe('s');
  });

  it('mail never mints over an existing accounts file', async () => {
    const accountsFile = path.join(tmp, 'mail-accounts.enc');
    await fs.writeFile(accountsFile, '{}');
    await expect(new MailAccountStore({ file: accountsFile, keyFile, vaultFile }).add({ name: 'w', email: 'w@gmail.com', provider: 'gmail', password: 'x-1234' })).rejects.toThrow(/MAIL_KEY_MISSING/);
    await expect(fs.access(keyFile)).rejects.toThrow();
  });
});

describe('spawnRunner', () => {
  it('passes input on stdin and reports a missing program as code null', async () => {
    const r = await spawnRunner(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'via-stdin' });
    expect(r).toMatchObject({ code: 0, stdout: 'via-stdin' });
    const missing = await spawnRunner('qodex-no-such-program-xyz', []);
    expect(missing.code).toBeNull();
  });
});
