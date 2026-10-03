/**
 * Sentinel audit trail — one JSON line per guarded decision / injection finding
 * in QODEX_SENTINEL_DIR/audit.jsonl (directory injectable for tests).
 *
 * Properties:
 *   - never throws and never blocks the agent: writes are queued on a promise
 *     chain (keeps order) and failures are swallowed after one debug log;
 *   - secrets never land on disk: keys that look sensitive are redacted
 *     (src/utils/redact.ts) and string VALUES that look like cards, IBAN/Sheba,
 *     API keys, tokens or private keys are masked (policy.maskSecrets);
 *     typed text for credential/payment actions is replaced by its length;
 *   - bounded: the file rotates to audit.1.jsonl past `maxBytes` (default 5 MB);
 *   - private: created with mode 0600 (it records which sites you use).
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { QODEX_SENTINEL_DIR } from '../config/paths.js';
import { redactValue } from '../utils/redact.js';
import { logger } from '../utils/logger.js';
import { maskControlTokens, maskSecrets } from './policy.js';

export interface AuditRecord {
  /** 'decision' for guarded tool calls, 'injection' for flagged untrusted output. */
  type: 'decision' | 'injection';
  tool: string;
  /** allow | deny (decisions only). */
  action?: 'allow' | 'deny';
  /** Why: policy | low-risk | auto-approve | session | permission | human | no-human | timeout | error ... */
  via?: string;
  category?: string | null;
  risk?: string;
  domain?: string;
  summary?: string;
  reason?: string;
  /** Approval answer + who answered (local, control, telegram, mission-db ...). */
  answer?: string;
  answeredBy?: string;
  sessionId?: string;
  args?: unknown;
  findings?: Array<{ id: string; excerpt?: string }>;
  source?: string;
}

const MAX_STRING = 300;
const SENSITIVE_VALUE_KEYS = /^(text|value|secret|password|body|totp|code|otp)$/i;

/** Deep-copy `v` with sensitive keys redacted, secrets masked and long strings cut. PURE. */
export function redactForAudit(v: unknown, opts: { hideTyped?: boolean } = {}, key = '', depth = 0): unknown {
  if (depth > 6) return '[…]';
  if (typeof v === 'string') {
    if (opts.hideTyped && SENSITIVE_VALUE_KEYS.test(key)) return `[hidden ${v.length} chars]`;
    const r = redactValue(key, v);
    if (typeof r !== 'string') return r;
    const masked = r === v ? maskControlTokens(maskSecrets(v)) : r;
    return masked.length > MAX_STRING ? masked.slice(0, MAX_STRING) + `…[+${masked.length - MAX_STRING}]` : masked;
  }
  if (Array.isArray(v)) return v.slice(0, 50).map(x => redactForAudit(x, opts, key, depth + 1));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const r = typeof x === 'object' && x !== null ? x : redactValue(k, x);
      out[k] = r === x ? redactForAudit(x, opts, k, depth + 1) : r;
    }
    return out;
  }
  return v;
}

export class SentinelAudit {
  private chain: Promise<void> = Promise.resolve();
  private readonly dir: string;
  private readonly maxBytes: number;
  private warned = false;
  private dirReady = false;

  constructor(opts: { dir?: string; maxBytes?: number } = {}) {
    this.dir = opts.dir ?? QODEX_SENTINEL_DIR;
    this.maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  }

  file(): string {
    return path.join(this.dir, 'audit.jsonl');
  }

  /** Queue one record. Never throws. */
  record(rec: AuditRecord): void {
    let line: string;
    try {
      line = JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n';
    } catch {
      return;
    }
    this.chain = this.chain.then(() => this.write(line)).catch(() => {});
  }

  /** Resolves when everything queued so far is on disk (tests, shutdown). */
  flush(): Promise<void> {
    return this.chain;
  }

  /** Last `limit` records (newest last). Never throws. */
  async tail(limit = 20): Promise<Array<AuditRecord & { ts: string }>> {
    await this.flush();
    try {
      const text = await fs.readFile(this.file(), 'utf-8');
      return text.trim().split('\n').filter(Boolean).slice(-limit).map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
    } catch {
      return [];
    }
  }

  private async write(line: string): Promise<void> {
    try {
      if (!this.dirReady) {
        await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
        this.dirReady = true;
      }
      const file = this.file();
      try {
        const st = await fs.stat(file);
        if (st.size + line.length > this.maxBytes) {
          await fs.rename(file, path.join(this.dir, 'audit.1.jsonl')).catch(() => {});
        }
      } catch { /* no file yet */ }
      try {
        await fs.appendFile(file, line, { encoding: 'utf-8', mode: 0o600 });
      } catch (e: any) {
        if (e?.code !== 'ENOENT') throw e;
        // The directory was removed while we were running: recreate it once, keep auditing.
        await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
        await fs.appendFile(file, line, { encoding: 'utf-8', mode: 0o600 });
      }
    } catch (e: any) {
      if (!this.warned) {
        this.warned = true;
        logger.debug('Sentinel audit write failed', { error: e?.message });
      }
    }
  }
}
