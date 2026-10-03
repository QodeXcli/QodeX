import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { randomBytes } from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { Vault, encryptVault, decryptVault, normalizeOrigin, matchOrigin, type VaultEntry } from '../src/vault/vault.js';

let tmp: string;
let vault: Vault;
const files = () => ({ file: path.join(tmp, 'vault.json'), keyFile: path.join(tmp, '.vault-key') });

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-vault-'));
  vault = new Vault(files());
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const entry: VaultEntry = { id: 'v_1', name: 'github', origins: ['github.com'], username: 'me', secret: 'p@ss', createdAt: 'x' };

describe('vault encryption', () => {
  it('round-trips and rejects the wrong key or tampering', () => {
    const key = randomBytes(32);
    const env = encryptVault([entry], key);
    expect(JSON.stringify(env)).not.toContain('p@ss');
    expect(decryptVault(env, key)).toEqual([entry]);
    expect(() => decryptVault(env, randomBytes(32))).toThrow(/VAULT_DECRYPT_FAILED/);
    const tampered = { ...env, data: Buffer.from('x' + Buffer.from(env.data, 'base64').toString('latin1').slice(1), 'latin1').toString('base64') };
    expect(() => decryptVault(tampered, key)).toThrow(/VAULT_DECRYPT_FAILED/);
    expect(() => decryptVault({ hello: 1 }, key)).toThrow(/VAULT_CORRUPT/);
    // fresh IV every time
    expect(encryptVault([entry], key).iv).not.toBe(env.iv);
  });
});

describe('Vault store', () => {
  it('creates a 0600 key on first add and never stores plaintext', async () => {
    expect(await vault.list()).toEqual([]);
    await expect(fs.access(files().keyFile)).rejects.toThrow(); // list() does not create a key
    const s = await vault.add({ name: 'github', origins: ['https://github.com/login', 'www.github.com'], username: 'me@x.com', secret: 'Sup3r-Secret!', totp: 'JBSWY3DPEHPK3PXP' });
    expect(s).toMatchObject({ name: 'github', origins: ['github.com'], hasUsername: true, hasSecret: true, hasTotp: true });
    expect((s as any).secret).toBeUndefined();
    const raw = await fs.readFile(files().file, 'utf-8');
    expect(raw).not.toContain('Sup3r-Secret!');
    expect(raw).not.toContain('JBSWY3DPEHPK3PXP');
    expect(raw).not.toContain('me@x.com');
    if (process.platform !== 'win32') {
      expect((await fs.stat(files().keyFile)).mode & 0o077).toBe(0);
      expect((await fs.stat(files().file)).mode & 0o077).toBe(0);
    }
    const got = await new Vault(files()).get('GitHub');
    expect(got).toMatchObject({ secret: 'Sup3r-Secret!', totp: 'JBSWY3DPEHPK3PXP', username: 'me@x.com' });
    const listed = await vault.list();
    expect(JSON.stringify(listed)).not.toContain('Sup3r-Secret!');
  });

  it('a different key cannot open the vault; a missing key is reported', async () => {
    await vault.add({ name: 'a', origins: ['a.example'], secret: 's1' });
    await fs.writeFile(files().keyFile, randomBytes(32).toString('base64'));
    await expect(vault.list()).rejects.toThrow(/VAULT_DECRYPT_FAILED/);
    await fs.rm(files().keyFile);
    await expect(vault.get('a')).rejects.toThrow(/VAULT_KEY_MISSING/);
    await expect(vault.add({ name: 'b', origins: ['b.example'], secret: 's' })).rejects.toThrow(/VAULT_KEY_MISSING/);
  });

  it('duplicates need replace; remove works; validation errors are coded', async () => {
    await vault.add({ name: 'mail', origins: ['mail.example.com'], secret: 'one' });
    await expect(vault.add({ name: 'MAIL', origins: ['mail.example.com'], secret: 'two' })).rejects.toThrow(/VAULT_EXISTS/);
    await vault.add({ name: 'mail', origins: ['mail.example.com'], secret: 'two' }, { replace: true });
    expect((await vault.get('mail'))?.secret).toBe('two');
    expect((await vault.get('mail'))?.updatedAt).toBeTruthy();
    expect(await vault.remove('mail')).toBe(true);
    expect(await vault.remove('mail')).toBe(false);
    await expect(vault.add({ name: '../x', origins: ['a.com'], secret: 's' })).rejects.toThrow(/VAULT_INVALID/);
    await expect(vault.add({ name: 'x', origins: [], secret: 's' })).rejects.toThrow(/origin/);
    await expect(vault.add({ name: 'x', origins: ['http://example.com'], secret: 's' })).rejects.toThrow(/VAULT_INVALID/);
    await expect(vault.add({ name: 'x', origins: ['a.com'], secret: '' })).rejects.toThrow(/empty/);
    await expect(vault.add({ name: 'x', origins: ['a.com'], secret: 's', totp: 'nope!' })).rejects.toThrow(/TOTP_INVALID/);
    await vault.add({ name: 'بانک من', origins: ['bank.ir'], secret: 's' });
    expect((await vault.get('بانک من'))?.origins).toEqual(['bank.ir']);
  });

  it('serializes concurrent writers', async () => {
    await Promise.all(['a', 'b', 'c', 'd'].map(n => new Vault(files()).add({ name: n, origins: [`${n}.example`], secret: n })));
    expect(await vault.names()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('stores non-default TOTP parameters from otpauth URIs', async () => {
    await vault.add({ name: 't', origins: ['t.example'], secret: 's', totp: 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=8&period=60' });
    expect(await vault.get('t')).toMatchObject({ totp: 'JBSWY3DPEHPK3PXP', totpDigits: 8, totpPeriod: 60 });
  });
});

describe('origin matching (anti-phishing)', () => {
  it('normalizes origins', () => {
    expect(normalizeOrigin('https://www.GitHub.com/login')).toMatchObject({ host: 'github.com', port: '', scheme: 'https', exact: false });
    expect(normalizeOrigin('*.example.com')).toMatchObject({ host: 'example.com' });
    expect(normalizeOrigin('localhost:3000')).toMatchObject({ host: 'localhost', port: '3000' });
    expect(normalizeOrigin('http://localhost:3000')).toMatchObject({ scheme: 'http' });
    expect(normalizeOrigin('http://example.com')).toBeNull();
    expect(normalizeOrigin('ftp://example.com')).toBeNull();
    expect(normalizeOrigin('github.io')).toMatchObject({ exact: true });
    expect(normalizeOrigin('دیجی\u200Cکالا.com')?.host).toMatch(/^xn--/);
  });
  it('allows the site and its subdomains over https only', () => {
    const o = ['github.com'];
    expect(matchOrigin('https://github.com/login', o).ok).toBe(true);
    expect(matchOrigin('https://www.github.com/login', o).ok).toBe(true);
    expect(matchOrigin('https://gist.github.com/', o).ok).toBe(true);
    expect(matchOrigin('http://github.com/login', o)).toMatchObject({ ok: false });
    expect(matchOrigin('https://github.com.evil.io/login', o).ok).toBe(false);
    expect(matchOrigin('https://evilgithub.com/', o).ok).toBe(false);
    expect(matchOrigin('about:blank', o).ok).toBe(false);
    expect(matchOrigin('file:///tmp/login.html', o).ok).toBe(false);
  });
  it('localhost over http, port pins and shared hosting', () => {
    expect(matchOrigin('http://localhost:3000/login', ['localhost:3000']).ok).toBe(true);
    expect(matchOrigin('http://localhost:4000/login', ['localhost:3000']).ok).toBe(false);
    expect(matchOrigin('http://127.0.0.1:8080/', ['http://127.0.0.1:8080']).ok).toBe(true);
    expect(matchOrigin('https://evil.github.io/', ['github.io']).ok).toBe(false);
    expect(matchOrigin('https://github.io/', ['github.io']).ok).toBe(true);
    expect(matchOrigin('https://me.github.io/app', ['me.github.io']).ok).toBe(true);
  });
});
