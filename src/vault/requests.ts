/**
 * SecretRequestBroker — the one runtime path by which a secret TYPED BY THE HUMAN
 * reaches QodeX (vault_request_login, the control-center vault panel). It is kept
 * apart from ApprovalBroker / OperatorHub on purpose: those publish prompts AND
 * answers on the bus (a 300-event replay ring served to every dashboard), append
 * answers to the project's audit log, mirror them to Telegram and hand them back to
 * the model. A secret request instead
 *   - is answered only by a SURFACE: the TUI's masked prompt ('terminal') or the
 *     control center's secret form ('control', loopback / https only, sealed in the
 *     page over a tunnel). Telegram and every ApprovalChannel never see it;
 *   - hands the typed values straight to the vault (add, or a merge-patch update that
 *     keeps the fields it did not ask for) and drops them; the requester (the tool)
 *     only learns {ok, by, summary}, the summary never holding a value;
 *   - publishes metadata-only notices on the bus (site, entry name, which fields).
 *
 * Vault API contract (V1 adds these to src/vault/vault.ts): `update(name, patch)`
 * merge-patch and `findByOrigin(url)`. `vaultUpdate` / `vaultFindByOrigin` below call
 * them when present and otherwise fall back to get + add({replace}) / list +
 * matchOrigin — a minimal local adapter that V1's merge makes a pass-through.
 */

import { randomBytes } from 'crypto';
import { domainToUnicode } from 'url';
import { getBus } from '../control/bus.js';
import { parseTotpInput } from './totp.js';
import {
  getVault, matchOrigin, normalizeOrigin, formatOrigin, validateEntryName,
  type VaultEntry, type VaultEntryInput, type VaultEntrySummary,
} from './vault.js';

// ── vault adapter (V1 contract) ─────────────────────────────────────────────

/** Merge-patch for an entry: a field left out is kept; `null` clears it. */
export interface VaultPatch {
  origins?: string[];
  username?: string | null;
  secret?: string;
  /** Base32 seed or otpauth:// URI; null removes the TOTP. */
  totp?: string | null;
  note?: string | null;
  loginUrl?: string | null;
}

/** The vault surface this module needs (the real Vault satisfies it). */
export interface VaultLike {
  get(name: string): Promise<VaultEntry | null>;
  list(): Promise<VaultEntrySummary[]>;
  add(input: VaultEntryInput, opts?: { replace?: boolean }): Promise<VaultEntrySummary>;
  remove(name: string): Promise<boolean>;
  update?(name: string, patch: VaultPatch): Promise<VaultEntrySummary>;
  findByOrigin?(url: string): Promise<VaultEntrySummary[]>;
}

/** otpauth URI that round-trips a stored seed with its non-default parameters. */
function storedTotpInput(e: VaultEntry): string | undefined {
  if (!e.totp) return undefined;
  if (!e.totpDigits && !e.totpPeriod && !e.totpAlgorithm) return e.totp;
  const q = new URLSearchParams({ secret: e.totp });
  if (e.totpDigits) q.set('digits', String(e.totpDigits));
  if (e.totpPeriod) q.set('period', String(e.totpPeriod));
  if (e.totpAlgorithm) q.set('algorithm', e.totpAlgorithm.toUpperCase());
  return `otpauth://totp/qodex?${q.toString()}`;
}

/** Merge-patch an entry (rotate the password / TOTP without dropping other fields). */
export async function vaultUpdate(vault: VaultLike, name: string, patch: VaultPatch): Promise<VaultEntrySummary> {
  if (typeof vault.update === 'function') return vault.update(name, patch);
  const e = await vault.get(name);
  if (!e) throw new Error(`[VAULT_NOT_FOUND] No vault entry named "${String(name).slice(0, 64)}".`);
  if (patch.loginUrl !== undefined) throw new Error('[VAULT_UNSUPPORTED] this vault version cannot store a login URL yet');
  const pick = <T>(v: T | null | undefined, keep: T | undefined): T | undefined => (v === null ? undefined : v === undefined ? keep : v);
  return vault.add({
    name: e.name,
    origins: patch.origins ?? e.origins,
    username: pick(patch.username, e.username),
    secret: patch.secret ?? e.secret,
    totp: pick(patch.totp, storedTotpInput(e)),
    note: pick(patch.note, e.note),
  }, { replace: true });
}

/** Entries whose origins accept `url` (summaries only). */
export async function vaultFindByOrigin(vault: VaultLike, url: string): Promise<VaultEntrySummary[]> {
  if (typeof vault.findByOrigin === 'function') return vault.findByOrigin(url);
  return (await vault.list()).filter(e => matchOrigin(url, e.origins).ok);
}

// ── small pure helpers ──────────────────────────────────────────────────────

/** Unicode form of an ASCII (punycode) host, so "xn--…" lookalikes show what they spell. PURE. */
export function displayHost(host: string): string {
  const h = String(host ?? '').toLowerCase();
  let u = '';
  try { u = domainToUnicode(h); } catch { u = ''; }
  return u && u !== h ? `${u} (${h})` : h;
}

/** A page URL for a normalized origin ("github.com" → https://github.com/). PURE. */
export function originUrl(origin: string): string {
  return /^https?:\/\//i.test(origin) ? `${origin.replace(/\/+$/, '')}/` : `https://${origin}/`;
}

/** Do the two origin lists share a site (one accepts the other, subdomains included)? PURE. */
export function sameSite(a: string[], b: string[]): boolean {
  return a.some(o => matchOrigin(originUrl(o), b).ok) || b.some(o => matchOrigin(originUrl(o), a).ok);
}

/** "jo***@gmail.com" / "al***" — enough to recognize, not to reuse. PURE. */
export function maskUsername(u: string | undefined): string {
  const s = String(u ?? '').trim();
  if (!s) return '';
  const at = s.indexOf('@');
  const local = at > 0 ? s.slice(0, at) : s;
  const keep = [...local].slice(0, local.length <= 3 ? 1 : 2).join('');
  return `${keep}***${at > 0 ? s.slice(at) : ''}`;
}

/** A free, valid entry name for `host` (e.g. "github.com", "github.com work", "github.com 2"). PURE. */
export function deriveEntryName(host: string, username: string | undefined, taken: Iterable<string>): string {
  const used = new Set([...taken].map(n => n.toLowerCase()));
  const base = String(host ?? '').toLowerCase().replace(/^www\./, '').replace(/[^\p{L}\p{N}._@+-]/gu, '-').replace(/^[^\p{L}\p{N}]+/u, '').slice(0, 48) || 'login';
  const user = String(username ?? '').trim().split('@')[0]?.replace(/[^\p{L}\p{N}._+-]/gu, '').slice(0, 14) ?? '';
  const candidates = [base, ...(user ? [`${base} ${user}`] : [])];
  for (const c of candidates) {
    try { if (!used.has(validateEntryName(c).toLowerCase())) return validateEntryName(c); } catch { /* next */ }
  }
  for (let i = 2; i < 1000; i++) {
    const c = `${base.slice(0, 58)} ${i}`;
    if (!used.has(c.toLowerCase())) return validateEntryName(c);
  }
  return validateEntryName(`login ${randomBytes(3).toString('hex')}`);
}

/**
 * A vault/parse error safe to show: the first line, at most 300 chars, with every
 * typed value (≥3 chars) cut out, and TOTP errors (whose text can quote one
 * character of the seed) replaced by a fixed sentence. PURE.
 */
export function scrubSecretError(e: unknown, values: Array<string | undefined>): string {
  let m = e instanceof Error ? e.message : 'unexpected error';
  if (/^\[TOTP_INVALID\]/.test(m)) return '[TOTP_INVALID] The 2FA setup key is not valid — paste the base32 key or the otpauth:// link shown by the site.';
  for (const v of values) if (v && v.length >= 3) m = m.split(v).join('***');
  m = m.split('\n')[0] ?? '';
  return m.length > 300 ? m.slice(0, 299) + '…' : m;
}

// ── broker ──────────────────────────────────────────────────────────────────

export type SecretField = 'username' | 'password' | 'totp';
/** Where a secret may be typed. Deliberately NOT Telegram or any approval channel. */
export type SecretSurface = 'terminal' | 'control';
const SURFACES: readonly SecretSurface[] = ['terminal', 'control'];

export interface SecretRequestInput {
  /** Vault entry to create, or to update when it exists on the same site. */
  entryName: string;
  /** Sites the entry is bound to (normalized origins like "github.com"). */
  origins: string[];
  /** What to ask. The password is always asked. */
  fields: SecretField[];
  /** Why the agent needs it (shown to the human). */
  reason: string;
  /** Pre-fills the username box (not a secret). */
  usernameHint?: string;
  /** Extra line for the human, e.g. "the active tab is on other.com". */
  warning?: string;
  /** Give up after this long (default 10 min). */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** What surfaces show. Never a value. */
export interface PendingSecretRequest {
  id: string;
  entryName: string;
  origins: string[];
  /** ASCII host of the first origin. */
  host: string;
  /** Unicode host (+ the punycode form when they differ). */
  displayHost: string;
  fields: SecretField[];
  reason: string;
  usernameHint?: string;
  warning?: string;
  /** The entry already exists: this rotates its password (other fields kept). */
  existing: boolean;
  createdAt: number;
  expiresAt: number;
}

export type SecretRequestCode = 'saved' | 'cancelled' | 'timeout' | 'aborted' | 'no-surface' | 'busy' | 'rate-limited' | 'invalid';

export interface SecretRequestResult {
  ok: boolean;
  code: SecretRequestCode;
  /** Surface that answered / cancelled ('terminal', 'control', 'timeout', …). */
  by: string;
  /** The saved entry — summary only (no secret, no TOTP seed). */
  summary?: { name: string; origins: string[]; fields: SecretField[]; updated: boolean };
  /** Human-readable reason for a failure (never contains a value). */
  message?: string;
}

/** Typed values from a surface. Consumed once, never stored. */
export interface SecretAnswer {
  username?: string;
  password?: string;
  totp?: string;
}

export type SecretAnswerOutcome = { ok: true; summary: NonNullable<SecretRequestResult['summary']> } | { ok: false; error: string };

interface Entry {
  p: PendingSecretRequest;
  resolve: (r: SecretRequestResult) => void;
  timer?: NodeJS.Timeout;
  onAbort?: () => void;
  signal?: AbortSignal;
  busy: boolean;
  done: boolean;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const RATE_WINDOW_MS = 10 * 60_000;
const RATE_MAX = 6;

function clip(s: unknown, n: number): string {
  const t = String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

export class SecretRequestBroker {
  private entries = new Map<string, Entry>();
  private listeners = new Set<(pending: PendingSecretRequest[]) => void>();
  private attached = new Map<SecretSurface, number>();
  private probes = new Map<SecretSurface, () => boolean>();
  private recentRequests: number[] = [];

  constructor(
    private readonly vaultOf: () => VaultLike = getVault,
    private readonly now: () => number = Date.now,
  ) {}

  // ── surfaces ──────────────────────────────────────────────────────────────

  /** A surface that can take a secret is on screen (the TUI while it runs). */
  attachSurface(name: SecretSurface): () => void {
    this.attached.set(name, (this.attached.get(name) ?? 0) + 1);
    this.emit();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const n = (this.attached.get(name) ?? 1) - 1;
      if (n <= 0) this.attached.delete(name); else this.attached.set(name, n);
    };
  }

  /** A surface whose availability is a live condition (the control center is running). */
  setSurfaceProbe(name: SecretSurface, probe: (() => boolean) | null): void {
    if (probe) this.probes.set(name, probe); else this.probes.delete(name);
  }

  availableSurfaces(): SecretSurface[] {
    return SURFACES.filter(s => (this.attached.get(s) ?? 0) > 0 || (() => { try { return !!this.probes.get(s)?.(); } catch { return false; } })());
  }

  // ── requests ──────────────────────────────────────────────────────────────

  pending(): PendingSecretRequest[] {
    return [...this.entries.values()].filter(e => !e.done).map(e => ({ ...e.p, origins: [...e.p.origins], fields: [...e.p.fields] }));
  }

  get(id: string): PendingSecretRequest | undefined {
    const e = this.entries.get(id);
    return e && !e.done ? { ...e.p } : undefined;
  }

  onChange(listener: (pending: PendingSecretRequest[]) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Ask the human for a login. Never rejects; resolves with metadata only. */
  async request(input: SecretRequestInput): Promise<SecretRequestResult> {
    let entryName: string;
    let origins: string[];
    try {
      entryName = validateEntryName(input.entryName);
      origins = [...new Set((input.origins ?? []).map(o => {
        const n = normalizeOrigin(o);
        if (!n) throw new Error(`[VAULT_INVALID] "${clip(o, 80)}" is not a usable site (https, or http only for localhost)`);
        return formatOrigin(n);
      }))];
      if (!origins.length) throw new Error('[VAULT_INVALID] a site is required');
    } catch (e) {
      return { ok: false, code: 'invalid', by: 'broker', message: scrubSecretError(e, []) };
    }
    if (!this.availableSurfaces().length) {
      return { ok: false, code: 'no-surface', by: 'broker', message: 'No secure input is open: the terminal UI is not running and the control center is off.' };
    }
    if ([...this.entries.values()].some(e => !e.done)) {
      return { ok: false, code: 'busy', by: 'broker', message: 'Another login request is already waiting for the user.' };
    }
    const now = this.now();
    this.recentRequests = this.recentRequests.filter(t => now - t < RATE_WINDOW_MS);
    if (this.recentRequests.length >= RATE_MAX) {
      return { ok: false, code: 'rate-limited', by: 'broker', message: `Too many login requests (${RATE_MAX} in 10 minutes).` };
    }
    if (input.signal?.aborted) return { ok: false, code: 'aborted', by: 'abort' };
    this.recentRequests.push(now);

    let existing = false;
    try {
      const e = await this.vaultOf().get(entryName);
      if (e) {
        // Rotating an entry of ANOTHER site would let a page re-bind someone's login.
        if (!sameSite(origins, e.origins)) {
          return { ok: false, code: 'invalid', by: 'broker', message: `[VAULT_EXISTS] the entry "${e.name}" belongs to ${e.origins.join(', ')} — pick another name` };
        }
        existing = true;
        entryName = e.name;
      }
    } catch (e) {
      return { ok: false, code: 'invalid', by: 'broker', message: scrubSecretError(e, []) };
    }

    const fields: SecretField[] = ['username', 'password', ...(input.fields?.includes('totp') ? ['totp' as const] : [])];
    const host = normalizeOrigin(origins[0]!)!.host;
    const timeoutMs = input.timeoutMs && input.timeoutMs > 0 ? input.timeoutMs : DEFAULT_TIMEOUT_MS;
    const p: PendingSecretRequest = {
      id: 'sr_' + randomBytes(9).toString('base64url'),
      entryName,
      origins,
      host,
      displayHost: displayHost(host),
      fields,
      reason: clip(input.reason, 300),
      ...(input.usernameHint && clip(input.usernameHint, 200) ? { usernameHint: clip(input.usernameHint, 200) } : {}),
      ...(input.warning ? { warning: clip(input.warning, 300) } : {}),
      existing,
      createdAt: now,
      expiresAt: now + timeoutMs,
    };

    return new Promise<SecretRequestResult>((resolve) => {
      const entry: Entry = { p, resolve, busy: false, done: false, signal: input.signal };
      this.entries.set(p.id, entry);
      entry.timer = setTimeout(() => this.finish(p.id, { ok: false, code: 'timeout', by: 'timeout' }), timeoutMs);
      entry.timer.unref?.();
      if (input.signal) {
        entry.onAbort = () => this.finish(p.id, { ok: false, code: 'aborted', by: 'abort' });
        input.signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      this.notice('info', `🔐 QodeX asks for the login for ${p.displayHost} (vault entry "${p.entryName}") — type it in the terminal prompt or the control center's secure form, never in a chat.`);
      this.emit();
    });
  }

  /**
   * Values typed on a surface. Saves them straight into the vault and resolves the
   * request with a summary. A bad value (invalid 2FA key, …) keeps the request open
   * so the human can correct it; the error never contains what was typed.
   */
  async answer(id: string, values: SecretAnswer, by: SecretSurface): Promise<SecretAnswerOutcome> {
    if (!SURFACES.includes(by)) return { ok: false, error: '[SECRET_SURFACE_REFUSED] secrets are only accepted from the terminal prompt or the control center form' };
    const e = this.entries.get(id);
    if (!e || e.done) return { ok: false, error: '[SECRET_REQUEST_NOT_FOUND] that request was already answered, cancelled or expired' };
    if (e.busy) return { ok: false, error: '[SECRET_REQUEST_BUSY] the previous answer is still being saved' };
    const username = typeof values?.username === 'string' ? values.username.trim() : '';
    const password = typeof values?.password === 'string' ? values.password : '';
    const totpRaw = typeof values?.totp === 'string' ? values.totp.trim() : '';
    const typed = [password, totpRaw];
    if (!password) return { ok: false, error: '[SECRET_EMPTY] the password is empty' };
    if (password.length > 4096 || username.length > 512 || totpRaw.length > 2048) return { ok: false, error: '[SECRET_TOO_LONG] a value is too long' };
    if (totpRaw && !e.p.fields.includes('totp')) return { ok: false, error: '[SECRET_FIELD_REFUSED] this request did not ask for a 2FA key' };
    if (totpRaw) {
      try { parseTotpInput(totpRaw); } catch (err) { return { ok: false, error: scrubSecretError(err, typed) }; }
    }
    e.busy = true;
    let summary: VaultEntrySummary;
    try {
      const vault = this.vaultOf();
      if (e.p.existing) {
        const cur = await vault.get(e.p.entryName);
        const origins = cur ? [...new Set([...cur.origins, ...e.p.origins])] : e.p.origins;
        summary = cur
          ? await vaultUpdate(vault, e.p.entryName, { origins, secret: password, ...(username ? { username } : {}), ...(totpRaw ? { totp: totpRaw } : {}) })
          : await vault.add({ name: e.p.entryName, origins, secret: password, username: username || undefined, totp: totpRaw || undefined });
      } else {
        summary = await vault.add({ name: e.p.entryName, origins: e.p.origins, secret: password, username: username || undefined, totp: totpRaw || undefined });
      }
    } catch (err) {
      e.busy = false;
      return { ok: false, error: scrubSecretError(err, typed) };
    }
    const fields: SecretField[] = [summary.hasUsername && 'username', summary.hasSecret && 'password', summary.hasTotp && 'totp'].filter(Boolean) as SecretField[];
    const out = { name: summary.name, origins: [...summary.origins], fields, updated: e.p.existing };
    this.finish(id, { ok: true, code: 'saved', by, summary: out });
    return { ok: true, summary: out };
  }

  /** The human declined (Esc in the terminal, Cancel in the form) or the asker gave up. */
  cancel(id: string, by: string): boolean {
    const e = this.entries.get(id);
    if (!e || e.done) return false;
    this.finish(id, { ok: false, code: 'cancelled', by: clip(by, 40) || 'cancel' });
    return true;
  }

  private finish(id: string, result: SecretRequestResult): void {
    const e = this.entries.get(id);
    if (!e || e.done) return;
    e.done = true;
    if (e.timer) clearTimeout(e.timer);
    if (e.onAbort) e.signal?.removeEventListener('abort', e.onAbort);
    this.entries.delete(id);
    const what = `the login for ${e.p.displayHost}`;
    if (result.ok) this.notice('info', `🔐 Saved ${what} in the vault as "${result.summary?.name ?? e.p.entryName}".`);
    else this.notice('info', `🔐 The request for ${what} ended: ${result.code}.`);
    this.emit();
    e.resolve(result);
  }

  private notice(level: 'info' | 'warn', message: string): void {
    try { getBus().publish({ kind: 'notice', level, message }); } catch { /* never break the caller */ }
  }

  private emit(): void {
    const list = this.pending();
    for (const l of [...this.listeners]) {
      try { l(list); } catch { /* isolate listener failures */ }
    }
  }

  /** Test helper: cancel everything and detach all surfaces. */
  reset(): void {
    for (const id of [...this.entries.keys()]) this.finish(id, { ok: false, code: 'cancelled', by: 'reset' });
    this.attached.clear();
    this.probes.clear();
    this.recentRequests = [];
  }
}

let instance: SecretRequestBroker | null = null;

export function getSecretRequestBroker(): SecretRequestBroker {
  if (!instance) instance = new SecretRequestBroker();
  return instance;
}

/** Test hook: install a broker (e.g. with a temp vault) or reset to the default. */
export function setSecretRequestBrokerForTests(b: SecretRequestBroker | null): void {
  instance = b;
}
