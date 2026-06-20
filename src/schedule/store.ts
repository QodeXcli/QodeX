/**
 * Schedule store — persists `qodex schedule` entries in ~/.qodex/sessions.db.
 *
 * We piggyback on the existing sessions DB rather than creating a new file: the
 * pragmas are already right, backups cover it, and `qodex schedule tick` won't
 * surprise users by silently creating new state outside the home dir.
 *
 * Each entry has its own next_run_at so the tick loop is O(due) rather than
 * O(all). Wall-clock changes (DST, manual time changes) re-compute next_run_at
 * on the next save.
 */
import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { openDatabase } from '../utils/sqlite.js';
import { QODEX_SESSION_DB } from '../config/defaults.js';
import { parseCron, nextAfter } from './cron.js';
import { logger } from '../utils/logger.js';

export interface ScheduleEntry {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  cwd: string;
  model?: string;
  allowed_tools?: string;     // JSON-encoded array, or null for "all tools"
  enabled: 1 | 0;
  created_at: string;
  last_run_at?: string;
  last_status?: 'success' | 'error' | 'skipped';
  last_message?: string;
  last_duration_ms?: number;
  next_run_at?: string;       // ISO; recomputed on save / on tick
  run_count: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cron TEXT NOT NULL,
  prompt TEXT NOT NULL,
  cwd TEXT NOT NULL,
  model TEXT,
  allowed_tools TEXT,
  enabled INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_run_at DATETIME,
  last_status TEXT,
  last_message TEXT,
  last_duration_ms INTEGER,
  next_run_at DATETIME,
  run_count INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_schedules_next ON schedules(next_run_at) WHERE enabled = 1;

CREATE TABLE IF NOT EXISTS schedule_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME,
  status TEXT,
  exit_code INTEGER,
  message TEXT,
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_runs_schedule ON schedule_runs(schedule_id, started_at DESC);
`;

export interface ScheduleRun {
  id: number;
  schedule_id: string;
  started_at: string;
  finished_at?: string;
  status?: 'success' | 'error' | 'skipped';
  exit_code?: number;
  message?: string;
  duration_ms?: number;
}

export class ScheduleStore {
  private db: Database.Database;

  constructor(dbPath: string = QODEX_SESSION_DB) {
    this.db = openDatabase(dbPath);
    this.db.exec(SCHEMA);
  }

  add(input: {
    name: string;
    cron: string;
    prompt: string;
    cwd: string;
    model?: string;
    allowedTools?: string[];
  }): ScheduleEntry {
    const parsed = parseCron(input.cron); // throws on invalid
    const next = nextAfter(parsed, new Date());
    const id = uuidv4();
    const allowed = input.allowedTools && input.allowedTools.length > 0 ? JSON.stringify(input.allowedTools) : null;
    this.db.prepare(`
      INSERT INTO schedules (id, name, cron, prompt, cwd, model, allowed_tools, next_run_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.name, input.cron, input.prompt, input.cwd, input.model ?? null, allowed, next?.toISOString() ?? null);
    return this.get(id)!;
  }

  remove(idOrName: string): boolean {
    const e = this.resolve(idOrName);
    if (!e) return false;
    this.db.prepare(`DELETE FROM schedules WHERE id = ?`).run(e.id);
    return true;
  }

  setEnabled(idOrName: string, enabled: boolean): ScheduleEntry | null {
    const e = this.resolve(idOrName);
    if (!e) return null;
    this.db.prepare(`UPDATE schedules SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, e.id);
    if (enabled) this.recomputeNext(e.id);
    return this.get(e.id) ?? null;
  }

  get(id: string): ScheduleEntry | undefined {
    return this.db.prepare(`SELECT * FROM schedules WHERE id = ?`).get(id) as ScheduleEntry | undefined;
  }

  /** Find by exact id, id prefix (>=4 chars), or exact name. */
  resolve(idOrName: string): ScheduleEntry | undefined {
    const exact = this.get(idOrName);
    if (exact) return exact;
    const byName = this.db.prepare(`SELECT * FROM schedules WHERE name = ?`).get(idOrName) as ScheduleEntry | undefined;
    if (byName) return byName;
    if (idOrName.length >= 4) {
      const matches = this.db.prepare(`SELECT * FROM schedules WHERE id LIKE ?`).all(`${idOrName}%`) as ScheduleEntry[];
      if (matches.length === 1) return matches[0];
    }
    return undefined;
  }

  list(): ScheduleEntry[] {
    return this.db.prepare(`SELECT * FROM schedules ORDER BY created_at ASC`).all() as ScheduleEntry[];
  }

  /** Schedules whose next_run_at is <= now and that are enabled. */
  dueAsOf(now: Date): ScheduleEntry[] {
    return this.db.prepare(
      `SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?`,
    ).all(now.toISOString()) as ScheduleEntry[];
  }

  recordRunStart(scheduleId: string): number {
    const r = this.db.prepare(
      `INSERT INTO schedule_runs (schedule_id, status) VALUES (?, 'running')`,
    ).run(scheduleId);
    return Number(r.lastInsertRowid);
  }

  /**
   * Record the result of a run and atomically advance next_run_at.
   *
   * Returns true if this caller won the claim, false if a concurrent tick had
   * already advanced next_run_at. The whole thing is one transaction: we
   * advance next_run_at FIRST (the atomic claim), and only if we win do we
   * commit the run/bookkeeping rows. A loser's writes are rolled back so it
   * leaves no trace and does not double-count — callers must treat false as
   * "this run did not happen / do not fire".
   */
  recordRunFinish(runId: number, scheduleId: string, status: 'success' | 'error' | 'skipped', exitCode: number, message: string, durationMs: number): boolean {
    const CLAIM_LOST = Symbol('claim-lost');
    const tx = this.db.transaction(() => {
      // Atomic claim first: if we lose the race, abort the transaction so none
      // of the bookkeeping below is committed.
      if (!this.recomputeNext(scheduleId)) {
        throw CLAIM_LOST;
      }
      this.db.prepare(`
        UPDATE schedule_runs SET finished_at = CURRENT_TIMESTAMP, status = ?, exit_code = ?, message = ?, duration_ms = ?
        WHERE id = ?
      `).run(status, exitCode, message, durationMs, runId);
      this.db.prepare(`
        UPDATE schedules SET
          last_run_at = CURRENT_TIMESTAMP,
          last_status = ?,
          last_message = ?,
          last_duration_ms = ?,
          run_count = run_count + 1
        WHERE id = ?
      `).run(status, message, durationMs, scheduleId);
    });
    try {
      tx();
      return true;
    } catch (err) {
      if (err === CLAIM_LOST) return false;
      throw err;
    }
  }

  /**
   * Recompute next_run_at from now. Called after every run and on enable.
   *
   * Returns true if this caller successfully advanced next_run_at, false if it
   * lost a race (another process/tick already advanced the same row). The
   * advance is atomic: the UPDATE is conditional on the previously-read
   * next_run_at, so only the first of two concurrent ticks sees changes === 1.
   * Callers on the run path MUST treat a false result as "do not fire".
   */
  recomputeNext(scheduleId: string): boolean {
    const e = this.get(scheduleId);
    if (!e) return false;
    let next: Date | null = null;
    try {
      const parsed = parseCron(e.cron);
      next = nextAfter(parsed, new Date());
    } catch (err: any) {
      // Invalid cron — leave next_run_at null so the tick loop ignores it, but
      // warn so the user can learn why this schedule never fires instead of it
      // being silently disabled.
      logger.warn('Schedule has an invalid cron expression; it will never run until fixed', {
        id: e.id,
        name: e.name,
        cron: e.cron,
        err: err?.message ?? String(err),
      });
    }
    // Atomic claim: only advance if next_run_at still holds the value we read.
    // A losing concurrent tick sees changes === 0 and must not fire.
    const prev = e.next_run_at ?? null;
    const res = prev === null
      ? this.db.prepare(`UPDATE schedules SET next_run_at = ? WHERE id = ? AND next_run_at IS NULL`)
          .run(next?.toISOString() ?? null, scheduleId)
      : this.db.prepare(`UPDATE schedules SET next_run_at = ? WHERE id = ? AND next_run_at = ?`)
          .run(next?.toISOString() ?? null, scheduleId, prev);
    return res.changes === 1;
  }

  recentRuns(scheduleId: string, limit = 10): ScheduleRun[] {
    return this.db.prepare(
      `SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY started_at DESC LIMIT ?`,
    ).all(scheduleId, limit) as ScheduleRun[];
  }
}

let _store: ScheduleStore | null = null;
export function getScheduleStore(): ScheduleStore {
  if (!_store) _store = new ScheduleStore();
  return _store;
}
