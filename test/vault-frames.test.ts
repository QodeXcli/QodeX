/**
 * browser_fill_secret must judge a field by the ORIGIN of the document it lives
 * in, not by its URL: an about:blank / srcdoc frame inherits the origin of the
 * frame that created it, so an ad iframe on a legitimate login page can build an
 * about:blank child with a password input and receive the secret.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { promises as fs, existsSync, readdirSync } from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { Vault, setVaultForTests } from '../src/vault/vault.js';
import { BrowserFillSecretTool } from '../src/vault/tools.js';
import { setBrowserManagerForTests } from '../src/tools/browser/types.js';
import type { ToolContext } from '../src/tools/base.js';

const SECRET = 'Tr0ub4dor-and-3';

function ctx(): ToolContext {
  return { cwd: os.tmpdir(), sessionId: 's', transaction: {} as any, permissions: {} as any, askUser: async () => 'no', emit: () => {} };
}

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-vault-frames-'));
  const vault = new Vault({ file: path.join(tmp, 'vault.json'), keyFile: path.join(tmp, '.vault-key') });
  setVaultForTests(vault);
  await vault.add({ name: 'site', origins: ['https://login.example.com'], username: 'me', secret: SECRET });
});
afterEach(async () => {
  setVaultForTests(null);
  setBrowserManagerForTests(null);
  await fs.rm(tmp, { recursive: true, force: true });
});

/** A fake manager whose single field lives in a document with the given href/origin. */
function managerWithField(doc: { href: string; origin?: string }) {
  const filled: string[] = [];
  const loc = {
    evaluate: async (fn: (el: any) => unknown) => fn({
      tagName: 'INPUT', getAttribute: (a: string) => (a === 'type' ? 'password' : null), isContentEditable: false,
      disabled: false, readOnly: false,
      ownerDocument: { location: { href: doc.href }, ...(doc.origin !== undefined ? { defaultView: { origin: doc.origin } } : {}) },
    }),
    fill: async (v: string) => { filled.push(v); },
  };
  setBrowserManagerForTests({
    isRunning: () => true, isTakeover: () => false, waitForTakeoverEnd: async () => {},
    activeUrl: () => 'https://login.example.com/signin', locator: async () => loc, recordAction: () => {},
  } as any);
  return filled;
}

const fill = (args: Record<string, unknown>) => new BrowserFillSecretTool().execute({ secret: 'site', field: 'password', ref: 'f1e2', ...args } as any, ctx());

describe('browser_fill_secret frame origin', () => {
  it('refuses an about:blank frame whose origin is another site', async () => {
    const filled = managerWithField({ href: 'about:blank', origin: 'https://ads.evil.example' });
    const r = await fill({});
    expect(r.content).toMatch(/^\[VAULT_ORIGIN_MISMATCH\]/);
    expect(filled).toEqual([]);
  });
  it('refuses a sandboxed (opaque-origin) frame', async () => {
    const filled = managerWithField({ href: 'about:srcdoc', origin: 'null' });
    const r = await fill({});
    expect(r.content).toMatch(/^\[VAULT_ORIGIN_MISMATCH\]/);
    expect(filled).toEqual([]);
  });
  it('refuses an about: frame when its origin is unknown', async () => {
    const filled = managerWithField({ href: 'about:blank' });
    expect((await fill({})).content).toMatch(/^\[VAULT_ORIGIN_MISMATCH\]/);
    expect(filled).toEqual([]);
  });
  it('fills an about:blank frame created by the site itself', async () => {
    const filled = managerWithField({ href: 'about:blank', origin: 'https://login.example.com' });
    const r = await fill({});
    expect(r.isError).toBeFalsy();
    expect(filled).toEqual([SECRET]);
  });
  it('a document whose URL looks right but whose origin differs is refused', async () => {
    // e.g. a blob:/data: document, or a document.domain trick — the origin decides.
    const filled = managerWithField({ href: 'https://login.example.com/frame', origin: 'https://evil.example' });
    expect((await fill({})).content).toMatch(/^\[VAULT_ORIGIN_MISMATCH\]/);
    expect(filled).toEqual([]);
  });
});

describe('shared-hosting tenants match exactly', () => {
  it('a login on one tenant is not offered to that tenant\'s "subdomains" (other people can own them)', async () => {
    const { matchOrigin, normalizeOrigin } = await import('../src/vault/vault.js');
    // S3 bucket names may contain dots: anyone can create bucket "evil.mybucket".
    expect(matchOrigin('https://evil.mybucket.s3.amazonaws.com/login', ['mybucket.s3.amazonaws.com']).ok).toBe(false);
    expect(matchOrigin('https://mybucket.s3.amazonaws.com/login', ['mybucket.s3.amazonaws.com']).ok).toBe(true);
    expect(matchOrigin('https://x.me.github.io/', ['me.github.io']).ok).toBe(false);
    expect(normalizeOrigin('me.vercel.app')).toMatchObject({ exact: true });
    // ordinary sites keep subdomain matching
    expect(matchOrigin('https://accounts.example.com/', ['example.com']).ok).toBe(true);
  });
});

// ── real Chromium ───────────────────────────────────────────────────────────

function findChromium(): string | null {
  const cands: string[] = [];
  if (process.env.QODEX_BROWSER_EXECUTABLE) cands.push(process.env.QODEX_BROWSER_EXECUTABLE);
  cands.push('/opt/pw-browsers/chromium');
  for (const base of [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers', path.join(os.homedir(), '.cache', 'ms-playwright')]) {
    if (!base || !existsSync(base)) continue;
    for (const d of readdirSync(base).filter(n => n.startsWith('chromium-')).sort().reverse()) {
      cands.push(path.join(base, d, 'chrome-linux', 'chrome'), path.join(base, d, 'chrome-linux64', 'chrome'));
    }
  }
  return cands.find(p => existsSync(p)) ?? null;
}

let playwright: any = null;
try { playwright = await import('playwright'); } catch { playwright = null; }
const chromium = playwright ? findChromium() : null;

describe('browser_fill_secret on a real page with nested frames', () => {
  let browser: any;
  let page: any;
  let main: http.Server;
  let ad: http.Server;
  let mainPort = 0;

  const listen = (s: http.Server) => new Promise<number>(res => s.listen(0, '127.0.0.1', () => res((s.address() as any).port)));

  beforeAll(async () => {
    if (!chromium) return;
    // The "ad" builds an about:blank child frame and a sandboxed srcdoc frame, each with a password box.
    ad = http.createServer((_q, r) => {
      r.setHeader('content-type', 'text/html');
      r.end(`<iframe id="inner"></iframe><script>document.getElementById('inner').contentDocument.body.innerHTML = '<input id="pw3" type="password">';</script>
        <iframe id="sb" sandbox srcdoc="<input id=pw4 type=password>"></iframe>`);
    });
    const adPort = await listen(ad);
    main = http.createServer((_q, r) => {
      r.setHeader('content-type', 'text/html');
      r.end(`<form><input id="pw" type="password"></form><iframe id="own"></iframe>
        <script>document.getElementById('own').contentDocument.body.innerHTML = '<input id="pw5" type="password">';</script>
        <iframe id="ad" src="http://localhost:${adPort}/"></iframe>`);
    });
    mainPort = await listen(main);
    browser = await playwright.chromium.launch({ executablePath: chromium, headless: true, args: ['--no-proxy-server'] });
    page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${mainPort}/login`);
    await page.frameLocator('#ad').frameLocator('#inner').locator('#pw3').waitFor({ state: 'attached' });
    await page.frameLocator('#ad').frameLocator('#sb').locator('#pw4').waitFor({ state: 'attached' });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    main?.close();
    ad?.close();
  });

  it.skipIf(!chromium)('fills its own about:blank frame but never the ad\'s nested or sandboxed frames', async () => {
    const vault = new Vault({ file: path.join(tmp, 'v2.json'), keyFile: path.join(tmp, '.k2') });
    setVaultForTests(vault);
    await vault.add({ name: 'site', origins: [`http://127.0.0.1:${mainPort}`], secret: SECRET });
    const frames: Record<string, () => any> = {
      own: () => page.frameLocator('#own').locator('#pw5'),
      nested: () => page.frameLocator('#ad').frameLocator('#inner').locator('#pw3'),
      sandboxed: () => page.frameLocator('#ad').frameLocator('#sb').locator('#pw4'),
    };
    setBrowserManagerForTests({
      isRunning: () => true, isTakeover: () => false, waitForTakeoverEnd: async () => {},
      activeUrl: () => page.url(), activePage: async () => page,
      locator: async ({ selector }: { selector?: string }) => (frames[selector!] ? frames[selector!]() : page.locator(selector!)),
      recordAction: () => {},
    } as any);
    const run = (selector: string) => new BrowserFillSecretTool().execute({ secret: 'site', field: 'password', selector } as any, ctx());

    expect((await run('#pw')).isError).toBeFalsy();
    expect((await run('own')).isError).toBeFalsy();
    expect(await frames.own().inputValue()).toBe(SECRET);

    const nested = await run('nested');
    expect(nested.content).toMatch(/^\[VAULT_ORIGIN_MISMATCH\]/);
    expect(await frames.nested().inputValue()).toBe('');

    const sandboxed = await run('sandboxed');
    expect(sandboxed.content).toMatch(/^\[VAULT_ORIGIN_MISMATCH\]/);
    expect(await frames.sandboxed().inputValue()).toBe('');
  }, 60_000);
});
