import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MailAccountStore, isEmailAddress } from '../src/mail/accounts.js';
import { MAIL_PRESETS, MAIL_PRESET_IDS, detectPreset, getPreset } from '../src/mail/presets.js';
import {
  decryptMailDoc, deriveKey, encryptMailDoc, hmac, safeErrorMessage, sameMac, scrubSecrets, secretForms,
} from '../src/mail/secrets.js';
import { Vault, decryptVault, encryptVault } from '../src/vault/vault.js';

const PW = 'abcd efgh ijkl mnop';
const TOKEN = 'ya29.A0ARrdaM-very-secret-oauth-token';

let tmp: string;
let store: MailAccountStore;
let keyFile: string;
let vaultFile: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-mail-acc-'));
  keyFile = path.join(tmp, '.vault-key');
  vaultFile = path.join(tmp, 'vault.json');
  store = new MailAccountStore({ file: path.join(tmp, 'mail-accounts.enc'), keyFile, vaultFile });
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('presets', () => {
  it('covers every provider the spec names', () => {
    for (const id of ['gmail', 'outlook', 'office365', 'yahoo', 'icloud', 'yandex', 'zoho', 'fastmail', 'aol', 'gmx', 'proton-bridge', 'custom']) {
      expect(MAIL_PRESET_IDS).toContain(id);
    }
    for (const p of MAIL_PRESETS) {
      expect(p.help.length).toBeGreaterThan(20);
      expect(p.imap.port).toBeGreaterThan(0);
      expect(p.smtp.port).toBeGreaterThan(0);
    }
    expect(getPreset('gmail')!.appPassword).toBe('required');
    expect(getPreset('yahoo')!.appPassword).toBe('required');
    expect(getPreset('icloud')!.appPassword).toBe('required');
  });
  it('resolves aliases and detects from the address', () => {
    expect(getPreset('Hotmail')!.id).toBe('outlook');
    expect(getPreset('o365')!.id).toBe('office365');
    expect(getPreset('protonmail')!.id).toBe('proton-bridge');
    expect(getPreset('custom')).toBeNull();
    expect(detectPreset('a@gmail.com')!.id).toBe('gmail');
    expect(detectPreset('b@icloud.com')!.id).toBe('icloud');
    expect(detectPreset('c@example.org')).toBeNull();
    // Proton Mail Bridge is local-only and allowed to be plain.
    const pb = getPreset('proton-bridge')!;
    expect(pb.imap.host).toBe('127.0.0.1');
    expect(pb.allowInsecure).toBe(true);
  });
});

describe('secrets', () => {
  const key = Buffer.alloc(32, 7);
  it('encrypts and decrypts; a wrong key or a tampered file fails', () => {
    const env = encryptMailDoc({ hello: PW }, key);
    expect(JSON.stringify(env)).not.toContain(PW);
    expect(decryptMailDoc<any>(env, key).hello).toBe(PW);
    expect(() => decryptMailDoc(env, Buffer.alloc(32, 8))).toThrow(/MAIL_DECRYPT_FAILED/);
    const bad = { ...env, data: Buffer.from('x').toString('base64') };
    expect(() => decryptMailDoc(bad, key)).toThrow(/MAIL_DECRYPT_FAILED/);
  });
  it('is not interchangeable with the vault (separate formats, never a VaultEntry)', () => {
    const mailEnv = encryptMailDoc({ accounts: [] }, key);
    expect(() => decryptVault(mailEnv, key)).toThrow();
    // Even with the vault's format label, the AAD differs.
    expect(() => decryptVault({ ...mailEnv, format: 'qodex-vault' }, key)).toThrow(/VAULT_DECRYPT_FAILED/);
    const vaultEnv = encryptVault([], key);
    expect(() => decryptMailDoc(vaultEnv, key)).toThrow();
    expect(() => decryptMailDoc({ ...vaultEnv, format: 'qodex-mail-accounts' }, key)).toThrow(/MAIL_DECRYPT_FAILED/);
  });
  it('scrubs every encoding of a secret', () => {
    const user = 'me@gmail.com';
    const forms = secretForms(PW, user);
    expect(forms).toContain(PW);
    expect(forms).toContain(Buffer.from(PW).toString('base64'));
    expect(forms).toContain(Buffer.from(`\u0000${user}\u0000${PW}`).toString('base64'));
    const text = `fail ${PW} / ${Buffer.from(PW).toString('base64')} / AUTH PLAIN ${Buffer.from(`\u0000${user}\u0000${PW}`).toString('base64')} / ${encodeURIComponent(PW)}`;
    const out = scrubSecrets(text, [PW], user);
    expect(out).not.toContain(PW);
    expect(out).not.toContain(Buffer.from(PW).toString('base64'));
    expect(out).not.toContain(encodeURIComponent(PW));
    const xo = Buffer.from(`user=${user}\u0001auth=Bearer ${TOKEN}\u0001\u0001`).toString('base64');
    expect(scrubSecrets(`AUTHENTICATE XOAUTH2 ${xo}`, [TOKEN], user)).not.toContain(xo);
    expect(scrubSecrets('ab', ['ab'])).toBe('ab'); // too short to scrub safely
  });
  it('safeErrorMessage drops AUTH lines and scrubs response fields', () => {
    const err = Object.assign(new Error(`Invalid login: 535 bad ${PW}`), { response: `AUTH PLAIN AHVzZXIAcGFzcw== rejected ${TOKEN}` });
    const m = safeErrorMessage(err, [PW, TOKEN], 'u');
    expect(m).not.toContain(PW);
    expect(m).not.toContain(TOKEN);
    expect(m).not.toContain('AHVzZXIAcGFzcw==');
    expect(m).toContain('Invalid login');
  });
  it('derives purpose keys and compares MACs in constant time', () => {
    const k1 = deriveKey(key, 'drafts');
    expect(k1.length).toBe(32);
    expect(k1.equals(deriveKey(key, 'other'))).toBe(false);
    const m = hmac(k1, 'x');
    expect(sameMac(m, hmac(k1, 'x'))).toBe(true);
    expect(sameMac(m, hmac(k1, 'y'))).toBe(false);
    expect(sameMac('', '')).toBe(false);
  });
});

describe('MailAccountStore', () => {
  it('stores accounts encrypted (0600) and never returns secrets from list/get', async () => {
    const s = await store.add({ name: 'personal', email: 'me@gmail.com', provider: 'gmail', password: PW });
    expect(s.provider).toBe('gmail');
    expect(s.imap).toEqual({ host: 'imap.gmail.com', port: 993, secure: true });
    expect(s.user).toBe('me@gmail.com');
    expect(s.isDefault).toBe(true);
    expect(s.hasPassword).toBe(true);
    const raw = await fs.readFile(store.file, 'utf-8');
    expect(raw).not.toContain(PW);
    expect(raw).not.toContain('me@gmail.com');
    if (process.platform !== 'win32') {
      expect((await fs.stat(store.file)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(keyFile)).mode & 0o777).toBe(0o600);
    }
    const listed = await store.list();
    expect(JSON.stringify(listed)).not.toContain(PW);
    expect(JSON.stringify(await store.get())).not.toContain(PW);
    expect((await store.credentials('personal'))!.secret.password).toBe(PW);
    // By email too.
    expect((await store.get('me@gmail.com'))!.name).toBe('personal');
  });

  it('shares the vault key file with the vault without breaking it', async () => {
    const vault = new Vault({ file: vaultFile, keyFile });
    await vault.add({ name: 'gh', origins: ['github.com'], secret: 'vault-secret' });
    await store.add({ name: 'w', email: 'w@example.com', provider: 'custom', imap: { host: 'imap.example.com' }, smtp: { host: 'smtp.example.com', port: 587, secure: false }, password: PW });
    expect((await vault.get('gh'))!.secret).toBe('vault-secret');
    expect((await store.credentials('w'))!.secret.password).toBe(PW);
    // The mail password is not in the vault: browser_fill_secret can never reach it.
    expect((await vault.names())).toEqual(['gh']);
    expect((await store.get('w'))!.smtp).toEqual({ host: 'smtp.example.com', port: 587, secure: false });
  });

  it('refuses to mint a new key when encrypted files exist but the key is gone', async () => {
    await store.add({ name: 'a', email: 'a@gmail.com', provider: 'gmail', password: PW });
    await fs.rm(keyFile);
    await expect(store.list()).rejects.toThrow(/MAIL_KEY_MISSING/);
    await expect(store.add({ name: 'b', email: 'b@gmail.com', provider: 'gmail', password: PW })).rejects.toThrow(/MAIL_KEY_MISSING/);
  });

  it('validates input', async () => {
    await expect(store.add({ name: 'x', email: 'not-an-email', provider: 'gmail', password: PW })).rejects.toThrow(/not an email/);
    await expect(store.add({ name: '../evil', email: 'a@b.co', provider: 'gmail', password: PW })).rejects.toThrow(/account names/);
    await expect(store.add({ name: 'x', email: 'a@b.co', provider: 'nope', password: PW })).rejects.toThrow(/unknown provider/);
    await expect(store.add({ name: 'x', email: 'a@b.co', provider: 'custom', password: PW })).rejects.toThrow(/IMAP and an SMTP host/);
    await expect(store.add({ name: 'x', email: 'a@b.co', provider: 'gmail' })).rejects.toThrow(/app password/);
    await expect(store.add({
      name: 'x', email: 'a@b.co', provider: 'custom', allowInsecure: true, password: PW,
      imap: { host: 'imap.remote.example', secure: false, port: 143 }, smtp: { host: 'smtp.remote.example', secure: false, port: 25 },
    })).rejects.toThrow(/only allowed to this machine/);
    await expect(store.add({ name: 'x', email: 'a@b.co', provider: 'custom', imap: { host: 'bad host' }, smtp: { host: 's.example' }, password: PW })).rejects.toThrow(/not a host name/);
  });

  it('replace, default and remove', async () => {
    await store.add({ name: 'a', email: 'a@gmail.com', provider: 'gmail', password: PW });
    await store.add({ name: 'b', email: 'b@yahoo.com', provider: 'yahoo', accessToken: TOKEN });
    await expect(store.add({ name: 'A', email: 'a@gmail.com', provider: 'gmail', password: PW })).rejects.toThrow(/MAIL_EXISTS/);
    const r = await store.add({ name: 'A', email: 'a2@gmail.com', provider: 'gmail', password: 'new-pass' }, { replace: true });
    expect(r.email).toBe('a2@gmail.com');
    expect(r.updatedAt).toBeTruthy();
    expect((await store.get())!.name).toBe('A');
    expect((await store.get('b'))!.auth).toBe('xoauth2');
    expect(await store.setDefault('b')).toBe(true);
    expect((await store.get())!.name).toBe('b');
    expect(await store.remove('b')).toBe(true);
    expect(await store.remove('b')).toBe(false);
    expect((await store.get())!.name).toBe('A');
    expect((await store.list()).map(a => a.name)).toEqual(['A']);
  });

  it('isEmailAddress rejects header injection', () => {
    expect(isEmailAddress('a@b.co')).toBe(true);
    expect(isEmailAddress('a@b.co\r\nBcc: x@y.z')).toBe(false);
    expect(isEmailAddress('A <a@b.co>')).toBe(false);
    expect(isEmailAddress('a@b')).toBe(false);
  });
});
