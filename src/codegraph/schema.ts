import type Database from 'better-sqlite3';
import { openDatabase } from '../utils/sqlite.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  language TEXT NOT NULL,
  mtime_ms INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  content_hash TEXT,
  indexed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_files_lang ON files(language);

CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  start_col INTEGER NOT NULL,
  parent_symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  signature TEXT
);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export interface FileRow {
  id: number;
  path: string;
  language: string;
  mtime_ms: number;
  size_bytes: number;
  content_hash: string | null;
  indexed_at: string;
}

export interface SymbolRow {
  id: number;
  file_id: number;
  name: string;
  kind: string;
  start_line: number;
  end_line: number;
  start_col: number;
  parent_symbol_id: number | null;
  signature: string | null;
}

export interface ExtractedSymbol {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  startColumn: number;
  parentName?: string;
  signature?: string;
}

export class CodeGraphDB {
  readonly db: Database.Database;
  private upsertFile: Database.Statement;
  private deleteSymbolsForFile: Database.Statement;
  private insertSymbol: Database.Statement;
  private findFileByPath: Database.Statement;
  private deleteFileByPath: Database.Statement;

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath);
    this.db.exec(SCHEMA);

    this.upsertFile = this.db.prepare(`
      INSERT INTO files (path, language, mtime_ms, size_bytes, content_hash, indexed_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(path) DO UPDATE SET
        language=excluded.language,
        mtime_ms=excluded.mtime_ms,
        size_bytes=excluded.size_bytes,
        content_hash=excluded.content_hash,
        indexed_at=CURRENT_TIMESTAMP
    `);
    this.deleteSymbolsForFile = this.db.prepare(`DELETE FROM symbols WHERE file_id = ?`);
    this.insertSymbol = this.db.prepare(`
      INSERT INTO symbols (file_id, name, kind, start_line, end_line, start_col, parent_symbol_id, signature)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.findFileByPath = this.db.prepare(`SELECT * FROM files WHERE path = ?`);
    this.deleteFileByPath = this.db.prepare(`DELETE FROM files WHERE path = ?`);
  }

  /** Returns true if the file's mtime+size+hash match our cached entry → can be skipped. */
  isFileFresh(path: string, mtimeMs: number, sizeBytes: number, contentHash: string | null): boolean {
    const row = this.findFileByPath.get(path) as FileRow | undefined;
    if (!row) return false;
    if (row.mtime_ms !== mtimeMs) return false;
    if (row.size_bytes !== sizeBytes) return false;
    if (contentHash && row.content_hash && row.content_hash !== contentHash) return false;
    return true;
  }

  /** Replace all symbols for a file atomically. */
  replaceFileSymbols(
    path: string,
    language: string,
    mtimeMs: number,
    sizeBytes: number,
    contentHash: string | null,
    symbols: ExtractedSymbol[],
  ): void {
    const tx = this.db.transaction(() => {
      this.upsertFile.run(path, language, mtimeMs, sizeBytes, contentHash);
      const fileRow = this.findFileByPath.get(path) as FileRow;
      this.deleteSymbolsForFile.run(fileRow.id);
      // Two-pass: first insert all symbols, then resolve parent IDs by name within this file
      const nameToId = new Map<string, number>();
      for (const s of symbols) {
        const result = this.insertSymbol.run(
          fileRow.id,
          s.name,
          s.kind,
          s.startLine,
          s.endLine,
          s.startColumn,
          null, // resolved below
          s.signature ?? null,
        );
        nameToId.set(`${s.kind}:${s.name}`, result.lastInsertRowid as number);
      }
      // Second pass: link parents
      const updateParent = this.db.prepare(`UPDATE symbols SET parent_symbol_id = ? WHERE id = ?`);
      for (const s of symbols) {
        if (!s.parentName) continue;
        const childId = nameToId.get(`${s.kind}:${s.name}`);
        // Match parent by name (any kind) within the same file
        const parentSym = this.db.prepare(
          `SELECT id FROM symbols WHERE file_id = ? AND name = ? LIMIT 1`,
        ).get(fileRow.id, s.parentName) as { id: number } | undefined;
        if (childId !== undefined && parentSym) {
          updateParent.run(parentSym.id, childId);
        }
      }
    });
    tx();
  }

  removeFile(path: string): void {
    this.deleteFileByPath.run(path);
  }

  findSymbolsByName(name: string, kind?: string, limit = 50): Array<SymbolRow & { file_path: string }> {
    if (kind) {
      return this.db.prepare(`
        SELECT symbols.*, files.path as file_path
        FROM symbols JOIN files ON files.id = symbols.file_id
        WHERE symbols.name = ? AND symbols.kind = ?
        ORDER BY files.path
        LIMIT ?
      `).all(name, kind, limit) as any[];
    }
    return this.db.prepare(`
      SELECT symbols.*, files.path as file_path
      FROM symbols JOIN files ON files.id = symbols.file_id
      WHERE symbols.name = ?
      ORDER BY files.path
      LIMIT ?
    `).all(name, limit) as any[];
  }

  searchSymbolsByPrefix(prefix: string, kind?: string, limit = 50): Array<SymbolRow & { file_path: string }> {
    const pattern = prefix + '%';
    if (kind) {
      return this.db.prepare(`
        SELECT symbols.*, files.path as file_path
        FROM symbols JOIN files ON files.id = symbols.file_id
        WHERE symbols.name LIKE ? AND symbols.kind = ?
        ORDER BY symbols.name, files.path
        LIMIT ?
      `).all(pattern, kind, limit) as any[];
    }
    return this.db.prepare(`
      SELECT symbols.*, files.path as file_path
      FROM symbols JOIN files ON files.id = symbols.file_id
      WHERE symbols.name LIKE ?
      ORDER BY symbols.name, files.path
      LIMIT ?
    `).all(pattern, limit) as any[];
  }

  listSymbolsInFile(filePath: string): SymbolRow[] {
    return this.db.prepare(`
      SELECT symbols.* FROM symbols
      JOIN files ON files.id = symbols.file_id
      WHERE files.path = ?
      ORDER BY symbols.start_line
    `).all(filePath) as SymbolRow[];
  }

  /** Look up a symbol by its primary-key id (used for resolving parent_symbol_id chains). */
  getSymbolById(id: number): SymbolRow | null {
    return (this.db.prepare(`SELECT * FROM symbols WHERE id = ?`).get(id) as SymbolRow | undefined) ?? null;
  }

  stats(): { files: number; symbols: number; lastIndexed: string | null } {
    const files = (this.db.prepare(`SELECT COUNT(*) as n FROM files`).get() as { n: number }).n;
    const symbols = (this.db.prepare(`SELECT COUNT(*) as n FROM symbols`).get() as { n: number }).n;
    const last = this.db.prepare(`SELECT MAX(indexed_at) as t FROM files`).get() as { t: string | null };
    return { files, symbols, lastIndexed: last.t };
  }

  setMeta(key: string, value: string): void {
    this.db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`).run(key, value);
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }
}
