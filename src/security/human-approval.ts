/**
 * Asking a HUMAN about what the auto-mode policy will not decide on its own (destructive
 * actions outside the project, remote-destructive / publish / deploy, system-level).
 *
 * Same routing as Sentinel-critical (src/sentinel/guard.ts askHuman): the tool's own
 * askUser only when a human sits at it (the TUI); otherwise the remote channels (control
 * center / Telegram) through the ApprovalBroker with a timeout; with nobody → null.
 * Unattended askers — headless `--yes`, a mission in 'auto', a bot chat in /auto — are never
 * consulted, so none of them can answer "yes" for the user.
 */
import type { ToolContext } from '../tools/base.js';
import { getApprovalBroker, isInteractiveHuman } from '../control/approvals.js';
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
    return { answer: await ctx.askUser(prompt, options), by: 'local' };
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
