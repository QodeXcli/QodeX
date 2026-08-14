/**
 * Append-only local audit trail.
 *
 * One JSON line per event at `<cwd>/.qodex/audit.jsonl`. No open at startup —
 * the file is created on the first event. Never throws into the agent loop.
 *
 * What we record: permission decisions that skipped the hub, operator answers
 * (with origin: tui / telegram / whatsapp / …), and tool outcomes. We do not
 * record prompts, file contents, or command stdout.
 */
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger.js';

export type AuditEvent =
  | {
      type: 'permission';
      tool: string;
      operation: string;
      decision: 'allow' | 'deny';
      via: string;
      sessionId?: string;
    }
  | {
      type: 'approval';
      id: string;
      answer: string;
      origin: string;
      source: string;
      lane?: string;
    }
  | {
      type: 'tool';
      tool: string;
      ok: boolean;
      durationMs: number;
      sessionId?: string;
    };

export interface AuditRecord {
  ts: string;
  type: AuditEvent['type'];
  [k: string]: unknown;
}

let pathOverride: string | null = null;

/** Tests point this at a temp file. `null` restores the default. */
export function setAuditLogPath(file: string | null): void {
  pathOverride = file;
}

export function auditLogPath(cwd: string = process.cwd()): string {
  if (pathOverride) return pathOverride;
  if (process.env.QODEX_AUDIT_LOG) return process.env.QODEX_AUDIT_LOG;
  return path.join(cwd, '.qodex', 'audit.jsonl');
}

function clip(s: string, max = 240): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/**
 * Append one event. Silent no-op under vitest unless a path override / env is set,
 * so unit tests do not pollute the project's `.qodex/audit.jsonl`.
 */
export function appendAudit(event: AuditEvent, cwd: string = process.cwd()): void {
  if (process.env.VITEST && !pathOverride && !process.env.QODEX_AUDIT_LOG) return;
  try {
    const file = auditLogPath(cwd);
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const rec: AuditRecord = {
      ts: new Date().toISOString(),
      ...event,
    };
    if (rec.type === 'permission' && typeof rec.operation === 'string') {
      rec.operation = clip(rec.operation);
    }
    fs.appendFileSync(file, JSON.stringify(rec) + '\n', { encoding: 'utf8' });
  } catch (e: any) {
    logger.debug('audit append failed', { err: e?.message });
  }
}
