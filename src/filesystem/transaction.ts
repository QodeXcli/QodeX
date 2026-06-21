import { promises as fs } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import simpleGit, { SimpleGit } from 'simple-git';
import type Database from 'better-sqlite3';
import { openDatabase } from '../utils/sqlite.js';
import { QODEX_TXN_DB, QODEX_BLOBS_DIR } from '../config/defaults.js';
import { logger } from '../utils/logger.js';
import { writeFileAtomic } from '../utils/atomic-write.js';

export type FileOperation = 'write' | 'delete' | 'create' | 'rename';

export interface JournaledOp {
  operation: FileOperation;
  path: string;
  beforeHash: string | null;
  afterHash: string | null;
  beforeContent?: string;
  afterContent?: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  txn_id INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  operation TEXT NOT NULL,
  path TEXT NOT NULL,
  before_hash TEXT,
  after_hash TEXT,
  git_commit_sha TEXT,
  git_status TEXT,
  git_fail_reason TEXT,
  tool_call_id TEXT,
  status TEXT NOT NULL DEFAULT 'committed',
  summary TEXT
);
CREATE INDEX IF NOT EXISTS idx_session ON transactions(session_id);
CREATE INDEX IF NOT EXISTS idx_txn ON transactions(txn_id);
CREATE INDEX IF NOT EXISTS idx_timestamp ON transactions(timestamp DESC);

CREATE TABLE IF NOT EXISTS counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT OR IGNORE INTO counters (name, value) VALUES ('next_txn_id', 1);

-- Idempotent migration: add new columns if upgrading from a v0.1.0 db
`;

const MIGRATIONS: Array<{ check: string; sql: string }> = [
  { check: "PRAGMA table_info(transactions)", sql: "ALTER TABLE transactions ADD COLUMN git_status TEXT" },
  { check: "PRAGMA table_info(transactions)", sql: "ALTER TABLE transactions ADD COLUMN git_fail_reason TEXT" },
];

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export class Transaction {
  private ops: JournaledOp[] = [];
  private status: 'open' | 'committed' | 'rolled-back' = 'open';
  private gitSha: string | null = null;

  constructor(
    public readonly id: number,
    private journal: TransactionJournal,
    public readonly sessionId: string,
    private toolCallId?: string,
  ) {}

  async write(filePath: string, content: string): Promise<void> {
    this.ensureOpen();
    const abs = path.resolve(filePath);

    let beforeContent: string | null = null;
    let beforeHash: string | null = null;
    let isCreate = false;

    try {
      beforeContent = await fs.readFile(abs, 'utf-8');
      beforeHash = hashContent(beforeContent);
    } catch (e: any) {
      if (e.code === 'ENOENT') {
        isCreate = true;
      } else {
        throw e;
      }
    }

    // ─── Pre-commit syntax gate ───
    // Parse the candidate content (tree-sitter, in-process) BEFORE it touches the
    // disk. Refuses only when the edit would turn a clean-parsing file into a broken
    // one (baseline tolerance) — see syntax-check.ts. The throw surfaces to the model
    // as a [SYNTAX_REJECTED] tool-result observation; the file on disk stays intact.
    // Rollback/undo paths use fs.writeFile directly and are NOT gated.
    // Off-switch: discipline.syntaxGate: false
    {
      const { checkSyntaxForWrite } = await import('../tools/ast/syntax-check.js');
      const rejection = await checkSyntaxForWrite(abs, beforeContent, content);
      if (rejection) {
        logger.info('Syntax gate refused write', { txnId: this.id, path: abs });
        throw new Error(rejection);
      }
    }

    if (beforeContent !== null) {
      await this.journal.storeBlob(beforeHash!, beforeContent);
    }

    const afterHash = hashContent(content);
    await this.journal.storeBlob(afterHash, content);

    await fs.mkdir(path.dirname(abs), { recursive: true });
    await writeFileAtomic(abs, content, { encoding: 'utf-8' });

    this.ops.push({
      operation: isCreate ? 'create' : 'write',
      path: abs,
      beforeHash,
      afterHash,
      beforeContent: beforeContent ?? undefined,
      afterContent: content,
    });

    logger.debug('Transaction write', { txnId: this.id, path: abs, isCreate });
  }

  async delete(filePath: string): Promise<void> {
    this.ensureOpen();
    const abs = path.resolve(filePath);
    const content = await fs.readFile(abs, 'utf-8');
    const hash = hashContent(content);
    await this.journal.storeBlob(hash, content);

    await fs.unlink(abs);

    this.ops.push({
      operation: 'delete',
      path: abs,
      beforeHash: hash,
      afterHash: null,
      beforeContent: content,
    });
  }

  async commit(summary?: string): Promise<string | null> {
    this.ensureOpen();
    if (this.ops.length === 0) {
      this.status = 'committed';
      return null;
    }

    // Try git commit — categorize failures.
    let gitStatus: 'committed' | 'skipped-not-a-repo' | 'skipped-gitignored' | 'failed' = 'skipped-not-a-repo';
    let gitFailReason: string | null = null;
    try {
      const git = simpleGit(process.cwd());
      const isRepo = await git.checkIsRepo();
      if (isRepo) {
        const relPaths = this.ops.map(o => path.relative(process.cwd(), o.path));

        // Filter out paths that are ignored — git add will refuse them and abort the whole add.
        const trackable: string[] = [];
        const ignored: string[] = [];
        try {
          // simple-git checkIgnore returns paths that ARE ignored
          const ignoredPaths = await git.checkIgnore(relPaths);
          for (const p of relPaths) {
            if (ignoredPaths.includes(p)) ignored.push(p);
            else trackable.push(p);
          }
        } catch {
          // If checkIgnore fails for any reason, attempt to add everything
          trackable.push(...relPaths);
        }

        if (ignored.length > 0) {
          logger.warn('Git: some files are gitignored, transaction journal still tracks them', {
            ignored,
            txnId: this.id,
          });
          gitFailReason = `Gitignored (not in git): ${ignored.join(', ')}`;
        }

        if (trackable.length > 0) {
          try {
            await git.add(trackable);
            const commit = await git.commit(
              `[qodex] txn ${this.id}: ${summary ?? this.autoSummary()}`,
              undefined,
              { '--allow-empty': null, '--no-verify': null },
            );
            this.gitSha = commit.commit;
            gitStatus = 'committed';
          } catch (commitErr: any) {
            gitStatus = 'failed';
            gitFailReason = commitErr.message ?? String(commitErr);
            logger.warn('Git commit failed but transaction journal succeeded', {
              reason: gitFailReason,
              txnId: this.id,
            });
          }
        } else if (ignored.length === relPaths.length) {
          gitStatus = 'skipped-gitignored';
        }
      }
    } catch (e: any) {
      logger.debug('Git step skipped', { err: e.message });
    }

    // Always persist the ops to our journal — undo works regardless of git status.
    this.journal.persistOps(
      this.id,
      this.sessionId,
      this.ops,
      this.gitSha,
      this.toolCallId,
      summary,
      gitStatus,
      gitFailReason,
    );
    this.gitStatus = gitStatus;
    this.gitFailReason = gitFailReason;
    this.status = 'committed';
    return this.gitSha;
  }

  /** Information about whether git tracked this transaction. Surface to user after commit. */
  public gitStatus: 'committed' | 'skipped-not-a-repo' | 'skipped-gitignored' | 'failed' = 'skipped-not-a-repo';
  public gitFailReason: string | null = null;

  async rollback(): Promise<void> {
    if (this.status === 'rolled-back') return;

    for (const op of [...this.ops].reverse()) {
      try {
        if (op.operation === 'write' || op.operation === 'create') {
          if (op.beforeContent !== undefined) {
            await writeFileAtomic(op.path, op.beforeContent, { encoding: 'utf-8' });
          } else {
            await fs.unlink(op.path).catch(() => {});
          }
        } else if (op.operation === 'delete' && op.beforeContent !== undefined) {
          await fs.mkdir(path.dirname(op.path), { recursive: true });
          await writeFileAtomic(op.path, op.beforeContent, { encoding: 'utf-8' });
        }
      } catch (e: any) {
        logger.warn('Rollback step failed', { path: op.path, err: e.message });
      }
    }

    this.status = 'rolled-back';
    this.journal.markRolledBack(this.id);
  }

  get fileCount(): number {
    return this.ops.length;
  }

  get operations(): readonly JournaledOp[] {
    return this.ops;
  }

  private ensureOpen(): void {
    if (this.status !== 'open') {
      throw new Error(`Transaction ${this.id} is ${this.status}`);
    }
  }

  private autoSummary(): string {
    const first = this.ops.slice(0, 3).map(o => `${o.operation} ${path.basename(o.path)}`).join(', ');
    return first + (this.ops.length > 3 ? ` +${this.ops.length - 3} more` : '');
  }
}

export class TransactionJournal {
  readonly db: Database.Database;
  private blobsDir: string;
  private writeStmt: Database.Statement;
  private incrementStmt: Database.Statement;
  private getNextIdStmt: Database.Statement;
  private markRolledBackStmt: Database.Statement;

  constructor(dbPath: string = QODEX_TXN_DB, blobsDir: string = QODEX_BLOBS_DIR) {
    this.db = openDatabase(dbPath);
    this.db.exec(SCHEMA);

    // Idempotent migrations: add columns if upgrading from v0.1.0
    const existingCols = this.db.prepare("PRAGMA table_info(transactions)").all() as Array<{ name: string }>;
    const colNames = new Set(existingCols.map(c => c.name));
    if (!colNames.has('git_status')) {
      try { this.db.exec("ALTER TABLE transactions ADD COLUMN git_status TEXT"); } catch {}
    }
    if (!colNames.has('git_fail_reason')) {
      try { this.db.exec("ALTER TABLE transactions ADD COLUMN git_fail_reason TEXT"); } catch {}
    }

    this.blobsDir = blobsDir;

    this.writeStmt = this.db.prepare(`
      INSERT INTO transactions
        (txn_id, session_id, operation, path, before_hash, after_hash, git_commit_sha, git_status, git_fail_reason, tool_call_id, summary)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.incrementStmt = this.db.prepare(`UPDATE counters SET value = value + 1 WHERE name = 'next_txn_id'`);
    this.getNextIdStmt = this.db.prepare(`SELECT value FROM counters WHERE name = 'next_txn_id'`);
    this.markRolledBackStmt = this.db.prepare(`UPDATE transactions SET status = 'rolled-back' WHERE txn_id = ?`);
  }

  async begin(sessionId: string, toolCallId?: string): Promise<Transaction> {
    await fs.mkdir(this.blobsDir, { recursive: true });
    const row = this.getNextIdStmt.get() as { value: number };
    const txnId = row.value;
    this.incrementStmt.run();
    return new Transaction(txnId, this, sessionId, toolCallId);
  }

  persistOps(
    txnId: number,
    sessionId: string,
    ops: JournaledOp[],
    gitSha: string | null,
    toolCallId: string | undefined,
    summary: string | undefined,
    gitStatus?: string,
    gitFailReason?: string | null,
  ): void {
    const tx = this.db.transaction(() => {
      for (const op of ops) {
        this.writeStmt.run(
          txnId, sessionId, op.operation, op.path,
          op.beforeHash, op.afterHash, gitSha, gitStatus ?? null, gitFailReason ?? null,
          toolCallId ?? null, summary ?? null,
        );
      }
    });
    tx();
  }

  markRolledBack(txnId: number): void {
    this.markRolledBackStmt.run(txnId);
  }

  async storeBlob(hash: string, content: string): Promise<void> {
    const blobPath = path.join(this.blobsDir, hash.slice(0, 2), hash);
    await fs.mkdir(path.dirname(blobPath), { recursive: true });
    try {
      await fs.access(blobPath);
      return;
    } catch {}
    await writeFileAtomic(blobPath, content, { encoding: 'utf-8' });
  }

  async loadBlob(hash: string): Promise<string> {
    const blobPath = path.join(this.blobsDir, hash.slice(0, 2), hash);
    return await fs.readFile(blobPath, 'utf-8');
  }

  /** Rollback every committed transaction in a session, newest first. */
  async rollbackSession(sessionId: string): Promise<{ filesRestored: number; txnsRolled: number }> {
    const rows = this.db.prepare(`
      SELECT * FROM transactions WHERE session_id = ? AND status = 'committed'
      ORDER BY id DESC
    `).all(sessionId) as any[];

    let filesRestored = 0;
    const txnIds = new Set<number>();

    for (const row of rows) {
      try {
        if (row.before_hash) {
          const content = await this.loadBlob(row.before_hash);
          await fs.mkdir(path.dirname(row.path), { recursive: true });
          await writeFileAtomic(row.path, content, { encoding: 'utf-8' });
          filesRestored++;
        } else if (row.operation === 'write' || row.operation === 'create') {
          await fs.unlink(row.path).catch(() => {});
          filesRestored++;
        }
        txnIds.add(row.txn_id);
      } catch (e: any) {
        logger.warn('Failed to rollback op', { id: row.id, err: e.message });
      }
    }

    const tx = this.db.transaction(() => {
      for (const id of txnIds) this.markRolledBackStmt.run(id);
    });
    tx();

    return { filesRestored, txnsRolled: txnIds.size };
  }

  /** Roll back the last N transactions in a session. */
  async rollbackLast(sessionId: string, count: number): Promise<{ filesRestored: number; txnsRolled: number }> {
    const txnRows = this.db.prepare(`
      SELECT DISTINCT txn_id FROM transactions WHERE session_id = ? AND status = 'committed'
      ORDER BY txn_id DESC LIMIT ?
    `).all(sessionId, count) as { txn_id: number }[];

    if (txnRows.length === 0) return { filesRestored: 0, txnsRolled: 0 };

    const placeholders = txnRows.map(() => '?').join(',');
    const ids = txnRows.map(r => r.txn_id);
    const ops = this.db.prepare(`
      SELECT * FROM transactions WHERE txn_id IN (${placeholders}) AND status = 'committed'
      ORDER BY id DESC
    `).all(...ids) as any[];

    let filesRestored = 0;
    for (const row of ops) {
      try {
        if (row.before_hash) {
          const content = await this.loadBlob(row.before_hash);
          await fs.mkdir(path.dirname(row.path), { recursive: true });
          await writeFileAtomic(row.path, content, { encoding: 'utf-8' });
          filesRestored++;
        } else if (row.operation === 'write' || row.operation === 'create') {
          await fs.unlink(row.path).catch(() => {});
          filesRestored++;
        }
      } catch (e: any) {
        logger.warn('Rollback failed', { err: e.message });
      }
    }

    const tx = this.db.transaction(() => {
      for (const id of ids) this.markRolledBackStmt.run(id);
    });
    tx();

    return { filesRestored, txnsRolled: ids.length };
  }

  listRecentTransactions(sessionId: string, limit = 20): Array<{
    txn_id: number;
    timestamp: string;
    fileCount: number;
    summary: string | null;
    status: string;
  }> {
    return this.db.prepare(`
      SELECT txn_id, MAX(timestamp) as timestamp, COUNT(*) as fileCount, MAX(summary) as summary, MAX(status) as status
      FROM transactions WHERE session_id = ?
      GROUP BY txn_id
      ORDER BY txn_id DESC
      LIMIT ?
    `).all(sessionId, limit) as any[];
  }
}

let _journal: TransactionJournal | null = null;
export function getJournal(): TransactionJournal {
  if (!_journal) _journal = new TransactionJournal();
  return _journal;
}
