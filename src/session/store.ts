import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { openDatabase } from '../utils/sqlite.js';
import { QODEX_SESSION_DB } from '../config/defaults.js';

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface SessionMeta {
  id: string;
  cwd: string;
  created_at: string;
  updated_at: string;
  title: string | null;
  model: string;
  status: 'active' | 'completed' | 'cancelled';
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  turn_count: number;
}

export type WorklogKind = 'work' | 'decision' | 'blocker' | 'note';

export interface ProjectMeta {
  cwd: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorklogEntry {
  kind: WorklogKind;
  entry: string;
  created_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  cwd TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  title TEXT,
  model TEXT,
  status TEXT DEFAULT 'active',
  total_input_tokens INTEGER DEFAULT 0,
  total_output_tokens INTEGER DEFAULT 0,
  total_cost_usd REAL DEFAULT 0,
  turn_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_number INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT,
  tool_calls_json TEXT,
  tool_call_id TEXT,
  name TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_session_messages ON messages(session_id, turn_number);

CREATE TABLE IF NOT EXISTS session_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  fact TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'project',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_facts_cwd ON session_facts(cwd);

CREATE TABLE IF NOT EXISTS projects (
  cwd TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS project_worklog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cwd TEXT NOT NULL,
  session_id TEXT,
  kind TEXT NOT NULL DEFAULT 'work',
  entry TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_worklog_cwd ON project_worklog(cwd);
`;
// NOTE: the idx_facts_scope index is created in the constructor AFTER the scope
// column is guaranteed to exist (see migration) — on an older DB the column
// doesn't exist yet when this base schema runs, so indexing it here would throw.

export class SessionStore {
  private db: Database.Database;
  private insertSession: Database.Statement;
  private updateSessionWithTurn: Database.Statement;
  private updateSessionNoTurn: Database.Statement;
  private insertMessage: Database.Statement;
  private getMessagesStmt: Database.Statement;

  constructor(dbPath: string = QODEX_SESSION_DB) {
    this.db = openDatabase(dbPath);
    this.db.exec(SCHEMA);

    // Migration: older DBs have session_facts without a `scope` column. Add it,
    // defaulting existing rows to 'project' (the only scope that existed before).
    const factCols = this.db.prepare(`PRAGMA table_info(session_facts)`).all() as Array<{ name: string }>;
    if (!factCols.some(c => c.name === 'scope')) {
      this.db.exec(`ALTER TABLE session_facts ADD COLUMN scope TEXT NOT NULL DEFAULT 'project'`);
    }
    // Safe now that the column is guaranteed to exist (new schema or just-migrated).
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_scope ON session_facts(scope)`);

    this.insertSession = this.db.prepare(`
      INSERT INTO sessions (id, cwd, model, title) VALUES (?, ?, ?, ?)
    `);
    // Bump turn_count only when this batch contains a user message
    this.updateSessionWithTurn = this.db.prepare(`
      UPDATE sessions SET
        updated_at = CURRENT_TIMESTAMP,
        total_input_tokens = total_input_tokens + ?,
        total_output_tokens = total_output_tokens + ?,
        total_cost_usd = total_cost_usd + ?,
        turn_count = turn_count + 1,
        title = COALESCE(title, ?)
      WHERE id = ?
    `);
    // Update usage without bumping turn_count (for assistant/tool messages)
    this.updateSessionNoTurn = this.db.prepare(`
      UPDATE sessions SET
        updated_at = CURRENT_TIMESTAMP,
        total_input_tokens = total_input_tokens + ?,
        total_output_tokens = total_output_tokens + ?,
        total_cost_usd = total_cost_usd + ?
      WHERE id = ?
    `);
    this.insertMessage = this.db.prepare(`
      INSERT INTO messages (session_id, turn_number, role, content, tool_calls_json, tool_call_id, name)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.getMessagesStmt = this.db.prepare(`
      SELECT * FROM messages WHERE session_id = ? ORDER BY turn_number ASC, id ASC
    `);
  }

  createSession(cwd: string, model: string): string {
    const id = uuidv4();
    this.insertSession.run(id, cwd, model, null);
    return id;
  }

  recordTurn(
    sessionId: string,
    messages: Message[],
    usage: { input: number; output: number; costUsd: number },
    title?: string,
  ): void {
    const hasUserMessage = messages.some(m => m.role === 'user');
    // Reuse the same turn_number for all messages in this batch.
    // Only bump to a new turn_number when this batch starts a new user turn.
    const currentMax = this.getCurrentTurnNumber(sessionId);
    const turnNumber = hasUserMessage ? currentMax + 1 : Math.max(currentMax, 1);

    const tx = this.db.transaction(() => {
      for (const msg of messages) {
        this.insertMessage.run(
          sessionId,
          turnNumber,
          msg.role,
          msg.content ?? null,
          msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
          msg.tool_call_id ?? null,
          msg.name ?? null,
        );
      }
      if (hasUserMessage) {
        this.updateSessionWithTurn.run(usage.input, usage.output, usage.costUsd, title ?? null, sessionId);
      } else {
        this.updateSessionNoTurn.run(usage.input, usage.output, usage.costUsd, sessionId);
      }
    });
    tx();
  }

  private getCurrentTurnNumber(sessionId: string): number {
    const row = this.db.prepare(
      `SELECT MAX(turn_number) as max FROM messages WHERE session_id = ?`,
    ).get(sessionId) as { max: number | null };
    return row.max ?? 0;
  }

  loadSession(sessionId: string): { meta: SessionMeta; messages: Message[] } | null {
    const meta = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(sessionId) as
      | SessionMeta
      | undefined;
    if (!meta) return null;
    const rows = this.getMessagesStmt.all(sessionId) as any[];
    const messages: Message[] = rows.map(r => ({
      role: r.role,
      content: r.content,
      tool_calls: r.tool_calls_json ? JSON.parse(r.tool_calls_json) : undefined,
      tool_call_id: r.tool_call_id ?? undefined,
      name: r.name ?? undefined,
    }));
    return { meta, messages };
  }

  listRecentSessions(limit = 20, cwd?: string): SessionMeta[] {
    if (cwd) {
      return this.db.prepare(
        `SELECT * FROM sessions WHERE cwd = ? ORDER BY updated_at DESC LIMIT ?`,
      ).all(cwd, limit) as SessionMeta[];
    }
    return this.db.prepare(
      `SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?`,
    ).all(limit) as SessionMeta[];
  }

  markStatus(sessionId: string, status: 'active' | 'completed' | 'cancelled'): void {
    this.db.prepare(`UPDATE sessions SET status = ? WHERE id = ?`).run(status, sessionId);
  }

  /** Delete all messages from a session and reset counters. Session row remains. */
  clearMessages(sessionId: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(sessionId);
      this.db.prepare(`
        UPDATE sessions SET
          turn_count = 0,
          total_input_tokens = 0,
          total_output_tokens = 0,
          total_cost_usd = 0,
          title = NULL,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(sessionId);
    });
    tx();
  }

  /** Delete a session entirely (cascades to messages via FK). */
  deleteSession(sessionId: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
  }

  /**
   * Persist a fact. scope='project' (default) ties it to `cwd`; scope='user'
   * makes it global — surfaced in every session regardless of directory. User
   * facts are stored with a '*' sentinel cwd so they never collide with a real path.
   */
  addFact(sessionId: string, cwd: string, fact: string, scope: 'project' | 'user' = 'project'): void {
    this.db.prepare(`INSERT INTO session_facts (session_id, cwd, fact, scope) VALUES (?, ?, ?, ?)`).run(
      sessionId,
      scope === 'user' ? '*' : cwd,
      fact,
      scope,
    );
  }

  /**
   * Facts to inject for a session in `cwd`: this project's facts PLUS all global
   * user facts. User facts come first so personal preferences lead. Deduped.
   */
  getFactsForCwd(cwd: string, limit = 50): string[] {
    const userRows = this.db.prepare(
      `SELECT DISTINCT fact FROM session_facts WHERE scope = 'user' ORDER BY id DESC LIMIT ?`,
    ).all(limit) as { fact: string }[];
    const projectRows = this.db.prepare(
      `SELECT DISTINCT fact FROM session_facts WHERE cwd = ? AND scope = 'project' ORDER BY id DESC LIMIT ?`,
    ).all(cwd, limit) as { fact: string }[];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of [...userRows, ...projectRows]) {
      if (seen.has(r.fact)) continue;
      seen.add(r.fact);
      out.push(r.fact);
      if (out.length >= limit) break;
    }
    return out;
  }

  /** List facts for a given scope. For 'project', pass the cwd. */
  getFactsByScope(scope: 'project' | 'user', cwd: string, limit = 50): string[] {
    if (scope === 'user') {
      const rows = this.db.prepare(
        `SELECT DISTINCT fact FROM session_facts WHERE scope = 'user' ORDER BY id DESC LIMIT ?`,
      ).all(limit) as { fact: string }[];
      return rows.map(r => r.fact);
    }
    const rows = this.db.prepare(
      `SELECT DISTINCT fact FROM session_facts WHERE cwd = ? AND scope = 'project' ORDER BY id DESC LIMIT ?`,
    ).all(cwd, limit) as { fact: string }[];
    return rows.map(r => r.fact);
  }

  // ---- Project memory: a named project + a human-readable worklog per cwd. ----
  // The cwd is the project key (it already scopes sessions and facts). A project
  // is "defined" by giving that cwd a name/description; the worklog is an
  // append-only log of what was accomplished, surfaced on the next session.

  /** Define or rename the project rooted at `cwd`. Idempotent (upsert). */
  defineProject(cwd: string, name: string, description?: string): void {
    this.db.prepare(`
      INSERT INTO projects (cwd, name, description) VALUES (?, ?, ?)
      ON CONFLICT(cwd) DO UPDATE SET
        name = excluded.name,
        description = COALESCE(excluded.description, projects.description),
        updated_at = CURRENT_TIMESTAMP
    `).run(cwd, name, description ?? null);
  }

  getProject(cwd: string): ProjectMeta | null {
    const row = this.db.prepare(`SELECT * FROM projects WHERE cwd = ?`).get(cwd) as
      | ProjectMeta
      | undefined;
    return row ?? null;
  }

  /** Append one accomplishment/decision/blocker/note to the project's worklog. */
  addWorklogEntry(cwd: string, sessionId: string | null, entry: string, kind: WorklogKind = 'work'): void {
    this.db.prepare(
      `INSERT INTO project_worklog (cwd, session_id, kind, entry) VALUES (?, ?, ?, ?)`,
    ).run(cwd, sessionId, kind, entry);
    // Touch the project's updated_at if a project row exists for this cwd.
    this.db.prepare(`UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE cwd = ?`).run(cwd);
  }

  getWorklog(cwd: string, limit = 20): WorklogEntry[] {
    return this.db.prepare(
      `SELECT kind, entry, created_at FROM project_worklog WHERE cwd = ? ORDER BY id DESC LIMIT ?`,
    ).all(cwd, limit) as WorklogEntry[];
  }

  /**
   * Synthesize a single "PROJECT MEMORY" brief, injected through the existing
   * facts path (see loop.ts), so a new/resumed session in this directory
   * automatically knows what was done here before — and continues instead of
   * redoing it. Returns null when there's nothing to brief, so the caller skips
   * injection cleanly.
   */
  getProjectBriefingFact(cwd: string, limit = 12): string | null {
    const project = this.getProject(cwd);
    const log = this.getWorklog(cwd, limit);
    if (!project && log.length === 0) return null;

    const lines: string[] = [];
    lines.push('PROJECT MEMORY — what was done in this project in earlier sessions (most recent first).');
    if (project) {
      lines.push(`Project: ${project.name}${project.description ? ` — ${project.description}` : ''}`);
    }
    if (log.length) {
      for (const e of log) {
        const when = (e.created_at ?? '').slice(0, 16).replace('T', ' ');
        const tag = e.kind && e.kind !== 'work' ? `(${e.kind}) ` : '';
        lines.push(`• [${when}] ${tag}${e.entry}`);
      }
      lines.push('Continue from this prior work — do NOT redo what is already done. When you finish another meaningful piece of work, call project_log to record it for the next session.');
    } else {
      lines.push('No work logged yet. As you complete meaningful work, call project_log so it persists for the next session.');
    }
    return lines.join('\n');
  }
}

let _store: SessionStore | null = null;
export function getSessionStore(): SessionStore {
  if (!_store) _store = new SessionStore();
  return _store;
}
