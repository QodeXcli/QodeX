/**
 * `dev_server_*` tools — manage long-running background processes.
 *
 * Use for: vite dev servers, php -S, npm start, webpack-dev-server, tsx watch,
 * laravel-mix watch, any process you want running while the agent works.
 *
 * Distinct from `bash`: bash runs to completion, dev_server keeps the process
 * alive and lets you read its output without blocking.
 *
 * Typical agent flow:
 *
 *   1. dev_server_start name=frontend, command="npm run dev", cwd="./web"
 *      → returns pid + initial output (after 2s grace period)
 *   2. browser_navigate url="http://localhost:3000"
 *   3. ... interact ...
 *   4. dev_server_log name=frontend
 *      → see what the server logged during interactions
 *   5. dev_server_stop name=frontend
 */

import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import * as registry from './process-registry.js';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Root-cause diagnosis for the recurring "dev server won't start / vite: command not found" trap.
 * When a local-binary command (npm run dev → vite) fails to be FOUND — exit 127, "command not
 * found", or an UNRESOLVED_IMPORT for a dep — the real cause is almost always a broken dependency
 * install (a stale .npmrc, or an npm/pnpm lockfile mismatch that leaves node_modules with only a
 * couple of packages). Re-running install from the agent doesn't fix it, so the model loops for
 * tens of minutes. Instead of returning the raw, opaque output, we detect the broken environment
 * and hand back a crisp, actionable message that (a) tells the model to STOP looping and (b) gives
 * the user the exact one-line fix. Returns null when the environment looks fine (don't cry wolf).
 */
export function diagnoseDevEnv(cwd: string | undefined, output: string): string | null {
  const notFound = /command not found|: not found|code 127|UNRESOLVED_IMPORT|Could not resolve|cannot find module/i.test(
    output,
  );
  if (!notFound) return null;
  const root = cwd || process.cwd();
  const nm = path.join(root, 'node_modules');
  let detail: string | null = null;
  try {
    if (!fs.existsSync(nm)) {
      detail = 'node_modules does not exist';
    } else {
      const hasBin = fs.existsSync(path.join(nm, '.bin'));
      const pkgs = fs.readdirSync(nm).filter((n) => !n.startsWith('.'));
      // A real install has dozens-to-hundreds of top-level entries and a populated .bin.
      if (!hasBin || pkgs.length <= 3) {
        detail = `node_modules looks incomplete (${pkgs.length} top-level package(s), .bin ${hasBin ? 'present' : 'missing'})`;
      }
    }
  } catch {
    /* if we can't inspect, don't fabricate a diagnosis */
  }
  if (!detail) return null;
  return [
    `[ENV_DEPS_BROKEN] ${detail}.`,
    `This is an ENVIRONMENT problem in the project folder, not a bug in the code — the dependency`,
    `install is broken (usually a stale .npmrc, or an npm/pnpm lockfile mismatch). Re-running install`,
    `from here will keep failing, so do NOT retry the dev server in a loop.`,
    `Tell the user to run this once in their own terminal, then retry the task:`,
    `  rm -rf node_modules package-lock.json pnpm-lock.yaml .npmrc && npm install`,
  ].join('\n');
}

const StartArgs = z.object({
  name: z.string().min(1).max(64).describe('Short id for later reference. e.g. "frontend", "api", "watcher".'),
  command: z.string().min(1).describe('Command to run. Shell-interpreted. e.g. "npm run dev", "php -S localhost:8000 -t public".'),
  cwd: z.string().optional().describe('Working directory. Defaults to current cwd.'),
  env: z.record(z.string()).optional().describe('Extra environment variables.'),
  replace: z.boolean().optional().describe('If a process with this name is running, kill+restart. Default false (errors instead).'),
  wait_ms: z.number().int().min(0).max(15_000).optional().describe('Wait this long after spawning, then return initial log. Default 2000.'),
});

export class DevServerStartTool extends Tool<z.infer<typeof StartArgs>> {
  name = 'dev_server_start';
  description = 'Start a long-running background process (dev server, watcher, etc). The process keeps running until dev_server_stop, QodeX exit, or its own crash. Returns the initial output after a brief warmup. Use for `npm run dev`, `vite`, `php -S`, `tsx watch`.';
  isReadOnly = false;
  isDestructive = false;
  argsSchema = StartArgs;

  async execute(args: z.infer<typeof StartArgs>, _ctx: ToolContext): Promise<ToolResult> {
    try {
      const info = await registry.start({
        name: args.name,
        command: args.command,
        cwd: args.cwd,
        env: args.env,
        replace: args.replace,
      });
      const waitMs = args.wait_ms ?? 2000;
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
      const tail = registry.tailLog(args.name, 'combined', 2000);
      const proc = registry.get(args.name);
      const exited = proc?.exitCode !== null && proc?.exitCode !== undefined;
      const status = !exited
        ? `running (pid ${info.pid})`
        : `exited with code ${proc?.exitCode}`;
      // If it failed to start (or the output shows a missing binary/dep), check whether the real
      // problem is a broken dependency install and, if so, return an actionable diagnosis instead
      // of the raw output the model would otherwise loop on.
      if (exited && proc?.exitCode !== 0) {
        const diag = diagnoseDevEnv(args.cwd ?? info.cwd, tail || '');
        if (diag) {
          return {
            content: `${diag}\n\n--- raw output ---\n${tail || '(no output)'}`,
            isError: true,
          };
        }
      }
      return {
        content: `Started '${args.name}' — ${status}\nCommand: ${args.command}\nCwd: ${info.cwd}\n\nInitial output:\n${tail || '(no output yet)'}`,
      };
    } catch (e: any) {
      return { content: `[DEV_SERVER_ERROR] ${e?.message ?? String(e)}`, isError: true };
    }
  }
}

const LogArgs = z.object({
  name: z.string().min(1),
  source: z.enum(['stdout', 'stderr', 'combined']).optional().describe('Default "combined".'),
  max_bytes: z.number().int().min(1).max(50_000).optional().describe('Truncate from front. Default 4000.'),
});

export class DevServerLogTool extends Tool<z.infer<typeof LogArgs>> {
  name = 'dev_server_log';
  description = 'Read recent output from a running background process. Returns the last N bytes of stdout/stderr/combined log. Read-only.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = LogArgs;

  async execute(args: z.infer<typeof LogArgs>, _ctx: ToolContext): Promise<ToolResult> {
    const tail = registry.tailLog(args.name, args.source ?? 'combined', args.max_bytes ?? 4000);
    return { content: tail };
  }
}

const StopArgs = z.object({
  name: z.string().min(1),
  signal: z.enum(['SIGTERM', 'SIGINT', 'SIGKILL']).optional().describe('Default SIGTERM; escalates to SIGKILL after 5s.'),
});

export class DevServerStopTool extends Tool<z.infer<typeof StopArgs>> {
  name = 'dev_server_stop';
  description = 'Stop a managed background process by name. Sends SIGTERM (graceful) then SIGKILL after 5s. Idempotent.';
  isReadOnly = false;
  isDestructive = false;
  argsSchema = StopArgs;

  async execute(args: z.infer<typeof StopArgs>, _ctx: ToolContext): Promise<ToolResult> {
    const found = await registry.stop(args.name, args.signal);
    if (!found) return { content: `No such process: ${args.name}` };
    return { content: `Stopped: ${args.name}` };
  }
}

const ListArgs = z.object({});

export class DevServerListTool extends Tool<z.infer<typeof ListArgs>> {
  name = 'dev_server_list';
  description = 'List all managed background processes with status (running / exited), pid, command, cwd, uptime. Read-only.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = ListArgs;

  async execute(_args: z.infer<typeof ListArgs>, _ctx: ToolContext): Promise<ToolResult> {
    const all = registry.list();
    if (all.length === 0) return { content: '(no managed processes)' };
    const lines = all.map(p => {
      const status = p.alive ? `running (pid ${p.pid})` : `exited code=${p.exitCode}${p.exitSignal ? ` signal=${p.exitSignal}` : ''}`;
      const uptime = p.alive ? `${Math.floor(p.uptimeMs / 1000)}s` : '-';
      return `  ${p.name.padEnd(20)} ${status.padEnd(25)} uptime=${uptime} cwd=${p.cwd}\n    cmd: ${p.command}`;
    });
    return { content: `Managed processes (${all.length}):\n${lines.join('\n')}` };
  }
}
