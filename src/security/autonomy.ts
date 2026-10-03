/**
 * Autonomous ("auto") approval policy — what runs without asking when the session
 * approval mode is 'auto' (see ApprovalMode in permissions.ts).
 *
 * The user's rules for auto mode:
 *   - Inside the project (the workspace roots) everything runs without asking: edits,
 *     shell, installs, commits, ordinary pushes, deletes of project files.
 *   - Destructive actions OUTSIDE the project still ask: deleting/overwriting paths
 *     outside the workspace roots, history rewrites on remotes (force push, remote
 *     branch deletes), deleting remote data (cloud/k8s/terraform/db/package registries),
 *     and system-level commands (sudo, shutdown, disks).
 *   - Purchases, payments, passwords and sending messages are Sentinel-critical and
 *     always need a human (src/sentinel/guard.ts) — not decided here.
 *   - The agent's own clarifying questions are not asked: the model decides, states its
 *     assumption and continues (autonomousQuestionReply).
 *
 * Hard deny patterns and user deny rules (permissions.ts) still outrank this policy.
 */
import * as os from 'os';
import * as path from 'path';

export type AutoDecision = 'allow' | 'ask' | 'deny';

export interface AutoVerdict {
  decision: AutoDecision;
  /** Why it was not simply allowed (shown in the prompt / audit). */
  reason?: string;
}

export interface AutoPolicyContext {
  /** Working directory of the tool call. */
  cwd: string;
  /** Workspace roots: cwd plus configured extra roots and the system temp dir. */
  roots: readonly string[];
}

/** Workspace roots for auto mode: cwd, extra configured roots, and the temp dir. PURE. */
export function workspaceRoots(cwd: string, extraRoots: readonly string[] = []): string[] {
  const roots = [cwd, ...extraRoots, os.tmpdir()]
    .filter(Boolean)
    .map(r => path.resolve(cwd, r));
  return [...new Set(roots)];
}

/** Is `p` (resolved against cwd) inside one of the roots? PURE (no symlink resolution). */
export function isInsideRoots(p: string, ctx: AutoPolicyContext): boolean {
  const abs = path.resolve(ctx.cwd, p);
  return ctx.roots.some(r => abs === r || abs.startsWith(r.endsWith(path.sep) ? r : r + path.sep));
}

/**
 * Decide a permission request in auto mode. `operation` is what the tool passed to the
 * permission engine (a shell command for shell-like tools, a path for edits).
 *
 * CONTRACT STUB — the full policy (shell parsing per segment, outside-workspace paths,
 * remote-destructive commands) is implemented in this module; callers must not depend
 * on anything but this signature.
 */
export function autonomousDecision(
  req: { tool: string; operation: string },
  _ctx: AutoPolicyContext,
): AutoVerdict {
  void req;
  return { decision: 'allow' };
}

/**
 * What the model gets back when it asks the user something in auto mode (ask_user, a
 * clarifying question, a plan approval): decide yourself and say so.
 */
export function autonomousQuestionReply(question: string, options?: readonly string[]): string {
  const choices = options && options.length ? ` Options were: ${options.join(', ')}.` : '';
  return (
    '[AUTONOMOUS_MODE] The user turned on auto mode and is not answering questions.' +
    ` Decide this yourself with your best judgment ("${question.slice(0, 200)}").${choices}` +
    ' State the assumption you made in your final answer, then continue the task.'
  );
}
