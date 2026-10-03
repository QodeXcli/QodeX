/**
 * V2 save-login capture against the REAL QodeX browser manager (headless Chromium,
 * local pages only): the human logs in through takeover input (what the control
 * center's live view sends), QodeX asks "Save the login for <host> (user <masked>)?"
 * and saves on yes.
 *
 * What must hold:
 *   - only a HUMAN submit under takeover creates a candidate (Enter in a login
 *     field, a click on a submit control) — not the agent, not a "show" button;
 *   - the login is read from the frame that owns it (cross-origin iframe included)
 *     and bound to THAT frame's origin;
 *   - the yes/no never contains the password (bus, approvals, prompts, candidate
 *     serialization), and the vault gets it only on yes; an identical saved login
 *     is not asked again; a still-visible login form (wrong password) defers.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as http from 'node:http';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { inspect } from 'node:util';
import { Vault } from '../src/vault/vault.js';
import { LoginCapture } from '../src/vault/capture.js';
import { getBus } from '../src/control/bus.js';
import { getApprovalBroker, type PendingApproval } from '../src/control/approvals.js';
import { resolveBrowserExecutable } from '../src/tools/browser/launcher.js';
import { QodexBrowserManager, addHumanInputObserver } from '../src/tools/browser/session.js';

const PASSWORD = 'S3cr3t-Hum4n-Typed!';
const PASSWORD2 = 'An0ther-Pa55-xyz';

let pw: any = null;
try { pw = await import('playwright'); } catch { pw = null; }
let pwExe = '';
try { pwExe = String(pw?.chromium?.executablePath?.() ?? ''); } catch { pwExe = ''; }
const exe = pw ? resolveBrowserExecutable({ playwrightExecutablePath: pwExe, headless: true }) : { executablePath: undefined, channel: undefined };
const haveChromium = !!pw && !!(exe.executablePath || exe.channel);

const FORM = (action: string, extra = '') => `<!doctype html><title>Login</title>
<form method="post" action="${action}" style="margin:40px">
  <input id="u" name="login" autocomplete="username" style="display:block;width:200px;height:30px">
  <input id="p" type="password" name="pw" style="display:block;width:200px;height:30px;margin-top:10px">
  <button id="show" type="button" style="width:120px;height:30px;margin-top:10px">Show</button>
  <button id="go" style="width:120px;height:30px;margin-top:10px">Sign in</button>
  ${extra}
</form>`;

const ROUTES: Record<string, string> = {
  '/login': FORM('/welcome'),
  '/wrong': FORM('/wrong'),
  '/step1': `<!doctype html><form method="post" action="/step2" style="margin:40px"><input id="e" type="email" name="email" style="width:200px;height:30px"><button id="next" style="width:120px;height:30px">Next</button></form>`,
  '/step2': `<!doctype html><form method="post" action="/welcome" style="margin:40px"><input id="p" type="password" name="pw" style="width:200px;height:30px"><button id="go" style="width:120px;height:30px">Sign in</button></form>`,
  '/welcome': '<!doctype html><title>Welcome</title><h1>Welcome</h1>',
};

describe.skipIf(!haveChromium)('save-login capture (real browser, takeover input)', () => {
  let tmp: string;
  let server: http.Server;
  let port = 0;
  let mgr: QodexBrowserManager;
  let vault: Vault;
  let capture: LoginCapture;
  let off: () => void;
  const prompts: PendingApproval[] = [];
  let answer = 'yes';

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-v2-capture-'));
    server = http.createServer((req, res) => {
      req.resume();
      const p = String(req.url ?? '/').split('?')[0]!;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      if (p === '/frame') {
        // cross-origin iframe: page on localhost, login form on 127.0.0.1
        res.end(`<!doctype html><h3>Host</h3><iframe id="f" src="http://127.0.0.1:${port}/login" style="position:absolute;left:50px;top:80px;width:400px;height:320px;border:0"></iframe>`);
        return;
      }
      res.end(ROUTES[p] ?? ROUTES['/welcome']);
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as { port: number }).port;
    mgr = new QodexBrowserManager({
      profilesDir: path.join(tmp, 'profiles'),
      downloadsDir: path.join(tmp, 'downloads'),
      config: { headless: true, viewport: { width: 800, height: 600 } },
    });
  }, 60_000);

  afterAll(async () => {
    off?.();
    await mgr?.close().catch(() => {});
    getApprovalBroker().reset();
    await new Promise<void>(r => server?.close(() => r()));
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }, 60_000);

  beforeEach(async () => {
    off?.();
    await fs.rm(path.join(tmp, 'vault'), { recursive: true, force: true });
    vault = new Vault({ file: path.join(tmp, 'vault', 'vault.json'), keyFile: path.join(tmp, 'vault', '.vault-key') });
    capture = new LoginCapture({ vault: () => vault, settleMs: 300, askTimeoutMs: 10_000 });
    off = addHumanInputObserver(capture.observer());
    prompts.length = 0;
    answer = 'yes';
    getBus().reset();
    getApprovalBroker().reset();
    getApprovalBroker().registerChannel({
      name: 'test',
      deliver: (p) => { prompts.push(p); setTimeout(() => getApprovalBroker().resolve(p.id, answer, 'test'), 20); },
    });
    mgr.setTakeover(true);
  });

  async function center(sel: string, frameSel?: string): Promise<{ x: number; y: number }> {
    const page = await mgr.activePage();
    const loc = frameSel ? page.frameLocator(frameSel).locator(sel) : page.locator(sel);
    const b = await loc.boundingBox();
    return { x: b!.x + b!.width / 2, y: b!.y + b!.height / 2 };
  }
  async function clickOn(sel: string, frameSel?: string) {
    const c = await center(sel, frameSel);
    await mgr.dispatchInput({ type: 'click', x: c.x, y: c.y });
  }
  async function goto(p: string, host = 'localhost') {
    await mgr.dispatchInput({ type: 'navigate', url: `http://${host}:${port}${p}` });
  }
  async function until(fn: () => boolean | Promise<boolean>, ms = 8000): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return true; await new Promise(r => setTimeout(r, 50)); }
    return false;
  }
  function expectNoLeak(...extra: string[]) {
    const all = [JSON.stringify(getBus().recent(500)), JSON.stringify(prompts), JSON.stringify(capture), inspect(capture, { depth: 5 }), ...extra].join('\n');
    expect(all).not.toContain(PASSWORD);
    expect(all).not.toContain(PASSWORD2);
  }

  it('Enter in the password field → asks without the secret → saves on yes; same login is not asked again', async () => {
    await goto('/login');
    await clickOn('#u');
    await mgr.dispatchInput({ type: 'type', text: 'octocat@example.com' });
    await clickOn('#p');
    await mgr.dispatchInput({ type: 'type', text: PASSWORD });
    // a "Show" button is not a submit
    await clickOn('#show');
    expect(capture.pendingCount()).toBe(0);
    await clickOn('#p'); // focus back in the password field (the click focused "Show")
    await mgr.dispatchInput({ type: 'key', key: 'Enter' });
    expect(await until(async () => (await vault.list()).length === 1)).toBe(true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.prompt).toBe('Save the login for localhost (user oc***@example.com) in the QodeX vault?');
    expect(prompts[0]!.category).toBe('credential');
    const e = (await vault.list())[0]!;
    expect(e.origins).toEqual([`http://localhost:${port}`]);
    expect((await vault.get(e.name))).toMatchObject({ username: 'octocat@example.com', secret: PASSWORD });
    expectNoLeak();

    // the same login again: nothing to ask
    await goto('/login');
    await clickOn('#u');
    await mgr.dispatchInput({ type: 'type', text: 'octocat@example.com' });
    await clickOn('#p');
    await mgr.dispatchInput({ type: 'type', text: PASSWORD });
    await clickOn('#go');
    expect(await until(async () => (await capture.lastOffer) === 'unchanged')).toBe(true);
    expect(prompts).toHaveLength(1);

    // a new password for the same user: "Update …"; declining keeps the old one
    answer = 'no';
    await goto('/login');
    await clickOn('#u');
    await mgr.dispatchInput({ type: 'type', text: 'octocat@example.com' });
    await clickOn('#p');
    await mgr.dispatchInput({ type: 'type', text: PASSWORD2 });
    await clickOn('#go');
    expect(await until(() => prompts.length === 2)).toBe(true);
    expect(prompts[1]!.prompt).toMatch(/^Update the saved password for localhost \(user oc\*\*\*@example\.com\)/);
    expect(await capture.lastOffer).toBe('declined');
    expect((await vault.get(e.name))?.secret).toBe(PASSWORD);
    expectNoLeak();
  }, 60_000);

  it('the agent (no takeover) never creates a candidate', async () => {
    await goto('/login');
    mgr.setTakeover(false);
    const page = await mgr.activePage();
    await page.fill('#u', 'agent@example.com');
    await page.fill('#p', PASSWORD);
    await mgr.dispatchInput({ type: 'key', key: 'Enter' }); // even through dispatchInput, without takeover
    await page.waitForURL(/\/welcome/);
    await new Promise(r => setTimeout(r, 500));
    expect(capture.pendingCount()).toBe(0);
    expect(prompts).toHaveLength(0);
    expect(await vault.list()).toEqual([]);
  }, 60_000);

  it('a click on the submit button inside a cross-origin iframe binds the login to the iframe origin', async () => {
    await goto('/frame');
    const page = await mgr.activePage();
    await page.frameLocator('#f').locator('#p').waitFor();
    await clickOn('#u', '#f');
    await mgr.dispatchInput({ type: 'type', text: 'frameuser' });
    await clickOn('#p', '#f');
    await mgr.dispatchInput({ type: 'type', text: PASSWORD });
    await clickOn('#go', '#f');
    // the iframe navigates, not the main frame: the prompt comes when takeover ends
    await new Promise(r => setTimeout(r, 400));
    expect(capture.pendingCount()).toBe(1);
    mgr.setTakeover(false);
    expect(await until(async () => (await vault.list()).length === 1)).toBe(true);
    expect(prompts[0]!.prompt).toBe('Save the login for 127.0.0.1 (user fr***) in the QodeX vault?');
    expect((await vault.list())[0]!.origins).toEqual([`http://127.0.0.1:${port}`]);
    expectNoLeak();
  }, 60_000);

  it('a wrong password (form shown again) defers; a two-step login keeps the username from step 1', async () => {
    await goto('/wrong');
    await clickOn('#u');
    await mgr.dispatchInput({ type: 'type', text: 'bob' });
    await clickOn('#p');
    await mgr.dispatchInput({ type: 'type', text: PASSWORD2 });
    await mgr.dispatchInput({ type: 'key', key: 'Enter' });
    await new Promise(r => setTimeout(r, 900));
    expect(prompts).toHaveLength(0);
    expect(capture.pendingCount()).toBe(1);

    // two-step: email first, password on the next page (a newer submit replaces the deferred one)
    await goto('/step1');
    await clickOn('#e');
    await mgr.dispatchInput({ type: 'type', text: 'carol@example.com' });
    await clickOn('#next');
    await (await mgr.activePage()).waitForURL(/\/step2/);
    await (await mgr.activePage()).locator('#p').waitFor();
    await clickOn('#p');
    await mgr.dispatchInput({ type: 'type', text: PASSWORD });
    await mgr.dispatchInput({ type: 'key', key: 'Enter' });
    expect(await until(async () => (await vault.list()).length === 1)).toBe(true);
    expect(prompts[0]!.prompt).toBe('Save the login for localhost (user ca***@example.com) in the QodeX vault?');
    const e = (await vault.list())[0]!;
    expect((await vault.get(e.name))).toMatchObject({ username: 'carol@example.com', secret: PASSWORD });
    expectNoLeak();
  }, 60_000);
});
