/**
 * Telemetry service.
 *
 * QodeX's telemetry is intentionally LOCAL-ONLY and opt-in. Nothing is sent
 * anywhere — the data is written to `~/.qodex/telemetry.db` (sqlite) and used
 * for two things:
 *
 *   1. The `/stats` slash command — show user what they've been doing
 *      (which tools, how often, success rate, total tokens, cost).
 *   2. The router's task classifier — for "preferLocal" decisions, knowing
 *      "this user has run X tool with Y model 100x with 98% success" lets
 *      future calls skip the cloud roundtrip with confidence.
 *
 * Privacy stance:
 *   - No phone-home. No external endpoint, ever.
 *   - No PII captured (no prompts, no responses, no file paths beyond cwd).
 *   - Only counts + durations + outcomes.
 *   - Disabled by default; opt-in via config `telemetry.enabled: true` or
 *     `/telemetry on`.
 *   - `/telemetry clear` wipes the local DB.
 *
 * What we DO record (per event):
 *   - timestamp
 *   - cwd (hashed if anonymize=true)
 *   - tool name
 *   - duration ms
 *   - success boolean
 *   - tokens in/out (if from LLM call)
 *   - model used
 *   - cost USD (calculated, not retrieved)
 *
 * What we DON'T:
 *   - Tool arguments
 *   - File contents
 *   - Prompts / responses
 *   - Filesystem paths beyond the cwd
 *   - User identity
 */

import Database from 'better-sqlite3';
import { QODEX_TELEMETRY_DB } from '../config/defaults.js';
import { logger } from './logger.js';
import { createHash } from 'crypto';

export interface ToolEvent {
  timestamp: number;
  cwd: string;
  tool: string;
  durationMs: number;
  success: boolean;
  errorClass?: string; // e.g. "TIMEOUT", "PERMISSION_DENIED" — for aggregation, not raw error text
}

export interface LlmEvent {
  timestamp: number;
  cwd: string;
  provider: string;
  model: string;
  role: string; // 'parent' | 'subagent' | 'vision' | etc
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  costUsd: number;
  success: boolean;
}

export interface ToolStats {
  tool: string;
  totalCalls: number;
  successCount: number;
  failCount: number;
  avgDurationMs: number;
  totalDurationMs: number;
}

export interface ModelStats {
  provider: string;
  model: string;
  role: string;
  callCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  avgDurationMs: number;
}

class TelemetryService {
  private db: Database.Database | null = null;
  private enabled = false;
  private anonymizeCwd = false;

  /** Lazy init — only opens the DB the first time something tries to record. */
  private ensureOpen(): Database.Database | null {
    if (!this.enabled) return null;
    if (this.db) return this.db;
    try {
      this.db = new Database(QODEX_TELEMETRY_DB);
      this.db.pragma('journal_mode = WAL');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS tool_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          cwd TEXT NOT NULL,
          tool TEXT NOT NULL,
          duration_ms INTEGER NOT NULL,
          success INTEGER NOT NULL,
          error_class TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_tool_events_tool ON tool_events(tool);
        CREATE INDEX IF NOT EXISTS idx_tool_events_cwd ON tool_events(cwd);

        CREATE TABLE IF NOT EXISTS llm_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          cwd TEXT NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          role TEXT NOT NULL,
          input_tokens INTEGER NOT NULL,
          output_tokens INTEGER NOT NULL,
          duration_ms INTEGER NOT NULL,
          cost_usd REAL NOT NULL,
          success INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_llm_events_model ON llm_events(model);
        CREATE INDEX IF NOT EXISTS idx_llm_events_role ON llm_events(role);
      `);
      return this.db;
    } catch (e: any) {
      logger.warn('Telemetry DB open failed; disabling for this session', { err: e?.message });
      this.enabled = false;
      return null;
    }
  }

  setEnabled(enabled: boolean, anonymize = false): void {
    this.enabled = enabled;
    this.anonymizeCwd = anonymize;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private maskCwd(cwd: string): string {
    if (!this.anonymizeCwd) return cwd;
    // sha256 prefix — stable across sessions but not reversible
    return 'cwd_' + createHash('sha256').update(cwd).digest('hex').slice(0, 12);
  }

  recordTool(event: ToolEvent): void {
    const db = this.ensureOpen();
    if (!db) return;
    try {
      db.prepare(
        `INSERT INTO tool_events (ts, cwd, tool, duration_ms, success, error_class) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(event.timestamp, this.maskCwd(event.cwd), event.tool, event.durationMs, event.success ? 1 : 0, event.errorClass ?? null);
    } catch (e: any) {
      logger.debug('Telemetry recordTool failed', { err: e?.message });
    }
  }

  recordLlm(event: LlmEvent): void {
    const db = this.ensureOpen();
    if (!db) return;
    try {
      db.prepare(
        `INSERT INTO llm_events (ts, cwd, provider, model, role, input_tokens, output_tokens, duration_ms, cost_usd, success)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        event.timestamp,
        this.maskCwd(event.cwd),
        event.provider,
        event.model,
        event.role,
        event.inputTokens,
        event.outputTokens,
        event.durationMs,
        event.costUsd,
        event.success ? 1 : 0,
      );
    } catch (e: any) {
      logger.debug('Telemetry recordLlm failed', { err: e?.message });
    }
  }

  /** Tool stats over the last N days. */
  getToolStats(daysBack = 30, cwd?: string): ToolStats[] {
    const db = this.ensureOpen();
    if (!db) return [];
    const since = Date.now() - daysBack * 24 * 60 * 60 * 1000;
    const whereCwd = cwd ? ' AND cwd = ?' : '';
    const params: (string | number)[] = [since];
    if (cwd) params.push(this.maskCwd(cwd));
    const rows = db.prepare(`
      SELECT tool,
             COUNT(*) as totalCalls,
             SUM(success) as successCount,
             SUM(1 - success) as failCount,
             AVG(duration_ms) as avgDurationMs,
             SUM(duration_ms) as totalDurationMs
      FROM tool_events
      WHERE ts >= ?${whereCwd}
      GROUP BY tool
      ORDER BY totalCalls DESC
    `).all(...params) as ToolStats[];
    return rows;
  }

  /** Model stats over the last N days. */
  getModelStats(daysBack = 30, cwd?: string): ModelStats[] {
    const db = this.ensureOpen();
    if (!db) return [];
    const since = Date.now() - daysBack * 24 * 60 * 60 * 1000;
    const whereCwd = cwd ? ' AND cwd = ?' : '';
    const params: (string | number)[] = [since];
    if (cwd) params.push(this.maskCwd(cwd));
    const rows = db.prepare(`
      SELECT provider, model, role,
             COUNT(*) as callCount,
             SUM(input_tokens) as totalInputTokens,
             SUM(output_tokens) as totalOutputTokens,
             SUM(cost_usd) as totalCostUsd,
             AVG(duration_ms) as avgDurationMs
      FROM llm_events
      WHERE ts >= ?${whereCwd}
      GROUP BY provider, model, role
      ORDER BY callCount DESC
    `).all(...params) as ModelStats[];
    return rows;
  }

  /** Wipe local telemetry DB. */
  clear(): { toolEventsDeleted: number; llmEventsDeleted: number } {
    const db = this.ensureOpen();
    if (!db) return { toolEventsDeleted: 0, llmEventsDeleted: 0 };
    const t = db.prepare('DELETE FROM tool_events').run();
    const l = db.prepare('DELETE FROM llm_events').run();
    return { toolEventsDeleted: t.changes, llmEventsDeleted: l.changes };
  }
}

let _telemetry: TelemetryService | null = null;
export function getTelemetry(): TelemetryService {
  if (!_telemetry) _telemetry = new TelemetryService();
  return _telemetry;
}
