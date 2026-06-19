import { z } from 'zod';
import crossSpawn from 'cross-spawn';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { logger } from '../../utils/logger.js';

const ArgsSchema = z.object({
  command: z.string().describe('Shell command to run. Use sparingly — prefer dedicated tools for file ops, git ops, etc.'),
  timeout_seconds: z.number().int().min(1).max(600).optional().describe('Max execution time in seconds. Default 120.'),
  description: z.string().optional().describe('Short human-readable description of what this command does (shown in permission prompts).'),
});

const MAX_OUTPUT_BYTES = 60_000;

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
        ['yes', 'no', 'always'],
      );
      if (answer === 'no') {
        return { content: `[USER_REJECTED] User declined to run: ${cmd}`, isError: true };
      }
      if (answer === 'always') {
        ctx.permissions.rememberDecision(permReq, 'allow', 'pattern');
      }
    }

    const timeoutMs = (args.timeout_seconds ?? 120) * 1000;

    // Auto-snapshot: if the wiring is present and this command pattern is destructive,
    // take a git stash first so /undo can roll back. Best-effort — never blocks on
    // failure, just logs a warning.
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
          // Snapshot failure is non-fatal — log and proceed.
          logger.warn('Auto-snapshot before bash failed (continuing)', { err: e?.message });
        }
      }
    }

    return await this.runCommand(cmd, ctx, timeoutMs);
  }

  private runCommand(cmd: string, ctx: ToolContext, timeoutMs: number): Promise<ToolResult> {
    return new Promise(resolve => {
      // cross-spawn handles Windows shell quoting and path escaping correctly.
      // shell:true lets us run a raw command string with pipes, redirects, etc.
      const proc = crossSpawn(cmd, [], {
        cwd: ctx.cwd,
        env: { ...process.env, FORCE_COLOR: '0' },
        shell: true,
        signal: ctx.signal,
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let truncated = false;
      const timer = setTimeout(() => {
        try { proc.kill('SIGTERM'); } catch {}
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 2000);
      }, timeoutMs);

      proc.stdout?.on('data', (chunk: Buffer) => {
        if (stdoutBytes < MAX_OUTPUT_BYTES) {
          stdoutChunks.push(chunk);
          stdoutBytes += chunk.length;
        } else {
          truncated = true;
        }
        // Stream lines to UI
        const text = chunk.toString('utf-8');
        for (const line of text.split('\n')) {
          if (line) ctx.emit({ type: 'shell-stdout', line });
        }
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        if (stderrBytes < MAX_OUTPUT_BYTES) {
          stderrChunks.push(chunk);
          stderrBytes += chunk.length;
        } else {
          truncated = true;
        }
        const text = chunk.toString('utf-8');
        for (const line of text.split('\n')) {
          if (line) ctx.emit({ type: 'shell-stderr', line });
        }
      });

      proc.on('error', err => {
        clearTimeout(timer);
        resolve({ content: `[SHELL_ERROR] ${err.message}`, isError: true });
      });

      proc.on('close', (code, signal) => {
        clearTimeout(timer);
        const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
        const stderr = Buffer.concat(stderrChunks).toString('utf-8');

        const parts: string[] = [];
        parts.push(`$ ${cmd}`);
        if (stdout.trim()) parts.push(stdout.trim());
        if (stderr.trim()) parts.push(`[stderr]\n${stderr.trim()}`);
        if (truncated) parts.push(`[output truncated at ~${MAX_OUTPUT_BYTES} bytes]`);

        if (signal) {
          parts.push(`[killed by signal: ${signal}${signal === 'SIGTERM' ? ` (likely timeout after ${timeoutMs / 1000}s)` : ''}]`);
        } else {
          parts.push(`[exit code: ${code}]`);
        }

        resolve({
          content: parts.join('\n'),
          isError: code !== 0,
          metadata: { exitCode: code, signal, truncated },
        });
      });
    });
  }
}
