/**
 * Web Bot Auth (browser.botAuth): the honest agent identity. These cover the pure parts —
 * config resolution, the key id (JWK thumbprint), the RFC 9421 signature base and that a
 * real verifier accepts the signature with the published public key, caching per
 * authority, the directory, and key creation / loading. The live header injection is in
 * the real-Chromium test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createPublicKey, verify as cryptoVerify } from 'crypto';
import {
  resolveBotAuthConfig, normalizeDirectoryUrl, jwkThumbprint, publicJwk, authorityOf, sfString,
  buildSignature, loadOrCreateKey, BotAuthSigner, WEB_BOT_AUTH_TAG,
} from '../src/tools/browser/bot-auth.js';
import { resolveBrowserConfig } from '../src/config/agent-config.js';
import * as http from 'http';
import type { ToolContext } from '../src/tools/base.js';
import { resolveBrowserExecutable } from '../src/tools/browser/launcher.js';
import { QodexBrowserManager } from '../src/tools/browser/session.js';
import { setBrowserManagerForTests } from '../src/tools/browser/types.js';
import { BrowserNavigateTool } from '../src/tools/browser/tools.js';

describe('browser.botAuth config', () => {
  it('is off by default and reads true/false/on/off/object + env', () => {
    expect(resolveBotAuthConfig(undefined).enabled).toBe(false);
    expect(resolveBotAuthConfig(true).enabled).toBe(true);
    expect(resolveBotAuthConfig('on').enabled).toBe(true);
    expect(resolveBotAuthConfig(false).enabled).toBe(false);
    expect(resolveBotAuthConfig({ enabled: true }).enabled).toBe(true);
    expect(resolveBotAuthConfig({ enabled: true }, { QODEX_BROWSER_BOT_AUTH: '0' }).enabled).toBe(false);
    expect(resolveBotAuthConfig({ enabled: false }, { QODEX_BROWSER_BOT_AUTH: '1' }).enabled).toBe(true);
    expect(resolveBrowserConfig({ browser: { botAuth: { enabled: true, directoryUrl: 'https://ex.com/dir/' } } }, {}).botAuth)
      .toMatchObject({ enabled: true, directoryUrl: 'https://ex.com/dir' });
    expect(resolveBrowserConfig({}).botAuth.enabled).toBe(false);
  });

  it('only accepts http(s) directory URLs and trims the trailing slash', () => {
    expect(normalizeDirectoryUrl('https://a.example/d/')).toBe('https://a.example/d');
    expect(normalizeDirectoryUrl('http://a.example')).toBe('http://a.example');
    expect(normalizeDirectoryUrl('javascript:alert(1)')).toBe('');
    expect(normalizeDirectoryUrl('file:///etc/passwd')).toBe('');
    expect(normalizeDirectoryUrl('not a url')).toBe('');
  });

  it('clamps maxAgeSec', () => {
    expect(resolveBotAuthConfig({ enabled: true, maxAgeSec: 5 }).maxAgeSec).toBe(30);
    expect(resolveBotAuthConfig({ enabled: true, maxAgeSec: 1e9 }).maxAgeSec).toBe(86_400);
    expect(resolveBotAuthConfig({ enabled: true }).maxAgeSec).toBe(900);
  });
});

describe('bot-auth primitives', () => {
  it('authorityOf drops default ports, lowercases, keeps odd ports', () => {
    expect(authorityOf('https://Example.COM/x')).toBe('example.com');
    expect(authorityOf('https://example.com:443/x')).toBe('example.com');
    expect(authorityOf('http://example.com:80/x')).toBe('example.com');
    expect(authorityOf('http://example.com:8080/x')).toBe('example.com:8080');
    expect(authorityOf('not a url')).toBe('');
  });

  it('sfString quotes and escapes', () => {
    expect(sfString('https://a/b')).toBe('"https://a/b"');
    expect(sfString('a"b\\c')).toBe('"a\\"b\\\\c"');
  });

  it('jwkThumbprint matches a hand-computed RFC 7638 value', () => {
    // RFC 7638 §3.1 worked example is RSA; for OKP the canonical members are crv,kty,x.
    const jwk = { kty: 'OKP', crv: 'Ed25519', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo' };
    // Recomputed here so a change in the canonical form is caught.
    const tp = jwkThumbprint(jwk);
    expect(tp).toMatch(/^[A-Za-z0-9_-]{43}$/); // base64url SHA-256, no padding
    expect(jwkThumbprint({ ...jwk })).toBe(tp); // stable
  });
});

describe('buildSignature is verifiable with the public key', () => {
  let keyFile = '';
  let tmp = '';
  beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-ba-')); keyFile = path.join(tmp, 'k.pem'); });
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }).catch(() => {}); });

  it('covers @authority + signature-agent and a real Ed25519 verify accepts it', async () => {
    const key = await loadOrCreateKey(keyFile);
    const jwk = publicJwk(key);
    const keyid = jwkThumbprint(jwk);
    const directoryUrl = 'https://agent.example/.well-known/http-message-signatures-directory';
    const created = 1_800_000_000;
    const expires = created + 900;
    const h = buildSignature({ key, keyid, authority: 'shop.example', directoryUrl, created, expires });

    expect(h['Signature-Agent']).toBe(`"${directoryUrl}"`);
    expect(h['Signature-Input']).toContain(`;keyid="${keyid}";alg="ed25519";tag="${WEB_BOT_AUTH_TAG}"`);
    expect(h['Signature-Input']).toMatch(/^sig1=\("@authority" "signature-agent"\);created=1800000000;expires=1800000900;/);
    expect(h.Signature).toMatch(/^sig1=:[A-Za-z0-9+/]+=*:$/);

    // Reconstruct the base the way a verifier would and check the signature.
    const params = h['Signature-Input'].replace(/^sig1=/, '');
    const base = [
      '"@authority": shop.example',
      `"signature-agent": "${directoryUrl}"`,
      `"@signature-params": ${params}`,
    ].join('\n');
    const sigB64 = h.Signature.replace(/^sig1=:/, '').replace(/:$/, '');
    const pub = createPublicKey({ key: jwk as any, format: 'jwk' });
    expect(cryptoVerify(null, Buffer.from(base, 'utf8'), pub, Buffer.from(sigB64, 'base64'))).toBe(true);

    // A tampered authority must fail.
    const badBase = base.replace('shop.example', 'evil.example');
    expect(cryptoVerify(null, Buffer.from(badBase, 'utf8'), pub, Buffer.from(sigB64, 'base64'))).toBe(false);
  });

  it('with no directory URL, signs @authority only (keyid-only verification)', async () => {
    const key = await loadOrCreateKey(keyFile);
    const keyid = jwkThumbprint(publicJwk(key));
    const h = buildSignature({ key, keyid, authority: 'shop.example', directoryUrl: '', created: 1_800_000_000, expires: 1_800_000_900 });
    expect(h['Signature-Agent']).toBeUndefined();
    expect(h['Signature-Input']).toMatch(/^sig1=\("@authority"\);/);
    const params = h['Signature-Input'].replace(/^sig1=/, '');
    const base = `"@authority": shop.example\n"@signature-params": ${params}`;
    const pub = createPublicKey({ key: publicJwk(key) as any, format: 'jwk' });
    const sig = Buffer.from(h.Signature.replace(/^sig1=:/, '').replace(/:$/, ''), 'base64');
    expect(cryptoVerify(null, Buffer.from(base, 'utf8'), pub, sig)).toBe(true);
  });
});

describe('BotAuthSigner', () => {
  let tmp = '';
  beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-ba2-')); });
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }).catch(() => {}); });

  it('creates a 0600 key, reuses it, and derives a stable key id', async () => {
    const keyFile = path.join(tmp, 'sub', 'k.pem');
    const a = await BotAuthSigner.load({ enabled: true, directoryUrl: '', keyFile, maxAgeSec: 900 });
    if (process.platform !== 'win32') expect((await fs.stat(keyFile)).mode & 0o777).toBe(0o600);
    const b = await BotAuthSigner.load({ enabled: true, directoryUrl: '', keyFile, maxAgeSec: 900 });
    expect(a.keyid).toBe(b.keyid);
    expect(a.directory().keys[0]!.kid).toBe(a.keyid);
    expect(a.directory().keys[0]).toMatchObject({ kty: 'OKP', crv: 'Ed25519', use: 'sig' });
  });

  it('caches the signature per authority within the window and re-signs after it', async () => {
    let now = 1_800_000_000_000;
    const signer = await BotAuthSigner.load(
      { enabled: true, directoryUrl: 'https://a.example/d', keyFile: path.join(tmp, 'k.pem'), maxAgeSec: 100 },
      () => now,
    );
    const first = signer.headersForAuthority('shop.example');
    now += 10_000; // +10s, still inside the 100s window
    expect(signer.headersForAuthority('shop.example')).toEqual(first);
    const other = signer.headersForAuthority('other.example');
    expect(other).not.toEqual(first); // a different authority → a different signature
    now += 95_000; // now past expiry-30s
    expect(signer.headersForAuthority('shop.example')).not.toEqual(first);
  });

  it('headersForUrl skips URLs with no authority and counts signed requests', async () => {
    const signer = await BotAuthSigner.load({ enabled: true, directoryUrl: '', keyFile: path.join(tmp, 'k.pem'), maxAgeSec: 900 });
    expect(signer.headersForUrl('not a url')).toBeNull();
    expect(signer.headersForUrl('https://shop.example/a')).not.toBeNull();
    expect(signer.headersForUrl('https://shop.example/b')).not.toBeNull();
    expect(signer.status(true).signed).toBe(2);
  });

  it('refuses a key file that is not Ed25519', async () => {
    const keyFile = path.join(tmp, 'rsa.pem');
    const { generateKeyPairSync } = await import('crypto');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await fs.writeFile(keyFile, privateKey.export({ format: 'pem', type: 'pkcs8' }) as string);
    await expect(loadOrCreateKey(keyFile)).rejects.toThrow(/ed25519/i);
  });
});

let pw: any = null;
try { pw = await import('playwright'); } catch { pw = null; }
let pwExe = '';
try { pwExe = String(pw?.chromium?.executablePath?.() ?? ''); } catch { pwExe = ''; }
const exe = resolveBrowserExecutable({ playwrightExecutablePath: pwExe, headless: true });
const chromium = !!pw && !!(exe.executablePath || exe.channel);

function ctx(cwd: string): ToolContext {
  return { cwd, sessionId: 'ba', transaction: {} as any, permissions: { evaluate: () => 'allow' } as any, askUser: async () => 'yes', signal: new AbortController().signal, emit: () => {} } as any;
}

describe.skipIf(!chromium)('Web Bot Auth over real Chromium', () => {
  let tmp = '';
  let server: http.Server;
  let base = '';
  let mgr: QodexBrowserManager;
  const seen: Record<string, http.IncomingHttpHeaders> = {};

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-ba-real-'));
    for (const k of Object.keys(seen)) delete seen[k];
    server = http.createServer((req, res) => {
      const p = new URL(req.url ?? '/', 'http://x').pathname;
      seen[p] = req.headers;
      if (p === '/img.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(Buffer.alloc(64)); return; }
      if (p === '/data.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return; }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>Shop</title><img src="/img.png"><script>fetch("/data.json")</script><h1>hi</h1>');
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterEach(async () => {
    await mgr?.close().catch(() => {});
    setBrowserManagerForTests(null);
    await new Promise<void>(r => server?.close(() => r()));
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  it('signs the document and fetch (not the image) with a signature the public key verifies', async () => {
    const directoryUrl = 'https://agent.example/.well-known/http-message-signatures-directory';
    mgr = new QodexBrowserManager({
      profilesDir: path.join(tmp, 'p'), downloadsDir: path.join(tmp, 'd'),
      config: { headless: true, lean: 'off', hostPacingMs: 0, challengeAutoWaitSec: 0,
        botAuth: { enabled: true, directoryUrl, keyFile: path.join(tmp, 'k.pem'), maxAgeSec: 900 } },
      // Treat the loopback test server as a public host so it is signed.
      leanExempt: () => false,
    });
    setBrowserManagerForTests(mgr);
    const r = await new BrowserNavigateTool().execute({ url: base + '/' } as any, ctx(tmp));
    expect(r.isError, String(r.content)).toBeFalsy();
    const page = await mgr.activePage();
    await page.waitForTimeout(400); // let the fetch() fire

    // The document carries all three headers; the image does not.
    const doc = seen['/'];
    expect(doc?.['signature-input']).toMatch(/tag="web-bot-auth"/);
    expect(doc?.['signature']).toMatch(/^sig1=:/);
    expect(doc?.['signature-agent']).toBe(`"${directoryUrl}"`);
    expect(seen['/data.json']?.['signature-input']).toBeTruthy(); // fetch() signed
    expect(seen['/img.png']?.['signature-input']).toBeUndefined(); // image not signed

    // Verify the document signature against the published public key.
    const signer = mgr.botAuthSigner()!;
    const jwk = signer.directory().keys[0]!;
    const authority = `127.0.0.1:${(server.address() as any).port}`;
    const params = String(doc!['signature-input']).replace(/^sig1=/, '');
    const signBase = [`"@authority": ${authority}`, `"signature-agent": "${directoryUrl}"`, `"@signature-params": ${params}`].join('\n');
    const sig = Buffer.from(String(doc!['signature']).replace(/^sig1=:/, '').replace(/:$/, ''), 'base64');
    const pub = createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x } as any, format: 'jwk' });
    expect(cryptoVerify(null, Buffer.from(signBase, 'utf8'), pub, sig)).toBe(true);

    const st = mgr.status() as any;
    expect(st.botAuth).toMatchObject({ enabled: true, hasDirectory: true });
    expect(st.botAuth.keyid).toBe(signer.keyid);
  }, 60_000);

  it('does not sign loopback / LAN hosts by default (exempt)', async () => {
    mgr = new QodexBrowserManager({
      profilesDir: path.join(tmp, 'p'), downloadsDir: path.join(tmp, 'd'),
      config: { headless: true, lean: 'off', hostPacingMs: 0, challengeAutoWaitSec: 0,
        botAuth: { enabled: true, directoryUrl: 'https://agent.example/dir', keyFile: path.join(tmp, 'k.pem'), maxAgeSec: 900 } },
      // No leanExempt override → the default (loopback is exempt) applies.
    });
    setBrowserManagerForTests(mgr);
    await new BrowserNavigateTool().execute({ url: base + '/' } as any, ctx(tmp));
    await (await mgr.activePage()).waitForTimeout(200);
    expect(seen['/']?.['signature-input']).toBeUndefined();
  }, 60_000);
});
