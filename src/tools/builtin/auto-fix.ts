/**
 * `auto_fix` tool — iterate on a failing test/command until it passes.
 *
 * Use case: "make the test suite pass" or "make this build green". The agent
 * picks the fix; auto_fix just orchestrates the test→fix→test loop and tracks
 * progress.
 *
 * How it works:
 *   1. Run the verification command (e.g. "npm test", "pytest", "go test ./...").
 *   2. If it passes (exit 0), return success.
 *   3. If it fails, return the failure output + iteration counter to the agent.
 *      Agent then has a clear signal: read what failed, edit files to fix it,
 *      call auto_fix again. Loop until pass or max_iterations.
 *
 * Why not bake the "fix" step into the tool?
 *   - The agent already has read_file, write_file, edit_text, etc.
 *   - The "fix" is creative work that needs LLM judgement.
 *   - Forcing fixes inside the tool would force a sub-agent for every iteration
 *     — wasteful and slower than letting the main loop handle it.
 *
 * What the tool DOES add:
 *   - Persistent iteration count across calls (stored by `id`)
 *   - Auto-stops at max_iterations with a clear "give up" message
 *   - Captures the FIRST and LAST failures so agent can see whether progress
 *     was actually made
 *   - Detects "same failure as last time" — gentle nudge that the latest fix
 *     didn't help
 */

import { z } from 'zod';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { Tool, type ToolContext, type ToolResult } from '../base.js';

interface FixSession {
  id: string;
  command: string;
  cwd: string;
  startedAt: number;
  iteration: number;
  maxIterations: number;
  firstFailure?: string;
  lastFailure?: string;
  lastFailureHash?: string;
  consecutiveSameFailure: number;
  passed: boolean;
}

const sessions = new Map<string, FixSession>();

function runOnce(command: string, cwd: string, timeoutMs: number): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0', CI: '1' },
    });
    let buf = '';
    const cap = 30_000;
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs);
    const onData = (d: Buffer) => {
      const chunk = d.toString('utf-8');
      if (buf.length + chunk.length <= cap) buf += chunk;
      else if (buf.length < cap) buf = buf + chunk.slice(0, cap - buf.length) + '\n[truncated]';
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, output: buf });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, output: `[spawn error] ${err.message}\n${buf}` });
    });
  });
}

const AutoFixArgs = z.object({
  id: z.string().min(1).describe('Stable session id you choose. Re-use across iterations of the SAME problem so the loop counter tracks correctly. Example: "test-suite-fix-2026-05-26".'),
  command: z.string().min(1).describe('The verification command. e.g. "npm test", "pytest -x", "cargo test", "go test ./...". Should exit 0 on success.'),
  cwd: z.string().optional().describe('Where to run. Defaults to current cwd.'),
  max_iterations: z.number().int().min(1).max(50).optional().describe('Cap on retries before giving up. Default 10.'),
  timeout_ms: z.number().int().min(5000).max(900_000).optional().describe('Per-run timeout. Default 120000 (2 min).'),
  reset: z.boolean().optional().describe('Clear iteration counter for this id (start fresh).'),
});

export class AutoFixTool extends Tool<z.infer<typeof AutoFixArgs>> {
  name = 'auto_fix';
  description = 'Run a verification command (test suite, build, lint) and report pass/fail with iteration tracking. Call repeatedly with the same `id` between your fix attempts; the tool tracks consecutive failures and stops you after max_iterations. The fixes themselves are YOUR responsibility — use read_file / edit_text / write_file between calls. Read-only on user filesystem (only side effect: running the command).';
  isReadOnly = false;
  isDestructive = false;
  argsSchema = AutoFixArgs;

  async execute(args: z.infer<typeof AutoFixArgs>, _ctx: ToolContext): Promise<ToolResult> {
    let session = sessions.get(args.id);
    if (args.reset || !session) {
      session = {
        id: args.id,
        command: args.command,
        cwd: args.cwd ?? process.cwd(),
        startedAt: Date.now(),
        iteration: 0,
        maxIterations: args.max_iterations ?? 10,
        consecutiveSameFailure: 0,
        passed: false,
      };
      sessions.set(args.id, session);
    }
    session.iteration++;

    if (session.iteration > session.maxIterations) {
      return {
        content: `[AUTO_FIX_GAVE_UP] Hit max_iterations=${session.maxIterations} for "${args.id}". ` +
          `Last failure was:\n\n${session.lastFailure ?? '(none)'}\n\n` +
          `Stop trying programmatically and report to the user what's blocking you.`,
      };
    }

    const result = await runOnce(args.command, session.cwd, args.timeout_ms ?? 120_000);
    const passed = result.exitCode === 0;
    const lines: string[] = [];
    lines.push(`Iteration ${session.iteration}/${session.maxIterations} — ${passed ? 'PASS ✓' : 'FAIL ✗'}`);
    lines.push(`Command: ${args.command}`);
    lines.push(`Exit code: ${result.exitCode}`);

    if (passed) {
      session.passed = true;
      lines.push('');
      lines.push('Success! No further action needed.');
      sessions.delete(args.id); // free memory
      return { content: lines.join('\n') };
    }

    // Track first failure separately so we can compare progress later
    if (!session.firstFailure) session.firstFailure = result.output;

    // Detect "same failure as last time"
    const hash = createHash('md5').update(result.output).digest('hex');
    if (session.lastFailureHash === hash) {
      session.consecutiveSameFailure++;
    } else {
      session.consecutiveSameFailure = 1;
      session.lastFailureHash = hash;
    }
    session.lastFailure = result.output;

    lines.push('');
    lines.push('=== Output ===');
    lines.push(result.output);

    if (session.consecutiveSameFailure >= 2) {
      lines.push('');
      lines.push(
        `⚠ This is the ${session.consecutiveSameFailure}th identical failure in a row. ` +
        `Your last fix didn't change the test output. Try a different angle: ` +
        `is the test even hitting your changes? Is there a build cache? Did the file save?`,
      );
    }

    lines.push('');
    lines.push(
      `Next step: read the output above, edit the relevant files to address the failure, ` +
      `then call auto_fix again with the SAME id="${args.id}" to verify the fix. ` +
      `${session.maxIterations - session.iteration} iteration(s) left.`,
    );
    return { content: lines.join('\n') };
  }
}
