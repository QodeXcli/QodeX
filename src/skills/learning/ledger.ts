/**
 * Learning ledger — an append-only event log so the loop has METRICS (the "فاقد متریک"
 * gap). Every capture / promote / reject / merge appends one JSONL line to
 * ~/.qodex/learning-events.jsonl; `readLearningStats` aggregates it for the
 * `qodex skill learning-stats` dashboard. Best-effort: logging a metric must never
 * break the task or the curate run.
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../../utils/logger.js';

export type LearningEventKind = 'capture' | 'promote' | 'reject' | 'merge';

export interface LearningEvent {
  ts: string;
  event: LearningEventKind;
  name: string;
  /** Confidence at capture time (capture events only). */
  confidence?: number;
  /** Independent judge model (promote/reject events). */
  judge?: string;
  /** For merge: the names that were collapsed. */
  from?: string[];
}

export function ledgerPath(): string {
  return path.join(os.homedir(), '.qodex', 'learning-events.jsonl');
}

export async function recordLearningEvent(ev: Omit<LearningEvent, 'ts'>): Promise<void> {
  try {
    const full = ledgerPath();
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.appendFile(full, JSON.stringify({ ts: new Date().toISOString(), ...ev }) + '\n', 'utf-8');
  } catch (e: any) {
    logger.debug('Learning event not recorded', { err: e?.message });
  }
}

export interface LearningStats {
  captured: number;
  promoted: number;
  rejected: number;
  merged: number;
  /** promoted / (promoted + rejected), 0 when no decisions yet. */
  promotionRate: number;
  avgConfidence: number | null;
  pendingCandidates: number;
  lastEventAt: string | null;
}

/** Aggregate the ledger (+ a live pending-candidate count) into dashboard stats. PURE
 *  over the event list so it's unit-testable; the I/O wrapper reads the file. */
export function aggregateStats(events: LearningEvent[], pendingCandidates: number): LearningStats {
  let captured = 0, promoted = 0, rejected = 0, merged = 0, confSum = 0, confN = 0;
  for (const e of events) {
    if (e.event === 'capture') { captured++; if (typeof e.confidence === 'number') { confSum += e.confidence; confN++; } }
    else if (e.event === 'promote') promoted++;
    else if (e.event === 'reject') rejected++;
    else if (e.event === 'merge') merged++;
  }
  const decisions = promoted + rejected;
  return {
    captured, promoted, rejected, merged,
    promotionRate: decisions ? promoted / decisions : 0,
    avgConfidence: confN ? Math.round(confSum / confN) : null,
    pendingCandidates,
    lastEventAt: events.length ? events[events.length - 1]!.ts : null,
  };
}

export async function readLearningEvents(): Promise<LearningEvent[]> {
  try {
    const raw = await fs.readFile(ledgerPath(), 'utf-8');
    return raw.split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l) as LearningEvent; } catch { return null; } }).filter(Boolean) as LearningEvent[];
  } catch {
    return [];
  }
}
