/**
 * Sub-agent runs on a real AgentLoop + real SessionStore (temp DB), driven by a scripted
 * provider: the FK fix (ensureSession), the iteration cap, error propagation, askUser
 * inheritance, fresh per-run state, built-in browser/computer roles (allow-lists, gating
 * bypass, enforcement) and operator-role budgets.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-core-sub-home-'));
const ORIG_HOME = process.env.HOME;

let F: typeof import('./core-fakes.js');
let L: typeof import('../src/agent/loop.js');
let S: typeof import('../src/session/store.js');
let R: typeof import('../src/llm/prompts/role-prompts.js');
let store: import('../src/session/store.js').SessionStore;
let cwd: string;

beforeAll(async () => {
  process.env.HOME = HOME; // src modules compute ~/.qodex at import time
  F = await import('./core-fakes.js');
  L = await import('../src/agent/loop.js');
  S = await import('../src/session/store.js');
  R = await import('../src/llm/prompts/role-prompts.js');
  store = new S.SessionStore(path.join(HOME, 'sessions-test.db'));
  S.setSessionStoreForTests(store);
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-core-sub-cwd-'));
});

afterAll(() => {
  S?.setSessionStoreForTests(null);
  if (ORIG_HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIG_HOME;
  fs.rmSync(HOME, { recursive: true, force: true });
  if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
});

function makeAgent(provider: InstanceType<typeof F.FakeProvider>, tools: InstanceType<typeof F.FakeTool>[], cfg = F.testConfig()) {
  return new L.AgentLoop({
    router: F.fakeRouter(provider),
    registry: new F.FakeRegistry(tools) as any,
    permissions: F.allowAllPermissions,
    config: cfg,
    cwd,
  });
}

describe('SessionStore.ensureSession (sub-agent FK fix)', () => {
  it('recordTurn on an unknown derived id fails with the FK error, and succeeds after ensureSession', () => {
    const id = `parent-${Date.now()}/sub-1`;
    expect(() => store.recordTurn(id, [{ role: 'assistant', content: 'x' }], { input: 0, output: 0, costUsd: 0 }))
      .toThrow(/FOREIGN KEY/);
    store.ensureSession(id, cwd, 'fake/fake-model');
    expect(store.hasSession(id)).toBe(true);
    store.recordTurn(id, [{ role: 'assistant', content: 'hello' }], { input: 1, output: 1, costUsd: 0 });
    expect(store.loadSession(id)!.messages.map(m => m.content)).toEqual(['hello']);
  });

  it('is idempotent and never overwrites an existing row', () => {
    const id = store.createSession(cwd, 'original-model');
    store.ensureSession(id, '/elsewhere', 'other-model');
    store.ensureSession(id, '/elsewhere', 'other-model');
    const meta = store.loadSession(id)!.meta;
    expect(meta.model).toBe('original-model');
    expect(meta.cwd).toBe(cwd);
  });

  it('rejects an empty id', () => {
    expect(() => store.ensureSession('', cwd, 'm')).toThrow(/SESSION_ERROR/);
  });
});

describe('AgentLoop.runSubagent', () => {
  it('runs end-to-end on a derived session id (no FK failure) and persists the transcript', async () => {
    const provider = new F.FakeProvider(() => ({ text: 'Sub-agent finished: 3 items found.' }));
    const agent = makeAgent(provider, [new F.FakeTool('read_file', () => ({ content: 'x' }), { readOnly: true })]);
    const sessionId = `root-${Date.now()}/sub-ok`;
    const r = await agent.runSubagent('count the items', { maxIterations: 5, sessionId });
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.finalText).toContain('3 items');
    expect(store.hasSession(sessionId)).toBe(true);
    const loaded = store.loadSession(sessionId)!;
    expect(loaded.meta.status).toBe('completed');
    expect(loaded.messages.some(m => m.role === 'assistant')).toBe(true);
  });

  it('honors maxIterations (maxIterationsOverride) and reports the error message (data.message)', async () => {
    let n = 0;
    const provider = new F.FakeProvider(() => ({ calls: [{ name: 'probe', args: { n: n++ } }] }));
    const probe = new F.FakeTool('probe', (a) => ({ content: `probe ${String(a.n)}` }));
    const agent = makeAgent(provider, [probe]);
    const r = await agent.runSubagent('loop forever', { maxIterations: 2, sessionId: `root/sub-cap-${Date.now()}` });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Iteration budget exceeded: 3\/2/);
    expect(provider.requests.length).toBe(2); // capped at 2 model calls, not the config default 50
    expect(probe.calls.length).toBe(2);
  });

  it('passes the caller askUser to tools inside the sub-agent', async () => {
    const asked: string[] = [];
    const gate = new F.FakeTool('gated', async (_a, ctx) => ({ content: `answer=${await ctx.askUser('Proceed?', ['yes', 'no'])}` }));
    const provider = new F.FakeProvider((_req, i) => (i === 0 ? { calls: [{ name: 'gated' }] } : { text: 'done' }));
    const agent = makeAgent(provider, [gate]);
    const r = await agent.runSubagent('do it', {
      maxIterations: 5,
      sessionId: `root/sub-ask-${Date.now()}`,
      askUser: async (p) => { asked.push(p); return 'yes'; },
    });
    expect(r.ok).toBe(true);
    expect(asked).toEqual(['Proceed?']);
    expect(F.toolResultsIn(provider.requests[1], 'gated')[0]).toBe('answer=yes');
  });

  it('inherits the parent run askUser when the caller passes none', async () => {
    const parentAsked: string[] = [];
    const gate = new F.FakeTool('gated', async (_a, ctx) => ({ content: `answer=${await ctx.askUser('Allow?', ['yes', 'no'])}` }));
    // Parent run: one plain answer (this stores the parent's askUser on the instance).
    const provider = new F.FakeProvider((req, i) => {
      if (i === 0) return { text: 'parent done' };
      if (i === 1) return { calls: [{ name: 'gated' }] };
      return { text: 'sub done' };
    });
    const agent = makeAgent(provider, [gate]);
    const parentSession = store.createSession(cwd, 'm');
    for await (const _ of agent.run([{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }], parentSession, {
      askUser: async (p) => { parentAsked.push(p); return 'no'; },
    })) { /* drain */ }
    const r = await agent.runSubagent('use the gated tool', { maxIterations: 5, sessionId: `${parentSession}/sub-inh` });
    expect(r.ok).toBe(true);
    expect(parentAsked).toEqual(['Allow?']);
    expect(F.toolResultsIn(provider.requests[2], 'gated')[0]).toBe('answer=no');
  });

  it('falls back to a fail-safe brokered asker when there is no parent asker (no channel → deny)', async () => {
    const gate = new F.FakeTool('gated', async (_a, ctx) => ({ content: `answer=${await ctx.askUser('Allow?', ['yes', 'no'])}` }));
    const provider = new F.FakeProvider((_req, i) => (i === 0 ? { calls: [{ name: 'gated' }] } : { text: 'done' }));
    const agent = makeAgent(provider, [gate]);
    const r = await agent.runSubagent('x', { maxIterations: 5, sessionId: `root/sub-fallback-${Date.now()}` });
    expect(r.ok).toBe(true);
    expect(F.toolResultsIn(provider.requests[1], 'gated')[0]).toBe('answer=no');
  });

  it('runs on a FRESH AgentLoop: the parent steer queue is not consumed by the sub-agent', async () => {
    const provider = new F.FakeProvider(() => ({ text: 'ok' }));
    const agent = makeAgent(provider, []);
    agent.pushSteer('note for the PARENT only');
    const r = await agent.runSubagent('task', { maxIterations: 3, sessionId: `root/sub-fresh-${Date.now()}` });
    expect(r.ok).toBe(true);
    expect(agent.hasPendingSteer()).toBe(true);
    const sent = provider.requests[0]!.messages.map(m => String(m.content ?? '')).join('\n');
    expect(sent).not.toContain('note for the PARENT only');
  });

  it('runs parallel sub-agents independently', async () => {
    const provider = new F.FakeProvider((req) => {
      const user = req.messages.find(m => m.role === 'user')?.content ?? '';
      return { text: `echo: ${user}` };
    });
    const agent = makeAgent(provider, []);
    const [a, b] = await Promise.all([
      agent.runSubagent('alpha', { maxIterations: 3, sessionId: `root/sub-pa-${Date.now()}` }),
      agent.runSubagent('beta', { maxIterations: 3, sessionId: `root/sub-pb-${Date.now()}` }),
    ]);
    expect(a.finalText).toContain('alpha');
    expect(b.finalText).toContain('beta');
  });
});

describe('built-in browser / computer roles', () => {
  const browserTools = () => [
    new F.FakeTool('browser_snapshot', () => ({ content: 'Page: Shop\nURL: https://shop.example/\n- button "Buy" [ref=e1]' })),
    new F.FakeTool('browser_click', () => ({ content: '✓ clicked e1' })),
    new F.FakeTool('browser_agent', () => ({ content: 'nested' })),
    new F.FakeTool('browser_console', () => ({ content: '' }), { readOnly: true }),
    new F.FakeTool('computer_use_screenshot', () => ({ content: 'shot.png' })),
    new F.FakeTool('computer_use_click', () => ({ content: 'clicked' })),
    new F.FakeTool('computer_use_agent', () => ({ content: 'nested' })),
    new F.FakeTool('vision_analyze', () => ({ content: 'a button' }), { readOnly: true }),
    new F.FakeTool('web_fetch', () => ({ content: 'page' }), { readOnly: true }),
    new F.FakeTool('recall', () => ({ content: '' }), { readOnly: true }),
    new F.FakeTool('shell', () => ({ content: 'ran' })),
    new F.FakeTool('write_file', () => ({ content: 'wrote' })),
    new F.FakeTool('vault_list', () => ({ content: 'none' }), { readOnly: true }),
  ];

  it('builtinRoleAllowedTools expands prefixes, excludes the nested agent tool and drops unknown names', () => {
    const names = browserTools().map(t => t.name);
    const b = R.builtinRoleAllowedTools('browser', names)!;
    expect(b).toEqual(expect.arrayContaining(['browser_snapshot', 'browser_click', 'browser_console', 'vision_analyze', 'web_fetch', 'recall', 'vault_list']));
    expect(b).not.toContain('browser_agent');
    expect(b).not.toContain('shell');
    expect(b).not.toContain('write_file');
    expect(b).not.toContain('workflow_run'); // not registered → dropped
    const c = R.builtinRoleAllowedTools('computer', names)!;
    expect(c).toEqual(expect.arrayContaining(['computer_use_screenshot', 'computer_use_click', 'vision_analyze', 'recall']));
    expect(c).not.toContain('computer_use_agent');
    expect(c).not.toContain('browser_click');
    expect(R.builtinRoleAllowedTools('subagent', names)).toBeUndefined();
    expect(R.BUILTIN_ROLES).toEqual(expect.arrayContaining(['browser', 'computer']));
    expect(R.getBuiltinRolePrompt('browser')).toContain('NEVER invent a ref');
    expect(R.getBuiltinRolePrompt('computer')).toContain('SCREENSHOT pixels');
  });

  it('a browser sub-agent sees exactly its role tools even when its prompt has no browser keywords (gating skipped)', async () => {
    const provider = new F.FakeProvider(() => ({ text: 'Result: price is 12 EUR. Evidence: https://shop.example/p/1' }));
    const agent = makeAgent(provider, browserTools());
    const r = await agent.runSubagent('Find the price of item 1', { maxIterations: 5, sessionId: `root/sub-br-${Date.now()}`, role: 'browser' });
    expect(r.ok).toBe(true);
    const shipped = F.toolNamesIn(provider.requests[0]);
    expect(shipped).toEqual(['browser_click', 'browser_console', 'browser_snapshot', 'recall', 'vault_list', 'vision_analyze', 'web_fetch']);
    const sys = String(provider.requests[0]!.messages[0]!.content);
    expect(sys).toContain('browser operator of QodeX');
    expect(sys).toContain('Available tools (the only ones you can call this turn): ');
  });

  it('refuses a call outside the role allow-list with [TOOL_NOT_ALLOWED] (the tool never runs)', async () => {
    const tools = browserTools();
    const shell = tools.find(t => t.name === 'shell')!;
    const provider = new F.FakeProvider((_r, i) => (i === 0 ? { calls: [{ name: 'shell', args: { command: 'curl x' } }] } : { text: 'ok' }));
    const agent = makeAgent(provider, tools);
    await agent.runSubagent('go', { maxIterations: 5, sessionId: `root/sub-deny-${Date.now()}`, role: 'browser' });
    const res = F.toolResultsIn(provider.requests[1], 'shell')[0]!;
    expect(res).toMatch(/^\[TOOL_NOT_ALLOWED\] 'shell'/);
    expect(res).toContain('browser_snapshot');
    expect(shell.calls.length).toBe(0);
  });

  it('allow-list enforcement resolves aliases and accepts trailing-* prefixes', async () => {
    const shell = new F.FakeTool('shell', () => ({ content: 'ran' }));
    const click = new F.FakeTool('browser_click', () => ({ content: '✓' }));
    const write = new F.FakeTool('write_file', () => ({ content: 'wrote' }));
    const provider = new F.FakeProvider((_r, i) => (i === 0
      ? { calls: [{ name: 'bash', args: { command: 'ls' } }, { name: 'browser_click', args: { ref: 'e1' } }, { name: 'write_file', args: { path: 'a' } }] }
      : { text: 'ok' }));
    const agent = new L.AgentLoop({
      router: F.fakeRouter(provider),
      registry: new F.FakeRegistry([shell, click, write], { bash: 'shell' }) as any,
      permissions: F.allowAllPermissions,
      config: F.testConfig(),
      cwd,
    });
    for await (const _ of agent.run([{ role: 'system', content: 's' }, { role: 'user', content: 'go' }], store.createSession(cwd, 'm'), {
      mode: { mode: 'subagent', allowedTools: ['bash', 'browser_*'] }, askUser: async () => 'no',
    })) { /* drain */ }
    expect(shell.calls.length).toBe(1);
    expect(click.calls.length).toBe(1);
    expect(write.calls.length).toBe(0);
    expect(F.toolResultsIn(provider.requests[1], 'write_file')[0]).toMatch(/^\[TOOL_NOT_ALLOWED\]/);
  });

  it('a general sub-agent does not get the nested agent tools', async () => {
    const provider = new F.FakeProvider(() => ({ text: 'ok' }));
    const agent = makeAgent(provider, browserTools(), F.testConfig({ discipline: { verifyBaseline: false, toolGating: false } }));
    await agent.runSubagent('use the browser to check the site', { maxIterations: 3, sessionId: `root/sub-gen-${Date.now()}` });
    const shipped = F.toolNamesIn(provider.requests[0]);
    expect(shipped).toContain('browser_click');
    expect(shipped).not.toContain('browser_agent');
    expect(shipped).not.toContain('computer_use_agent');
  });

  it('operator roles get the long-run budget by default (30 min wall, no token cap); explicit overrides win', () => {
    expect(L.operatorRoleBudget(1.5)).toEqual({ maxWallSeconds: 1800, maxTokens: 0, maxCostUsd: 1.5 });
    const cfg = { perTaskMaxTokens: 200_000, perTaskLimitUsd: 1, perTaskMaxWallSeconds: 600 };
    expect(L.resolveRunBudget(cfg)).toEqual({ maxTokens: 200_000, maxCostUsd: 1, maxWallSeconds: 600 });
    expect(L.resolveRunBudget(cfg, { maxWallSeconds: 1800, maxTokens: 0 })).toEqual({ maxTokens: 0, maxCostUsd: 1, maxWallSeconds: 1800 });
    expect(L.resolveRunBudget(cfg, { maxTokens: -5, maxCostUsd: Number.NaN })).toEqual({ maxTokens: 200_000, maxCostUsd: 1, maxWallSeconds: 600 });
  });

  it('a browser sub-agent is not killed by the config token cap (operator budget applied)', async () => {
    // usage per call = 120 tokens; a 150-token config cap would end a normal run on iteration 3.
    let i = 0;
    const provider = new F.FakeProvider(() => (i++ < 3 ? { calls: [{ name: 'browser_snapshot', args: { step: i } }] } : { text: 'done' }));
    const tight = F.testConfig({ budget: { ...F.testConfig().budget, perTaskMaxTokens: 150 } });
    const general = makeAgent(provider, browserTools(), tight);
    const g = await general.runSubagent('x', { maxIterations: 10, sessionId: `root/sub-tok-g-${Date.now()}` });
    expect(g.ok).toBe(false);
    expect(g.error).toMatch(/Token budget exceeded/);

    i = 0;
    const provider2 = new F.FakeProvider(() => (i++ < 3 ? { calls: [{ name: 'browser_snapshot', args: { step: i } }] } : { text: 'done' }));
    const browser = makeAgent(provider2, browserTools(), tight);
    const b = await browser.runSubagent('x', { maxIterations: 10, sessionId: `root/sub-tok-b-${Date.now()}`, role: 'browser' });
    expect(b.ok).toBe(true);
    expect(b.finalText).toBe('done');
  });
});

describe('budgetOverride on a plain run', () => {
  beforeEach(() => { /* nothing */ });
  it('applies wall/token overrides to the run BudgetTracker', async () => {
    const provider = new F.FakeProvider(() => ({ calls: [{ name: 'noop', args: { t: Date.now() } }] }));
    const agent = makeAgent(provider, [new F.FakeTool('noop')]);
    const sid = store.createSession(cwd, 'm');
    const events: any[] = [];
    for await (const ev of agent.run([{ role: 'system', content: 's' }, { role: 'user', content: 'go' }], sid, {
      askUser: async () => 'no',
      budgetOverride: { maxTokens: 250 },
      maxIterationsOverride: 0,
    })) events.push(ev);
    const err = events.find(e => e.type === 'error');
    expect(err?.data?.message).toMatch(/Token budget exceeded: \d+\/250/);
  });
});
