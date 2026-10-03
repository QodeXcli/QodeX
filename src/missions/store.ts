/**
 * Mission store — durable state for long-running, detached, resumable missions.
 *
 * A mission is a user goal that QodeX keeps working on after the terminal (or the
 * app) is closed: a planner splits it into steps, a detached worker process runs
 * each step with a fresh agent, and every process that cares (the CLI, the TUI,
 * the control center, Telegram) observes and steers it through these tables.
 *
 * Like ScheduleStore we piggyback on ~/.qodex/sessions.db: WAL + busy_timeout
 * make it safe for the worker and any number of observers to read/write
 * concurrently, and the step conversations live in the same DB's `sessions`.
 *
 * Tables
 *   missions           one row per mission (status, plan, report, usage, worker pid)
 *   mission_steps      the plan's steps (status, attempts, result, session id)
 *   mission_events     append-only timeline (milestones, step start/done, tools, ...)
 *   mission_approvals  human decisions a worker is waiting for — written by the
 *                      worker, resolved by whichever process the human used
 *
 * Columns added after the first release are migrated with PRAGMA table_info, so
 * opening an older DB is idempotent and never loses rows.
 */
import type Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import { openDatabase } from '../utils/sqlite.js';
import { QODEX_SESSION_DB } from '../config/defaults.js';
import { normalizeAnswer, safeOption, isApproval } from '../control/approvals.js';

export type MissionStatus =
  | 'planning'
  | 'running'
  | 'paused'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';
export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'answered' | 'expired';
/**
 * How a mission's worker answers ordinary permission prompts (shell commands,
 * file edits, MCP tools):
 *   ask  — route them to a human (mission approval queue, control center, Telegram)
 *   auto — answer them with the approving option, like `--yes`
 * Sentinel-critical actions and the cost cap ALWAYS need a human, in both modes.
 */
export type ApprovalMode = 'ask' | 'auto';

/** A worker process is (supposed to be) driving the mission. */
export const ACTIVE_STATUSES: readonly MissionStatus[] = ['planning', 'running', 'awaiting_approval'];
/** Nothing more will happen unless a human resumes it. */
export const TERMINAL_STATUSES: readonly MissionStatus[] = ['completed', 'failed', 'cancelled'];

export function isActiveStatus(s: string): boolean {
  return (ACTIVE_STATUSES as readonly string[]).includes(s);
}
export function isTerminalStatus(s: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(s);
}

export interface MissionRow {
  id: string;
  goal: string;
  cwd: string;
  model: string | null;
  status: MissionStatus;
  pid: number | null;
  plan_json: string | null;
  report: string | null;
  live_url: string | null;
  cancel_requested: 0 | 1;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  error: string | null;
  approval_mode: ApprovalMode;
  /** USD the mission may spend before pausing for approval (0 = unlimited). */
  cost_cap_usd: number;
  /** Who started it: 'cli', 'tool', 'schedule:<id>', 'telegram', 'control', ... */
  source: string | null;
  log_file: string | null;
  /** Start identity of the `pid` process (Linux: start time since boot) — guards against pid reuse. */
  pid_start: string | null;
  /** 1 = `pid` is a shared host running the mission inline (a TUI): never signal it. */
  worker_shared: 0 | 1;
}

export interface MissionStepRow {
  mission_id: string;
  id: string;
  idx: number;
  title: string;
  instruction: string;
  depends_on_json: string;
  status: StepStatus;
  session_id: string | null;
  attempts: number;
  result: string | null;
  error: string | null;
  cost_usd: number;
  started_at: string | null;
  finished_at: string | null;
}

export interface MissionEventRow {
  id: number;
  mission_id: string;
  ts: string;
  type: string;
  payload_json: string | null;
}

export interface MissionEvent {
  id: number;
  missionId: string;
  ts: string;
  type: string;
  payload: any;
}

export interface MissionApprovalRow {
  id: string;
  mission_id: string;
  step_id: string | null;
  prompt: string;
  options_json: string;
  category: string | null;
  risk: string | null;
  status: ApprovalStatus;
  answer: string | null;
  resolved_by: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface NewStep {
  id: string;
  title: string;
  instruction: string;
  depends_on: string[];
}

export interface ResolveApprovalResult {
  ok: boolean;
  /** The normalized answer that was stored (one of the approval's options). */
  answer?: string;
  status?: ApprovalStatus;
  reason?: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  goal TEXT NOT NULL,
  cwd TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL DEFAULT 'planning',
  pid INTEGER,
  plan_json TEXT,
  report TEXT,
  live_url TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_missions_created ON missions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_missions_status ON missions(status);

CREATE TABLE IF NOT EXISTS mission_steps (
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  title TEXT NOT NULL,
  instruction TEXT NOT NULL,
  depends_on_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  session_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  started_at TEXT,
  finished_at TEXT,
  PRIMARY KEY (mission_id, id)
);

CREATE TABLE IF NOT EXISTS mission_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_mission_events ON mission_events(mission_id, id);

CREATE TABLE IF NOT EXISTS mission_approvals (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  step_id TEXT,
  prompt TEXT NOT NULL,
  options_json TEXT NOT NULL,
  category TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  answer TEXT,
  resolved_by TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_mission_approvals_pending ON mission_approvals(status, mission_id);
`;

/** Columns added after v1 of the schema — [table, column, DDL]. */
const LATE_COLUMNS: Array<[string, string, string]> = [
  ['missions', 'approval_mode', `TEXT NOT NULL DEFAULT 'ask'`],
  ['missions', 'cost_cap_usd', 'REAL NOT NULL DEFAULT 0'],
  ['missions', 'source', 'TEXT'],
  ['missions', 'log_file', 'TEXT'],
  ['mission_steps', 'error', 'TEXT'],
  ['mission_steps', 'cost_usd', 'REAL NOT NULL DEFAULT 0'],
  ['mission_approvals', 'risk', 'TEXT'],
  ['missions', 'pid_start', 'TEXT'],
  ['missions', 'worker_shared', 'INTEGER NOT NULL DEFAULT 0'],
];

const MISSION_PATCH_KEYS = [
  'goal', 'cwd', 'model', 'plan_json', 'report', 'live_url', 'pid', 'pid_start', 'worker_shared', 'error',
  'approval_mode', 'cost_cap_usd', 'source', 'log_file', 'started_at', 'finished_at',
] as const;
export type MissionPatch = Partial<Pick<MissionRow, typeof MISSION_PATCH_KEYS[number]>>;

const STEP_PATCH_KEYS = [
  'title', 'instruction', 'status', 'session_id', 'attempts', 'result', 'error',
  'cost_usd', 'started_at', 'finished_at',
] as const;
export type StepPatch = Partial<Pick<MissionStepRow, typeof STEP_PATCH_KEYS[number]>>;

/** True if a process with this pid exists (EPERM = exists but not ours). */
export function isProcessAlive(pid: number | null | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}

/**
 * Identity of a process beyond its pid, so a pid the OS reused after the worker
 * died (crash, kill -9, power loss) is not mistaken for the worker. Linux: the
 * start time in clock ticks since boot (/proc/<pid>/stat field 22, fixed at fork,
 * unchanged by exec). Null where unknown (other platforms, process gone).
 */
export function processStartToken(pid: number | null | undefined): string | null {
  if (!pid || !Number.isInteger(pid) || pid <= 0 || process.platform !== 'linux') return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // "pid (comm) state ppid …" — comm may contain spaces/parens, so split after the LAST ')'.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const start = fields[19]; // field 22 overall; fields[0] is field 3 (state)
    return start && /^\d+$/.test(start) ? start : null;
  } catch {
    return null;
  }
}

/**
 * True when the mission's recorded worker still runs AND is the same process that
 * claimed the mission (its start identity matches, where the platform tells us).
 */
export function isWorkerAlive(m: { pid: number | null; pid_start?: string | null }): boolean {
  if (!isProcessAlive(m.pid)) return false;
  if (!m.pid_start) return true;
  const now = processStartToken(m.pid);
  return now === null || now === m.pid_start;
}

export function stepDeps(step: Pick<MissionStepRow, 'depends_on_json'>): string[] {
  try {
    const v = JSON.parse(step.depends_on_json || '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function approvalOptions(a: Pick<MissionApprovalRow, 'options_json'>): string[] {
  try {
    const v = JSON.parse(a.options_json || '[]');
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export function parseEventRow(r: MissionEventRow): MissionEvent {
  let payload: any = null;
  if (r.payload_json) {
    try { payload = JSON.parse(r.payload_json); } catch { payload = r.payload_json; }
  }
  return { id: r.id, missionId: r.mission_id, ts: r.ts, type: r.type, payload };
}

export class MissionStore {
  private db: Database.Database;
  private readonly now: () => number;

  constructor(dbPath: string = QODEX_SESSION_DB, opts: { now?: () => number } = {}) {
    this.db = openDatabase(dbPath);
    this.now = opts.now ?? Date.now;
    this.db.exec(SCHEMA);
    this.migrate();
  }

  private migrate(): void {
    const byTable = new Map<string, Set<string>>();
    for (const [table, col, ddl] of LATE_COLUMNS) {
      let have = byTable.get(table);
      if (!have) {
        have = new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name));
        byTable.set(table, have);
      }
      if (have.has(col)) continue;
      try {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
      } catch (e: any) {
        // Another process migrated the same DB between our PRAGMA and ALTER.
        if (!/duplicate column/i.test(String(e?.message))) throw e;
      }
      have.add(col);
    }
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  // ── missions ──────────────────────────────────────────────────────────────

  private newMissionId(): string {
    for (let i = 0; i < 20; i++) {
      const id = 'm' + randomBytes(4).toString('hex');
      if (!this.get(id)) return id;
    }
    return 'm' + randomBytes(8).toString('hex');
  }

  create(input: {
    goal: string;
    cwd: string;
    model?: string | null;
    approvalMode?: ApprovalMode;
    costCapUsd?: number;
    source?: string | null;
    id?: string;
  }): MissionRow {
    const goal = String(input.goal ?? '').trim();
    if (!goal) throw new Error('[MISSION_INVALID] A mission needs a non-empty goal.');
    const id = input.id ?? this.newMissionId();
    const ts = this.iso();
    this.db.prepare(`
      INSERT INTO missions (id, goal, cwd, model, status, created_at, updated_at, approval_mode, cost_cap_usd, source)
      VALUES (?, ?, ?, ?, 'planning', ?, ?, ?, ?, ?)
    `).run(
      id, goal, input.cwd, input.model ?? null, ts, ts,
      input.approvalMode === 'auto' ? 'auto' : 'ask',
      Math.max(0, Number(input.costCapUsd) || 0),
      input.source ?? null,
    );
    this.appendEvent(id, 'created', { goal, cwd: input.cwd, model: input.model ?? null, source: input.source ?? null });
    return this.get(id)!;
  }

  get(id: string): MissionRow | undefined {
    return this.db.prepare(`SELECT * FROM missions WHERE id = ?`).get(id) as MissionRow | undefined;
  }

  /** Exact id, or a unique id prefix (>= 3 chars). */
  resolve(idOrPrefix: string): MissionRow | undefined {
    const key = String(idOrPrefix ?? '').trim();
    if (!key) return undefined;
    const exact = this.get(key);
    if (exact) return exact;
    if (key.length < 3) return undefined;
    const rows = this.db.prepare(`SELECT * FROM missions WHERE id LIKE ? ESCAPE '\\' LIMIT 2`)
      .all(key.replace(/[\\%_]/g, m => '\\' + m) + '%') as MissionRow[];
    return rows.length === 1 ? rows[0] : undefined;
  }

  list(opts: { limit?: number; statuses?: MissionStatus[]; cwd?: string } = {}): MissionRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.statuses && opts.statuses.length) {
      where.push(`status IN (${opts.statuses.map(() => '?').join(',')})`);
      params.push(...opts.statuses);
    }
    if (opts.cwd) { where.push('cwd = ?'); params.push(opts.cwd); }
    const limit = Math.max(1, Math.min(1000, Math.floor(opts.limit ?? 20)));
    const sql = `SELECT * FROM missions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, rowid DESC LIMIT ?`;
    return this.db.prepare(sql).all(...params, limit) as MissionRow[];
  }

  /** Most recently created mission (optionally in `cwd`). */
  latest(cwd?: string): MissionRow | undefined {
    return this.list({ limit: 1, cwd })[0];
  }

  update(id: string, patch: MissionPatch): void {
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const k of MISSION_PATCH_KEYS) {
      if (k in patch) { sets.push(`${k} = ?`); params.push((patch as any)[k] ?? null); }
    }
    if ('pid' in patch && !('pid_start' in patch)) {
      // A pid is only meaningful together with the identity of that process.
      sets.push('pid_start = ?');
      params.push(processStartToken(patch.pid));
    }
    if (!sets.length) return;
    sets.push('updated_at = ?');
    params.push(this.iso(), id);
    this.db.prepare(`UPDATE missions SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  /**
   * Record `pid` as the process running the mission — atomically, and only if no
   * OTHER live process holds it (two racing `resume`s must not start two workers).
   * `shared` marks a host that runs the mission inline (TUI): it is never signalled.
   * Returns false when another live worker owns the mission.
   */
  claimWorker(id: string, pid: number, opts: { shared?: boolean } = {}): boolean {
    const m = this.get(id);
    if (!m) return false;
    const holder = m.pid ?? null;
    if (holder && holder !== pid && isWorkerAlive(m)) return false;
    // Compare-and-set on the holder we saw, so a concurrent claim can't be overwritten.
    const r = this.db.prepare(`
      UPDATE missions SET pid = ?, pid_start = ?, worker_shared = ?, updated_at = ? WHERE id = ? AND pid IS ?
    `).run(pid, processStartToken(pid), opts.shared ? 1 : 0, this.iso(), id, holder);
    return r.changes === 1;
  }

  /** `pid` stopped running the mission: forget it (no-op if another process claimed it since). */
  releaseWorker(id: string, pid: number): void {
    this.db.prepare(`
      UPDATE missions SET pid = NULL, pid_start = NULL, worker_shared = 0, updated_at = ? WHERE id = ? AND pid = ?
    `).run(this.iso(), id, pid);
  }

  /**
   * Change status. Entering an active state clears finished_at (resume); entering
   * 'running' the first time stamps started_at; a terminal state stamps finished_at.
   */
  setStatus(id: string, status: MissionStatus, extra: { error?: string | null } = {}): number | undefined {
    const ts = this.iso();
    const m = this.get(id);
    if (!m) return undefined;
    const startedAt = m.started_at ?? (status === 'running' ? ts : null);
    const finishedAt = isTerminalStatus(status) ? ts : null;
    const error = 'error' in extra ? (extra.error ?? null) : m.error;
    this.db.prepare(`
      UPDATE missions SET status = ?, updated_at = ?, started_at = ?, finished_at = ?, error = ? WHERE id = ?
    `).run(status, ts, startedAt, finishedAt, error, id);
    // The 'status' event's id (undefined when the status did not change).
    return m.status !== status ? this.appendEvent(id, 'status', { from: m.status, to: status, error: error ?? undefined }) : undefined;
  }

  addUsage(id: string, u: { costUsd?: number; tokensIn?: number; tokensOut?: number }): void {
    const c = Number(u.costUsd) || 0;
    const ti = Math.round(Number(u.tokensIn) || 0);
    const to = Math.round(Number(u.tokensOut) || 0);
    if (!c && !ti && !to) return;
    this.db.prepare(`
      UPDATE missions SET cost_usd = cost_usd + ?, tokens_in = tokens_in + ?, tokens_out = tokens_out + ?, updated_at = ? WHERE id = ?
    `).run(c, ti, to, this.iso(), id);
  }

  requestCancel(id: string): boolean {
    const r = this.db.prepare(`UPDATE missions SET cancel_requested = 1, updated_at = ? WHERE id = ?`).run(this.iso(), id);
    return r.changes === 1;
  }

  clearCancel(id: string): void {
    this.db.prepare(`UPDATE missions SET cancel_requested = 0, updated_at = ? WHERE id = ?`).run(this.iso(), id);
  }

  isCancelRequested(id: string): boolean {
    const r = this.db.prepare(`SELECT cancel_requested FROM missions WHERE id = ?`).get(id) as { cancel_requested: number } | undefined;
    return !!r && r.cancel_requested === 1;
  }

  /** running/planning → awaiting_approval (only from those states). */
  markAwaitingApproval(id: string): boolean {
    const r = this.db.prepare(`
      UPDATE missions SET status = 'awaiting_approval', updated_at = ? WHERE id = ? AND status IN ('running', 'planning')
    `).run(this.iso(), id);
    if (r.changes === 1) this.appendEvent(id, 'status', { to: 'awaiting_approval' });
    return r.changes === 1;
  }

  /** awaiting_approval → running once no approval for the mission is pending. */
  clearAwaitingApproval(id: string): boolean {
    const r = this.db.prepare(`
      UPDATE missions SET status = 'running', updated_at = ?
      WHERE id = ? AND status = 'awaiting_approval'
        AND NOT EXISTS (SELECT 1 FROM mission_approvals WHERE mission_id = ? AND status = 'pending')
    `).run(this.iso(), id, id);
    if (r.changes === 1) this.appendEvent(id, 'status', { from: 'awaiting_approval', to: 'running' });
    return r.changes === 1;
  }

  remove(id: string): boolean {
    return this.db.prepare(`DELETE FROM missions WHERE id = ?`).run(id).changes === 1;
  }

  /**
   * If the mission claims to be active but its worker process is gone (crash,
   * reboot, kill -9), record that: cancelled when a cancel was requested, else
   * paused (resumable). Running steps go back to pending and pending approvals
   * expire, since nobody is waiting for them any more. Returns the fresh row.
   */
  reconcile(id: string): MissionRow | undefined {
    const m = this.get(id);
    if (!m) return undefined;
    if (!isActiveStatus(m.status) || !m.pid || isWorkerAlive(m)) return m;
    this.resetRunningSteps(id);
    this.expirePendingApprovals(id, 'worker-exited');
    if (m.cancel_requested) {
      this.setStatus(id, 'cancelled', { error: null });
    } else {
      this.setStatus(id, 'paused', {
        error: `The mission's worker (pid ${m.pid}) exited unexpectedly. Resume with: qodex mission resume ${id}`,
      });
    }
    return this.get(id);
  }

  // ── events ────────────────────────────────────────────────────────────────

  appendEvent(missionId: string, type: string, payload?: unknown): number {
    let json: string | null = null;
    if (payload !== undefined) {
      try { json = JSON.stringify(payload); } catch { json = JSON.stringify(String(payload)); }
    }
    const r = this.db.prepare(`INSERT INTO mission_events (mission_id, ts, type, payload_json) VALUES (?, ?, ?, ?)`)
      .run(missionId, this.iso(), type, json);
    return Number(r.lastInsertRowid);
  }

  /** Events with id > sinceId, oldest first. */
  events(missionId: string, sinceId = 0, opts: { limit?: number; types?: string[] } = {}): MissionEvent[] {
    const limit = Math.max(1, Math.min(10_000, Math.floor(opts.limit ?? 500)));
    const typeSql = opts.types && opts.types.length ? ` AND type IN (${opts.types.map(() => '?').join(',')})` : '';
    const rows = this.db.prepare(
      `SELECT * FROM mission_events WHERE mission_id = ? AND id > ?${typeSql} ORDER BY id ASC LIMIT ?`,
    ).all(missionId, sinceId, ...(opts.types ?? []), limit) as MissionEventRow[];
    return rows.map(parseEventRow);
  }

  /** The newest `limit` events (optionally of some types), oldest first. */
  recentEvents(missionId: string, limit = 20, types?: string[]): MissionEvent[] {
    const typeSql = types && types.length ? ` AND type IN (${types.map(() => '?').join(',')})` : '';
    const rows = this.db.prepare(
      `SELECT * FROM mission_events WHERE mission_id = ?${typeSql} ORDER BY id DESC LIMIT ?`,
    ).all(missionId, ...(types ?? []), Math.max(1, Math.floor(limit))) as MissionEventRow[];
    return rows.reverse().map(parseEventRow);
  }

  lastEventId(missionId: string): number {
    const r = this.db.prepare(`SELECT MAX(id) AS id FROM mission_events WHERE mission_id = ?`).get(missionId) as { id: number | null };
    return r?.id ?? 0;
  }

  /** Newest event id across all missions (0 when none). */
  maxEventId(): number {
    const r = this.db.prepare(`SELECT MAX(id) AS id FROM mission_events`).get() as { id: number | null };
    return r?.id ?? 0;
  }

  /**
   * Ids of stored events THIS process already published on its bus (the runner and
   * the milestone tool publish as they write), so the cross-process event bridge
   * (startMissionEventBridge) does not mirror them a second time. Bounded: a
   * process without a bridge must not accumulate them forever.
   */
  private readonly busPublished = new Set<number>();
  noteBusPublished(eventId: number | undefined): void {
    if (typeof eventId !== 'number' || !(eventId > 0)) return;
    this.busPublished.add(eventId);
    if (this.busPublished.size > 5000) this.busPublished.delete(this.busPublished.values().next().value as number);
  }
  /** True (once) when this process already published the event; the mark is consumed. */
  takeBusPublished(eventId: number): boolean {
    return this.busPublished.delete(eventId);
  }

  /** Events of ALL missions with id > sinceId, oldest first (cross-process bridges). */
  eventsAfter(sinceId: number, opts: { limit?: number; types?: string[] } = {}): MissionEvent[] {
    const limit = Math.max(1, Math.min(10_000, Math.floor(opts.limit ?? 500)));
    const typeSql = opts.types && opts.types.length ? ` AND type IN (${opts.types.map(() => '?').join(',')})` : '';
    const rows = this.db.prepare(
      `SELECT * FROM mission_events WHERE id > ?${typeSql} ORDER BY id ASC LIMIT ?`,
    ).all(sinceId, ...(opts.types ?? []), limit) as MissionEventRow[];
    return rows.map(parseEventRow);
  }

  // ── steps ─────────────────────────────────────────────────────────────────

  /** Replace the mission's plan steps atomically. */
  replaceSteps(missionId: string, steps: NewStep[]): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM mission_steps WHERE mission_id = ?`).run(missionId);
      const ins = this.db.prepare(`
        INSERT INTO mission_steps (mission_id, id, idx, title, instruction, depends_on_json, status)
        VALUES (?, ?, ?, ?, ?, ?, 'pending')
      `);
      steps.forEach((s, i) => ins.run(missionId, s.id, i, s.title, s.instruction, JSON.stringify(s.depends_on ?? [])));
    });
    tx();
  }

  steps(missionId: string): MissionStepRow[] {
    return this.db.prepare(`SELECT * FROM mission_steps WHERE mission_id = ? ORDER BY idx ASC`).all(missionId) as MissionStepRow[];
  }

  getStep(missionId: string, stepId: string): MissionStepRow | undefined {
    return this.db.prepare(`SELECT * FROM mission_steps WHERE mission_id = ? AND id = ?`).get(missionId, stepId) as MissionStepRow | undefined;
  }

  updateStep(missionId: string, stepId: string, patch: StepPatch): void {
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const k of STEP_PATCH_KEYS) {
      if (k in patch) { sets.push(`${k} = ?`); params.push((patch as any)[k] ?? null); }
    }
    if (!sets.length) return;
    params.push(missionId, stepId);
    this.db.prepare(`UPDATE mission_steps SET ${sets.join(', ')} WHERE mission_id = ? AND id = ?`).run(...params);
  }

  addStepCost(missionId: string, stepId: string, costUsd: number): void {
    const c = Number(costUsd) || 0;
    if (!c) return;
    this.db.prepare(`UPDATE mission_steps SET cost_usd = cost_usd + ? WHERE mission_id = ? AND id = ?`).run(c, missionId, stepId);
  }

  /** Crash recovery: steps that were mid-run go back to pending. Returns how many. */
  resetRunningSteps(missionId: string): number {
    return this.db.prepare(`UPDATE mission_steps SET status = 'pending', started_at = NULL WHERE mission_id = ? AND status = 'running'`)
      .run(missionId).changes;
  }

  /** `qodex mission resume` of a failed mission: retry failed/skipped steps from scratch. */
  resetFailedSteps(missionId: string): number {
    return this.db.prepare(`
      UPDATE mission_steps SET status = 'pending', attempts = 0, error = NULL, started_at = NULL, finished_at = NULL
      WHERE mission_id = ? AND status IN ('failed', 'skipped')
    `).run(missionId).changes;
  }

  // ── approvals ─────────────────────────────────────────────────────────────

  /** Record a pending approval. Idempotent on `id` (a re-delivery is a no-op). */
  createApproval(input: {
    id?: string;
    missionId: string;
    stepId?: string | null;
    prompt: string;
    options: string[];
    category?: string | null;
    risk?: string | null;
  }): MissionApprovalRow {
    const id = input.id ?? 'ap_' + randomBytes(6).toString('base64url');
    const options = input.options?.length ? input.options.map(String) : ['yes', 'no'];
    this.db.prepare(`
      INSERT OR IGNORE INTO mission_approvals (id, mission_id, step_id, prompt, options_json, category, risk, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(id, input.missionId, input.stepId ?? null, input.prompt, JSON.stringify(options), input.category ?? null, input.risk ?? null, this.iso());
    return this.getApproval(id)!;
  }

  getApproval(id: string): MissionApprovalRow | undefined {
    return this.db.prepare(`SELECT * FROM mission_approvals WHERE id = ?`).get(id) as MissionApprovalRow | undefined;
  }

  /** Exact approval id, or a unique prefix among this mission's approvals. */
  resolveApprovalId(missionId: string, idOrPrefix: string): MissionApprovalRow | undefined {
    const key = String(idOrPrefix ?? '').trim();
    if (!key) return undefined;
    const exact = this.getApproval(key);
    if (exact && exact.mission_id === missionId) return exact;
    const rows = this.db.prepare(`SELECT * FROM mission_approvals WHERE mission_id = ? AND id LIKE ? ESCAPE '\\' LIMIT 2`)
      .all(missionId, key.replace(/[\\%_]/g, m => '\\' + m) + '%') as MissionApprovalRow[];
    return rows.length === 1 ? rows[0] : undefined;
  }

  listPendingApprovals(missionId?: string): MissionApprovalRow[] {
    if (missionId) {
      return this.db.prepare(`SELECT * FROM mission_approvals WHERE mission_id = ? AND status = 'pending' ORDER BY created_at ASC, rowid ASC`)
        .all(missionId) as MissionApprovalRow[];
    }
    return this.db.prepare(`SELECT * FROM mission_approvals WHERE status = 'pending' ORDER BY created_at ASC, rowid ASC`)
      .all() as MissionApprovalRow[];
  }

  listApprovals(missionId: string, limit = 50): MissionApprovalRow[] {
    return this.db.prepare(`SELECT * FROM mission_approvals WHERE mission_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(missionId, Math.max(1, Math.floor(limit))) as MissionApprovalRow[];
  }

  /**
   * Answer a pending approval from any process. The answer is normalized against
   * the approval's options ("y", "approve", "بله" → the approving option), so the
   * waiting worker always receives one of the options it offered. Atomic: only the
   * first resolver wins.
   */
  resolveApproval(id: string, answer: string, by: string): ResolveApprovalResult {
    const a = this.getApproval(id);
    if (!a) return { ok: false, reason: `[APPROVAL_NOT_FOUND] No approval ${id}.` };
    if (a.status !== 'pending') return { ok: false, status: a.status, answer: a.answer ?? undefined, reason: `Approval ${id} is already ${a.status}.` };
    const options = approvalOptions(a);
    const norm = normalizeAnswer(answer, options);
    if (norm === null) {
      return { ok: false, reason: `[APPROVAL_BAD_ANSWER] "${answer}" is not one of: ${options.join(', ')}` };
    }
    const status: ApprovalStatus = norm === safeOption(options)
      ? 'denied'
      : isApproval(norm, options) ? 'approved' : 'answered';
    const r = this.db.prepare(`
      UPDATE mission_approvals SET status = ?, answer = ?, resolved_by = ?, resolved_at = ? WHERE id = ? AND status = 'pending'
    `).run(status, norm, by, this.iso(), id);
    if (r.changes !== 1) {
      const now = this.getApproval(id);
      return { ok: false, status: now?.status, answer: now?.answer ?? undefined, reason: `Approval ${id} was answered concurrently.` };
    }
    this.appendEvent(a.mission_id, 'approval-resolved', { approvalId: id, answer: norm, status, by, stepId: a.step_id });
    return { ok: true, answer: norm, status };
  }

  /** Mark one approval expired (the worker stopped waiting). No-op unless pending. */
  expireApproval(id: string, reason = 'expired'): boolean {
    const a = this.getApproval(id);
    const r = this.db.prepare(`
      UPDATE mission_approvals SET status = 'expired', resolved_by = ?, resolved_at = ? WHERE id = ? AND status = 'pending'
    `).run(reason, this.iso(), id);
    if (r.changes === 1 && a) this.appendEvent(a.mission_id, 'approval-expired', { approvalId: id, reason });
    return r.changes === 1;
  }

  expirePendingApprovals(missionId: string, reason = 'expired'): number {
    let n = 0;
    for (const a of this.listPendingApprovals(missionId)) if (this.expireApproval(a.id, reason)) n++;
    return n;
  }
}

let _store: MissionStore | null = null;

export function getMissionStore(): MissionStore {
  if (!_store) _store = new MissionStore();
  return _store;
}

/** Point every mission API at another store (tests), or back to the default with null. */
export function setMissionStoreForTests(store: MissionStore | null): void {
  _store = store;
}
