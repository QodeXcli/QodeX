/**
 * Standing grants — "from now on you may …" permissions the HUMAN gives QodeX.
 *
 * The first (and so far only) kind is 'mail-reply': the agent may send a reply in
 * the same thread to the original sender of a message received in an account,
 * without asking each time (Sentinel checks the exact scope, see mail-scope.ts).
 *
 * Who can create one: ONLY human surfaces — the TUI's `/allow`, `qodex grant add`
 * in a terminal, a paired Telegram chat's `/allow`, or a human clicking "Always
 * allow replies like this" on an approval prompt. There is deliberately no tool
 * for it: nothing the model can call creates, widens or reads a grant, and
 * Sentinel hard-protects the file from the agent's file / shell tools
 * (src/sentinel/policy.ts DEFAULT_PROTECTED_PATHS) and treats `qodex grant …`
 * run by the agent as a change to QodeX's own safety settings (always a human).
 *
 * Storage: ~/.qodex/grants.json (0600, atomic writes, cross-process lock) — the
 * TUI, a Telegram bot, the mail watcher daemon and mission workers share it.
 * The daily cap is counted here (per grant, per local calendar day).
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { writeFileAtomic } from '../utils/atomic-write.js';
import { withLock } from '../utils/file-lock.js';
import { QODEX_GRANTS_FILE } from './paths.js';

export const GRANT_KINDS = ['mail-reply'] as const;
export type GrantKind = typeof GRANT_KINDS[number];

/** The human surfaces that may create a grant (recorded as createdBy). */
export type GrantOrigin = 'tui' | 'cli' | 'telegram' | 'approval' | 'control';

export const DEFAULT_MAX_PER_DAY = 50;
export const MAX_MAX_PER_DAY = 1000;

export interface StandingGrant {
  id: string;
  kind: GrantKind;
  /** Mail account name, or '*' for every account. */
  account: string;
  /** Sender filter: exact addresses and/or '@domain' entries. Empty = any sender. */
  from: string[];
  /** Uses allowed per local calendar day. */
  maxPerDay: number;
  /** ISO timestamp. */
  createdAt: string;
  /** 'tui' | 'cli' | 'telegram:@user' | 'approval:telegram' … */
  createdBy: string;
  /** ISO timestamp; absent = until revoked. */
  expiresAt?: string;
  note?: string;
}

export interface NewGrantInput {
  kind?: GrantKind;
  account?: string;
  from?: string[] | string;
  maxPerDay?: number;
  /** ISO timestamp, or a duration like '12h' / '7d' / '2w'. */
  expiresAt?: string | null;
  note?: string;
}

interface GrantsState {
  version: 1;
  grants: StandingGrant[];
  /** grantId → { 'YYYY-MM-DD': uses } */
  usage: Record<string, Record<string, number>>;
}

// ── validation (PURE) ─────────────────────────────────────────────────────────

const ADDRESS_RE = /^[^\s@<>(),;:"\[\]\\]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
const DOMAIN_RE = /^@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
const ACCOUNT_RE = /^[\p{L}\p{N}._@+-]{1,64}$/u;

/** `Name <a@b.c>` / `mailto:a@b.c` / ` A@B.C ` → 'a@b.c' (lower-case), or '' when it is not one plain address. PURE. */
export function bareAddress(raw: unknown): string {
  let s = String(raw ?? '').trim();
  const angle = /<([^<>]*)>\s*$/.exec(s);
  if (angle) s = angle[1];
  s = s.replace(/^mailto:/i, '').trim().toLowerCase();
  return ADDRESS_RE.test(s) ? s : '';
}

/** Domain part of an address ('' when none). PURE. */
export function domainOf(address: string): string {
  const i = address.lastIndexOf('@');
  return i >= 0 ? address.slice(i + 1).toLowerCase() : '';
}

/** One sender-filter entry: an exact address or '@domain'. Throws [GRANT_BAD_INPUT]. PURE. */
export function normalizeSenderFilter(entry: string): string {
  const s = String(entry ?? '').trim().toLowerCase();
  if (s.startsWith('@') || /^\*@/.test(s)) {
    const d = '@' + s.replace(/^\*?@/, '');
    if (DOMAIN_RE.test(d)) return d;
    throw new Error(`[GRANT_BAD_INPUT] "${entry}" is not a domain (use @example.com).`);
  }
  const a = bareAddress(s);
  if (a) return a;
  throw new Error(`[GRANT_BAD_INPUT] "${entry}" is not an email address or @domain.`);
}

/** Split "a@x.com, @y.org" / arrays into normalized filter entries (deduped). PURE. */
export function normalizeSenderList(v: string[] | string | undefined | null): string[] {
  const parts = (Array.isArray(v) ? v : String(v ?? '').split(/[,;\s]+/)).map(x => String(x).trim()).filter(Boolean);
  return [...new Set(parts.map(normalizeSenderFilter))];
}

export function normalizeAccount(v: string | undefined | null): string {
  const s = String(v ?? '').trim();
  if (!s || s === '*' || s.toLowerCase() === 'all' || s.toLowerCase() === 'any') return '*';
  if (!ACCOUNT_RE.test(s)) throw new Error(`[GRANT_BAD_INPUT] "${s}" is not a valid account name.`);
  return s;
}

/** '12h' | '7d' | '2w' | ISO date → ISO timestamp (future). Throws [GRANT_BAD_INPUT]. PURE apart from `now`. */
export function parseExpiry(v: string, now: number = Date.now()): string {
  const s = String(v ?? '').trim();
  const m = /^(\d{1,4})\s*(m|min|h|d|w)$/i.exec(s);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    const ms = unit === 'w' ? 7 * 86_400_000 : unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : 60_000;
    if (n <= 0) throw new Error(`[GRANT_BAD_INPUT] Expiry must be in the future ("${s}").`);
    return new Date(now + n * ms).toISOString();
  }
  const t = Date.parse(s);
  if (!Number.isFinite(t)) throw new Error(`[GRANT_BAD_INPUT] "${s}" is not a duration (12h, 7d, 2w) or a date.`);
  if (t <= now) throw new Error(`[GRANT_BAD_INPUT] Expiry must be in the future ("${s}").`);
  return new Date(t).toISOString();
}

export function normalizeMaxPerDay(v: unknown): number {
  if (v === undefined || v === null || v === '') return DEFAULT_MAX_PER_DAY;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_MAX_PER_DAY) {
    throw new Error(`[GRANT_BAD_INPUT] --max-per-day must be a whole number between 1 and ${MAX_MAX_PER_DAY}.`);
  }
  return n;
}

/** Local calendar day key, 'YYYY-MM-DD'. PURE. */
export function dayKey(now: number = Date.now()): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function isExpired(g: Pick<StandingGrant, 'expiresAt'>, now: number = Date.now()): boolean {
  if (!g.expiresAt) return false;
  const t = Date.parse(g.expiresAt);
  return !Number.isFinite(t) || t <= now;
}

/** Does the grant's sender filter allow this (bare) address? Empty filter = any. PURE. */
export function senderAllowed(g: Pick<StandingGrant, 'from'>, address: string): boolean {
  const a = bareAddress(address);
  if (!a) return false;
  if (!g.from.length) return true;
  const dom = domainOf(a);
  return g.from.some(f => (f.startsWith('@') ? f.slice(1) === dom : f === a));
}

function sanitizeOriginDetail(s: string | undefined): string {
  return String(s ?? '').replace(/[^\p{L}\p{N}@._:-]+/gu, '').slice(0, 64);
}

/** One-line description of a grant (for /allow list, Telegram, the control center). PURE. */
export function describeGrant(g: StandingGrant, usedToday = 0, now: number = Date.now()): string {
  const parts = [
    g.id,
    g.kind === 'mail-reply' ? 'mail replies' : g.kind,
    `account ${g.account === '*' ? 'all' : g.account}`,
    `from ${g.from.length ? g.from.join(', ') : 'anyone'}`,
    `${usedToday}/${g.maxPerDay} today`,
  ];
  if (g.expiresAt) parts.push(isExpired(g, now) ? `expired ${g.expiresAt.slice(0, 16).replace('T', ' ')}` : `until ${g.expiresAt.slice(0, 16).replace('T', ' ')}`);
  parts.push(`by ${g.createdBy}`);
  return parts.join(' · ');
}

// ── state file ────────────────────────────────────────────────────────────────

function emptyState(): GrantsState {
  return { version: 1, grants: [], usage: {} };
}

/** Coerce whatever is on disk into a valid state; malformed grants are dropped (never widened). */
function sanitizeState(raw: unknown): GrantsState {
  const s = emptyState();
  if (!raw || typeof raw !== 'object') return s;
  const r = raw as Record<string, unknown>;
  if (Array.isArray(r.grants)) {
    for (const g of r.grants) {
      if (!g || typeof g !== 'object') continue;
      const x = g as Record<string, unknown>;
      if (typeof x.id !== 'string' || !/^g_[a-z0-9]{4,32}$/.test(x.id)) continue;
      if (!(GRANT_KINDS as readonly unknown[]).includes(x.kind)) continue;
      try {
        const grant: StandingGrant = {
          id: x.id,
          kind: x.kind as GrantKind,
          account: normalizeAccount(typeof x.account === 'string' ? x.account : '*'),
          from: Array.isArray(x.from) ? normalizeSenderList(x.from.map(String)) : [],
          maxPerDay: normalizeMaxPerDay(x.maxPerDay),
          createdAt: typeof x.createdAt === 'string' ? x.createdAt : new Date(0).toISOString(),
          createdBy: typeof x.createdBy === 'string' ? x.createdBy.slice(0, 80) : 'unknown',
        };
        if (typeof x.expiresAt === 'string') grant.expiresAt = x.expiresAt;
        if (typeof x.note === 'string') grant.note = x.note.slice(0, 200);
        if (!s.grants.some(o => o.id === grant.id)) s.grants.push(grant);
      } catch { /* a grant we can't read precisely is dropped, never widened */ }
    }
  }
  if (r.usage && typeof r.usage === 'object') {
    for (const [id, days] of Object.entries(r.usage as Record<string, unknown>)) {
      if (!days || typeof days !== 'object') continue;
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(days as Record<string, unknown>)) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(k) && Number.isFinite(Number(v))) out[k] = Math.max(0, Math.floor(Number(v)));
      }
      s.usage[id] = out;
    }
  }
  return s;
}

export interface GrantStoreOptions {
  file?: string;
  now?: () => number;
}

export class GrantStore {
  readonly file: string;
  private readonly now: () => number;

  constructor(opts: GrantStoreOptions = {}) {
    this.file = opts.file ?? QODEX_GRANTS_FILE;
    this.now = opts.now ?? Date.now;
  }

  private async read(): Promise<GrantsState> {
    try {
      return sanitizeState(JSON.parse(await fs.readFile(this.file, 'utf-8')));
    } catch {
      return emptyState();
    }
  }

  private async write(s: GrantsState): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await writeFileAtomic(this.file, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
    try { await fs.chmod(this.file, 0o600); } catch { /* best effort (Windows) */ }
  }

  private mutate<T>(fn: (s: GrantsState) => T | Promise<T>): Promise<T> {
    return withLock(this.file + '.lock', async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 }).catch(() => {});
      const s = await this.read();
      const out = await fn(s);
      await this.write(s);
      return out;
    }, { retries: 100, intervalMs: 50, staleMs: 10_000 });
  }

  /** All grants (expired ones too unless `activeOnly`). */
  async list(opts: { activeOnly?: boolean } = {}): Promise<StandingGrant[]> {
    const s = await this.read();
    const now = this.now();
    return opts.activeOnly ? s.grants.filter(g => !isExpired(g, now)) : s.grants;
  }

  /** Uses of a grant today. */
  async usedToday(id: string): Promise<number> {
    const s = await this.read();
    return s.usage[id]?.[dayKey(this.now())] ?? 0;
  }

  /** Grants with today's use count (for listings). */
  async listWithUsage(): Promise<Array<{ grant: StandingGrant; usedToday: number; expired: boolean }>> {
    const s = await this.read();
    const now = this.now();
    const day = dayKey(now);
    return s.grants.map(g => ({ grant: g, usedToday: s.usage[g.id]?.[day] ?? 0, expired: isExpired(g, now) }));
  }

  /** Exact id or a unique prefix (≥ 3 chars, with or without the 'g_'). */
  async resolve(idOrPrefix: string): Promise<StandingGrant | null> {
    return resolveIn((await this.read()).grants, idOrPrefix);
  }

  /**
   * Create a grant. ONLY call this from a human surface (`origin` says which). An
   * identical active grant (same kind, account and sender filter) is updated in place
   * (cap / expiry) instead of duplicated.
   */
  async add(input: NewGrantInput, origin: GrantOrigin, detail?: string): Promise<{ grant: StandingGrant; updated: boolean }> {
    const kind = input.kind ?? 'mail-reply';
    if (!(GRANT_KINDS as readonly string[]).includes(kind)) throw new Error(`[GRANT_BAD_INPUT] Unknown grant kind "${kind}".`);
    const account = normalizeAccount(input.account);
    const from = normalizeSenderList(input.from ?? []);
    const maxPerDay = normalizeMaxPerDay(input.maxPerDay);
    const now = this.now();
    const expiresAt = input.expiresAt ? parseExpiry(input.expiresAt, now) : undefined;
    const d = sanitizeOriginDetail(detail);
    const createdBy = d ? `${origin}:${d}` : origin;
    return this.mutate((s) => {
      const key = (g: Pick<StandingGrant, 'kind' | 'account' | 'from'>) => `${g.kind}|${g.account.toLowerCase()}|${[...g.from].sort().join(',')}`;
      const same = s.grants.find(g => !isExpired(g, now) && key(g) === key({ kind, account, from }));
      if (same) {
        same.maxPerDay = maxPerDay;
        if (expiresAt) same.expiresAt = expiresAt; else delete same.expiresAt;
        if (input.note) same.note = String(input.note).slice(0, 200);
        return { grant: { ...same }, updated: true };
      }
      let id = '';
      do { id = 'g_' + randomBytes(4).toString('hex'); } while (s.grants.some(g => g.id === id));
      const grant: StandingGrant = { id, kind, account, from, maxPerDay, createdAt: new Date(now).toISOString(), createdBy };
      if (expiresAt) grant.expiresAt = expiresAt;
      if (input.note) grant.note = String(input.note).slice(0, 200);
      s.grants.push(grant);
      return { grant: { ...grant }, updated: false };
    });
  }

  /** Remove a grant (exact id or unique prefix). Returns the removed grant, or null. */
  async revoke(idOrPrefix: string): Promise<StandingGrant | null> {
    return this.mutate((s) => {
      const g = resolveIn(s.grants, idOrPrefix);
      if (!g) return null;
      s.grants = s.grants.filter(x => x.id !== g.id);
      delete s.usage[g.id];
      return g;
    });
  }

  /** Remove every grant. Returns how many were removed. */
  async revokeAll(): Promise<number> {
    return this.mutate((s) => {
      const n = s.grants.length;
      s.grants = [];
      s.usage = {};
      return n;
    });
  }

  /**
   * Count one use of a grant against today's cap, atomically across processes.
   * `ok: false` when the grant is gone, expired or the cap is reached (nothing counted).
   */
  async consume(id: string): Promise<{ ok: boolean; used: number; cap: number; reason?: string }> {
    return this.mutate((s) => {
      const now = this.now();
      const g = s.grants.find(x => x.id === id);
      if (!g) return { ok: false, used: 0, cap: 0, reason: 'the grant was revoked' };
      if (isExpired(g, now)) return { ok: false, used: 0, cap: g.maxPerDay, reason: 'the grant expired' };
      const day = dayKey(now);
      const days = s.usage[id] ?? (s.usage[id] = {});
      const used = days[day] ?? 0;
      if (used >= g.maxPerDay) return { ok: false, used, cap: g.maxPerDay, reason: `today's cap of ${g.maxPerDay} is used up` };
      days[day] = used + 1;
      // Keep a week of history.
      for (const k of Object.keys(days)) if (k < dayKey(now - 7 * 86_400_000)) delete days[k];
      return { ok: true, used: used + 1, cap: g.maxPerDay };
    });
  }
}

function resolveIn(grants: StandingGrant[], idOrPrefix: string): StandingGrant | null {
  const q = String(idOrPrefix ?? '').trim().toLowerCase();
  if (!q) return null;
  const exact = grants.find(g => g.id === q || g.id === `g_${q}`);
  if (exact) return exact;
  if (q.replace(/^g_/, '').length < 3) return null;
  const pre = q.startsWith('g_') ? q : `g_${q}`;
  const hits = grants.filter(g => g.id.startsWith(pre));
  return hits.length === 1 ? hits[0] : null;
}

let instance: GrantStore | null = null;

export function getGrantStore(): GrantStore {
  if (!instance) instance = new GrantStore();
  return instance;
}

/** Test hook: point the process-wide store elsewhere (null = default on next use). */
export function setGrantStoreForTests(store: GrantStore | null): void {
  instance = store;
}
