/**
 * Desk persistence. One JSON board plus an append-only audit log, both under
 * ~/.qodex/desks/. The audit is the Muse-style trail: every hold, approval,
 * denial, and handoff is a line you can read later.
 */
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { emptyBoard, type AuditEvent, type Board } from './board.js';
import { withLock } from '../utils/file-lock.js';

export function desksDir(): string {
  // Honor HOME at call time. os.homedir() is cached for the process, which
  // makes tests (and a user who exports HOME) write the board in the wrong place.
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.join(home, '.qodex', 'desks');
}

function boardPath(): string {
  return path.join(desksDir(), 'board.json');
}

function auditPath(): string {
  return path.join(desksDir(), 'audit.jsonl');
}

export function sharedComputerDir(): string {
  return path.join(desksDir(), 'computer');
}

/** The folder every desk shares — the local stand-in for one shared computer. */
export async function ensureSharedComputer(): Promise<string> {
  const dir = sharedComputerDir();
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export function deskLockPath(): string {
  return path.join(desksDir(), 'board.lock');
}

/** Serialize read-modify-write of the board. Do not hold this across a model call. */
export async function withDeskLock<T>(fn: () => Promise<T>): Promise<T> {
  await fs.mkdir(desksDir(), { recursive: true });
  return withLock(deskLockPath(), fn);
}

export async function loadBoard(): Promise<Board> {
  try {
    const raw = await fs.readFile(boardPath(), 'utf-8');
    const parsed = JSON.parse(raw) as Board;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.desks)) return emptyBoard();
    return parsed;
  } catch {
    return emptyBoard();
  }
}

export async function saveBoard(board: Board): Promise<void> {
  const dir = desksDir();
  await fs.mkdir(dir, { recursive: true });
  const dest = boardPath();
  const tmp = dest + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(board, null, 2), 'utf-8');
  await fs.rename(tmp, dest);
}

export async function appendAudit(event: AuditEvent): Promise<void> {
  const dir = desksDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(auditPath(), JSON.stringify(event) + '\n', 'utf-8');
}

export async function readAudit(limit = 40): Promise<AuditEvent[]> {
  try {
    const raw = await fs.readFile(auditPath(), 'utf-8');
    const rows = raw.split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line) as AuditEvent; } catch { return null; }
    }).filter((x): x is AuditEvent => !!x);
    return rows.slice(-limit);
  } catch {
    return [];
  }
}
