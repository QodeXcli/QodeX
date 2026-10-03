/**
 * The permission step for tools that run a shell command line (shell, background_job_start).
 *
 * evaluate() decides; on 'ask' the prompt says WHY (the policy's reason) and offers
 * "always yes" only when it could help — "always yes" switches the session to auto mode, so
 * it is pointless (and misleading) for something auto mode would still ask about. Asks the
 * auto policy raises go to a real human (askHumanForAutoMode), never to an unattended
 * auto-answerer.
 */
import type { ToolContext, ToolResult } from '../base.js';
import { interpretPermissionAnswer, setApprovalMode } from '../../security/permissions.js';
import { askHumanForAutoMode, explainRequest, unansweredMessage, whyLine } from '../../security/human-approval.js';

export const AUTO_MODE_ON_NOTE =
  'note: auto mode is on for this session (Shift+Tab or /auto to change). It still asks before destructive ' +
  'actions outside the project, force pushes / remote deletes / publishes, and system-level commands.';

/** Returns null to proceed, or the tool result to return instead (denied / declined / no human). */
export async function confirmShellCommand(
  ctx: ToolContext,
  req: { tool: string; command: string; description?: string },
): Promise<ToolResult | null> {
  const cmd = req.command;
  const permReq = { tool: req.tool, operation: cmd, description: req.description, cwd: ctx.cwd };
  const decision = ctx.permissions.evaluate(permReq);
  if (decision === 'allow') return null;
  const ex = explainRequest(ctx.permissions as any, permReq);
  if (decision === 'deny') {
    return {
      content: `[PERMISSION_DENIED] Command blocked by policy: ${cmd}${ex.reason ? ` (${ex.reason})` : ''}\nIf you really need this, ask the user to add an allow rule.`,
      isError: true,
    };
  }

  ctx.emit({ type: 'permission-request', tool: req.tool, operation: cmd, description: req.description });
  const prompt = `Run: ${cmd}${req.description ? `\n  (${req.description})` : ''}${whyLine(ex)}`;
  const options = ex.canAlways ? ['yes', 'no', 'always yes'] : ['yes', 'no'];

  let answer: string;
  if (ex.autoPolicy) {
    const r = await askHumanForAutoMode(ctx, prompt, options, { source: req.tool, reason: ex.reason });
    if (!r || r.by === 'timeout' || r.by === 'fallback') {
      return { content: unansweredMessage(`run \`${cmd}\``, ex.reason, r?.by ?? null), isError: true };
    }
    answer = r.answer;
  } else {
    answer = await ctx.askUser(prompt, options);
  }

  const verdict = interpretPermissionAnswer(answer);
  if (verdict === 'deny') {
    return { content: `[USER_REJECTED] User declined to run: ${cmd}`, isError: true };
  }
  if (verdict === 'always') {
    // The user's explicit choice: the whole session goes to auto mode (with its policy —
    // never a blanket yes). The engine stores no grant for anything auto would still ask.
    setApprovalMode('auto');
    ctx.permissions.rememberDecision(permReq, 'allow', 'pattern');
    ctx.emit({ type: 'shell-stderr', line: AUTO_MODE_ON_NOTE });
  }
  return null;
}
