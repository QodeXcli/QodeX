import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import type { ToolContext } from '../src/tools/base.js';
import { MissionStore, setMissionStoreForTests, isProcessAlive } from '../src/missions/store.js';
import {
  spawnMissionWorker, resolveWorkerCommand, setMissionWorkerSpawner, cancelMission, prepareResume,
  steerMission, answerMissionApproval, answerApprovalById, handleWorkerTermination, handleWorkerExit,
  summarizeMission, listMissionSummaries, startMission, missionLogPath, setMissionsDirForTests, type WorkerSpawner,
} from '../src/missions/daemon.js';
import {
  MISSION_TOOL_CLASSES, MissionStartTool, MissionStatusTool, MissionListTool, MissionCancelTool,
  formatEventLine, formatMissionLine, setMissionInlineRunner,
} from '../src/missions/tools.js';
import { createMissionControlActions, createMissionChannelAdapter, startMissionEventBridge } from '../src/missions/index.js';
import { getBus, type BusEvent } from '../src/control/bus.js';

function makeCtx(cwd: string, signal?: AbortSignal): ToolContext {
  return {
    cwd, sessionId: 'test', transaction: {} as any, permissions: { evaluate: () => 'allow' } as any,
    askUser: async () => 'yes', signal: signal ?? new AbortController().signal, emit: () => {},
  } as ToolContext;
}

async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise(r => setTimeout(r, 20));
  }
}

const DEAD_PID = 2 ** 22 + 777;

describe('mission daemon', () => {
  let dir: string;
  let store: MissionStore;
  let spawned: Array<{ command: string; args: string[]; opts: any }>;
  const fakeSpawner: WorkerSpawner = (command, args, opts) => {
    spawned.push({ command, args, opts });
    return { pid: process.pid, unref: () => {}, on: () => undefined };
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-missions-daemon-'));
    store = new MissionStore(path.join(dir, 'sessions.db'));
    setMissionStoreForTests(store);
    setMissionsDirForTests(path.join(dir, 'missions'));
    spawned = [];
    getBus().reset();
  });
  afterEach(async () => {
    setMissionStoreForTests(null);
    setMissionsDirForTests(null);
    setMissionWorkerSpawner(null);
    setMissionInlineRunner(null);
    getBus().reset();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('builds the worker command line from node + the CLI entry, dropping debugger flags', () => {
    const c = resolveWorkerCommand('m1', { entry: '/opt/qodex/bin/qodex.mjs', execPath: '/usr/bin/node', execArgv: ['--inspect=9229', '--import', 'tsx'] });
    expect(c).toEqual({ command: '/usr/bin/node', args: ['--import', 'tsx', '/opt/qodex/bin/qodex.mjs', 'mission', 'run', 'm1'] });
  });

  it('spawns a real detached worker with QODEX_MISSION_ID, logs to the mission log and stores the pid', async () => {
    const script = path.join(dir, 'fake-cli.mjs');
    const out = path.join(dir, 'worker-out.json');
    await fs.writeFile(script, `import fs from 'fs';\nconsole.log('worker says hi');\nfs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), id: process.env.QODEX_MISSION_ID, cwd: process.cwd() }));\n`);
    const m = store.create({ goal: 'g', cwd: dir });
    const logFile = path.join(dir, 'logs', `${m.id}.log`);
    const r = spawnMissionWorker(m.id, { cwd: dir, store, entry: script, execArgv: [], logFile });
    expect(r.pid).toBeGreaterThan(0);
    expect(store.get(m.id)!.pid).toBe(r.pid);
    expect(store.get(m.id)!.log_file).toBe(logFile);
    await waitFor(() => fsSync.existsSync(out));
    const got = JSON.parse(await fs.readFile(out, 'utf8'));
    expect(got.argv).toEqual(['mission', 'run', m.id]);
    expect(got.id).toBe(m.id);
    expect(await fs.realpath(got.cwd)).toBe(await fs.realpath(dir));
    await waitFor(() => fsSync.readFileSync(logFile, 'utf8').includes('worker says hi'));
    expect(fsSync.readFileSync(logFile, 'utf8')).toContain(`starting mission worker ${m.id}`);
    expect(store.events(m.id, 0, { types: ['worker-spawned'] })).toHaveLength(1);
  });

  it('cancelMission SIGTERMs a live worker, finalizes one without a worker', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    await waitFor(() => !!child.pid);
    const live = store.create({ goal: 'live', cwd: dir });
    store.setStatus(live.id, 'running');
    store.update(live.id, { pid: child.pid! });
    const exited = new Promise<void>(res => child.once('exit', () => res()));
    const r = cancelMission(live.id, { store });
    expect(r.ok).toBe(true);
    expect(r.signalled).toBe(true);
    expect(store.isCancelRequested(live.id)).toBe(true);
    await exited;
    expect(isProcessAlive(child.pid!)).toBe(false);
    // the dead worker never recorded anything — reconcile turns it into 'cancelled'
    expect(store.reconcile(live.id)!.status).toBe('cancelled');

    const idle = store.create({ goal: 'paused one', cwd: dir });
    store.setStatus(idle.id, 'paused');
    const r2 = cancelMission(idle.id.slice(0, 5), { store });
    expect(r2.ok).toBe(true);
    expect(r2.signalled).toBe(false);
    expect(store.get(idle.id)!.status).toBe('cancelled');
    expect(cancelMission(idle.id, { store }).ok).toBe(false);
    expect(cancelMission('nope-nope', { store }).message).toMatch(/MISSION_NOT_FOUND/);
  });

  it('worker termination: cancel requested → cancelled; otherwise paused + steps re-queued', () => {
    const a = store.create({ goal: 'a', cwd: dir });
    store.replaceSteps(a.id, [{ id: 's1', title: 't', instruction: 'i', depends_on: [] }]);
    store.setStatus(a.id, 'running');
    store.updateStep(a.id, 's1', { status: 'running' });
    expect(handleWorkerTermination(store, a.id)!.status).toBe('paused');
    expect(store.get(a.id)!.error).toMatch(/resume/);
    expect(store.getStep(a.id, 's1')!.status).toBe('pending');

    const b = store.create({ goal: 'b', cwd: dir });
    store.setStatus(b.id, 'running');
    store.requestCancel(b.id);
    expect(handleWorkerTermination(store, b.id)!.status).toBe('cancelled');

    // exit hook only touches a mission this process owns
    const c = store.create({ goal: 'c', cwd: dir });
    store.setStatus(c.id, 'running');
    store.update(c.id, { pid: DEAD_PID });
    handleWorkerExit(store, c.id, process.pid);
    expect(store.get(c.id)!.status).toBe('running');
    store.update(c.id, { pid: process.pid });
    handleWorkerExit(store, c.id, process.pid);
    expect(store.get(c.id)!.status).toBe('paused');
  });

  it('prepareResume retries failed steps, raises an exhausted cost cap and refuses completed missions', () => {
    const m = store.create({ goal: 'g', cwd: dir, costCapUsd: 2 });
    store.replaceSteps(m.id, [
      { id: 's1', title: 'a', instruction: 'a', depends_on: [] },
      { id: 's2', title: 'b', instruction: 'b', depends_on: ['s1'] },
    ]);
    store.updateStep(m.id, 's1', { status: 'failed', attempts: 2, error: 'x' });
    store.updateStep(m.id, 's2', { status: 'skipped' });
    store.addUsage(m.id, { costUsd: 2.5 });
    store.setStatus(m.id, 'failed', { error: 'failed' });
    store.requestCancel(m.id);
    const r = prepareResume(m.id, { store, approvalMode: 'auto' });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/2 step\(s\) will be retried/);
    const after = store.get(m.id)!;
    expect(after.cancel_requested).toBe(0);
    expect(after.approval_mode).toBe('auto');
    expect(after.cost_cap_usd).toBeCloseTo(4.5);
    expect(store.steps(m.id).every(s => s.status === 'pending' && s.attempts === 0)).toBe(true);

    store.setStatus(m.id, 'completed');
    expect(prepareResume(m.id, { store }).ok).toBe(false);

    const inline = store.create({ goal: 'inline', cwd: dir });
    store.setStatus(inline.id, 'running');
    store.update(inline.id, { pid: process.pid });
    expect(prepareResume(inline.id, { store }).message).toMatch(/already running/);

    // A worker that is still booting (status not yet running) also owns the mission.
    const booting = store.create({ goal: 'booting', cwd: dir });
    store.setStatus(booting.id, 'paused');
    store.update(booting.id, { pid: 1 });
    expect(prepareResume(booting.id, { store }).message).toMatch(/already running/);
    store.update(booting.id, { pid: DEAD_PID });
    expect(prepareResume(booting.id, { store }).ok).toBe(true);
    expect(store.get(booting.id)!.pid).toBeNull();
  });

  it('steer + approvals through the control API', () => {
    const m = store.create({ goal: 'g', cwd: dir });
    store.setStatus(m.id, 'paused');
    expect(steerMission(m.id, 'hello', { store }).ok).toBe(false); // not running
    store.setStatus(m.id, 'running');
    store.update(m.id, { pid: process.pid });
    expect(steerMission(m.id, '  ', { store }).ok).toBe(false);
    expect(steerMission(m.id, 'prefer the cheaper one', { store, by: 'test' }).ok).toBe(true);
    expect(store.events(m.id, 0, { types: ['steer'] })[0]!.payload).toEqual({ note: 'prefer the cheaper one', by: 'test' });

    expect(answerMissionApproval(m.id, undefined, 'yes', { store }).message).toMatch(/no pending approvals/);
    store.createApproval({ id: 'ap_one', missionId: m.id, prompt: 'p1', options: ['yes', 'no'] });
    const single = answerMissionApproval(m.id, undefined, 'yes', { store, by: 'cli' });
    expect(single.ok).toBe(true);
    expect(single.message).toMatch(/Approved ap_one/);

    store.createApproval({ id: 'ap_a', missionId: m.id, prompt: 'p2', options: ['yes', 'no'] });
    store.createApproval({ id: 'ap_b', missionId: m.id, prompt: 'p3', options: ['yes', 'no'] });
    const amb = answerMissionApproval(m.id, undefined, 'yes', { store });
    expect(amb.ok).toBe(false);
    expect(amb.pending).toHaveLength(2);
    expect(answerMissionApproval(m.id, 'ap_b', 'no', { store }).status).toBe('denied');
    expect(answerApprovalById('ap_a', 'maybe', { store }).ok).toBe(false);
    expect(answerApprovalById('ap_a', 'y', { store }).ok).toBe(true);
    expect(answerApprovalById('ap_zzz', 'y', { store }).message).toMatch(/APPROVAL_NOT_FOUND/);
  });

  it('summaries include progress, pending approvals and the last milestone', () => {
    const m = store.create({ goal: 'summarize me', cwd: dir });
    store.replaceSteps(m.id, [
      { id: 's1', title: 'a', instruction: 'a', depends_on: [] },
      { id: 's2', title: 'b', instruction: 'b', depends_on: [] },
    ]);
    store.updateStep(m.id, 's1', { status: 'done' });
    store.createApproval({ id: 'ap_s', missionId: m.id, prompt: 'ok?', options: ['yes', 'no'], category: 'purchase' });
    store.appendEvent(m.id, 'milestone', { title: 'Halfway', progress: 50 });
    const s = summarizeMission(store, m.id)!;
    expect(s.steps).toMatchObject({ total: 2, done: 1, pending: 1 });
    expect(s.pendingApprovals[0]).toMatchObject({ id: 'ap_s', category: 'purchase', options: ['yes', 'no'] });
    expect(s.lastMilestone).toMatchObject({ title: 'Halfway', progress: 50 });
    expect(formatMissionLine(s)).toContain('awaiting approval');
    expect(listMissionSummaries({ store }).map(x => x.id)).toContain(m.id);
  });

  it('startMission validates cwd and spawns through the injected spawner', () => {
    setMissionWorkerSpawner(fakeSpawner);
    expect(() => startMission({ goal: 'g', cwd: path.join(dir, 'missing') }, { store })).toThrow(/MISSION_BAD_CWD/);
    const r = startMission({ goal: 'g', cwd: dir, source: 'test' }, { store, spawn: { entry: '/x/qodex.mjs', execArgv: [] } });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.args).toEqual(['/x/qodex.mjs', 'mission', 'run', r.mission.id]);
    expect(spawned[0]!.opts.detached).toBe(true);
    expect(spawned[0]!.opts.env.QODEX_MISSION_ID).toBe(r.mission.id);
    expect(r.mission.source).toBe('test');
    expect(r.logFile).toBe(missionLogPath(r.mission.id));
  });
});

describe('mission tools', () => {
  let dir: string;
  let store: MissionStore;
  let spawned: string[][];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-missions-tools-'));
    store = new MissionStore(path.join(dir, 'sessions.db'));
    setMissionStoreForTests(store);
    setMissionsDirForTests(path.join(dir, 'missions'));
    spawned = [];
    setMissionWorkerSpawner((_c, args) => { spawned.push(args); return { pid: process.pid, unref: () => {}, on: () => undefined }; });
  });
  afterEach(async () => {
    setMissionStoreForTests(null);
    setMissionsDirForTests(null);
    setMissionWorkerSpawner(null);
    setMissionInlineRunner(null);
    delete process.env.QODEX_MISSION_ID;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('every tool has an object schema and a valid name', () => {
    for (const T of MISSION_TOOL_CLASSES) {
      const t = new T();
      expect(t.name).toMatch(/^mission_[a-z_]+$/);
      expect(t.schema().function.parameters.type).toBe('object');
    }
    expect(new MissionStartTool().timeoutSeconds).toBe(0);
    expect(new MissionStatusTool().isReadOnly).toBe(true);
    expect(new MissionStartTool().isReadOnly).toBe(false);
    expect(new MissionCancelTool().isReadOnly).toBe(false);
    const start = new MissionStartTool().schema().function.parameters;
    expect(start.required).toEqual(['goal']);
    expect(start.properties.detach.description).toMatch(/detached/);
  });

  it('mission_start creates the mission and spawns a detached worker', async () => {
    const t = new MissionStartTool();
    const r = await t.execute(t.argsSchema.parse({ goal: 'Watch prices of X and report daily', cwd: '.' }), makeCtx(dir));
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('[MISSION_STARTED]');
    const id = String(r.metadata!.missionId);
    expect(store.get(id)!.source).toBe('tool');
    expect(store.get(id)!.approval_mode).toBe('ask');
    expect(spawned[0]!.slice(-3)).toEqual(['mission', 'run', id]);
    expect(r.content).toContain(`qodex mission attach ${id}`);

    const bad = await t.execute(t.argsSchema.parse({ goal: 'x', cwd: 'does/not/exist' }), makeCtx(dir));
    expect(bad.isError).toBe(true);
    expect(bad.content).toMatch(/MISSION_BAD_CWD/);
  });

  it('mission_start refuses to nest inside a mission and needs an inline runner for detach:false', async () => {
    const t = new MissionStartTool();
    process.env.QODEX_MISSION_ID = 'mparent';
    const nested = await t.execute(t.argsSchema.parse({ goal: 'x' }), makeCtx(dir));
    expect(nested.content).toMatch(/MISSION_NESTED/);
    delete process.env.QODEX_MISSION_ID;

    const noInline = await t.execute(t.argsSchema.parse({ goal: 'x', detach: false }), makeCtx(dir));
    expect(noInline.content).toMatch(/MISSION_INLINE_UNAVAILABLE/);

    let ranWith = '';
    setMissionInlineRunner(async (id) => {
      ranWith = id;
      store.setStatus(id, 'completed');
      return { missionId: id, status: 'completed', report: 'ok', stepsDone: 1, stepsFailed: 0, stepsSkipped: 0, costUsd: 0, error: null };
    });
    const inline = await t.execute(t.argsSchema.parse({ goal: 'inline goal', detach: false }), makeCtx(dir));
    expect(inline.isError).toBeFalsy();
    expect(inline.content).toContain('[MISSION_COMPLETED]');
    expect(store.get(ranWith)!.goal).toBe('inline goal');
    expect(spawned).toHaveLength(0);
  });

  it('mission_status / mission_list / mission_cancel', async () => {
    const status = new MissionStatusTool();
    const empty = await status.execute({}, makeCtx(dir));
    expect(empty.content).toMatch(/No missions yet/);

    const m = store.create({ goal: 'Research flights', cwd: dir });
    store.replaceSteps(m.id, [{ id: 's1', title: 'Search flights', instruction: 'i', depends_on: [] }]);
    store.setStatus(m.id, 'paused');
    const st = await status.execute({}, makeCtx(dir));
    expect(st.content).toContain(`Mission ${m.id}`);
    expect(st.content).toContain('Search flights');
    expect((await status.execute({ id: 'zzzz' }, makeCtx(dir))).content).toMatch(/MISSION_NOT_FOUND/);

    const list = await new MissionListTool().execute({ limit: 5 });
    expect(list.content).toContain(m.id);

    const cancel = new MissionCancelTool();
    const c = await cancel.execute({ id: m.id });
    expect(c.isError).toBeFalsy();
    expect(store.get(m.id)!.status).toBe('cancelled');
    expect((await cancel.execute({ id: m.id })).isError).toBe(true);
  });

  it('formats event lines', () => {
    const ts = new Date().toISOString();
    expect(formatEventLine({ ts, type: 'milestone', payload: { stepId: 's1', title: 'Logged in', progress: 40 } })).toMatch(/★ \[s1\] Logged in \(40%\)/);
    expect(formatEventLine({ ts, type: 'approval-requested', payload: { approvalId: 'ap_1', prompt: 'Buy?', options: ['yes', 'no'], category: 'purchase' } }))
      .toMatch(/approval needed ap_1 \[purchase\]: Buy\? \(yes \/ no\)/);
    expect(formatEventLine({ ts, type: 'weird', payload: { a: 1 } })).toContain('weird');
    expect(formatEventLine({ ts, type: 'completed', payload: { stepsDone: 2, stepsFailed: 0, costUsd: 0.5 } })).toMatch(/■ ✓ mission completed — 2 step\(s\) done · \$0\.5000/);
    expect(formatEventLine({ ts, type: 'status', payload: { from: 'planning', to: 'running' } })).toMatch(/status: planning → running/);
    expect(formatEventLine({ ts, type: 'approval', payload: { approvalId: 'ap_9', prompt: 'Run x', options: ['yes', 'no'] } })).toMatch(/approval needed ap_9/);
  });
});

describe('mission integration adapters', () => {
  let dir: string;
  let store: MissionStore;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-missions-adapt-'));
    store = new MissionStore(path.join(dir, 'sessions.db'));
    setMissionStoreForTests(store);
    setMissionsDirForTests(path.join(dir, 'missions'));
    setMissionWorkerSpawner(() => ({ pid: process.pid, unref: () => {}, on: () => undefined }));
    getBus().reset();
  });
  afterEach(async () => {
    setMissionStoreForTests(null);
    setMissionsDirForTests(null);
    setMissionWorkerSpawner(null);
    getBus().reset();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('control actions list/start/status/approve/steer/cancel', async () => {
    const actions = createMissionControlActions({ defaultCwd: dir });
    expect(Object.keys(actions)).toEqual(expect.arrayContaining([
      'missions.list', 'missions.status', 'missions.start', 'missions.cancel', 'missions.resume',
      'missions.approve', 'missions.deny', 'missions.steer', 'missions.approvals', 'missions.events',
    ]));
    const started = await actions['missions.start']!({ goal: 'from the dashboard' }) as any;
    expect(store.get(started.id)!.source).toBe('control');
    expect(store.get(started.id)!.cwd).toBe(dir);
    await expect(actions['missions.start']!({})).rejects.toThrow(/BAD_REQUEST/);
    const list = await actions['missions.list']!({}) as any[];
    expect(list[0].id).toBe(started.id);
    store.createApproval({ id: 'ap_c', missionId: started.id, prompt: 'go?', options: ['yes', 'no'] });
    const approvals = await actions['missions.approvals']!({}) as any[];
    expect(approvals[0]).toMatchObject({ id: 'ap_c', missionId: started.id, goal: 'from the dashboard' });
    const ans = await actions['missions.approve']!({ id: started.id }) as any;
    expect(ans.ok).toBe(true);
    store.setStatus(started.id, 'running');
    expect(((await actions['missions.steer']!({ id: started.id, note: 'hi' })) as any).ok).toBe(true);
    const status = await actions['missions.status']!({ id: started.id }) as any;
    expect(status.text).toContain('from the dashboard');
    expect(((await actions['missions.cancel']!({ id: started.id })) as any).ok).toBe(true);
  });

  it('channel adapter (Telegram) start/status/approvals/cancel', async () => {
    const ad = createMissionChannelAdapter({ defaultCwd: dir });
    const s = await ad.start('ثبت سفارش رو پیگیری کن');
    expect(store.get(s.id)!.source).toBe('telegram');
    expect(await ad.status(s.id)).toContain('ثبت سفارش');
    store.createApproval({ id: 'ap_t', missionId: s.id, prompt: 'pay?', options: ['yes', 'no'], category: 'payment' });
    expect((await ad.pendingApprovals())[0]).toMatchObject({ id: 'ap_t', category: 'payment' });
    expect(await ad.resolveApproval('ap_t', 'no', 'telegram')).toBe(true);
    expect(store.getApproval('ap_t')!.status).toBe('denied');
    expect((await ad.list()).length).toBe(1);
    expect((await ad.cancel(s.id)).ok).toBe(true);
  });

  it('event bridge republishes events written by other processes onto the local bus', async () => {
    const m = store.create({ goal: 'bridged', cwd: dir });
    store.update(m.id, { pid: DEAD_PID });
    const seen: BusEvent[] = [];
    getBus().subscribe(e => seen.push(e));
    const stop = startMissionEventBridge({ store, intervalMs: 100 });
    try {
      store.appendEvent(m.id, 'milestone', { title: 'from worker' });
      store.setStatus(m.id, 'completed');
      await waitFor(() => seen.some(e => e.kind === 'mission' && e.type === 'status' && (e.data as any).to === 'completed'));
      expect(seen.some(e => e.kind === 'mission' && e.type === 'milestone' && (e.data as any).title === 'from worker')).toBe(true);
    } finally {
      stop();
    }
  });
});
