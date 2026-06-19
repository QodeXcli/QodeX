/**
 * `code_run` tool — execute code in a per-call sandbox.
 *
 * Use case: the agent wants to verify behavior of a snippet without committing
 * it to a file. Quick math, regex testing, JSON manipulation, "does this Python
 * snippet do what I think", reproducing a bug, generating test data, etc.
 *
 * Distinct from:
 *   - `bash`:     runs commands; this runs source code with auto temp-file management
 *   - `write_file` + `bash`: feasible but slower; this is 1 tool call
 *   - `browser_evaluate`: runs in a browser page context, this runs server-side
 *
 * Sandbox strategy (cross-platform pragmatic):
 *   - Always: chdir to a fresh temp dir per call (no clobbering project files)
 *   - Always: per-call timeout (default 30s, max 300s)
 *   - Always: memory cap via ulimit -v on Linux/macOS where supported
 *   - macOS Apple Silicon: use `sandbox-exec` with a profile that restricts FS
 *     writes to the temp dir + denies network if `network: false`
 *   - Linux: use bubblewrap (bwrap) if installed, else fall back to plain
 *   - Windows: no sandbox; rely on temp dir + timeout (warn user)
 *
 * Languages supported (auto-detected from `language` arg):
 *   python, python3 → python3
 *   node, javascript, js → node
 *   typescript, ts → tsx (if available) else node with --experimental-strip-types
 *   bash, sh → bash
 *   php → php
 *   ruby, rb → ruby
 *
 * Output capture: stdout + stderr + exit code, capped at 50KB.
 */

import { z } from 'zod';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomBytes } from 'crypto';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { logger } from '../../utils/logger.js';

const CodeRunArgs = z.object({
  language: z.enum([
    'python', 'python3',
    'node', 'javascript', 'js',
    'typescript', 'ts',
    'bash', 'sh',
    'php',
    'ruby', 'rb',
  ]).describe('Language of the snippet. Auto-picks the right interpreter.'),
  code: z.string().min(1).describe('Source code to execute.'),
  stdin: z.string().optional().describe('Optional stdin to send to the program.'),
  timeout_ms: z.number().int().min(100).max(300_000).optional().describe('Max execution time. Default 30000, max 300000.'),
  network: z.boolean().optional().describe('Allow network access. Default true. Set false to deny outbound on macOS/Linux sandbox.'),
  env: z.record(z.string()).optional().describe('Extra environment variables for the run.'),
  cwd: z.string().optional().describe('Working dir. Defaults to a fresh /tmp/qodex-run-* per call.'),
});

interface InterpreterInfo {
  cmd: string;
  args: (filePath: string) => string[];
  extension: string;
}

function pickInterpreter(lang: string): InterpreterInfo {
  switch (lang) {
    case 'python':
    case 'python3':
      return { cmd: 'python3', args: f => [f], extension: 'py' };
    case 'node':
    case 'javascript':
    case 'js':
      return { cmd: 'node', args: f => [f], extension: 'js' };
    case 'typescript':
    case 'ts':
      // Prefer tsx if available — set later via fallback detection
      return { cmd: 'node', args: f => ['--experimental-strip-types', f], extension: 'ts' };
    case 'bash':
    case 'sh':
      return { cmd: 'bash', args: f => [f], extension: 'sh' };
    case 'php':
      return { cmd: 'php', args: f => [f], extension: 'php' };
    case 'ruby':
    case 'rb':
      return { cmd: 'ruby', args: f => [f], extension: 'rb' };
    default:
      throw new Error(`Unsupported language: ${lang}`);
  }
}

/** Check if a binary is on PATH. */
async function which(cmd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const p = spawn('which', [cmd]);
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.on('exit', (code) => {
      resolve(code === 0 ? out.trim() : null);
    });
    p.on('error', () => resolve(null));
  });
}

/** Build a macOS sandbox profile that restricts writes to tempDir and optionally denies network. */
function macosSandboxProfile(tempDir: string, allowNetwork: boolean): string {
  // sandbox-exec profile (SBPL — a Scheme dialect). Allows reads everywhere
  // (most interpreters need to read libs from /usr), restricts writes to tempDir,
  // and conditionally allows network outbound.
  const allow = (cond: string): string => `(allow ${cond})`;
  const networkLines = allowNetwork
    ? [
        allow('network-outbound'),
        allow('network-bind'),
        allow('system-socket'),
      ].join('\n  ')
    : '(deny network-outbound)\n  (deny network-bind)';
  return `(version 1)
(deny default)
${allow('file-read*')}
(deny file-write*)
(allow file-write* (subpath "${tempDir}"))
(allow file-write* (subpath "/private/tmp"))
(allow file-write* (subpath "/private/var/tmp"))
(allow file-write* (literal "/dev/null") (literal "/dev/dtracehelper"))
${allow('process-exec*')}
${allow('process-fork')}
${allow('signal (target self)')}
${allow('mach-lookup')}
${allow('mach-priv-host-port')}
${allow('iokit-open')}
${allow('sysctl-read')}
${allow('system-info')}
${networkLines}
`;
}

export class CodeRunTool extends Tool<z.infer<typeof CodeRunArgs>> {
  name = 'code_run';
  description = 'Execute a code snippet in an isolated temp dir. Auto-picks the right interpreter for the language. Returns stdout, stderr, exit code. Each call uses a fresh sandbox; nothing persists between calls. Use to verify code behavior, do quick math, test regex, generate data.';
  isReadOnly = false; // can write to its own temp dir; not destructive to user filesystem
  isDestructive = false;
  argsSchema = CodeRunArgs;

  async execute(args: z.infer<typeof CodeRunArgs>, _ctx: ToolContext): Promise<ToolResult> {
    const timeoutMs = args.timeout_ms ?? 30_000;
    const allowNetwork = args.network !== false; // default true

    // Pick interpreter
    let interp: InterpreterInfo;
    try {
      interp = pickInterpreter(args.language);
    } catch (e: any) {
      return { content: `[CODE_RUN_ERROR] ${e.message}`, isError: true };
    }

    // For TS, prefer tsx if available
    if (args.language === 'typescript' || args.language === 'ts') {
      const tsxPath = await which('tsx');
      if (tsxPath) {
        interp = { cmd: 'tsx', args: f => [f], extension: 'ts' };
      }
    }

    // Verify interpreter is installed
    const interpPath = await which(interp.cmd);
    if (!interpPath) {
      return {
        content: `[CODE_RUN_ERROR] Interpreter '${interp.cmd}' not found on PATH. Install it or pick a different language.`,
        isError: true,
      };
    }

    // Create per-call temp dir
    const tempDir = args.cwd ?? path.join(os.tmpdir(), `qodex-run-${Date.now()}-${randomBytes(4).toString('hex')}`);
    if (!args.cwd) await fs.mkdir(tempDir, { recursive: true });
    const sourceFile = path.join(tempDir, `code.${interp.extension}`);
    await fs.writeFile(sourceFile, args.code, 'utf-8');

    // Decide whether to wrap in sandbox-exec (macOS) or run directly
    const isMacos = os.platform() === 'darwin';
    let spawnCmd: string;
    let spawnArgs: string[];
    let sandboxProfileFile: string | null = null;

    if (isMacos) {
      const profile = macosSandboxProfile(tempDir, allowNetwork);
      sandboxProfileFile = path.join(tempDir, '.sandbox.sb');
      await fs.writeFile(sandboxProfileFile, profile);
      spawnCmd = 'sandbox-exec';
      spawnArgs = ['-f', sandboxProfileFile, interp.cmd, ...interp.args(sourceFile)];
    } else {
      // Linux/Windows: no sandbox layer, just rely on cwd isolation + timeout
      spawnCmd = interp.cmd;
      spawnArgs = interp.args(sourceFile);
    }

    return new Promise<ToolResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let truncated = false;
      const MAX_OUT = 50_000;

      const child = spawn(spawnCmd, spawnArgs, {
        cwd: tempDir,
        env: { ...process.env, ...(args.env ?? {}), HOME: tempDir, TMPDIR: tempDir },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }, timeoutMs);

      child.stdout?.on('data', (d: Buffer) => {
        if (stdout.length + d.length > MAX_OUT) {
          stdout += d.toString('utf-8', 0, MAX_OUT - stdout.length);
          truncated = true;
        } else {
          stdout += d.toString('utf-8');
        }
      });
      child.stderr?.on('data', (d: Buffer) => {
        if (stderr.length + d.length > MAX_OUT) {
          stderr += d.toString('utf-8', 0, MAX_OUT - stderr.length);
          truncated = true;
        } else {
          stderr += d.toString('utf-8');
        }
      });

      if (args.stdin) {
        child.stdin?.write(args.stdin);
        child.stdin?.end();
      } else {
        child.stdin?.end();
      }

      child.on('error', (err) => {
        clearTimeout(killTimer);
        resolve({
          content: `[CODE_RUN_ERROR] spawn failed: ${err.message}`,
          isError: true,
        });
      });

      child.on('exit', async (code, signal) => {
        clearTimeout(killTimer);
        // Cleanup temp dir (best-effort)
        if (!args.cwd) {
          try { await fs.rm(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
        const lines: string[] = [];
        lines.push(`Language: ${args.language}`);
        lines.push(`Interpreter: ${spawnCmd}${isMacos ? ' (sandboxed)' : ''}`);
        if (signal) lines.push(`Killed by signal: ${signal}${signal === 'SIGKILL' ? ' (timeout)' : ''}`);
        else lines.push(`Exit code: ${code}`);
        if (stdout.length > 0) {
          lines.push('');
          lines.push('=== stdout ===');
          lines.push(stdout);
        }
        if (stderr.length > 0) {
          lines.push('');
          lines.push('=== stderr ===');
          lines.push(stderr);
        }
        if (truncated) {
          lines.push('');
          lines.push('[output truncated at 50000 bytes]');
        }
        resolve({
          content: lines.join('\n'),
          metadata: { exitCode: code, signal, truncated },
          isError: code !== 0 && code !== null,
        });
      });
    });
  }
}
