/**
 * Approval-mode UX for the TUI (src/cli/ui.tsx) — pure helpers, unit-tested in
 * test/automode-ux-tui.test.ts:
 *   - autoAnswerForMode: may a prompt that is on screen (or queued) be answered for the
 *     user now that the approval mode changed (Shift+Tab into edits / auto)?
 *   - modeBadge: label + color for the header / status bar.
 *   - autoModeBanner: the one-time explanation of what auto mode still asks.
 *
 * Safety rules (never relaxed here):
 *   - Sentinel prompts are never answered by a mode switch. Critical ones (purchase,
 *     payment, credential, send, integrity) always need the human's explicit answer, and
 *     Sentinel applies its own auto-mode rules to the others when it asks.
 *   - A prompt is answered only when it says what it is about (AskMeta 'permission' with
 *     tool + operation) AND the permission engine, asked again under the new mode, says
 *     'allow' — exactly what would have happened had the mode been on when the tool asked.
 *     The auto policy's 'ask' (destructive outside the project, remote deletes, …) stays.
 *   - Unknown prompts, the agent's own questions and other lanes' prompts (a chat bot's
 *     conversation) are left for the human.
 *   - The answer is the one-shot "yes"/"accept", never "always" (no standing grant).
 */
import type { AskMeta } from '../agent/ask-meta.js';
import type { ApprovalMode, PermissionDecision, PermissionRequest } from '../security/permissions.js';
import { isSentinelPrompt } from '../sentinel/guard.js';

export interface PendingPromptView {
  prompt: string;
  options: string[];
  /** What the prompt is about (from the tool that asked); undefined = unknown. */
  meta?: AskMeta;
  /** Operator-hub lane / origin ('tui' for this terminal's own runs). */
  lane?: string;
  origin?: string;
}

/** Affirmative one-shot answers, in preference order. "always …" is deliberately absent. */
const ONE_SHOT_AFFIRMATIVE = ['accept', 'yes', 'y', 'allow', 'approve'];

/** The one-shot affirmative option of `options` (never an "always" one), else null. PURE. */
export function oneShotAffirmative(options: readonly string[]): string | null {
  const lower = options.map(o => String(o).trim().toLowerCase());
  for (const want of ONE_SHOT_AFFIRMATIVE) {
    const i = lower.indexOf(want);
    if (i !== -1) return options[i]!;
  }
  return null;
}

/**
 * The answer to give a pending prompt on behalf of the user under `mode`, or null when
 * the human must answer it. `evaluate` is the session's PermissionEngine.evaluate (the
 * mode is already switched when this is called).
 */
export function autoAnswerForMode(
  p: PendingPromptView,
  mode: ApprovalMode,
  evaluate: (req: PermissionRequest) => PermissionDecision,
): string | null {
  if (mode === 'manual') return null;
  // Another lane's prompt (a chat bot conversation shown here) follows that lane's mode.
  if ((p.lane && p.lane !== 'tui') || (p.origin && p.origin !== 'tui')) return null;
  // Sentinel decides its own prompts; critical ones are human-only in every mode.
  if (isSentinelPrompt(p.prompt) || p.meta?.kind === 'sentinel') return null;
  if (!p.meta || p.meta.kind !== 'permission') return null;
  const { tool, operation } = p.meta;
  if (typeof tool !== 'string' || !tool || typeof operation !== 'string') return null;
  let decision: PermissionDecision;
  try {
    decision = evaluate({ tool, operation });
  } catch {
    return null;
  }
  return decision === 'allow' ? oneShotAffirmative(p.options) : null;
}

/** Header / status-bar badge for a mode. PURE. */
export function modeBadge(mode: ApprovalMode): { label: string; color: 'green' | 'cyan' | 'magenta'; bold: boolean } {
  if (mode === 'auto') return { label: '⏵⏵ auto', color: 'magenta', bold: true };
  if (mode === 'edits') return { label: '✎ accept edits', color: 'cyan', bold: false };
  return { label: 'manual', color: 'green', bold: false };
}

/** What auto mode still asks — the one-time banner. */
export const AUTO_MODE_BANNER =
  'Auto mode: QodeX works without asking — edits, shell, installs, commits and pushes inside this project. ' +
  'It still stops for purchases, payments, passwords, sending messages, and destructive actions outside the project ' +
  '(deleting files elsewhere, force-push, deleting remote data, publishing, sudo). Deny rules and budgets still apply. ' +
  'Shift+Tab or /auto off to leave.';

let bannerShown = false;

/** The banner the first time auto mode is enabled in this process, then null. */
export function autoModeBannerOnce(): string | null {
  if (bannerShown) return null;
  bannerShown = true;
  return AUTO_MODE_BANNER;
}

/** Tests only. */
export function resetAutoModeBannerForTests(): void {
  bannerShown = false;
}

/** History line after a prompt was answered for the user on a mode switch. PURE. */
export function autoAnsweredLine(p: PendingPromptView, answer: string, mode: ApprovalMode): string {
  const what = p.meta?.operation ? p.meta.operation.replace(/\s+/g, ' ').slice(0, 80) : p.prompt.split('\n')[0]!.slice(0, 80);
  return `Answered "${answer}" for you — ${mode} mode allows: ${what}`;
}
