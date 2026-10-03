/**
 * `qodex mission …` — start, watch, approve, steer, cancel and resume missions.
 *
 *   qodex mission start <goal...> [--cwd] [--model] [--foreground] [--yes] [--budget]
 *   qodex mission list | status <id> | attach <id> | logs <id> [-f]
 *   qodex mission approve <id> [approvalId] | deny <id> [approvalId]
 *   qodex mission steer <id> <note...> | cancel <id> | resume <id> | rm <id>
 *   qodex mission run <id>        (hidden: the detached worker's entry point)
 *
 * Only `run` and `--foreground` need the full QodeX bootstrap (models, tools,
 * MCP), which the caller passes in as `boot`; every other subcommand works on
 * the mission DB alone, so it is instant and safe to run from any terminal.
 * Heavy modules are imported lazily inside the actions.
 */
import { Command, Option } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import type { QodexConfig } from '../config/defaults.js';
import type { MissionsConfig } from '../config/agent-config.js';
import type { ModelRouter } from '../llm/router.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { PermissionEngine } from '../security/permissions.js';
import type { LocalAsker } from '../control/approvals.js';
import type { MissionStore, MissionRow } from './store.js';
import type { MissionDeps, MissionRunResult } from './runner.js';
import type { InlineMissionRunner } from './tools.js';

/** What a mission worker needs from QodeX's bootstrap. */
export interface MissionBoot {
  config: QodexConfig;
  router: ModelRouter;
  registry: ToolRegistry;
  permissions: PermissionEngine;
  mcpManager?: { stopAll(): Promise<void> } | null;
}
export type MissionBootFn = () => Promise<MissionBoot>;

/**
 * Config for one mission step's AgentLoop: per-step wall clock and iteration
 * caps from `missions`, no cumulative token cap (it kills long browser runs; the
 * cost guard remains). The USD cap is what is left of the mission's cost cap,
 * else the user's own per-task limit (budget.perTaskLimitUsd) so a mission
 * without a cap still can't spend unboundedly per step. 0 = unlimited.
 */
export function cloneConfigForMission(config: QodexConfig, m: MissionsConfig, stepMaxCostUsd?: number): QodexConfig {
  const perTaskLimitUsd = stepMaxCostUsd && stepMaxCostUsd > 0
    ? stepMaxCostUsd
    : (m.maxCostUsd > 0 ? m.maxCostUsd : (config.budget?.perTaskLimitUsd ?? 0));
  return {
    ...config,
    defaults: { ...config.defaults, maxIterations: m.stepMaxIterations },
    budget: {
      ...config.budget,
      perTaskMaxWallSeconds: m.stepMaxWallSeconds,
      perTaskMaxTokens: 0,
      perTaskLimitUsd,
    },
  };
}

/** A tool-less one-shot completion through the router (planning + report). */
export function makeRouterComplete(
  router: ModelRouter,
  opts: { model?: string; onUsage?: (u: { costUsd: number; tokensIn: number; tokensOut: number }) => void } = {},
): (prompt: string, signal?: AbortSignal) => Promise<string> {
  return async (prompt: string, signal?: AbortSignal) => {
    const { computeCost } = await import('../llm/router.js');
    const { extractThinking } = await import('../llm/thinking.js');
    const route = router.route('planning', Math.ceil(prompt.length / 4), opts.model ? { explicitModel: opts.model } : {});
    let text = '';
    let usage: { input: number; output: number } | undefined;
    for await (const ev of route.provider.complete({
      model: route.model,
      messages: [{ role: 'user', content: prompt }],
      tools: [],
      signal,
    })) {
      if (signal?.aborted) break;
      if (ev.type === 'text_delta') text += ev.delta ?? '';
      else if (ev.type === 'usage' && ev.usage) usage = ev.usage;
      else if (ev.type === 'error') throw new Error(ev.error ?? 'model error');
    }
    if (usage) {
      try { opts.onUsage?.({ costUsd: computeCost(usage, route.modelInfo), tokensIn: usage.input, tokensOut: usage.output }); } catch { /* accounting only */ }
    }
    return extractThinking(text).visibleText.trim();
  };
}

/** A terminal asker for foreground runs; it closes its prompt when answered elsewhere. */
export function makeTtyAsker(print: (line: string) => void): LocalAsker {
  return (prompt, options, signal) => new Promise<string>((resolve, reject) => {
    void import('readline').then(async ({ createInterface }) => {
      const { normalizeAnswer } = await import('../control/approvals.js');
      if (signal.aborted) { reject(new Error('answered elsewhere')); return; }
      const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        rl.close();
        fn();
      };
      const onAbort = () => finish(() => reject(new Error('answered elsewhere')));
      signal.addEventListener('abort', onAbort, { once: true });
      print(`\n⚠ Approval needed: ${prompt}\n  Type one of: ${options.join(' / ')} and press Enter (or answer remotely).`);
      rl.on('line', (line) => {
        const a = normalizeAnswer(line, options);
        if (a) finish(() => resolve(a));
        else print(`  Please type one of: ${options.join(' / ')}`);
      });
      rl.on('close', () => finish(() => reject(new Error('stdin closed'))));
    }).catch(reject);
  });
}

export interface MissionWorkerOptions {
  store?: MissionStore;
  /** Running in the user's terminal (`start --foreground`, `resume --foreground`). */
  foreground?: boolean;
  print?: (line: string) => void;
  /**
   * Integration hook after boot, e.g. start a control center in the worker and
   * return its URL (stored as the mission's live_url).
   */
  onStart?: (info: { missionId: string; store: MissionStore; boot: MissionBoot }) =>
    Promise<{ liveUrl?: string; dispose?: () => void | Promise<void> } | void>;
  /** Test seams: replace the real AgentLoop / LLM / session rows / notifications. */
  createAgent?: MissionDeps['createAgent'];
  complete?: MissionDeps['complete'];
  sessions?: MissionDeps['sessions'];
  notify?: MissionDeps['notify'];
  /** Default true. Tests pass false to keep process listeners untouched. */
  installSignalHandlers?: boolean;
  pollIntervalMs?: number;
  /** A human sits at this terminal (default: foreground run with a TTY stdin). */
  interactive?: boolean;
  /** The terminal prompt used when `interactive` (default: a readline prompt on stdin). */
  localAsker?: LocalAsker;
}

/**
 * Body of `qodex mission run <id>` (also used by --foreground): boot QodeX, wire
 * sub-agents + approvals, run the mission to a final state. Returns an exit code
 * (0 completed/paused/cancelled, 1 failed, 2 not found, 3 already running).
 */
export async function runMissionWorker(id: string, boot: MissionBootFn, opts: MissionWorkerOptions = {}): Promise<number> {
  const print = opts.print ?? ((l: string) => console.log(l));
  const { getMissionStore } = await import('./store.js');
  const store = opts.store ?? getMissionStore();
  const m0 = store.resolve(id);
  if (!m0) { print(`[MISSION_NOT_FOUND] No mission matches "${id}".`); return 2; }
  const missionId = m0.id;
  if (m0.status === 'completed' || (m0.status === 'cancelled' && m0.cancel_requested)) {
    print(`Mission ${missionId} is already ${m0.status}.`);
    return 0;
  }
  // Another live process owns it (e.g. a second worker spawned by a duplicate resume).
  // The claim is atomic, so two workers racing here can't both win.
  if (!store.claimWorker(missionId, process.pid)) {
    print(`[MISSION_BUSY] Mission ${missionId} is already being run by pid ${store.get(missionId)?.pid}.`);
    return 3;
  }

  const { installWorkerSignalHandlers } = await import('./daemon.js');
  const ac = new AbortController();
  const disposeSignals = opts.installSignalHandlers === false ? () => {} : installWorkerSignalHandlers(store, missionId, ac);

  let b: MissionBoot;
  try {
    b = await boot();
  } catch (e: any) {
    store.setStatus(missionId, 'failed', { error: `[MISSION_BOOT_FAILED] ${e?.message ?? e}` });
    store.releaseWorker(missionId, process.pid);
    print(`[MISSION_BOOT_FAILED] ${e?.message ?? e}`);
    disposeSignals();
    return 1;
  }

  const [{ resolveMissionsConfig }, loopMod, taskMod, approvals, runnerMod, toolsMod, perms] = await Promise.all([
    import('../config/agent-config.js'),
    import('../agent/loop.js'),
    import('../tools/builtin/task.js'),
    import('../control/approvals.js'),
    import('./runner.js'),
    import('./tools.js'),
    import('../security/permissions.js'),
  ]);
  const missionsCfg = resolveMissionsConfig(b.config);
  const cwd = store.get(missionId)!.cwd;
  const newAgent = (maxCostUsd?: number) => new loopMod.AgentLoop({
    router: b.router, registry: b.registry, permissions: b.permissions,
    config: cloneConfigForMission(b.config, missionsCfg, maxCostUsd), cwd,
  });

  // Sub-agents (task / fanout / gather / browser_agent) need a registered runner.
  const host = newAgent();
  taskMod.setSubAgentRunner((p, o) => host.runSubagent(p, o));
  loopMod.setActiveAgent(host);
  const approvalMode = store.get(missionId)?.approval_mode === 'auto' ? 'auto' : 'ask';
  // The worker's own permission engine and Sentinel apply the mission's mode: 'auto' is
  // the session's autonomous policy (ordinary steps run without asking; destructive
  // actions outside the project, remote deletes and critical actions still reach a
  // human through the mission queue / control center / Telegram), 'ask' asks for all.
  const prevApprovalMode = perms.getApprovalMode();
  perms.setApprovalMode(approvalMode === 'auto' ? 'auto' : 'manual');
  const tty = opts.interactive ?? (!!opts.foreground && !!process.stdin.isTTY);
  const terminal: LocalAsker | undefined = tty ? (opts.localAsker ?? makeTtyAsker(print)) : undefined;
  // Sentinel sends CRITICAL actions (purchases, payments, sending, credentials)
  // through ctx.askUser only when a human sits at this process's askUser. With
  // `--yes` ('auto') the worker runs unattended under the autonomous policy, so it
  // must NOT count as a human: critical actions and auto mode's remaining asks go to
  // the broker, where the terminal is just another approval channel next to the
  // mission queue (and the control center / Telegram).
  const humanAtAskUser = !!terminal && approvalMode !== 'auto';
  approvals.setInteractiveHuman(humanAtAskUser);
  const local = humanAtAskUser ? terminal : undefined;
  const unregisterTerminal = terminal && !humanAtAskUser
    ? approvals.getApprovalBroker().registerChannel(new runnerMod.TerminalApprovalChannel(terminal, missionId))
    : () => {};

  let hookDispose: (() => void | Promise<void>) | undefined;
  if (opts.onStart) {
    try {
      const r = await opts.onStart({ missionId, store, boot: b });
      if (r?.liveUrl) store.update(missionId, { live_url: r.liveUrl });
      hookDispose = r?.dispose;
    } catch (e: any) {
      print(`(mission start hook failed: ${e?.message ?? e})`);
    }
  }

  const m = store.get(missionId)!;
  print(`QodeX mission ${missionId} — worker pid ${process.pid}`);
  print(`Goal: ${m.goal}`);
  print(`Dir:  ${m.cwd}${m.model ? `   Model: ${m.model}` : ''}   Approvals: ${m.approval_mode}`);
  // The log is readable by the mission's own agents: never print the live view's token there.
  if (store.get(missionId)?.live_url) {
    print(`Live: ${toolsMod.redactLiveUrl(store.get(missionId)!.live_url)}  (open it with: qodex mission status ${missionId})`);
  }

  const stepAgents = new Map<string, InstanceType<typeof loopMod.AgentLoop>>();
  let result: MissionRunResult | null = null;
  let busy = false;
  try {
    result = await runnerMod.runMission(missionId, {
      store,
      createAgent: opts.createAgent ?? ((o) => newAgent(o?.maxCostUsd)),
      complete: opts.complete ?? makeRouterComplete(b.router, {
        model: m.model ?? undefined,
        onUsage: (u) => store.addUsage(missionId, u),
      }),
      askUserFactory: (stepId, signal) => runnerMod.missionAskUser(missionId, stepId, {
        approvalMode: store.get(missionId)?.approval_mode,
        signal,
        local,
      }),
      humanApproval: local
        ? async (req, signal) => (await approvals.getApprovalBroker().request({
            prompt: req.prompt, options: req.options, category: req.category, risk: req.risk,
            source: `mission:${missionId}`, meta: { missionId, kind: req.category }, signal,
          }, local)).answer
        : undefined,
      onEvent: (ev) => {
        const line = toolsMod.formatEventLine({ ts: new Date(ev.ts).toISOString(), type: ev.type, payload: ev.data });
        if (line) print(line);
      },
      onAgent: (stepId, agent) => {
        // /steer from a control center in this process reaches the newest running step.
        if (agent) stepAgents.set(stepId, agent as InstanceType<typeof loopMod.AgentLoop>);
        else stepAgents.delete(stepId);
        loopMod.setActiveAgent([...stepAgents.values()].pop() ?? host);
      },
      signal: ac.signal,
      defaultModel: b.config.defaults.model,
      approvalChannel: 'exclusive',
      pollIntervalMs: opts.pollIntervalMs,
      sessions: opts.sessions,
      notify: opts.notify,
    });
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    busy = /^\[MISSION_BUSY\]/.test(msg);
    print(busy ? msg : `[MISSION_ERROR] ${msg}`);
    // Lost the mission to another worker: it is not ours to fail.
    if (!busy) {
      try { store.setStatus(missionId, 'failed', { error: `[MISSION_ERROR] ${msg}` }); } catch { /* ignore */ }
      try { store.releaseWorker(missionId, process.pid); } catch { /* ignore */ }
    }
  } finally {
    disposeSignals();
    unregisterTerminal();
    taskMod.setSubAgentRunner(null);
    loopMod.setActiveAgent(null);
    approvals.setInteractiveHuman(false);
    perms.setApprovalMode(prevApprovalMode);
    if (hookDispose) { try { await hookDispose(); } catch { /* ignore */ } }
    try { await b.mcpManager?.stopAll(); } catch { /* ignore */ }
  }

  if (busy) return 3;
  const final = store.get(missionId);
  print('');
  print(`Mission ${missionId} finished: ${final?.status ?? result?.status ?? 'unknown'}${final?.error ? ` — ${final.error}` : ''}`);
  if (final?.report) print(`\n${final.report}`);
  const status = final?.status ?? result?.status;
  return status === 'failed' ? 1 : 0;
}

/**
 * An InlineMissionRunner for `mission_start {detach:false}` inside an
 * interactive/headless process (register it with setMissionInlineRunner). Steps
 * ask the caller's own askUser (the user is right there).
 */
export function createInlineMissionRunner(b: MissionBoot, opts: { store?: MissionStore } = {}): InlineMissionRunner {
  return async (missionId, o) => {
    const [{ resolveMissionsConfig }, { AgentLoop }, { getMissionStore }, runnerMod, toolsMod] = await Promise.all([
      import('../config/agent-config.js'),
      import('../agent/loop.js'),
      import('./store.js'),
      import('./runner.js'),
      import('./tools.js'),
    ]);
    const store = opts.store ?? getMissionStore();
    const m = store.get(missionId);
    if (!m) throw new Error(`[MISSION_NOT_FOUND] No mission ${missionId}.`);
    const missionsCfg = resolveMissionsConfig(b.config);
    const quiet = new Set(['tool', 'notice', 'steer-injected', 'approval-resolved']);
    return runnerMod.runMission(missionId, {
      store,
      createAgent: (x) => new AgentLoop({
        router: b.router, registry: b.registry, permissions: b.permissions,
        config: cloneConfigForMission(b.config, missionsCfg, x?.maxCostUsd), cwd: m.cwd,
      }),
      complete: makeRouterComplete(b.router, { model: m.model ?? undefined, onUsage: (u) => store.addUsage(missionId, u) }),
      askUserFactory: (stepId, signal) => o.askUser ?? runnerMod.missionAskUser(missionId, stepId, { signal }),
      humanApproval: o.askUser ? (req) => o.askUser!(req.prompt, req.options) : undefined,
      onEvent: (ev) => {
        if (!o.onProgress || quiet.has(ev.type)) return;
        const line = toolsMod.formatEventLine({ ts: new Date(ev.ts).toISOString(), type: ev.type, payload: ev.data });
        if (line) o.onProgress(line);
      },
      signal: o.signal,
      defaultModel: b.config.defaults.model,
      approvalChannel: 'tagged',
    });
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

async function loadActiveConfig(cwd: string): Promise<void> {
  try {
    const { loadConfig, setActiveConfig, getActiveConfig } = await import('../config/loader.js');
    if (!getActiveConfig()) setActiveConfig(await loadConfig(cwd));
  } catch { /* defaults apply */ }
}

/**
 * True when this CLI runs inside a mission worker's process tree — i.e. a step's
 * agent ran `qodex mission …` through its shell tool (the worker's env, including
 * QODEX_MISSION_ID, is inherited). Approvals must come from a human, never from the
 * agent that asked for them.
 */
function insideMission(): boolean {
  return !!process.env.QODEX_MISSION_ID?.trim();
}

/**
 * A subcommand's options merged with the root program's. `qodex` itself declares
 * `--json`, `-y/--yes` and `-m/--model` globally, and commander lets the root
 * consume those even when they FOLLOW `mission start …` — without this,
 * `qodex mission start --yes --model x --json` silently ran in 'ask' mode on the
 * default model, and scheduled mission routines (`mission start --yes …`) lost
 * their flags too.
 */
/**
 * The mission approval mode the CLI flags ask for: `--yes` / `--auto` / `--approval-mode auto`
 * → 'auto' (the autonomous policy), `--approval-mode manual|edits` → 'ask', nothing →
 * undefined (startMission then inherits this process's session mode). Throws on a bad mode.
 */
export function missionApprovalFromFlags(o: Record<string, any>): 'auto' | 'ask' | undefined {
  if (o.yes || o.auto) return 'auto';
  const raw = typeof o.approvalMode === 'string' ? o.approvalMode.trim().toLowerCase() : '';
  if (!raw) return undefined;
  if (raw === 'auto' || raw === 'autonomous') return 'auto';
  if (raw === 'manual' || raw === 'edits' || raw === 'ask') return 'ask';
  throw new Error(`[MISSION_INVALID] --approval-mode must be manual, edits or auto (got "${o.approvalMode}").`);
}

function flags(cmd: Command): Record<string, any> {
  const own = cmd.opts();
  const merged: Record<string, any> = { ...own };
  for (const [k, v] of Object.entries(cmd.optsWithGlobals())) if (merged[k] === undefined) merged[k] = v;
  return merged;
}

function fail(message: string): void {
  console.error(message);
  process.exitCode = 1;
}

function parseUsd(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

async function resolveOrFail(id: string): Promise<{ store: MissionStore; m: MissionRow } | null> {
  const { getMissionStore } = await import('./store.js');
  const store = getMissionStore();
  const m = store.resolve(id);
  if (!m) { fail(`[MISSION_NOT_FOUND] No mission matches "${id}". See: qodex mission list`); return null; }
  return { store, m };
}

function printStartHints(id: string, pid: number | null, logFile: string | null): void {
  console.log(`✓ Mission ${id} started in the background${pid ? ` (worker pid ${pid})` : ''}.`);
  console.log(`  Watch:    qodex mission attach ${id}`);
  console.log(`  Status:   qodex mission status ${id}`);
  if (logFile) console.log(`  Log:      ${logFile}`);
  console.log(`  Approve:  qodex mission approve ${id}   (when it asks)`);
  console.log(`  Stop:     qodex mission cancel ${id}`);
}

export function buildMissionCommand(
  boot: MissionBootFn,
  /** Integration hooks applied to every worker run (e.g. a live control center). */
  workerHooks: Pick<MissionWorkerOptions, 'onStart'> = {},
): Command {
  const mission = new Command('mission')
    .description('Long-running background missions: start, watch, approve, steer, cancel, resume');

  mission
    .command('start <goal...>')
    .description('Start a mission. It plans its own steps and keeps running in a detached worker after you close the terminal.')
    .option('--cwd <dir>', 'Working directory for the mission (default: current directory)')
    .option('--model <id>', 'Model to use (default: the configured default)')
    .option('--foreground', 'Run in this terminal instead of a detached background worker')
    .option('-y, --yes', 'Run in auto mode: ordinary steps run without asking; purchases, payments, passwords, sending messages, destructive actions outside the project and the cost cap still need a human')
    .option('--auto', 'Same as --yes')
    .option('--approval-mode <mode>', 'manual | edits | auto (default: this session\'s approval mode)')
    .option('--budget <usd>', 'Cost cap in USD before the mission pauses for approval (default: missions.maxCostUsd)')
    .option('--json', 'Print the result as JSON')
    .addOption(new Option('--from-schedule <id>', 'Started by a scheduled routine').hideHelp())
    .action(async (goalParts: string[], _o: any, cmd: Command) => {
      const o = flags(cmd);
      const goal = (goalParts ?? []).join(' ').trim();
      if (!goal) { fail('[MISSION_INVALID] Give the mission a goal: qodex mission start "<goal>"'); return; }
      const cwd = path.resolve(o.cwd ?? process.cwd());
      let approvalMode: 'auto' | 'ask' | undefined;
      try { approvalMode = missionApprovalFromFlags(o); } catch (e: any) { fail(e.message); return; }
      await loadActiveConfig(cwd);
      const { startMission } = await import('./daemon.js');
      const input = {
        goal, cwd, model: o.model ?? null,
        approvalMode,
        costCapUsd: parseUsd(o.budget),
        source: o.fromSchedule ? `schedule:${o.fromSchedule}` : 'cli',
      };
      try {
        if (o.foreground) {
          const { mission: m } = startMission({ ...input, spawn: false });
          if (cwd !== process.cwd()) process.chdir(cwd);
          const code = await runMissionWorker(m.id, boot, { ...workerHooks, foreground: true });
          process.exit(code);
        }
        const r = startMission(input);
        if (o.json) console.log(JSON.stringify({ id: r.mission.id, pid: r.pid, logFile: r.logFile, status: r.mission.status }));
        else printStartHints(r.mission.id, r.pid, r.logFile);
      } catch (e: any) {
        fail(String(e?.message ?? e));
      }
    });

  mission
    .command('list')
    .description('List recent missions')
    .option('-n, --limit <n>', 'How many to show', '20')
    .option('--active', 'Only missions that are running or waiting for approval')
    .option('--json', 'Print as JSON')
    .action(async (_o: any, cmd: Command) => {
      const o = flags(cmd);
      const { listMissionSummaries } = await import('./daemon.js');
      const { formatMissionLine } = await import('./tools.js');
      const list = listMissionSummaries({ limit: parseInt(o.limit, 10) || 20, activeOnly: !!o.active });
      if (o.json) { console.log(JSON.stringify(list, null, 2)); return; }
      if (!list.length) { console.log('No missions yet. Start one with: qodex mission start "<goal>"'); return; }
      const now = Date.now();
      console.log(`${'ID'.padEnd(9)}  ${'STATUS'.padEnd(17)}  ${'STEPS'.padStart(5)}  ${'COST'.padStart(7)}  ${'CREATED'.padStart(8)}  GOAL`);
      for (const s of list) console.log(formatMissionLine(s, now));
    });

  mission
    .command('status <id>')
    .description('Show a mission: steps, milestones, pending approvals, cost and report')
    .option('--json', 'Print as JSON')
    .action(async (id: string, _o: any, cmd: Command) => {
      const o = flags(cmd);
      const r = await resolveOrFail(id);
      if (!r) return;
      const { summarizeMission } = await import('./daemon.js');
      const { formatMissionStatus } = await import('./tools.js');
      const s = summarizeMission(r.store, r.m);
      if (!s) { fail(`[MISSION_NOT_FOUND] ${id}`); return; }
      // From inside a mission (an agent's shell) the live view's token stays hidden.
      const reveal = !insideMission();
      const { redactLiveUrl } = await import('./tools.js');
      const view = reveal ? s : { ...s, liveUrl: s.liveUrl ? redactLiveUrl(s.liveUrl) : null };
      if (o.json) console.log(JSON.stringify({ ...view, report: r.store.get(s.id)?.report ?? null, steps_detail: r.store.steps(s.id) }, null, 2));
      else console.log(formatMissionStatus(r.store, view, { revealLiveUrl: reveal }));
    });

  mission
    .command('attach <id>')
    .description('Follow a mission live (Ctrl+C detaches; the mission keeps running). Type to answer approvals or steer.')
    .option('--quiet', 'Hide per-tool lines')
    .option('--history <n>', 'How many past events to show first', '30')
    .action(async (id: string, o: any) => {
      const r = await resolveOrFail(id);
      if (!r) return;
      await attachToMission(r.store, r.m.id, { quiet: !!o.quiet, history: parseInt(o.history, 10) || 30 });
    });

  mission
    .command('logs <id>')
    .description("Print a mission worker's log")
    .option('-f, --follow', 'Keep printing new output until the mission stops')
    .option('-n, --lines <n>', 'Show the last N lines', '200')
    .action(async (id: string, o: any) => {
      const r = await resolveOrFail(id);
      if (!r) return;
      const { missionLogPath } = await import('./daemon.js');
      const file = r.m.log_file ?? missionLogPath(r.m.id);
      await printLog(r.store, r.m.id, file, { follow: !!o.follow, lines: parseInt(o.lines, 10) || 200 });
    });

  const answer = (verb: 'approve' | 'deny') => async (id: string, approvalId: string | undefined, o: any) => {
    if (verb === 'approve' && insideMission()) {
      fail(`[MISSION_APPROVAL_FORBIDDEN] Mission approvals must come from a human (qodex mission approve in your own terminal, the control center or Telegram) — not from inside mission ${process.env.QODEX_MISSION_ID}.`);
      return;
    }
    const { answerMissionApproval } = await import('./daemon.js');
    let ans = verb === 'deny' ? 'no' : (o.answer ?? (o.always ? 'always' : 'yes'));
    let res = answerMissionApproval(id, approvalId, ans, { by: 'cli' });
    if (!res.ok && verb === 'approve' && o.always && /BAD_ANSWER/.test(res.message)) {
      ans = 'yes';
      res = answerMissionApproval(id, approvalId, ans, { by: 'cli' });
    }
    if (res.ok) { console.log(res.message); return; }
    fail(res.message);
    for (const p of res.pending ?? []) {
      console.error(`  ${p.id}${p.category ? ` [${p.category}]` : ''}: ${p.prompt.replace(/\s+/g, ' ').slice(0, 160)}`);
    }
  };

  mission
    .command('approve <id> [approvalId]')
    .description('Approve a pending mission request (the only one, or the given approval id)')
    .option('--always', 'Answer "always" when the request offers it (remember for this mission)')
    .option('--answer <option>', 'Answer with a specific option instead of "yes"')
    .action(answer('approve'));

  mission
    .command('deny <id> [approvalId]')
    .description('Deny a pending mission request')
    .action(answer('deny'));

  mission
    .command('steer <id> <note...>')
    .description('Send a steering note to the running mission (picked up within a second)')
    .action(async (id: string, note: string[]) => {
      // A steering note reaches the mission's agents with the USER's authority.
      if (insideMission()) {
        fail(`[MISSION_STEER_FORBIDDEN] Steering notes must come from a human, not from inside mission ${process.env.QODEX_MISSION_ID}.`);
        return;
      }
      const { steerMission } = await import('./daemon.js');
      const res = steerMission(id, (note ?? []).join(' '), { by: 'cli' });
      if (res.ok) console.log(res.message); else fail(res.message);
    });

  mission
    .command('cancel <id>')
    .description('Cancel a mission (finished steps keep their results)')
    .action(async (id: string) => {
      const { cancelMission } = await import('./daemon.js');
      const res = cancelMission(id, { by: 'cli' });
      if (res.ok) console.log(res.message); else fail(res.message);
    });

  mission
    .command('resume <id>')
    .description('Resume a paused/failed/interrupted mission (failed steps are retried)')
    .option('--foreground', 'Run in this terminal instead of a detached worker')
    .option('-y, --yes', 'Switch the mission to auto mode (critical and outside-project destructive actions still ask)')
    .option('--auto', 'Same as --yes')
    .option('--approval-mode <mode>', 'Switch the mission to manual | edits | auto')
    .option('--budget <usd>', 'New cost cap in USD')
    .action(async (id: string, _o: any, cmd: Command) => {
      const o = flags(cmd);
      let approvalMode: 'auto' | 'ask' | undefined;
      try { approvalMode = missionApprovalFromFlags(o); } catch (e: any) { fail(e.message); return; }
      const r = await resolveOrFail(id);
      if (!r) return;
      await loadActiveConfig(r.m.cwd);
      const { prepareResume, spawnMissionWorker } = await import('./daemon.js');
      const prep = prepareResume(r.m.id, { approvalMode, costCapUsd: parseUsd(o.budget) });
      if (!prep.ok) { fail(prep.message); return; }
      console.log(prep.message);
      try {
        if (o.foreground) {
          if (r.m.cwd !== process.cwd()) process.chdir(r.m.cwd);
          const code = await runMissionWorker(r.m.id, boot, { ...workerHooks, foreground: true });
          process.exit(code);
        }
        const { pid, logFile } = spawnMissionWorker(r.m.id, { cwd: r.m.cwd });
        printStartHints(r.m.id, pid, logFile);
      } catch (e: any) {
        fail(String(e?.message ?? e));
      }
    });

  mission
    .command('rm <id>')
    .description('Delete a mission that is not running (and its log)')
    .action(async (id: string) => {
      const r = await resolveOrFail(id);
      if (!r) return;
      const { isActiveStatus, isWorkerAlive } = await import('./store.js');
      const m = r.store.reconcile(r.m.id) ?? r.m;
      if (isActiveStatus(m.status) && isWorkerAlive(m)) { fail(`Mission ${m.id} is running — cancel it first: qodex mission cancel ${m.id}`); return; }
      r.store.remove(m.id);
      if (m.log_file) { try { fs.unlinkSync(m.log_file); } catch { /* already gone */ } }
      console.log(`✓ Removed mission ${m.id}.`);
    });

  mission
    .command('run <id>', { hidden: true })
    .description('Run a mission in this process (entry point of the detached worker)')
    .action(async (id: string) => {
      const code = await runMissionWorker(id, boot, workerHooks);
      process.exit(code);
    });

  return mission;
}

// ── attach / logs ─────────────────────────────────────────────────────────────

/** Follow a mission's events until it stops (or the user detaches with Ctrl+C). */
export async function attachToMission(
  store: MissionStore,
  missionId: string,
  opts: { quiet?: boolean; history?: number; intervalMs?: number; print?: (l: string) => void; interactive?: boolean } = {},
): Promise<void> {
  const print = opts.print ?? ((l: string) => console.log(l));
  const { formatEventLine } = await import('./tools.js');
  const { isActiveStatus } = await import('./store.js');
  const { answerApprovalById, steerMission } = await import('./daemon.js');
  const show = (ev: { ts: string; type: string; payload: any }) => {
    if (opts.quiet && ev.type === 'tool') return;
    const line = formatEventLine(ev);
    if (line) print(line);
  };
  const history = store.recentEvents(missionId, Math.max(1, opts.history ?? 30));
  for (const ev of history) show(ev);
  let last = history.length ? history[history.length - 1]!.id : store.lastEventId(missionId);

  const interactive = opts.interactive ?? !!process.stdin.isTTY;
  print(`— attached to mission ${missionId}. Ctrl+C detaches (the mission keeps running).` +
    (interactive ? ' Type an answer when an approval is pending, or type a note to steer the mission.' : ''));

  let rl: import('readline').Interface | null = null;
  if (interactive) {
    const { createInterface } = await import('readline');
    rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    rl.on('line', (line) => {
      const text = line.trim();
      if (!text) return;
      const pending = store.listPendingApprovals(missionId);
      if (pending.length && insideMission()) {
        print('  [MISSION_APPROVAL_FORBIDDEN] approvals must come from a human, not from inside a mission');
      } else if (pending.length) {
        const res = answerApprovalById(pending[0]!.id, text, { store, by: 'attach' });
        print(res.ok ? res.message : `  ${res.message}`);
      } else {
        const res = steerMission(missionId, text, { store, by: 'attach' });
        print(res.ok ? '  ➜ steering note sent' : `  ${res.message}`);
      }
    });
  }

  await new Promise<void>((resolve) => {
    const tick = () => {
      try {
        for (const ev of store.events(missionId, last, { limit: 500 })) { last = ev.id; show(ev); }
        const m = store.reconcile(missionId);
        if (!m || !isActiveStatus(m.status)) {
          for (const ev of store.events(missionId, last, { limit: 500 })) { last = ev.id; show(ev); }
          print(`— mission ${missionId} is ${m?.status ?? 'gone'}${m?.error ? `: ${m.error}` : ''}`);
          if (m?.report && (m.status === 'completed' || m.status === 'failed')) print(`\n${m.report}`);
          clearInterval(timer);
          resolve();
        }
      } catch (e: any) {
        print(`(attach error: ${e?.message ?? e})`);
      }
    };
    const timer = setInterval(tick, Math.max(50, opts.intervalMs ?? 1000));
    tick();
  });
  rl?.close();
}

async function printLog(store: MissionStore, missionId: string, file: string, opts: { follow: boolean; lines: number }): Promise<void> {
  const { isActiveStatus } = await import('./store.js');
  let pos = 0;
  /** New bytes of the log since `from` — size and data come from ONE open descriptor. */
  const readFrom = (from: number): Buffer | null => {
    let fd: number;
    try { fd = fs.openSync(file, 'r'); } catch { return null; }
    try {
      const size = fs.fstatSync(fd).size;
      if (size <= from) return Buffer.alloc(0);
      const buf = Buffer.alloc(size - from);
      const n = fs.readSync(fd, buf, 0, buf.length, from);
      return buf.subarray(0, n);
    } finally { fs.closeSync(fd); }
  };
  const initial = readFrom(0);
  if (initial) {
    const lines = initial.toString('utf8').split('\n');
    process.stdout.write(lines.slice(-opts.lines - 1).join('\n'));
    pos = initial.length;
  } else {
    console.log(`(no log yet at ${file})`);
    if (!opts.follow) return;
  }
  if (!opts.follow) { process.stdout.write('\n'); return; }
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      try {
        const buf = readFrom(pos);
        if (buf && buf.length) {
          pos += buf.length;
          process.stdout.write(buf.toString('utf8'));
        }
        const m = store.reconcile(missionId);
        if (!m || !isActiveStatus(m.status)) { clearInterval(timer); process.stdout.write('\n'); resolve(); }
      } catch { /* keep following */ }
    }, 500);
  });
}
