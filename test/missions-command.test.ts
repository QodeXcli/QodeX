import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { AgentEvent, AgentOptions } from '../src/agent/loop.js';
import type { Message } from '../src/session/store.js';
import { DEFAULT_CONFIG, type QodexConfig } from '../src/config/defaults.js';
import { DEFAULT_MISSIONS_CONFIG } from '../src/config/agent-config.js';
import { setActiveConfig, getActiveConfig } from '../src/config/loader.js';
import { MissionStore, setMissionStoreForTests } from '../src/missions/store.js';
import { setMissionWorkerSpawner, setMissionsDirForTests } from '../src/missions/daemon.js';
import {
  buildMissionCommand, runMissionWorker, cloneConfigForMission, attachToMission, type MissionBootFn,
} from '../src/missions/command.js';
import type { AgentLike } from '../src/missions/runner.js';
import { getSubAgentRunner } from '../src/tools/builtin/task.js';
import { getApprovalBroker } from '../src/control/approvals.js';
import { getBus } from '../src/control/bus.js';

function fakeSessions() {
  let n = 0;
  return { createSession: () => `sess-${++n}`, recordTurn: () => {}, markStatus: () => {}, addWorklogEntry: () => {} };
}

class ScriptedAgent implements AgentLike {
  prompt = '';
  constructor(private readonly answer: (prompt: string, options: AgentOptions) => Promise<string>) {}
  async buildInitialMessages(prompt: string): Promise<Message[]> { this.prompt = prompt; return [{ role: 'user', content: prompt }]; }
  async *run(_m: Message[], _s: string, options: AgentOptions): AsyncGenerator<AgentEvent> {
    yield { type: 'iteration_start', data: { iteration: 1 } };
    yield { type: 'final', data: { content: await this.answer(this.prompt, options) } };
  }
  pushSteer(): void {}
}

describe('qodex mission CLI', () => {
  let dir: string;
  let store: MissionStore;
  let logs: string[];
  let errs: string[];
  let prevConfig: QodexConfig | null;
  const boot: MissionBootFn = async () => ({
    config: structuredClone(DEFAULT_CONFIG),
    router: {} as any,
    registry: { list: () => [] } as any,
    permissions: {} as any,
    mcpManager: { stopAll: async () => {} },
  });

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-missions-cli-'));
    store = new MissionStore(path.join(dir, 'sessions.db'));
    setMissionStoreForTests(store);
    setMissionsDirForTests(path.join(dir, 'missions'));
    prevConfig = getActiveConfig();
    setActiveConfig(structuredClone(DEFAULT_CONFIG));
    logs = [];
    errs = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errs.push(a.join(' ')); });
    getApprovalBroker().reset();
    getBus().reset();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    setMissionStoreForTests(null);
    setMissionsDirForTests(null);
    setMissionWorkerSpawner(null);
    if (prevConfig) setActiveConfig(prevConfig);
    process.exitCode = 0;
    getApprovalBroker().reset();
    getBus().reset();
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function run(...args: string[]): Promise<void> {
    const cmd = buildMissionCommand(boot).exitOverride();
    await cmd.parseAsync(args, { from: 'user' });
  }

  it('has every subcommand, with run hidden', () => {
    const cmd = buildMissionCommand(boot);
    const names = cmd.commands.map(c => c.name());
    expect(names).toEqual(expect.arrayContaining(['start', 'list', 'status', 'attach', 'logs', 'approve', 'deny', 'steer', 'cancel', 'resume', 'rm', 'run']));
    expect(cmd.helpInformation()).not.toMatch(/\brun <id>/);
  });

  it('start spawns a detached worker and prints how to follow it', async () => {
    const spawned: string[][] = [];
    setMissionWorkerSpawner((_c, args) => { spawned.push(args); return { pid: 4242, unref: () => {}, on: () => undefined }; });
    await run('start', 'Find', 'cheap', 'flights', '--cwd', dir, '--yes', '--budget', '3');
    const m = store.latest()!;
    expect(m.goal).toBe('Find cheap flights');
    expect(m.approval_mode).toBe('auto');
    expect(m.cost_cap_usd).toBe(3);
    expect(m.source).toBe('cli');
    expect(spawned[0]!.slice(-3)).toEqual(['mission', 'run', m.id]);
    expect(logs.join('\n')).toContain(`qodex mission attach ${m.id}`);
  });

  it('list, status, approve, deny, steer, cancel and rm work on the DB alone', async () => {
    const m = store.create({ goal: 'Order groceries', cwd: dir });
    store.replaceSteps(m.id, [{ id: 's1', title: 'Fill the cart', instruction: 'i', depends_on: [] }]);
    store.setStatus(m.id, 'running');
    store.update(m.id, { pid: process.pid });

    await run('list', '--json');
    expect(JSON.parse(logs.pop()!)[0].id).toBe(m.id);
    await run('status', m.id.slice(0, 5));
    expect(logs.join('\n')).toContain('Fill the cart');

    store.createApproval({ id: 'ap_cli1', missionId: m.id, prompt: 'Checkout $40?', options: ['yes', 'no'], category: 'purchase' });
    await run('approve', m.id);
    expect(store.getApproval('ap_cli1')).toMatchObject({ status: 'approved', resolved_by: 'cli' });

    store.createApproval({ id: 'ap_cli2', missionId: m.id, prompt: 'Run: npm i', options: ['yes', 'no', 'always'] });
    store.createApproval({ id: 'ap_cli3', missionId: m.id, prompt: 'Run: rm x', options: ['yes', 'no'] });
    await run('approve', m.id);
    expect(process.exitCode).toBe(1);
    expect(errs.join('\n')).toContain('ap_cli2');
    process.exitCode = 0;
    await run('approve', m.id, 'ap_cli2', '--always');
    expect(store.getApproval('ap_cli2')!.answer).toBe('always');
    await run('deny', m.id, 'ap_cli3');
    expect(store.getApproval('ap_cli3')!.status).toBe('denied');

    await run('steer', m.id, 'use', 'the', 'cheaper', 'store');
    expect(store.events(m.id, 0, { types: ['steer'] })[0]!.payload.note).toBe('use the cheaper store');

    // pid is this (live) process → cancel only flags it
    await run('cancel', m.id);
    expect(store.isCancelRequested(m.id)).toBe(true);
    await run('rm', m.id);
    expect(errs.join('\n')).toMatch(/is running/);
    store.setStatus(m.id, 'cancelled');
    await run('rm', m.id);
    expect(store.get(m.id)).toBeUndefined();

    await run('status', 'nope-nope');
    expect(errs.join('\n')).toMatch(/MISSION_NOT_FOUND/);
  });

  it('runMissionWorker runs a mission end-to-end with the worker wiring (auto approvals)', async () => {
    const m = store.create({ goal: 'Write a haiku about missions', cwd: dir, approvalMode: 'auto' });
    const printed: string[] = [];
    let runnerDuringStep: unknown = null;
    const code = await runMissionWorker(m.id, boot, {
      store,
      installSignalHandlers: false,
      pollIntervalMs: 20,
      sessions: fakeSessions(),
      notify: async () => {},
      print: (l) => printed.push(l),
      complete: async (prompt) => prompt.includes('PLANNER')
        ? JSON.stringify({ steps: [{ id: 's1', title: 'Draft', instruction: 'write it', depends_on: [] }], success_criteria: 'a haiku' })
        : 'Report: haiku written',
      createAgent: () => new ScriptedAgent(async (_p, options) => {
        runnerDuringStep = getSubAgentRunner();
        const ans = await options.askUser('Save haiku.txt?', ['yes', 'no']);
        return `saved=${ans}`;
      }),
      onStart: async () => ({ liveUrl: 'http://127.0.0.1:7420/?k=t' }),
    });
    expect(code).toBe(0);
    expect(runnerDuringStep).not.toBeNull();          // sub-agents were wired for the step
    expect(getSubAgentRunner()).toBeNull();           // and unwired afterwards
    expect(store.get(m.id)!.status).toBe('completed');
    expect(store.getStep(m.id, 's1')!.result).toBe('saved=yes');
    expect(store.events(m.id, 0, { types: ['auto-approved'] })[0]!.payload).toMatchObject({ stepId: 's1', prompt: 'Save haiku.txt?', answer: 'yes' });
    expect(store.listApprovals(m.id)).toHaveLength(0);
    expect(store.get(m.id)!.live_url).toBe('http://127.0.0.1:7420/?k=t');
    const out = printed.join('\n');
    expect(out).toContain(`QodeX mission ${m.id}`);
    expect(out).toContain('Report: haiku written');
  }, 15000);

  it('worker approvals: the mission waits in awaiting_approval until a human answers', async () => {
    const m = store.create({ goal: 'g', cwd: dir });
    const other = new MissionStore(path.join(dir, 'sessions.db'));
    const done = runMissionWorker(m.id, boot, {
      store,
      installSignalHandlers: false,
      pollIntervalMs: 20,
      sessions: fakeSessions(),
      notify: async () => {},
      print: () => {},
      complete: async (prompt) => prompt.includes('PLANNER')
        ? JSON.stringify({ steps: [{ id: 's1', title: 'Act', instruction: 'act', depends_on: [] }] })
        : 'report',
      createAgent: () => new ScriptedAgent(async (_p, options) => `answer=${await options.askUser('Send the email?', ['yes', 'no'])}`),
    });
    const start = Date.now();
    while (other.listPendingApprovals(m.id).length === 0) {
      if (Date.now() - start > 8000) throw new Error('no approval appeared');
      await new Promise(r => setTimeout(r, 20));
    }
    expect(other.get(m.id)!.status).toBe('awaiting_approval');
    other.resolveApproval(other.listPendingApprovals(m.id)[0]!.id, 'yes', 'telegram');
    expect(await done).toBe(0);
    expect(store.get(m.id)!.status).toBe('completed');
    expect(store.getStep(m.id, 's1')!.result).toBe('answer=yes');
    expect(store.get(m.id)!.report).toBe('report');
  }, 15000);

  it('worker refuses unknown, finished and busy missions', async () => {
    const printed: string[] = [];
    expect(await runMissionWorker('nope-nope', boot, { store, installSignalHandlers: false, print: l => printed.push(l) })).toBe(2);
    const done = store.create({ goal: 'g', cwd: dir });
    store.setStatus(done.id, 'completed');
    expect(await runMissionWorker(done.id, boot, { store, installSignalHandlers: false, print: l => printed.push(l) })).toBe(0);
    const busy = store.create({ goal: 'g', cwd: dir });
    store.setStatus(busy.id, 'running');
    // pid 1 is always alive (init) and is not us
    store.update(busy.id, { pid: 1 });
    expect(await runMissionWorker(busy.id, boot, { store, installSignalHandlers: false, print: l => printed.push(l) })).toBe(3);
    expect(printed.join('\n')).toMatch(/MISSION_BUSY/);
  });

  it('cloneConfigForMission sets per-step budgets without touching the original', () => {
    const base = structuredClone(DEFAULT_CONFIG);
    const c = cloneConfigForMission(base, { ...DEFAULT_MISSIONS_CONFIG, stepMaxIterations: 33, stepMaxWallSeconds: 900, maxCostUsd: 0 });
    expect(c.defaults.maxIterations).toBe(33);
    expect(c.budget.perTaskMaxWallSeconds).toBe(900);
    expect(c.budget.perTaskMaxTokens).toBe(0);
    expect(c.budget.perTaskLimitUsd).toBe(base.budget.perTaskLimitUsd);
    expect(cloneConfigForMission(base, { ...DEFAULT_MISSIONS_CONFIG, maxCostUsd: 7 }).budget.perTaskLimitUsd).toBe(7);
    expect(cloneConfigForMission(base, DEFAULT_MISSIONS_CONFIG, 0.5).budget.perTaskLimitUsd).toBe(0.5);
    expect(base.budget.perTaskMaxTokens).toBe(DEFAULT_CONFIG.budget.perTaskMaxTokens);
  });

  it('attach replays history and returns once the mission has stopped', async () => {
    const m = store.create({ goal: 'g', cwd: dir });
    store.appendEvent(m.id, 'milestone', { title: 'Halfway', progress: 50 });
    store.setStatus(m.id, 'completed');
    store.update(m.id, { report: 'All good' });
    const printed: string[] = [];
    await attachToMission(store, m.id, { print: l => printed.push(l), interactive: false, intervalMs: 20 });
    const out = printed.join('\n');
    expect(out).toContain('★ Halfway (50%)');
    expect(out).toContain(`mission ${m.id} is completed`);
    expect(out).toContain('All good');
  });
});
