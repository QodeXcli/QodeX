import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { promises as fs, existsSync, readdirSync } from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { Vault, setVaultForTests } from '../src/vault/vault.js';
import { BrowserFillSecretTool, VaultListTool, VAULT_TOOL_CLASSES } from '../src/vault/tools.js';
import { totp } from '../src/vault/totp.js';
import { setBrowserManagerForTests, type BrowserActionRecord } from '../src/tools/browser/types.js';
import type { ToolContext } from '../src/tools/base.js';

const SECRET = 'C0rrect-Horse-Battery';
const SEED = 'JBSWY3DPEHPK3PXP';

function ctx(): ToolContext {
  return {
    cwd: os.tmpdir(), sessionId: 's', transaction: {} as any, permissions: {} as any,
    askUser: async () => 'no', emit: () => {},
  };
}

interface FakeField { tag: string; type?: string; href?: string; contentEditable?: boolean; disabled?: boolean }

function fakeManager(url: string, fields: Record<string, FakeField>, opts: { running?: boolean } = {}) {
  const filled: Array<{ target: string; value: string; at: number }> = [];
  const records: BrowserActionRecord[] = [];
  const makeLoc = (key: string) => ({
    evaluate: async (fn: (el: any) => unknown) => {
      const f = fields[key];
      if (!f) throw new Error(`[STALE_REF] ref ${key} not found — call browser_snapshot again`);
      return fn({ tagName: f.tag.toUpperCase(), getAttribute: (a: string) => (a === 'type' ? f.type ?? null : null), isContentEditable: !!f.contentEditable, disabled: !!f.disabled, readOnly: false, ownerDocument: { location: { href: f.href ?? url } } });
    },
    fill: async (value: string) => { filled.push({ target: key, value, at: Date.now() }); },
    isVisible: async () => true,
    count: async () => 1,
    nth: () => makeLoc(key),
  });
  const mgr = {
    isRunning: () => opts.running ?? true,
    isTakeover: () => false,
    waitForTakeoverEnd: async () => {},
    activeUrl: () => url,
    locator: async (t: { ref?: string; selector?: string }) => {
      const key = t.ref ?? t.selector ?? '';
      if (!fields[key]) throw new Error(`[STALE_REF] ref ${key} not found — call browser_snapshot again`);
      return makeLoc(key);
    },
    activePage: async () => ({
      locator: (sel: string) => {
        const key = Object.keys(fields).find(k => k === sel || sel.includes(k));
        return key ? makeLoc(key) : { count: async () => 0, nth: () => null };
      },
    }),
    recordAction: (r: BrowserActionRecord) => { records.push(r); },
  };
  return { mgr: mgr as any, filled, records };
}

let tmp: string;
let vault: Vault;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-vault-tools-'));
  vault = new Vault({ file: path.join(tmp, 'vault.json'), keyFile: path.join(tmp, '.vault-key') });
  setVaultForTests(vault);
  await vault.add({ name: 'github', origins: ['github.com'], username: 'octo@example.com', secret: SECRET, totp: SEED });
  await vault.add({ name: 'nopass-totp', origins: ['x.example'], secret: 'zzz' });
});
afterEach(async () => {
  setVaultForTests(null);
  setBrowserManagerForTests(null);
  await fs.rm(tmp, { recursive: true, force: true });
});

const fill = (args: Record<string, unknown>) => new BrowserFillSecretTool().execute(new BrowserFillSecretTool().argsSchema.parse(args), ctx());

describe('browser_fill_secret', () => {
  it('fills the password on the right site and never returns it', async () => {
    const f = fakeManager('https://github.com/login', { e2: { tag: 'input', type: 'password' } });
    setBrowserManagerForTests(f.mgr);
    const r = await fill({ secret: 'github', field: 'password', ref: 'e2' });
    expect(r.isError).toBeFalsy();
    expect(f.filled).toEqual([{ target: 'e2', value: SECRET, at: expect.any(Number) }]);
    expect(r.content).not.toContain(SECRET);
    expect(r.content).toMatch(/^✓ Filled the password from vault entry "github" into ref e2 on github\.com/);
    expect(f.records).toHaveLength(1);
    expect(f.records[0].args).toMatchObject({ secret: 'github', field: 'password', value: '***' });
    expect(JSON.stringify(f.records)).not.toContain(SECRET);
    expect(f.records[0].element?.isPassword).toBe(true);
  });

  it('refuses other sites (anti-phishing) and plain http', async () => {
    for (const url of ['https://github.com.evil.io/login', 'https://gitHub-login.example/', 'http://github.com/login']) {
      const f = fakeManager(url, { e2: { tag: 'input', type: 'password' } });
      setBrowserManagerForTests(f.mgr);
      const r = await fill({ secret: 'github', field: 'password', ref: 'e2' });
      expect(r.content).toMatch(/^\[VAULT_ORIGIN_MISMATCH\]/);
      expect(f.filled).toEqual([]);
    }
  });

  it('re-checks the site right before typing (redirect race)', async () => {
    const f = fakeManager('https://github.com/login', { e2: { tag: 'input', type: 'password' } });
    const urls = ['https://github.com/login'];
    f.mgr.activeUrl = () => urls.shift() ?? 'https://github-login.evil.example/';
    setBrowserManagerForTests(f.mgr);
    const r = await fill({ secret: 'github', field: 'password', ref: 'e2' });
    expect(r.content).toMatch(/^\[VAULT_ORIGIN_MISMATCH\] The page navigated away/);
    expect(f.filled).toEqual([]);
  });

  it('refuses a field inside a cross-origin frame', async () => {
    const f = fakeManager('https://github.com/login', { f1e2: { tag: 'input', type: 'password', href: 'https://ads.example/frame' } });
    setBrowserManagerForTests(f.mgr);
    const r = await fill({ secret: 'github', field: 'password', ref: 'f1e2' });
    expect(r.content).toMatch(/^\[VAULT_ORIGIN_MISMATCH\].*frame from another site/);
    expect(f.filled).toEqual([]);
  });

  it('only fills the right kind of field', async () => {
    const f = fakeManager('https://github.com/x', {
      text: { tag: 'input', type: 'text' }, area: { tag: 'textarea' }, rich: { tag: 'div', contentEditable: true },
      email: { tag: 'input', type: 'email' }, off: { tag: 'input', type: 'password', disabled: true },
    });
    setBrowserManagerForTests(f.mgr);
    expect((await fill({ secret: 'github', field: 'password', ref: 'text' })).content).toMatch(/^\[VAULT_FIELD_MISMATCH\] A password is only filled into a password input/);
    expect((await fill({ secret: 'github', field: 'username', ref: 'area' })).content).toMatch(/^\[VAULT_FIELD_MISMATCH\]/);
    expect((await fill({ secret: 'github', field: 'username', ref: 'rich' })).content).toMatch(/^\[VAULT_FIELD_MISMATCH\]/);
    expect((await fill({ secret: 'github', field: 'password', ref: 'off' })).content).toMatch(/disabled/);
    expect(f.filled).toEqual([]);
    expect((await fill({ secret: 'github', field: 'username', ref: 'email' })).isError).toBeFalsy();
    expect(f.filled[0].value).toBe('octo@example.com');
  });

  it('fills a fresh TOTP code', async () => {
    const f = fakeManager('https://github.com/sessions/two-factor', { otp: { tag: 'input', type: 'text' } });
    setBrowserManagerForTests(f.mgr);
    const r = await fill({ secret: 'github', field: 'totp', ref: 'otp' });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('current one-time code');
    expect(f.filled[0].value).toMatch(/^\d{6}$/);
    expect(f.filled[0].value).toBe(totp(SEED, { time: f.filled[0].at }));
    expect(r.content).not.toContain(f.filled[0].value);
  }, 10_000);

  it('auto-detects the field when no ref is given', async () => {
    const f = fakeManager('https://github.com/login', { 'input[type="password"]': { tag: 'input', type: 'password' } });
    setBrowserManagerForTests(f.mgr);
    const r = await fill({ secret: 'github', field: 'password' });
    expect(r.isError).toBeFalsy();
    expect(f.filled[0].value).toBe(SECRET);
  });

  it('clear errors: unknown entry, missing field, stale ref, no browser', async () => {
    const f = fakeManager('https://github.com/login', { e2: { tag: 'input', type: 'password' } });
    setBrowserManagerForTests(f.mgr);
    expect((await fill({ secret: 'gitlab', field: 'password', ref: 'e2' })).content).toMatch(/^\[VAULT_NOT_FOUND\] No vault entry named "gitlab". Available: github, nopass-totp/);
    expect((await fill({ secret: 'nopass-totp', field: 'totp', ref: 'e2' })).content).toMatch(/^\[VAULT_FIELD_MISSING\]/);
    expect((await fill({ secret: 'github', field: 'password', ref: 'e99' })).content).toMatch(/^\[STALE_REF\]/);
    setBrowserManagerForTests(fakeManager('', {}, { running: false }).mgr);
    expect((await fill({ secret: 'github', field: 'password', ref: 'e2' })).content).toMatch(/^\[BROWSER_ERROR\] The browser is not open/);
  });
});

describe('vault_list', () => {
  it('lists names, sites and fields but no values', async () => {
    const r = await new VaultListTool().execute({}, ctx());
    expect(r.content).toContain('- github — sites: github.com — fields: username, password, totp');
    expect(r.content).toContain('- nopass-totp — sites: x.example — fields: password');
    expect(r.content).not.toContain(SECRET);
    expect(r.content).not.toContain('octo@example.com');
    expect(r.content).not.toContain(SEED);
  });
  it('explains how to add entries when empty', async () => {
    setVaultForTests(new Vault({ file: path.join(tmp, 'empty.json'), keyFile: path.join(tmp, '.k2') }));
    expect((await new VaultListTool().execute({}, ctx())).content).toContain('qodex vault add');
  });
  it('exports tool classes with valid names and object schemas', () => {
    for (const C of VAULT_TOOL_CLASSES) {
      const t = new C();
      expect(t.name).toMatch(/^[a-z0-9_]+$/);
      expect(t.schema().function.parameters.type).toBe('object');
    }
    expect(new BrowserFillSecretTool().schema().function.parameters.required).toEqual(['secret', 'field']);
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

describe('browser_fill_secret on a real page', () => {
  let browser: any;
  let page: any;
  let main: http.Server;
  let other: http.Server;
  let mainPort = 0;
  let otherPort = 0;

  const listen = (s: http.Server) => new Promise<number>(res => s.listen(0, '127.0.0.1', () => res((s.address() as any).port)));

  beforeAll(async () => {
    if (!chromium) return;
    other = http.createServer((_q, r) => { r.setHeader('content-type', 'text/html'); r.end('<input id="pw2" type="password">'); });
    otherPort = await listen(other);
    main = http.createServer((_q, r) => {
      r.setHeader('content-type', 'text/html');
      r.end(`<form><input id="user" name="username" autocomplete="username"><input id="pw" type="password"><textarea id="note"></textarea></form>
        <iframe id="ad" src="http://127.0.0.1:${otherPort}/"></iframe>`);
    });
    mainPort = await listen(main);
    browser = await playwright.chromium.launch({ executablePath: chromium, headless: true, args: ['--no-proxy-server'] });
    page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${mainPort}/login`);
    await page.frameLocator('#ad').locator('#pw2').waitFor();
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    main?.close();
    other?.close();
  });

  it.skipIf(!chromium)('fills the main form, refuses the cross-origin iframe and the textarea', async () => {
    await vault.add({ name: 'local', origins: [`http://127.0.0.1:${mainPort}`], username: 'dev', secret: SECRET });
    const records: BrowserActionRecord[] = [];
    setBrowserManagerForTests({
      isRunning: () => true, isTakeover: () => false, waitForTakeoverEnd: async () => {},
      activeUrl: () => page.url(), activePage: async () => page,
      locator: async ({ selector }: { selector?: string }) => (selector!.startsWith('frame:') ? page.frameLocator('#ad').locator(selector!.slice(6)) : page.locator(selector!)),
      recordAction: (r: BrowserActionRecord) => { records.push(r); },
    } as any);

    const ok = await fill({ secret: 'local', field: 'password', selector: '#pw' });
    expect(ok.isError).toBeFalsy();
    expect(await page.inputValue('#pw')).toBe(SECRET);

    const user = await fill({ secret: 'local', field: 'username' });
    expect(user.isError).toBeFalsy();
    expect(await page.inputValue('#user')).toBe('dev');

    const framed = await fill({ secret: 'local', field: 'password', selector: 'frame:#pw2' });
    expect(framed.content).toMatch(/^\[VAULT_ORIGIN_MISMATCH\]/);
    expect(await page.frameLocator('#ad').locator('#pw2').inputValue()).toBe('');

    const area = await fill({ secret: 'local', field: 'password', selector: '#note' });
    expect(area.content).toMatch(/^\[VAULT_FIELD_MISMATCH\]/);
    expect(await page.inputValue('#note')).toBe('');
    expect(records.map(r => r.args.value)).toEqual(['***', '***']);
  }, 60_000);
});
