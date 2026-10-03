import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Vault, setVaultForTests } from '../src/vault/vault.js';
import { VaultListTool } from '../src/vault/tools.js';
import { setBrowserManagerForTests } from '../src/tools/browser/types.js';
import type { ToolContext } from '../src/tools/base.js';

const SEED = 'JBSWY3DPEHPK3PXP';
const SEED2 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

let tmp: string;
let vault: Vault;
const files = () => ({ file: path.join(tmp, 'vault.json'), keyFile: path.join(tmp, '.vault-key') });

function ctx(): ToolContext {
  return { cwd: os.tmpdir(), sessionId: 's', transaction: {} as any, permissions: {} as any, askUser: async () => 'no', emit: () => {} };
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-vault-core-store-'));
  vault = new Vault(files());
});
afterEach(async () => {
  setVaultForTests(null);
  setBrowserManagerForTests(null);
  vi.restoreAllMocks();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('Vault.update (merge-patch)', () => {
  beforeEach(async () => {
    await vault.add({ name: 'github', origins: ['github.com'], username: 'octo', secret: 'old-pass-1', totp: SEED, note: 'work' });
  });

  it('rotates the secret without dropping username / TOTP / note, keeping the old one', async () => {
    const s = await vault.update('GitHub', { secret: 'new-pass-2' });
    expect(s).toMatchObject({ name: 'github', hasUsername: true, hasTotp: true, hasPreviousSecret: true, note: 'work' });
    expect(s.rotatedAt).toBeTruthy();
    expect(JSON.stringify(s)).not.toContain('new-pass-2');
    expect(JSON.stringify(s)).not.toContain('old-pass-1');
    const e = (await vault.get('github'))!;
    expect(e).toMatchObject({ secret: 'new-pass-2', previousSecret: 'old-pass-1', username: 'octo', totp: SEED, note: 'work' });
    const raw = await fs.readFile(files().file, 'utf-8');
    expect(raw).not.toContain('new-pass-2');
    expect(raw).not.toContain('old-pass-1');
  });

  it('restorePrevious undoes a rotation', async () => {
    await vault.update('github', { secret: 'new-pass-2' });
    await vault.update('github', { restorePrevious: true });
    expect((await vault.get('github'))!).toMatchObject({ secret: 'old-pass-1', previousSecret: 'new-pass-2' });
    await expect(vault.update('github', { secret: 'x-123', restorePrevious: true })).rejects.toThrow(/VAULT_INVALID/);
  });

  it('changes or removes the TOTP seed, username and note independently', async () => {
    await vault.update('github', { totp: `otpauth://totp/x?secret=${SEED2}&digits=8&period=60` });
    expect((await vault.get('github'))!).toMatchObject({ totp: SEED2, totpDigits: 8, totpPeriod: 60, secret: 'old-pass-1', username: 'octo' });
    await vault.update('github', { totp: null, username: null, note: null });
    const e = (await vault.get('github'))!;
    expect(e.totp).toBeUndefined();
    expect(e.totpDigits).toBeUndefined();
    expect(e.username).toBeUndefined();
    expect(e.note).toBeUndefined();
    expect(e.secret).toBe('old-pass-1');
    await expect(vault.update('github', { totp: 'not base32!!' })).rejects.toThrow(/TOTP/);
  });

  it('origins: add / remove / replace; never zero; login URL must stay on a site', async () => {
    await vault.update('github', { addOrigins: ['gist.github.com', 'https://github.com'] });
    expect((await vault.get('github'))!.origins).toEqual(['github.com', 'gist.github.com']);
    await vault.update('github', { loginUrl: 'https://github.com/login?return_to=x' });
    expect((await vault.list())[0].loginUrl).toBe('https://github.com/login?return_to=x');
    await expect(vault.update('github', { loginUrl: 'https://github.com.evil.io/login' })).rejects.toThrow(/VAULT_INVALID.*login URL/);
    await expect(vault.update('github', { loginUrl: 'http://github.com/login' })).rejects.toThrow(/VAULT_INVALID/);
    await vault.update('github', { origins: ['gist.github.com'] });
    // github.com/login is not on gist.github.com (a subdomain does not cover its parent).
    expect((await vault.get('github'))!.loginUrl).toBeUndefined();
    await expect(vault.update('github', { removeOrigins: ['gist.github.com'] })).rejects.toThrow(/at least one origin/);
    await expect(vault.update('github', { addOrigins: ['ftp://x'] })).rejects.toThrow(/VAULT_INVALID/);
  });

  it('renames (unique, valid) and reports a missing entry', async () => {
    await vault.add({ name: 'other', origins: ['o.example'], secret: 'sss' });
    await expect(vault.update('github', { name: 'Other' })).rejects.toThrow(/VAULT_EXISTS/);
    await expect(vault.update('github', { name: 'bad/name' })).rejects.toThrow(/VAULT_INVALID/);
    await vault.update('github', { name: 'gh' });
    expect(await vault.names()).toEqual(['gh', 'other']);
    await expect(vault.update('nope', { note: 'x' })).rejects.toThrow(/VAULT_NOT_FOUND/);
    await expect(vault.update('gh', { secret: '' })).rejects.toThrow(/VAULT_INVALID/);
    await expect(new Vault({ file: path.join(tmp, 'none.json'), keyFile: path.join(tmp, '.k3') }).update('x', {})).rejects.toThrow(/VAULT_NOT_FOUND/);
  });

  it('add --force keeps the replaced secret as previousSecret', async () => {
    await vault.add({ name: 'github', origins: ['github.com'], secret: 'forced-3' }, { replace: true });
    expect((await vault.get('github'))!).toMatchObject({ secret: 'forced-3', previousSecret: 'old-pass-1' });
  });

  it('touch records lastUsedAt at most once a minute', async () => {
    await vault.touch('github');
    const first = (await vault.list())[0].lastUsedAt!;
    expect(first).toBeTruthy();
    await vault.touch('github');
    expect((await vault.list())[0].lastUsedAt).toBe(first);
    await vault.touch('missing'); // no throw
  });
});

describe('Vault.findByOrigin', () => {
  it('uses the same origin rules as filling', async () => {
    await vault.add({ name: 'gh', origins: ['github.com'], secret: 'a-1' });
    await vault.add({ name: 'pages', origins: ['me.github.io'], secret: 'b-2' });
    await vault.add({ name: 'local', origins: ['http://localhost:3000'], secret: 'c-3' });
    expect((await vault.findByOrigin('https://gist.github.com/x')).map(e => e.name)).toEqual(['gh']);
    expect((await vault.findByOrigin('https://github.com.evil.io/')).map(e => e.name)).toEqual([]);
    expect((await vault.findByOrigin('http://github.com/')).map(e => e.name)).toEqual([]);
    expect((await vault.findByOrigin('https://evil.me.github.io/')).map(e => e.name)).toEqual([]);
    expect((await vault.findByOrigin('http://localhost:3000/login')).map(e => e.name)).toEqual(['local']);
    expect(await vault.findByOrigin('not a url')).toEqual([]);
    expect(JSON.stringify(await vault.findByOrigin('https://github.com/'))).not.toContain('a-1');
  });
});

describe('Vault.addMany', () => {
  it('adds under one write, reports invalid rows by index (never by value), handles conflicts', async () => {
    await vault.add({ name: 'existing', origins: ['e.example'], secret: 'keep-me' });
    const save = vi.spyOn(Vault.prototype as any, 'save');
    const r = await vault.addMany([
      { name: 'a', origins: ['a.example'], secret: 'pa' },
      { name: 'b', origins: ['http://b.example'], secret: 'TOPSECRET-b' },
      { name: 'existing', origins: ['e.example'], secret: 'new-e' },
      { name: 'c', origins: ['c.example'], secret: 'pc', totp: SEED },
    ]);
    expect(save).toHaveBeenCalledTimes(1);
    expect(r.added).toEqual(['a', 'c']);
    expect(r.skipped).toEqual(['existing']);
    expect(r.invalid).toEqual([{ index: 1, reason: expect.stringContaining('not a usable origin') }]);
    expect(JSON.stringify(r)).not.toContain('TOPSECRET');
    expect((await vault.get('existing'))!.secret).toBe('keep-me');

    const renamed = await vault.addMany([{ name: 'a', origins: ['a.example'], secret: 'pa2' }], { onConflict: 'rename' });
    expect(renamed.renamed).toEqual([{ from: 'a', to: 'a-2' }]);
    const replaced = await vault.addMany([{ name: 'existing', origins: ['e.example'], secret: 'new-e' }], { onConflict: 'replace' });
    expect(replaced.replaced).toEqual(['existing']);
    expect((await vault.get('existing'))!).toMatchObject({ secret: 'new-e', previousSecret: 'keep-me' });
  });

  it('dry-run writes nothing and creates no key', async () => {
    const fresh = new Vault({ file: path.join(tmp, 'v2.json'), keyFile: path.join(tmp, '.k2') });
    const r = await fresh.addMany([{ name: 'a', origins: ['a.example'], secret: 'pa' }], { dryRun: true });
    expect(r.added).toEqual(['a']);
    await expect(fs.access(path.join(tmp, 'v2.json'))).rejects.toThrow();
    await expect(fs.access(path.join(tmp, '.k2'))).rejects.toThrow();
  });
});

describe('vault_list site filter + active tab marker', () => {
  beforeEach(async () => {
    await vault.add({ name: 'github', origins: ['github.com'], username: 'octo@example.com', secret: 'S3cret-x' });
    await vault.add({ name: 'gitlab', origins: ['gitlab.com'], secret: 'S3cret-y' });
    setVaultForTests(vault);
  });

  it('filters by site and never shows usernames or values', async () => {
    const r = await new VaultListTool().execute({ site: 'https://gist.github.com/x' }, ctx());
    expect(r.content).toContain('- github — sites: github.com');
    expect(r.content).not.toContain('gitlab');
    expect(r.content).not.toContain('octo@example.com');
    expect(r.content).not.toContain('S3cret');
    const none = await new VaultListTool().execute({ site: 'bitbucket.org' }, ctx());
    expect(none.content).toMatch(/No vault entry may be used on bitbucket\.org/);
    expect(none.content).toContain('vault_request_login');
  });

  it('marks the entries for an already-open tab without launching the browser', async () => {
    let r = await new VaultListTool().execute({}, ctx());
    expect(r.content).not.toContain('matches the active tab');
    setBrowserManagerForTests({ isRunning: () => true, activeUrl: () => 'https://gitlab.com/users/sign_in' } as any);
    r = await new VaultListTool().execute({}, ctx());
    expect(r.content).toMatch(/- gitlab — .*✓ matches the active tab/);
    expect(r.content).not.toMatch(/- github — .*active tab/);
  });
});
