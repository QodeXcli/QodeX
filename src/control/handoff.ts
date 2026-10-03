/**
 * Human hand-off plumbing shared by the surfaces that show one (control center,
 * Telegram, terminal): what a hand-off approval looks like, whether it is still
 * running, how a human answers it, and the short-lived scoped links that open the
 * control center's live view for ONE hand-off.
 *
 * A hand-off is raised by the browser's HandoffController (a CAPTCHA / bot check
 * that needs a person): it takes an OWNED takeover (`handoff:<id>`) and asks
 * through the ApprovalBroker with options ['done', 'cancel'] and
 * `meta.handoff = {id, host, vendor, state, tabIndex, frameBox, linkTtlSec}`.
 * QodeX never solves the challenge itself — the human does, and the controller
 * resumes by itself once it is gone (`by: 'challenge-cleared'`).
 *
 * Hand-off links: `/?h=<token>&handoff=<id>`. The token is 256 random bits, handed
 * out ONCE (Telegram's URL button) and stored here only as its sha256. It opens
 * the live view of its hand-off and nothing else (no approvals, actions, missions,
 * steering, stop or vault), and dies at its TTL or when the hand-off ends,
 * whichever comes first. This module has no I/O and imports nothing heavy, so the
 * terminal UI can use it without loading the HTTP server.
 */

import { createHash, randomBytes } from 'node:crypto';
import { getApprovalBroker, type ApprovalBroker, type PendingApproval } from './approvals.js';
import type { BusEvent } from './bus.js';
import { peekBrowserManager, type BrowserManager } from '../tools/browser/types.js';

// ── hand-off metadata ─────────────────────────────────────────────────────────

/** Where the challenge sits on the page, in viewport CSS pixels. */
export interface HandoffFrameBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** `meta.handoff` of a hand-off approval (validated copy; unknown fields dropped). */
export interface HandoffMeta {
  id: string;
  host?: string;
  vendor?: string;
  state?: string;
  tabIndex?: number;
  frameBox?: HandoffFrameBox;
  linkTtlSec?: number;
}

/** Hand-off ids are short opaque tokens (they ride in URLs and takeover owners). */
export const HANDOFF_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
/** The options a hand-off approval is asked with. */
export const HANDOFF_OPTIONS = ['done', 'cancel'] as const;
export type HandoffAnswer = (typeof HANDOFF_OPTIONS)[number];
/** Broker `by` of the controller's automatic resolve when the challenge disappeared. */
export const HANDOFF_CLEARED_BY = 'challenge-cleared';
/** Default and bounds of a hand-off link's lifetime. */
export const DEFAULT_HANDOFF_LINK_TTL_MS = 10 * 60_000;
const MIN_LINK_TTL_MS = 15_000;
const MAX_LINK_TTL_MS = 24 * 3600_000;
/** Live links kept at most (the oldest is dropped first). */
const MAX_LINKS = 64;
/** How long an ended hand-off's outcome is remembered (for a late page refresh). */
const OUTCOME_TTL_MS = 15 * 60_000;
const MAX_OUTCOMES = 100;

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function clipStr(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return s ? s.slice(0, max) : undefined;
}

/** Validated `meta.handoff` of an approval's meta, or null when it is not a hand-off. PURE. */
export function handoffMetaOf(meta: unknown): HandoffMeta | null {
  if (!isObj(meta) || !isObj(meta.handoff)) return null;
  const h = meta.handoff;
  if (typeof h.id !== 'string' || !HANDOFF_ID_RE.test(h.id)) return null;
  const out: HandoffMeta = { id: h.id };
  const host = clipStr(h.host, 253);
  if (host) out.host = host;
  const vendor = clipStr(h.vendor, 40);
  if (vendor) out.vendor = vendor;
  const state = clipStr(h.state, 24);
  if (state) out.state = state;
  if (finite(h.tabIndex) && h.tabIndex >= 0 && h.tabIndex < 1000) out.tabIndex = Math.floor(h.tabIndex);
  if (isObj(h.frameBox)) {
    const b = h.frameBox;
    const width = finite(b.width) ? b.width : b.w;
    const height = finite(b.height) ? b.height : b.h;
    if (finite(b.x) && finite(b.y) && finite(width) && finite(height) && width > 0 && height > 0
      && Math.abs(b.x) < 100_000 && Math.abs(b.y) < 100_000 && width < 100_000 && height < 100_000) {
      out.frameBox = { x: b.x, y: b.y, width, height };
    }
  }
  if (finite(h.linkTtlSec) && h.linkTtlSec > 0) out.linkTtlSec = Math.min(86_400, h.linkTtlSec);
  return out;
}

/** True when this pending approval is a hand-off. PURE. */
export function isHandoffApproval(p: Pick<PendingApproval, 'meta'> | null | undefined): boolean {
  return !!p && handoffMetaOf(p.meta) !== null;
}

/** The takeover owner a hand-off holds. */
export function handoffOwner(handoffId: string): string {
  return `handoff:${handoffId}`;
}

/** Hand-off id of a takeover owner (`handoff:<id>`), else null. PURE. */
export function handoffIdOfOwner(by: string | undefined | null): string | null {
  if (typeof by !== 'string' || !by.startsWith('handoff:')) return null;
  const id = by.slice('handoff:'.length);
  return HANDOFF_ID_RE.test(id) ? id : null;
}

/** The pending broker approval of hand-off `handoffId`, if any. */
export function findHandoffApproval(handoffId: string, broker: ApprovalBroker = getApprovalBroker()): PendingApproval | undefined {
  return broker.pending().find(p => handoffMetaOf(p.meta)?.id === handoffId);
}

/**
 * The pending hand-off approval a terminal prompt belongs to (the operator hub
 * carries prompt + options only): same prompt text and options, meta.handoff set.
 */
export function handoffForPrompt(prompt: string, options: string[], broker: ApprovalBroker = getApprovalBroker()): { approval: PendingApproval; handoff: HandoffMeta } | null {
  for (const p of broker.pending()) {
    const h = handoffMetaOf(p.meta);
    if (!h) continue;
    if (p.prompt === prompt && p.options.length === options.length && p.options.every((o, i) => o === options[i])) return { approval: p, handoff: h };
  }
  return null;
}

function safeTakeoverBy(mgr: BrowserManager | null): string | undefined {
  if (!mgr) return undefined;
  try {
    return mgr.isTakeover() ? mgr.status().takeoverBy : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Is hand-off `handoffId` still running? Yes while its approval is pending OR the
 * browser takeover is still owned by it (the controller re-checks the page after a
 * "done" and may ask again — the human's link must survive that gap).
 */
export function isHandoffActive(
  handoffId: string,
  deps: { broker?: ApprovalBroker; browser?: () => BrowserManager | null } = {},
): boolean {
  if (!HANDOFF_ID_RE.test(handoffId)) return false;
  if (findHandoffApproval(handoffId, deps.broker)) return true;
  let mgr: BrowserManager | null = null;
  try { mgr = (deps.browser ?? peekBrowserManager)(); } catch { mgr = null; }
  return handoffIdOfOwner(safeTakeoverBy(mgr)) === handoffId;
}

/**
 * Answer hand-off `handoffId` for the human ('done' = "I solved it, check again";
 * 'cancel' = "I can't"). Maps onto the approval's own options. Returns false when
 * no approval of that hand-off is pending (answered already, or the controller is
 * re-checking the page right now).
 */
export function answerHandoff(handoffId: string, answer: HandoffAnswer, by: string, broker: ApprovalBroker = getApprovalBroker()): boolean {
  const p = findHandoffApproval(handoffId, broker);
  if (!p) return false;
  const option = answer === 'done'
    ? p.options.find(o => /^(done|continue|solved|ok|y)/i.test(o.trim()))
    : p.options.find(o => /^(cancel|n|deny|reject|stop|skip)/i.test(o.trim()));
  if (!option) return false;
  return broker.resolve(p.id, option, by);
}

// ── outcomes (for a late page refresh: "cleared" vs "ended") ────────────────────

export type HandoffOutcome = 'cleared' | 'done' | 'cancelled' | 'timeout' | 'stopped';

const approvalToHandoff = new Map<string, string>();
const outcomes = new Map<string, { outcome: HandoffOutcome; at: number }>();

/** How an approval result reads for the human. PURE. */
export function handoffOutcomeOf(result: { answer: string; by: string }): HandoffOutcome {
  if (result.by === HANDOFF_CLEARED_BY) return 'cleared';
  if (result.by === 'timeout') return 'timeout';
  if (/^(abort|user-stop|reset|fallback|local-error|cancel)$/.test(result.by)) return 'stopped';
  return /^(done|continue|solved|ok|y)/i.test(result.answer) ? 'done' : 'cancelled';
}

/** Feed bus events here (the control center does) to remember how hand-offs ended. */
export function noteHandoffBusEvent(ev: BusEvent): void {
  if (ev.kind === 'approval.requested') {
    const h = handoffMetaOf(ev.meta);
    if (!h) return;
    approvalToHandoff.set(ev.id, h.id);
    if (approvalToHandoff.size > MAX_OUTCOMES) approvalToHandoff.delete(approvalToHandoff.keys().next().value as string);
  } else if (ev.kind === 'approval.resolved') {
    const id = approvalToHandoff.get(ev.id);
    if (!id) return;
    approvalToHandoff.delete(ev.id);
    outcomes.delete(id);
    outcomes.set(id, { outcome: handoffOutcomeOf(ev), at: Date.now() });
    if (outcomes.size > MAX_OUTCOMES) outcomes.delete(outcomes.keys().next().value as string);
  }
}

/** The last known outcome of hand-off `handoffId` (null when unknown or too old). */
export function lastHandoffOutcome(handoffId: string, now = Date.now()): HandoffOutcome | null {
  const o = outcomes.get(handoffId);
  if (!o || now - o.at > OUTCOME_TTL_MS) return null;
  return o.outcome;
}

// ── scoped links ──────────────────────────────────────────────────────────────

/** A hand-off token: 32 random bytes, base64url (43 chars). */
export const HANDOFF_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** sha256 (hex) of a hand-off token — the only form that is ever stored. PURE. */
export function hashHandoffToken(token: string): string {
  return createHash('sha256').update(String(token), 'utf8').digest('hex');
}

/** Clamp a requested link lifetime. PURE. */
export function clampLinkTtlMs(ttlMs: unknown): number {
  const v = typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_HANDOFF_LINK_TTL_MS;
  return Math.round(Math.min(MAX_LINK_TTL_MS, Math.max(MIN_LINK_TTL_MS, v)));
}

interface LinkEntry {
  handoffId: string;
  expiresAt: number;
}

export type HandoffLinkLookup =
  | { status: 'active'; handoffId: string; expiresAt: number }
  | { status: 'expired' | 'ended'; handoffId: string }
  | { status: 'unknown' };

/**
 * Hashed store of hand-off link tokens. `mint` returns the raw token exactly once;
 * afterwards only `sha256(token)` exists in memory. Lookups never throw.
 */
export class HandoffLinkStore {
  private byHash = new Map<string, LinkEntry>();

  /** Create a token for `handoffId` that lives `ttlMs` (clamped). */
  mint(handoffId: string, ttlMs: number, now = Date.now()): { token: string; expiresAt: number } {
    if (!HANDOFF_ID_RE.test(handoffId)) throw new Error('[HANDOFF_BAD_ID] Invalid hand-off id.');
    this.prune(now);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = now + clampLinkTtlMs(ttlMs);
    this.byHash.set(hashHandoffToken(token), { handoffId, expiresAt });
    while (this.byHash.size > MAX_LINKS) this.byHash.delete(this.byHash.keys().next().value as string);
    return { token, expiresAt };
  }

  /**
   * What `token` opens right now. `isActive` says whether its hand-off is still
   * running; a token of an ended hand-off is revoked on the spot.
   */
  lookup(token: string | null | undefined, isActive: (handoffId: string) => boolean, now = Date.now()): HandoffLinkLookup {
    if (typeof token !== 'string' || !HANDOFF_TOKEN_RE.test(token)) return { status: 'unknown' };
    const key = hashHandoffToken(token);
    const e = this.byHash.get(key);
    if (!e) return { status: 'unknown' };
    if (now >= e.expiresAt) { this.byHash.delete(key); return { status: 'expired', handoffId: e.handoffId }; }
    let active = false;
    try { active = isActive(e.handoffId); } catch { active = false; }
    if (!active) { this.byHash.delete(key); return { status: 'ended', handoffId: e.handoffId }; }
    return { status: 'active', handoffId: e.handoffId, expiresAt: e.expiresAt };
  }

  /** Revoke one token (e.g. Telegram refused the button that carried it). */
  revokeToken(token: string): boolean {
    return this.byHash.delete(hashHandoffToken(token));
  }

  /** Revoke every token of a hand-off. */
  revokeHandoff(handoffId: string): number {
    let n = 0;
    for (const [k, e] of this.byHash) if (e.handoffId === handoffId) { this.byHash.delete(k); n++; }
    return n;
  }

  /** Drop expired tokens (and, with `isActive`, those of ended hand-offs). */
  prune(now = Date.now(), isActive?: (handoffId: string) => boolean): void {
    for (const [k, e] of this.byHash) {
      if (now >= e.expiresAt) { this.byHash.delete(k); continue; }
      if (isActive) {
        let active = false;
        try { active = isActive(e.handoffId); } catch { active = false; }
        if (!active) this.byHash.delete(k);
      }
    }
  }

  size(): number {
    return this.byHash.size;
  }

  /** Stored keys (sha256 hex) — for tests that check nothing raw is kept. */
  storedKeysForTests(): string[] {
    return [...this.byHash.keys()];
  }

  clear(): void {
    this.byHash.clear();
  }
}

let links: HandoffLinkStore | null = null;

/** The process-wide hand-off link store (the control center serves its tokens). */
export function getHandoffLinks(): HandoffLinkStore {
  if (!links) links = new HandoffLinkStore();
  return links;
}

/** Mask hand-off tokens (`h=<token>`) in free text. PURE. */
export function maskHandoffTokens(text: string): string {
  return String(text ?? '').replace(/([?&]h=)[A-Za-z0-9_-]{16,}/g, '$1***');
}

// ── terminal hint ─────────────────────────────────────────────────────────────

let localUrlProvider: (() => string | null) | null = null;

/** The control center registers how to reach it locally (owner URL), or null when stopped. */
export function setHandoffLocalUrlProvider(fn: (() => string | null) | null): void {
  localUrlProvider = fn;
}

/** Local control-center URL that opens hand-off `handoffId` (owner link), or null. */
export function localHandoffUrl(handoffId: string): string | null {
  if (!localUrlProvider || !HANDOFF_ID_RE.test(handoffId)) return null;
  let base: string | null = null;
  try { base = localUrlProvider(); } catch { base = null; }
  if (!base) return null;
  return `${base}${base.includes('?') ? '&' : '?'}handoff=${encodeURIComponent(handoffId)}`;
}

/** Terminal hint lines for a hand-off prompt (en/fa). PURE apart from the URL lookup. */
export function handoffTerminalHint(handoff: HandoffMeta, lang: 'en' | 'fa' = 'en', url: string | null = localHandoffUrl(handoff.id)): string[] {
  const lines: string[] = [];
  if (lang === 'fa') {
    lines.push('آن را در پنجرهٔ مرورگر یا مرکز کنترل حل کنید — QodeX خودش ادامه می‌دهد.');
    lines.push(url ? `مرکز کنترل: ${url}` : 'مرکز کنترل: /control');
    lines.push('d انجام شد · c نمی‌توانم · Esc توقف کار');
  } else {
    lines.push('Solve it in the browser window or the control center — QodeX continues automatically.');
    lines.push(url ? `Control center: ${url}` : 'Control center: /control');
    lines.push('d done · c can\'t solve it · Esc stops the task');
  }
  return lines;
}
