/**
 * Asking a HUMAN about what the auto-mode policy will not decide on its own (destructive
 * actions outside the project, remote-destructive / publish / deploy, system-level).
 *
 * Same routing as Sentinel-critical (src/sentinel/guard.ts askHuman): the tool's own
 * askUser only when a human sits at it (the TUI); otherwise the remote channels (control
 * center / Telegram) through the ApprovalBroker with a timeout; with nobody → null.
 * Unattended askers — headless `--yes`, a mission in 'auto', a bot chat in /auto — are never
 * consulted, so none of them can answer "yes" for the user.
 *
 * In the TUI the ask waits approval.unattendedTimeoutSec (default 120 s, 0 = forever) and is
 * then denied with a rewrite hint ([AUTO_MODE_TIMEOUT]): an auto run the user walked away from
 * keeps going instead of sitting on one prompt. Remote answers (control center / Telegram)
 * still count while it waits. Sentinel-critical prompts never use this (they keep waiting).
 */
import type { ToolContext } from '../tools/base.js';
import { getApprovalBroker, isInteractiveHuman, safeOption } from '../control/approvals.js';
import { getActiveConfig } from '../config/loader.js';
import { resolveSentinelConfig } from '../config/agent-config.js';
import { AUTO_NEEDS_HUMAN_TAG, needsHumanMessage } from './autonomy.js';
import type { PermissionExplanation, PermissionRequest } from './permissions.js';

export interface HumanAnswer {
  answer: string;
  /** 'local' (the tool's askUser), a channel name, 'timeout', 'abort', 'fallback'. */
  by: string;
}

/** Remote approval timeout (sentinel.remoteApprovalTimeoutSec, default 600 s). */
function remoteTimeoutMs(): number {
  try {
    return resolveSentinelConfig(getActiveConfig() ?? {}).remoteApprovalTimeoutSec * 1000;
  } catch {
    return 600_000;
  }
}

export const AUTO_MODE_TIMEOUT_TAG = '[AUTO_MODE_TIMEOUT]';

/** approval.unattendedTimeoutSec: seconds an auto-mode ask waits in the TUI (default 120, 0 = forever). */
export function unattendedTimeoutSec(): number {
  try {
    const v = (getActiveConfig() as { approval?: { unattendedTimeoutSec?: unknown } } | null)?.approval?.unattendedTimeoutSec;
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  } catch { /* default */ }
  return 120;
}

/** "2 minutes", "1 minute", "45 seconds". PURE. */
export function formatWait(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s >= 60 && s % 60 === 0) return s === 60 ? '1 minute' : `${s / 60} minutes`;
  return s === 1 ? '1 second' : `${s} seconds`;
}

/** The tool result when an auto-mode ask got no answer in the TUI within the timeout. PURE. */
export function autoModeTimeoutMessage(what: string, reason: string | undefined, sec: number): string {
  return `${AUTO_MODE_TIMEOUT_TAG} No answer in ${formatWait(sec)} — not done. Rewrite it to stay inside the project ` +
    '(e.g. target a path under the workspace) or leave it for the user and continue with the rest.' +
    `\n  Asked: ${what}${reason ? ` — ${reason}` : ''}`;
}

/**
 * Ask the human at this terminal, giving up after `sec` seconds (0 = wait forever): resolves
 * `{ by: 'local' }` with their answer, or `{ answer: <safe option>, by: 'timeout' }`. On timeout
 * the prompt this ask put up (a terminal entry in the ApprovalBroker with this exact text) is
 * withdrawn, so it does not linger on screen or on the remote channels.
 */
export function askLocalWithTimeout(ask: () => Promise<string>, prompt: string, options: string[], sec: number): Promise<HumanAnswer> {
  if (!(sec > 0)) return Promise.resolve().then(ask).then(answer => ({ answer, by: 'local' }));
  const broker = getApprovalBroker();
  const before = new Set(broker.pending().map(p => p.id));
  return new Promise<HumanAnswer>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      for (const p of broker.pending()) {
        if (!before.has(p.id) && p.prompt === prompt) broker.cancel(p.id, 'timeout');
      }
      resolve({ answer: safeOption(options) ?? 'no', by: 'timeout' });
    }, sec * 1000);
    timer.unref?.();
    Promise.resolve().then(ask).then(
      (answer) => { if (done) return; done = true; clearTimeout(timer); resolve({ answer, by: 'local' }); },
      (e) => { if (done) return; done = true; clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Ask a human. Returns null when no human can be reached (no interactive terminal and no
 * remote channel) — the caller refuses with needsHumanMessage().
 */
export async function askHumanForAutoMode(
  ctx: Pick<ToolContext, 'askUser' | 'signal' | 'sessionId'>,
  prompt: string,
  options: string[],
  meta: { source: string; reason?: string },
): Promise<HumanAnswer | null> {
  if (isInteractiveHuman()) {
    return askLocalWithTimeout(() => ctx.askUser(prompt, options), prompt, options, unattendedTimeoutSec());
  }
  const broker = getApprovalBroker();
  if (!broker.hasRemoteChannel()) return null;
  const r = await broker.request({
    prompt,
    options,
    source: meta.source,
    category: 'auto-mode',
    risk: 'high',
    timeoutMs: remoteTimeoutMs(),
    signal: ctx.signal,
    meta: { reason: meta.reason, sessionId: ctx.sessionId },
  });
  return { answer: r.answer, by: r.by };
}

/** The tool result when a human could not be reached / did not answer in time. */
export function unansweredMessage(what: string, reason: string | undefined, by: string | null): string {
  // A timeout at this terminal is the unattended one (askHumanForAutoMode's TUI branch).
  if (by === 'timeout' && isInteractiveHuman()) return autoModeTimeoutMessage(what, reason, unattendedTimeoutSec());
  if (by === 'timeout') {
    return `${AUTO_NEEDS_HUMAN_TAG} No approval arrived in time for: ${what}${reason ? ` — ${reason}` : ''}. It was not done. Do not retry it on your own; tell the user it is waiting for their approval.`;
  }
  return needsHumanMessage(what, reason);
}

/**
 * `explain()` when the engine has it (tests and other hosts may pass a minimal stub):
 * the reason to show, whether "always yes" can help, and whether the auto policy asked.
 */
export function explainRequest(
  permissions: { explain?: (req: PermissionRequest) => PermissionExplanation } | undefined,
  req: PermissionRequest,
): { reason?: string; canAlways: boolean; autoPolicy: boolean } {
  try {
    const ex = permissions?.explain?.(req);
    if (ex) return { reason: ex.reason, canAlways: ex.canAlways, autoPolicy: ex.via === 'auto-policy-ask' };
  } catch { /* fall through to the old prompt */ }
  return { canAlways: true, autoPolicy: false };
}

/** Same text as src/sentinel/auto-mode.ts AUTO_MODE_ASKS (channels match on it). */
const AUTO_MODE_ASKS_LABEL = 'Auto mode still asks';

/**
 * The prompt line explaining why it asks. An auto-policy ask carries the
 * "Auto mode still asks" marker so the bot, Telegram, the control center and mission
 * queues can say why (isAutoModeAskPrompt). PURE.
 */
export function whyLine(ex: { reason?: string; autoPolicy: boolean }): string {
  if (!ex.reason) return '';
  return ex.autoPolicy ? `\n  ${AUTO_MODE_ASKS_LABEL}: ${ex.reason}` : `\n  Why: ${ex.reason}`;
}
