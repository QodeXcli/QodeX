/**
 * G3.3 — an auto-mode ask shown in the TUI (destructive outside the project, an edit outside
 * it, Sentinel's own auto-mode asks) waits approval.unattendedTimeoutSec and is then denied
 * with a rewrite hint ([AUTO_MODE_TIMEOUT]). Sentinel-critical prompts and manual mode keep
 * waiting; remote answers (control center / Telegram) still count while it waits.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PermissionEngine, setApprovalMode } from '../src/security/permissions.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { getActiveConfig, setActiveConfig } from '../src/config/loader.js';
import { BashTool } from '../src/tools/shell/bash.js';
import { confirmEdit } from '../src/tools/filesystem/edit-approval.js';
import { getApprovalBroker, setInteractiveHuman, ApprovalBroker } from '../src/control/approvals.js';
import {
  askLocalWithTimeout, autoModeTimeoutMessage, formatWait, unattendedTimeoutSec, unansweredMessage,
} from '../src/security/human-approval.js';
import { Sentinel } from '../src/sentinel/guard.js';
import { DEFAULT_SENTINEL_CONFIG } from '../src/config/agent-config.js';
import { getBus } from '../src/control/bus.js';

const tmpRoots: string[] = [];
function project(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qx-cc-ask-')));
  tmpRoots.push(d);
  return d;
}
const homeTilde = () => `~/.qx-cc-ask-${process.pid}-${Math.random().toString(36).slice(2)}`;
const savedConfig = getActiveConfig();

/** Never answers (a human who walked away) unless `after` ms is given. */
function makeCtx(cwd: string, answer: { value: string; after?: number } | null, extra: Record<string, any> = {}) {
  const asked: string[] = [];
  const ran: string[] = [];
  const ctx: any = {
    cwd,
    sessionId: 's1',
    permissions: new PermissionEngine(DEFAULT_CONFIG as any),
    askUser: (prompt: string) => {
      asked.push(prompt);
      if (!answer) return new Promise<string>(() => {});
      return new Promise<string>(r => setTimeout(() => r(answer.value), answer.after ?? 0));
    },
    emit: () => {},
    exec: async (req: any) => { ran.push(req.command); return { code: 0, signal: null, stdout: 'ok', stderr: '', timedOut: false, truncated: false, backend: 'local' }; },
    ...extra,
  };
  return { ctx, asked, ran };
}

function setTimeoutSec(sec: number | undefined) {
  setActiveConfig({ ...DEFAULT_CONFIG, approval: sec === undefined ? {} : { unattendedTimeoutSec: sec } } as any);
}

beforeEach(() => { setInteractiveHuman(true); setTimeoutSec(0.05); });
afterEach(() => {
  setApprovalMode('manual');
  setInteractiveHuman(false);
  getApprovalBroker().reset();
  setActiveConfig(savedConfig as any);
  vi.useRealTimers();
});
afterAll(() => { for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true }); });

describe('message and config', () => {
  it('default 120 s → "No answer in 2 minutes — not done. Rewrite it …"', () => {
    setTimeoutSec(undefined);
    expect(unattendedTimeoutSec()).toBe(120);
    expect(autoModeTimeoutMessage('run `rm -rf ~/x`', 'deletes ~/x (outside the project)', 120)).toBe(
      '[AUTO_MODE_TIMEOUT] No answer in 2 minutes — not done. Rewrite it to stay inside the project (e.g. target a path ' +
      'under the workspace) or leave it for the user and continue with the rest.\n  Asked: run `rm -rf ~/x` — deletes ~/x (outside the project)',
    );
    expect(formatWait(60)).toBe('1 minute');
    expect(formatWait(45)).toBe('45 seconds');
    setTimeoutSec(0);
    expect(unattendedTimeoutSec()).toBe(0);
  });

  it('a remote-channel timeout (nobody at a terminal) keeps the old wording', () => {
    setInteractiveHuman(false);
    expect(unansweredMessage('run x', undefined, 'timeout')).toMatch(/^\[AUTO_MODE_NEEDS_HUMAN\] No approval arrived in time/);
  });

  it('askLocalWithTimeout gives up after the default 2 minutes (fake clock)', async () => {
    vi.useFakeTimers();
    const p = askLocalWithTimeout(() => new Promise<string>(() => {}), 'Run: x', ['yes', 'no'], 120);
    await vi.advanceTimersByTimeAsync(119_000);
    let settled = false;
    void p.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await p).toEqual({ answer: 'no', by: 'timeout' });
  });
});

describe('shell in auto mode, a human at the terminal', () => {
  it('no answer → [AUTO_MODE_TIMEOUT], the command is not run', async () => {
    setApprovalMode('auto');
    const target = homeTilde();
    const { ctx, asked, ran } = makeCtx(project(), null);
    const r = await new BashTool().execute({ command: `rm -rf ${target}` }, ctx);
    expect(asked).toHaveLength(1);
    expect(ran).toEqual([]);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/^\[AUTO_MODE_TIMEOUT\] No answer in .* — not done\. Rewrite it to stay inside the project/);
    expect(r.content).toContain(`Asked: run \`rm -rf ${target}\``);
  });

  it('the terminal prompt is withdrawn on timeout (and from the remote channels)', async () => {
    setApprovalMode('auto');
    const broker = getApprovalBroker();
    const retracted: string[] = [];
    broker.registerChannel({ name: 'phone', deliver: () => {}, retract: (id) => { retracted.push(id); } });
    let dismissed = false;
    // The TUI's askUser: the prompt goes through the broker; the terminal asker gets a signal.
    const tuiAsk = (prompt: string, options: string[]) => broker.request({ prompt, options, source: 'terminal' },
      (_p, _o, signal) => new Promise<string>(res => signal.addEventListener('abort', () => { dismissed = true; res('no'); }))).then(r => r.answer);
    const { ctx, ran } = makeCtx(project(), null, { askUser: tuiAsk });
    const r = await new BashTool().execute({ command: `rm -rf ${homeTilde()}` }, ctx);
    expect(r.content).toMatch(/^\[AUTO_MODE_TIMEOUT\]/);
    expect(ran).toEqual([]);
    expect(broker.pending()).toHaveLength(0);
    expect(dismissed).toBe(true);
    expect(retracted).toHaveLength(1);
  });

  it('a Telegram / control-center answer while it waits still counts', async () => {
    setApprovalMode('auto');
    setTimeoutSec(5);
    const broker = getApprovalBroker();
    broker.registerChannel({ name: 'telegram', deliver: (p) => { setTimeout(() => broker.resolve(p.id, 'yes', 'telegram'), 10); } });
    const tuiAsk = (prompt: string, options: string[]) => broker.request({ prompt, options, source: 'terminal' },
      (_p, _o, signal) => new Promise<string>(res => signal.addEventListener('abort', () => res('no')))).then(r => r.answer);
    const target = homeTilde();
    const { ctx, ran } = makeCtx(project(), null, { askUser: tuiAsk });
    const r = await new BashTool().execute({ command: `rm -rf ${target}` }, ctx);
    expect(r.isError).toBeFalsy();
    expect(ran).toEqual([`rm -rf ${target}`]);
  });

  it('a late answer inside the window counts; 0 = wait forever', async () => {
    setApprovalMode('auto');
    setTimeoutSec(0);
    const target = homeTilde();
    const { ctx, ran } = makeCtx(project(), { value: 'yes', after: 120 });
    await new BashTool().execute({ command: `rm -rf ${target}` }, ctx);
    expect(ran).toEqual([`rm -rf ${target}`]);
  });
});

describe('what never times out', () => {
  it('manual mode: an ordinary prompt keeps waiting past the timeout', async () => {
    const { ctx, ran } = makeCtx(project(), { value: 'yes', after: 150 });
    const r = await new BashTool().execute({ command: 'docker compose up' }, ctx);
    expect(r).toBeTruthy();
    expect(ran).toEqual(['docker compose up']);
  });

  it('Sentinel-critical (a purchase) in auto mode keeps waiting; Sentinel auto-asks time out', async () => {
    setApprovalMode('auto');
    getBus().reset();
    const tmp = project();
    const shop = {
      isRunning: () => true,
      activeUrl: () => 'https://shop.example.com/account',
      describeRef: (ref: string) => Promise.resolve(ref === 'order'
        ? { role: 'button', tag: 'button', name: 'Place order' }
        : { role: 'button', tag: 'button', name: 'Delete' }),
      describeSelector: () => Promise.resolve(null),
    } as any;
    const s = new Sentinel({
      config: () => ({ ...DEFAULT_SENTINEL_CONFIG, audit: false }),
      audit: null,
      broker: () => new ApprovalBroker(),
      interactive: () => true,
      browser: () => shop,
      workflowsDir: path.join(tmp, 'workflows'),
    });
    const critical = makeCtx(tmp, { value: 'yes', after: 150 });
    expect(await s.beforeTool('browser_click', { ref: 'order' }, critical.ctx)).toBeNull();
    expect(critical.asked).toHaveLength(1);

    const autoAsk = makeCtx(tmp, null);
    const r = await s.beforeTool('browser_click', { ref: 'del' }, autoAsk.ctx);
    expect(autoAsk.asked[0]).toMatch(/Auto mode still asks/);
    expect(r?.isError).toBe(true);
    expect(r?.content).toMatch(/^\[AUTO_MODE_TIMEOUT\] No answer in .* — not done\./);
  });

  it('an edit outside the project times out the same way', async () => {
    setApprovalMode('auto');
    const cwd = project();
    const outside = path.join(os.homedir(), `.qx-cc-ask-edit-${process.pid}`);
    const { ctx } = makeCtx(cwd, null);
    const d = await confirmEdit(ctx, {
      rel: outside, before: 'a', after: 'b', absPath: outside,
      permReq: { tool: 'write_file', operation: outside, cwd }, label: `Write ${outside}?`,
    });
    expect(d.kind).toBe('reject');
    expect((d as any).message).toMatch(/^\[AUTO_MODE_TIMEOUT\]/);
    expect(fs.existsSync(outside)).toBe(false);
  });
});
