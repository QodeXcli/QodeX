/**
 * Missions under auto mode:
 *   - mission_start in auto mode starts without a confirmation and the mission gets
 *     approval_mode 'auto' (also /mission, control center, Telegram, bot starts in an auto
 *     session — startMission inherits the process mode);
 *   - the worker applies the SAME autonomous policy as the session (its process approval
 *     mode is 'auto'): ordinary steps silent, remote deletes and critical actions go to the
 *     mission queue (a human), never auto-answered. The cost cap still asks a human.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { AgentEvent, AgentOptions } from '../src/agent/loop.js';
import type { Message } from '../src/session/store.js';
import type { ToolContext } from '../src/tools/base.js';
import { DEFAULT_CONFIG, type QodexConfig } from '../src/config/defaults.js';
import { DEFAULT_SENTINEL_CONFIG } from '../src/config/agent-config.js';
import { setActiveConfig, getActiveConfig } from '../src/config/loader.js';
import { Sentinel } from '../src/sentinel/guard.js';
import { markAutonomousPermissions } from '../src/sentinel/auto-mode.js';
import { MissionStore, setMissionStoreForTests } from '../src/missions/store.js';
import { setMissionWorkerSpawner, setMissionsDirForTests, startMission } from '../src/missions/daemon.js';
import { runMissionWorker, buildMissionCommand, missionApprovalFromFlags, type MissionBootFn } from '../src/missions/command.js';
import type { AgentLike } from '../src/missions/runner.js';
import { MissionStartTool } from '../src/missions/tools.js';
import { createMissionChannelAdapter } from '../src/missions/index.js';
import { createTelegramMissionAdapter } from '../src/missions/telegram-adapter.js';
import { getApprovalBroker, isInteractiveHuman, setInteractiveHuman } from '../src/control/approvals.js';
import { getBus } from '../src/control/bus.js';
import { PermissionEngine, getApprovalMode, isAutonomousMode, setApprovalMode } from '../src/security/permissions.js';

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

async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise(r => setTimeout(r, 20));
  }
}

function toolCtx(cwd: string, o: { evaluate?: () => 'allow' | 'ask' | 'deny'; ask?: (p: string, opts?: string[]) => Promise<string>; permissions?: any } = {}): ToolContext {
  return {
    cwd, sessionId: 'test', transaction: {} as any,
    permissions: o.permissions ?? ({ evaluate: o.evaluate ?? (() => 'ask'), rememberDecision: () => {} } as any),
    askUser: o.ask ?? (async () => 'yes'), signal: new AbortController().signal, emit: () => {},
  } as ToolContext;
}

const plan1 = JSON.stringify({ steps: [{ id: 's1', title: 'Work', instruction: 'do it', depends_on: [] }], success_criteria: 'done' });

let dir: string;
let store: MissionStore;
let prevConfig: QodexConfig | null;
let spawned: string[][];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-automode-missions-'));
  store = new MissionStore(path.join(dir, 'sessions.db'));
  setMissionStoreForTests(store);
  setMissionsDirForTests(path.join(dir, 'missions'));
  prevConfig = getActiveConfig();
  setActiveConfig(structuredClone(DEFAULT_CONFIG));
  spawned = [];
  setMissionWorkerSpawner((_c, args) => { spawned.push(args); return { pid: process.pid, unref: () => {}, on: () => undefined } as any; });
  getApprovalBroker().reset();
  getBus().reset();
  setInteractiveHuman(false);
  setApprovalMode('manual');
});
afterEach(async () => {
  vi.restoreAllMocks();
  setApprovalMode('manual');
  setMissionStoreForTests(null);
  setMissionsDirForTests(null);
  setMissionWorkerSpawner(null);
  if (prevConfig) setActiveConfig(prevConfig);
  getApprovalBroker().reset();
  getBus().reset();
  setInteractiveHuman(false);
  await fs.rm(dir, { recursive: true, force: true });
});

describe('mission_start in auto mode', () => {
  it('starts without a confirmation and records approval_mode auto', async () => {
    setApprovalMode('auto');
    const prompts: string[] = [];
    const progress: string[] = [];
    const t = new MissionStartTool();
    const ctx = toolCtx(dir, { evaluate: () => 'ask', ask: async (p) => { prompts.push(p); return 'no'; } });
    ctx.emit = (e: any) => { if (e.type === 'progress') progress.push(e.message); };
    const r = await t.execute(t.argsSchema.parse({ goal: 'Refactor the parser and keep tests green' }), ctx);
    expect(r.isError).toBeFalsy();
    expect(prompts).toEqual([]);
    expect(spawned).toHaveLength(1);
    const row = store.list()[0]!;
    expect(row.approval_mode).toBe('auto');
    expect(r.content).toMatch(/Auto mode: ordinary steps run without asking/);
    expect(progress.some(p => /Auto mode: starting a background mission without asking/.test(p))).toBe(true);
  });

  it('a per-conversation autonomous engine counts as auto too', async () => {
    const engine = markAutonomousPermissions({ evaluate: () => 'ask', rememberDecision: () => {} });
    const prompts: string[] = [];
    const t = new MissionStartTool();
    const r = await t.execute(t.argsSchema.parse({ goal: 'g' }), toolCtx(dir, { permissions: engine, ask: async (p) => { prompts.push(p); return 'no'; } }));
    expect(r.isError).toBeFalsy();
    expect(prompts).toEqual([]);
    expect(store.list()[0]!.approval_mode).toBe('auto');
  });

  it('deny rules still refuse in auto mode', async () => {
    setApprovalMode('auto');
    const t = new MissionStartTool();
    const r = await t.execute(t.argsSchema.parse({ goal: 'g' }), toolCtx(dir, { evaluate: () => 'deny' }));
    expect(r.content).toMatch(/^\[PERMISSION_DENIED\]/);
    expect(store.list()).toHaveLength(0);
  });

  it('manual mode still confirms, and the mission asks a human (approval_mode ask)', async () => {
    const prompts: string[] = [];
    const t = new MissionStartTool();
    const r = await t.execute(t.argsSchema.parse({ goal: 'g' }), toolCtx(dir, { ask: async (p) => { prompts.push(p); return 'yes'; } }));
    expect(r.isError).toBeFalsy();
    expect(prompts).toHaveLength(1);
    expect(store.list()[0]!.approval_mode).toBe('ask');
  });
});

describe('every start path inherits the session mode', () => {
  it('startMission without an explicit mode: auto session → auto, manual → ask', () => {
    setApprovalMode('auto');
    expect(startMission({ goal: 'tui /mission', cwd: dir, spawn: false }).mission.approval_mode).toBe('auto');
    setApprovalMode('edits');
    expect(startMission({ goal: 'edits session', cwd: dir, spawn: false }).mission.approval_mode).toBe('ask');
    setApprovalMode('manual');
    expect(startMission({ goal: 'manual session', cwd: dir, spawn: false }).mission.approval_mode).toBe('ask');
    // An explicit mode wins.
    setApprovalMode('auto');
    expect(startMission({ goal: 'explicit', cwd: dir, spawn: false, approvalMode: 'ask' }).mission.approval_mode).toBe('ask');
  });

  it('control-center / Telegram adapters started in an auto session create auto missions', async () => {
    setApprovalMode('auto');
    const ch = createMissionChannelAdapter({ store, defaultCwd: dir, source: 'telegram' });
    const a = await ch.start('channel goal');
    expect(store.get(a.id)!.approval_mode).toBe('auto');
    const tg = createTelegramMissionAdapter({ store, defaultCwd: dir });
    const b = await tg.start('telegram goal');
    expect(store.get(b.id)!.approval_mode).toBe('auto');
    setApprovalMode('manual');
    const c = await ch.start('manual goal');
    expect(store.get(c.id)!.approval_mode).toBe('ask');
  });

  it('CLI flags: --yes / --auto / --approval-mode', async () => {
    expect(missionApprovalFromFlags({ yes: true })).toBe('auto');
    expect(missionApprovalFromFlags({ auto: true })).toBe('auto');
    expect(missionApprovalFromFlags({ approvalMode: 'auto' })).toBe('auto');
    expect(missionApprovalFromFlags({ approvalMode: 'manual' })).toBe('ask');
    expect(missionApprovalFromFlags({ approvalMode: 'edits' })).toBe('ask');
    expect(missionApprovalFromFlags({})).toBeUndefined();
    expect(() => missionApprovalFromFlags({ approvalMode: 'yolo-ish' })).toThrow(/approval-mode/);

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
    const cmd = () => buildMissionCommand(async () => { throw new Error('no boot'); }).exitOverride();
    await cmd().parseAsync(['start', 'via', 'auto', '--auto', '--json', '--cwd', dir], { from: 'user' });
    expect(store.get(JSON.parse(logs.pop()!).id)!.approval_mode).toBe('auto');
    await cmd().parseAsync(['start', 'via', 'manual', '--approval-mode', 'manual', '--json', '--cwd', dir], { from: 'user' });
    expect(store.get(JSON.parse(logs.pop()!).id)!.approval_mode).toBe('ask');
  });
});

describe('the worker applies the session policy (never a blanket yes)', () => {
  const boot: MissionBootFn = async () => ({
    config: structuredClone(DEFAULT_CONFIG),
    router: {} as any,
    registry: { list: () => [] } as any,
    permissions: {} as any,
    mcpManager: { stopAll: async () => {} },
  });

  function sentinel() {
    return new Sentinel({ config: () => ({ ...DEFAULT_SENTINEL_CONFIG, audit: false }), audit: null, browser: () => null });
  }

  it("auto: ordinary steps silent; a remote delete and a purchase wait in the mission queue; the process mode is restored", async () => {
    const m = store.create({ goal: 'g', cwd: dir, approvalMode: 'auto' });
    const other = new MissionStore(path.join(dir, 'sessions.db'));
    const s = sentinel();
    let modeInStep: string | null = null;
    let interactiveInStep: boolean | null = null;
    const done = runMissionWorker(m.id, boot, {
      store, installSignalHandlers: false, pollIntervalMs: 20, sessions: fakeSessions(), notify: async () => {}, print: () => {},
      complete: async (p) => p.includes('PLANNER') ? plan1 : 'report',
      createAgent: () => new ScriptedAgent(async (_p, options) => {
        modeInStep = getApprovalMode();
        interactiveInStep = isInteractiveHuman();
        const ctx = {
          cwd: dir, sessionId: 's', transaction: {} as any,
          permissions: new PermissionEngine(DEFAULT_CONFIG),
          askUser: options.askUser, signal: options.signal, emit: () => {},
        } as unknown as ToolContext;
        const out: string[] = [];
        // ordinary: desktop input, HTTP write, page-free MCP read — no prompt at all
        out.push(`click=${(await s.beforeTool('computer_use_click', { x: 1, y: 1 }, ctx)) ? 'blocked' : 'ok'}`);
        out.push(`post=${(await s.beforeTool('http_request', { method: 'POST', url: 'https://api.example.com/x' }, ctx)) ? 'blocked' : 'ok'}`);
        // remote delete → the queue (a human); the test answers "no"
        out.push(`delete=${(await s.beforeTool('mcp:gdrive:delete_file', { id: 'f' }, ctx)) ? 'blocked' : 'ok'}`);
        // critical → the queue; the test answers "yes"
        out.push(`buy=${(await s.beforeTool('mcp:shop:purchase_item', { item: 'tv' }, ctx)) ? 'blocked' : 'ok'}`);
        return out.join(' ');
      }),
    });
    await waitFor(() => other.listPendingApprovals(m.id).length === 1);
    const del = other.listPendingApprovals(m.id)[0]!;
    expect(del.prompt).toContain('Auto mode still asks');
    expect(del.category).toBe('delete');
    expect(other.resolveApproval(del.id, 'no', 'telegram').ok).toBe(true);
    await waitFor(() => other.listPendingApprovals(m.id).length === 1 && other.listPendingApprovals(m.id)[0]!.id !== del.id);
    const buy = other.listPendingApprovals(m.id)[0]!;
    expect(buy.risk).toBe('critical');
    expect(other.resolveApproval(buy.id, 'yes', 'control').ok).toBe(true);
    expect(await done).toBe(0);
    expect(store.getStep(m.id, 's1')!.result).toBe('click=ok post=ok delete=blocked buy=ok');
    expect(modeInStep).toBe('auto');
    expect(interactiveInStep).toBe(false);
    expect(getApprovalMode()).toBe('manual');
    expect(isAutonomousMode()).toBe(false);
  }, 20000);

  it("ask: the worker runs manual even when this process was in auto mode", async () => {
    setApprovalMode('auto');
    const m = store.create({ goal: 'g', cwd: dir, approvalMode: 'ask' });
    let modeInStep: string | null = null;
    const code = await runMissionWorker(m.id, boot, {
      store, installSignalHandlers: false, pollIntervalMs: 20, sessions: fakeSessions(), notify: async () => {}, print: () => {},
      complete: async (p) => p.includes('PLANNER') ? plan1 : 'report',
      createAgent: () => new ScriptedAgent(async () => { modeInStep = getApprovalMode(); return 'ok'; }),
    });
    expect(code).toBe(0);
    expect(modeInStep).toBe('manual');
    expect(getApprovalMode()).toBe('auto');
  }, 15000);

  it('auto: the cost cap still asks a human', async () => {
    const m = store.create({ goal: 'g', cwd: dir, approvalMode: 'auto', costCapUsd: 0.5 });
    const other = new MissionStore(path.join(dir, 'sessions.db'));
    let calls = 0;
    const done = runMissionWorker(m.id, boot, {
      store, installSignalHandlers: false, pollIntervalMs: 20, sessions: fakeSessions(), notify: async () => {}, print: () => {},
      complete: async (p) => p.includes('PLANNER') ? plan1 : 'report',
      createAgent: () => ({
        prompt: '',
        async buildInitialMessages(p: string) { return [{ role: 'user', content: p }] as Message[]; },
        async *run(): AsyncGenerator<AgentEvent> {
          calls++;
          yield { type: 'iteration_start', data: { iteration: 1 } };
          yield { type: 'budget_update', data: { lastCostUsd: 1, lastInputTokens: 10, lastOutputTokens: 10 } };
          yield { type: 'iteration_start', data: { iteration: 2 } };
          yield { type: 'final', data: { content: 'x' } };
        },
        pushSteer() {},
      }),
    });
    await waitFor(() => other.listPendingApprovals(m.id).length === 1);
    const cap = other.listPendingApprovals(m.id)[0]!;
    expect(cap.category).toBe('cost');
    expect(other.resolveApproval(cap.id, 'no', 'telegram').ok).toBe(true);
    await done;
    expect(store.get(m.id)!.status).toBe('paused');
    expect(calls).toBeGreaterThan(0);
  }, 20000);
});

