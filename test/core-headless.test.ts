/**
 * Headless (`--print`) mode: the unattended approval policy (the old code silently
 * ACCEPTED edit approvals while logging "denied"), sub-agent runner / active-agent
 * registration, brokered approvals when a remote channel exists, and SIGTERM → abort.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-core-headless-home-'));
const ORIG_HOME = process.env.HOME;

let F: typeof import('./core-fakes.js');
let H: typeof import('../src/cli/modes/headless.js');
let L: typeof import('../src/agent/loop.js');
let S: typeof import('../src/session/store.js');
let T: typeof import('../src/tools/builtin/task.js');
let A: typeof import('../src/control/approvals.js');
let B: typeof import('../src/control/bus.js');
let cwd: string;

beforeAll(async () => {
  process.env.HOME = HOME;
  F = await import('./core-fakes.js');
  H = await import('../src/cli/modes/headless.js');
  L = await import('../src/agent/loop.js');
  S = await import('../src/session/store.js');
  T = await import('../src/tools/builtin/task.js');
  A = await import('../src/control/approvals.js');
  B = await import('../src/control/bus.js');
  S.setSessionStoreForTests(new S.SessionStore(path.join(HOME, 'sessions-headless.db')));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-core-headless-cwd-'));
});

afterAll(() => {
  S?.setSessionStoreForTests(null);
  if (ORIG_HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIG_HOME;
  fs.rmSync(HOME, { recursive: true, force: true });
  if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  A.getApprovalBroker().reset();
});

describe('headlessAnswer (pure policy)', () => {
  it('without --yes: the safe option, never options[0]', () => {
    expect(H.headlessAnswer(['yes', 'no'], false)).toBe('no');
    expect(H.headlessAnswer(['yes', 'no', 'always'], false)).toBe('no');
    expect(H.headlessAnswer(['accept', 'edit', 'continue', 'reject'], false)).toBe('reject');
    expect(H.headlessAnswer(['approve', 'deny'], false)).toBe('deny');
    expect(H.headlessAnswer(['ok', 'fine'], false)).toBe('no');
    expect(H.headlessAnswer([], false)).toBe('no');
    expect(H.headlessAnswer(undefined, false)).toBe('no');
  });
  it('with --yes: the first approving option, else options[0]', () => {
    expect(H.headlessAnswer(['yes', 'no'], true)).toBe('yes');
    expect(H.headlessAnswer(['no', 'yes'], true)).toBe('yes');
    expect(H.headlessAnswer(['accept', 'edit', 'continue', 'reject'], true)).toBe('accept');
    expect(H.headlessAnswer(['deny', 'allow'], true)).toBe('allow');
    expect(H.headlessAnswer(['approve', 'deny'], true)).toBe('approve');
    expect(H.headlessAnswer(['foo', 'bar'], true)).toBe('foo');
  });
});

interface Captured { stdout: string[]; stderr: string[] }
function capture(): Captured {
  const c: Captured = { stdout: [], stderr: [] };
  vi.spyOn(process.stdout, 'write').mockImplementation(((s: any) => { c.stdout.push(String(s)); return true; }) as any);
  vi.spyOn(process.stderr, 'write').mockImplementation(((s: any) => { c.stderr.push(String(s)); return true; }) as any);
  vi.spyOn(console, 'error').mockImplementation((...a: any[]) => { c.stderr.push(a.join(' ')); });
  return c;
}

async function headless(opts: { tools: any[]; script: (r: any, i: number) => any; json?: boolean; yes?: boolean }) {
  const provider = new F.FakeProvider(opts.script);
  const code = await H.runHeadless({
    cwd,
    config: F.testConfig(),
    router: F.fakeRouter(provider),
    registry: new F.FakeRegistry(opts.tools) as any,
    permissions: F.allowAllPermissions,
    prompt: 'apply the change',
    json: !!opts.json,
    autoApproveAll: !!opts.yes,
    explicitModel: 'fake-model',
  });
  return { code, provider };
}

const approvalTool = () => new F.FakeTool('edit_like', async (_a, ctx) => ({
  content: `answer=${await ctx.askUser('Apply this edit to a.ts?', ['accept', 'edit', 'continue', 'reject'])}`,
}));

describe('runHeadless', () => {
  it('denies edit approvals without --yes (no more silent accept) and says so', async () => {
    const out = capture();
    const { code, provider } = await headless({
      tools: [approvalTool()],
      script: (_r, i) => (i === 0 ? { calls: [{ name: 'edit_like' }] } : { text: 'stopped' }),
    });
    expect(code).toBe(0);
    expect(F.toolResultsIn(provider.requests[1], 'edit_like')[0]).toBe('answer=reject');
    expect(out.stderr.join('')).toContain('auto-denied in headless mode');
  });

  it('approves with --yes and reports both outcomes in --json', async () => {
    const out = capture();
    const { provider } = await headless({
      tools: [approvalTool()],
      json: true,
      yes: true,
      script: (_r, i) => (i === 0 ? { calls: [{ name: 'edit_like' }] } : { text: 'done' }),
    });
    expect(F.toolResultsIn(provider.requests[1], 'edit_like')[0]).toBe('answer=accept');
    const lines = out.stdout.join('').split('\n').filter(Boolean).map(l => JSON.parse(l));
    const perm = lines.find(l => l.type === 'permission_request');
    expect(perm).toMatchObject({ prompt: 'Apply this edit to a.ts?', answer: 'accept', denied: false });
  });

  it('registers the sub-agent runner + active agent for the run, marks the process unattended, and cleans up', async () => {
    capture();
    A.setInteractiveHuman(true);
    let during: { runner: boolean; agent: boolean } | null = null;
    const probe = new F.FakeTool('probe', () => {
      during = { runner: T.getSubAgentRunner() !== null, agent: L.getActiveAgent() !== null };
      return { content: 'ok' };
    });
    await headless({ tools: [probe], script: (_r, i) => (i === 0 ? { calls: [{ name: 'probe' }] } : { text: 'done' }) });
    expect(during).toEqual({ runner: true, agent: true });
    expect(T.getSubAgentRunner()).toBeNull();
    expect(L.getActiveAgent()).toBeNull();
    expect(A.isInteractiveHuman()).toBe(false);
  });

  it('the task tool works in --print now (sub-agent runs on its own session)', async () => {
    capture();
    const { TaskTool } = await import('../src/tools/builtin/task.js');
    const { provider } = await headless({
      tools: [new TaskTool()],
      script: (req, i) => {
        const isSub = String(req.messages[0]?.content ?? '').includes('SUB-AGENT MODE');
        if (isSub) return { text: 'sub-agent result: 42' };
        return i === 0 ? { calls: [{ name: 'task', args: { description: 'compute', prompt: 'compute the answer' } }] } : { text: 'The answer is 42.' };
      },
    });
    const taskResult = provider.requests.map(r => F.toolResultsIn(r, 'task')).flat()[0]!;
    expect(taskResult).toMatch(/^\[SUBAGENT_DONE\]/);
    expect(taskResult).toContain('sub-agent result: 42');
  });

  it('routes prompts through the ApprovalBroker when a remote channel is attached (local policy answers)', async () => {
    capture();
    const delivered: string[] = [];
    const unregister = A.getApprovalBroker().registerChannel({ name: 'test-remote', deliver: (p) => { delivered.push(p.prompt); } });
    const events: any[] = [];
    const unsub = B.getBus().subscribe(ev => events.push(ev));
    try {
      const { provider } = await headless({
        tools: [approvalTool()],
        script: (_r, i) => (i === 0 ? { calls: [{ name: 'edit_like' }] } : { text: 'done' }),
      });
      expect(F.toolResultsIn(provider.requests[1], 'edit_like')[0]).toBe('answer=reject');
    } finally { unregister(); unsub(); }
    await new Promise(r => setTimeout(r, 10));
    expect(delivered).toEqual(['Apply this edit to a.ts?']);
    expect(events.find(e => e.kind === 'approval.requested')?.source).toBe('headless');
    expect(events.find(e => e.kind === 'approval.resolved')).toMatchObject({ answer: 'reject', by: 'local' });
  });

  it('SIGTERM aborts the run (handler installed for the run only; no SIGINT handler)', async () => {
    const out = capture();
    const before = process.listeners('SIGTERM').slice();
    const sigintBefore = process.listenerCount('SIGINT');
    let sigintDuring = -1;
    const killer = new F.FakeTool('killer', () => {
      sigintDuring = process.listenerCount('SIGINT');
      const added = process.listeners('SIGTERM').filter(l => !before.includes(l));
      expect(added.length).toBe(1);
      (added[0] as () => void)(); // what `kill -TERM` would trigger
      return { content: 'sent' };
    });
    const { code } = await headless({ tools: [killer], script: () => ({ calls: [{ name: 'killer', args: { t: Math.random() } }] }) });
    expect(code).toBe(1);
    expect(out.stderr.join('')).toMatch(/Cancelled/);
    expect(process.listeners('SIGTERM')).toEqual(before);
    expect(sigintDuring).toBe(sigintBefore);
  });
});

describe('unattendedAskUser (sub-agents without a parent asker)', () => {
  it('no channel → immediate safe answer; channel → waits for it; channel silent → times out safe', async () => {
    const ask = L.unattendedAskUser('subagent:test', 1);
    expect(await ask('Allow?', ['yes', 'no'])).toBe('no');

    const broker = A.getApprovalBroker();
    const unregister = broker.registerChannel({ name: 'phone', deliver: (p) => { setTimeout(() => broker.resolve(p.id, 'yes', 'phone'), 20); } });
    try { expect(await ask('Allow?', ['yes', 'no'])).toBe('yes'); } finally { unregister(); }

    const silent = broker.registerChannel({ name: 'silent', deliver: () => {} });
    try {
      const t0 = Date.now();
      expect(await ask('Allow?', ['yes', 'no'])).toBe('no');
      expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    } finally { silent(); }
  });
});
