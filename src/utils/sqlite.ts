import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { logger } from './logger.js';

const connections = new Map<string, Database.Database>();

export function openDatabase(filePath: string): Database.Database {
  if (connections.has(filePath)) {
    return connections.get(filePath)!;
  }
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  connections.set(filePath, db);
  return db;
}

export function closeAll(): void {
  for (const db of connections.values()) {
    try {
      db.close();
    } catch (err) {
      // Cleanup path — keep closing the rest, but surface DB-locked/corruption signals.
      logger.debug('sqlite close failed', { err });
    }
  }
  connections.clear();
}
