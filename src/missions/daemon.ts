/**
 * Mission daemon — detached worker processes and the cross-process control API.
 *
 * A mission runs in its own detached process (`qodex mission run <id>`), so it
 * keeps working after the terminal, the TUI or the app that started it closes.
 * Its stdout/stderr go to ~/.qodex/missions/<id>.log; its state lives in the DB.
 * Every other process (CLI, TUI, control center, Telegram, schedule tick) talks
 * to it only through MissionStore rows:
 *
 *   start   → create row + spawn the worker (pid stored)
 *   cancel  → cancel_requested=1, then SIGTERM; the worker's SIGTERM handler
 *             marks the status synchronously and aborts its run
 *   approve → resolve a mission_approvals row; the worker's poller picks it up
 *   steer   → append a 'steer' event; the worker pushes it into running agents
 *   resume  → reset failed/running steps, spawn a fresh worker
 *
 * Nothing here installs SIGINT listeners (that would disable Ctrl+C).
 */
import { spawn as nodeSpawn, type SpawnOptions } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { QODEX_MISSIONS_DIR } from '../config/paths.js';
import { resolveMissionsConfig } from '../config/agent-config.js';
import { getActiveConfig } from '../config/loader.js';
import { logger } from '../utils/logger.js';
import {
  getMissionStore, isProcessAlive, isActiveStatus, isTerminalStatus, approvalOptions,
  type MissionStore, type MissionRow, type ApprovalMode, type MissionApprovalRow, type ApprovalStatus,
} from './store.js';

let missionsDirOverride: string | null = null;
/** Put worker logs somewhere else (tests), or restore ~/.qodex/missions with null. */
export function setMissionsDirForTests(dir: string | null): void {
  missionsDirOverride = dir;
}

/** Log file of a mission's worker. */
export function missionLogPath(id: string, dir: string = missionsDirOverride ?? QODEX_MISSIONS_DIR): string {
  return path.join(dir, `${id.replace(/[^A-Za-z0-9_-]/g, '_')}.log`);
}

// ── spawning ──────────────────────────────────────────────────────────────────

export interface ChildLike {
  pid?: number;
  unref(): void;
  on(event: 'error', cb: (e: Error) => void): unknown;
}
export type WorkerSpawner = (command: string, args: string[], opts: SpawnOptions) => ChildLike;

let spawner: WorkerSpawner | null = null;
/** Replace child_process.spawn for worker processes (tests), or restore with null. */
export function setMissionWorkerSpawner(fn: WorkerSpawner | null): void {
  spawner = fn;
}

/**
 * The command line of a worker: `<node> [execArgv] <cli entry> mission run <id>`.
 * Loader flags in execArgv (e.g. `--import tsx`) are kept so dev runs work;
 * debugger flags are dropped so a worker never fights for the inspector port.
 */
export function resolveWorkerCommand(
  id: string,
  opts: { entry?: string; execPath?: string; execArgv?: string[] } = {},
): { command: string; args: string[] } {
  const entry = opts.entry || process.env.QODEX_MISSION_WORKER_ENTRY || process.argv[1];
  if (!entry) {
    throw new Error('[MISSION_SPAWN_FAILED] Cannot locate the qodex CLI entry (process.argv[1] is empty). Set QODEX_MISSION_WORKER_ENTRY to the path of bin/qodex.mjs.');
  }
  const execArgv = (opts.execArgv ?? process.execArgv).filter(a => !/^--(inspect|debug)/.test(a));
  return { command: opts.execPath ?? process.execPath, args: [...execArgv, entry, 'mission', 'run', id] };
}

export interface SpawnWorkerOptions {
  cwd: string;
  logFile?: string;
  store?: MissionStore;
  /** CLI entry script (default: QODEX_MISSION_WORKER_ENTRY or process.argv[1]). */
  entry?: string;
  execPath?: string;
  execArgv?: string[];
  env?: NodeJS.ProcessEnv;
}

/**
 * Start the detached worker for a mission. Returns once the process exists; the
 * worker then boots QodeX and calls runMission. Throws [MISSION_SPAWN_FAILED].
 */
export function spawnMissionWorker(id: string, opts: SpawnWorkerOptions): { pid: number; logFile: string } {
  const store = opts.store ?? getMissionStore();
  const logFile = opts.logFile ?? missionLogPath(id);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const { command, args } = resolveWorkerCommand(id, opts);
  const fd = fs.openSync(logFile, 'a');
  try {
    fs.writeSync(fd, `\n# ${new Date().toISOString()} starting mission worker ${id}\n# cwd: ${opts.cwd}\n`);
    const child = (spawner ?? (nodeSpawn as unknown as WorkerSpawner))(command, args, {
      cwd: opts.cwd,
      detached: true,
      stdio: ['ignore', fd, fd],
      env: { ...process.env, ...(opts.env ?? {}), QODEX_MISSION_ID: id },
      windowsHide: true,
    });
    // Attach before anything can throw: an async 'error' with no listener would crash us.
    child.on('error', (e: Error) => {
      logger.warn('mission worker spawn error', { id, err: e?.message });
      try {
        const m = store.get(id);
        if (m && isActiveStatus(m.status) && (!m.pid || m.pid === child.pid)) {
          store.setStatus(id, 'failed', { error: `[MISSION_SPAWN_FAILED] ${e?.message ?? e}` });
        }
      } catch { /* ignore */ }
    });
    if (!child.pid) {
      store.setStatus(id, 'failed', { error: `[MISSION_SPAWN_FAILED] could not start ${command}` });
      throw new Error(`[MISSION_SPAWN_FAILED] Could not start the mission worker (${command}).`);
    }
    child.unref();
    store.update(id, { pid: child.pid, log_file: logFile });
    store.appendEvent(id, 'worker-spawned', { pid: child.pid, logFile });
    return { pid: child.pid, logFile };
  } finally {
    try { fs.closeSync(fd); } catch { /* the child holds its own copy */ }
  }
}

// ── worker-side lifecycle ─────────────────────────────────────────────────────

/**
 * SIGTERM in a worker: record the outcome SYNCHRONOUSLY (the process may exit
 * right after — bootstrap's own shutdown handler calls process.exit). A
 * requested cancel → 'cancelled'; anything else (logout, reboot) → 'paused' so
 * it can be resumed. Running steps return to pending.
 */
export function handleWorkerTermination(store: MissionStore, id: string, reason = 'SIGTERM'): MissionRow | undefined {
  const m = store.get(id);
  if (!m || !isActiveStatus(m.status)) return m;
  store.resetRunningSteps(id);
  store.expirePendingApprovals(id, `worker-${reason.toLowerCase()}`);
  if (m.cancel_requested) {
    store.setStatus(id, 'cancelled', { error: null });
  } else {
    store.setStatus(id, 'paused', { error: `The worker was stopped (${reason}). Resume with: qodex mission resume ${id}` });
  }
  return store.get(id);
}

/** process 'exit' in a worker: a run that never reached a final status is marked paused. */
export function handleWorkerExit(store: MissionStore, id: string, pid: number = process.pid): void {
  const m = store.get(id);
  if (!m || !isActiveStatus(m.status) || (m.pid && m.pid !== pid)) return;
  handleWorkerTermination(store, id, 'exit');
}

/** Install the worker's SIGTERM + exit hooks. Returns a disposer. */
export function installWorkerSignalHandlers(store: MissionStore, id: string, abort: AbortController): () => void {
  const onTerm = () => {
    try { handleWorkerTermination(store, id, 'SIGTERM'); } catch (e: any) { logger.warn('mission SIGTERM bookkeeping failed', { id, err: e?.message }); }
    if (!abort.signal.aborted) abort.abort(store.isCancelRequested(id) ? 'cancelled' : 'SIGTERM');
  };
  const onExit = () => {
    try { handleWorkerExit(store, id); } catch { /* best-effort only */ }
  };
  // prepend: run before bootstrap's async shutdown handler (which ends in process.exit).
  process.prependListener('SIGTERM', onTerm);
  process.on('exit', onExit);
  return () => {
    process.removeListener('SIGTERM', onTerm);
    process.removeListener('exit', onExit);
  };
}

// ── control API (any process) ─────────────────────────────────────────────────

export interface ControlResult {
  ok: boolean;
  message: string;
  mission?: MissionRow;
}

export interface StartMissionInput {
  goal: string;
  cwd?: string;
  model?: string | null;
  approvalMode?: ApprovalMode;
  /** 0/undefined = the missions.maxCostUsd config value. */
  costCapUsd?: number;
  source?: string;
  /** false = only create the row (the caller runs it in-process). Default true. */
  spawn?: boolean;
}

/** Create a mission (and by default spawn its detached worker). Throws [MISSION_*]. */
export function startMission(
  input: StartMissionInput,
  opts: { store?: MissionStore; spawn?: Omit<SpawnWorkerOptions, 'cwd' | 'store'> } = {},
): { mission: MissionRow; pid: number | null; logFile: string | null } {
  const store = opts.store ?? getMissionStore();
  const cwd = path.resolve(input.cwd || process.cwd());
  let st: fs.Stats;
  try { st = fs.statSync(cwd); } catch { throw new Error(`[MISSION_BAD_CWD] Working directory does not exist: ${cwd}`); }
  if (!st.isDirectory()) throw new Error(`[MISSION_BAD_CWD] Not a directory: ${cwd}`);
  const cfg = resolveMissionsConfig(getActiveConfig());
  const mission = store.create({
    goal: input.goal,
    cwd,
    model: input.model ?? null,
    approvalMode: input.approvalMode,
    costCapUsd: input.costCapUsd && input.costCapUsd > 0 ? input.costCapUsd : cfg.maxCostUsd,
    source: input.source ?? null,
  });
  if (input.spawn === false) return { mission, pid: null, logFile: null };
  const { pid, logFile } = spawnMissionWorker(mission.id, { ...(opts.spawn ?? {}), cwd, store });
  return { mission: store.get(mission.id)!, pid, logFile };
}

/** Request cancellation; signal a live worker, or finalize directly if none is running. */
export function cancelMission(
  idOrPrefix: string,
  opts: { store?: MissionStore; kill?: (pid: number, signal: NodeJS.Signals) => void; by?: string } = {},
): ControlResult & { signalled: boolean } {
  const store = opts.store ?? getMissionStore();
  const m0 = store.resolve(idOrPrefix);
  if (!m0) return { ok: false, signalled: false, message: `[MISSION_NOT_FOUND] No mission matches "${idOrPrefix}".` };
  const m = store.reconcile(m0.id) ?? m0;
  if (isTerminalStatus(m.status)) {
    return { ok: false, signalled: false, mission: m, message: `Mission ${m.id} is already ${m.status}.` };
  }
  store.requestCancel(m.id);
  store.appendEvent(m.id, 'cancel-requested', { by: opts.by ?? 'cli' });
  const kill = opts.kill ?? ((pid: number, sig: NodeJS.Signals) => { process.kill(pid, sig); });
  const live = !!m.pid && isProcessAlive(m.pid);
  if (live && m.pid === process.pid) {
    // Runs in this very process (foreground / inline): the runner's poller sees the flag.
    return { ok: true, signalled: false, mission: store.get(m.id), message: `Cancelling mission ${m.id}…` };
  }
  if (live) {
    let signalled = false;
    try { kill(m.pid!, 'SIGTERM'); signalled = true; } catch (e: any) { logger.warn('mission cancel: SIGTERM failed', { id: m.id, err: e?.message }); }
    if (process.platform === 'win32' && signalled) {
      // Windows terminates outright — the worker never gets to record the outcome.
      handleWorkerTermination(store, m.id, 'cancel');
    }
    return { ok: true, signalled, mission: store.get(m.id), message: `Cancelling mission ${m.id} (worker pid ${m.pid})…` };
  }
  // No live worker (paused, or never started): finalize here.
  store.resetRunningSteps(m.id);
  store.expirePendingApprovals(m.id, 'cancelled');
  store.setStatus(m.id, 'cancelled', { error: null });
  return { ok: true, signalled: false, mission: store.get(m.id), message: `Mission ${m.id} cancelled.` };
}

/**
 * Get a mission ready for another worker: clears the cancel flag, retries
 * failed/skipped steps, re-queues running ones, and raises an exhausted cost cap
 * (resuming is the human's approval to spend more).
 */
export function prepareResume(
  idOrPrefix: string,
  opts: { store?: MissionStore; approvalMode?: ApprovalMode; costCapUsd?: number } = {},
): ControlResult {
  const store = opts.store ?? getMissionStore();
  const m0 = store.resolve(idOrPrefix);
  if (!m0) return { ok: false, message: `[MISSION_NOT_FOUND] No mission matches "${idOrPrefix}".` };
  const m = store.reconcile(m0.id) ?? m0;
  // Any live worker — even one still booting (status not yet 'running') — owns it.
  // (In this very process it only counts while the mission is active — inline runs.)
  if (m.pid && isProcessAlive(m.pid) && (m.pid !== process.pid || isActiveStatus(m.status))) {
    return { ok: false, mission: m, message: `Mission ${m.id} is already running (worker pid ${m.pid}).` };
  }
  if (m.status === 'completed') {
    return { ok: false, mission: m, message: `Mission ${m.id} already completed. Start a new mission for follow-up work.` };
  }
  store.clearCancel(m.id);
  const retried = store.resetFailedSteps(m.id);
  store.resetRunningSteps(m.id);
  const patch: Parameters<MissionStore['update']>[1] = { pid: null };
  if (opts.approvalMode) patch.approval_mode = opts.approvalMode;
  if (opts.costCapUsd && opts.costCapUsd > 0) {
    patch.cost_cap_usd = opts.costCapUsd;
  } else if (m.cost_cap_usd > 0 && m.cost_usd >= m.cost_cap_usd) {
    const base = resolveMissionsConfig(getActiveConfig()).maxCostUsd || m.cost_cap_usd;
    patch.cost_cap_usd = m.cost_usd + base;
  }
  store.update(m.id, patch);
  store.appendEvent(m.id, 'resume-requested', { retriedSteps: retried, costCapUsd: patch.cost_cap_usd });
  return { ok: true, mission: store.get(m.id), message: `Mission ${m.id} ready to resume${retried ? ` (${retried} step(s) will be retried)` : ''}.` };
}

/** Queue a steering note for the mission's running agents. */
export function steerMission(idOrPrefix: string, note: string, opts: { store?: MissionStore; by?: string } = {}): ControlResult {
  const store = opts.store ?? getMissionStore();
  const m = store.resolve(idOrPrefix);
  if (!m) return { ok: false, message: `[MISSION_NOT_FOUND] No mission matches "${idOrPrefix}".` };
  const text = String(note ?? '').trim();
  if (!text) return { ok: false, mission: m, message: 'Steering note is empty.' };
  const live = store.reconcile(m.id) ?? m;
  if (!isActiveStatus(live.status)) {
    return { ok: false, mission: live, message: `Mission ${m.id} is ${live.status}; steering only reaches a running mission.` };
  }
  store.appendEvent(m.id, 'steer', { note: text.slice(0, 4000), by: opts.by ?? 'cli' });
  return { ok: true, mission: live, message: `Steering note queued for mission ${m.id}.` };
}

export interface ApprovalAnswerResult extends ControlResult {
  approval?: MissionApprovalRow;
  answer?: string;
  status?: ApprovalStatus;
  /** Pending approvals when the target was ambiguous. */
  pending?: MissionApprovalRow[];
}

/**
 * Answer a mission's pending approval. Without an approval id the single
 * pending one is answered; with several pending the caller must choose.
 */
export function answerMissionApproval(
  missionIdOrPrefix: string,
  approvalIdOrPrefix: string | undefined,
  answer: string,
  opts: { store?: MissionStore; by?: string } = {},
): ApprovalAnswerResult {
  const store = opts.store ?? getMissionStore();
  const m = store.resolve(missionIdOrPrefix);
  if (!m) return { ok: false, message: `[MISSION_NOT_FOUND] No mission matches "${missionIdOrPrefix}".` };
  const pending = store.listPendingApprovals(m.id);
  let target: MissionApprovalRow | undefined;
  if (approvalIdOrPrefix) {
    target = store.resolveApprovalId(m.id, approvalIdOrPrefix);
    if (!target) return { ok: false, mission: m, pending, message: `[APPROVAL_NOT_FOUND] Mission ${m.id} has no approval matching "${approvalIdOrPrefix}".` };
  } else if (pending.length === 1) {
    target = pending[0];
  } else if (pending.length === 0) {
    return { ok: false, mission: m, pending, message: `Mission ${m.id} has no pending approvals.` };
  } else {
    return {
      ok: false, mission: m, pending,
      message: `Mission ${m.id} has ${pending.length} pending approvals — pass one of: ${pending.map(p => p.id).join(', ')}`,
    };
  }
  return answerApprovalById(target.id, answer, { store, by: opts.by });
}

/** Answer an approval by its (globally unique) id. */
export function answerApprovalById(approvalId: string, answer: string, opts: { store?: MissionStore; by?: string } = {}): ApprovalAnswerResult {
  const store = opts.store ?? getMissionStore();
  const a = store.getApproval(approvalId);
  if (!a) return { ok: false, message: `[APPROVAL_NOT_FOUND] No approval ${approvalId}.` };
  const r = store.resolveApproval(a.id, answer, opts.by ?? 'cli');
  const mission = store.get(a.mission_id);
  if (!r.ok) return { ok: false, mission, approval: a, status: r.status, answer: r.answer, message: r.reason ?? 'Could not answer the approval.' };
  return {
    ok: true, mission, approval: store.getApproval(a.id), status: r.status, answer: r.answer,
    message: `${r.status === 'approved' ? '✓ Approved' : r.status === 'denied' ? '✗ Denied' : '✓ Answered'} ${a.id} for mission ${a.mission_id} ("${r.answer}").`,
  };
}

// ── summaries ─────────────────────────────────────────────────────────────────

export interface MissionSummary {
  id: string;
  goal: string;
  status: MissionRow['status'];
  cwd: string;
  model: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  costUsd: number;
  costCapUsd: number;
  tokensIn: number;
  tokensOut: number;
  steps: { total: number; done: number; running: number; pending: number; failed: number; skipped: number };
  pendingApprovals: Array<{ id: string; prompt: string; options: string[]; category: string | null; stepId: string | null }>;
  lastMilestone: { title: string; detail?: string; progress?: number; ts: string } | null;
  liveUrl: string | null;
  error: string | null;
  approvalMode: ApprovalMode;
  workerPid: number | null;
  workerAlive: boolean;
  logFile: string | null;
}

/** A JSON-safe snapshot of a mission (reconciles a dead worker first). */
export function summarizeMission(store: MissionStore, idOrRow: string | MissionRow): MissionSummary | null {
  const id = typeof idOrRow === 'string' ? idOrRow : idOrRow.id;
  const m = store.reconcile(id);
  if (!m) return null;
  const steps = store.steps(m.id);
  const count = (s: string) => steps.filter(x => x.status === s).length;
  const ms = store.recentEvents(m.id, 1, ['milestone'])[0];
  return {
    id: m.id,
    goal: m.goal,
    status: m.status,
    cwd: m.cwd,
    model: m.model,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
    startedAt: m.started_at,
    finishedAt: m.finished_at,
    costUsd: m.cost_usd,
    costCapUsd: m.cost_cap_usd,
    tokensIn: m.tokens_in,
    tokensOut: m.tokens_out,
    steps: { total: steps.length, done: count('done'), running: count('running'), pending: count('pending'), failed: count('failed'), skipped: count('skipped') },
    pendingApprovals: store.listPendingApprovals(m.id).map(a => ({
      id: a.id, prompt: a.prompt, options: approvalOptions(a), category: a.category, stepId: a.step_id,
    })),
    lastMilestone: ms ? { title: String(ms.payload?.title ?? ''), detail: ms.payload?.detail, progress: ms.payload?.progress, ts: ms.ts } : null,
    liveUrl: m.live_url,
    error: m.error,
    approvalMode: m.approval_mode,
    workerPid: m.pid,
    workerAlive: isProcessAlive(m.pid),
    logFile: m.log_file,
  };
}

/** Recent missions as summaries, newest first. */
export function listMissionSummaries(opts: { store?: MissionStore; limit?: number; activeOnly?: boolean; cwd?: string } = {}): MissionSummary[] {
  const store = opts.store ?? getMissionStore();
  const rows = store.list({ limit: opts.limit ?? 20, cwd: opts.cwd });
  const out: MissionSummary[] = [];
  for (const r of rows) {
    const s = summarizeMission(store, r);
    if (!s) continue;
    if (opts.activeOnly && !isActiveStatus(s.status)) continue;
    out.push(s);
  }
  return out;
}
