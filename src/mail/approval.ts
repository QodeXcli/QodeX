/**
 * mail_send's own approval gate — defence in depth behind Sentinel.
 *
 * Sending email is Sentinel-critical ('send'): a HUMAN answers, in every approval mode
 * (manual / edits / auto), never /auto, --yes, a bot's /auto or a mission's auto mode.
 * Sentinel reviews mail_send in ToolRegistry.execute (classification in
 * src/sentinel/policy.ts) and, when a human approved there — or a standing grant
 * matched, which records the same mark — `takeSentinelApproval(ctx, 'mail_send')` is
 * true and this gate does not ask again (one prompt, like the MCP wrapper).
 *
 * Otherwise (Sentinel off, a classification gap, a direct caller) this gate asks itself
 * with the same routing as Sentinel: the terminal's askUser only when a human sits at
 * it, else the remote channels (control center / Telegram) with a timeout, else refuse.
 * The prompt starts with Sentinel's title so every surface treats it as critical.
 */

import { getApprovalBroker, isApproval, isInteractiveHuman } from '../control/approvals.js';
import { getBus } from '../control/bus.js';
import { resolveSentinelConfig } from '../config/agent-config.js';
import { getActiveConfig } from '../config/loader.js';
import { takeSentinelApproval } from '../sentinel/auto-mode.js';
import { SENTINEL_PROMPT_TITLE } from '../sentinel/guard.js';
import type { ToolContext } from '../tools/base.js';
import { formatOutgoingPrompt, summarizeOutgoingMail, type OutgoingMailDescription } from './outgoing.js';

export type SendApproval = { ok: true; by: string } | { ok: false; message: string };

const OPTIONS = ['yes', 'no'];

function remoteTimeoutMs(): number {
  try {
    return resolveSentinelConfig(getActiveConfig() ?? {}).remoteApprovalTimeoutSec * 1000;
  } catch {
    return 600_000;
  }
}

/** The approval prompt for an outgoing email. PURE. */
export function buildSendPrompt(d: OutgoingMailDescription): string {
  return [
    SENTINEL_PROMPT_TITLE,
    `Action: ${summarizeOutgoingMail(d)}`,
    'Category: send · risk: critical',
    ...formatOutgoingPrompt(d).map(l => `  ${l}`),
    'Critical actions always need your explicit answer (/auto and --yes do not apply).',
    'Send this email? · این ایمیل ارسال شود؟',
  ].join('\n');
}

function report(action: 'allow' | 'deny', via: string, d: OutgoingMailDescription, answeredBy?: string): void {
  try {
    getBus().publish({
      kind: 'sentinel', type: 'decision',
      data: { tool: 'mail_send', action, via, category: 'send', risk: 'critical', summary: summarizeOutgoingMail(d), answeredBy },
    });
  } catch { /* never break the tool */ }
}

function raceAbort(p: Promise<string>, signal: AbortSignal | undefined): Promise<string> {
  if (!signal) return p;
  if (signal.aborted) return Promise.resolve('no');
  return new Promise<string>((resolve, reject) => {
    const onAbort = () => resolve('no');
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(v => { signal.removeEventListener('abort', onAbort); resolve(v); }, e => { signal.removeEventListener('abort', onAbort); reject(e); });
  });
}

/** Get a human's explicit yes for exactly this outgoing email (or Sentinel's, already given). */
export async function approveSend(ctx: ToolContext, d: OutgoingMailDescription): Promise<SendApproval> {
  if (takeSentinelApproval(ctx, 'mail_send')) return { ok: true, by: 'sentinel' };
  const prompt = buildSendPrompt(d);
  try { ctx.emit?.({ type: 'progress', message: `🛡 Waiting for a human to approve: ${summarizeOutgoingMail(d)}` }); } catch { /* UI only */ }

  let answer: string;
  let by: string;
  if (isInteractiveHuman()) {
    answer = await raceAbort(Promise.resolve().then(() => ctx.askUser(prompt, OPTIONS)), ctx.signal);
    by = ctx.signal?.aborted ? 'abort' : 'local';
  } else {
    const broker = getApprovalBroker();
    if (!broker.hasRemoteChannel()) {
      report('deny', 'no-human', d);
      return {
        ok: false,
        message: '[SENTINEL_BLOCKED] Sending email needs a human approval, but no one is available to approve it in this run. Nothing was sent. ' +
          'The user can approve sends interactively (qodex), or through the control center (qodex control) or Telegram (qodex telegram start). Tell the user the draft is waiting.',
      };
    }
    const r = await broker.request({
      prompt, options: OPTIONS, source: 'mail_send', category: 'send', risk: 'critical',
      timeoutMs: remoteTimeoutMs(), signal: ctx.signal,
      meta: { kind: 'sentinel', summary: summarizeOutgoingMail(d), sessionId: ctx.sessionId },
    });
    answer = r.answer;
    by = r.by;
  }
  if (isApproval(answer, OPTIONS)) {
    report('allow', 'human', d, by);
    return { ok: true, by };
  }
  report('deny', by === 'timeout' ? 'timeout' : 'human', d, by);
  if (by === 'timeout') return { ok: false, message: '[SENTINEL_DENIED] No approval arrived in time to send this email. Nothing was sent. Do not retry on your own; tell the user it is waiting for their approval.' };
  if (by === 'abort') return { ok: false, message: '[SENTINEL_DENIED] Cancelled while waiting for approval. Nothing was sent.' };
  return { ok: false, message: '[SENTINEL_DENIED] The user declined sending this email. Nothing was sent. Do not retry; ask the user how to proceed.' };
}
