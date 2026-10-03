/**
 * vault_generate_and_fill and browser_login — fake managers for the failure paths, a real
 * Chromium on local pages for the flows. Every test checks that no password / seed reaches
 * a tool result (what the bus, audit log and session store get), a progress event, an
 * action record (the recorder / live view) or the console.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { promises as fs, existsSync, readdirSync } from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { Vault, setVaultForTests } from '../src/vault/vault.js';
import { VaultGenerateAndFillTool, generatePassword } from '../src/vault/tools.js';
import { BrowserLoginTool, resetLoginFailuresForTests } from '../src/vault/login.js';
import { totp } from '../src/vault/totp.js';
import { setBrowserManagerForTests } from '../src/tools/browser/types.js';
import type { ToolContext, ToolResult } from '../src/tools/base.js';

const PASS = 'Corr3ct-Horse-Battery';
const PASS2 = 'Otp-Acc0unt-Secret!';
const OLD = 'Old-Passw0rd-Value';
const SEED = 'JBSWY3DPEHPK3PXPJBSWY3DP';

let tmp: string;
let vault: Vault;
let events: unknown[];
let records: unknown[];
let results: ToolResult[];
let logged: unknown[];

function ctx(): ToolContext {
  return { cwd: os.tmpdir(), sessionId: 's', transaction: {} as any, permissions: {} as any, askUser: async () => 'no', emit: (e: unknown) => { events.push(e); } } as any;
}

/** Everything a secret could leak into, serialized. */
function leakSurface(): string {
  return JSON.stringify({ results, events, records, logged });
}
function expectNoLeak(...secrets: string[]): void {
  const blob = leakSurface();
  for (const s of secrets) expect(blob).not.toContain(s);
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-vault-login-'));
  vault = new Vault({ file: path.join(tmp, 'vault.json'), keyFile: path.join(tmp, '.vault-key') });
  setVaultForTests(vault);
  resetLoginFailuresForTests();
  events = []; records = []; results = []; logged = [];
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
  }
});
afterEach(async () => {
  vi.restoreAllMocks();
  setVaultForTests(null);
  setBrowserManagerForTests(null);
  await fs.rm(tmp, { recursive: true, force: true });
});

const generate = async (args: Record<string, unknown>) => {
  const r = await new VaultGenerateAndFillTool().execute(args as any, ctx());
  results.push(r);
  return r;
};
const login = async (args: Record<string, unknown>) => {
  const r = await new BrowserLoginTool().execute(args as any, ctx());
  results.push(r);
  return r;
};

// ── fake manager: refusals and rollback ─────────────────────────────────────

function fakeManager(url: string, opts: { failFill?: boolean } = {}) {
  const typed: string[] = [];
  const field = (id: string) => ({
    evaluate: async (fn: (el: any) => unknown) => fn({
      tagName: 'INPUT', getAttribute: (a: string) => (a === 'type' ? 'password' : a === 'autocomplete' ? 'new-password' : a === 'name' ? id : null),
      isContentEditable: false, disabled: false, readOnly: false, maxLength: -1, minLength: 0,
      ownerDocument: { location: { href: url }, defaultView: { origin: new URL(url).origin } },
    }),
    fill: async (v: string) => {
      typed.push(v);
      if (opts.failFill) throw new Error(`element detached while typing "${v}"`);
    },
  });
  setBrowserManagerForTests({
    isRunning: () => true, isTakeover: () => false, waitForTakeoverEnd: async () => {},
    activeUrl: () => url, locator: async ({ ref }: { ref?: string }) => field(ref ?? 'x'),
    recordAction: (r: unknown) => { records.push(r); },
  } as any);
  return typed;
}

describe('generatePassword', () => {
  it('meets common policies and is random', () => {
    const a = generatePassword(20);
    expect(a).toHaveLength(20);
    expect(a).toMatch(/^[A-Za-z]/);
    for (const re of [/[a-z]/, /[A-Z]/, /\d/, /[!@#$%&*\-_+=?]/]) expect(a).toMatch(re);
    expect(a).not.toMatch(/(.)\1\1/);
    expect(generatePassword(20)).not.toBe(a);
    expect(generatePassword(3)).toHaveLength(8);
    expect(generatePassword(500)).toHaveLength(64);
  });
});

describe('vault_generate_and_fill refusals and rollback (fake manager)', () => {
  it('refuses a plain-http page that is not localhost', async () => {
    const typed = fakeManager('http://shop.example.com/signup');
    const r = await generate({ ref: 'e1' });
    expect(r.content).toMatch(/^\[VAULT_ORIGIN_MISMATCH\]/);
    expect(typed).toEqual([]);
    expect(await vault.names()).toEqual([]);
  });

  it('refuses to rotate an entry on a page outside its sites', async () => {
    await vault.add({ name: 'bank', origins: ['https://bank.example.com'], secret: OLD });
    const typed = fakeManager('https://evil.example.net/change-password');
    const r = await generate({ ref: 'e1', name: 'bank' });
    expect(r.content).toMatch(/^\[VAULT_ORIGIN_MISMATCH\]/);
    expect(typed).toEqual([]);
    expect((await vault.get('bank'))!.secret).toBe(OLD);
    expectNoLeak(OLD);
  });

  it('removes the new entry again when typing fails, without echoing the value', async () => {
    const typed = fakeManager('https://new.example.com/signup', { failFill: true });
    const r = await generate({ ref: 'e1', confirm_ref: 'e2', username: 'me@example.com' });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/^\[BROWSER_ERROR\].*\*\*\*.*removed again/);
    expect(await vault.names()).toEqual([]);
    expect(typed).toHaveLength(1);
    expectNoLeak(typed[0]);
  });

  it('puts a rotated entry back on its previous password when typing fails', async () => {
    await vault.add({ name: 'site', origins: ['https://new.example.com'], secret: OLD });
    const typed = fakeManager('https://new.example.com/settings', { failFill: true });
    const r = await generate({ ref: 'e1', name: 'site' });
    expect(r.content).toMatch(/back on its previous password/);
    expect((await vault.get('site'))!.secret).toBe(OLD);
    expectNoLeak(OLD, typed[0]);
  });
});

// ── real Chromium ───────────────────────────────────────────────────────────

function findChromium(): string | null {
  const cands: string[] = [];
  if (process.env.QODEX_BROWSER_EXECUTABLE) cands.push(process.env.QODEX_BROWSER_EXECUTABLE);
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

const LOGIN_FORM = (button = 'Sign in', alert = '') => `<!doctype html><title>Sign in</title>${alert ? `<p role="alert">${alert}</p>` : ''}
  <form method="post" action="/login"><input name="username" autocomplete="username">
  <input type="password" name="password" autocomplete="current-password"><button type="submit">${button}</button></form>`;

describe('real Chromium flows', () => {
  let browser: any;
  let page: any;
  let a: http.Server;
  let b: http.Server;
  let A = '';
  let B = '';
  /** Every POST the sites received: path + form fields. */
  let posts: Array<{ site: string; path: string; form: Record<string, string> }>;

  const listen = (s: http.Server) => new Promise<number>(res => s.listen(0, '127.0.0.1', () => res((s.address() as any).port)));
  const readForm = (q: http.IncomingMessage) => new Promise<Record<string, string>>(res => {
    let body = '';
    q.on('data', c => { body += c; });
    q.on('end', () => res(Object.fromEntries(new URLSearchParams(body))));
  });
  const html = (r: http.ServerResponse, body: string) => { r.setHeader('content-type', 'text/html; charset=utf-8'); r.end(body); };
  const redirect = (r: http.ServerResponse, to: string) => { r.statusCode = 302; r.setHeader('location', to); r.end(); };

  beforeAll(async () => {
    if (!chromium) return;
    a = http.createServer(async (q, r) => {
      const url = new URL(q.url ?? '/', 'http://x');
      if (q.method === 'POST') {
        const form = await readForm(q);
        posts.push({ site: 'A', path: url.pathname, form });
        if (url.pathname === '/login') {
          // Slow on purpose: an error left on the page must not be read as this attempt failing.
          await new Promise(res => setTimeout(res, 700));
          if (form.username === 'alice' && form.password === PASS) return redirect(r, '/home');
          if (form.username === 'otpuser' && form.password === PASS2) return redirect(r, '/otp');
          return html(r, LOGIN_FORM('Sign in', 'Incorrect password. Try again.'));
        }
        if (url.pathname === '/id') {
          return html(r, `<!doctype html><title>Password</title><form method="post" action="/login">
            <input type="hidden" name="username" value="${form.email ?? ''}"><input type="password" name="password"><button>Sign in</button></form>`);
        }
        if (url.pathname === '/otp') {
          const now = Date.now();
          const ok = [now, now - 30_000].some(t => totp(SEED, { time: t }) === form.code);
          return ok ? redirect(r, '/home') : html(r, '<p role="alert">Wrong code</p><form method="post" action="/otp"><input name="code" autocomplete="one-time-code"><button>Verify</button></form>');
        }
      }
      switch (url.pathname) {
        case '/': return html(r, LOGIN_FORM());
        case '/pay': return html(r, LOGIN_FORM('Sign in and pay $49'));
        // A script-driven form still showing the error of an earlier attempt.
        case '/spa': return html(r, `${LOGIN_FORM('Sign in', 'Incorrect password. Try again.')}<script>
          document.querySelector('form').addEventListener('submit', function (e) {
            e.preventDefault();
            fetch('/login', { method: 'POST', body: new URLSearchParams(new FormData(e.target)) })
              .then(function (res) { if (res.url.endsWith('/home')) location.href = '/home'; });
          });</script>`);
        case '/home': return html(r, '<!doctype html><title>Dashboard</title><h1>Welcome back</h1>');
        case '/id': return html(r, '<!doctype html><title>Sign in</title><form method="post" action="/id"><input name="email" autocomplete="username"><button>Next</button></form>');
        case '/otp': return html(r, '<!doctype html><title>2FA</title><form method="post" action="/otp"><input name="code" autocomplete="one-time-code" inputmode="numeric"><button>Verify</button></form>');
        case '/to-b': return redirect(r, `${B}/`);
        case '/signup': return html(r, `<!doctype html><form><input type="email" name="email" autocomplete="username">
          <input type="password" id="np" autocomplete="new-password"><input type="password" id="cp" autocomplete="new-password"><button>Create account</button></form>`);
        case '/change': return html(r, `<!doctype html><form><input type="password" id="cur" autocomplete="current-password">
          <input type="password" id="np"><input type="password" id="cp"><button>Change</button></form>`);
        case '/short': return html(r, '<!doctype html><form><input type="password" id="np" autocomplete="new-password" maxlength="16"></form>');
        default: r.statusCode = 404; return r.end();
      }
    });
    b = http.createServer(async (q, r) => {
      if (q.method === 'POST') posts.push({ site: 'B', path: q.url ?? '', form: await readForm(q) });
      html(r, LOGIN_FORM());
    });
    A = `http://127.0.0.1:${await listen(a)}`;
    B = `http://127.0.0.1:${await listen(b)}`;
    browser = await playwright.chromium.launch({ executablePath: chromium, headless: true, args: ['--no-proxy-server'] });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    a?.close();
    b?.close();
  });

  beforeEach(async () => {
    posts = [];
    if (!browser) return;
    page = await browser.newPage();
    setBrowserManagerForTests({
      isRunning: () => true, isTakeover: () => false, waitForTakeoverEnd: async () => {},
      activeUrl: () => page.url(), activePage: async () => page,
      locator: async ({ selector }: { selector?: string }) => page.locator(selector!),
      recordAction: (rec: unknown) => { records.push(rec); },
    } as any);
  });
  afterEach(async () => { await page?.close().catch(() => {}); });

  // vault_generate_and_fill

  it.skipIf(!chromium)('sign-up: fills password + confirm with one new password and saves it for this site', async () => {
    await page.goto(`${A}/signup`);
    const r = await generate({ username: 'alice@example.com' });
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/new vault entry "127\.0\.0\.1".*new-password field and the confirm-password field/);
    const e = (await vault.get('127.0.0.1'))!;
    expect(e.origins).toEqual([A]);
    expect(e.username).toBe('alice@example.com');
    expect(e.secret).toHaveLength(20);
    expect(await page.locator('#np').inputValue()).toBe(e.secret);
    expect(await page.locator('#cp').inputValue()).toBe(e.secret);
    expect(JSON.stringify(records)).toContain('***');
    expectNoLeak(e.secret);
    expect(await fs.readFile(path.join(tmp, 'vault.json'), 'utf8')).not.toContain(e.secret);
  }, 30_000);

  it.skipIf(!chromium)('change-password form: rotates the named entry into the new + confirm fields, keeps the old one', async () => {
    await vault.add({ name: 'acct', origins: [A], username: 'alice', secret: OLD });
    await page.goto(`${A}/change`);
    const r = await generate({ name: 'acct' });
    expect(r.content).toMatch(/rotated vault entry "acct"/);
    const e = (await vault.get('acct'))!;
    expect(e.previousSecret).toBe(OLD);
    expect(e.secret).not.toBe(OLD);
    expect(await page.locator('#cur').inputValue()).toBe('');
    expect(await page.locator('#np').inputValue()).toBe(e.secret);
    expect(await page.locator('#cp').inputValue()).toBe(e.secret);
    expectNoLeak(e.secret, OLD);
  }, 30_000);

  it.skipIf(!chromium)('respects maxlength, and refuses a page whose only password field is a login field', async () => {
    await page.goto(`${A}/short`);
    const r = await generate({ selector: '#np' });
    expect(r.content).toMatch(/16-character/);
    const e = (await vault.get('127.0.0.1'))!;
    expect(e.secret).toHaveLength(16);
    expect(await page.locator('#np').inputValue()).toBe(e.secret);

    await page.goto(`${A}/`);
    const r2 = await generate({});
    expect(r2.content).toMatch(/^\[VAULT_FIELD_MISMATCH\].*browser_login/);
    expect(await vault.names()).toEqual(['127.0.0.1']);
    expectNoLeak(e.secret);
  }, 30_000);

  // browser_login

  it.skipIf(!chromium)('classic login: opens the site, fills username + password, submits once, reports where it landed', async () => {
    await vault.add({ name: 'alice', origins: [A], username: 'alice', secret: PASS });
    const r = await login({ secret: 'alice' });
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/Signed in to 127\.0\.0\.1.*username → password.*\/home.*"Dashboard"/);
    expect(page.url()).toBe(`${A}/home`);
    expect(posts).toEqual([{ site: 'A', path: '/login', form: { username: 'alice', password: PASS } }]);
    expect(records.some((x: any) => x.tool === 'browser_fill_secret' && x.args.value === '***')).toBe(true);
    expect(events.length).toBeGreaterThan(0);
    expectNoLeak(PASS);
    expect((await vault.get('alice'))!.lastUsedAt).toBeTruthy();
  }, 60_000);

  it.skipIf(!chromium)('identifier-first: username, Next, then the password page', async () => {
    await vault.add({ name: 'idf', origins: [A], username: 'alice', secret: PASS, loginUrl: `${A}/id` });
    const r = await login({ secret: 'idf' });
    expect(r.isError).toBeFalsy();
    expect(posts.map(p => p.path)).toEqual(['/id', '/login']);
    expect(posts[1].form).toEqual({ username: 'alice', password: PASS });
    expect(page.url()).toBe(`${A}/home`);
    expectNoLeak(PASS);
  }, 60_000);

  it.skipIf(!chromium)('fills the current TOTP code when the site asks for one', async () => {
    await vault.add({ name: 'otp', origins: [A], username: 'otpuser', secret: PASS2, totp: SEED });
    const r = await login({ secret: 'otp' });
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/one-time code/);
    expect(posts.map(p => p.path)).toEqual(['/login', '/otp']);
    expect(page.url()).toBe(`${A}/home`);
    expectNoLeak(PASS2, SEED, posts[1].form.code);
  }, 60_000);

  it.skipIf(!chromium)('refuses a url on another site, and a login page that redirects to another site', async () => {
    await vault.add({ name: 'alice', origins: [A], username: 'alice', secret: PASS, loginUrl: `${A}/to-b` });
    const r = await login({ secret: 'alice', url: `${B}/` });
    expect(r.content).toMatch(/^\[VAULT_ORIGIN_MISMATCH\].*Nothing was opened/);
    expect(page.url()).toBe('about:blank');

    const r2 = await login({ secret: 'alice' });
    expect(r2.content).toMatch(/^\[VAULT_ORIGIN_MISMATCH\] The sign-in page is on 127\.0\.0\.1.*Nothing was filled/);
    expect(page.url()).toBe(`${B}/`);
    expect(await page.locator('input[name=username]').inputValue()).toBe('');
    expect(await page.locator('input[type=password]').inputValue()).toBe('');
    expect(posts).toEqual([]);
    expectNoLeak(PASS);
  }, 60_000);

  it.skipIf(!chromium)('stops after one failed attempt and holds the entry until it is changed', async () => {
    await vault.add({ name: 'bad', origins: [A], username: 'alice', secret: OLD });
    const r = await login({ secret: 'bad' });
    expect(r.content).toMatch(/^\[LOGIN_FAILED\].*Not retrying/);
    expect(posts).toHaveLength(1);

    const again = await login({ secret: 'bad', url: `${A}/` });
    expect(again.content).toMatch(/^\[LOGIN_HALTED\]/);
    expect(posts).toHaveLength(1);

    await new Promise(res => setTimeout(res, 5));
    await vault.update('bad', { secret: PASS });
    const fixed = await login({ secret: 'bad' });
    expect(fixed.isError).toBeFalsy();
    expect(posts).toHaveLength(2);
    expectNoLeak(OLD, PASS);
  }, 60_000);

  it.skipIf(!chromium)('an error message left over from an earlier attempt is not read as this attempt failing', async () => {
    await vault.add({ name: 'spa', origins: [A], username: 'alice', secret: PASS, loginUrl: `${A}/spa` });
    const r = await login({ secret: 'spa' });
    expect(r.isError).toBeFalsy();
    expect(page.url()).toBe(`${A}/home`);
    expect(posts).toHaveLength(1);
    expectNoLeak(PASS);
  }, 60_000);

  it.skipIf(!chromium)('never clicks a submit button that reads like a payment; submit:false fills without submitting', async () => {
    await vault.add({ name: 'pay', origins: [A], username: 'alice', secret: PASS, loginUrl: `${A}/pay` });
    const r = await login({ secret: 'pay' });
    expect(r.content).toMatch(/^\[LOGIN_REFUSED\]/);
    expect(posts).toEqual([]);

    const r2 = await login({ secret: 'pay', url: `${A}/`, submit: false });
    expect(r2.content).toMatch(/Filled username and password.*Not submitted/);
    expect(await page.locator('input[type=password]').inputValue()).toBe(PASS);
    expect(posts).toEqual([]);
    expectNoLeak(PASS);
  }, 60_000);
});

describe('prompts point at the vault login tools', () => {
  it('the # Your Computer credentials line names browser_login, and vault_request_login only when it exists', async () => {
    const { buildComputerSection, detectComputerFamilies } = await import('../src/llm/prompts/system.js');
    const base = ['browser_navigate', 'browser_fill_secret', 'browser_login', 'vault_list', 'vault_generate_and_fill'];
    const without = buildComputerSection(detectComputerFamilies(base));
    expect(without).toMatch(/Credentials\*\*: sign in with `browser_login`/);
    expect(without).not.toContain('vault_request_login');
    expect(buildComputerSection(detectComputerFamilies([...base, 'vault_request_login']))).toMatch(/none saved\? `vault_request_login`/);
    expect(buildComputerSection(detectComputerFamilies(['browser_navigate', 'browser_fill_secret', 'vault_list']))).toMatch(/use the vault \(`vault_list`, `browser_fill_secret`\)/);
  });
  it('the browser sub-agent gets the vault login tools', async () => {
    const { builtinRoleAllowedTools, getBuiltinRolePrompt } = await import('../src/llm/prompts/role-prompts.js');
    const allowed = builtinRoleAllowedTools('browser', ['browser_click', 'browser_login', 'browser_agent', 'vault_list', 'vault_generate_and_fill', 'vault_request_login', 'shell'])!;
    expect(allowed).toEqual(expect.arrayContaining(['browser_login', 'vault_list', 'vault_generate_and_fill', 'vault_request_login']));
    expect(allowed).not.toContain('browser_agent');
    expect(allowed).not.toContain('shell');
    expect(getBuiltinRolePrompt('browser')).toMatch(/browser_login/);
  });
});
