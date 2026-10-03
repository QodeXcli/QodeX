/**
 * Headless `--print --yes`: `--yes` means AUTO MODE, not "answer yes".
 *   - in-project work runs with no permission prompt at all;
 *   - outside-project destructive / force push / publish never run unattended: refused with
 *     [AUTO_MODE_NEEDS_HUMAN] (how to approve), or carried to a remote human when one is
 *     attached — never answered yes (the old --yes ran `rm -rf` and `npm publish`).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// NOT under the temp dir: the temp dir is a workspace root, so a $HOME there would make
// "~/x" count as inside the project.
const HOME = fs.mkdtempSync(path.join(os.homedir(), '.qx-auto-headless-home-'));
const ORIG_HOME = process.env.HOME;

let F: typeof import('./core-fakes.js');
let H: typeof import('../src/cli/modes/headless.js');
let S: typeof import('../src/session/store.js');
let A: typeof import('../src/control/approvals.js');
let P: typeof import('../src/security/permissions.js');
let BashTool: typeof import('../src/tools/shell/bash.js').BashTool;
let cwd: string;
let outsideName: string;

beforeAll(async () => {
  process.env.HOME = HOME;
  F = await import('./core-fakes.js');
  H = await import('../src/cli/modes/headless.js');
  S = await import('../src/session/store.js');
  A = await import('../src/control/approvals.js');
  P = await import('../src/security/permissions.js');
  BashTool = (await import('../src/tools/shell/bash.js')).BashTool;
  S.setSessionStoreForTests(new S.SessionStore(path.join(HOME, 'sessions-auto-headless.db')));
  // The project must not be under the temp dir (a workspace root) for "outside" to exist:
  // put it in a fake $HOME, and aim the outside target at that $HOME.
  const projects = path.join(os.homedir(), 'projects');
  fs.mkdirSync(projects, { recursive: true });
  cwd = fs.mkdtempSync(path.join(projects, 'proj-'));
  outsideName = 'keep-me';
  fs.mkdirSync(path.join(os.homedir(), outsideName), { recursive: true });
});

afterAll(() => {
  S?.setSessionStoreForTests(null);
  if (ORIG_HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIG_HOME;
  fs.rmSync(HOME, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  A.getApprovalBroker().reset();
  P.setApprovalMode('manual');
});

function capture() {
  const c = { stdout: [] as string[], stderr: [] as string[] };
  vi.spyOn(process.stdout, 'write').mockImplementation(((s: any) => { c.stdout.push(String(s)); return true; }) as any);
  vi.spyOn(process.stderr, 'write').mockImplementation(((s: any) => { c.stderr.push(String(s)); return true; }) as any);
  vi.spyOn(console, 'error').mockImplementation((...a: any[]) => { c.stderr.push(a.join(' ')); });
  return c;
}

async function run(commands: string[], opts: { yes: boolean; json?: boolean }) {
  const provider = new F.FakeProvider((_r, i) => (i < commands.length ? { calls: [{ name: 'shell', args: { command: commands[i] } }] } : { text: 'done' }));
  const code = await H.runHeadless({
    cwd,
    config: F.testConfig(),
    router: F.fakeRouter(provider),
    registry: new F.FakeRegistry([new BashTool()]) as any,
    permissions: new P.PermissionEngine(F.testConfig()),
    prompt: 'do the work',
    json: !!opts.json,
    autoApproveAll: opts.yes,
    explicitModel: 'fake-model',
  });
  const results = provider.requests.map(r => F.toolResultsIn(r, 'shell')).flat();
  return { code, results: [...new Set(results)] };
}

describe('headless --yes = auto mode', () => {
  it('in-project work runs without any prompt; outside / remote work is refused and explains how to approve', async () => {
    const out = capture();
    const { results } = await run([
      'echo ok > out.txt',
      `rm -r ~/${outsideName}`,
      'git push --force origin main',
    ], { yes: true, json: true });
    expect(fs.readFileSync(path.join(cwd, 'out.txt'), 'utf8').trim()).toBe('ok');
    expect(fs.existsSync(path.join(os.homedir(), outsideName))).toBe(true); // NOT deleted
    expect(results[1]).toMatch(/^\[AUTO_MODE_NEEDS_HUMAN\] Not done: run `rm -r ~\/keep-me` — deletes ~\/keep-me \(outside the project\)/);
    expect(results[2]).toMatch(/^\[AUTO_MODE_NEEDS_HUMAN\].*force push/);
    for (const r of results.slice(1)) expect(r).toMatch(/interactively.*control center.*Telegram/s);
    // No prompt was answered yes (there were no prompts at all — the tool refused before asking).
    const lines = out.stdout.join('').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return {}; } });
    expect(lines.filter((l: any) => l.type === 'permission_request' && !l.denied)).toEqual([]);
    expect(P.getApprovalMode()).toBe('manual');
  });

  it('with a remote channel attached, the remote human decides (a "no" stops it)', async () => {
    capture();
    const broker = A.getApprovalBroker();
    const seen: string[] = [];
    const unregister = broker.registerChannel({ name: 'phone', deliver: (p) => { seen.push(p.prompt); setTimeout(() => broker.resolve(p.id, 'no', 'phone'), 5); } });
    try {
      const { results } = await run([`rm -r ~/${outsideName}`], { yes: true });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatch(/Auto mode still asks: deletes ~\/keep-me/);
      expect(results[0]).toMatch(/^\[USER_REJECTED\]/);
      expect(fs.existsSync(path.join(os.homedir(), outsideName))).toBe(true);
    } finally { unregister(); }
  });

  it('without --yes (manual) a non-allow-listed command is still denied as before', async () => {
    const out = capture();
    const { results } = await run(['touch made.txt'], { yes: false });
    expect(results[0]).toMatch(/^\[USER_REJECTED\]/);
    expect(fs.existsSync(path.join(cwd, 'made.txt'))).toBe(false);
    expect(out.stderr.join('')).toContain('auto-denied in headless mode');
  });

  it('the headless asker never answers yes in auto mode — even with autoYes — and reports why', async () => {
    P.setApprovalMode('auto');
    const lines: string[] = [];
    const warned: string[] = [];
    const ask = H.makeHeadlessAskUser({ autoYes: true, json: false, write: (l) => lines.push(l), warn: (l) => warned.push(l) });
    expect(await ask('🛡 Sentinel — approval needed\nAction: delete repo on github.com\nAllow this action?', ['yes', 'no', 'always'])).toBe('no');
    expect(await ask('Overwrite ../x?', ['accept', 'always yes', 'edit', 'continue', 'reject'])).toBe('reject');
    expect(warned[0]).toMatch(/^\[AUTO_MODE_NEEDS_HUMAN\] Not done: Action: delete repo on github\.com · Allow this action\?/);
    const json = H.makeHeadlessAskUser({ autoYes: false, json: true, write: (l) => lines.push(l) });
    expect(await json('Run: npm publish', ['yes', 'no'])).toBe('no');
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: 'permission_request', answer: 'no', denied: true, needsHuman: true });
  });

  it('headlessAskChoice (also used by bot /auto) never affirms while the session is in auto mode', async () => {
    const { headlessAskChoice } = await import('../src/cli/modes/headless-ask.js');
    expect(headlessAskChoice(['yes', 'no'], true)).toEqual({ choice: 'yes', denied: false });
    P.setApprovalMode('auto');
    expect(headlessAskChoice(['yes', 'no'], true)).toEqual({ choice: 'no', denied: true });
    expect(headlessAskChoice(['accept', 'always yes', 'edit', 'continue', 'reject'], true)).toEqual({ choice: 'reject', denied: true });
  });
});
