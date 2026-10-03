/**
 * V2 control-center secret routes + dashboard panels.
 *
 * What must hold:
 *   - only the FULL token may enter or manage secrets (a scoped link is refused);
 *   - loopback: sealed or plain accepted; tunnel (proxy headers, https): plaintext
 *     refused, sealed accepted; plain-http LAN: refused outright;
 *   - a typed secret reaches the vault and nowhere else: not a response, the bus,
 *     the ApprovalBroker, the server log path or an error message;
 *   - the vault panel lists summaries only (masked usernames), add/rotate need a
 *     key bound to that operation + entry, delete needs the name repeated;
 *   - real Chromium: the dashboard's form seals the secret in the page (local and
 *     tunnel), the vault panel adds an entry, nothing secret is posted in clear.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { webcrypto } from 'node:crypto';
import { Vault } from '../src/vault/vault.js';
import { SecretRequestBroker, setSecretRequestBrokerForTests } from '../src/vault/requests.js';
import { SECRET_SEAL_JS } from '../src/control/secret-crypto.js';
import { handleSecretRoute, isSecretRoute, resetSecretRoutesForTests, setSecretRoutesVaultForTests } from '../src/control/secret-routes.js';
import { renderDashboard, DASHBOARD_STRINGS } from '../src/control/dashboard.js';
import { startControlCenter, stopControlCenter, splitUrl, type ControlCenterInfo } from '../src/control/server.js';
import { getBus } from '../src/control/bus.js';
import { getApprovalBroker } from '../src/control/approvals.js';
import { resolveBrowserExecutable } from '../src/tools/browser/launcher.js';

const SECRET = 'Tr0ub4dor&3-horse-staple';
const SECRET2 = 'n3w-Pa55word-rotated!';
const SEED = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const TOKEN = 'vault-entry-control-token-0123456789';

const seal = new Function(`${SECRET_SEAL_JS}; return qxSealSecret;`)() as (c: unknown, pub: string, kid: string, obj: unknown) => Promise<Record<string, string>>;

let tmp: string;
let vault: Vault;
let broker: SecretRequestBroker;
let detach: () => void;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-v2-control-'));
  vault = new Vault({ file: path.join(tmp, 'vault.json'), keyFile: path.join(tmp, '.vault-key') });
  broker = new SecretRequestBroker(() => vault);
  setSecretRequestBrokerForTests(broker);
  setSecretRoutesVaultForTests(() => vault);
  resetSecretRoutesForTests();
  detach = broker.attachSurface('control');
  getBus().reset();
  getApprovalBroker().reset();
});

afterEach(async () => {
  detach();
  broker.reset();
  setSecretRequestBrokerForTests(null);
  setSecretRoutesVaultForTests(null);
  await fs.rm(tmp, { recursive: true, force: true });
});

/** Everything that left the process or could be logged must not hold a secret. */
function expectNoLeak(...extra: string[]): void {
  const surfaces = [
    JSON.stringify(getBus().recent(500)),
    JSON.stringify(getApprovalBroker().pending()),
    JSON.stringify(broker.pending()),
    ...extra,
  ].join('\n');
  for (const s of [SECRET, SECRET2, SEED]) expect(surfaces).not.toContain(s);
}

interface Resp { status: number; text: string; json: any }

function call(port: number, method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path: p,
      headers: { authorization: `Bearer ${TOKEN}`, ...(data ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(data)) } : {}), ...headers },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: any = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode ?? 0, text, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** A bare server that hands every request to handleSecretRoute (remote address / auth overridable). */
async function harness(opts: { remote?: string; authVia?: string } = {}): Promise<{ port: number; close: () => Promise<void> }> {
  const srv = http.createServer((req, res) => {
    if (opts.remote) Object.defineProperty(req.socket, 'remoteAddress', { value: opts.remote, configurable: true });
    const { path: p, query } = splitUrl(req.url ?? '/');
    void handleSecretRoute({ req, res, path: p, query, method: String(req.method), authVia: opts.authVia ?? 'bearer' });
  });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  return { port, close: () => new Promise<void>(r => { srv.closeAllConnections?.(); srv.close(() => r()); }) };
}

const TUNNEL = { host: 'abc-def.trycloudflare.com', 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https' };

function ask(fields: Array<'username' | 'password' | 'totp'> = ['username', 'password']) {
  return broker.request({ entryName: 'github', origins: ['github.com'], fields, reason: 'log in to open the repo', usernameHint: 'octo@example.com', timeoutMs: 20_000 });
}

async function pendingWithSeal(port: number, headers: Record<string, string> = {}) {
  for (let i = 0; i < 50 && !broker.pending().length; i++) await new Promise(r => setTimeout(r, 10));
  const r = await call(port, 'GET', '/api/secrets', undefined, headers);
  expect(r.status).toBe(200);
  return r.json as { transport: string; requests: Array<{ id: string; displayHost: string; seal?: { kid: string; publicKey: string } }> };
}

describe('secret routes', () => {
  it('owns /api/secrets and /api/vault only', () => {
    expect(isSecretRoute('/api/secrets')).toBe(true);
    expect(isSecretRoute('/api/secrets/sr_x')).toBe(true);
    expect(isSecretRoute('/api/vault/add')).toBe(true);
    expect(isSecretRoute('/api/vaults')).toBe(false);
    expect(isSecretRoute('/api/state')).toBe(false);
  });

  it('loopback: a sealed answer lands in the vault and nowhere else; the key is single use', async () => {
    const h = await harness();
    try {
      const pending = ask();
      const list = await pendingWithSeal(h.port);
      expect(list.transport).toBe('local');
      const req0 = list.requests[0]!;
      expect(req0.displayHost).toBe('github.com');
      const sealed = await seal(webcrypto, req0.seal!.publicKey, req0.seal!.kid, { username: 'octo@example.com', password: SECRET });
      const r = await call(h.port, 'POST', `/api/secrets/${req0.id}`, { sealed });
      expect(r.status).toBe(200);
      expect(r.json.saved.name).toBe('github');
      const res = await pending;
      expect(res).toMatchObject({ ok: true, by: 'control' });
      expect((await vault.get('github'))?.secret).toBe(SECRET);
      // replaying the same envelope fails (request gone; key consumed)
      const again = await call(h.port, 'POST', `/api/secrets/${req0.id}`, { sealed });
      expect(again.status).toBe(404);
      expectNoLeak(r.text, again.text, JSON.stringify(res));
    } finally { await h.close(); }
  });

  it('tunnel: plaintext is refused, a sealed answer works, a bad 2FA key never echoes', async () => {
    const h = await harness();
    try {
      const pending = ask(['username', 'password', 'totp']);
      const list = await pendingWithSeal(h.port, TUNNEL);
      expect(list.transport).toBe('tunnel');
      const id = list.requests[0]!.id;
      const plain = await call(h.port, 'POST', `/api/secrets/${id}`, { password: SECRET }, TUNNEL);
      expect(plain.status).toBe(400);
      expect(plain.json.error).toMatch(/SECRET_SEAL_REQUIRED/);
      // bad TOTP: request stays open, error scrubbed
      let s = (await pendingWithSeal(h.port, TUNNEL)).requests[0]!.seal!;
      const bad = await call(h.port, 'POST', `/api/secrets/${id}`, { sealed: await seal(webcrypto, s.publicKey, s.kid, { password: SECRET, totp: 'not!a!valid!seed!0189' }) }, TUNNEL);
      expect(bad.status).toBe(400);
      expect(bad.text).not.toContain('not!a!valid');
      // a fresh key is minted for the next try
      const s2 = (await pendingWithSeal(h.port, TUNNEL)).requests[0]!.seal!;
      expect(s2.kid).not.toBe(s.kid);
      s = s2;
      const ok = await call(h.port, 'POST', `/api/secrets/${id}`, { sealed: await seal(webcrypto, s.publicKey, s.kid, { password: SECRET, totp: SEED }) }, TUNNEL);
      expect(ok.status).toBe(200);
      expect((await pending).ok).toBe(true);
      const e = await vault.get('github');
      expect(e?.secret).toBe(SECRET);
      expect(e?.totp).toBe(SEED);
      expectNoLeak(plain.text, bad.text, ok.text);
    } finally { await h.close(); }
  });

  it('plain-http LAN is refused (no seal key offered), but the human can still cancel', async () => {
    const h = await harness({ remote: '192.168.1.23' });
    try {
      const pending = ask();
      const list = await pendingWithSeal(h.port);
      expect(list.transport).toBe('refused');
      expect(list.requests[0]!.seal).toBeUndefined();
      const id = list.requests[0]!.id;
      const r = await call(h.port, 'POST', `/api/secrets/${id}`, { password: SECRET });
      expect(r.status).toBe(403);
      expect(r.json.error).toMatch(/SECRET_TRANSPORT_REFUSED/);
      const v = await call(h.port, 'POST', '/api/vault/add', { name: 'x', origins: 'x.com', password: SECRET });
      expect(v.status).toBe(403);
      expect((await call(h.port, 'GET', '/api/vault')).json).toMatchObject({ transport: 'refused', entries: [] });
      expect((await call(h.port, 'GET', '/api/vault/key?op=add&name=x')).status).toBe(403);
      const c = await call(h.port, 'POST', `/api/secrets/${id}`, { cancel: true });
      expect(c.status).toBe(200);
      expect(await pending).toMatchObject({ ok: false, code: 'cancelled', by: 'control' });
      expect(await vault.list()).toEqual([]);
      expectNoLeak(r.text, v.text);
    } finally { await h.close(); }
  });

  it('a scoped (non full-token) credential is refused for every secret route', async () => {
    const h = await harness({ authVia: 'handoff' });
    try {
      for (const [m, p] of [['GET', '/api/secrets'], ['GET', '/api/vault'], ['POST', '/api/vault/add']] as const) {
        const r = await call(h.port, m, p, m === 'POST' ? { name: 'a', origins: 'a.com', password: SECRET } : undefined);
        expect(r.status).toBe(403);
        expect(r.json.error).toMatch(/SECRET_SCOPE/);
      }
    } finally { await h.close(); }
  });

  it('vault panel: add (sealed, bound key), list masked, rotate, edit, guarded delete; errors scrubbed', async () => {
    const h = await harness();
    try {
      const key = async (op: string, name: string) => (await call(h.port, 'GET', `/api/vault/key?op=${op}&name=${encodeURIComponent(name)}`)).json as { kid: string; publicKey: string };
      // a key minted for another entry does not open
      let k = await key('add', 'other');
      const wrong = await call(h.port, 'POST', '/api/vault/add', { name: 'gh', origins: 'github.com', sealed: await seal(webcrypto, k.publicKey, k.kid, { username: 'octocat@example.com', password: SECRET }) });
      expect(wrong.status).toBe(400);
      expect(wrong.json.error).toMatch(/SECRET_SEAL_INVALID/);
      k = await key('add', 'gh');
      const add = await call(h.port, 'POST', '/api/vault/add', { name: 'gh', origins: 'github.com', sealed: await seal(webcrypto, k.publicKey, k.kid, { username: 'octocat@example.com', password: SECRET, totp: SEED }) });
      expect(add.status).toBe(200);
      const list = await call(h.port, 'GET', '/api/vault');
      expect(list.json.entries).toEqual([expect.objectContaining({ name: 'gh', origins: ['github.com'], user: 'oc***@example.com', fields: { username: true, password: true, totp: true } })]);
      expect(list.text).not.toContain('octocat');
      // plain over loopback is accepted (the page seals anyway)
      const dup = await call(h.port, 'POST', '/api/vault/add', { name: 'gh', origins: 'github.com', password: SECRET2 });
      expect(dup.status).toBe(409);
      // a bad 2FA key on rotate is scrubbed
      k = await key('rotate', 'gh');
      const badTotp = await call(h.port, 'POST', '/api/vault/rotate', { name: 'gh', sealed: await seal(webcrypto, k.publicKey, k.kid, { totp: 'zz!!bad-seed-zz' }) });
      expect(badTotp.status).toBe(400);
      expect(badTotp.text).not.toContain('bad-seed');
      k = await key('rotate', 'gh');
      const rot = await call(h.port, 'POST', '/api/vault/rotate', { name: 'gh', sealed: await seal(webcrypto, k.publicKey, k.kid, { password: SECRET2 }) });
      expect(rot.status).toBe(200);
      const e = await vault.get('gh');
      expect(e).toMatchObject({ secret: SECRET2, username: 'octocat@example.com', totp: SEED });
      // edit never takes a secret
      expect((await call(h.port, 'POST', '/api/vault/edit', { name: 'gh', password: SECRET })).status).toBe(400);
      const ed = await call(h.port, 'POST', '/api/vault/edit', { name: 'gh', origins: 'github.com, gist.github.com' });
      expect(ed.status).toBe(200);
      expect((await vault.get('gh'))?.origins).toEqual(['github.com', 'gist.github.com']);
      expect((await call(h.port, 'POST', '/api/vault/remove', { name: 'gh' })).status).toBe(400);
      expect((await call(h.port, 'POST', '/api/vault/remove', { name: 'gh', confirm: 'GH' })).status).toBe(200);
      expect(await vault.list()).toEqual([]);
      expectNoLeak(wrong.text, add.text, list.text, dup.text, badTotp.text, rot.text, ed.text);
    } finally { await h.close(); }
  });
});

describe('dashboard panels', () => {
  it('renders the request + vault panels, both languages, the shared sealing code', () => {
    const html = renderDashboard({ lang: 'fa' });
    expect(html).toMatch(/id="secretsPanel" class="panel hidden"/);
    expect(html).toContain('id="vaultPanel"');
    expect(html).toContain('function qxSealSecret');
    expect(html).toContain("'/api/secrets'");
    expect(DASHBOARD_STRINGS.fa.secRefused).toBeTruthy();
    expect(DASHBOARD_STRINGS.en.vaultConfirmDelete).toContain('{name}');
    const code = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/)![1]!;
    expect(() => new Function(code)).not.toThrow();
    // plaintext is only ever sent where the server said "local"
    expect(code).toMatch(/if \(transport === 'local'\) return Promise\.resolve\(payload\);/);
  });
});

// ── real Chromium against the real control center ───────────────────────────

let pw: any = null;
try { pw = await import('playwright'); } catch { pw = null; }
let pwExe = '';
try { pwExe = String(pw?.chromium?.executablePath?.() ?? ''); } catch { pwExe = ''; }
const exe = pw ? resolveBrowserExecutable({ playwrightExecutablePath: pwExe, headless: true }) : { executablePath: undefined, channel: undefined };
const haveChromium = !!pw && !!(exe.executablePath || exe.channel);

describe.skipIf(!haveChromium)('dashboard secret form in a real browser', () => {
  let info: ControlCenterInfo;
  let viewer: any;

  beforeAll(async () => {
    info = await startControlCenter({ port: 0, token: TOKEN, lang: 'en' });
    viewer = await pw.chromium.launch({ headless: true, executablePath: exe.executablePath, channel: exe.executablePath ? undefined : exe.channel, args: ['--no-proxy-server'] });
  }, 60_000);

  afterAll(async () => {
    await viewer?.close().catch(() => {});
    await stopControlCenter();
  });

  async function open(extraHeaders?: Record<string, string>) {
    const ctx = await viewer.newContext();
    const page = await ctx.newPage();
    const posted: string[] = [];
    page.on('request', (r: any) => { if (r.method() === 'POST') posted.push(String(r.postData() ?? '')); });
    await page.goto(`http://127.0.0.1:${info.port}/?k=${TOKEN}`);
    await page.waitForSelector('#vaultPanel');
    if (extraHeaders) await page.setExtraHTTPHeaders(extraHeaders);
    return { ctx, page, posted };
  }

  it('the human types a requested login: sealed in the page, saved, nothing in clear (local and tunnel)', async () => {
    for (const headers of [undefined, { 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.9' }]) {
      const { ctx, page, posted } = await open(headers);
      try {
        // the control-center probe (set by startControlCenter) makes the form a surface on its own
        await startControlCenter({ token: TOKEN });
        detach();
        const pending = ask();
        await page.waitForSelector('#secretsPanel:not(.hidden) .scard input[type=password]', { timeout: 10_000 });
        expect(await page.textContent('#secretList')).toContain('github.com');
        await page.fill('.scard input[type=password]', headers ? SECRET2 : SECRET);
        await page.click('.scard button[type=submit]');
        const res = await pending;
        expect(res).toMatchObject({ ok: true, by: 'control' });
        expect((await vault.get('github'))?.secret).toBe(headers ? SECRET2 : SECRET);
        await page.waitForSelector('#secretsPanel.hidden', { state: 'attached' });
        const secretPost = posted.find(p => p.includes('"sealed"'));
        expect(secretPost).toBeTruthy();
        expectNoLeak(posted.join('\n'), await page.content());
        detach = broker.attachSurface('control');
      } finally { await ctx.close(); }
    }
  }, 60_000);

  it('the vault panel adds an entry through a sealed form and lists it masked', async () => {
    const { ctx, page, posted } = await open();
    try {
      await page.click('#vaultAddBox summary');
      await page.fill('#vaName', 'shop');
      await page.fill('#vaSites', 'shop.example.com');
      await page.fill('#vaUser', 'alice@example.com');
      await page.fill('#vaPass', SECRET);
      await page.click('#vaultAddForm button[type=submit]');
      await page.waitForSelector('#vaultList > :not(.empty)', { timeout: 10_000 });
      expect(await page.textContent('#vaultList')).toContain('shop.example.com');
      expect(await page.textContent('#vaultList')).toContain('al***@example.com');
      expect(await page.inputValue('#vaPass')).toBe('');
      expect((await vault.get('shop'))).toMatchObject({ secret: SECRET, username: 'alice@example.com' });
      expect(posted.some(p => p.includes('"sealed"'))).toBe(true);
      expectNoLeak(posted.join('\n'), await page.content());
    } finally { await ctx.close(); }
  }, 60_000);
});
