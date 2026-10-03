/**
 * Adversarial-review regressions for the dedicated QodeX Browser:
 *   - secret field values (passwords filled from the vault, card numbers, one-time
 *     codes) never reach the model through snapshots / evaluate results;
 *   - a ref passed as `selector` ("e5") is described as that ref, so Sentinel
 *     classifies the real target (no approval bypass);
 *   - typing into a focused password field (agent without a target, or a human
 *     typing into a cross-origin login iframe) is redacted in the action feed;
 *   - browser_downloads wait does not lose a download that finished after an
 *     earlier wait timed out;
 *   - symlinks cannot smuggle QodeX secret files through upload / screenshot paths;
 *   - a protected file:// page reached by clicking (not navigate) is closed;
 *   - browser_agent hands the caller's askUser down; status hides CDP tokens;
 *   - browser_wait_for url treats "?" literally; browser_evaluate runs
 *     `() => { ...; return x }` scripts; throwaway `<profile>-<pid>` profiles
 *     are deleted on close and stale ones pruned (never a user's profile).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'http';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ToolContext, ToolResult } from '../src/tools/base.js';
import { resolveBrowserExecutable } from '../src/tools/browser/launcher.js';
import { QodexBrowserManager, pruneStaleFallbackProfiles } from '../src/tools/browser/session.js';
import { setBrowserManagerForTests, type BrowserActionRecord } from '../src/tools/browser/types.js';
import { BrowserClickTool, BrowserEvaluateTool, BrowserNavigateTool, BrowserScreenshotTool, BrowserWaitForTool, compileEvaluateScript } from '../src/tools/browser/tools.js';
import { BrowserSnapshotTool, BrowserTypeTool, BrowserUploadTool, BrowserStatusTool, BrowserPdfTool, BrowserTabsTool } from '../src/tools/browser/tools-extra.js';
import { BrowserAgentTool } from '../src/tools/browser/agent-tool.js';
import { maskSecretValues, snapshotWithBoxes } from '../src/tools/browser/snapshot.js';
import { setSubAgentRunner } from '../src/tools/builtin/task.js';
import { getBus } from '../src/control/bus.js';
import { Sentinel } from '../src/sentinel/index.js';
import { QODEX_VAULT_FILE, QODEX_VAULT_KEY_FILE } from '../src/config/paths.js';

let pw: any = null;
try { pw = await import('playwright'); } catch { pw = null; }
let pwExe = '';
try { pwExe = String(pw?.chromium?.executablePath?.() ?? ''); } catch { pwExe = ''; }
const exe = resolveBrowserExecutable({ playwrightExecutablePath: pwExe, headless: true });
const chromium = !!pw && !!(exe.executablePath || exe.channel);

function makeCtx(cwd: string, over: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd,
    sessionId: 'review',
    transaction: {} as any,
    permissions: { evaluate: () => 'allow' } as any,
    askUser: async () => 'yes',
    signal: new AbortController().signal,
    emit: () => {},
    ...over,
  } as any;
}

function refOf(text: string, role: string, name: string): string {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`- ${role} "${esc}"[^\\n]*?\\[ref=([a-z0-9]+)\\]`).exec(text);
  if (!m) throw new Error(`no ${role} "${name}" in snapshot:\n${text}`);
  return m[1];
}

// ── pure ────────────────────────────────────────────────────────────────────

describe('maskSecretValues (pure)', () => {
  it('hides the inline value of a field whose value is a secret, plain and YAML-quoted', () => {
    const snap = [
      '- textbox "User" [ref=e4]: alice',
      '- textbox "Pass" [ref=e6]: hunter2',
      '- textbox [ref=e7]: "p@ss: \\"w0rd\\""',
      '- textbox "card" [active] [ref=e10]: "4111111111111111"',
      '- paragraph [ref=e11]: unrelated hunter2x text',
    ].join('\n');
    const out = maskSecretValues(snap, ['hunter2', 'p@ss: "w0rd"', '4111111111111111']);
    expect(out).toContain('- textbox "User" [ref=e4]: alice');
    expect(out).toContain('- textbox "Pass" [ref=e6]: [hidden]');
    expect(out).toContain('- textbox [ref=e7]: [hidden]');
    expect(out).toContain('- textbox "card" [active] [ref=e10]: [hidden]');
    expect(out).not.toContain('4111111111111111');
    expect(out).not.toContain('w0rd');
    // Short values are only masked as a whole field value, never inside other text.
    expect(out).toContain('unrelated hunter2x text');
  });

  it('masks long secret values anywhere (a page echoing them back)', () => {
    const out = maskSecretValues('- heading "Your password is CorrectHorse99" [level=1]', ['CorrectHorse99']);
    expect(out).not.toContain('CorrectHorse99');
  });

  it('is a no-op without secrets', () => {
    expect(maskSecretValues('- textbox "a" [ref=e1]: x', [])).toBe('- textbox "a" [ref=e1]: x');
  });
});

describe('compileEvaluateScript', () => {
  it('runs function-expression scripts whose body uses `return` (arrow with block, function, async)', async () => {
    expect(await compileEvaluateScript('() => { return 41 + 1; }')()).toBe(42);
    expect(await compileEvaluateScript('(arg) => { const x = arg * 2; return x; }')(21)).toBe(42);
    expect(await compileEvaluateScript('async () => { return await Promise.resolve(7); }')()).toBe(7);
    expect(await compileEvaluateScript('function () { return "f"; }')()).toBe('f');
    expect(await compileEvaluateScript('(function () { return 9; })()')()).toBe(9);
    // Unchanged forms.
    expect(await compileEvaluateScript('return 1 + arg')(2)).toBe(3);
    expect(await compileEvaluateScript('1 + 1')()).toBe(2);
    expect(await compileEvaluateScript('const a = 5; return a;')()).toBe(5);
    expect(await compileEvaluateScript('if (arg) { return "yes"; } return "no";')(true)).toBe('yes');
  });
});

describe('browser_agent approval routing', () => {
  it('hands the calling tool\'s askUser down to the browser sub-agent', async () => {
    let seen: any = null;
    setSubAgentRunner(async (_prompt, opts) => {
      seen = opts;
      return { finalText: 'done', toolCallsRun: 1, ok: true };
    });
    try {
      const askUser = async () => 'no';
      await new BrowserAgentTool().execute({ task: 'x' } as any, makeCtx(os.tmpdir(), { askUser } as any));
      expect(seen?.askUser).toBe(askUser);
    } finally {
      setSubAgentRunner(null);
    }
  });
});

describe('waitForDownload (fake download, no browser)', () => {
  it('a download that finishes after an earlier wait timed out is returned by the next wait', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-dl-'));
    const mgr = new QodexBrowserManager({ profilesDir: path.join(tmp, 'p'), downloadsDir: path.join(tmp, 'dl') });
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const download = {
      url: () => 'http://x/report.csv',
      suggestedFilename: () => 'report.csv',
      saveAs: async (p: string) => { await gate; await fs.writeFile(p, 'a,b'); },
    };
    (mgr as any).onDownload({ id: 't1' }, download);
    expect(await mgr.waitForDownload(50)).toBeNull(); // still in progress
    release();
    await new Promise(r => setTimeout(r, 50)); // it completes while nobody waits
    const d = await mgr.waitForDownload(500);
    expect(d?.state).toBe('completed');
    expect(d?.path).toBe(path.join(tmp, 'dl', 'report.csv'));
    // ...and is not returned twice.
    expect(await mgr.waitForDownload(50)).toBeNull();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('two downloads started during one wait: the second stays available for the next wait', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-dl-'));
    const mgr = new QodexBrowserManager({ profilesDir: path.join(tmp, 'p'), downloadsDir: path.join(tmp, 'dl') });
    const mk = (name: string) => ({ url: () => `http://x/${name}`, suggestedFilename: () => name, saveAs: async (p: string) => { await fs.writeFile(p, name); } });
    const waiting = mgr.waitForDownload(1000);
    (mgr as any).onDownload({ id: 't1' }, mk('a.txt'));
    (mgr as any).onDownload({ id: 't1' }, mk('b.txt'));
    const first = await waiting;
    expect(first?.suggestedFilename).toBe('a.txt');
    const second = await mgr.waitForDownload(500);
    expect(second?.suggestedFilename).toBe('b.txt');
    await fs.rm(tmp, { recursive: true, force: true });
  });
});

describe('status never prints CDP credentials', () => {
  it('browser_status redacts the token / password of a configured cdpUrl', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-st-'));
    const mgr = new QodexBrowserManager({
      profilesDir: path.join(tmp, 'p'),
      downloadsDir: path.join(tmp, 'dl'),
      config: { cdpUrl: 'wss://user:pa55word@chrome.example.com/devtools?token=SECRET-TOKEN-123&x=1' },
    });
    setBrowserManagerForTests(mgr);
    try {
      expect(mgr.status().cdpUrl).not.toMatch(/SECRET-TOKEN-123|pa55word/);
      expect(mgr.status().cdpUrl).toContain('chrome.example.com');
      // Not running, so the tool doesn't print the URL at all — but the status object is public API.
      const r = await new BrowserStatusTool().execute({} as any, makeCtx(tmp));
      expect(r.content).not.toMatch(/SECRET-TOKEN-123|pa55word/);
    } finally {
      setBrowserManagerForTests(null);
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('symlinks cannot reach QodeX secret files', () => {
  it('upload refuses a symlink that points at the vault key; screenshot/pdf refuse a symlinked output into the vault', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-sym-'));
    try {
      await fs.symlink(QODEX_VAULT_KEY_FILE, path.join(tmp, 'innocent.txt'));
      await fs.symlink(QODEX_VAULT_FILE, path.join(tmp, 'shot.png'));
      await fs.symlink(QODEX_VAULT_FILE, path.join(tmp, 'page.pdf'));
      const running = {
        isRunning: () => true, isTakeover: () => false, status: () => ({ headless: true }),
        activePage: async () => { throw new Error('must not reach the page'); },
      } as any;
      setBrowserManagerForTests(running);
      const up = await new BrowserUploadTool().execute({ paths: ['innocent.txt'] } as any, makeCtx(tmp));
      expect(up.isError).toBe(true);
      expect(up.content).toMatch(/Refusing to upload QodeX credential/);
      const shot = await new BrowserScreenshotTool().execute({ path: 'shot.png' } as any, makeCtx(tmp));
      expect(shot.isError).toBe(true);
      expect(shot.content).toMatch(/refusing to write into QodeX/);
      const pdf = await new BrowserPdfTool().execute({ path: 'page.pdf' } as any, makeCtx(tmp));
      expect(pdf.isError).toBe(true);
      expect(pdf.content).toMatch(/refusing to write into QodeX/);
    } finally {
      setBrowserManagerForTests(null);
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('fallback <profile>-<pid> profiles do not pile up', () => {
  it('prunes marked fallbacks of dead processes only — never a user profile named like one, never a live pid', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-prof-'));
    try {
      const mk = async (name: string, marker: boolean) => {
        await fs.mkdir(path.join(base, name, 'Default'), { recursive: true });
        if (marker) await fs.writeFile(path.join(base, name, '.qodex-fallback-profile'), '1');
      };
      await mk('default-999999', true); // dead pid, QodeX fallback → removed
      await mk('default-2024', false); // user's own profile that only looks like one → kept
      await mk(`default-${process.pid}`, true); // this process → kept
      await mk('work-999999', true); // other profile's fallback → not this prune
      const removed = await pruneStaleFallbackProfiles(base, 'default');
      expect(removed).toEqual(['default-999999']);
      const left = (await fs.readdir(base)).sort();
      expect(left).toEqual(['default-2024', `default-${process.pid}`, 'work-999999'].sort());
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });
});

// ── real Chromium ───────────────────────────────────────────────────────────

const LOGIN = `<!doctype html><title>Login</title>
<h1>Sign in</h1>
<label>Email <input id="email" name="email"></label>
<label>Pass <input id="pw" type="password" name="pw"></label>
<input id="pw2" type="password">
<input id="card" autocomplete="cc-number" aria-label="Card number">
<input id="otp" autocomplete="one-time-code" aria-label="Code">
<iframe id="inner" srcdoc="<label>Inner pass <input id=ipw type=password></label>" style="width:300px;height:80px"></iframe>
<button id="go">Continue</button>`;

describe.skipIf(!chromium)('QodeX browser review (real Chromium)', () => {
  let server: http.Server;
  let base = '';
  let alt = '';
  let tmp = '';
  let mgr: QodexBrowserManager;
  let ctx: ToolContext;
  const actions: BrowserActionRecord[] = [];

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-review-'));
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      res.setHeader('content-type', 'text/html');
      if (url.pathname === '/login') { res.end(LOGIN); return; }
      if (url.pathname === '/checkout') {
        res.end('<title>Checkout</title><h1>Checkout</h1><p>Total: 99 USD</p><button id="place" onclick="document.title=\'ordered\'">Place order</button>');
        return;
      }
      if (url.pathname === '/xo') {
        // The login form lives in a cross-origin iframe (localhost vs 127.0.0.1).
        res.end(`<title>Embedded login</title><h1>Shop</h1><iframe id="sso" src="${alt}/sso" style="width:400px;height:120px"></iframe>`);
        return;
      }
      if (url.pathname === '/sso') {
        res.end('<label>SSO password <input id="sp" type="password"></label><label>SSO user <input id="su"></label>');
        return;
      }
      res.statusCode = 404;
      res.end('nope');
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as any).port;
    base = `http://127.0.0.1:${port}`;
    alt = `http://localhost:${port}`;
    mgr = new QodexBrowserManager({
      profilesDir: path.join(tmp, 'profiles'),
      downloadsDir: path.join(tmp, 'downloads'),
      config: { headless: true, snapshotAfterAction: true },
    });
    setBrowserManagerForTests(mgr);
    mgr.onAction(r => actions.push(r));
    ctx = makeCtx(tmp);
  }, 60_000);

  afterAll(async () => {
    await mgr?.close();
    setBrowserManagerForTests(null);
    await new Promise<void>(r => server?.close(() => r()));
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }, 60_000);

  const run = async (tool: { execute: (a: any, c: ToolContext) => Promise<ToolResult>; argsSchema: any }, args: Record<string, unknown>): Promise<ToolResult> =>
    tool.execute(tool.argsSchema.parse(args), ctx);

  it('snapshots never show the values of password / card / one-time-code fields (vault fills stay secret)', async () => {
    const page = await mgr.activePage();
    await page.goto(`${base}/login`);
    // What browser_fill_secret does: the value goes straight into the page.
    await page.fill('#email', 'alice@example.com');
    await page.fill('#pw', 'Vault-Secret-1');
    await page.fill('#pw2', 'xyz');
    await page.fill('#card', '4111111111111111');
    await page.fill('#otp', '123456');
    await page.frameLocator('#inner').locator('#ipw').fill('Inner-Secret-2');

    const secrets = ['Vault-Secret-1', 'xyz', '4111111111111111', '123456', 'Inner-Secret-2'];
    const full = await run(new BrowserSnapshotTool(), {});
    const inter = await run(new BrowserSnapshotTool(), { interactive_only: true });
    for (const text of [full.content, inter.content]) {
      for (const s of secrets) expect(text, s).not.toContain(s);
      expect(text).toContain('alice@example.com');
      expect(text).toMatch(/- textbox "Pass" \[ref=e\d+\]: \[hidden\]/);
    }
    // The compact snapshot appended to the next action is masked too.
    const click = await run(new BrowserClickTool(), { ref: refOf(inter.content, 'textbox', 'Email') });
    expect(click.content).toContain('Page after action');
    for (const s of secrets) expect(click.content, s).not.toContain(s);
    // Set-of-marks legend / boxes snapshot.
    const boxes = await snapshotWithBoxes(page);
    for (const s of secrets) expect(JSON.stringify(boxes), s).not.toContain(s);
    // browser_evaluate reading a password field gets it masked as well.
    const ev = await run(new BrowserEvaluateTool(), { script: "return document.querySelector('#pw').value" });
    expect(ev.content).not.toContain('Vault-Secret-1');
  }, 60_000);

  it('a ref passed as `selector` is described as that ref, so Sentinel sees the real target', async () => {
    const r = await run(new BrowserNavigateTool(), { url: `${base}/checkout`, snapshot: false });
    expect(r.isError).toBeFalsy();
    const snap = (await run(new BrowserSnapshotTool(), { interactive_only: true })).content;
    const ref = refOf(snap, 'button', 'Place order');
    expect(await mgr.describeSelector(ref)).toMatchObject({ role: 'button', name: 'Place order', selector: '#place' });
    expect(await mgr.describeSelector(`[ref=${ref}]`)).toMatchObject({ name: 'Place order' });
    // Direct manager callers (vault fill, workflow replay) resolve it the same way.
    expect(await (await mgr.locator({ selector: ref })).textContent()).toBe('Place order');
    const sentinel = new Sentinel({ browser: () => mgr, audit: null });
    const viaSelector = await sentinel.review('browser_click', { selector: ref, element: 'button' }, ctx);
    const viaRef = await sentinel.review('browser_click', { ref, element: 'button' }, ctx);
    expect(viaRef.category).toBe('purchase');
    expect(viaSelector.category).toBe('purchase');
  }, 60_000);

  it('agent typing into the focused password field (no ref) is redacted in the action feed', async () => {
    await (await mgr.activePage()).goto(`${base}/login`);
    const snap = (await run(new BrowserSnapshotTool(), { interactive_only: true })).content;
    await run(new BrowserClickTool(), { ref: refOf(snap, 'textbox', 'Pass'), snapshot: false });
    actions.length = 0;
    const t = await run(new BrowserTypeTool(), { text: 'Typed-Secret-3', snapshot: false });
    expect(t.isError, t.content).toBeFalsy();
    expect(t.content).toContain('(hidden)');
    const rec = actions.find(a => a.tool === 'browser_type');
    expect(rec?.args.text).toBe('***');
    expect(rec?.element?.isPassword).toBe(true);
    expect(JSON.stringify(getBus().recent(30))).not.toContain('Typed-Secret-3');
  }, 60_000);

  it('a human typing into a password field inside a cross-origin iframe is redacted', async () => {
    const page = await mgr.activePage();
    await page.goto(`${base}/xo`);
    const field = page.frameLocator('#sso').locator('#sp');
    await field.waitFor();
    const box = await field.boundingBox();
    actions.length = 0;
    await mgr.dispatchInput({ type: 'click', x: box.x + 5, y: box.y + 5 });
    await mgr.dispatchInput({ type: 'type', text: 'Human-Secret-4' });
    await mgr.dispatchInput({ type: 'key', key: 'Alt+q' });
    expect(await field.inputValue()).toContain('Human-Secret-4');
    const typed = actions.find(a => a.actor === 'human' && a.tool === 'browser_type');
    expect(typed?.args.text).toBe('***');
    const key = actions.find(a => a.actor === 'human' && a.tool === 'browser_press');
    expect(key?.args.key).toBe('***');
    // The click is attributed to the field inside the frame, not to the <iframe>.
    const click = actions.find(a => a.actor === 'human' && a.tool === 'browser_click');
    expect(click?.element?.isPassword).toBe(true);
    expect(JSON.stringify(getBus().recent(30))).not.toContain('Human-Secret-4');

    // A normal text field in the same frame is still recorded verbatim.
    const user = page.frameLocator('#sso').locator('#su');
    const ub = await user.boundingBox();
    actions.length = 0;
    await mgr.dispatchInput({ type: 'click', x: ub.x + 5, y: ub.y + 5 });
    await mgr.dispatchInput({ type: 'type', text: 'bob' });
    expect(actions.find(a => a.tool === 'browser_type')?.args.text).toBe('bob');
  }, 60_000);

  it('the throwaway profile used while the real one is locked is deleted on close', async () => {
    const second = new QodexBrowserManager({ profilesDir: path.join(tmp, 'profiles'), downloadsDir: path.join(tmp, 'downloads'), config: { headless: true } });
    const dir = path.join(tmp, 'profiles', `default-${process.pid}`);
    try {
      await second.ensure();
      expect(second.status().profile).toBe(`default-${process.pid}`);
      await fs.access(dir);
    } finally {
      await second.close();
    }
    // close() already waits for the removal; allow a slow CI box a little more.
    for (let i = 0; i < 50; i++) {
      try { await fs.access(dir); } catch { break; }
      await new Promise(r => setTimeout(r, 100));
    }
    await expect(fs.access(dir)).rejects.toThrow();
    // The main profile is untouched.
    await fs.access(path.join(tmp, 'profiles', 'default'));
  }, 60_000);

  it('a target=_blank link (implicitly noopener) opens a tab that becomes active and is announced', async () => {
    const page = await mgr.activePage();
    await page.goto(`${base}/checkout`);
    await page.setContent(`<a href="${base}/login" target="_blank">open login</a> <a href="${base}/login" target="_blank" rel="noopener noreferrer">noopener</a>`);
    const before = mgr.tabs().length;
    const snap = (await run(new BrowserSnapshotTool(), { interactive_only: true })).content;
    const r = await run(new BrowserClickTool(), { ref: refOf(snap, 'link', 'noopener'), snapshot: false });
    expect(r.isError, r.content).toBeFalsy();
    expect(mgr.tabs().length).toBe(before + 1);
    expect(r.content).toMatch(/New tab opened: .*\/login/);
    expect(mgr.tabs()[before].active).toBe(true);
    await run(new BrowserTabsTool(), { action: 'close', snapshot: false });
  }, 30_000);

  it('browser_wait_for url matches a URL with a query string as a substring (not a glob)', async () => {
    const page = await mgr.activePage();
    await page.goto(`${base}/checkout?step=2&q=kettle`);
    const r = await run(new BrowserWaitForTool(), { kind: 'url', value: '/checkout?step=2', timeout_ms: 2000 });
    expect(r.isError, r.content).toBeFalsy();
    expect(r.content).toContain('✓ URL matched');
    const g = await run(new BrowserWaitForTool(), { kind: 'url', value: '**/checkout*', timeout_ms: 2000 });
    expect(g.isError, g.content).toBeFalsy();
    const g2 = await run(new BrowserWaitForTool(), { kind: 'url', value: '*checkout*', timeout_ms: 2000 });
    expect(g2.isError, g2.content).toBeFalsy();
  }, 30_000);

  it('a protected file:// page reached without browser_navigate (link click, redirect) is closed before the agent can read it', async () => {
    // The manager's own profile dir holds the session cookies (stand-in file).
    const prefs = path.join(tmp, 'profiles', 'default', 'qx-session-secret.txt');
    await fs.writeFile(prefs, 'COOKIE-JAR-SECRET-5 do not read');
    const url = 'file://' + prefs.split(path.sep).map(encodeURIComponent).join('/');
    // browser_navigate refuses it outright...
    const nav = await run(new BrowserNavigateTool(), { url, snapshot: false });
    expect(nav.content).toMatch(/^\[BROWSER_ERROR\] Refusing to open QodeX browser-profile/);
    // ...and a symlink to it as well.
    await fs.symlink(prefs, path.join(tmp, 'harmless.json'));
    const viaLink = await run(new BrowserNavigateTool(), { url: 'file://' + path.join(tmp, 'harmless.json'), snapshot: false });
    expect(viaLink.content).toMatch(/^\[BROWSER_ERROR\] Refusing/);
    // A page that gets there by other means (here: a direct goto, as a click on a
    // file:// directory listing would) is closed before any tool reads it.
    const page = await mgr.activePage();
    await page.goto(url);
    const r = await run(new BrowserSnapshotTool(), {});
    expect(r.content).toContain('Closed a page showing QodeX');
    const head = (await fs.readFile(prefs, 'utf8')).slice(0, 30);
    expect(head.length).toBeGreaterThan(5);
    expect(r.content).not.toContain(head);
    expect(mgr.activeUrl()).toBe('about:blank');
  }, 60_000);
});
