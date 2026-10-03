import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { logger } from '../../utils/logger.js';
import { formatExecResult, resolveRuntime } from '../../runtime/exec.js';
import { isAutonomousMode } from '../../security/permissions.js';
import { confirmShellCommand } from './confirm.js';

const ArgsSchema = z.object({
  command: z.string().describe('Shell command to run. Use sparingly — prefer dedicated tools for file ops, git ops, etc.'),
  timeout_seconds: z.number().int().min(1).max(600).optional().describe('Max execution time in seconds. Default 120.'),
  description: z.string().optional().describe('Short human-readable description of what this command does (shown in permission prompts).'),
});

export class BashTool extends Tool<z.infer<typeof ArgsSchema>> {
  name = 'shell';
  description = 'Run a shell command in the current working directory. Output is captured (stdout+stderr), truncated to ~60KB. Some patterns auto-approve (npm test, git status, ls, etc.) — risky patterns are auto-denied. Anything else asks the user (in auto mode only destructive actions outside the project, force pushes/publishes and system-level commands ask). Use timeout_seconds for long-running operations.';
  isReadOnly = false;
  isDestructive = true;
  argsSchema = ArgsSchema;

  async execute(args: z.infer<typeof ArgsSchema>, ctx: ToolContext): Promise<ToolResult> {
    const cmd = args.command.trim();
    if (!cmd) return { content: '[ERROR] Empty command', isError: true };

    // Permission check (reason in the prompt; auto-policy asks go to a real human).
    const refused = await confirmShellCommand(ctx, { tool: 'shell', command: cmd, description: args.description });
    if (refused) return refused;

    const timeoutMs = (args.timeout_seconds ?? 120) * 1000;

    // Auto-snapshot: if the wiring is present and this command pattern is destructive,
    // take a git stash first so /undo can roll back. Best-effort — never blocks on
    // failure, but the failure IS surfaced in the result so the user knows /undo
    // is unavailable for this command. In auto mode nobody confirmed an in-project
    // `rm -rf` / `git reset --hard` / `git checkout -- .`, so the policy's own
    // classification of those also triggers it.
    let snapshotWarning: string | null = null;
    if (ctx.snapshotService) {
      const snapshot = await import('../../safety/snapshot.js');
      const check = snapshot.isDestructiveBash(cmd, isAutonomousMode() ? { cwd: ctx.cwd } : undefined);
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
