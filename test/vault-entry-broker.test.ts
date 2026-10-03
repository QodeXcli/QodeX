/**
 * V2 secret entry — the SecretRequestBroker, its vault adapter and the sealed
 * transport used by the control-center form.
 *
 * What must hold:
 *   - a typed secret lands in the vault and NOWHERE else: not in the request's
 *     result, the bus ring, the ApprovalBroker (so never Telegram), or an error;
 *   - only the terminal prompt or the control-center form can answer;
 *   - a request with no surface fails fast; rotation keeps the other fields;
 *   - the page-side sealing (the exact JS the dashboard ships) round-trips with
 *     the server key store, single use, bound to its request.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { webcrypto } from 'crypto';
import { Vault } from '../src/vault/vault.js';
import {
  SecretRequestBroker, vaultUpdate, vaultFindByOrigin, maskUsername, displayHost, deriveEntryName, scrubSecretError,
  type SecretSurface,
} from '../src/vault/requests.js';
import { SecretKeyStore, SECRET_SEAL_JS, classifySecretTransport, isSealedSecret } from '../src/control/secret-crypto.js';
import { getBus } from '../src/control/bus.js';
import { getApprovalBroker } from '../src/control/approvals.js';
import { totp } from '../src/vault/totp.js';

const SECRET = 'Tr0ub4dor&3-horse-staple';
const SEED = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

let tmp: string;
let vault: Vault;
let broker: SecretRequestBroker;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-v2-broker-'));
  vault = new Vault({ file: path.join(tmp, 'vault.json'), keyFile: path.join(tmp, '.vault-key') });
  broker = new SecretRequestBroker(() => vault);
  getBus().reset();
  getApprovalBroker().reset();
});
afterEach(async () => {
  broker.reset();
  await fs.rm(tmp, { recursive: true, force: true });
});

function busText(): string {
  return JSON.stringify(getBus().recent(300));
}

async function nextPending(b = broker): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const p = b.pending()[0];
    if (p) return p.id;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error('no pending request');
}

describe('SecretRequestBroker', () => {
  it('fails fast when no secure surface is open', async () => {
    const r = await broker.request({ entryName: 'github', origins: ['github.com'], fields: ['password'], reason: 'log in' });
    expect(r).toMatchObject({ ok: false, code: 'no-surface' });
    expect(broker.pending()).toEqual([]);
  });

  it('saves the typed login into the vault and returns only a summary', async () => {
    broker.attachSurface('terminal');
    const seen: number[] = [];
    broker.onChange(list => seen.push(list.length));
    const pending = broker.request({ entryName: 'github', origins: ['https://github.com/login'], fields: ['password', 'totp'], reason: 'log in to push', usernameHint: 'octo' });
    const id = await nextPending();
    const pub = broker.get(id)!;
    expect(pub).toMatchObject({ entryName: 'github', origins: ['github.com'], host: 'github.com', fields: ['username', 'password', 'totp'], existing: false, usernameHint: 'octo' });
    expect(JSON.stringify(broker.pending())).not.toContain(SECRET);

    const out = await broker.answer(id, { username: 'octo@example.com', password: SECRET, totp: SEED }, 'terminal');
    expect(out).toEqual({ ok: true, summary: { name: 'github', origins: ['github.com'], fields: ['username', 'password', 'totp'], updated: false } });
    const r = await pending;
    expect(r).toMatchObject({ ok: true, code: 'saved', by: 'terminal' });
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(JSON.stringify(r)).not.toContain(SEED);

    const e = await vault.get('github');
    expect(e?.secret).toBe(SECRET);
    expect(e?.username).toBe('octo@example.com');
    expect(totp(e!.totp!)).toBe(totp(SEED));
    // Nowhere else: bus ring, approvals (→ Telegram / dashboard approval cards), the file on disk.
    expect(busText()).not.toContain(SECRET);
    expect(busText()).not.toContain(SEED);
    expect(busText()).toContain('github.com');
    expect(getApprovalBroker().pending()).toEqual([]);
    expect(getBus().recent(300).some(ev => ev.kind === 'approval.requested' || ev.kind === 'approval.resolved')).toBe(false);
    const raw = await fs.readFile(path.join(tmp, 'vault.json'), 'utf-8');
    expect(raw).not.toContain(SECRET);
    expect(seen.at(-1)).toBe(0);
  });

  it('accepts answers only from the terminal prompt or the control-center form (never Telegram)', async () => {
    broker.attachSurface('control');
    const pending = broker.request({ entryName: 'bank', origins: ['bank.example'], fields: ['password'], reason: 'pay a bill' });
    const id = await nextPending();
    for (const by of ['telegram', 'local', 'mission-db', 'control-approval']) {
      const r = await broker.answer(id, { password: SECRET }, by as SecretSurface);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toMatch(/SECRET_SURFACE_REFUSED/);
        expect(r.error).not.toContain(SECRET);
      }
    }
    expect(broker.get(id)).toBeDefined();
    // The approval broker (Telegram, dashboard approvals, mission DB) never heard of it.
    expect(getApprovalBroker().resolve(id, 'yes', 'telegram')).toBe(false);
    expect(await vault.get('bank')).toBeNull();
    broker.cancel(id, 'test');
    expect(await pending).toMatchObject({ ok: false, code: 'cancelled' });
  });

  it('keeps the request open on a bad 2FA key and never echoes it', async () => {
    broker.attachSurface('terminal');
    const pending = broker.request({ entryName: 'site', origins: ['site.example'], fields: ['password', 'totp'], reason: 'x' });
    const id = await nextPending();
    const badSeed = 'NOT!BASE32@@@SEEDVALUE';
    const r = await broker.answer(id, { password: SECRET, totp: badSeed }, 'terminal');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/TOTP_INVALID/);
      expect(r.error).not.toMatch(/"!"|NOT!|SEEDVALUE/);
      expect(r.error).not.toContain(SECRET);
    }
    expect(broker.get(id)).toBeDefined();
    expect(await vault.get('site')).toBeNull();
    expect((await broker.answer(id, { password: '' }, 'terminal')).ok).toBe(false);
    const ok = await broker.answer(id, { password: SECRET }, 'terminal');
    expect(ok.ok).toBe(true);
    expect((await pending).ok).toBe(true);
    expect(busText()).not.toContain('SEEDVALUE');
  });

  it('rotates an existing entry of the same site without dropping its username or 2FA', async () => {
    await vault.add({ name: 'github', origins: ['github.com'], username: 'octo', secret: 'old-password', totp: `otpauth://totp/x?secret=${SEED}&digits=8&period=60` });
    broker.attachSurface('terminal');
    const pending = broker.request({ entryName: 'GitHub', origins: ['gist.github.com'], fields: ['password'], reason: 'password changed' });
    const id = await nextPending();
    expect(broker.get(id)).toMatchObject({ existing: true, entryName: 'github' });
    await broker.answer(id, { password: SECRET }, 'terminal');
    expect(await pending).toMatchObject({ ok: true, summary: { name: 'github', updated: true } });
    const e = (await vault.get('github'))!;
    expect(e.secret).toBe(SECRET);
    expect(e.username).toBe('octo');
    expect(e.totp).toBe(SEED);
    expect(e.totpDigits).toBe(8);
    expect(e.totpPeriod).toBe(60);
    expect(e.origins.sort()).toEqual(['gist.github.com', 'github.com']);
  });

  it('refuses to rebind an entry that belongs to another site', async () => {
    await vault.add({ name: 'bank', origins: ['bank.example'], secret: 'keep-me' });
    broker.attachSurface('terminal');
    const r = await broker.request({ entryName: 'bank', origins: ['evil.example'], fields: ['password'], reason: 'x' });
    expect(r).toMatchObject({ ok: false, code: 'invalid' });
    expect(r.message).toMatch(/VAULT_EXISTS/);
    expect((await vault.get('bank'))!.secret).toBe('keep-me');
  });

  it('times out, honors abort and cancellation, refuses a second request and rate-limits', async () => {
    broker.attachSurface('terminal');
    expect(await broker.request({ entryName: 'a', origins: ['a.example'], fields: ['password'], reason: 'x', timeoutMs: 20 })).toMatchObject({ ok: false, code: 'timeout' });
    const ac = new AbortController();
    const p = broker.request({ entryName: 'b', origins: ['b.example'], fields: ['password'], reason: 'x', signal: ac.signal });
    await nextPending();
    expect(await broker.request({ entryName: 'c', origins: ['c.example'], fields: ['password'], reason: 'x' })).toMatchObject({ ok: false, code: 'busy' });
    ac.abort();
    expect(await p).toMatchObject({ ok: false, code: 'aborted' });
    for (let i = 0; i < 4; i++) {
      const q = broker.request({ entryName: `d${i}`, origins: ['d.example'], fields: ['password'], reason: 'x' });
      broker.cancel(await nextPending(), 'terminal');
      expect(await q).toMatchObject({ code: 'cancelled', by: 'terminal' });
    }
    expect(await broker.request({ entryName: 'e', origins: ['e.example'], fields: ['password'], reason: 'x' })).toMatchObject({ ok: false, code: 'rate-limited' });
  });

  it('rejects bad sites and http outside localhost', async () => {
    broker.attachSurface('terminal');
    expect(await broker.request({ entryName: 'x', origins: ['http://example.com'], fields: ['password'], reason: 'x' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await broker.request({ entryName: 'bad/name', origins: ['example.com'], fields: ['password'], reason: 'x' })).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('a probe-based surface (control center running) counts as available', async () => {
    let running = false;
    broker.setSurfaceProbe('control', () => running);
    expect(broker.availableSurfaces()).toEqual([]);
    running = true;
    expect(broker.availableSurfaces()).toEqual(['control']);
    const detach = broker.attachSurface('terminal');
    expect(broker.availableSurfaces()).toEqual(['terminal', 'control']);
    detach();
    detach();
    expect(broker.availableSurfaces()).toEqual(['control']);
  });
});

describe('vault adapter (V1 contract fallback)', () => {
  it('vaultUpdate merge-patches and vaultFindByOrigin matches by site', async () => {
    await vault.add({ name: 'gh', origins: ['github.com'], username: 'octo', secret: 'one', note: 'n' });
    await vaultUpdate(vault, 'gh', { secret: 'two' });
    let e = (await vault.get('gh'))!;
    expect([e.username, e.secret, e.note]).toEqual(['octo', 'two', 'n']);
    await vaultUpdate(vault, 'gh', { username: null, origins: ['github.com', 'gitlab.com'] });
    e = (await vault.get('gh'))!;
    expect(e.username).toBeUndefined();
    expect(e.origins).toEqual(['github.com', 'gitlab.com']);
    await expect(vaultUpdate(vault, 'nope', { secret: 'x' })).rejects.toThrow(/VAULT_NOT_FOUND/);
    expect((await vaultFindByOrigin(vault, 'https://gist.github.com/x')).map(s => s.name)).toEqual(['gh']);
    expect(await vaultFindByOrigin(vault, 'https://github.com.evil.io/')).toEqual([]);
  });

  it('uses the real update/findByOrigin when the vault has them', async () => {
    const calls: string[] = [];
    const fake = {
      get: async () => null, list: async () => [], add: async () => { throw new Error('no'); }, remove: async () => false,
      update: async (name: string) => { calls.push(`update:${name}`); return { name } as any; },
      findByOrigin: async (url: string) => { calls.push(`find:${url}`); return []; },
    };
    await vaultUpdate(fake, 'x', { secret: 'y' });
    await vaultFindByOrigin(fake, 'https://a.example/');
    expect(calls).toEqual(['update:x', 'find:https://a.example/']);
  });
});

describe('helpers', () => {
  it('masks usernames, decodes punycode hosts and derives free entry names', () => {
    expect(maskUsername('octocat@example.com')).toBe('oc***@example.com');
    expect(maskUsername('bob')).toBe('b***');
    expect(maskUsername('')).toBe('');
    expect(displayHost('xn--80ak6aa92e.com')).toBe('аррӏе.com (xn--80ak6aa92e.com)');
    expect(displayHost('github.com')).toBe('github.com');
    expect(deriveEntryName('www.github.com', 'octo@x.io', [])).toBe('github.com');
    expect(deriveEntryName('github.com', 'octo@x.io', ['GitHub.com'])).toBe('github.com octo');
    expect(deriveEntryName('github.com', undefined, ['github.com'])).toBe('github.com 2');
  });

  it('scrubs typed values out of errors', () => {
    expect(scrubSecretError(new Error(`[VAULT_ERROR] bad ${SECRET} here\nsecond line`), [SECRET])).toBe('[VAULT_ERROR] bad *** here');
    expect(scrubSecretError(new Error('[TOTP_INVALID] "!" is not a base32 character'), [])).not.toContain('"!"');
    expect(scrubSecretError('not an error', [])).toBe('unexpected error');
  });
});

describe('sealed transport (page JS ↔ server key store)', () => {
  const seal = new Function(`${SECRET_SEAL_JS}; return qxSealSecret;`)() as (c: unknown, pub: string, kid: string, obj: unknown) => Promise<Record<string, string>>;

  it('round-trips the exact page code with a single-use key bound to its request', async () => {
    const store = new SecretKeyStore();
    const k = store.mint('sr_1');
    const env = await seal(webcrypto, k.publicKey, k.kid, { password: SECRET });
    expect(isSealedSecret(env)).toBe(true);
    expect(JSON.stringify(env)).not.toContain(SECRET);
    expect(JSON.parse(store.open(env as any, 'sr_1').toString('utf8'))).toEqual({ password: SECRET });
    // single use
    expect(() => store.open(env as any, 'sr_1')).toThrow(/SECRET_SEAL_INVALID/);
  });

  it('refuses another request, a tampered envelope and expired keys without echoing input', async () => {
    let now = 1_000;
    const store = new SecretKeyStore(60_000, () => now);
    const a = store.mint('sr_a');
    const env = await seal(webcrypto, a.publicKey, a.kid, { password: SECRET });
    expect(() => store.open(env as any, 'sr_b')).toThrow(/SECRET_SEAL_INVALID/);
    const b = store.mint('sr_b');
    const env2 = await seal(webcrypto, b.publicKey, b.kid, { password: SECRET });
    const ct = Buffer.from(env2.ct, 'base64');
    ct[0] ^= 1;
    try { store.open({ ...env2, ct: ct.toString('base64') } as any, 'sr_b'); throw new Error('opened'); } catch (e: any) {
      expect(e.message).toMatch(/SECRET_SEAL_INVALID/);
      expect(e.message).not.toContain(env2.ct.slice(0, 12));
    }
    const c = store.mint('sr_c');
    now += 61_000;
    const env3 = await seal(webcrypto, c.publicKey, c.kid, { password: SECRET });
    expect(store.has(c.kid)).toBe(false);
    expect(() => store.open(env3 as any, 'sr_c')).toThrow(/SECRET_SEAL_INVALID/);
  });

  it('classifies the transport: loopback direct, tunnel (https), refused plain-http LAN', () => {
    const loop = { remoteAddress: '127.0.0.1' };
    expect(classifySecretTransport({ headers: { host: '127.0.0.1:7420' }, socket: loop }).transport).toBe('local');
    expect(classifySecretTransport({ headers: { host: 'localhost:7420' }, socket: { remoteAddress: '::ffff:127.0.0.1' } }).transport).toBe('local');
    expect(classifySecretTransport({ headers: { host: 'abc.trycloudflare.com', 'x-forwarded-proto': 'https', 'cf-ray': '1' }, socket: loop }).transport).toBe('tunnel');
    expect(classifySecretTransport({ headers: { host: 'x.ngrok-free.app', 'x-forwarded-for': '1.2.3.4', 'x-forwarded-proto': 'https' }, socket: loop }).transport).toBe('tunnel');
    expect(classifySecretTransport({ headers: { host: '127.0.0.1:7420', 'x-forwarded-for': '1.2.3.4' }, socket: loop }).transport).toBe('refused');
    expect(classifySecretTransport({ headers: { host: 'evil.example' }, socket: loop }).transport).toBe('refused');
    const lan = classifySecretTransport({ headers: { host: '192.168.1.5:7420', 'x-forwarded-proto': 'https' }, socket: { remoteAddress: '192.168.1.20' } });
    expect(lan.transport).toBe('refused');
    expect(lan.reason).toMatch(/clear text/);
    expect(classifySecretTransport({ headers: { host: 'qodex.local' }, socket: { remoteAddress: '192.168.1.20', encrypted: true } }).transport).toBe('local');
  });
});
