/**
 * `browser_request_human` — hand the QodeX browser to the human for a CAPTCHA / bot
 * check (or any step only they can do, e.g. approving a 2FA prompt on their phone),
 * and resume BY ITSELF as soon as it is gone.
 *
 * QodeX never solves a challenge. The HandoffController only waits, watches and asks:
 *
 *   1. finds the challenge (active tab first, else a tab whose challenge is known);
 *      a 'blocked' page is refused (nobody can solve it here); a self-clearing check is
 *      waited out first (browser.challengeAutoWaitSec);
 *   2. switches to that tab (the live view and human input follow the active tab);
 *   3. takes an OWNED takeover (`handoff:<id>`) so agent tools wait and the control
 *      center accepts the human's input — never stealing a human's own takeover;
 *   4. asks through the ApprovalBroker DIRECTLY (meta.handoff reaches the TUI, the
 *      control center and Telegram): options ['done', 'cancel'], category 'challenge';
 *   5. AUTO-RESUME: re-detects about every second (and on navigation); two consecutive
 *      clear checks resolve the request ('challenge-cleared') — no "done" needed. A
 *      "done" while the challenge is still up keeps waiting (and says so);
 *   6. always releases ONLY its own takeover (compare-and-release).
 *
 * Works in every approval mode, auto included: the human's own step is the consent.
 * Nothing secret travels: meta carries host / vendor / state / box only (no URL, no
 * query string, no link token — H2 mints the scoped hand-off link from the id).
 */

import { z } from 'zod';
import { randomBytes } from 'crypto';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { getBrowserManager } from './types.js';
import { QodexBrowserManager } from './session.js';
import { challengeLabel, type ChallengeBox, type ChallengeInfo } from './challenge.js';
import { browserErrorResult, composeActionResult, notRunningResult } from './tools.js';
import { getApprovalBroker, isInteractiveHuman, type LocalAsker, type PendingApproval } from '../../control/approvals.js';
import { getOperatorHub } from '../../operator/hub.js';

/** Hand-off answers (unique first letters: the TUI's letter shortcuts and Telegram replies stay unambiguous). */
export const HANDOFF_OPTIONS = ['done', 'cancel'];

/** What a hand-off approval carries in `meta.handoff` (for the TUI hint, dashboard, Telegram card). */
export interface HandoffMeta {
  id: string;
  /** Page host only — never a path or query. */
  host: string;
  vendor?: ChallengeInfo['vendor'];
  state?: ChallengeInfo['state'];
  /** Tab that shows it (already the active tab). */
  tabIndex: number;
  /** Where it is on screen, viewport CSS px — zoom / clip the live view or a Telegram photo to it. */
  frameBox?: ChallengeBox;
  /** Lifetime for a scoped one-time control-center link (never longer than the hand-off). */
  linkTtlSec: number;
}

export type HandoffOutcome = 'cleared' | 'self-cleared' | 'done' | 'cancelled' | 'timeout' | 'aborted' | 'blocked' | 'refused' | 'unreachable';

export interface HandoffResult {
  id: string;
  outcome: HandoffOutcome;
  /** Who ended it: 'challenge-cleared', 'local', 'control', 'telegram', 'timeout', 'abort', … */
  by: string;
  waitedMs: number;
  /** The challenge handed off (null for a plain "do this step" hand-off). */
  challenge: ChallengeInfo | null;
}

/** One line, no control chars, no URL query strings (tokens), capped. PURE. */
export function cleanReason(reason: string): string {
  return String(reason ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/(https?:\/\/[^\s?#]+)[?#]\S*/gi, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** The prompt shown to the human (TUI / control center / Telegram). PURE. */
export function handoffPrompt(reason: string, ch: ChallengeInfo | null, host: string, timeoutMs: number, repeat = 0): string {
  const lines = [`🧩 QodeX needs you in the browser: ${cleanReason(reason) || 'a step only you can do'}`];
  if (ch) {
    if (repeat > 0) lines.push(`The ${challengeLabel(ch.vendor)} on ${ch.host || host} is still there — QodeX keeps waiting.`);
    lines.push(
      `${challengeLabel(ch.vendor)} on ${ch.host || host}. Solve it yourself in the QodeX browser window or the control center's live view — ` +
      'QodeX notices when it is gone and continues by itself (no need to answer).',
    );
  } else {
    lines.push(`${host ? `On ${host}: d` : 'D'}o it in the QodeX browser window or the control center's live view, then answer "done".`);
  }
  lines.push(`Answer "done" when finished or "cancel" to give up (waiting up to ${formatDuration(timeoutMs)}).`);
  return lines.join('\n');
}

function hostOfUrl(url: string): string {
  try { return new URL(url).hostname; } catch { return ''; }
}

function newHandoffId(): string {
  return 'ho_' + randomBytes(6).toString('base64url');
}

/** Pending hand-off approvals (for surfaces that act on a hand-off by its id). */
export function pendingHandoffs(): Array<PendingApproval & { meta: { handoff: HandoffMeta } }> {
  return getApprovalBroker().pending().filter((p): p is PendingApproval & { meta: { handoff: HandoffMeta } } =>
    !!p.meta && typeof p.meta === 'object' && !!(p.meta as any).handoff && typeof (p.meta as any).handoff.id === 'string');
}

/**
 * Answer a pending hand-off by its hand-off id ('done' = "I finished" — the controller
 * re-checks and keeps waiting if the challenge is still there; 'cancel' = give up).
 * Returns false when no such hand-off is pending.
 */
export function resolveHandoff(handoffId: string, answer: 'done' | 'cancel', by: string): boolean {
  const p = pendingHandoffs().find(x => x.meta.handoff.id === handoffId);
  return p ? getApprovalBroker().resolve(p.id, answer, by) : false;
}

/** The terminal asker (operator hub) when a human sits at this process's TUI. */
function localAsker(): LocalAsker | undefined {
  if (!isInteractiveHuman()) return undefined;
  // kind 'question': the human's own step — never auto-answered by a mode switch.
  return (prompt, options, signal) => getOperatorHub().requestApproval('handoff', prompt, options, { signal, meta: { kind: 'question' } });
}

export interface HandoffOptions {
  mgr: QodexBrowserManager;
  ctx: ToolContext;
  reason: string;
  /** Total wait for the human. Default browser.handoffTimeoutSec. */
  timeoutMs?: number;
}

/**
 * Run one hand-off (see the module comment). Never throws for the human's answers;
 * `[ABORTED]` (ctx.signal) resolves as outcome 'aborted'.
 */
export async function runHandoff(opts: HandoffOptions): Promise<HandoffResult> {
  const { mgr, ctx } = opts;
  const cfg = mgr.currentConfig();
  const id = newHandoffId();
  const owner = `handoff:${id}`;
  const started = Date.now();
  const timeoutMs = Math.max(1000, opts.timeoutMs ?? cfg.handoffTimeoutSec * 1000);
  const deadline = started + timeoutMs;
  const result = (outcome: HandoffOutcome, by: string, challenge: ChallengeInfo | null): HandoffResult =>
    ({ id, outcome, by, waitedMs: Date.now() - started, challenge });

  if (cfg.challengeHandoff === 'report') return result('refused', 'config', null);

  // 1. Which tab: the active one, else one whose challenge is already known.
  let page = await mgr.activePage();
  let ch: ChallengeInfo | null = cfg.challengeHandoff === 'off' ? null : await mgr.detectChallengeNow(page);
  if (!ch && cfg.challengeHandoff !== 'off') {
    const known = mgr.challengeTabs().sort((a, b) => Number(b.challenge.state === 'needs-human') - Number(a.challenge.state === 'needs-human'));
    for (const t of known) {
      const p = mgr.pageAt(t.index);
      const again = p ? await mgr.detectChallengeNow(p) : null;
      if (p && again) { page = p; ch = again; break; }
    }
  }
  if (ch?.state === 'blocked') return result('blocked', 'detector', ch);

  // 2. A check that clears by itself gets its chance first.
  if (ch?.state === 'self-clearing' && cfg.challengeAutoWaitSec > 0) {
    ctx.emit({ type: 'progress', message: `Waiting up to ${cfg.challengeAutoWaitSec}s for the ${challengeLabel(ch.vendor)} to clear by itself…` });
    const r = await waitSafely(() => mgr.waitForChallenge(page, {
      timeoutMs: Math.min(cfg.challengeAutoWaitSec * 1000, Math.max(0, deadline - Date.now())),
      signal: ctx.signal, intervalMs: 500, confirmations: 2,
      until: c => !c || c.state !== 'self-clearing',
    }));
    if (r === 'aborted') return result('aborted', 'abort', ch);
    if (!r.challenge) return result('self-cleared', 'challenge-cleared', ch);
    ch = r.challenge;
    if (ch.state === 'blocked') return result('blocked', 'detector', ch);
  }

  // Nobody could ever see or answer it: no terminal, no remote channel (control center,
  // Telegram, mission queue) and no visible window. Fail fast instead of blocking.
  const broker = getApprovalBroker();
  const local = localAsker();
  if (!local && broker.channelNames().length === 0 && mgr.status().headless) return result('unreachable', 'fallback', ch);

  // 3. Show that tab to the human (live view, screenshots and input follow the active tab).
  const tabIndex = mgr.indexOfPage(page);
  if (tabIndex >= 0 && !mgr.tabs()[tabIndex]?.active) await mgr.switchTab(tabIndex);

  // 4. Owned takeover — never stolen from a human who already holds it.
  let owned = false;
  const takeOver = (): boolean => {
    const ok = mgr.setTakeover(true, owner) && mgr.status().takeoverBy === owner;
    if (ok) owned = true;
    return ok;
  };
  takeOver();

  const host = ch?.host || hostOfUrl(mgr.activeUrl());
  const meta: HandoffMeta = {
    id, host, tabIndex: Math.max(0, tabIndex), linkTtlSec: Math.min(cfg.handoffLinkTtlSec, Math.ceil(timeoutMs / 1000)),
    ...(ch ? { vendor: ch.vendor, state: ch.state } : {}),
    ...(ch?.frameBox ? { frameBox: ch.frameBox } : {}),
  };
  // 5. Auto-resume: watch for the challenge to disappear while the human works.
  let cleared = false;
  let approvalId: string | null = null;
  const stopWatch = new AbortController();
  const watchSignal = anySignal([ctx.signal, stopWatch.signal]);
  const watcher = ch
    ? (async () => {
        for (;;) {
          const left = deadline - Date.now();
          if (left <= 0 || watchSignal.aborted) return;
          const r = await waitSafely(() => mgr.waitForChallenge(page, { timeoutMs: left, signal: watchSignal, intervalMs: 1000, confirmations: 2 }));
          if (r === 'aborted' || r.timedOut) return;
          if (!r.challenge) {
            cleared = true;
            if (approvalId) broker.resolve(approvalId, 'done', 'challenge-cleared');
            return;
          }
        }
      })()
    : Promise.resolve();
  // A human handing the browser back (TUI /takeover off, control center) means "done":
  // re-check. A takeover that went off is taken again so agent tools keep waiting.
  const unwatchTakeover = watchTakeover(mgr, owner, takeOver, () => { if (approvalId) broker.resolve(approvalId, 'done', 'takeover-released'); }, watchSignal);

  ctx.emit({
    type: 'progress',
    message: ch
      ? `Waiting for a human to solve the ${challengeLabel(ch.vendor)} on ${host} — QodeX continues by itself when it is gone (up to ${formatDuration(timeoutMs)}).`
      : `Waiting for a human in the browser${host ? ` (${host})` : ''} — up to ${formatDuration(timeoutMs)}.`,
  });

  let outcome: HandoffOutcome = 'timeout';
  let by = 'timeout';
  try {
    for (let repeat = 0; ; repeat++) {
      if (cleared) { outcome = 'cleared'; by = 'challenge-cleared'; break; }
      const left = deadline - Date.now();
      if (left <= 0) { outcome = 'timeout'; by = 'timeout'; break; }
      if (ctx.signal?.aborted) { outcome = 'aborted'; by = 'abort'; break; }
      if (!mgr.isTakeover()) takeOver();
      const pending = broker.request({
        prompt: handoffPrompt(opts.reason, ch, host, timeoutMs, repeat),
        options: [...HANDOFF_OPTIONS],
        source: 'browser_request_human',
        category: 'challenge',
        risk: 'medium',
        timeoutMs: left,
        signal: ctx.signal,
        meta: { handoff: meta },
      }, local);
      approvalId = broker.pending().find(p => (p.meta as any)?.handoff?.id === id)?.id ?? null;
      if (cleared && approvalId) broker.resolve(approvalId, 'done', 'challenge-cleared');
      const r = await pending;
      approvalId = null;
      if (cleared || r.by === 'challenge-cleared') { outcome = 'cleared'; by = 'challenge-cleared'; break; }
      if (r.by === 'timeout') { outcome = 'timeout'; by = 'timeout'; break; }
      if (r.by === 'abort' || ctx.signal?.aborted) { outcome = 'aborted'; by = 'abort'; break; }
      if (r.answer !== 'done') { outcome = 'cancelled'; by = r.by; break; }
      // "done": trust it for a plain hand-off; for a challenge, look again.
      if (!ch) { outcome = 'done'; by = r.by; break; }
      const again = await waitSafely(() => mgr.waitForChallenge(page, {
        timeoutMs: Math.min(3000, Math.max(0, deadline - Date.now())), signal: ctx.signal, intervalMs: 500, confirmations: 2,
      }));
      if (again === 'aborted') { outcome = 'aborted'; by = 'abort'; break; }
      if (!again.challenge) { outcome = 'cleared'; by = r.by; break; }
      ch = again.challenge;
      ctx.emit({ type: 'progress', message: `The ${challengeLabel(ch.vendor)} on ${host} is still there — waiting for the human.` });
    }
  } finally {
    stopWatch.abort();
    unwatchTakeover();
    await watcher.catch(() => {});
    // 6. Release ONLY our own takeover — a human's own takeover is never touched.
    if (owned) mgr.releaseTakeover(owner);
  }
  return result(outcome, by, ch);
}

async function waitSafely<T>(fn: () => Promise<T>): Promise<T | 'aborted'> {
  try { return await fn(); } catch (e: any) {
    if (/\[ABORTED\]/.test(String(e?.message ?? e))) return 'aborted';
    throw e;
  }
}

/** An AbortSignal that aborts when any of `signals` does. */
function anySignal(signals: Array<AbortSignal | undefined>): AbortSignal {
  const ac = new AbortController();
  for (const s of signals) {
    if (!s) continue;
    if (s.aborted) { ac.abort(); break; }
    s.addEventListener('abort', () => ac.abort(), { once: true });
  }
  return ac.signal;
}

/**
 * While the hand-off runs: when the takeover it owned is handed back by a human, call
 * `onRelease` ("done" — re-check); whenever no takeover is on, take it again so agent
 * tools keep waiting while the human works.
 */
function watchTakeover(mgr: QodexBrowserManager, owner: string, reacquire: () => boolean, onRelease: () => void, signal: AbortSignal): () => void {
  let stopped = false;
  void (async () => {
    let wasOwner = mgr.status().takeoverBy === owner;
    while (!stopped && !signal.aborted) {
      const isOwner = mgr.status().takeoverBy === owner;
      if (wasOwner && !isOwner) onRelease();
      if (!mgr.isTakeover()) reacquire();
      wasOwner = mgr.status().takeoverBy === owner;
      await sleepUnref(250);
    }
  })();
  return () => { stopped = true; };
}

function sleepUnref(ms: number): Promise<void> {
  return new Promise(r => { const t = setTimeout(r, ms); (t as any).unref?.(); });
}

// ── the tool ────────────────────────────────────────────────────────────────

const RequestHumanArgs = z.object({
  reason: z.string().min(1).describe('What the human must do, shown to them (e.g. "solve the CAPTCHA to sign in").'),
  timeout_sec: z.number().int().min(5).max(86_400).describe('Max wait in seconds (default browser.handoffTimeoutSec).').optional(),
});

export class BrowserRequestHumanTool extends Tool<z.infer<typeof RequestHumanArgs>> {
  name = 'browser_request_human';
  description =
    'Hand the browser to the user for a CAPTCHA / bot check or a step only they can do (e.g. 2FA approval). ' +
    'Waits, resumes by itself when it clears. Never solve those yourself.';
  // Waits on the live page (ordering vs. actions in the same response): not read-only.
  isReadOnly = false;
  isDestructive = false;
  untrustedOutput = true;
  /** No tool timeout: bounded by timeout_sec and the run's abort signal (Esc / stop). */
  timeoutSeconds = 0;
  argsSchema = RequestHumanArgs;

  async execute(args: z.infer<typeof RequestHumanArgs>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const mgr = await getBrowserManager();
      if (!mgr.isRunning()) return notRunningResult();
      if (!(mgr instanceof QodexBrowserManager)) return { content: '[BROWSER_ERROR] Hand-off needs the QodeX browser manager.', isError: true };
      const r = await runHandoff({ mgr, ctx, reason: args.reason, timeoutMs: args.timeout_sec !== undefined ? args.timeout_sec * 1000 : undefined });
      const secs = Math.max(1, Math.round(r.waitedMs / 1000));
      const what = r.challenge ? `the ${challengeLabel(r.challenge.vendor)} on ${r.challenge.host || hostOfUrl(mgr.activeUrl()) || 'this site'}` : 'the step';
      const metadata = { handoffId: r.id, outcome: r.outcome, by: r.by, waitedSec: secs, ...(r.challenge ? { vendor: r.challenge.vendor, host: r.challenge.host } : {}) };
      const unsolved = (text: string): ToolResult => ({ content: `[CHALLENGE_UNSOLVED] ${text} Do not retry automatically; tell the user.`, isError: true, metadata });
      switch (r.outcome) {
        case 'refused':
          return unsolved('Hand-off is off (browser.challengeHandoff: report).');
        case 'unreachable':
          return unsolved(
            `No human can be reached for ${what}: no terminal, control center or Telegram is connected and the browser is headless. ` +
            'The user can start the control center (`qodex control`) or run QodeX in the TUI.',
          );
        case 'blocked':
          return unsolved(`${r.challenge?.host || 'The site'} blocked this browser (${r.challenge ? challengeLabel(r.challenge.vendor) : 'access denied'}) — a human cannot solve this here.`);
        case 'cancelled':
          return unsolved(`The human cancelled the hand-off (${what} is not done).`);
        case 'timeout':
          return unsolved(`Nobody finished ${what} within ${formatDuration(r.waitedMs)}.`);
        case 'aborted':
          return { content: '[ABORTED] Stopped waiting for the human (the run was cancelled).', isError: true, metadata };
        default: {
          const line = r.outcome === 'self-cleared'
            ? `✓ ${capitalize(what)} cleared by itself after ${secs}s — no human needed.`
            : r.outcome === 'done'
              ? `✓ The human finished (${secs}s) — continuing.`
              : `✓ ${capitalize(what)} is gone (${secs}s, ${r.by === 'challenge-cleared' ? 'noticed automatically' : `confirmed via ${r.by}`}) — continuing.`;
          const content = await composeActionResult(mgr, [line], null, undefined, ctx);
          return { content, metadata };
        }
      }
    } catch (e) {
      return browserErrorResult(e, 'request_human');
    }
  }
}

/** "45s" / "10 min". PURE. */
export function formatDuration(ms: number): string {
  const secs = Math.max(1, Math.round(ms / 1000));
  return secs < 120 ? `${secs}s` : `${Math.round(secs / 60)} min`;
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}
