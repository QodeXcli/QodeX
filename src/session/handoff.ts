/**
 * CLI ↔ messaging handoff.
 *
 * The interactive TUI writes the active session id here whenever it changes.
 * The bot reads it so `/continue` binds the phone conversation to the same
 * transcript — start in the terminal, finish from Telegram, without copying ids.
 *
 * Tiny JSON, best-effort. A missing/stale file just means "no handoff".
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { QODEX_HOME } from '../config/defaults.js';

export interface Handoff {
  sessionId: string;
  cwd: string;
  updatedAt: string;
}

export function handoffPath(): string {
  return path.join(QODEX_HOME, 'handoff.json');
}

export async function writeHandoff(sessionId: string, cwd: string): Promise<void> {
  const rec: Handoff = { sessionId, cwd: path.resolve(cwd), updatedAt: new Date().toISOString() };
  try {
    await fs.mkdir(QODEX_HOME, { recursive: true });
    await fs.writeFile(handoffPath(), JSON.stringify(rec, null, 2), 'utf-8');
  } catch { /* never block the TUI on a handoff write */ }
}

export async function readHandoff(): Promise<Handoff | null> {
  try {
    const raw = JSON.parse(await fs.readFile(handoffPath(), 'utf-8')) as Handoff;
    if (!raw?.sessionId) return null;
    return raw;
  } catch {
    return null;
  }
}

export function formatHandoff(h: Handoff): string {
  const ageMin = Math.max(0, Math.round((Date.now() - Date.parse(h.updatedAt)) / 60_000));
  const age = Number.isFinite(ageMin) ? (ageMin < 1 ? 'just now' : `${ageMin}m ago`) : 'unknown';
  return `session ${h.sessionId.slice(0, 8)}  ·  ${h.cwd}  ·  ${age}`;
}
