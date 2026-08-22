import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { logger } from '../../utils/logger.js';
import { formatExecResult, resolveRuntime } from '../../runtime/exec.js';
import { interpretPermissionAnswer, setApprovalMode } from '../../security/permissions.js';

const ArgsSchema = z.object({
  command: z.string().describe('Shell command to run. Use sparingly — prefer dedicated tools for file ops, git ops, etc.'),
  timeout_seconds: z.number().int().min(1).max(600).optional().describe('Max execution time in seconds. Default 120.'),
  description: z.string().optional().describe('Short human-readable description of what this command does (shown in permission prompts).'),
});

export class BashTool extends Tool<z.infer<typeof ArgsSchema>> {
  name = 'shell';
  description = 'Run a shell command in the current working directory. Output is captured (stdout+stderr), truncated to ~60KB. Some patterns auto-approve (npm test, git status, ls, etc.) — risky patterns are auto-denied. Anything else asks the user. Use timeout_seconds for long-running operations.';
  isReadOnly = false;
  isDestructive = true;
  argsSchema = ArgsSchema;

  async execute(args: z.infer<typeof ArgsSchema>, ctx: ToolContext): Promise<ToolResult> {
    const cmd = args.command.trim();
    if (!cmd) return { content: '[ERROR] Empty command', isError: true };

    // Permission check
    const permReq = { tool: 'shell', operation: cmd, description: args.description };
    const decision = ctx.permissions.evaluate(permReq);
    if (decision === 'deny') {
      return { content: `[PERMISSION_DENIED] Command blocked by policy: ${cmd}\nIf you really need this, ask the user to add an allow rule.`, isError: true };
    }
    if (decision === 'ask') {
      ctx.emit({ type: 'permission-request', tool: 'shell', operation: cmd, description: args.description });
      const answer = await ctx.askUser(
        `Run: ${cmd}${args.description ? `\n  (${args.description})` : ''}`,
        ['yes', 'no', 'always yes'],
      );
      const verdict = interpretPermissionAnswer(answer);
      if (verdict === 'deny') {
        return { content: `[USER_REJECTED] User declined to run: ${cmd}`, isError: true };
      }
      if (verdict === 'always') {
        setApprovalMode('always');
        ctx.permissions.rememberDecision(permReq, 'allow', 'pattern');
        // "always" now binds to THIS command, and irreversible commands refuse a standing
        // grant entirely. Say so, or the user believes they answered the question once and
        // silently gets asked again — which reads as the prompt being broken.
        const refused = ctx.permissions.grantRefusalReason?.(cmd);
        if (refused) {
          ctx.emit({ type: 'shell-stderr', line: `note: ${refused}` });
        }
      }
    }

    const timeoutMs = (args.timeout_seconds ?? 120) * 1000;

    // Auto-snapshot: if the wiring is present and this command pattern is destructive,
    // take a git stash first so /undo can roll back. Best-effort — never blocks on
    // failure, but the failure IS surfaced in the result so the user knows /undo
    // is unavailable for this command.
    let snapshotWarning: string | null = null;
    if (ctx.snapshotService) {
      const snapshot = await import('../../safety/snapshot.js');
      const check = snapshot.isDestructiveBash(cmd);
      if (check.destructive) {
        try {
          ctx.snapshotService.takeSnapshot(
            `before bash: ${check.label} (${cmd.slice(0, 80)})`,
            ctx.currentTurn ?? 0,
          );
        } catch (e: any) {
          // Snapshot failure is non-fatal — log, surface to the user, and proceed.
          logger.warn('Auto-snapshot before bash failed (continuing)', { err: e?.message });
          snapshotWarning = '⚠ snapshot failed — /undo unavailable for this command';
        }
      }
    }

    const exec = ctx.exec ?? ((req) => resolveRuntime().exec(req));
    const ran = await exec({
      command: cmd,
      cwd: ctx.cwd,
      timeoutMs,
      signal: ctx.signal,
      onStdoutLine: line => ctx.emit({ type: 'shell-stdout', line }),
      onStderrLine: line => ctx.emit({ type: 'shell-stderr', line }),
    });
    const formatted = formatExecResult(cmd, ran);
    const result: ToolResult = {
      ...formatted,
      metadata: { exitCode: ran.code, signal: ran.signal, truncated: ran.truncated, backend: ran.backend },
    };
    if (snapshotWarning) {
      return { ...result, content: `${snapshotWarning}\n${result.content}` };
    }
    return result;
  }
}
