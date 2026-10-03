/**
 * Mail watcher — wakes up when email arrives, tells the user, and runs the
 * standing tasks (rules) the user gave for it.
 *
 *   qodex mail watch              foreground (Ctrl+C stops it)
 *   qodex mail watch --daemon     detached worker (like mission workers): pid file, log
 *   qodex mail watch --status | --stop
 *   /mail watch [start|stop|status]   (TUI, Telegram)
 *
 * Per account: IMAP IDLE (the server pushes "new message") with a polling fallback
 * (and a periodic poll even while idling). New messages are found by UID above the
 * persisted last-seen UID per account/folder (reset safely on UIDVALIDITY change —
 * history is never replayed), deduplicated by Message-ID. For each new message:
 *
 *   1. scan subject + body for prompt injection (flagged mail never gets an automatic
 *      reply: the received-mail index remembers the flag for Sentinel's grant check);
 *   2. record it in the received-mail index (what "a reply to a message received in
 *      this account" means for a standing reply grant);
 *   3. notify: bus event + control center timeline + Telegram + desktop, with sender,
 *      subject and a short snippet (clipped, secret-masked, escaped by every consumer —
 *      never executed or interpreted);
 *   4. start a run for every matching rule (src/mail/rules.ts): the rule's task is the
 *      trusted instruction, the email is fenced data; flagged mail → draft only.
 *
 * Mail comes from the mail core (src/mail/service.ts): `getMailService().transport(name)`
 * per account — `status` / `list({sinceUid})` / `fetch` / `waitForNew` (IMAP IDLE on its
 * own connection). Tests inject the in-memory transport (setMailServiceForTests) or a
 * WatchSource factory. Credentials never leave the transport: errors go through the
 * service's `errorText` before they reach logs, the bus, notifications or the state file.
 */

import { promises as fs, openSync, closeSync, writeSync, mkdirSync, readFileSync, unlinkSync } from 'fs';
import * as path from 'path';
import { spawn as nodeSpawn, type SpawnOptions } from 'child_process';
import { Command, Option } from 'commander';
import { writeFileAtomic } from '../utils/atomic-write.js';
import { withLock } from '../utils/file-lock.js';
import { logger } from '../utils/logger.js';
import { getActiveConfig } from '../config/loader.js';
import { mailAutoPaths } from '../grants/paths.js';
import { bareAddress } from '../grants/store.js';
import { getReceivedIndex, normalizeMessageId, type ReceivedIndex } from '../grants/received.js';
import { publishMailEvent, cleanLine, recentMailEvents, type MailEventData, type MailEventType } from '../grants/mail-events.js';
import {
  getMailRuleStore, runMatchingRules, scanMail, splitArgs, runMailAutomationCommand,
  type IncomingMail, type MailRuleStore, type RuleRunStarter,
} from './rules.js';
import { getMailService, type MailService } from './service.js';
import { formatAddress, type MailTransport } from './types.js';

// ── sources ───────────────────────────────────────────────────────────────────

/** A message as the watcher needs it (parsed: text body, attachment names). */
export interface WatchMessage {
  uid: number;
  /** The mail tools' id for this message ("<folder>#<uid>": mail_read / mail_draft reply_to_id). */
  id?: string;
  /** Message-ID header (with or without angle brackets). */
  messageId?: string;
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  date?: string;
  attachments?: Array<{ name: string; size?: number }>;
  /** A few headers (auto-submitted, list-id, precedence …): auto-generated mail never gets an auto-reply. */
  headers?: Record<string, string>;
}

export interface WatchSource {
  /** Folder state: UIDVALIDITY and the next UID the server will assign. */
  status(folder: string): Promise<{ uidValidity: string; uidNext: number }>;
  /** Messages with uid ≥ fromUid, ascending, at most `limit`. */
  fetchSince(folder: string, fromUid: number, limit: number): Promise<WatchMessage[]>;
  /**
   * Resolve when the server reports new mail (IMAP IDLE), after `maxMs`, or when
   * `signal` aborts. Absent → the watcher polls.
   */
  waitForChange?(folder: string, maxMs: number, signal: AbortSignal): Promise<void>;
  close?(): Promise<void>;
  /** The account's own address (its own mail never gets an auto-reply). */
  self?: string;
}

export type WatchSourceFactory = (account: string) => Promise<WatchSource>;

/** Every configured mail account (the mail core's encrypted store). Never throws. */
export async function listWatchAccounts(service: MailService = getMailService()): Promise<string[]> {
  try {
    return [...new Set((await service.accounts().list()).map(a => a.name).filter(Boolean))];
  } catch {
    return [];
  }
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  if (signal?.aborted) return resolve();
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); signal?.removeEventListener('abort', done); resolve(); }
  signal?.addEventListener('abort', done, { once: true });
});

/**
 * A WatchSource over the mail core's transport for `account`
 * (`getMailService().transport(name)`): `status` for UIDVALIDITY / UIDNEXT, `list`
 * with `sinceUid` for what is new, `fetch` for the text body, and `waitForNew` (IMAP
 * IDLE on its own connection) to sleep until mail arrives. Every error that leaves it
 * goes through the service's `errorText` (passwords / tokens scrubbed in every encoding).
 */
export async function openMailServiceSource(account: string, service: MailService = getMailService()): Promise<WatchSource> {
  const safe = (e: unknown) => new Error(service.errorText(e));
  let resolved: { account: { name: string; email: string }; transport: MailTransport };
  try { resolved = await service.transport(account); } catch (e) { throw safe(e); }
  const { transport } = resolved;
  const name = resolved.account.name;
  return {
    self: resolved.account.email,
    async status(folder) {
      try {
        if (transport.status) {
          const st = await transport.status(folder);
          return { uidValidity: String(st.uidValidity ?? ''), uidNext: Number(st.uidNext) || 1 };
        }
        // No STATUS support: the newest UID stands in for UIDNEXT (UIDVALIDITY unknown → constant).
        const newest = await transport.list({ folder, limit: 1 });
        return { uidValidity: 'list', uidNext: (newest[0]?.uid ?? 0) + 1 };
      } catch (e) { throw safe(e); }
    },
    async fetchSince(folder, fromUid, limit) {
      try {
        const rows = (await transport.list({ folder, sinceUid: Math.max(0, fromUid - 1), limit }))
          .filter(r => r.uid >= fromUid)
          .sort((a, b) => a.uid - b.uid);
        const out: WatchMessage[] = [];
        for (const r of rows) {
          const m = await transport.fetch(r.id);
          if (!m) continue;
          out.push({
            uid: m.uid, id: m.id, messageId: m.messageId,
            from: formatAddress(m.from[0]), to: m.to.map(formatAddress).filter(Boolean), cc: m.cc.map(formatAddress).filter(Boolean),
            subject: m.subject ?? '', text: m.text ?? '', date: m.date,
            attachments: m.attachments.filter(a => !a.inline).map(a => ({ name: a.filename, size: a.size })),
            ...(m.headers ? { headers: { ...m.headers } } : {}),
          });
        }
        return out;
      } catch (e) { throw safe(e); }
    },
    ...(transport.waitForNew ? {
      async waitForChange(folder: string, maxMs: number, signal: AbortSignal) {
        let r;
        try { r = await transport.waitForNew!(folder, { timeoutMs: maxMs, signal }); } catch (e) { throw safe(e); }
        // The IDLE connection closed under us: pause like a poll instead of spinning.
        if (r?.reason === 'closed' && !signal.aborted) await sleep(Math.min(maxMs, 60_000), signal);
      },
    } : {}),
    async close() {
      // Drop the cached transport: a reconnect after an error starts from a fresh login.
      try { await service.forget(name); } catch { /* ignore */ }
    },
  };
}

// ── config ────────────────────────────────────────────────────────────────────

export interface MailWatchConfig {
  /** Start the watcher daemon with `qodex telegram start` / the control center. */
  enabled: boolean;
  /** Accounts to watch (default: all). */
  accounts: string[];
  folder: string;
  /** Poll interval when IDLE is unavailable (and safety poll while idling = 5× this, max 25 min). */
  pollIntervalSec: number;
  idle: boolean;
}

/** `mail.watch` from the config: `true` or { enabled, accounts, folder, pollIntervalSec, idle }. PURE. */
export function resolveMailWatchConfig(cfg: unknown): MailWatchConfig {
  const mail = cfg && typeof cfg === 'object' ? (cfg as any).mail : undefined;
  const w = mail?.watch;
  const o = w && typeof w === 'object' ? w : {};
  const n = Number(o.pollIntervalSec);
  return {
    enabled: w === true || o.enabled === true,
    accounts: Array.isArray(o.accounts) ? o.accounts.map(String).filter(Boolean) : [],
    folder: typeof o.folder === 'string' && o.folder.trim() ? o.folder.trim() : 'INBOX',
    pollIntervalSec: Number.isFinite(n) && n >= 10 ? Math.min(n, 3600) : 60,
    idle: o.idle !== false,
  };
}

// ── state ─────────────────────────────────────────────────────────────────────

interface FolderState { uidValidity: string; lastUid: number }
interface AccountState {
  folders: Record<string, FolderState>;
  /** Recent Message-IDs (dedupe across folders / UIDVALIDITY resets). */
  seen: string[];
  lastCheckAt?: string;
  lastNewAt?: string;
  lastError?: string;
  mode?: 'idle' | 'poll';
}
interface WatchState { version: 1; accounts: Record<string, AccountState> }

const MAX_SEEN = 2000;

export class WatchStateStore {
  constructor(readonly file: string = mailAutoPaths().state) {}

  async read(): Promise<WatchState> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf-8'));
      const out: WatchState = { version: 1, accounts: {} };
      for (const [name, a] of Object.entries((raw?.accounts ?? {}) as Record<string, any>)) {
        const folders: Record<string, FolderState> = {};
        for (const [f, st] of Object.entries((a?.folders ?? {}) as Record<string, any>)) {
          const lastUid = Number(st?.lastUid);
          if (Number.isSafeInteger(lastUid) && lastUid >= 0) folders[f] = { uidValidity: String(st?.uidValidity ?? ''), lastUid };
        }
        out.accounts[name] = {
          folders,
          seen: Array.isArray(a?.seen) ? a.seen.map(String).slice(-MAX_SEEN) : [],
          lastCheckAt: typeof a?.lastCheckAt === 'string' ? a.lastCheckAt : undefined,
          lastNewAt: typeof a?.lastNewAt === 'string' ? a.lastNewAt : undefined,
          lastError: typeof a?.lastError === 'string' ? a.lastError.slice(0, 300) : undefined,
          mode: a?.mode === 'idle' ? 'idle' : a?.mode === 'poll' ? 'poll' : undefined,
        };
      }
      return out;
    } catch {
      return { version: 1, accounts: {} };
    }
  }

  async update(account: string, fn: (a: AccountState) => void): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await withLock(this.file + '.lock', async () => {
      const s = await this.read();
      const a = s.accounts[account] ?? (s.accounts[account] = { folders: {}, seen: [] });
      fn(a);
      a.seen = a.seen.slice(-MAX_SEEN);
      await writeFileAtomic(this.file, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
    }, { retries: 100, intervalMs: 50, staleMs: 10_000 });
  }
}

// ── the watcher ───────────────────────────────────────────────────────────────

export interface MailWatcherOptions {
  /** Accounts to watch (default: config mail.watch.accounts, else every account). */
  accounts?: string[];
  folder?: string;
  pollIntervalMs?: number;
  /** Use IMAP IDLE when the source supports it (default true). */
  idle?: boolean;
  /** Max wait in IDLE before a safety poll (default 5 × poll interval, ≤ 25 min). */
  idleMaxMs?: number;
  /** Messages fetched per check (default 50). */
  batch?: number;
  factory?: WatchSourceFactory;
  state?: WatchStateStore;
  index?: ReceivedIndex;
  rules?: MailRuleStore;
  startRun?: RuleRunStarter;
  publish?: (type: MailEventType, data: MailEventData) => unknown;
  /** Output for the foreground CLI. */
  onLog?: (line: string) => void;
  backoff?: { initialMs?: number; maxMs?: number };
}

export interface ProcessedMail {
  account: string;
  messageId: string;
  flagged: boolean;
  rules: Array<{ ruleId: string; missionId?: string; draftOnly: boolean; error?: string }>;
}

export class MailWatcher {
  private readonly opts: MailWatcherOptions;
  private readonly state: WatchStateStore;
  private controller: AbortController | null = null;
  private loops: Promise<void>[] = [];
  private lastErr = new Map<string, { msg: string; at: number }>();

  constructor(opts: MailWatcherOptions = {}) {
    this.opts = opts;
    this.state = opts.state ?? new WatchStateStore();
  }

  get folder(): string { return this.opts.folder ?? 'INBOX'; }

  private log(line: string): void {
    try { this.opts.onLog?.(line); } catch { /* ignore */ }
  }

  private publish(type: MailEventType, data: MailEventData): void {
    try {
      if (this.opts.publish) void Promise.resolve(this.opts.publish(type, data)).catch(() => {});
      else void publishMailEvent(type, data);
    } catch { /* never break the loop */ }
  }

  /** Start one loop per account. Resolves once started; `done()` settles when all stop. */
  async start(signal?: AbortSignal): Promise<string[]> {
    if (this.controller) throw new Error('[MAIL_WATCH_RUNNING] The watcher is already running.');
    const accounts = this.opts.accounts?.length ? this.opts.accounts : await listWatchAccounts();
    if (!accounts.length) throw new Error('[MAIL_NOT_CONFIGURED] No mail accounts to watch. Add one with `qodex mail add`.');
    const ac = new AbortController();
    this.controller = ac;
    if (signal) { if (signal.aborted) ac.abort(); else signal.addEventListener('abort', () => ac.abort(), { once: true }); }
    this.loops = accounts.map(a => this.loop(a, ac.signal));
    for (const a of accounts) this.publish('watch-started', { account: a });
    return accounts;
  }

  done(): Promise<void> {
    return Promise.allSettled(this.loops).then(() => undefined);
  }

  async stop(): Promise<void> {
    this.controller?.abort();
    await this.done();
    this.controller = null;
  }

  private async loop(account: string, signal: AbortSignal): Promise<void> {
    const pollMs = Math.max(1000, this.opts.pollIntervalMs ?? 60_000);
    const idleMax = this.opts.idleMaxMs ?? Math.min(25 * 60_000, pollMs * 5);
    const initialBackoff = this.opts.backoff?.initialMs ?? 5000;
    const maxBackoff = this.opts.backoff?.maxMs ?? 5 * 60_000;
    let backoff = initialBackoff;
    let source: WatchSource | null = null;
    while (!signal.aborted) {
      try {
        if (!source) source = await (this.opts.factory ?? openMailServiceSource)(account);
        await this.check(account, source);
        backoff = initialBackoff;
        if (signal.aborted) break;
        if (this.opts.idle !== false && source.waitForChange) {
          await this.state.update(account, a => { a.mode = 'idle'; }).catch(() => {});
          await source.waitForChange(this.folder, idleMax, signal);
        } else {
          await this.state.update(account, a => { a.mode = 'poll'; }).catch(() => {});
          await sleep(pollMs, signal);
        }
      } catch (e: any) {
        if (signal.aborted) break;
        const msg = cleanLine(String(e?.message ?? e), 300);
        await this.state.update(account, a => { a.lastError = msg; }).catch(() => {});
        const last = this.lastErr.get(account);
        if (!last || last.msg !== msg || Date.now() - last.at > 10 * 60_000) {
          this.lastErr.set(account, { msg, at: Date.now() });
          this.publish('watch-error', { account, error: msg });
          this.log(`⚠ ${account}: ${msg}`);
        }
        try { await source?.close?.(); } catch { /* ignore */ }
        source = null;
        await sleep(backoff, signal);
        backoff = Math.min(maxBackoff, backoff * 2);
      }
    }
    try { await source?.close?.(); } catch { /* ignore */ }
    this.publish('watch-stopped', { account });
  }

  /**
   * One check of an account: fetch messages above the last-seen UID, process the new
   * ones, persist progress. The first check of a folder only records where "now" is.
   */
  async check(account: string, source: WatchSource): Promise<ProcessedMail[]> {
    const folder = this.folder;
    const st = await source.status(folder);
    const state = (await this.state.read()).accounts[account];
    const prev = state?.folders[folder];
    if (!prev || prev.uidValidity !== st.uidValidity) {
      // First run, or the server renumbered the folder: start from now (never replay history).
      await this.state.update(account, a => {
        a.folders[folder] = { uidValidity: st.uidValidity, lastUid: Math.max(0, st.uidNext - 1) };
        a.lastCheckAt = new Date().toISOString();
        a.lastError = undefined;
      });
      return [];
    }
    if (st.uidNext - 1 <= prev.lastUid) {
      await this.state.update(account, a => { a.lastCheckAt = new Date().toISOString(); a.lastError = undefined; });
      return [];
    }
    const msgs = (await source.fetchSince(folder, prev.lastUid + 1, this.opts.batch ?? 50))
      .filter(m => Number.isSafeInteger(m.uid) && m.uid > prev.lastUid)
      .sort((a, b) => a.uid - b.uid);
    const seen = new Set(state?.seen ?? []);
    const out: ProcessedMail[] = [];
    let maxUid = prev.lastUid;
    for (const m of msgs) {
      maxUid = Math.max(maxUid, m.uid);
      const messageId = normalizeMessageId(m.messageId) || `uid-${st.uidValidity}-${m.uid}@${account}`;
      if (seen.has(messageId)) continue;
      seen.add(messageId);
      out.push(await this.processMessage(account, folder, m, messageId, source.self));
      // Persist after each message: a crash never re-announces what was handled.
      await this.state.update(account, a => {
        a.folders[folder] = { uidValidity: st.uidValidity, lastUid: m.uid };
        a.seen.push(messageId);
        a.lastNewAt = new Date().toISOString();
      });
    }
    await this.state.update(account, a => {
      const f = a.folders[folder];
      if (f && f.uidValidity === st.uidValidity) f.lastUid = Math.max(f.lastUid, maxUid);
      a.lastCheckAt = new Date().toISOString();
      a.lastError = undefined;
    });
    return out;
  }

  private async processMessage(account: string, folder: string, m: WatchMessage, messageId: string, self?: string): Promise<ProcessedMail> {
    const findings = scanMail({ from: m.from, subject: m.subject, text: m.text });
    const flagged = findings.length > 0;
    const index = this.opts.index ?? getReceivedIndex();
    try {
      await index.record([{
        account, messageId, from: bareAddress(m.from), subject: m.subject, folder, uid: m.uid,
        flagged, findings: findings.map(f => f.id), receivedAt: new Date().toISOString(),
      }]);
    } catch (e: any) {
      logger.warn('mail watcher: could not record a received message', { err: String(e?.message ?? e).slice(0, 200) });
    }
    const snippet = String(m.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
    this.publish('new-mail', { account, from: m.from, subject: m.subject, snippet, messageId, flagged, findings: findings.map(f => f.id) });
    this.log(`📬 ${account}: ${cleanLine(m.from, 80)} — ${cleanLine(m.subject, 120)}${flagged ? ' ⚠ possible prompt injection' : ''}`);
    const incoming: IncomingMail = {
      account, id: m.id, messageId, folder, uid: m.uid, from: m.from, to: m.to ?? [], cc: m.cc ?? [],
      subject: m.subject ?? '', text: m.text ?? '', date: m.date, attachments: m.attachments ?? [],
      flagged, findings: findings.map(f => f.id),
      ...(m.headers ? { headers: m.headers } : {}), ...(self ? { self } : {}),
    };
    const rules = await runMatchingRules(incoming, { store: this.opts.rules ?? getMailRuleStore(), start: this.opts.startRun, publish: this.opts.publish });
    for (const r of rules) {
      this.log(r.error ? `  ✗ rule ${r.ruleId}: ${r.error}` : `  ▶ rule ${r.ruleId} → ${r.missionId}${r.draftOnly ? ' (draft only)' : ''}`);
    }
    return { account, messageId, flagged, rules };
  }
}

// ── daemon (pid file, like mission workers) ───────────────────────────────────

interface PidInfo { pid: number; startToken: string | null; startedAt: string; accounts: string[]; logFile?: string }

function processStartToken(pid: number): string | null {
  if (process.platform !== 'linux') return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return /^\d+$/.test(fields[19] ?? '') ? fields[19] : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; }
}

export function readPidFile(file: string = mailAutoPaths().pid): PidInfo | null {
  try {
    const v = JSON.parse(readFileSync(file, 'utf-8'));
    const pid = Number(v?.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return { pid, startToken: typeof v.startToken === 'string' ? v.startToken : null, startedAt: String(v.startedAt ?? ''), accounts: Array.isArray(v.accounts) ? v.accounts.map(String) : [], logFile: typeof v.logFile === 'string' ? v.logFile : undefined };
  } catch {
    return null;
  }
}

/** The running watcher (daemon or foreground) per its pid file, verified against pid reuse. */
export function runningWatcher(file: string = mailAutoPaths().pid): PidInfo | null {
  const info = readPidFile(file);
  if (!info || !isAlive(info.pid)) return null;
  if (info.startToken) {
    const now = processStartToken(info.pid);
    if (now !== null && now !== info.startToken) return null;
  }
  return info;
}

/** Claim the pid file for this process. Throws [MAIL_WATCH_RUNNING] when another live watcher holds it. */
export function claimPidFile(accounts: string[], file: string = mailAutoPaths().pid, logFile?: string): () => void {
  const other = runningWatcher(file);
  if (other && other.pid !== process.pid) {
    throw new Error(`[MAIL_WATCH_RUNNING] A mail watcher is already running (pid ${other.pid}). Stop it with \`qodex mail watch --stop\`.`);
  }
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const info: PidInfo = { pid: process.pid, startToken: processStartToken(process.pid), startedAt: new Date().toISOString(), accounts, logFile };
  const fd = openSync(file, 'w', 0o600);
  try { writeSync(fd, JSON.stringify(info)); } finally { closeSync(fd); }
  const release = () => {
    try { if (readPidFile(file)?.pid === process.pid) unlinkSync(file); } catch { /* ignore */ }
  };
  process.once('exit', release);
  return release;
}

export interface SpawnWatchDaemonOptions {
  entry?: string;
  execPath?: string;
  execArgv?: string[];
  cwd?: string;
  pidFile?: string;
  logFile?: string;
  accounts?: string[];
  spawn?: (command: string, args: string[], opts: SpawnOptions) => { pid?: number; unref(): void; on(ev: 'error', cb: (e: Error) => void): unknown };
}

/** Start the detached watcher worker (`qodex mail watch --worker`). */
export function spawnMailWatchDaemon(opts: SpawnWatchDaemonOptions = {}): { pid: number; logFile: string; already?: boolean } {
  const paths = mailAutoPaths();
  const pidFile = opts.pidFile ?? paths.pid;
  const running = runningWatcher(pidFile);
  if (running) return { pid: running.pid, logFile: running.logFile ?? paths.log, already: true };
  const entry = opts.entry || process.env.QODEX_MAIL_WATCH_ENTRY || process.env.QODEX_MISSION_WORKER_ENTRY || process.argv[1];
  if (!entry) throw new Error('[MAIL_WATCH_SPAWN_FAILED] Cannot locate the qodex CLI entry.');
  const execArgv = (opts.execArgv ?? process.execArgv).filter(a => !/^--(inspect|debug)/.test(a));
  const args = [...execArgv, entry, 'mail', 'watch', '--worker', ...(opts.accounts?.length ? ['--account', opts.accounts.join(',')] : [])];
  const logFile = opts.logFile ?? paths.log;
  mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
  const fd = openSync(logFile, 'a', 0o600);
  try {
    writeSync(fd, `\n# ${new Date().toISOString()} starting mail watcher\n`);
    const child = (opts.spawn ?? (nodeSpawn as any))(opts.execPath ?? process.execPath, args, {
      cwd: opts.cwd ?? process.cwd(), detached: true, stdio: ['ignore', fd, fd], windowsHide: true,
      env: { ...process.env, QODEX_MAIL_WATCH_DAEMON: '1' },
    });
    child.on('error', (e: Error) => logger.warn('mail watcher spawn error', { err: e?.message }));
    if (!child.pid) throw new Error('[MAIL_WATCH_SPAWN_FAILED] Could not start the mail watcher process.');
    child.unref();
    return { pid: child.pid, logFile };
  } finally {
    try { closeSync(fd); } catch { /* the child keeps its copy */ }
  }
}

/** Stop the running watcher (SIGTERM). */
export function stopMailWatchDaemon(pidFile: string = mailAutoPaths().pid): { ok: boolean; message: string } {
  const info = runningWatcher(pidFile);
  if (!info) return { ok: false, message: 'The mail watcher is not running.' };
  try {
    process.kill(info.pid, 'SIGTERM');
    return { ok: true, message: `✓ Stopping the mail watcher (pid ${info.pid}).` };
  } catch (e: any) {
    return { ok: false, message: `Could not stop the mail watcher (pid ${info.pid}): ${e?.message ?? e}` };
  }
}

/** Status text for /mail status, /mail watch status and `qodex mail watch --status`. */
export async function mailWatchStatusText(opts: { pidFile?: string; state?: WatchStateStore } = {}): Promise<string> {
  const info = runningWatcher(opts.pidFile);
  const st = await (opts.state ?? new WatchStateStore()).read();
  const lines = [info
    ? `Mail watcher: running (pid ${info.pid}, since ${info.startedAt.slice(0, 16).replace('T', ' ')}${info.accounts.length ? `, accounts ${info.accounts.join(', ')}` : ''})`
    : 'Mail watcher: not running — start it with `qodex mail watch --daemon` (or /mail watch start)'];
  for (const [name, a] of Object.entries(st.accounts)) {
    lines.push(`  ${name}: ${a.mode ?? '—'}${a.lastCheckAt ? ` · checked ${a.lastCheckAt.slice(11, 16)}` : ''}${a.lastNewAt ? ` · last new mail ${a.lastNewAt.slice(0, 16).replace('T', ' ')}` : ''}${a.lastError ? ` · ⚠ ${a.lastError}` : ''}`);
  }
  return lines.join('\n');
}

/** `/mail watch [start|stop|status]` from the TUI / Telegram. */
export async function mailWatchSlash(args: string[], opts: { cwd?: string } = {}): Promise<string> {
  const sub = (args[0] ?? 'status').toLowerCase();
  if (sub === 'start' || sub === 'on') {
    const accounts = await listWatchAccounts();
    if (!accounts.length) return 'No mail accounts are set up yet — add one with `qodex mail add`.';
    const r = spawnMailWatchDaemon({ cwd: opts.cwd });
    return r.already ? `The mail watcher is already running (pid ${r.pid}).` : `✓ Mail watcher started in the background (pid ${r.pid}). Log: ${r.logFile}`;
  }
  if (sub === 'stop' || sub === 'off') return stopMailWatchDaemon().message;
  if (sub === 'recent' || sub === 'log') {
    const evs = await recentMailEvents(15);
    return evs.length ? evs.map(e => `${new Date(e.ts).toISOString().slice(5, 16).replace('T', ' ')} ${e.data.summary ?? e.type}`).join('\n') : 'No mail events yet.';
  }
  return mailWatchStatusText();
}

/** Start the watcher daemon when `mail.watch` is on in the config and none runs (telegram start / control center). Never throws. */
export async function maybeStartMailWatchFromConfig(opts: { config?: unknown; cwd?: string } = {}): Promise<string | null> {
  try {
    const cfg = resolveMailWatchConfig(opts.config ?? getActiveConfig());
    if (!cfg.enabled || runningWatcher()) return null;
    if (!(await listWatchAccounts()).length) return null;
    const r = spawnMailWatchDaemon({ cwd: opts.cwd, accounts: cfg.accounts });
    return `Mail watcher started (pid ${r.pid}).`;
  } catch (e: any) {
    logger.debug('mail watcher auto-start failed', { err: String(e?.message ?? e).slice(0, 200) });
    return null;
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────

/** Run the watcher in this process until SIGTERM (worker) or Ctrl+C (foreground). */
async function runForeground(o: { accounts?: string[]; worker: boolean }): Promise<void> {
  // A CLI command runs without the agent bootstrap: load ~/.qodex/.env (the Telegram
  // token for notifications) and the config (mail.watch, telegram.*) here.
  try {
    const { loadEnvFileIntoProcess } = await import('../setup/env-writer.js');
    await loadEnvFileIntoProcess().catch(() => 0);
    const { loadConfig, setActiveConfig, ensureQodexHome } = await import('../config/loader.js');
    await ensureQodexHome();
    if (!getActiveConfig()) setActiveConfig(await loadConfig(process.cwd()));
  } catch (e: any) {
    logger.debug('mail watcher: config not loaded', { err: String(e?.message ?? e).slice(0, 200) });
  }
  const cfg = resolveMailWatchConfig(getActiveConfig());
  const accounts = o.accounts?.length ? o.accounts : cfg.accounts.length ? cfg.accounts : await listWatchAccounts();
  if (!accounts.length) throw new Error('[MAIL_NOT_CONFIGURED] No mail accounts to watch. Add one with `qodex mail add`.');
  const release = claimPidFile(accounts, undefined, o.worker ? mailAutoPaths().log : undefined);
  const ac = new AbortController();
  // SIGTERM (`qodex mail watch --stop`, a mission-style stop): finish cleanly, then exit.
  const onTerm = () => { ac.abort(); setTimeout(() => { release(); process.exit(0); }, 3000).unref(); };
  process.once('SIGTERM', onTerm);
  const out = (line: string) => process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${line}\n`);
  const watcher = new MailWatcher({ accounts, folder: cfg.folder, pollIntervalMs: cfg.pollIntervalSec * 1000, idle: cfg.idle, onLog: out });
  await watcher.start(ac.signal);
  out(`Watching ${accounts.join(', ')} (${cfg.folder}, ${cfg.idle ? 'IDLE + ' : ''}poll ${cfg.pollIntervalSec}s). ${o.worker ? 'Stop: qodex mail watch --stop' : 'Ctrl+C to stop.'}`);
  await watcher.done();
  release();
  process.removeListener('SIGTERM', onTerm);
}

/** `qodex mail watch` (mounted under the core `qodex mail` command). */
export function buildMailWatchCommand(): Command {
  return new Command('watch')
    .description('Watch mailboxes for new mail: notify you and run your mail rules (--daemon to run in the background)')
    .option('--daemon', 'Run detached in the background (pid file, log in ~/.qodex/mail-auto/watch.log)')
    .option('--status', 'Show whether the watcher runs and what it last saw')
    .option('--stop', 'Stop the background watcher')
    .option('--account <names>', 'Only these accounts (comma-separated)')
    .addOption(new Option('--worker', 'internal: the detached worker process').hideHelp())
    .action(async (o: { daemon?: boolean; status?: boolean; stop?: boolean; account?: string; worker?: boolean }) => {
      try {
        const accounts = o.account ? o.account.split(',').map(s => s.trim()).filter(Boolean) : undefined;
        if (o.status) { process.stdout.write((await mailWatchStatusText()) + '\n'); return; }
        if (o.stop) { const r = stopMailWatchDaemon(); process.stdout.write(r.message + '\n'); if (!r.ok) process.exitCode = 1; return; }
        if (o.daemon) {
          const r = spawnMailWatchDaemon({ accounts });
          process.stdout.write(r.already ? `The mail watcher is already running (pid ${r.pid}).\n` : `✓ Mail watcher started (pid ${r.pid}). Log: ${r.logFile}\nStatus: qodex mail watch --status · Stop: qodex mail watch --stop\n`);
          return;
        }
        await runForeground({ accounts, worker: !!o.worker });
      } catch (e: any) {
        process.stderr.write(`${getMailService().errorText(e)}\n`);
        process.exitCode = 1;
      }
    });
}

function cliRun(argv: string[]): Promise<void> {
  return runMailAutomationCommand(argv, { origin: 'cli', cwd: process.cwd() })
    .then(t => { process.stdout.write(t + '\n'); })
    .catch((e: any) => { process.stderr.write(`${e?.message ?? e}\n`); process.exitCode = 1; });
}

/** `qodex mail rule add|list|remove|enable|disable`. */
export function buildMailRuleCommand(): Command {
  const cmd = new Command('rule').alias('rules').description('Standing tasks for incoming mail (when <conditions> → <task>)');
  cmd.command('list', { isDefault: true }).description('List mail rules').action(() => cliRun(['rule', 'list']));
  cmd.command('add <when> <task...>')
    .description('Add a rule. when: from:<addr|@domain> to:<…> subject:"…" body:"…" has:attachment account:<name> (* = any)')
    .option('--cwd <dir>', 'Working directory of the runs (default: current directory)')
    .option('--auto', 'Run in auto mode (still asks for sending, payments, credentials, destructive actions outside the project)')
    .action((when: string, task: string[], o: { cwd?: string; auto?: boolean }) => cliRun(['rule', 'add', when, task.join(' '), ...(o.cwd ? ['--cwd', o.cwd] : []), ...(o.auto ? ['--auto'] : [])]));
  cmd.command('remove <id>').alias('rm').description('Remove a rule (a reply-all preset also revokes its grant)').action((id: string) => cliRun(['rule', 'remove', id]));
  cmd.command('enable <id>').description('Enable a rule').action((id: string) => cliRun(['rule', 'enable', id]));
  cmd.command('disable <id>').description('Disable a rule').action((id: string) => cliRun(['rule', 'disable', id]));
  return cmd;
}

/** `qodex mail reply-all` — the "reply to all mail" preset (grant + rule). */
export function buildMailReplyAllCommand(): Command {
  return new Command('reply-all')
    .description('Auto-reply to incoming mail: a standing reply grant + a rule "draft a reply and send it"')
    .option('--account <name>', 'Only this account')
    .option('--from <addr|@domain>', 'Only mail from these senders (comma-separated)')
    .option('--max-per-day <n>', 'Daily cap (default 50)')
    .option('--expires <when>', 'Expire after 12h / 7d / 2w or at a date')
    .option('--cwd <dir>', 'Working directory of the runs')
    .action((o: Record<string, string | undefined>) => {
      const argv = ['reply-all'];
      for (const k of ['account', 'from', 'max-per-day', 'expires', 'cwd']) {
        const v = o[k.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())];
        if (v) argv.push(`--${k}`, v);
      }
      return cliRun(argv);
    });
}

/**
 * Mount `watch`, `rule` and `reply-all` (+ `status`) under `qodex mail` — the core
 * mail command when it exists (call this AFTER it is added), else a new `mail`
 * command. Subcommands the core already defines are left alone.
 */
export function attachMailAutomationCommands(program: Command): Command {
  let mail = program.commands.find(c => c.name() === 'mail');
  if (!mail) {
    mail = new Command('mail').description('Email: watcher, rules and auto-replies');
    program.addCommand(mail);
  }
  const has = (n: string) => mail!.commands.some(c => c.name() === n);
  if (!has('watch')) mail.addCommand(buildMailWatchCommand());
  if (!has('rule')) mail.addCommand(buildMailRuleCommand());
  if (!has('reply-all')) mail.addCommand(buildMailReplyAllCommand());
  if (!has('auto-status')) {
    mail.addCommand(new Command('auto-status').description('Watcher, rules and reply grants at a glance').action(() => cliRun(['status'])));
  }
  return mail;
}

/** Re-split TUI slash args (split on whitespace) honoring quotes. PURE. */
export function resplitSlashArgs(args: string[]): string[] {
  return splitArgs(args.join(' '));
}
