import { spawn } from 'cross-spawn';
import { redactObject } from '../utils/redact.js';
import { logger } from '../utils/logger.js';
import type { HookConfig, HookContext, HookRunResult } from './types.js';

/**
 * Run a single hook to completion. Always resolves (never rejects); failures become
 * structured HookRunResult objects with a non-zero exitCode so callers can decide policy.
 *
 * Process lifecycle:
 *   - Spawn through cross-spawn with shell: true (so users can write `prettier --write $X`
 *     with normal shell syntax, redirections, pipes).
 *   - SIGTERM at timeout, SIGKILL 2s later. We DO await exit so callers can be sure
 *     no zombie hook process is left running once we return.
 *
 * Security note: hooks run with the user's full shell privileges. They are explicitly
 * NOT sandboxed — the same way that .git/hooks aren't sandboxed. Users opt in by writing
 * a config file. We do redact sensitive arg values from the JSON we expose via env.
 */
export async function runHook(hook: HookConfig, ctx: HookContext): Promise<HookRunResult> {
  const start = Date.now();
  const timeoutMs = Math.max(1, hook.timeout ?? 30) * 1000;
  const hookName = hook.name ?? hook.command.slice(0, 60);

  // Build env. Redact sensitive arg values so a logger hook can't accidentally
  // exfiltrate API keys etc. that the model passed to a tool.
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    QODEX_HOOK_EVENT: ctx.event,
    QODEX_SESSION_ID: ctx.sessionId,
    QODEX_CWD: ctx.cwd,
  };
  if (ctx.toolName) env.QODEX_TOOL_NAME = ctx.toolName;
  if (ctx.toolArgsJson) {
    // Re-parse, redact, re-serialise so secret values don't leak via env
    try {
      const parsed = JSON.parse(ctx.toolArgsJson);
      env.QODEX_TOOL_ARGS_JSON = JSON.stringify(
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? redactObject(parsed)
          : parsed,
      );
    } catch {
      env.QODEX_TOOL_ARGS_JSON = ctx.toolArgsJson;
    }
  }
  if (ctx.toolResult !== undefined) {
    // Truncate to avoid huge env entries (some systems have ARG_MAX limits)
    env.QODEX_TOOL_RESULT = ctx.toolResult.length > 64 * 1024
      ? ctx.toolResult.slice(0, 64 * 1024) + '\n...[truncated]'
      : ctx.toolResult;
  }
  if (ctx.filePaths && ctx.filePaths.length > 0) {
    env.QODEX_FILE_PATHS = ctx.filePaths.join(' ');
  }

  return new Promise<HookRunResult>((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(hook.command, [], {
        shell: true,
        cwd: hook.cwd ?? ctx.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e: any) {
      logger.warn(`Hook spawn failed`, { hookName, err: e.message });
      resolve({
        hookName,
        exitCode: 127,
        stdout: '',
        stderr: `spawn failed: ${e.message}`,
        durationMs: Date.now() - start,
        timedOut: false,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const settle = (result: HookRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      resolve(result);
    };

    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    const termTimer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGTERM'); } catch {}
    }, timeoutMs);
    const killTimer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
    }, timeoutMs + 2000);

    proc.on('close', (code, signal) => {
      const exitCode = code ?? (signal === 'SIGTERM' ? 124 : signal === 'SIGKILL' ? 137 : 130);
      settle({
        hookName,
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - start,
        timedOut,
      });
    });
    proc.on('error', (e) => {
      settle({
        hookName,
        exitCode: 127,
        stdout,
        stderr: stderr ? stderr + '\n' + (e.message ?? '') : (e.message ?? ''),
        durationMs: Date.now() - start,
        timedOut: false,
      });
    });
  });
}
