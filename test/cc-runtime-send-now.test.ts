/**
 * G3.2 — "Send now": a running foreground shell command is moved to a background job instead
 * of being killed when the turn ends; its call returns [MOVED_TO_BACKGROUND]; the process stays
 * alive and its output is readable through the background_job_* tools. Plus the key detection
 * and the next-turn prompt the TUI builds, and the loop side of the hand-off (the moved result is
 * recorded, the steering note survives for the next turn).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-cc-sendnow-home-'));
const ORIG_HOME = process.env.HOME;

let SN: typeof import('../src/tools/shell/send-now.js');
let BJ: typeof import('../src/tools/builtin/background-jobs.js');
let BashTool: typeof import('../src/tools/shell/bash.js').BashTool;
let F: typeof import('./core-fakes.js');
let L: typeof import('../src/agent/loop.js');
let S: typeof import('../src/session/store.js');
let cwd: string;

beforeAll(async () => {
  process.env.HOME = HOME;
  SN = await import('../src/tools/shell/send-now.js');
  BJ = await import('../src/tools/builtin/background-jobs.js');
  BashTool = (await import('../src/tools/shell/bash.js')).BashTool;
  F = await import('./core-fakes.js');
  L = await import('../src/agent/loop.js');
  S = await import('../src/session/store.js');
  S.setSessionStoreForTests(new S.SessionStore(path.join(HOME, 'sessions-sendnow.db')));
  cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qx-cc-sendnow-cwd-')));
});

afterAll(() => {
  S?.setSessionStoreForTests(null);
  if (ORIG_HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIG_HOME;
  fs.rmSync(HOME, { recursive: true, force: true });
  if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
});

const allow: any = { evaluate: () => 'allow', rememberDecision: () => {} };
function ctxFor(signal: AbortSignal, extra: Record<string, any> = {}) {
  const lines: string[] = [];
  const ctx: any = {
    cwd, sessionId: 's', permissions: allow, signal,
    askUser: async () => 'no',
    emit: (e: any) => { if (e.type === 'shell-stdout') lines.push(e.line); },
    ...extra,
  };
  return { ctx, lines };
}
const until = async (cond: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise(r => setTimeout(r, 20));
  }
};
const status = (id: string) => new BJ.BackgroundJobStatusTool().execute({ id }, {} as any);

describe('keys and texts', () => {
  it('Ctrl+Enter (LF, kitty CSI-u, xterm modifyOtherKeys) and the Ctrl+X Ctrl+S chord', () => {
    expect(SN.sendNowKey('\n', {}, false)).toBe('send');
    expect(SN.sendNowKey('[13;5u', { ctrl: true }, false)).toBe('send');
    expect(SN.sendNowKey('[27;5;13~', { ctrl: true }, false)).toBe('send');
    expect(SN.sendNowKey('x', { ctrl: true }, false)).toBe('arm');
    expect(SN.sendNowKey('s', { ctrl: true }, true)).toBe('send');
    expect(SN.sendNowKey('s', { ctrl: true }, false)).toBeNull();
    expect(SN.sendNowKey('\r', { return: true }, false)).toBeNull();
    expect(SN.sendNowKey('a', {}, true)).toBeNull();
  });

  it('the next-turn prompt merges what was queued and names the background jobs', () => {
    const moved = [{ jobId: 'job_1', command: 'npm test', cwd: '/p', pid: 42 }];
    expect(SN.buildSendNowPrompt(['use pnpm', ' also lint '], moved)).toBe(
      '[Send now: I ended the previous turn early so this goes in right away. Still running as background jobs: job_1 (`npm test`) ' +
      '— check them with background_job_status / background_job_log.]\n\nuse pnpm\n\nalso lint',
    );
    expect(SN.buildSendNowPrompt([], [])).toMatch(/\n\nContinue with my latest note\.$/);
    expect(SN.movedResult(moved[0]!)).toMatch(/^\[MOVED_TO_BACKGROUND\] job job_1 — check it with background_job_status\n`npm test` keeps running in the background \(cwd \/p, pid 42\)/);
    expect(SN.sendNowLine(moved)).toBe('⏩ Sending now — the running turn ends; kept running as background job: job_1 (npm test)');
  });
});

describe('scope', () => {
  it("the turn's own and its sub-agents' shells move; side runs (/background) do not", () => {
    expect(SN.belongsToTurn('s1', 's1')).toBe(true);
    expect(SN.belongsToTurn('s1/sub-123', 's1')).toBe(true);
    expect(SN.belongsToTurn('s1/fanout-2', 's1')).toBe(true);
    expect(SN.belongsToTurn('s1/bg1', 's1')).toBe(false);
    expect(SN.belongsToTurn('s1/bg1/sub-9', 's1')).toBe(false);
    expect(SN.belongsToTurn('s10', 's1')).toBe(false);
    expect(SN.belongsToTurn(undefined, 's1')).toBe(false);
  });

  it('detachForegroundShells({ sessionId }) leaves other sessions running in the foreground', async () => {
    const turn = new AbortController();
    const mine = ctxFor(turn.signal, { sessionId: 'turn-a' });
    const side = ctxFor(turn.signal, { sessionId: 'turn-a/bg1' });
    const p1 = new BashTool().execute({ command: 'sleep 0.5; echo mine' }, mine.ctx);
    const p2 = new BashTool().execute({ command: 'sleep 0.5; echo side' }, side.ctx);
    await until(() => SN.foregroundShellCount() === 2);
    expect(SN.foregroundShellCount({ sessionId: 'turn-a' })).toBe(1);
    const moved = SN.detachForegroundShells({ sessionId: 'turn-a' });
    expect(moved).toHaveLength(1);
    expect((await p1).content).toMatch(/^\[MOVED_TO_BACKGROUND\]/);
    const r2 = await p2;
    expect(r2.content).toContain('side');
    expect(r2.content).not.toContain('MOVED_TO_BACKGROUND');
    await new BJ.BackgroundJobWaitTool().execute({ id: moved[0]!.jobId, timeout_ms: 5000 }, {} as any);
  });
});

describe('the shell tool, real processes', () => {
  it('detach keeps the process alive past the end of the turn; output readable via background_job_*', async () => {
    const turn = new AbortController();
    const { ctx, lines } = ctxFor(turn.signal);
    const marker = path.join(cwd, 'finished.txt');
    const pending = new BashTool().execute({ command: `echo start; sleep 0.6; echo middle; sleep 0.4; echo end; echo ok > ${marker}` }, ctx);
    await until(() => lines.includes('start'));
    expect(SN.foregroundShellCount()).toBe(1);
    const moved = SN.detachForegroundShells();
    expect(moved).toHaveLength(1);
    turn.abort(); // the turn ends — the command must NOT die with it
    const r = await pending;
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(new RegExp(`^\\[MOVED_TO_BACKGROUND\\] job ${moved[0]!.jobId} — check it with background_job_status`));
    expect(r.metadata?.movedToBackground).toBe(moved[0]!.jobId);
    expect(SN.foregroundShellCount()).toBe(0);

    const running = await status(moved[0]!.jobId);
    expect(running.content).toMatch(/Status: running/);
    expect(running.content).toContain('(moved from the foreground by Send now)');
    expect(running.content).toContain(`Cwd: ${cwd}`);

    const waited = await new BJ.BackgroundJobWaitTool().execute({ id: moved[0]!.jobId, timeout_ms: 10_000 }, {} as any);
    expect(waited.content).toMatch(/finished: completed/);
    expect(waited.content).toMatch(/Exit code: 0/);
    const log = await new BJ.BackgroundJobLogTool().execute({ id: moved[0]!.jobId }, {} as any);
    expect(log.content).toMatch(/start\nmiddle\nend/);
    expect(fs.readFileSync(marker, 'utf8').trim()).toBe('ok');
  });

  it('without send now, ending the turn still kills the command (unchanged)', async () => {
    const turn = new AbortController();
    const { ctx } = ctxFor(turn.signal);
    const t0 = Date.now();
    const pending = new BashTool().execute({ command: 'sleep 5; echo never' }, ctx);
    await until(() => SN.foregroundShellCount() === 1);
    turn.abort();
    const r = await pending;
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(r.content).not.toContain('never');
    expect(r.metadata?.movedToBackground).toBeUndefined();
  });

  it('background_job_cancel stops a moved command', async () => {
    const turn = new AbortController();
    const { ctx } = ctxFor(turn.signal);
    const pending = new BashTool().execute({ command: 'sleep 30' }, ctx);
    await until(() => SN.foregroundShellCount() === 1);
    const [m] = SN.detachForegroundShells();
    turn.abort();
    await pending;
    const c = await new BJ.BackgroundJobCancelTool().execute({ id: m!.jobId }, {} as any);
    expect(c.content).toBe(`Cancelled ${m!.jobId}`);
    expect((await status(m!.jobId)).content).toMatch(/Status: cancelled/);
  });

  it('a runtime that reports its pid (onSpawn) — the job keeps it and the timeout is released', async () => {
    let released = false;
    let finish: (r: any) => void = () => {};
    const exec = (req: any) => {
      req.onSpawn?.({ pid: 4242, releaseTimeout: () => { released = true; } });
      req.onStdoutLine?.('hello');
      return new Promise<any>(res => { finish = res; });
    };
    const turn = new AbortController();
    const { ctx } = ctxFor(turn.signal, { exec });
    const pending = new BashTool().execute({ command: 'long-thing' }, ctx);
    await until(() => SN.foregroundShellCount() === 1);
    const [m] = SN.detachForegroundShells();
    turn.abort();
    expect((await pending).content).toContain('pid 4242');
    expect(released).toBe(true);
    expect((await status(m!.jobId)).content).toContain('PID: 4242');
    finish({ code: 0, signal: null, stdout: 'hello\nbye\n', stderr: '', timedOut: false, truncated: false, backend: 'local' });
    await new Promise(r => setTimeout(r, 10));
    expect((await status(m!.jobId)).content).toMatch(/Status: completed/);
    const log = await new BJ.BackgroundJobLogTool().execute({ id: m!.jobId }, {} as any);
    expect(log.content).toBe('hello\nbye\n');
  }, 10_000);
});

describe('agent loop side of the hand-off', () => {
  it('ending the turn at iteration_done records the moved result; the steering note survives', async () => {
    const provider = new F.FakeProvider((_req, i) => (i === 0
      ? { calls: [{ name: 'shell', args: { command: 'echo begin; sleep 0.8; echo after' } }] }
      : { text: 'should not be reached' }));
    const agent = new L.AgentLoop({
      router: F.fakeRouter(provider), registry: new F.FakeRegistry([new BashTool()]) as any,
      permissions: F.allowAllPermissions, config: F.testConfig(), cwd,
    });
    const sid = S.getSessionStore().createSession(cwd, 'fake-model');
    const ac = new AbortController();
    let moved: import('../src/tools/shell/send-now.js').MovedShell[] = [];
    const watcher = setInterval(() => {
      if (moved.length === 0 && SN.foregroundShellCount() === 1) {
        agent.pushSteer('use pnpm instead');
        moved = SN.detachForegroundShells(); // what the TUI's Ctrl+Enter does
      }
    }, 10);
    const t0 = Date.now();
    try {
      for await (const ev of agent.run([{ role: 'system', content: 's' }, { role: 'user', content: 'run it' }], sid, {
        askUser: async () => 'no', signal: ac.signal,
      })) {
        if (ac.signal.aborted) break;
        if (ev.type === 'iteration_done' && moved.length > 0) { ac.abort(); break; }
      }
    } finally {
      clearInterval(watcher);
    }
    expect(moved).toHaveLength(1);
    expect(Date.now() - t0).toBeLessThan(700); // did not wait for the 0.8 s command
    expect(provider.requests).toHaveLength(1);
    const msgs = S.getSessionStore().loadSession(sid)!.messages;
    const toolMsg = msgs.find(m => m.role === 'tool');
    expect(String(toolMsg?.content)).toMatch(/^\[MOVED_TO_BACKGROUND\] job /);
    expect(agent.hasPendingSteer()).toBe(true); // injected at the next turn's first step
    const waited = await new BJ.BackgroundJobWaitTool().execute({ id: moved[0]!.jobId, timeout_ms: 10_000 }, {} as any);
    expect(waited.content).toMatch(/begin\nafter/);
  });
});
