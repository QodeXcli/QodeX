/**
 * CLI ↔ messaging handoff.
 *
 * The interactive TUI writes the active session id AND its working directory
 * here whenever either changes. `/continue` on a bot binds the phone chat to
 * that transcript AND injects this cwd into AgentLoop — tools must never fall
 * back to the bot process's `process.cwd()`, which is just where `qodex bot`
 * was launched.
 *
 * Tiny JSON, best-effort. A missing/stale file just means "no handoff".
 */

import { promises as fs } from 'fs';
import * as fsSync from 'fs';
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

/** True when `cwd` is an existing directory the process can work in. */
export function isUsableCwd(cwd: string): boolean {
  try {
    return fsSync.statSync(cwd).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Pick the working directory for a resumed / handed-off session.
 *
 * Priority: durable session cwd → handoff cwd → host process cwd.
 * A candidate that no longer exists on disk is skipped. PURE besides `exists`.
 */
export function pickWorkingCwd(opts: {
  sessionCwd?: string | null;
  handoffCwd?: string | null;
  hostCwd: string;
  exists?: (abs: string) => boolean;
}): string {
  const exists = opts.exists ?? isUsableCwd;
  for (const raw of [opts.sessionCwd, opts.handoffCwd, opts.hostCwd]) {
    if (!raw) continue;
    const abs = path.resolve(raw);
    if (exists(abs)) return abs;
  }
  return path.resolve(opts.hostCwd);
}
