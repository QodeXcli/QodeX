import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { AgentEvent, AgentOptions } from '../src/agent/loop.js';
import type { Message } from '../src/session/store.js';
import type { ToolContext } from '../src/tools/base.js';
import { MissionStore } from '../src/missions/store.js';
import {
  runMission, missionAskUser, getMissionContext, buildStepPrompt, MissionApprovalChannel,
  type AgentLike, type MissionDeps, type MissionRunnerEvent,
} from '../src/missions/runner.js';
import { MissionMilestoneTool } from '../src/missions/tools.js';
import { getApprovalBroker } from '../src/control/approvals.js';
import { getBus, type BusEvent } from '../src/control/bus.js';

interface ScriptCtx {
  stepId: string;
  prompt: string;
  sessionId: string;
  options: AgentOptions;
  agent: FakeAgent;
  attempt: number;
}
type Script = (c: ScriptCtx) => AsyncGenerator<AgentEvent>;

class FakeAgent implements AgentLike {
  prompt = '';
  steers: string[] = [];
  constructor(readonly stepId: string, private readonly script: Script, readonly attempt: number) {}
  async buildInitialMessages(prompt: string): Promise<Message[]> {
    this.prompt = prompt;
    return [{ role: 'system', content: 'sys' }, { role: 'user', content: prompt }];
  }
  async *run(_m: Message[], sessionId: string, options: AgentOptions): AsyncGenerator<AgentEvent> {
    yield* this.script({ stepId: this.stepId, prompt: this.prompt, sessionId, options, agent: this, attempt: this.attempt });
  }
  pushSteer(note: string): void { this.steers.push(note); }
}

const ok = (text: string): Script => async function* () {
  yield { type: 'iteration_start', data: { iteration: 1 } };
  yield { type: 'final', data: { content: text } };
};

function makeCtx(cwd: string): ToolContext {
  return {
    cwd, sessionId: 'test', transaction: {} as any, permissions: { evaluate: () => 'allow' } as any,
    askUser: async () => 'yes', signal: new AbortController().signal, emit: () => {},
  } as ToolContext;
}

async function waitFor(cond: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise(r => setTimeout(r, 10));
  }
}

function planOf(steps: Array<{ id: string; title?: string; deps?: string[] }>): string {
  return JSON.stringify({
    steps: steps.map(s => ({ id: s.id, title: s.title ?? `Title ${s.id}`, instruction: `Instruction for ${s.id}`, depends_on: s.deps ?? [] })),
    success_criteria: 'All done',
  });
}

describe('runMission', () => {
  let dir: string;
  let dbPath: string;
  let store: MissionStore;
  let agents: FakeAgent[];
  let events: MissionRunnerEvent[];
  let completions: string[];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-missions-runner-'));
    dbPath = path.join(dir, 'sessions.db');
    store = new MissionStore(dbPath);
    agents = [];
    events = [];
    completions = [];
    getApprovalBroker().reset();
    getBus().reset();
  });
  afterEach(async () => {
    getApprovalBroker().reset();
    getBus().reset();
    await fs.rm(dir, { recursive: true, force: true });
  });

  function deps(missionId: string, scripts: Record<string, Script | Script[]>, plan: string, extra: Partial<MissionDeps> = {}): MissionDeps {
    let sessions = 0;
    const attempts = new Map<string, number>();
    return {
      store,
      createAgent: (o) => {
        const stepId = o!.stepId!;
        const n = (attempts.get(stepId) ?? 0) + 1;
        attempts.set(stepId, n);
        const s = scripts[stepId];
        const script = Array.isArray(s) ? (s[n - 1] ?? s[s.length - 1]!) : (s ?? ok(`done ${stepId}`));
        const a = new FakeAgent(stepId, script, n);
        agents.push(a);
        return a;
      },
      complete: async (prompt) => {
        completions.push(prompt);
        return prompt.includes('PLANNER') ? plan : 'FINAL REPORT for the user';
      },
      askUserFactory: (stepId, signal) => missionAskUser(missionId, stepId, { signal }),
      onEvent: (ev) => { events.push(ev); },
      sessions: { createSession: () => `sess-${++sessions}`, recordTurn: () => {}, markStatus: () => {}, addWorklogEntry: () => {} },
      notify: async () => {},
      pollIntervalMs: 20,
      abortGraceMs: 1000,
      config: { maxConcurrency: 2, maxAttempts: 2, stepMaxIterations: 10, stepMaxWallSeconds: 0, maxCostUsd: 0, notify: false },
      ...extra,
    };
  }

  it('plans, runs two dependent steps in order, feeds results forward and reports', async () => {
    const m = store.create({ goal: 'Compare vendors and write a summary', cwd: dir });
    const bus: BusEvent[] = [];
    getBus().subscribe(e => bus.push(e));
    const r = await runMission(m.id, deps(m.id, {
      s1: ok('RESULT-ONE: vendors A, B, C'),
      s2: async function* (c) {
        expect(c.prompt).toContain('RESULT-ONE');
        expect(c.prompt).toContain('Mission step 2/2');
        yield { type: 'final', data: { content: 'RESULT-TWO' } };
      },
    }, planOf([{ id: 's1' }, { id: 's2', deps: ['s1'] }])));

    expect(r.status).toBe('completed');
    expect(r.stepsDone).toBe(2);
    expect(r.report).toBe('FINAL REPORT for the user');
    const steps = store.steps(m.id);
    expect(steps.map(s => s.status)).toEqual(['done', 'done']);
    expect(steps[0]!.session_id).toMatch(/^sess-/);
    expect(steps[1]!.result).toBe('RESULT-TWO');
    expect(agents.map(a => a.stepId)).toEqual(['s1', 's2']);
    // the planner and the report prompt both went through complete()
    expect(completions[0]).toContain('PLANNER');
    expect(completions[1]).toContain('final report');
    const types = store.events(m.id).map(e => e.type);
    expect(types).toEqual(expect.arrayContaining(['plan', 'step-start', 'step-done', 'report']));
    expect(store.get(m.id)!.status).toBe('completed');
    expect(bus.some(e => e.kind === 'mission' && e.type === 'completed')).toBe(true);
  });

  it('retries a failed step with the failure fed back', async () => {
    const m = store.create({ goal: 'g', cwd: dir });
    const r = await runMission(m.id, deps(m.id, {
      s1: [
        async function* () { yield { type: 'error', data: { message: 'boom: selector not found' } }; },
        async function* (c) {
          expect(c.prompt).toContain('Previous attempt failed');
          expect(c.prompt).toContain('boom: selector not found');
          yield { type: 'final', data: { content: 'fixed' } };
        },
      ],
    }, planOf([{ id: 's1' }])));
    expect(r.status).toBe('completed');
    const s1 = store.getStep(m.id, 's1')!;
    expect(s1.attempts).toBe(2);
    expect(s1.status).toBe('done');
    expect(store.events(m.id, 0, { types: ['step-retry'] })).toHaveLength(1);
  });

  it('marks a step failed after maxAttempts and skips its dependents', async () => {
    const m = store.create({ goal: 'g', cwd: dir });
    const fail: Script = async function* () { yield { type: 'final', data: { content: '' } }; };
    const r = await runMission(m.id, deps(m.id, { s1: fail, s3: ok('independent ok') },
      planOf([{ id: 's1' }, { id: 's2', deps: ['s1'] }, { id: 's3' }, { id: 's4', deps: ['s2'] }])));
    expect(r.status).toBe('failed');
    const by = Object.fromEntries(store.steps(m.id).map(s => [s.id, s]));
    expect(by.s1!.status).toBe('failed');
    expect(by.s1!.attempts).toBe(2);
    expect(by.s1!.error).toMatch(/without a final answer/);
    expect(by.s2!.status).toBe('skipped');
    expect(by.s4!.status).toBe('skipped');
    expect(by.s3!.status).toBe('done');
    expect(agents.some(a => a.stepId === 's2')).toBe(false);
    expect(store.get(m.id)!.error).toMatch(/1 step\(s\) failed, 2 skipped/);
    expect(r.report).toBe('FINAL REPORT for the user');
  });

  it('cancels mid-run when another process requests it', async () => {
    const m = store.create({ goal: 'g', cwd: dir });
    const other = new MissionStore(dbPath);
    const r = await runMission(m.id, deps(m.id, {
      s1: async function* (c) {
        yield { type: 'iteration_start', data: { iteration: 1 } };
        await new Promise<void>(res => c.options.signal!.addEventListener('abort', () => res(), { once: true }));
        yield { type: 'error', data: { message: 'Cancelled by user' } };
      },
    }, planOf([{ id: 's1' }, { id: 's2', deps: ['s1'] }]), {
      onEvent: (ev) => { if (ev.type === 'step-start') setTimeout(() => other.requestCancel(m.id), 20); },
    }));
    expect(r.status).toBe('cancelled');
    const s1 = store.getStep(m.id, 's1')!;
    expect(s1.status).toBe('pending');
    expect(s1.attempts).toBe(0);
    expect(store.get(m.id)!.status).toBe('cancelled');
    expect(store.events(m.id, 0, { types: ['step-interrupted'] })).toHaveLength(1);
  });

  it('resumes after a crash: done steps are kept, running ones re-run', async () => {
    const m = store.create({ goal: 'g', cwd: dir });
    store.replaceSteps(m.id, [
      { id: 's1', title: 'one', instruction: 'do one', depends_on: [] },
      { id: 's2', title: 'two', instruction: 'do two', depends_on: ['s1'] },
    ]);
    store.update(m.id, { plan_json: planOf([{ id: 's1' }, { id: 's2', deps: ['s1'] }]), pid: 2 ** 22 + 4242 });
    store.setStatus(m.id, 'running');
    store.updateStep(m.id, 's1', { status: 'done', attempts: 1, result: 'R1-from-before-crash' });
    store.updateStep(m.id, 's2', { status: 'running', attempts: 1 });

    const r = await runMission(m.id, deps(m.id, {
      s2: async function* (c) {
        expect(c.prompt).toContain('R1-from-before-crash');
        yield { type: 'final', data: { content: 'R2' } };
      },
    }, 'unused'));
    expect(r.status).toBe('completed');
    expect(agents.map(a => a.stepId)).toEqual(['s2']);
    expect(store.getStep(m.id, 's2')!.attempts).toBe(2);
    expect(store.events(m.id, 0, { types: ['resumed'] })[0]!.payload.stepsRequeued).toBe(1);
    expect(completions.some(c => c.includes('PLANNER'))).toBe(false);
  });

  it('routes askUser to a DB approval that another process resolves', async () => {
    const m = store.create({ goal: 'deploy', cwd: dir });
    const other = new MissionStore(dbPath);
    const answers: string[] = [];
    const run = runMission(m.id, deps(m.id, {
      s1: async function* (c) {
        const a = await c.options.askUser('Run: npm publish', ['yes', 'no', 'always']);
        answers.push(a);
        const b = await c.options.askUser('Run: rm -rf dist', ['yes', 'no']);
        answers.push(b);
        yield { type: 'final', data: { content: `answers=${a},${b}` } };
      },
    }, planOf([{ id: 's1' }])));

    await waitFor(() => other.listPendingApprovals(m.id).length === 1);
    expect(other.get(m.id)!.status).toBe('awaiting_approval');
    const first = other.listPendingApprovals(m.id)[0]!;
    expect(first.step_id).toBe('s1');
    expect(first.prompt).toBe('Run: npm publish');
    expect(other.resolveApproval(first.id, 'approve', 'telegram').ok).toBe(true);

    await waitFor(() => other.listPendingApprovals(m.id).length === 1 && other.listPendingApprovals(m.id)[0]!.id !== first.id);
    const second = other.listPendingApprovals(m.id)[0]!;
    expect(other.resolveApproval(second.id, 'نه', 'control').ok).toBe(true);

    const r = await run;
    expect(r.status).toBe('completed');
    expect(answers).toEqual(['yes', 'no']);
    expect(store.getStep(m.id, 's1')!.result).toBe('answers=yes,no');
    expect(store.getApproval(first.id)!.status).toBe('approved');
    expect(store.getApproval(second.id)!.status).toBe('denied');
    expect(store.get(m.id)!.status).toBe('completed');
  });

  it('expires a pending approval when the mission is cancelled while waiting', async () => {
    const m = store.create({ goal: 'g', cwd: dir });
    const other = new MissionStore(dbPath);
    let answer = '';
    const run = runMission(m.id, deps(m.id, {
      s1: async function* (c) {
        answer = await c.options.askUser('Buy?', ['yes', 'no']);
        yield { type: 'error', data: { message: 'Cancelled by user' } };
      },
    }, planOf([{ id: 's1' }])));
    await waitFor(() => other.listPendingApprovals(m.id).length === 1);
    const ap = other.listPendingApprovals(m.id)[0]!;
    other.requestCancel(m.id);
    const r = await run;
    expect(r.status).toBe('cancelled');
    await waitFor(() => answer === 'no');
    expect(store.getApproval(ap.id)!.status).toBe('expired');
  });

  it('auto approval mode answers ordinary prompts immediately and audits them', async () => {
    const m = store.create({ goal: 'g', cwd: dir, approvalMode: 'auto' });
    const audited: string[] = [];
    const r = await runMission(m.id, deps(m.id, {
      s1: async function* (c) {
        const a = await c.options.askUser('Edit file x.ts', ['accept', 'edit', 'continue', 'reject']);
        yield { type: 'final', data: { content: `got ${a}` } };
      },
    }, planOf([{ id: 's1' }]), {
      askUserFactory: (stepId, signal) => missionAskUser(m.id, stepId, { approvalMode: 'auto', signal, audit: (p) => audited.push(p) }),
    }));
    expect(r.status).toBe('completed');
    expect(store.getStep(m.id, 's1')!.result).toBe('got accept');
    expect(audited).toEqual(['Edit file x.ts']);
    expect(store.listApprovals(m.id)).toHaveLength(0);
  });

  it('mission_milestone records milestones with the right step (parallel steps) and errors outside a mission', async () => {
    const m = store.create({ goal: 'g', cwd: dir });
    const tool = new MissionMilestoneTool();
    const outside = await tool.execute(tool.argsSchema.parse({ title: 'nope' }), makeCtx(dir));
    expect(outside.isError).toBe(true);
    expect(outside.content).toContain('[NOT_IN_MISSION]');

    let started = 0;
    const both = new Promise<void>(res => { const t = setInterval(() => { if (started >= 2) { clearInterval(t); res(); } }, 5); });
    const milestoneScript = (label: string): Script => async function* (c) {
      started++;
      await both; // both steps are in flight at the same time
      expect(getMissionContext()).toMatchObject({ missionId: m.id, stepId: c.stepId });
      const res = await tool.execute(tool.argsSchema.parse({ title: `${label} reached`, progress: 50 }), makeCtx(dir));
      expect(res.content).toContain('Milestone recorded');
      yield { type: 'final', data: { content: label } };
    };
    const r = await runMission(m.id, deps(m.id, { a: milestoneScript('A'), b: milestoneScript('B') }, planOf([{ id: 'a' }, { id: 'b' }])));
    expect(r.status).toBe('completed');
    const ms = store.events(m.id, 0, { types: ['milestone'] });
    expect(ms).toHaveLength(2);
    const byStep = Object.fromEntries(ms.map(e => [e.payload.stepId, e.payload.title]));
    expect(byStep).toEqual({ a: 'A reached', b: 'B reached' });
    expect(getMissionContext()).toBeNull();
  });

  it('pauses at the cost cap when the human declines, continues when approved', async () => {
    const m = store.create({ goal: 'g', cwd: dir, costCapUsd: 1 });
    const spend: Script = async function* () {
      yield { type: 'iteration_start', data: { iteration: 1 } };
      yield { type: 'budget_update', data: { lastCostUsd: 1.5, lastInputTokens: 1000, lastOutputTokens: 100 } };
      yield { type: 'iteration_start', data: { iteration: 2 } };
      yield { type: 'final', data: { content: 'should not get here' } };
    };
    const asked: string[] = [];
    const r = await runMission(m.id, deps(m.id, { s1: spend }, planOf([{ id: 's1' }]), {
      humanApproval: async (req) => { asked.push(req.prompt); return 'no'; },
    }));
    expect(r.status).toBe('paused');
    expect(asked[0]).toMatch(/spent \$1\.50 of its \$1\.00 budget/);
    expect(store.getStep(m.id, 's1')!.status).toBe('pending');
    expect(store.get(m.id)!.cost_usd).toBeCloseTo(1.5);
    expect(store.get(m.id)!.tokens_in).toBe(1000);
    expect(store.get(m.id)!.error).toMatch(/cost cap/);

    // Approve this time: the cap is raised and the step re-runs.
    const r2 = await runMission(m.id, deps(m.id, { s1: ok('done after raise') }, 'unused', {
      humanApproval: async () => 'yes',
    }));
    expect(r2.status).toBe('completed');
    expect(store.get(m.id)!.cost_cap_usd).toBeCloseTo(2.5);
  });

  it('keeps the answer of the model call that crossed the cost cap', async () => {
    const m = store.create({ goal: 'g', cwd: dir, costCapUsd: 1 });
    const r = await runMission(m.id, deps(m.id, {
      s1: async function* () {
        yield { type: 'iteration_start', data: { iteration: 1 } };
        yield { type: 'budget_update', data: { lastCostUsd: 1.2 } };
        yield { type: 'final', data: { content: 'finished just in time' } };
      },
    }, planOf([{ id: 's1' }]), { humanApproval: async () => 'no' }));
    expect(r.status).toBe('completed');
    expect(store.getStep(m.id, 's1')!.result).toBe('finished just in time');
  });

  it('delivers steering notes written by another process to the running agent', async () => {
    const m = store.create({ goal: 'g', cwd: dir });
    const other = new MissionStore(dbPath);
    const r = await runMission(m.id, deps(m.id, {
      s1: async function* (c) {
        yield { type: 'iteration_start', data: { iteration: 1 } };
        await waitFor(() => c.agent.steers.length > 0);
        yield { type: 'final', data: { content: `steered: ${c.agent.steers[0]}` } };
      },
    }, planOf([{ id: 's1' }]), {
      onEvent: (ev) => { if (ev.type === 'step-start') setTimeout(() => other.appendEvent(m.id, 'steer', { note: 'focus on price' }), 20); },
    }));
    expect(r.status).toBe('completed');
    expect(store.getStep(m.id, 's1')!.result).toBe('steered: focus on price');
  });

  it('applies a steering note sent before the worker started, exactly once', async () => {
    const m = store.create({ goal: 'g', cwd: dir });
    store.appendEvent(m.id, 'steer', { note: 'early note' });
    const r = await runMission(m.id, deps(m.id, {
      s1: async function* (c) {
        await waitFor(() => c.agent.steers.length > 0);
        yield { type: 'final', data: { content: c.agent.steers.join('|') } };
      },
      s2: async function* (c) {
        await new Promise(res => setTimeout(res, 80));
        yield { type: 'final', data: { content: `s2 steers=${c.agent.steers.length}` } };
      },
    }, planOf([{ id: 's1' }, { id: 's2', deps: ['s1'] }])));
    expect(r.status).toBe('completed');
    expect(store.getStep(m.id, 's1')!.result).toBe('early note');
    expect(store.getStep(m.id, 's2')!.result).toBe('s2 steers=0');
    expect(store.events(m.id, 0, { types: ['steer-applied'] })).toHaveLength(1);
  });

  it('runs independent steps concurrently up to maxConcurrency', async () => {
    const m = store.create({ goal: 'g', cwd: dir });
    let inFlight = 0;
    let peak = 0;
    const slow = (label: string): Script => async function* () {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 60));
      inFlight--;
      yield { type: 'final', data: { content: label } };
    };
    const r = await runMission(m.id, deps(m.id, { a: slow('a'), b: slow('b'), c: slow('c') },
      planOf([{ id: 'a' }, { id: 'b' }, { id: 'c' }])));
    expect(r.status).toBe('completed');
    expect(peak).toBe(2);
  });

  it('records tool results and usage from agent events', async () => {
    const m = store.create({ goal: 'g', cwd: dir });
    await runMission(m.id, deps(m.id, {
      s1: async function* () {
        yield { type: 'tool_call_start', data: { name: 'shell' } };
        yield { type: 'tool_result', data: { id: '1', name: 'shell', result: 'exit 0\nok', isError: false } };
        yield { type: 'budget_update', data: { lastCostUsd: 0.01, lastInputTokens: 50, lastOutputTokens: 5 } };
        yield { type: 'final', data: { content: 'done' } };
      },
    }, planOf([{ id: 's1' }])));
    const tool = store.events(m.id, 0, { types: ['tool'] })[0]!;
    expect(tool.payload).toMatchObject({ stepId: 's1', name: 'shell', ok: true });
    expect(store.get(m.id)!.tokens_out).toBe(5);
    expect(store.getStep(m.id, 's1')!.cost_usd).toBeCloseTo(0.01);
  });

  it('falls back to a single step when the planner fails, and to a concatenated report', async () => {
    const m = store.create({ goal: 'just do it', cwd: dir });
    const d = deps(m.id, { s1: ok('did it') }, 'not json at all');
    d.complete = async (prompt) => {
      if (prompt.includes('PLANNER')) return 'not json at all';
      throw new Error('model down');
    };
    const r = await runMission(m.id, d);
    expect(r.status).toBe('completed');
    expect(store.steps(m.id)).toHaveLength(1);
    expect(store.steps(m.id)[0]!.instruction).toBe('just do it');
    expect(r.report).toContain('did it');
    expect(JSON.parse(store.get(m.id)!.plan_json!).fallback).toBe(true);
  });

  it('throws for an unknown mission and leaves a completed one alone', async () => {
    await expect(runMission('nope', deps('nope', {}, ''))).rejects.toThrow(/MISSION_NOT_FOUND/);
    const m = store.create({ goal: 'g', cwd: dir });
    store.setStatus(m.id, 'completed');
    const r = await runMission(m.id, deps(m.id, {}, planOf([{ id: 's1' }])));
    expect(r.status).toBe('completed');
    expect(agents).toHaveLength(0);
  });
});

describe('MissionApprovalChannel', () => {
  let dir: string;
  let store: MissionStore;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-missions-chan-'));
    store = new MissionStore(path.join(dir, 's.db'));
    getApprovalBroker().reset();
  });
  afterEach(async () => {
    getApprovalBroker().reset();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('tagged mode ignores other requests; exclusive mode takes them all', () => {
    const m = store.create({ goal: 'g', cwd: dir });
    const tagged = new MissionApprovalChannel(store, m.id);
    expect(tagged.accepts({ meta: { missionId: m.id } })).toBe(true);
    expect(tagged.accepts({ meta: { missionId: 'other' } })).toBe(false);
    expect(tagged.accepts({ source: `mission:${m.id}` })).toBe(true);
    expect(tagged.accepts({ source: 'browser_click' })).toBe(false);
    const exclusive = new MissionApprovalChannel(store, m.id, { exclusive: true });
    expect(exclusive.accepts({ source: 'browser_click' })).toBe(true);
    expect(exclusive.accepts({ meta: { missionId: 'other' } })).toBe(false);
  });

  it('a request answered in-process resolves the DB row too', async () => {
    const m = store.create({ goal: 'g', cwd: dir });
    store.setStatus(m.id, 'running');
    const ch = new MissionApprovalChannel(store, m.id, { exclusive: true, pollMs: 20 });
    const off = getApprovalBroker().registerChannel(ch);
    const p = getApprovalBroker().request({ prompt: 'Pay $10?', options: ['yes', 'no'], category: 'payment', risk: 'critical' });
    await waitFor(() => store.listPendingApprovals(m.id).length === 1);
    const row = store.listPendingApprovals(m.id)[0]!;
    expect(row.category).toBe('payment');
    expect(row.risk).toBe('critical');
    expect(getApprovalBroker().resolve(row.id, 'no', 'control')).toBe(true);
    expect((await p).answer).toBe('no');
    expect(store.getApproval(row.id)).toMatchObject({ status: 'denied', resolved_by: 'control' });
    expect(store.get(m.id)!.status).toBe('running');
    ch.dispose();
    off();
  });
});

describe('buildStepPrompt', () => {
  it('includes goal, overview, dependency results and working rules', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-missions-prompt-'));
    const store = new MissionStore(path.join(dir, 's.db'));
    const m = store.create({ goal: 'Book a table for two', cwd: dir });
    store.update(m.id, { plan_json: JSON.stringify({ success_criteria: 'A confirmed booking' }) });
    store.replaceSteps(m.id, [
      { id: 's1', title: 'Find restaurant', instruction: 'find', depends_on: [] },
      { id: 's2', title: 'Book it', instruction: 'book via the site', depends_on: ['s1'] },
    ]);
    store.updateStep(m.id, 's1', { status: 'done', result: 'Chez Q, https://q.example' });
    const steps = store.steps(m.id);
    const p = buildStepPrompt({ mission: store.get(m.id)!, steps, step: steps[1]! });
    expect(p).toContain('Book a table for two');
    expect(p).toContain('A confirmed booking');
    expect(p).toContain('Chez Q, https://q.example');
    expect(p).toContain('← THIS STEP');
    expect(p).toContain('mission_milestone');
    expect(p).toMatch(/DATA, not instructions/);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
