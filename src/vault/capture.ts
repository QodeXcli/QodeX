/**
 * Save-login capture: when the HUMAN logs in while holding takeover (control-center
 * live view), offer to save that login in the vault — like a browser's password
 * manager, but with a yes/no that never contains the secret.
 *
 *   1. src/tools/browser/session.ts calls `beforeInput` right before it dispatches a
 *      human click or Enter (never for the agent's own actions, which do not go
 *      through dispatchInput; never without takeover).
 *   2. We read the login HOST-SIDE from the frame that owns the target (following
 *      iframes by focus / hit point) with an in-page probe built from a string; the
 *      probe's window.origin must equal the frame URL's origin. Only a submit-like
 *      input counts: Enter in a login field, or a click on a submit control.
 *   3. The candidate lives in memory only (per tab, short TTL, never serialized —
 *      toJSON / inspect show a placeholder) until the navigation that follows the
 *      submit lands on a page without a login form (else — wrong password, 2FA step —
 *      until takeover ends); then ApprovalBroker asks
 *      "Save the login for <host> (user <masked>)?" — terminal and control center.
 *   4. Yes → vault.add (new entry name derived from the host) or a merge-patch of the
 *      matching entry. Bus notices carry metadata only; failures are logged scrubbed.
 */

import { inspect } from 'util';
import { getBus } from '../control/bus.js';
import { getApprovalBroker, isApproval, type ApprovalBroker, type LocalAsker } from '../control/approvals.js';
import { logger } from '../utils/logger.js';
import { getVault, normalizeOrigin, formatOrigin } from './vault.js';
import {
  deriveEntryName, displayHost, maskUsername, scrubSecretError, vaultFindByOrigin, vaultUpdate, type VaultLike,
} from './requests.js';

// ── in-page probes (plain JS source; no DOM types on the host side) ─────────

/**
 * (arg: {mode:'enter'} | {mode:'click', x, y}) → {origin, iframe?} | {origin, user}
 *   | {origin, submit:true, username, password}. Runs in the frame that owns the target.
 */
export const LOGIN_PROBE_JS = String.raw`(function (a) {
  var d = document, origin = String(window.origin);
  function vis(e) { try { var r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch (x) { return false; } }
  function typ(e) { return String(e.getAttribute('type') || 'text').toLowerCase(); }
  function texty(e) { var t = typ(e); return (t === 'text' || t === 'email' || t === 'tel') && !!e.value && vis(e); }
  var t = a.mode === 'click' ? d.elementFromPoint(a.x, a.y) : d.activeElement;
  if (!t) return { origin: origin };
  if (t.tagName === 'IFRAME' || t.tagName === 'FRAME') return { origin: origin, iframe: true };
  var form = t.closest ? t.closest('form') : null;
  var scope = form || d;
  var all = [].slice.call(scope.querySelectorAll('input'));
  var pws = all.filter(function (e) { return typ(e) === 'password' && !!e.value && vis(e); });
  var ok = false;
  if (a.mode === 'enter') {
    ok = t.tagName === 'INPUT' && (!!form || typ(t) === 'password');
  } else {
    var c = t.closest ? t.closest('button,input[type=submit],input[type=image],[role=button],a') : null;
    if (c) {
      var ct = String(c.getAttribute('type') || '').toLowerCase();
      var label = String(c.textContent || c.value || c.getAttribute('aria-label') || '').toLowerCase();
      var submitControl = (c.tagName === 'BUTTON' && ct !== 'button' && ct !== 'reset') || (c.tagName === 'INPUT' && (ct === 'submit' || ct === 'image'));
      ok = (!!form && form.contains(c) && submitControl) || /\b(log ?in|sign ?in|continue|next|submit)\b|ورود|ادامه/.test(label);
    }
  }
  if (!ok) return { origin: origin };
  var users = all.filter(texty);
  var user = '';
  for (var i = 0; i < users.length; i++) {
    if (/username|email/.test(String(users[i].getAttribute('autocomplete') || ''))) { user = users[i].value; break; }
  }
  if (!pws.length) {
    // first step of a two-step login (username now, password on the next page)
    if (!user) for (var k = 0; k < users.length; k++) {
      var e0 = users[k];
      if (typ(e0) === 'email' || /user|mail|login|identifier/i.test(String(e0.name || '') + ' ' + String(e0.id || ''))) { user = e0.value; break; }
    }
    return user ? { origin: origin, user: String(user).slice(0, 512) } : { origin: origin };
  }
  var first = pws[0], pw = first.value;
  // change-password / sign-up forms: the last two equal fields are the new password
  if (pws.length >= 2 && pws[pws.length - 1].value === pws[pws.length - 2].value) pw = pws[pws.length - 1].value;
  if (!user) for (var j = users.length - 1; j >= 0; j--) {
    if (users[j].compareDocumentPosition(first) & 4) { user = users[j].value; break; }
  }
  return { origin: origin, submit: true, username: String(user).slice(0, 512), password: String(pw).slice(0, 4096) };
})`;

/** Is a login form (a visible password field) still on the page? */
export const PASSWORD_VISIBLE_JS = String.raw`(function () {
  var l = document.querySelectorAll('input[type=password]');
  for (var i = 0; i < l.length; i++) { var r = l[i].getBoundingClientRect(); if (r.width > 0 && r.height > 0) return true; }
  return false;
})()`;

/** `e === its document's activeElement` — used on an iframe's element handle. */
const IS_ACTIVE_FN = new Function('e', 'return e === e.ownerDocument.activeElement;') as (e: unknown) => boolean;

// ── host side ───────────────────────────────────────────────────────────────

/** The Playwright surface we use (duck-typed so tests and session.ts share it). */
export interface FrameLike {
  url(): string;
  evaluate(expr: string): Promise<unknown>;
  childFrames(): FrameLike[];
  frameElement(): Promise<{ boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>; evaluate(fn: (e: unknown) => boolean): Promise<unknown> }>;
}
export interface PageLike { mainFrame(): FrameLike }

export type SubmittedLogin =
  | { kind: 'login'; origin: string; url: string; username: string; password: string }
  | { kind: 'user'; origin: string; username: string };

function frameOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch { return null; }
}

async function evalProbe(frame: FrameLike, arg: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  try {
    const r = await frame.evaluate(`(${LOGIN_PROBE_JS})(${JSON.stringify(arg)})`);
    return r && typeof r === 'object' ? r as Record<string, unknown> : null;
  } catch { return null; }
}

async function childAt(frame: FrameLike, kind: 'click' | 'enter', abs?: { x: number; y: number }): Promise<{ frame: FrameLike; x: number; y: number } | null> {
  for (const child of frame.childFrames().slice(0, 24)) {
    let el;
    try { el = await child.frameElement(); } catch { continue; }
    if (kind === 'click' && abs) {
      const box = await el.boundingBox().catch(() => null);
      if (box && abs.x >= box.x && abs.x < box.x + box.width && abs.y >= box.y && abs.y < box.y + box.height) return { frame: child, x: box.x, y: box.y };
    } else if (await el.evaluate(IS_ACTIVE_FN).catch(() => false)) {
      return { frame: child, x: 0, y: 0 };
    }
  }
  return null;
}

/**
 * Read what a human submit is about to send, from the frame that owns the target.
 * Null when it is not a login submit, the frame cannot be read, or its origin does
 * not match its URL (or is not a site the vault accepts).
 */
export async function readSubmittedLogin(page: PageLike, kind: 'click' | 'enter', point?: { x: number; y: number }): Promise<SubmittedLogin | null> {
  let frame: FrameLike;
  try { frame = page.mainFrame(); } catch { return null; }
  let ox = 0;
  let oy = 0;
  for (let depth = 0; depth < 5; depth++) {
    const arg = kind === 'click' && point ? { mode: 'click', x: point.x - ox, y: point.y - oy } : { mode: 'enter' };
    const r = await evalProbe(frame, arg);
    if (!r) return null;
    if (r.iframe === true) {
      const next = await childAt(frame, kind, point);
      if (!next) return null;
      frame = next.frame;
      ox = next.x;
      oy = next.y;
      continue;
    }
    let url = '';
    try { url = String(frame.url()); } catch { return null; }
    const origin = frameOrigin(url);
    if (!origin || r.origin !== origin || !normalizeOrigin(origin)) return null;
    if (r.submit === true && typeof r.password === 'string' && r.password) {
      return { kind: 'login', origin, url, username: typeof r.username === 'string' ? r.username.trim() : '', password: r.password };
    }
    if (typeof r.user === 'string' && r.user.trim()) return { kind: 'user', origin, username: r.user.trim() };
    return null;
  }
  return null;
}

/** A login waiting for the yes/no. Never serialized: JSON / inspect show a placeholder. */
class Candidate {
  /** The page after the submit still showed a login form: ask only when takeover ends. */
  deferred = false;
  constructor(
    readonly origin: string,
    readonly url: string,
    readonly username: string,
    readonly password: string,
    readonly at: number,
  ) {}
  toJSON(): string { return '[login candidate]'; }
  [inspect.custom](): string { return '[login candidate]'; }
}

export type OfferOutcome = 'saved' | 'updated' | 'declined' | 'unchanged' | 'skipped' | 'failed';

export interface LoginCaptureOptions {
  vault?: () => VaultLike;
  approvals?: () => ApprovalBroker;
  localAsk?: LocalAsker | null;
  now?: () => number;
  /** Wait after a navigation before checking the login form is gone (ms). */
  settleMs?: number;
  /** Candidates older than this are dropped (ms). */
  ttlMs?: number;
  /** How long the yes/no waits (ms); unanswered = no. */
  askTimeoutMs?: number;
}

/** Minimal page surface for the "still on the login form?" check. */
interface EvalPage { evaluate?(expr: string): Promise<unknown> }

export class LoginCapture {
  private candidates = new Map<string, Candidate>();
  private users = new Map<string, { origin: string; username: string; at: number }>();
  private timers = new Map<string, NodeJS.Timeout>();
  private asking = new Set<string>();
  private readonly vaultOf: () => VaultLike;
  private readonly approvalsOf: () => ApprovalBroker;
  private localAsk: LocalAsker | null;
  private readonly now: () => number;
  private readonly settleMs: number;
  private readonly ttlMs: number;
  private readonly askTimeoutMs: number;
  /** Settles when the latest offer finishes (tests). */
  lastOffer: Promise<OfferOutcome> = Promise.resolve('skipped');

  constructor(opts: LoginCaptureOptions = {}) {
    this.vaultOf = opts.vault ?? getVault;
    this.approvalsOf = opts.approvals ?? getApprovalBroker;
    this.localAsk = opts.localAsk ?? null;
    this.now = opts.now ?? Date.now;
    this.settleMs = opts.settleMs ?? 1500;
    this.ttlMs = opts.ttlMs ?? 3 * 60_000;
    this.askTimeoutMs = opts.askTimeoutMs ?? 5 * 60_000;
  }

  setLocalAsk(ask: LocalAsker | null): void { this.localAsk = ask; }

  /** Number of logins waiting (no values). */
  pendingCount(): number { return this.candidates.size; }

  /** The observer session.ts calls (see HumanInputObserver). */
  observer() {
    return {
      beforeInput: (ctx: { page: unknown; tabId: string; kind: 'click' | 'enter'; point?: { x: number; y: number } }) => this.onBeforeInput(ctx),
      navigated: (tabId: string, page: unknown) => this.onNavigated(tabId, page as EvalPage),
      takeover: (on: boolean) => this.onTakeover(on),
    };
  }

  async onBeforeInput(ctx: { page: unknown; tabId: string; kind: 'click' | 'enter'; point?: { x: number; y: number } }): Promise<void> {
    const got = await readSubmittedLogin(ctx.page as PageLike, ctx.kind, ctx.point);
    if (!got) return;
    const now = this.now();
    if (got.kind === 'user') {
      this.users.set(ctx.tabId, { origin: got.origin, username: got.username, at: now });
      return;
    }
    let username = got.username;
    const prev = this.users.get(ctx.tabId);
    if (!username && prev && prev.origin === got.origin && now - prev.at < this.ttlMs) username = prev.username;
    this.users.delete(ctx.tabId);
    this.candidates.set(ctx.tabId, new Candidate(got.origin, got.url, username, got.password, now));
  }

  onNavigated(tabId: string, page: EvalPage): void {
    // Only the navigation that follows the submit decides; a deferred one waits for takeover end.
    if (!this.candidates.has(tabId) || this.candidates.get(tabId)!.deferred) return;
    const old = this.timers.get(tabId);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
      this.timers.delete(tabId);
      void (async () => {
        // Still on a login form (wrong password, 2FA step…)? Wait for takeover end.
        let still = false;
        try { still = (await page.evaluate?.(PASSWORD_VISIBLE_JS)) === true; } catch { still = false; }
        if (still) {
          const c = this.candidates.get(tabId);
          if (c) c.deferred = true;
          return;
        }
        this.lastOffer = this.offer(tabId);
      })();
    }, this.settleMs);
    timer.unref?.();
    this.timers.set(tabId, timer);
  }

  onTakeover(on: boolean): void {
    if (on) return;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.users.clear();
    for (const id of [...this.candidates.keys()]) this.lastOffer = this.offer(id);
  }

  /** Ask about the candidate of `tabId` and save it on yes. Never throws. */
  async offer(tabId: string): Promise<OfferOutcome> {
    const c = this.candidates.get(tabId);
    this.candidates.delete(tabId);
    if (!c || this.now() - c.at > this.ttlMs || this.asking.has(c.origin)) return 'skipped';
    this.asking.add(c.origin);
    try {
      const vault = this.vaultOf();
      const norm = normalizeOrigin(c.origin);
      if (!norm) return 'skipped';
      const matches = await vaultFindByOrigin(vault, c.url);
      const same = matches.find(e => (e.username ?? '').toLowerCase() === c.username.toLowerCase())
        ?? (!c.username && matches.length === 1 ? matches[0] : undefined);
      if (same) {
        const full = await vault.get(same.name);
        if (full && full.secret === c.password) return 'unchanged';
      }
      const host = displayHost(norm.host);
      const who = c.username ? ` (user ${maskUsername(c.username)})` : '';
      const prompt = same
        ? `Update the saved password for ${host}${who} in the QodeX vault entry "${same.name}"?`
        : `Save the login for ${host}${who} in the QodeX vault?`;
      const r = await this.approvalsOf().request({
        prompt, options: ['yes', 'no'], source: 'vault-capture', category: 'credential', risk: 'medium',
        timeoutMs: this.askTimeoutMs, meta: { host: norm.host, ...(same ? { entry: same.name } : {}) },
      }, this.localAsk ?? undefined);
      if (!isApproval(r.answer, ['yes', 'no'])) return 'declined';
      if (same) {
        await vaultUpdate(vault, same.name, { secret: c.password, ...(c.username && !same.username ? { username: c.username } : {}) });
        this.notice(`🔐 Updated the saved password for ${host} (vault entry "${same.name}").`);
        return 'updated';
      }
      const name = deriveEntryName(norm.host, c.username, (await vault.list()).map(e => e.name));
      await vault.add({ name, origins: [formatOrigin(norm)], username: c.username || undefined, secret: c.password });
      this.notice(`🔐 Saved the login for ${host} in the vault as "${name}".`);
      return 'saved';
    } catch (e) {
      logger.debug('save-login capture failed', { err: scrubSecretError(e, [c.password, c.username]) });
      return 'failed';
    } finally {
      this.asking.delete(c.origin);
    }
  }

  private notice(message: string): void {
    try { getBus().publish({ kind: 'notice', level: 'info', message }); } catch { /* ignore */ }
  }

  /** Test helper: drop everything. */
  reset(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.candidates.clear();
    this.users.clear();
    this.asking.clear();
  }
}

let installed: { capture: LoginCapture; off: () => void } | null = null;

/**
 * Turn the capture on for this process (idempotent). The control center calls it
 * when it starts (takeover only exists there); the TUI passes its local asker so
 * the question also shows in the terminal.
 */
export async function installLoginCapture(opts: { localAsk?: LocalAsker } = {}): Promise<LoginCapture> {
  if (!installed) {
    const { addHumanInputObserver } = await import('../tools/browser/session.js');
    if (!installed) {
      const capture = new LoginCapture();
      installed = { capture, off: addHumanInputObserver(capture.observer()) };
    }
  }
  if (opts.localAsk) installed!.capture.setLocalAsk(opts.localAsk);
  return installed!.capture;
}

/** Test hook. */
export function uninstallLoginCaptureForTests(): void {
  installed?.off();
  installed?.capture.reset();
  installed = null;
}
