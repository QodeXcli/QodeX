/**
 * `browser_*` tools (core set) — drive the dedicated QodeX Browser.
 *
 * All tools talk to the process-wide BrowserManager (session.ts): one persistent
 * Chromium profile with tabs. Targets are snapshot REFS (`ref: "e12"` from
 * browser_snapshot — preferred, unambiguous) or Playwright selectors (CSS,
 * `text=...`, `role=button[name="..."]`, xpath=...).
 *
 * Tools defined here (names kept for back-compat with skills/prompts):
 *   browser_navigate, browser_click, browser_fill, browser_screenshot,
 *   browser_console, browser_evaluate, browser_get_text, browser_wait_for,
 *   browser_close.  More tools live in tools-extra.ts; the autonomous
 *   browser sub-agent in agent-tool.ts.
 *
 * Every ACTION waits while a human has taken over the browser (control center),
 * records itself for the workflow recorder (password text → "***"), and returns
 * `✓ <what happened>` + navigation / new-tab / dialog / download notes + a compact
 * interactive snapshot of the page after the action (browser.snapshotAfterAction;
 * `snapshot: false` opts out) so the model rarely needs a separate observe call.
 *
 * READ-ONLY FLAGS (deliberate): the agent loop runs all `isReadOnly` calls of one
 * model response FIRST and in parallel, and caches them per iteration. A
 * page-OBSERVING tool (snapshot, screenshot, get_text, extract, console, network,
 * downloads) marked read-only would therefore observe the page BEFORE a click
 * issued earlier in the same response, and repeated observations of a changing
 * page would be served from cache / flagged as "stuck". So every tool that reads
 * the live page is `isReadOnly = false`; only browser_status (pure manager state,
 * never launches) is read-only.
 *
 * Results that contain page text set `untrustedOutput = true` so Sentinel fences
 * them as data (prompt-injection defense).
 */

import { z } from 'zod';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { getBrowserManager, type BrowserManager, type ElementInfo } from './types.js';
import {
  QodexBrowserManager, normalizeUrl, formatBytes, refFromSelector, redactTypedArgs,
  isProtectedQodexPath, isProtectedFileUrl, isProtectedQodexPathReal, isProtectedFileUrlReal,
} from './session.js';
import { snapshotWithBoxes, selectDrawableMarks, drawMarks, clearMarks, maskPageSecrets, maskSecretText } from './snapshot.js';
import { challengeHint, challengeLabel, isChallengeElement, isChallengeFrameUrl, type ChallengeInfo } from './challenge.js';
import { QODEX_SCREENSHOTS_DIR } from '../../config/paths.js';
import { VisionAnalyzeTool } from '../vision/vision-analyze.js';
import { logger } from '../../utils/logger.js';

// ── shared helpers (also used by tools-extra.ts / agent-tool.ts) ────────────

/** Compact snapshot appended to action results is capped at this many chars. */
export const ACTION_SNAPSHOT_MAX_CHARS = 6000;

export function asQodex(mgr: BrowserManager): QodexBrowserManager | null {
  return mgr instanceof QodexBrowserManager ? mgr : null;
}

function firstLine(e: unknown): string {
  return String((e as any)?.message ?? e).split('\n')[0];
}

function safeUrlOf(page: any): string {
  try { return String(page.url()); } catch { return ''; }
}

async function safeTitleOf(page: any): Promise<string> {
  try { return String(await page.title()); } catch { return ''; }
}

/** Shared zod pieces (`.describe()` BEFORE `.optional()` so the description survives). */
export const refField = () => z.string().describe('Ref from the latest snapshot, e.g. "e12" (preferred).').optional();
export const selectorField = () => z.string().describe('Playwright selector, if no ref.').optional();
export const snapshotField = () => z.boolean().describe('Append a fresh page snapshot (default true).').optional();
export const timeoutField = () => z.number().int().min(100).max(120_000).describe('Max wait ms (default 8000).').optional();

/** `{ref, selector}` from tool args; a ref passed as `selector` ("e12") is treated as a ref. */
export function targetOf(args: { ref?: string; selector?: string }): { ref?: string; selector?: string } | null {
  const ref = args.ref?.trim();
  const sel = args.selector?.trim();
  if (ref) return { ref };
  if (sel) {
    const bare = refFromSelector(sel);
    if (bare) return { ref: bare };
    return { selector: sel };
  }
  return null;
}

/** `button "Sign in" [ref=e11]` / `selector "#email"` — how results name a target. */
export function describeTarget(el: ElementInfo | null | undefined, target: { ref?: string; selector?: string } | null): string {
  const tag = target?.ref ? ` [ref=${target.ref}]` : target?.selector ? ` (${target.selector})` : '';
  if (el?.role || el?.name) {
    const role = el.isPassword ? 'password field' : el.role && el.role !== 'generic' ? el.role : el.tag || 'element';
    const name = el.name ? ` "${el.name.length > 60 ? el.name.slice(0, 60) + '…' : el.name}"` : '';
    return `${role}${name}${tag}`;
  }
  return target?.ref ? `element [ref=${target.ref}]` : target?.selector ? `"${target.selector}"` : 'the page';
}

/**
 * Replace typed text with *** when the target is a secret field (password,
 * one-time code, card number) — or, with `unknownTarget`, when focus was in a
 * frame that could not be inspected.
 */
export function redactForRecord(args: Record<string, unknown>, el: ElementInfo | null | undefined, unknownTarget = false): Record<string, unknown> {
  return redactTypedArgs(args, el, unknownTarget);
}

/** Reject an aborted run early with a clear marker. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('[ABORTED] The run was cancelled.');
}

/** Race a promise against ctx.signal (the underlying op keeps its own timeout). */
export function withAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new Error('[ABORTED] The run was cancelled.'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('[ABORTED] The run was cancelled.'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      v => { signal.removeEventListener('abort', onAbort); resolve(v); },
      e => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

/** If a human has taken over the browser, report progress and wait for the hand-back. */
export async function waitForHuman(mgr: BrowserManager, ctx: ToolContext): Promise<void> {
  if (!mgr.isTakeover()) return;
  const by = mgr.status().takeoverBy;
  ctx.emit({ type: 'progress', message: `Waiting: ${by ? `${by} has` : 'a human has'} taken over the QodeX browser — continuing when it is handed back.` });
  await mgr.waitForTakeoverEnd(ctx.signal);
}

const CODE_RE = /^\[(STALE_REF|PLAYWRIGHT_MISSING|BROWSER_LAUNCH_FAILED|BROWSER_ERROR|ABORTED|HUMAN_TAKEOVER|PARTIAL_LOAD|CHALLENGE|CHALLENGE_HUMAN_ONLY|CHALLENGE_UNSOLVED)\]/;

/** Map an exception to a model-readable `[CODE] ...` result with a fix hint. */
export function browserErrorResult(e: unknown, what: string): ToolResult {
  const raw = String((e as any)?.message ?? e);
  if (CODE_RE.test(raw)) return { content: raw.split('\nCall log:')[0].trim(), isError: true };
  const [head, log = ''] = raw.split(/\nCall log:\n?/);
  const first = head.split('\n')[0].replace(/^\w+\.\w+:\s*/, '').trim();
  const clues = Array.from(new Set(
    log.split('\n')
      .map(l => l.replace(/\x1b\[[0-9;]*m/g, '').replace(/^\s*-\s*/, '').trim())
      .filter(l => /intercepts pointer events|not visible|not enabled|not editable|not stable|outside of the viewport|detached|resolved to \d+ elements|waiting for navigation/i.test(l)),
  )).slice(-3);
  let hint = '';
  if (/Timeout \d+ms exceeded/i.test(first)) {
    hint = /intercepts pointer events/i.test(log)
      ? 'Another element (a modal, cookie banner or overlay) covers the target — close it first (browser_snapshot to find its button, or browser_press Escape).'
      : 'The element was not actionable in time (hidden, disabled, still loading or off-screen). Take a fresh browser_snapshot, scroll it into view (browser_scroll ref=...), or wait (browser_wait_for).';
  } else if (/strict mode violation/i.test(first)) {
    hint = 'The selector matches several elements — use a ref from browser_snapshot instead.';
  } else if (/Target (page|context|browser)[^]*closed|has been closed/i.test(first)) {
    hint = 'The tab or browser was closed. The next browser_* call relaunches it; browser_tabs action=list shows open tabs.';
  } else if (/net::ERR_/i.test(first)) {
    const code = /net::(ERR_[A-Z_]+)/.exec(first)?.[1];
    hint = code === 'ERR_NAME_NOT_RESOLVED'
      ? 'The domain did not resolve — check the spelling of the URL.'
      : code === 'ERR_TUNNEL_CONNECTION_FAILED' || code === 'ERR_PROXY_CONNECTION_FAILED'
        ? 'The network/proxy refused the connection (this machine may have no internet access to that site).'
        : `Network error ${code ?? ''} — check the URL and that the site is reachable from this machine.`;
  } else if (/Element is not an <input>|not an <input>, <textarea>|is not editable/i.test(first)) {
    hint = 'The target is not a text field — snapshot again and pick the textbox ref (or use browser_click / browser_select).';
  } else if (/is not a <select>|not a select element/i.test(first)) {
    hint = 'The target is not a native <select>: click it to open the list, then click the option (browser_snapshot to find option refs).';
  }
  const details = clues.length ? `\n  ${clues.join('\n  ')}` : '';
  return { content: `[BROWSER_ERROR] ${what} failed: ${first}${details}${hint ? `\nHint: ${hint}` : ''}`, isError: true };
}

/** The refusal for any agent action on a CAPTCHA / bot-check widget. */
export function humanOnlyMessage(what: string): string {
  return `[CHALLENGE_HUMAN_ONLY] ${what} is part of a CAPTCHA / bot check — only a human may act on it. ` +
    'Do not click, type into, drag or analyze it, and do not script around it. Call browser_request_human (it hands the browser to the user and resumes by itself), or tell the user.';
}

/** A page script that reaches into a CAPTCHA widget or its token (refused like a click on it). PURE. */
export const CHALLENGE_SCRIPT_RE = /captcha|turnstile|_cf_chl|cf-chl|challenge-platform|geetest|arkose|funcaptcha|captcha-delivery|awswaf|px-captcha/i;

function withTimeoutValue<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>(resolve => {
    const t = setTimeout(() => resolve(fallback), ms);
    (t as any).unref?.();
    p.then(v => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(fallback); });
  });
}

/**
 * Refuse ([CHALLENGE_HUMAN_ONLY]) when a resolved target belongs to a challenge: the
 * in-page describer flagged it, or — when it could not be described — the frame it lives
 * in is a challenge vendor's frame. A frame ref that cannot be resolved at all while the
 * tab shows a challenge is refused too (fail closed). Human input (dispatchInput) is
 * never checked here.
 */
export async function assertNotChallenge(
  mgr: BrowserManager,
  loc: any,
  el: ElementInfo | null,
  target: { ref?: string; selector?: string } | null,
): Promise<void> {
  if (isChallengeElement(el)) throw new Error(humanOnlyMessage(describeTarget(el, target)));
  if (el) return;
  let frameUrl: string | null = null;
  const handle: any = await withTimeoutValue(Promise.resolve().then(() => loc?.elementHandle?.({ timeout: 500 })), 1500, null);
  if (handle) {
    try {
      const frame = await withTimeoutValue(Promise.resolve().then(() => handle.ownerFrame()), 1000, null);
      frameUrl = frame ? String(frame.url()) : null;
    } catch { frameUrl = null; }
    void Promise.resolve(handle.dispose?.()).catch(() => {});
  }
  if (frameUrl && isChallengeFrameUrl(frameUrl)) throw new Error(humanOnlyMessage(describeTarget(el, target)));
  const qm = asQodex(mgr);
  if (!frameUrl && target?.ref && /^f\d+e/.test(target.ref) && qm?.challengeOf()) {
    throw new Error(humanOnlyMessage(describeTarget(el, target)));
  }
}

/** The soft refusal to load a URL again whose last two loads ended on a bot check. */
export function refuseChallengeReload(url: string): ToolResult {
  let where = url;
  try { const u = new URL(url); where = `${u.host}${u.pathname}`; } catch { /* keep */ }
  return {
    content: `[CHALLENGE] Not loading ${where} again: its last 2 loads ended on a bot check, and reloading restarts the check and looks more like a bot. ` +
      'Call browser_request_human to hand it to the user (or tell the user).',
    isError: true,
  };
}

/** Error when an observation tool is called before the browser was opened. */
export function notRunningResult(): ToolResult {
  return { content: '[BROWSER_ERROR] The QodeX browser is not open yet — call browser_navigate first.', isError: true };
}

/** What the challenge gate found after an action: lines for the result + the challenge still up (or null). */
export interface ChallengeGate {
  lines: string[];
  challenge: ChallengeInfo | null;
  /** The challenge was there and cleared by itself during the auto-wait. */
  cleared?: ChallengeInfo;
}

/** `[CHALLENGE] …` line for a challenge that is still up. PURE. */
export function formatChallengeLine(ch: ChallengeInfo, mode: 'auto' | 'report' | 'off' = 'auto'): string {
  return `[CHALLENGE] ${challengeHint(ch.vendor, ch.state, ch.host, mode === 'report' ? 'report' : 'auto')}`;
}

/**
 * The CAPTCHA / bot-check check every navigate / action / snapshot result goes through:
 * detect on the active tab; a check that clears by itself is waited out (up to
 * browser.challengeAutoWaitSec, honouring ctx.signal, no model calls); anything still up
 * becomes a `[CHALLENGE]` line telling the model to hand off (browser_request_human) —
 * never to touch it. browser.challengeHandoff 'off' disables it.
 */
export async function challengeGate(mgr: BrowserManager, ctx?: ToolContext, opts: { wait?: boolean } = {}): Promise<ChallengeGate> {
  const qm = asQodex(mgr);
  if (!qm || !qm.isRunning() || qm.pendingDialog()) return { lines: [], challenge: null };
  const cfg = qm.currentConfig();
  if (cfg.challengeHandoff === 'off') return { lines: [], challenge: null };
  let ch = await qm.detectChallengeNow();
  const lines: string[] = [];
  let cleared: ChallengeInfo | undefined;
  if (ch && ch.state === 'self-clearing' && opts.wait !== false && cfg.challengeAutoWaitSec > 0) {
    const label = `${challengeLabel(ch.vendor)}${ch.host ? ` on ${ch.host}` : ''}`;
    try {
      ctx?.emit?.({ type: 'progress', message: `Waiting up to ${cfg.challengeAutoWaitSec}s for the ${label} to clear by itself…` });
    } catch { /* progress is cosmetic */ }
    const first = ch;
    const r = await qm.waitForChallenge(undefined, {
      timeoutMs: cfg.challengeAutoWaitSec * 1000,
      signal: ctx?.signal,
      intervalMs: 500,
      confirmations: 2,
      until: c => !c || c.state !== 'self-clearing',
    });
    ch = r.challenge;
    if (!ch) {
      cleared = first;
      lines.push(`✓ The ${label} cleared by itself after ${Math.max(1, Math.round(r.waitedMs / 1000))}s.`);
    }
  }
  if (ch) lines.push(formatChallengeLine(ch, cfg.challengeHandoff));
  return { lines, challenge: ch, ...(cleared ? { cleared } : {}) };
}

/**
 * Compose an action result: the `✓` line, navigation change, the challenge gate
 * (auto-wait / `[CHALLENGE]`), manager notices and (optionally) a compact interactive
 * snapshot of the page after the action. Pass `gate` when the caller already ran it.
 */
export async function composeActionResult(
  mgr: BrowserManager,
  lines: string[],
  before: { url: string; title?: string } | null,
  wantSnapshot: boolean | undefined,
  ctx?: ToolContext,
  gate?: ChallengeGate,
): Promise<string> {
  const out = [...lines];
  const qm = asQodex(mgr);
  const g = gate ?? await challengeGate(mgr, ctx);
  const nowUrl = mgr.activeUrl();
  const nowTitle = qm?.activeTitle() ?? '';
  if (before && nowUrl && nowUrl !== before.url) out.push(`→ Now at: ${nowUrl}${nowTitle ? ` — "${nowTitle}"` : ''}`);
  out.push(...g.lines);
  for (const n of qm?.drainNotices() ?? []) out.push(`• ${n}`);
  const cfg = qm?.currentConfig();
  const snap = wantSnapshot ?? cfg?.snapshotAfterAction ?? false;
  if (snap && qm && qm.isRunning() && !qm.pendingDialog()) {
    try {
      const s = await qm.snapshot({ interactiveOnly: true, maxChars: Math.min(ACTION_SNAPSHOT_MAX_CHARS, cfg?.snapshotMaxChars ?? ACTION_SNAPSHOT_MAX_CHARS) });
      out.push('', '--- Page after action (interactive elements; refs for the next call) ---', s.text);
    } catch (e) {
      out.push(`(snapshot unavailable: ${firstLine(e)} — call browser_snapshot)`);
    }
  }
  return out.join('\n');
}

export interface BrowserActionHandle {
  page: any;
  mgr: BrowserManager;
  locator: any | null;
  element: ElementInfo | null;
  target: { ref?: string; selector?: string } | null;
  timeout: number;
}

export interface BrowserActionSpec {
  /** Tool name (recorded in the action feed). */
  tool: string;
  ctx: ToolContext;
  target?: { ref?: string; selector?: string } | null;
  /** Fail with a clear error when no ref/selector is given. */
  requireTarget?: boolean;
  /**
   * Without a ref/selector the action goes to the FOCUSED element (typing, key
   * presses): describe that element so a password field is redacted in the
   * record and named in the result.
   */
  focusTarget?: boolean;
  snapshot?: boolean;
  timeoutMs?: number;
  /** Args for the action feed (text/value redacted for password fields). `null` = don't record. */
  recordArgs?: Record<string, unknown> | null;
  /** Do the thing; return the `✓ ...` line(s). */
  perform: (h: BrowserActionHandle) => Promise<string | string[]>;
}

/**
 * The common action pipeline: takeover wait → launch/active tab → pending-dialog
 * guard → resolve + describe the target → perform (raced against a dialog
 * opening and ctx.signal) → settle (popups, navigation) → record → compose.
 */
export async function runBrowserAction(spec: BrowserActionSpec): Promise<ToolResult> {
  const { ctx } = spec;
  try {
    const mgr = await getBrowserManager();
    await waitForHuman(mgr, ctx);
    throwIfAborted(ctx.signal);
    const qm = asQodex(mgr);
    const page = await mgr.activePage();
    const pending = qm?.pendingDialog(page);
    if (pending) {
      return {
        content: `[BROWSER_ERROR] ${/^[aeiou]/i.test(pending.type) ? 'An' : 'A'} ${pending.type} dialog is open on this tab: "${pending.message.slice(0, 200)}". Answer it first with browser_dialog (action accept or dismiss).`,
        isError: true,
      };
    }
    const before = { url: safeUrlOf(page), title: await safeTitleOf(page) };
    const timeout = spec.timeoutMs ?? qm?.currentConfig().actionTimeoutMs ?? 8000;
    const target = spec.target ?? null;
    if (!target && spec.requireTarget) {
      return { content: '[BROWSER_ERROR] Pass `ref` (from browser_snapshot, e.g. "e12") or `selector`.', isError: true };
    }
    let locator: any = null;
    let element: ElementInfo | null = null;
    let focusUnknown = false;
    if (target) {
      locator = await mgr.locator(target);
      element = qm ? await qm.describeLocator(locator) : (target.ref ? await mgr.describeRef(target.ref) : null);
      if (element && target.ref) element = { ...element, ref: target.ref };
      // Never on a CAPTCHA / bot-check widget: that is the human's part.
      await assertNotChallenge(mgr, locator, element, target);
    } else if (spec.focusTarget && qm) {
      const f = await qm.focusedElement(page);
      if (f === 'unknown') focusUnknown = true;
      else element = f;
      // Typing / keys go to the focused element — refuse when that is inside a challenge
      // (or focus is in a frame we cannot inspect while the tab shows one).
      if (isChallengeElement(element) || (focusUnknown && qm.challengeOf(page))) {
        throw new Error(humanOnlyMessage(element ? `the focused ${describeTarget(element, null)}` : 'the focused element'));
      }
    }

    // Not too fast for the same site (bot scores punish bursts); never for local hosts.
    await qm?.paceHost(before.url);
    throwIfAborted(ctx.signal);

    // A dialog opened by the action blocks the page; stop waiting for the action then.
    let unsubscribe: (() => void) | null = null;
    const dialogOpened = new Promise<'dialog'>(resolve => {
      // Only a dialog on THIS tab blocks the action (another tab's dialog does not).
      unsubscribe = qm?.onPendingDialog(() => { if (qm.pendingDialog(page)) resolve('dialog'); }) ?? null;
    });
    const work = spec.perform({ page, mgr, locator, element, target, timeout });
    work.catch(() => { /* surfaced below unless a dialog won the race */ });
    let lines: string[];
    try {
      const winner = await withAbort(Promise.race([work.then(v => ({ v })), dialogOpened]), ctx.signal);
      if (winner === 'dialog') {
        lines = [`✓ ${spec.tool.replace(/^browser_/, '')} on ${describeTarget(element, target)} — it opened a dialog (see below).`];
      } else {
        lines = Array.isArray(winner.v) ? winner.v : [winner.v];
      }
    } finally {
      (unsubscribe as (() => void) | null)?.();
    }

    if (qm) await qm.settle();
    if (spec.recordArgs !== null) {
      mgr.recordAction({
        tool: spec.tool,
        args: redactForRecord(spec.recordArgs ?? {}, element, focusUnknown),
        url: before.url,
        title: before.title,
        element: element ?? undefined,
        actor: 'agent',
      });
    }
    const content = await composeActionResult(mgr, lines, before, spec.snapshot, ctx);
    return { content, metadata: { url: mgr.activeUrl(), tabs: mgr.tabs().length, target: target ?? undefined } };
  } catch (e) {
    return browserErrorResult(e, spec.tool);
  }
}

/** Resolve a user-supplied path against the tool cwd (expanding ~). */
export function resolveUserPath(p: string, cwd: string): string {
  const s = p.trim();
  if (s === '~') return os.homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2));
  return path.resolve(cwd, s);
}

// True for files that hold QodeX secrets / browser sessions (never upload or open
// them); `isProtectedFileUrl` for `file:` URLs into them. Defined in session.ts
// (the manager also closes such pages) and re-exported here for the tools.
export { isProtectedQodexPath, isProtectedFileUrl, isProtectedQodexPathReal, isProtectedFileUrlReal };

/** Extra protected dirs of the active manager (its own profiles dir, when not the default). */
function managerProtectedDirs(mgr: BrowserManager | null): string[] {
  const qm = mgr ? asQodex(mgr) : null;
  return qm ? [qm.profilesDir] : [];
}

/**
 * Where an output file (screenshot / PDF) may be written. These tools bypass the
 * write_file permission gate, so they may only create files with the expected
 * extension and never touch QodeX's own secret/profile files — also not through
 * a symlink. Returns an error message, or null when the path is acceptable.
 */
export async function checkOutputPath(abs: string, exts: string[], mgr: BrowserManager | null = null): Promise<string | null> {
  const ext = path.extname(abs).toLowerCase();
  if (!exts.includes(ext)) return `the output path must end with ${exts.join(' or ')} (got "${path.basename(abs)}")`;
  if (await isProtectedQodexPathReal(abs, managerProtectedDirs(mgr))) return 'refusing to write into QodeX browser-profile / vault files';
  return null;
}

// ── browser_navigate ────────────────────────────────────────────────────────

const NavigateArgs = z.object({
  url: z.string().min(1).describe('URL to open. A bare domain ("example.com") gets https://; "localhost:3000" gets http://.'),
  wait_until: z.enum(['load', 'domcontentloaded', 'networkidle', 'commit']).describe(
    "When navigation counts as done. 'domcontentloaded' (default) = DOM parsed — doesn't wait for slow third-party assets. " +
    "'load' = window.onload (often times out on heavy pages). 'networkidle' = quiet for 500ms (SPAs that render late).",
  ).optional(),
  timeout_ms: z.number().int().min(1000).max(120_000).describe('Max wait. Default 30000.').optional(),
  return_html: z.boolean().describe('Also include the page HTML (truncated to 25k chars). Default false; included automatically on timeout.').optional(),
  new_tab: z.boolean().describe('Open the URL in a new tab (it becomes the active tab). Default false = current tab.').optional(),
  snapshot: snapshotField(),
});

export class BrowserNavigateTool extends Tool<z.infer<typeof NavigateArgs>> {
  name = 'browser_navigate';
  description =
    'Open a URL in the QodeX browser — your own persistent Chromium (logins/cookies survive restarts). The first call launches it. ' +
    'Returns status, title and a compact snapshot of interactive elements with refs (e.g. [ref=e12]) to use with browser_click / browser_type / browser_fill_form. ' +
    'On a slow page it returns partial state ([PARTIAL_LOAD]) instead of failing. Resets the console/network buffers of the tab.';
  isReadOnly = false;
  isDestructive = false;
  untrustedOutput = true;
  argsSchema = NavigateArgs;

  coerceArgs(raw: unknown): unknown {
    if (raw && typeof raw === 'object' && typeof (raw as any).url === 'string') {
      return { ...(raw as any), url: normalizeUrl((raw as any).url) };
    }
    return raw;
  }

  async execute(args: z.infer<typeof NavigateArgs>, ctx: ToolContext): Promise<ToolResult> {
    const url = normalizeUrl(args.url);
    const waitUntil = args.wait_until ?? 'domcontentloaded';
    const timeout = args.timeout_ms ?? 30_000;
    try {
      const mgr = await getBrowserManager();
      if (await isProtectedFileUrlReal(url, managerProtectedDirs(mgr))) {
        return { content: '[BROWSER_ERROR] Refusing to open QodeX browser-profile / vault files in the browser.', isError: true };
      }
      await waitForHuman(mgr, ctx);
      throwIfAborted(ctx.signal);
      const qm = asQodex(mgr);
      // Reloading a page whose last loads were a bot check restarts the check and looks
      // more like a bot: hand it to the human instead.
      if (qm && qm.challengeLoadCount(url) >= 2) return refuseChallengeReload(url);
      await qm?.paceHost(url);
      throwIfAborted(ctx.signal);
      if (args.new_tab) await mgr.newTab();
      const page = await mgr.activePage();
      const pending = qm?.pendingDialog(page);
      if (pending) await qm!.resolveDialog('dismiss');
      qm?.clearActiveBuffers();
      const preNotes = pending ? [`• Dismissed the waiting ${pending.type} dialog ("${pending.message.slice(0, 80)}") to navigate away.`] : [];

      let status: number | undefined;
      let timedOut = false;
      let phaseError: string | undefined;
      try {
        const r = await withAbort(page.goto(url, { waitUntil, timeout }), ctx.signal);
        status = (r as any)?.status?.();
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        const isTimeout = e?.name === 'TimeoutError' || /Timeout \d+ms exceeded/i.test(msg) || /navigation timeout/i.test(msg);
        if (!isTimeout) return browserErrorResult(e, 'navigate');
        timedOut = true;
        phaseError = msg.split('\n')[0];
        logger.info('browser_navigate timed out; returning partial state', { url, waitUntil, timeout });
      }
      if (qm) await qm.settle({ timeoutMs: 1500 });
      // A Cloudflare-style "Just a moment…" is waited out here, before the page is reported.
      const gate = await challengeGate(mgr, ctx);
      const title = await safeTitleOf(page);
      const finalUrl = safeUrlOf(page) || url;
      for (const u of new Set([url, finalUrl])) qm?.noteChallengeLoad(u, !!gate.challenge);
      mgr.recordAction({ tool: 'browser_navigate', args: { url }, url: finalUrl, title, actor: 'agent' });

      let htmlSection = '';
      if (args.return_html === true || timedOut) {
        try {
          // Frameworks mirror field values into the value="" attribute: mask secrets.
          const html = await maskPageSecrets(page, String(await page.content()), qm?.extraSecretsFor(page) ?? []);
          const max = 25_000;
          const slice = html.length > max ? html.slice(0, max) + `\n\n…[truncated, ${html.length - max} more chars]` : html;
          htmlSection = `\n\n--- HTML (${html.length} chars) ---\n${slice}`;
        } catch (e) {
          htmlSection = `\n\n--- HTML unavailable: ${firstLine(e)} ---`;
        }
      }
      const bufs = qm?.activeBuffers();
      const lines = [
        timedOut
          ? `[PARTIAL_LOAD] navigation timed out after ${timeout}ms (waitUntil=${waitUntil}); returning whatever the page has so far. Reason: ${phaseError ?? 'timeout'}`
          : `✓ Loaded ${finalUrl}`,
        `  HTTP ${status ?? '?'}${status && status >= 400
          ? gate.challenge ? ' (a CAPTCHA / bot-check page — see [CHALLENGE])' : gate.cleared ? ' (a bot check that has since cleared)' : ' (the site returned an error page)'
          : ''}`,
        `  Title: ${title || '(none)'}`,
        ...(finalUrl !== url ? [`  Final URL: ${finalUrl} (redirected from ${url})`] : []),
        `  Console: ${bufs?.console.length ?? 0} msg(s)  Errors: ${bufs?.errors.length ?? 0}`,
        ...preNotes,
      ];
      const content = await composeActionResult(mgr, lines, null, timedOut ? (args.snapshot ?? true) : args.snapshot, ctx, gate);
      return {
        content: content + htmlSection,
        metadata: { url: finalUrl, status, title, timedOut, waitUntil, ...(gate.challenge ? { challenge: { vendor: gate.challenge.vendor, state: gate.challenge.state, host: gate.challenge.host } } : {}) },
      };
    } catch (e) {
      return browserErrorResult(e, 'navigate');
    }
  }
}

// ── browser_click ───────────────────────────────────────────────────────────

const ClickArgs = z.object({
  ref: refField(),
  selector: selectorField(),
  element: z.string().describe('What the target is, e.g. "Add to cart button" (for approvals).').optional(),
  button: z.enum(['left', 'right', 'middle']).describe('Mouse button. Default left.').optional(),
  click_count: z.number().int().min(1).max(3).describe('1 = single (default), 2 = double, 3 = triple.').optional(),
  double: z.boolean().describe('Double-click (same as click_count 2).').optional(),
  modifiers: z.array(z.enum(['Alt', 'Control', 'Meta', 'Shift'])).describe('Keys held during the click, e.g. ["Control"] to open a link in a new tab.').optional(),
  timeout_ms: timeoutField(),
  snapshot: snapshotField(),
});

export class BrowserClickTool extends Tool<z.infer<typeof ClickArgs>> {
  name = 'browser_click';
  description =
    'Click an element by ref (from browser_snapshot, e.g. "e12") or selector. Waits for it to be visible/enabled, then reports what happened ' +
    '(navigation, new tab, dialog, download) and returns a fresh snapshot with new refs.';
  isReadOnly = false;
  isDestructive = false;
  untrustedOutput = true;
  argsSchema = ClickArgs;

  async execute(args: z.infer<typeof ClickArgs>, ctx: ToolContext): Promise<ToolResult> {
    const clickCount = args.double ? 2 : args.click_count ?? 1;
    return runBrowserAction({
      tool: 'browser_click',
      ctx,
      target: targetOf(args),
      requireTarget: true,
      snapshot: args.snapshot,
      timeoutMs: args.timeout_ms,
      recordArgs: { ...targetOf(args), button: args.button ?? 'left', click_count: clickCount, ...(args.modifiers?.length ? { modifiers: args.modifiers } : {}) },
      perform: async ({ locator, element, target, timeout }) => {
        const opts = { button: args.button ?? 'left', modifiers: args.modifiers, timeout };
        if (clickCount === 2) await locator.dblclick(opts);
        else await locator.click({ ...opts, clickCount });
        return `✓ ${clickCount === 2 ? 'Double-clicked' : clickCount === 3 ? 'Triple-clicked' : 'Clicked'} ${describeTarget(element, target)}${args.modifiers?.length ? ` with ${args.modifiers.join('+')}` : ''}`;
      },
    });
  }
}

// ── browser_fill ────────────────────────────────────────────────────────────

const FillArgs = z.object({
  ref: refField(),
  selector: selectorField(),
  value: z.string().describe('Text to put in the field. Replaces existing content.'),
  timeout_ms: timeoutField(),
  snapshot: snapshotField(),
});

export class BrowserFillTool extends Tool<z.infer<typeof FillArgs>> {
  name = 'browser_fill';
  description =
    'Fill an input / textarea / contenteditable (by ref or selector), replacing its content. For several fields at once use browser_fill_form; ' +
    'to type key-by-key or submit with Enter use browser_type. For saved passwords use browser_fill_secret (never ask the user for passwords).';
  isReadOnly = false;
  isDestructive = false;
  untrustedOutput = true;
  argsSchema = FillArgs;

  async execute(args: z.infer<typeof FillArgs>, ctx: ToolContext): Promise<ToolResult> {
    return runBrowserAction({
      tool: 'browser_fill',
      ctx,
      target: targetOf(args),
      requireTarget: true,
      snapshot: args.snapshot,
      timeoutMs: args.timeout_ms,
      recordArgs: { ...targetOf(args), value: args.value },
      perform: async ({ locator, element, target, timeout }) => {
        await locator.fill(args.value, { timeout });
        return `✓ Filled ${describeTarget(element, target)} with ${args.value.length} char(s)${element?.isPassword ? ' (hidden)' : ''}`;
      },
    });
  }
}

// ── browser_screenshot ──────────────────────────────────────────────────────

const ScreenshotArgs = z.object({
  full_page: z.boolean().describe('Capture the entire scrollable page (true) or just the viewport (false, default).').optional(),
  ref: refField(),
  selector: z.string().describe('Screenshot only this element (Playwright selector). Ignored when ref is given.').optional(),
  path: z.string().describe('Where to save the image (.png, or .jpg for JPEG; relative to the working directory). Default ~/.qodex/screenshots/shot-<time>.png.').optional(),
  marks: z.boolean().describe('Overlay set-of-marks boxes labeled with snapshot refs (e12, ...) so a vision model can say which ref to act on.').optional(),
  analyze: z.string().describe('Ask a vision model about the screenshot (e.g. "Is the order confirmed? what is the total?"); the answer is appended.').optional(),
});

export class BrowserScreenshotTool extends Tool<z.infer<typeof ScreenshotArgs>> {
  name = 'browser_screenshot';
  description =
    'Save a PNG of the current tab (viewport, full page, or one element) and return its path. marks=true labels interactive elements with their refs; ' +
    'analyze="question" sends the image to the vision model and appends its answer. Prefer browser_snapshot for reading/acting — screenshots are for visual checks.';
  // Not read-only on purpose: see the header comment (ordering vs. clicks in the same response).
  isReadOnly = false;
  isDestructive = false;
  untrustedOutput = true;
  argsSchema = ScreenshotArgs;

  async execute(args: z.infer<typeof ScreenshotArgs>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const mgr = await getBrowserManager();
      if (!mgr.isRunning()) return notRunningResult();
      const qm = asQodex(mgr);
      const dest = args.path ? resolveUserPath(args.path, ctx.cwd) : path.join(QODEX_SCREENSHOTS_DIR, `shot-${Date.now()}.png`);
      const bad = await checkOutputPath(dest, ['.png', '.jpg', '.jpeg'], mgr);
      if (bad) return { content: `[BROWSER_ERROR] screenshot: ${bad}`, isError: true };
      const page = await mgr.activePage();
      if (args.analyze && qm) {
        // A vision model must never read a CAPTCHA (that would be automated solving).
        const ch = await qm.detectChallengeNow();
        if (ch) {
          return {
            content: `[CHALLENGE_HUMAN_ONLY] No screenshot analysis while a ${challengeLabel(ch.vendor)} is on this tab — a vision model must never read it. ` +
              'Call browser_request_human (it hands the browser to the user and resumes by itself), or tell the user.',
            isError: true,
          };
        }
      }
      await fs.mkdir(path.dirname(dest), { recursive: true });
      const target = targetOf({ ref: args.ref, selector: args.selector });
      const legend: string[] = [];
      if (target) {
        const loc = await mgr.locator(target);
        await loc.screenshot({ path: dest, timeout: qm?.currentConfig().actionTimeoutMs ?? 8000 });
      } else if (args.marks) {
        const { marks } = qm ? await qm.boxes() : await snapshotWithBoxes(page);
        const drawable = selectDrawableMarks(marks, page.viewportSize?.() ?? null);
        await drawMarks(page, drawable);
        try {
          await page.screenshot({ path: dest, fullPage: args.full_page ?? false });
        } finally {
          await clearMarks(page);
        }
        for (const m of drawable.slice(0, 80)) legend.push(`  ${m.ref}  ${m.role}${m.name ? ` "${m.name}"` : ''}`);
        if (drawable.length > 80) legend.push(`  … ${drawable.length - 80} more`);
      } else {
        await page.screenshot({ path: dest, fullPage: args.full_page ?? false });
      }
      const stat = await fs.stat(dest);
      const vp = page.viewportSize?.();
      const lines = [
        `Screenshot saved: ${dest}`,
        `  Size: ${(stat.size / 1024).toFixed(1)} KB${vp ? `\n  Viewport: ${vp.width}x${vp.height}` : ''}`,
        `  Page: ${await safeTitleOf(page) || '(untitled)'} — ${safeUrlOf(page)}`,
      ];
      if (legend.length) lines.push(`  Marks (ref → element):`, ...legend);
      for (const n of qm?.drainNotices() ?? []) lines.push(`• ${n}`);
      if (args.analyze) {
        const v = await new VisionAnalyzeTool().execute({ image_path: dest, prompt: args.analyze }, ctx);
        lines.push('', `--- Vision: ${args.analyze} ---`, v.content);
      }
      return { content: lines.join('\n'), metadata: { path: dest, bytes: stat.size } };
    } catch (e) {
      return browserErrorResult(e, 'screenshot');
    }
  }
}

// ── browser_console ─────────────────────────────────────────────────────────

const ConsoleArgs = z.object({
  level: z.enum(['all', 'error', 'warn', 'info', 'log', 'debug']).describe('Filter by level. Default all.').optional(),
  limit: z.number().int().min(1).max(500).describe('Max messages to return. Default 50, newest last.').optional(),
});

export class BrowserConsoleTool extends Tool<z.infer<typeof ConsoleArgs>> {
  name = 'browser_console';
  description = 'Read the active tab\'s console messages and uncaught page errors since its last browser_navigate. Use to debug JavaScript errors after interacting with a page.';
  // Not read-only: must observe the page AFTER actions issued earlier in the same response.
  isReadOnly = false;
  isDestructive = false;
  untrustedOutput = true;
  argsSchema = ConsoleArgs;

  async execute(args: z.infer<typeof ConsoleArgs>, _ctx: ToolContext): Promise<ToolResult> {
    const mgr = await getBrowserManager();
    const bufs = asQodex(mgr)?.activeBuffers();
    if (!mgr.isRunning() || !bufs) return { content: 'The QodeX browser is not running — no console messages.' };
    const level = args.level ?? 'all';
    const limit = args.limit ?? 50;
    const filtered = level === 'all' ? bufs.console : bufs.console.filter(m => m.type === level || (level === 'warn' && m.type === 'warning'));
    const slice = filtered.slice(-limit);
    const consoleLines = slice.length === 0
      ? '  (no messages)'
      : slice.map(m => `  [${m.type}] ${m.text}${m.location ? `  (${m.location})` : ''}`).join('\n');
    const errors = bufs.errors.length === 0 ? '  (no page errors)' : bufs.errors.slice(-limit).map(e => `  ${e.message}`).join('\n');
    // A page that logs a vault-filled value must not carry it into the conversation.
    const extra = asQodex(mgr)?.extraSecretsFor() ?? [];
    return {
      content: maskSecretText(`Console (${slice.length}/${filtered.length} ${level} message(s)):\n${consoleLines}\n\nPage errors (${bufs.errors.length}):\n${errors}`, extra),
    };
  }
}

// ── browser_evaluate ────────────────────────────────────────────────────────

const EvaluateArgs = z.object({
  script: z.string().min(1).describe(
    'JavaScript run in the page. A function BODY — use `return` to send a value back ("return document.title"). ' +
    'A bare expression ("document.title") or an arrow function ("() => location.href") also works; `await` is allowed.',
  ),
  arg: z.string().describe('Optional argument passed to the script as `arg` (JSON text is parsed: "{\\"n\\":2}" → object; anything else is a string).').optional(),
});

const AsyncFunction: new (...args: string[]) => (...a: unknown[]) => Promise<unknown> = Object.getPrototypeOf(async function () { /* probe */ }).constructor;

/** Build the in-page function for browser_evaluate (exported for tests). */
export function compileEvaluateScript(script: string): (...a: unknown[]) => Promise<unknown> {
  const body = script.trim().replace(/;\s*$/, '');
  // Anything that parses as ONE expression is evaluated as such (and called when it
  // is a function) — also when its text contains `return` inside a nested function
  // ("() => { ...; return x }", an IIFE): as a function BODY it would only be
  // declared and its result silently lost. Statements fall back to the body form.
  try {
    return new AsyncFunction('arg', `const __qx = (${body}\n);\nreturn typeof __qx === 'function' ? await __qx(arg) : __qx;`);
  } catch { /* not an expression: treat as statements */ }
  return new AsyncFunction('arg', body);
}

function parseEvaluateArg(arg: string | undefined): unknown {
  if (arg === undefined) return undefined;
  const t = arg.trim();
  if (!t) return arg;
  try { return JSON.parse(t); } catch { return arg; }
}

export class BrowserEvaluateTool extends Tool<z.infer<typeof EvaluateArgs>> {
  name = 'browser_evaluate';
  description = 'Run JavaScript in the active tab and return the (JSON-serializable) result. Use for reading data the snapshot does not show or for widgets no other tool handles. Prefer the dedicated browser_* tools for normal interaction.';
  isReadOnly = false;
  isDestructive = false;
  untrustedOutput = true;
  argsSchema = EvaluateArgs;

  coerceArgs(raw: unknown): unknown {
    if (raw && typeof raw === 'object' && 'arg' in (raw as any)) {
      const a = (raw as any).arg;
      if (a !== undefined && a !== null && typeof a === 'object') return { ...(raw as any), arg: JSON.stringify(a) };
      if (a === null) { const { arg: _drop, ...rest } = raw as any; return rest; }
    }
    return raw;
  }

  async execute(args: z.infer<typeof EvaluateArgs>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const mgr = await getBrowserManager();
      if (!mgr.isRunning()) return notRunningResult();
      if (CHALLENGE_SCRIPT_RE.test(args.script)) return { content: humanOnlyMessage('What this script touches'), isError: true };
      await waitForHuman(mgr, ctx);
      const page = await mgr.activePage();
      let fn: (...a: unknown[]) => Promise<unknown>;
      try {
        fn = compileEvaluateScript(args.script);
      } catch (e) {
        return { content: `[BROWSER_ERROR] evaluate failed: the script does not parse: ${firstLine(e)}`, isError: true };
      }
      // Pass the Function OBJECT: Playwright serializes it and calls it with `arg`.
      // (A string is evaluated as an expression and never called — the old bug.)
      const result = await withAbort(page.evaluate(fn, parseEvaluateArg(args.arg)), ctx.signal);
      let formatted: string;
      if (result === undefined) formatted = 'undefined';
      else if (typeof result === 'string') formatted = result;
      else {
        try { formatted = JSON.stringify(result, null, 2) ?? String(result); } catch { formatted = String(result); }
      }
      // A script reading a password / card field (e.g. one filled from the vault)
      // must not carry its value into the conversation.
      formatted = await maskPageSecrets(page, formatted, asQodex(mgr)?.extraSecretsFor(page) ?? []);
      const notes = asQodex(mgr)?.drainNotices() ?? [];
      return {
        content: `Result:\n${formatted.slice(0, 5000)}${formatted.length > 5000 ? `\n…[truncated, ${formatted.length - 5000} more chars]` : ''}${notes.length ? '\n' + notes.map(n => `• ${n}`).join('\n') : ''}`,
      };
    } catch (e) {
      return browserErrorResult(e, 'evaluate');
    }
  }
}

// ── browser_get_text ────────────────────────────────────────────────────────

const GetTextArgs = z.object({
  ref: refField(),
  selector: z.string().describe('Text of this element only (Playwright selector). Default: the whole visible page.').optional(),
  max_chars: z.number().int().min(1).max(100_000).describe('Truncate output. Default 5000.').optional(),
});

export class BrowserGetTextTool extends Tool<z.infer<typeof GetTextArgs>> {
  name = 'browser_get_text';
  description = 'Visible text of the active tab (or of one element by ref/selector). For structured content (headings, links, tables) use browser_extract format=markdown.';
  // Not read-only: see header comment.
  isReadOnly = false;
  isDestructive = false;
  untrustedOutput = true;
  argsSchema = GetTextArgs;

  async execute(args: z.infer<typeof GetTextArgs>, _ctx: ToolContext): Promise<ToolResult> {
    try {
      const mgr = await getBrowserManager();
      if (!mgr.isRunning()) return notRunningResult();
      const page = await mgr.activePage();
      const maxChars = args.max_chars ?? 5000;
      const target = targetOf(args);
      let text: string;
      if (target) {
        const loc = await mgr.locator(target);
        if (target.selector && (await page.locator(target.selector).count()) === 0) {
          return { content: `[BROWSER_ERROR] selector not found: ${target.selector}`, isError: true };
        }
        text = String(await loc.innerText({ timeout: 5000 }));
      } else {
        text = String(await page.innerText('body', { timeout: 5000 }));
      }
      // A site may echo a revealed password into the page: hide secrets / vault fills.
      text = await maskPageSecrets(page, text, asQodex(mgr)?.extraSecretsFor(page) ?? []);
      const truncated = text.length > maxChars;
      return {
        content: `${text.slice(0, maxChars)}${truncated ? `\n…[truncated, ${text.length - maxChars} more chars]` : ''}`,
        metadata: { fullLength: text.length, url: safeUrlOf(page) },
      };
    } catch (e) {
      return browserErrorResult(e, 'get_text');
    }
  }
}

// ── browser_wait_for ────────────────────────────────────────────────────────

/**
 * browser_wait_for kind=url matcher. A pattern with `*` is a wildcard pattern
 * (`*` / `**` = any text; anchored to the whole URL only when it starts with a
 * scheme); anything else is a substring — `?` is NOT a wildcard, so
 * "/search?q=kettle" matches literally (Playwright's glob would treat it as a
 * pattern for the whole URL and never match). PURE.
 */
export function urlMatcher(pattern: string): (href: string) => boolean {
  const v = pattern.trim();
  if (!v.includes('*')) return href => href.includes(v);
  const body = v.split(/\*+/).map(part => part.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')).join('.*');
  const re = new RegExp(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? `^${body}$` : body, 'i');
  return href => re.test(href);
}

const WaitForArgs = z.object({
  kind: z.enum(['selector', 'url', 'networkidle', 'function', 'text', 'time']).describe(
    'What to wait for: "selector" = element visible, "text" = visible text appears, "url" = URL contains the text (or matches a pattern with * wildcards), ' +
    '"networkidle" = no network for 500ms, "function" = JS expression becomes truthy, "time" = sleep `value` ms.',
  ),
  value: z.string().describe('Selector / text / URL pattern / JS expression / milliseconds. Not needed for networkidle.').optional(),
  timeout_ms: z.number().int().min(100).max(120_000).describe('Default 10000.').optional(),
});

export class BrowserWaitForTool extends Tool<z.infer<typeof WaitForArgs>> {
  name = 'browser_wait_for';
  description = 'Wait for an element, some visible text, a URL change, network idle, a JS predicate, or a fixed time. Useful when a page updates asynchronously after an action.';
  isReadOnly = false;
  isDestructive = false;
  argsSchema = WaitForArgs;

  async execute(args: z.infer<typeof WaitForArgs>, ctx: ToolContext): Promise<ToolResult> {
    const timeout = args.timeout_ms ?? 10_000;
    try {
      if (args.kind === 'time') {
        const ms = Math.min(120_000, Math.max(0, Number(args.value ?? timeout) || 0));
        await withAbort(new Promise<void>(r => setTimeout(r, ms)), ctx.signal);
        return { content: `Waited ${ms} ms.` };
      }
      const mgr = await getBrowserManager();
      if (!mgr.isRunning()) return notRunningResult();
      const page = await mgr.activePage();
      const need = (k: string): ToolResult | null => (args.value ? null : { content: `[BROWSER_ERROR] kind "${k}" requires \`value\``, isError: true });
      let msg: string;
      if (args.kind === 'selector') {
        const miss = need('selector'); if (miss) return miss;
        await withAbort(page.waitForSelector(args.value, { timeout }), ctx.signal);
        msg = `✓ Selector visible: ${args.value}`;
      } else if (args.kind === 'text') {
        const miss = need('text'); if (miss) return miss;
        await withAbort(page.getByText(args.value!, { exact: false }).first().waitFor({ state: 'visible', timeout }), ctx.signal);
        msg = `✓ Text visible: "${args.value}"`;
      } else if (args.kind === 'url') {
        const miss = need('url'); if (miss) return miss;
        const matcher = urlMatcher(args.value!);
        await withAbort(page.waitForURL((u: URL) => matcher(u.href), { timeout }), ctx.signal);
        msg = `✓ URL matched: ${safeUrlOf(page)}`;
      } else if (args.kind === 'networkidle') {
        await withAbort(page.waitForLoadState('networkidle', { timeout }), ctx.signal);
        msg = '✓ Network idle reached';
      } else {
        const miss = need('function'); if (miss) return miss;
        if (CHALLENGE_SCRIPT_RE.test(args.value!)) return { content: humanOnlyMessage('What this predicate touches'), isError: true };
        await withAbort(page.waitForFunction(args.value, undefined, { timeout }), ctx.signal);
        msg = `✓ Predicate satisfied: ${args.value!.slice(0, 80)}`;
      }
      mgr.recordAction({ tool: 'browser_wait_for', args: { kind: args.kind, value: args.value }, url: safeUrlOf(page), actor: 'agent' });
      const notes = asQodex(mgr)?.drainNotices() ?? [];
      return { content: [msg, ...notes.map(n => `• ${n}`)].join('\n') };
    } catch (e) {
      return browserErrorResult(e, 'wait_for');
    }
  }
}

// ── browser_close ───────────────────────────────────────────────────────────

const CloseArgs = z.object({});

export class BrowserCloseTool extends Tool<z.infer<typeof CloseArgs>> {
  name = 'browser_close';
  description = 'Close the QodeX browser (all tabs). Idempotent. Logins/cookies stay in the persistent profile; the next browser_* call relaunches it.';
  isReadOnly = false;
  isDestructive = false;
  argsSchema = CloseArgs;

  async execute(_args: z.infer<typeof CloseArgs>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const mgr = await getBrowserManager();
      const wasRunning = mgr.isRunning();
      // Don't pull the browser away from a human who is using it.
      if (wasRunning) await waitForHuman(mgr, ctx);
      await mgr.close();
      return { content: wasRunning ? 'Browser closed. The profile (logins, cookies) is kept for next time.' : 'Browser was not running.' };
    } catch (e) {
      return browserErrorResult(e, 'close');
    }
  }
}

export { formatBytes };
