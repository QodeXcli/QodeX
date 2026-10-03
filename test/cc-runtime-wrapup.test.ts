/**
 * G3.1 — wrap-up allowance: a budget cap reached mid-task grants ONE allowance (a system note
 * "Budget reached: wrap up …", max(percent, min) more tokens / USD / wall clock, at most
 * `maxIterations` more model calls, the last without tools); exceeding it is the hard stop,
 * marked "(wrap-up allowance used)". Off for sub-agents (hard contracts) and --strict-budget.
 * Driven through a REAL AgentLoop (and runHeadless) with a scripted provider.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-cc-wrapup-home-'));
const ORIG_HOME = process.env.HOME;

let F: typeof import('./core-fakes.js');
let L: typeof import('../src/agent/loop.js');
let S: typeof import('../src/session/store.js');
let H: typeof import('../src/cli/modes/headless.js');
let B: typeof import('../src/agent/budget.js');
let W: typeof import('../src/agent/budget-wrapup.js');
let cwd: string;

beforeAll(async () => {
  process.env.HOME = HOME;
  F = await import('./core-fakes.js');
  L = await import('../src/agent/loop.js');
  S = await import('../src/session/store.js');
  H = await import('../src/cli/modes/headless.js');
  B = await import('../src/agent/budget.js');
  W = await import('../src/agent/budget-wrapup.js');
  S.setSessionStoreForTests(new S.SessionStore(path.join(HOME, 'sessions-wrapup.db')));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-cc-wrapup-cwd-'));
});

afterAll(() => {
  S?.setSessionStoreForTests(null);
  if (ORIG_HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIG_HOME;
  fs.rmSync(HOME, { recursive: true, force: true });
  if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
});

afterEach(() => { vi.restoreAllMocks(); });

const NOTE = 'Budget reached: wrap up.';
const sawNote = (req: any) => req.messages.some((m: any) => typeof m.content === 'string' && m.content.includes(NOTE));

/** Calls `work` every turn; once it has seen the wrap-up note it either summarizes or keeps going. */
function script(opts: { obeys: boolean }) {
  let n = 0;
  return (req: any) => {
    if (opts.obeys && sawNote(req)) return { text: 'Summary: reverted the half edit; left: the tests.' };
    return { calls: [{ name: 'work', args: { n: n++ } }] };
  };
}

async function run(opts: { obeys: boolean; wrapUp?: boolean; budget?: Record<string, unknown>; maxIterationsOverride?: number }) {
  const provider = new F.FakeProvider(script({ obeys: opts.obeys }));
  const work = new F.FakeTool('work');
  // Each call reports 100 input + 20 output; novel tokens: 120, then 20 per call.
  const cfg = F.testConfig({ budget: { ...F.testConfig().budget, perTaskMaxTokens: 150, ...(opts.budget ?? {}) } });
  const agent = new L.AgentLoop({
    router: F.fakeRouter(provider), registry: new F.FakeRegistry([work]) as any,
    permissions: F.allowAllPermissions, config: cfg, cwd,
  });
  const sid = S.getSessionStore().createSession(cwd, 'fake-model');
  const events: any[] = [];
  for await (const ev of agent.run([{ role: 'system', content: 's' }, { role: 'user', content: 'refactor the module' }], sid, {
    askUser: async () => 'no',
    wrapUpAllowance: opts.wrapUp ?? true,
    ...(opts.maxIterationsOverride !== undefined ? { maxIterationsOverride: opts.maxIterationsOverride } : {}),
  })) events.push(ev);
  return { provider, work, events, sid };
}

describe('BudgetTracker.grantWrapUp', () => {
  it('raises every finite cap by max(percent, minimum) over what is used, once', () => {
    const b = new B.BudgetTracker(200_000, 1, 600, 50);
    b.consume({ tokens: 210_000, costUsd: 0.5 });
    for (let i = 0; i < 10; i++) b.incrementIteration();
    const cfg = W.resolveWrapUp({});
    const g = b.grantWrapUp({ message: 'Token budget exceeded: 210000/200000', budgetType: 'tokens' }, cfg)!;
    expect(g).toMatchObject({ budgetType: 'tokens', steps: 3, tokens: 20_000, usd: 0.1, wallSeconds: 60, grantedAt: 10 });
    expect(() => b.checkpoint()).not.toThrow();
    b.consume({ tokens: 20_001 });
    expect(() => b.checkpoint()).toThrow(/Token budget exceeded: 230001\/230000/);
    expect(b.grantWrapUp({ message: 'again', budgetType: 'tokens' }, cfg)).toBeNull();
  });

  it('minimums apply to small caps; steps count model calls (the last one is the summary)', () => {
    const b = new B.BudgetTracker(1000, 0.1, 0, 0);
    b.incrementIteration();
    const g = b.grantWrapUp({ message: 'm', budgetType: 'cost' }, W.resolveWrapUp({ maxIterations: 2 }))!;
    expect(g.tokens).toBe(4000);
    expect(g.usd).toBe(0.05);
    expect(g.wallSeconds).toBeUndefined(); // no wall cap → nothing to raise
    expect(b.wrapUpLastStep()).toBe(false);
    expect(b.wrapUpExhausted()).toBe(false);
    b.incrementIteration();
    expect(b.wrapUpLastStep()).toBe(true);
    b.incrementIteration();
    expect(b.wrapUpExhausted()).toBe(true);
  });

  it('disabled in config → no allowance', () => {
    const b = new B.BudgetTracker(10, 0, 0, 0);
    expect(b.grantWrapUp({ message: 'm', budgetType: 'tokens' }, W.resolveWrapUp({ enabled: false }))).toBeNull();
  });
});

describe('agent loop', () => {
  it('cap hit → the note is injected → the run finishes within the allowance', async () => {
    const { provider, events } = await run({ obeys: true });
    expect(events.some(e => e.type === 'error')).toBe(false);
    const notice = events.find(e => e.type === 'notice' && /wrapping up/.test(e.data?.message));
    expect(notice?.data.message).toMatch(/^⏳ Token budget exceeded: 160\/150 — wrapping up: up to 3 more steps/);
    const firstWithNote = provider.requests.findIndex(sawNote);
    expect(firstWithNote).toBeGreaterThan(0);
    const note = provider.requests[firstWithNote]!.messages.find((m: any) => String(m.content).includes(NOTE))!;
    expect(String(note.content)).toContain('Budget reached: wrap up. Leave the work consistent (finish or revert the half-made change, run the quick check if any), summarize what is done and what is left. Do not start anything new.');
    expect(provider.requests.length).toBe(firstWithNote + 1);
    const final = events.find(e => e.type === 'final');
    expect(final?.data.content).toMatch(/^Summary:/);
  });

  it('exceeding the allowance → hard stop "(wrap-up allowance used)"; the last step has no tools', async () => {
    const { provider, work, events } = await run({ obeys: false });
    const err = events.find(e => e.type === 'error');
    expect(err?.data.message).toBe('Token budget exceeded: 160/150 (wrap-up allowance used)');
    expect(err?.data.budgetType).toBe('tokens');
    const firstWithNote = provider.requests.findIndex(sawNote);
    expect(provider.requests.length - firstWithNote).toBe(3); // exactly maxIterations more calls
    expect((provider.requests.at(-1)!.tools ?? []).length).toBe(0);
    expect((provider.requests[firstWithNote]!.tools ?? []).length).toBeGreaterThan(0);
    expect(work.calls.length).toBeGreaterThan(0);
  });

  it('without the allowance (sub-agents, --strict-budget) the cap stops at once, no note', async () => {
    const { provider, events } = await run({ obeys: true, wrapUp: false });
    expect(events.find(e => e.type === 'error')?.data.message).toBe('Token budget exceeded: 160/150');
    expect(provider.requests.some(sawNote)).toBe(false);
  });

  it('config budget.wrapUp.enabled: false turns it off', async () => {
    const { events } = await run({ obeys: true, budget: { wrapUp: { enabled: false } } });
    expect(events.find(e => e.type === 'error')?.data.message).toBe('Token budget exceeded: 160/150');
  });

  it('an explicit iteration cap (/iterations N) gets the allowance too', async () => {
    const { provider, events } = await run({ obeys: false, budget: { perTaskMaxTokens: 0 }, maxIterationsOverride: 2 });
    const err = events.find(e => e.type === 'error');
    expect(err?.data.message).toBe('Iteration budget exceeded: 3/2 (wrap-up allowance used)');
    expect(err?.data.budgetType).toBe('iterations');
    expect(provider.requests.length).toBe(2 + 3);
  });

  it('sub-agents keep their caps as hard contracts', async () => {
    const provider = new F.FakeProvider(() => ({ calls: [{ name: 'work' }] }));
    const agent = new L.AgentLoop({
      router: F.fakeRouter(provider), registry: new F.FakeRegistry([new F.FakeTool('work')]) as any,
      permissions: F.allowAllPermissions, config: F.testConfig(), cwd,
    });
    const r = await agent.runSubagent('x', { maxIterations: 2, sessionId: `root/sub-wrap-${Date.now()}` });
    expect(r.error).toMatch(/^Iteration budget exceeded: 3\/2$/);
    expect(provider.requests.length).toBe(2);
  });
});

describe('headless', () => {
  async function headless(strictBudget: boolean) {
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((s: any) => { out.push(String(s)); return true; }) as any);
    vi.spyOn(process.stderr, 'write').mockImplementation(((s: any) => { out.push(String(s)); return true; }) as any);
    vi.spyOn(console, 'error').mockImplementation((...a: any[]) => { out.push(a.join(' ')); });
    const provider = new F.FakeProvider(script({ obeys: true }));
    const code = await H.runHeadless({
      cwd,
      config: F.testConfig({ budget: { ...F.testConfig().budget, perTaskMaxTokens: 150 } }),
      router: F.fakeRouter(provider),
      registry: new F.FakeRegistry([new F.FakeTool('work')]) as any,
      permissions: F.allowAllPermissions,
      prompt: 'refactor the module',
      json: false,
      explicitModel: 'fake-model',
      strictBudget,
    });
    return { code, out: out.join(''), provider };
  }

  it('a headless run gets the allowance and ends with the summary', async () => {
    const { code, out } = await headless(false);
    expect(code).toBe(0);
    expect(out).toMatch(/wrapping up/);
    expect(out).toContain('Summary: reverted the half edit');
  });

  it('--strict-budget: no allowance', async () => {
    const { code, out, provider } = await headless(true);
    expect(code).toBe(1);
    expect(out).toContain('Token budget exceeded: 160/150');
    expect(provider.requests.some(sawNote)).toBe(false);
  });
});
