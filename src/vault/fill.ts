/**
 * The one way a vault value reaches a page field — shared by browser_fill_secret,
 * browser_login and vault_generate_and_fill.
 *
 *   prepareField  resolve the target (ref / selector / auto-detect), pin the DOM element,
 *                 and check, on the live page: the field's own document is on one of the
 *                 entry's ORIGINS (a cross-origin iframe, an about:blank child it creates
 *                 or a sandboxed frame never receives a secret) and the element is the
 *                 right KIND of field (a password only into <input type=password>, a
 *                 username / code only into a text-like <input>, never a textarea or a
 *                 rich editor that would publish it);
 *   commitFill    last look at the tab's origin right before typing, then fill.
 *
 * Values never appear in a result, an error (scrub), a progress event or an action record
 * (recordFill writes "***").
 */

import { getActiveConfig } from '../config/loader.js';
import { resolveBrowserConfig } from '../config/agent-config.js';
import type { ToolResult } from '../tools/base.js';
import type { BrowserManager } from '../tools/browser/types.js';
import { matchOrigin, type VaultEntry } from './vault.js';
import { totp, totpRemainingSeconds } from './totp.js';

/** What to tell the model when a login is missing: the human adds it privately. */
export const ASK_FOR_LOGIN = 'Ask the user to add it privately: call vault_request_login {site, reason} if you have it (they type it; you never see it), or have them run: qodex vault add <name> --origin <site> [--username <u>] [--totp]. Never ask for a password in the chat.';

export type FieldKind = 'username' | 'password' | 'totp' | 'new-password';

export interface FieldInfo {
  tag: string;
  type: string;
  contentEditable: boolean;
  disabled: boolean;
  readOnly: boolean;
  href: string;
  /** Serialized origin of the field's document ('null' when opaque, '' when unknown). */
  origin: string;
  name: string;
  autocomplete: string;
  /** maxlength / minlength (-1 / 0 when unset). */
  maxLength?: number;
  minLength?: number;
}

/** Runs in the page. Typed `any` because tsconfig has no DOM lib. */
export const inspectField = (el: any): FieldInfo => ({
  tag: String(el?.tagName ?? '').toLowerCase(),
  type: String(el?.getAttribute?.('type') ?? '').toLowerCase(),
  contentEditable: !!el?.isContentEditable,
  disabled: !!el?.disabled,
  readOnly: !!el?.readOnly,
  href: String(el?.ownerDocument?.location?.href ?? ''),
  // window.origin: an about:blank / srcdoc frame INHERITS its creator's origin, which
  // its URL doesn't show ('about:blank'); a sandboxed frame is opaque ('null').
  origin: String(el?.ownerDocument?.defaultView?.origin ?? ''),
  name: String(el?.getAttribute?.('aria-label') || el?.getAttribute?.('name') || el?.getAttribute?.('placeholder') || el?.id || ''),
  autocomplete: String(el?.getAttribute?.('autocomplete') ?? '').toLowerCase(),
  maxLength: typeof el?.maxLength === 'number' ? el.maxLength : -1,
  minLength: typeof el?.minLength === 'number' ? el.minLength : 0,
});

/**
 * The URL whose origin decides whether the field's document may receive the
 * secret. The document's ORIGIN wins over its URL: an about:blank child of an ad
 * iframe has URL "about:blank" but the ad's origin. Unknown origins of about:
 * documents are refused rather than guessed from the tab URL.
 */
function fieldDocumentUrl(info: FieldInfo, pageUrl: string): { url: string } | { refuse: string } {
  const origin = info.origin.trim();
  if (origin === 'null') return { refuse: 'the field is in a sandboxed frame with an opaque origin' };
  if (origin) {
    return /^https?:\/\/[^/]+$/i.test(origin) ? { url: origin + '/' } : { refuse: `the field's document has the origin "${origin.slice(0, 80)}"` };
  }
  if (!info.href) return { url: pageUrl };
  if (info.href.startsWith('about:')) return { refuse: `the field is in an ${info.href.slice(0, 20)} frame of unknown origin` };
  return { url: info.href };
}

export function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return url || '(no page)'; }
}

/** Remove every occurrence of each secret (≥3 chars), keep one line, cap. PURE. */
export function scrub(message: string, ...secrets: Array<string | undefined>): string {
  let m = String(message ?? '');
  for (const s of secrets) if (s && s.length >= 3) m = m.split(s).join('***');
  return m.split('\n')[0].slice(0, 300);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

export function actionTimeoutMs(): number {
  try { return resolveBrowserConfig(getActiveConfig()).actionTimeoutMs; } catch { return 10_000; }
}

/** Inputs a username or one-time code may go into. */
const TEXTLIKE = new Set(['', 'text', 'email', 'tel', 'number', 'username']);

/** Auto-detection selectors per field (first visible match wins; main frame only). */
export const AUTO_SELECTORS: Record<FieldKind, string[]> = {
  password: ['input[type="password"]:not([autocomplete="new-password"])', 'input[type="password"]'],
  'new-password': ['input[type="password"][autocomplete="new-password"]', 'input[type="password"]'],
  username: [
    'input[autocomplete="username"]', 'input[type="email"]', 'input[autocomplete="email"]',
    'input[name*="user" i]', 'input[name*="email" i]', 'input[name*="login" i]', 'input[id*="user" i]',
    'input[id*="email" i]', 'input[id*="login" i]', 'input[name*="identifier" i]', 'input[name*="mobile" i]',
    'input[name*="phone" i]', 'input[type="tel"]',
  ],
  totp: [
    'input[autocomplete="one-time-code"]', 'input[name*="otp" i]', 'input[name*="totp" i]', 'input[id*="otp" i]',
    'input[name*="code" i]', 'input[id*="code" i]', 'input[inputmode="numeric"]',
  ],
};

/** Why `info` is the wrong kind of field for `kind`, or null. PURE. */
export function checkField(kind: FieldKind, info: FieldInfo): string | null {
  if (info.disabled || info.readOnly) return 'The target field is disabled or read-only.';
  if (info.tag !== 'input' || info.contentEditable) {
    return `The target is a <${info.tag || '?'}>${info.contentEditable ? ' (rich editor)' : ''}, not an input field — a secret is only filled into a login input.`;
  }
  if ((kind === 'password' || kind === 'new-password') && info.type !== 'password') {
    return `A password is only filled into a password input; the target is <input type="${info.type || 'text'}">.`;
  }
  if (kind === 'username' && !TEXTLIKE.has(info.type)) {
    return `A username goes into a text/email input; the target is <input type="${info.type}">.`;
  }
  if (kind === 'totp' && !TEXTLIKE.has(info.type) && info.type !== 'password') {
    return `A one-time code goes into a text/number input; the target is <input type="${info.type}">.`;
  }
  return null;
}

/** The first visible match of the auto-detect selectors for `kind` (main frame). */
export async function autoDetect(mgr: BrowserManager, kind: FieldKind): Promise<any | null> {
  const page = await mgr.activePage();
  for (const sel of AUTO_SELECTORS[kind]) {
    const all = page.locator(sel);
    const n = Math.min(await all.count().catch(() => 0), 10);
    for (let i = 0; i < n; i++) {
      const loc = all.nth(i);
      if (await loc.isVisible().catch(() => false)) return loc;
    }
  }
  return null;
}

/** Every visible element for a selector (main frame, at most 10). */
export async function visibleAll(mgr: BrowserManager, selector: string): Promise<any[]> {
  const page = await mgr.activePage();
  const all = page.locator(selector);
  const n = Math.min(await all.count().catch(() => 0), 10);
  const out: any[] = [];
  for (let i = 0; i < n; i++) {
    const loc = all.nth(i);
    if (await loc.isVisible().catch(() => false)) out.push(loc);
  }
  return out;
}

export interface FillTarget {
  ref?: string;
  selector?: string;
  /** An already resolved Playwright locator (auto-detection by the caller). */
  loc?: any;
  /** How to call it in messages when it has no ref / selector. */
  label?: string;
}

export interface PreparedField {
  el: any;
  info: FieldInfo;
  /** "ref e12" / "\"#pw\"" / "the password field". */
  target: string;
  release: () => void;
}

/**
 * Resolve, pin and check a field for an entry bound to `origins` on `pageUrl`. Returns
 * the pinned element, or an error result (nothing was typed).
 */
export async function prepareField(
  mgr: BrowserManager, kind: FieldKind, target: FillTarget,
  opts: { origins: string[]; entryName: string; pageUrl: string; secrets?: string[] },
): Promise<PreparedField | ToolResult> {
  const clean = (m: string) => scrub(m, ...(opts.secrets ?? []));
  const timeout = actionTimeoutMs();
  let loc: any;
  let label: string;
  try {
    if (target.loc) {
      loc = target.loc;
      label = target.label ?? `the ${kind} field`;
    } else if (target.ref || target.selector) {
      loc = await mgr.locator({ ref: target.ref, selector: target.selector });
      label = target.ref ? `ref ${target.ref}` : `"${target.selector}"`;
    } else {
      loc = await autoDetect(mgr, kind);
      if (!loc) {
        return { content: `[BROWSER_ERROR] Could not find a visible ${kind} field on ${hostOf(opts.pageUrl)}. Call browser_snapshot and pass the field's ref.`, isError: true };
      }
      label = `the ${kind} field`;
    }
  } catch (e: any) {
    const msg = clean(e?.message ?? String(e));
    return { content: msg.startsWith('[') ? msg : `[BROWSER_ERROR] ${msg}`, isError: true };
  }

  // Pin the exact DOM element: a Locator re-resolves on every call, so a redirect
  // between the checks below and fill() could otherwise land the secret on another
  // page. An ElementHandle detaches instead (fill then fails safely).
  let el: any = loc;
  let info: FieldInfo;
  try {
    if (typeof loc.elementHandle === 'function') {
      el = await loc.elementHandle({ timeout });
      if (!el) return { content: `[BROWSER_ERROR] ${label} is not on the page any more. Call browser_snapshot again.`, isError: true };
    }
    info = await el.evaluate(inspectField);
  } catch (e: any) {
    return { content: `[BROWSER_ERROR] Could not inspect the target field: ${clean(e?.message ?? String(e))}`, isError: true };
  }
  const release = () => { if (el !== loc) void Promise.resolve(el.dispose?.()).catch(() => {}); };
  const frame = fieldDocumentUrl(info, opts.pageUrl);
  const frameMatch = 'refuse' in frame ? { ok: false as const, reason: frame.refuse } : matchOrigin(frame.url, opts.origins);
  if (!frameMatch.ok) {
    release();
    return { content: `[VAULT_ORIGIN_MISMATCH] Refusing to fill "${opts.entryName}": the field is inside a frame from another site (${frameMatch.reason}).`, isError: true };
  }
  const fieldError = checkField(kind, info);
  if (fieldError) {
    release();
    return { content: `[VAULT_FIELD_MISMATCH] ${fieldError} Pick the right field from browser_snapshot.`, isError: true };
  }
  return { el, info, target: label, release };
}

export function isPrepared(x: PreparedField | ToolResult): x is PreparedField {
  return !!x && typeof (x as PreparedField).release === 'function';
}

/**
 * Last look at the active tab's origin, then type `value` into the pinned field.
 * Always releases the element. Null on success, else an error result.
 */
export async function commitFill(
  mgr: BrowserManager, p: PreparedField, value: string,
  opts: { origins: string[]; entryName: string; pageUrl: string; secrets?: string[]; keep?: boolean },
): Promise<ToolResult | null> {
  if (!matchOrigin(mgr.activeUrl(), opts.origins).ok) {
    p.release();
    return { content: `[VAULT_ORIGIN_MISMATCH] The page navigated away from ${hostOf(opts.pageUrl)} before "${opts.entryName}" could be filled — nothing was typed.`, isError: true };
  }
  try {
    await p.el.fill(value, { timeout: actionTimeoutMs() });
    return null;
  } catch (e: any) {
    return { content: `[BROWSER_ERROR] Could not fill ${p.target}: ${scrub(e?.message ?? String(e), value, ...(opts.secrets ?? []))}`, isError: true };
  } finally {
    if (!opts.keep) p.release();
  }
}

/** Publish a fill to the recorder / live view with the value masked. */
export function recordFill(
  mgr: BrowserManager, p: PreparedField,
  args: { ref?: string; selector?: string; secret: string; field: string }, pageUrl: string,
): void {
  try {
    mgr.recordAction({
      tool: 'browser_fill_secret',
      args: { ref: args.ref, selector: args.selector, secret: args.secret, field: args.field, value: '***' },
      url: pageUrl,
      actor: 'agent',
      element: {
        ref: args.ref, tag: p.info.tag, inputType: p.info.type, isPassword: p.info.type === 'password',
        name: p.info.name || undefined, autocomplete: p.info.autocomplete || undefined, selector: args.selector,
      },
    });
  } catch { /* recording is best-effort */ }
}

/**
 * The current TOTP code for an entry, computed right before typing; waits for the next
 * window when fewer than 3 s remain (a code that expires before submit is useless).
 */
export async function currentTotp(entry: VaultEntry, signal?: AbortSignal): Promise<string> {
  const period = entry.totpPeriod ?? 30;
  if (totpRemainingSeconds(period) < 3) await sleep(Math.ceil(totpRemainingSeconds(period) * 1000) + 250, signal);
  return totp(entry.totp!, { period, digits: entry.totpDigits ?? 6, algorithm: entry.totpAlgorithm ?? 'sha1' });
}
