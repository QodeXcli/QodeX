/**
 * Auto mode in the agent loop (wip/auto-ux): the agent's own questions are never asked
 * in auto mode (ask_user, present_plan approval), the model is told when the mode
 * changes mid-session, prompts carry what they are about (AskMeta) to the surface, and
 * sub-agents inherit the session's mode. Real AgentLoop + scripted provider (core-fakes).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-auto-ux-home-'));
const ORIG_HOME = process.env.HOME;

let F: typeof import('./core-fakes.js');
let L: typeof import('../src/agent/loop.js');
let S: typeof import('../src/session/store.js');
let P: typeof import('../src/security/permissions.js');
let AU: typeof import('../src/tools/builtin/ask-user.js');
let PP: typeof import('../src/tools/builtin/present-plan.js');
let N: typeof import('../src/agent/approval-note.js');
let store: import('../src/session/store.js').SessionStore;
let cwd: string;

beforeAll(async () => {
  process.env.HOME = HOME;
  F = await import('./core-fakes.js');
  L = await import('../src/agent/loop.js');
  S = await import('../src/session/store.js');
  P = await import('../src/security/permissions.js');
  AU = await import('../src/tools/builtin/ask-user.js');
  PP = await import('../src/tools/builtin/present-plan.js');
  N = await import('../src/agent/approval-note.js');
  store = new S.SessionStore(path.join(HOME, 'sessions-auto-ux.db'));
  S.setSessionStoreForTests(store);
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-auto-ux-cwd-'));
});

afterEach(() => { P.setApprovalMode('manual'); });

afterAll(() => {
  P?.setApprovalMode('manual');
  S?.setSessionStoreForTests(null);
  if (ORIG_HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIG_HOME;
  fs.rmSync(HOME, { recursive: true, force: true });
  if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
});

type Ask = { prompt: string; options?: string[]; meta?: unknown };

function makeAgent(provider: InstanceType<typeof import('./core-fakes.js').FakeProvider>, tools: any[]) {
  return new L.AgentLoop({
    router: F.fakeRouter(provider),
    registry: new F.FakeRegistry(tools) as any,
    permissions: F.allowAllPermissions,
    config: F.testConfig(),
    cwd,
  });
}

async function runAgent(opts: {
  script: (req: any, i: number) => import('./core-fakes.js').FakeTurn;
  tools: any[];
  mode?: 'normal' | 'plan' | 'subagent';
  system?: string;
  answer?: (a: Ask) => string;
}) {
  const provider = new F.FakeProvider(opts.script);
  const agent = makeAgent(provider, opts.tools);
  const asks: Ask[] = [];
  const sid = store.createSession(cwd, 'fake');
  const events: any[] = [];
  for await (const ev of agent.run(
    [{ role: 'system', content: opts.system ?? 'sys' }, { role: 'user', content: 'do the task' }],
    sid,
    {
      mode: { mode: opts.mode ?? 'normal' },
      askUser: async (prompt: string, options?: string[], meta?: unknown) => {
        const a = { prompt, options, meta };
        asks.push(a);
        return opts.answer ? opts.answer(a) : 'no';
      },
      maxIterationsOverride: 10,
    },
  )) events.push(ev);
  return { provider, events, asks, agent };
}

const PLAN_ARGS = {
  goal: 'Add a greeting file',
  steps: [{ action: 'create', target: 'hello.txt', rationale: 'the user wants a greeting' }],
};

describe('ask_user', () => {
  it('auto mode: returns the autonomous reply and never calls askUser', async () => {
    P.setApprovalMode('auto');
    const r = await runAgent({
      tools: [new AU.AskUserTool()],
      script: (_q, i) => i === 0
        ? { calls: [{ name: 'ask_user', args: { question: 'Postgres or SQLite?', options: ['Postgres', 'SQLite'] } }] }
        : { text: 'Went with SQLite (assumption: single user).' },
    });
    expect(r.asks).toEqual([]);
    const result = F.toolResultsIn(r.provider.requests[1], 'ask_user')[0]!;
    expect(result).toContain('[AUTONOMOUS_MODE]');
    expect(result).toContain('Postgres or SQLite?');
    expect(result).toContain('Postgres, SQLite');
  });

  it('manual mode: asks the user as a QUESTION (never a permission) and returns the pick', async () => {
    const r = await runAgent({
      tools: [new AU.AskUserTool()],
      answer: () => 'SQLite',
      script: (_q, i) => i === 0
        ? { calls: [{ name: 'ask_user', args: { question: 'Postgres or SQLite?', options: ['Postgres', 'SQLite', 'sqlite'] } }] }
        : { text: 'ok' },
    });
    expect(r.asks).toHaveLength(1);
    expect(r.asks[0]).toMatchObject({ prompt: 'Postgres or SQLite?', options: ['Postgres', 'SQLite'], meta: { kind: 'question' } });
    expect(F.toolResultsIn(r.provider.requests[1], 'ask_user')[0]).toBe('The user picked: SQLite');
  });

  it('an answer that is not one of the options (nobody there, cancelled) means "decide yourself"', async () => {
    const r = await runAgent({
      tools: [new AU.AskUserTool()],
      answer: () => 'no',
      script: (_q, i) => i === 0
        ? { calls: [{ name: 'ask_user', args: { question: 'Which port?', options: ['3000', '8080'] } }] }
        : { text: 'ok' },
    });
    expect(F.toolResultsIn(r.provider.requests[1], 'ask_user')[0]).toContain('[NO_ANSWER]');
  });

  it('is read-only (plan mode keeps it) and has no tool timeout (a human may take a while)', () => {
    const t = new AU.AskUserTool();
    expect(t.isReadOnly).toBe(true);
    expect(t.timeoutSeconds).toBe(0);
    expect(AU.cleanOptions([' a ', 'A', '', 'b', 'c', 'd', 'e', 'f', 'g'])).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });
});

describe('present_plan', () => {
  it('auto mode: approves the plan, lifts plan mode and executes it in the same run — no askUser', async () => {
    P.setApprovalMode('auto');
    const write = new F.FakeTool('write_file', () => ({ content: 'wrote hello.txt' }));
    const r = await runAgent({
      mode: 'plan',
      tools: [new PP.PresentPlanTool(), write, new F.FakeTool('read_file', () => ({ content: 'x' }), { readOnly: true })],
      script: (_q, i) => i === 0 ? { calls: [{ name: 'present_plan', args: PLAN_ARGS }] }
        : i === 1 ? { calls: [{ name: 'write_file', args: { path: 'hello.txt', content: 'hi' } }] }
          : { text: 'Done: created hello.txt.' },
    });
    expect(r.asks).toEqual([]);
    const ready = r.events.find(e => e.type === 'plan_ready');
    expect(ready?.data).toMatchObject({ autoApproved: true, modeLifted: true });
    // The plan result says so, and the next request ships the mutating tools with the note.
    expect(F.toolResultsIn(r.provider.requests[1], 'present_plan')[0]).toContain('[PLAN_APPROVED]');
    expect(F.toolNamesIn(r.provider.requests[1])).toContain('write_file');
    expect(r.provider.requests[1]!.messages.some(m => m.role === 'user' && String(m.content).includes('Plan mode has ended'))).toBe(true);
    expect(write.calls).toHaveLength(1);
    expect(F.toolResultsIn(r.provider.requests[2], 'write_file')[0]).toBe('wrote hello.txt');
  });

  it('manual mode: the plan waits for the user — plan mode stays and a write is refused', async () => {
    const write = new F.FakeTool('write_file', () => ({ content: 'wrote' }));
    const r = await runAgent({
      mode: 'plan',
      tools: [new PP.PresentPlanTool(), write],
      script: (_q, i) => i === 0 ? { calls: [{ name: 'present_plan', args: PLAN_ARGS }] }
        : i === 1 ? { calls: [{ name: 'write_file', args: { path: 'hello.txt', content: 'hi' } }] }
          : { text: 'Plan presented.' },
    });
    const ready = r.events.find(e => e.type === 'plan_ready');
    expect(ready?.data).toMatchObject({ autoApproved: false, modeLifted: false });
    expect(F.toolResultsIn(r.provider.requests[1], 'present_plan')[0]).not.toContain('[PLAN_APPROVED]');
    expect(write.calls).toHaveLength(0);
    expect(F.toolResultsIn(r.provider.requests[2], 'write_file')[0]).toContain('[TOOL_NOT_ALLOWED]');
  });
});

describe('mode changes mid-session reach the running model', () => {
  it('switching into auto during a run injects one note (merged, never two user messages in a row)', async () => {
    const flip = new F.FakeTool('flip', () => { P.setApprovalMode('auto'); return { content: 'flipped' }; });
    const r = await runAgent({
      tools: [flip],
      script: (_q, i) => i === 0 ? { calls: [{ name: 'flip' }] } : i === 1 ? { calls: [{ name: 'flip' }] } : { text: 'done' },
    });
    const notesIn = (req: any) => req.messages.filter((m: any) => m.role === 'user' && String(m.content).includes(N.APPROVAL_NOTE_PREFIX)).length;
    expect(notesIn(r.provider.requests[0])).toBe(0);
    expect(notesIn(r.provider.requests[1])).toBe(1);
    expect(notesIn(r.provider.requests[2])).toBe(1); // told once, not every iteration
    for (const req of r.provider.requests) {
      const roles = req.messages.map((m: any) => m.role);
      for (let i = 1; i < roles.length; i++) expect(roles[i] === 'user' && roles[i - 1] === 'user').toBe(false);
    }
    expect(String(r.provider.requests[1]!.messages.at(-1)!.content)).toContain('[APPROVAL MODE: AUTO]');
  });

  it('a conversation started in auto (system prompt section) that is now manual gets the "left auto" note on the prompt', async () => {
    const r = await runAgent({
      tools: [],
      system: 'You are QodeX.\n\n## Autonomous mode\nAuto mode is on.',
      script: () => ({ text: 'ok' }),
    });
    const last = r.provider.requests[0]!.messages.at(-1)!;
    expect(last.role).toBe('user');
    expect(String(last.content)).toMatch(/^do the task\n\n\[APPROVAL MODE: MANUAL\] The user left auto mode/);
  });

  it('conversationSaysAutonomous: the latest note wins over the system prompt', () => {
    const sys = { role: 'system' as const, content: '## Autonomous mode\n…' };
    expect(N.conversationSaysAutonomous([sys])).toBe(true);
    expect(N.conversationSaysAutonomous([sys, { role: 'user', content: N.approvalModeNote(false) }])).toBe(false);
    expect(N.conversationSaysAutonomous([{ role: 'system', content: 'x' }, { role: 'user', content: `a\n\n${N.approvalModeNote(true)}` }])).toBe(true);
    expect(N.conversationSaysAutonomous([{ role: 'system', content: 'x' }])).toBe(false);
  });
});

describe('prompts carry what they are about (AskMeta)', () => {
  it('a permission prompt announced by the tool, a Sentinel prompt, and an unannounced one', async () => {
    const shell = new F.FakeTool('shell', async (_a, ctx) => {
      ctx.emit({ type: 'permission-request', tool: 'shell', operation: 'npm test' });
      return { content: `shell=${await ctx.askUser('Run: npm test', ['yes', 'no', 'always yes'])}` };
    });
    const sentinelish = new F.FakeTool('browser_click', async (_a, ctx) => {
      ctx.emit({ type: 'permission-request', tool: 'browser_click', operation: 'sentinel:delete example.com browser_click' });
      return { content: `click=${await ctx.askUser('🛡 Sentinel — approval needed · x\nAllow this action?', ['yes', 'no'])}` };
    });
    const bare = new F.FakeTool('mcp_x', async (_a, ctx) => ({ content: `mcp=${await ctx.askUser('Run MCP tool x?', ['yes', 'no'])}` }));
    const r = await runAgent({
      tools: [shell, sentinelish, bare],
      answer: () => 'yes',
      script: (_q, i) => i === 0 ? { calls: [{ name: 'shell' }] } : i === 1 ? { calls: [{ name: 'browser_click' }] } : i === 2 ? { calls: [{ name: 'mcp_x' }] } : { text: 'ok' },
    });
    expect(r.asks.map(a => a.meta)).toEqual([
      { kind: 'permission', tool: 'shell', operation: 'npm test' },
      { kind: 'sentinel' },
      undefined,
    ]);
  });

  it('describeAsk: a Sentinel prompt is always "sentinel", even when a caller tagged it otherwise', () => {
    const sp = '🛡 Sentinel — approval needed · نیاز به تأیید شما\nCategory: purchase · risk: critical';
    expect(L.describeAsk(sp, { kind: 'permission', tool: 'shell', operation: 'ls' }, undefined)).toEqual({ kind: 'sentinel' });
    expect(L.describeAsk('Run: ls', undefined, { kind: 'permission', tool: 'shell', operation: 'ls' })).toEqual({ kind: 'permission', tool: 'shell', operation: 'ls' });
    expect(L.describeAsk('Pick one', undefined, undefined, 'ask_user')).toEqual({ kind: 'question' });
    expect(L.describeAsk('Run MCP tool x?', undefined, undefined, 'mcp_x')).toBeUndefined();
  });
});

describe('sub-agents inherit the session mode', () => {
  it('auto: a sub-agent question is answered by the auto policy, not by the unattended "no"', async () => {
    P.setApprovalMode('auto');
    const provider = new F.FakeProvider((_q, i) => i === 0
      ? { calls: [{ name: 'ask_user', args: { question: 'Which file?', options: ['a.ts', 'b.ts'] } }] }
      : { text: 'picked a.ts' });
    const agent = makeAgent(provider, [new AU.AskUserTool()]);
    // No askUser at all: the run would otherwise fall back to the unattended broker ('no').
    const r = await agent.runSubagent('pick a file', { maxIterations: 4, sessionId: `root-${Date.now()}/sub-auto` });
    expect(r.ok).toBe(true);
    expect(F.toolResultsIn(provider.requests[1], 'ask_user')[0]).toContain('[AUTONOMOUS_MODE]');
  });

  it('auto: a role sub-agent prompt gets the autonomous section (no mode note needed)', async () => {
    P.setApprovalMode('auto');
    const provider = new F.FakeProvider(() => ({ text: 'done' }));
    const agent = makeAgent(provider, [new F.FakeTool('read_file', () => ({ content: 'x' }), { readOnly: true })]);
    const r = await agent.runSubagent('look around', { maxIterations: 3, sessionId: `root-${Date.now()}/sub-role`, role: 'scout' });
    expect(r.ok).toBe(true);
    const sys = String(provider.requests[0]!.messages[0]!.content);
    expect(sys).toContain('## Autonomous mode');
    expect(provider.requests[0]!.messages.some(m => String(m.content).includes(N.APPROVAL_NOTE_PREFIX))).toBe(false);
  });
});
