import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { runProcess, notInstalledMessage } from '../../utils/run-process.js';

/**
 * Docker tools. Thin, structured wrappers over the `docker` CLI — the value over
 * the raw `shell` tool is (a) structured/condensed output the model reads better,
 * (b) consistent "docker not installed" handling, (c) read-only vs destructive
 * correctly flagged so the permission engine gates writes.
 *
 * Read-only: docker_ps, docker_logs, docker_inspect.
 * Destructive (mutate containers/images): docker_exec, docker_build, docker_compose.
 */

const DOCKER_HINT = 'Install Docker Desktop (macOS) from https://www.docker.com/products/docker-desktop/ and ensure the daemon is running.';

async function docker(args: string[], timeoutMs = 120_000): Promise<ToolResult> {
  const r = await runProcess('docker', args, { timeoutMs });
  if (r.notFound) return { content: notInstalledMessage('docker', DOCKER_HINT), isError: true };
  if (r.timedOut) return { content: `docker ${args[0]} timed out after ${Math.round(timeoutMs / 1000)}s.`, isError: true };
  const out = [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n');
  return { content: out || '(no output)', isError: !r.ok };
}

// ---- docker_ps ----
const PsArgs = z.object({ all: z.boolean().optional().describe('Include stopped containers (docker ps -a). Default false.') });
export class DockerPsTool extends Tool<z.infer<typeof PsArgs>> {
  name = 'docker_ps';
  description = 'List Docker containers with id, image, status, ports and name (condensed table). Read-only.';
  isReadOnly = true; isDestructive = false; argsSchema = PsArgs;
  async execute(a: z.infer<typeof PsArgs>): Promise<ToolResult> {
    const fmt = 'table {{.ID}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}\t{{.Names}}';
    const args = ['ps', '--format', fmt];
    if (a.all) args.push('-a');
    return docker(args, 20_000);
  }
}

// ---- docker_logs ----
const LogsArgs = z.object({
  container: z.string().describe('Container name or id.'),
  tail: z.number().int().min(1).max(2000).optional().describe('Number of trailing lines. Default 200.'),
  since: z.string().optional().describe("Only logs since a timestamp/relative time, e.g. '10m' or '2024-01-01T00:00:00'."),
});
export class DockerLogsTool extends Tool<z.infer<typeof LogsArgs>> {
  name = 'docker_logs';
  description = 'Read a container\'s logs (stdout+stderr), tail-limited. Read-only. Use after docker_ps to debug a running/crashed container.';
  isReadOnly = true; isDestructive = false; argsSchema = LogsArgs;
  async execute(a: z.infer<typeof LogsArgs>): Promise<ToolResult> {
    const args = ['logs', '--tail', String(a.tail ?? 200)];
    if (a.since) args.push('--since', a.since);
    args.push(a.container);
    return docker(args, 30_000);
  }
}

// ---- docker_inspect ----
const InspectArgs = z.object({
  target: z.string().describe('Container or image name/id to inspect.'),
  path: z.string().optional().describe("Optional Go-template path to extract one field, e.g. '{{.State.Health.Status}}'. Omit for a condensed summary."),
});
export class DockerInspectTool extends Tool<z.infer<typeof InspectArgs>> {
  name = 'docker_inspect';
  description = 'Inspect a container or image. With no path, returns a condensed summary (state, health, mounts, networks, env count, image). With a Go-template path, returns just that field. Read-only.';
  isReadOnly = true; isDestructive = false; argsSchema = InspectArgs;
  async execute(a: z.infer<typeof InspectArgs>): Promise<ToolResult> {
    if (a.path) return docker(['inspect', '--format', a.path, a.target], 20_000);
    const r = await runProcess('docker', ['inspect', a.target], { timeoutMs: 20_000 });
    if (r.notFound) return { content: notInstalledMessage('docker', DOCKER_HINT), isError: true };
    if (!r.ok) return { content: (r.stderr || r.stdout).trim() || 'inspect failed', isError: true };
    // Condense the (huge) inspect JSON to the fields a developer actually reads.
    try {
      const arr = JSON.parse(r.stdout);
      const o = Array.isArray(arr) ? arr[0] : arr;
      const summary: Record<string, unknown> = {
        name: o?.Name, image: o?.Config?.Image ?? o?.RepoTags,
        state: o?.State?.Status, health: o?.State?.Health?.Status,
        startedAt: o?.State?.StartedAt, restartCount: o?.RestartCount,
        ports: o?.NetworkSettings?.Ports ? Object.keys(o.NetworkSettings.Ports) : undefined,
        mounts: Array.isArray(o?.Mounts) ? o.Mounts.map((m: any) => `${m.Source}:${m.Destination}`) : undefined,
        networks: o?.NetworkSettings?.Networks ? Object.keys(o.NetworkSettings.Networks) : undefined,
        envCount: Array.isArray(o?.Config?.Env) ? o.Config.Env.length : undefined,
        cmd: o?.Config?.Cmd,
      };
      return { content: JSON.stringify(summary, null, 2) };
    } catch {
      return { content: r.stdout.slice(0, 4000) };
    }
  }
}

// ---- docker_exec ----
const ExecArgs = z.object({
  container: z.string().describe('Target container name or id.'),
  command: z.array(z.string()).min(1).describe("Command + args as an array, e.g. ['php', '-v'] or ['sh','-lc','ls /var/www']."),
  timeout_seconds: z.number().int().min(1).max(600).optional().describe('Default 120.'),
});
export class DockerExecTool extends Tool<z.infer<typeof ExecArgs>> {
  name = 'docker_exec';
  description = 'Run a command inside a running container (docker exec). Command is passed as an array (no shell injection). Destructive: it can mutate container state, so it is permission-gated.';
  isReadOnly = false; isDestructive = true; argsSchema = ExecArgs;
  async execute(a: z.infer<typeof ExecArgs>): Promise<ToolResult> {
    return docker(['exec', a.container, ...a.command], (a.timeout_seconds ?? 120) * 1000);
  }
}

// ---- docker_build ----
const BuildArgs = z.object({
  context: z.string().optional().describe('Build context dir. Default current directory "." .'),
  dockerfile: z.string().optional().describe('Path to Dockerfile if not <context>/Dockerfile.'),
  tag: z.string().optional().describe('Image tag, e.g. myapp:latest.'),
  timeout_seconds: z.number().int().min(10).max(1800).optional().describe('Default 600. Long builds: prefer background_job_start with a shell docker build.'),
});
export class DockerBuildTool extends Tool<z.infer<typeof BuildArgs>> {
  name = 'docker_build';
  description = 'Build a Docker image from a Dockerfile. Destructive (writes an image). For very long builds, consider background_job_start instead so it does not block.';
  isReadOnly = false; isDestructive = true; argsSchema = BuildArgs;
  async execute(a: z.infer<typeof BuildArgs>): Promise<ToolResult> {
    const args = ['build'];
    if (a.tag) args.push('-t', a.tag);
    if (a.dockerfile) args.push('-f', a.dockerfile);
    args.push(a.context ?? '.');
    return docker(args, (a.timeout_seconds ?? 600) * 1000);
  }
}

// ---- docker_compose ----
const ComposeArgs = z.object({
  action: z.enum(['up', 'down', 'ps', 'logs', 'build', 'restart']).describe('Compose action. up uses -d (detached).'),
  file: z.string().optional().describe('Path to compose file if not ./docker-compose.yml.'),
  service: z.string().optional().describe('Limit to one service (for logs/restart/up).'),
  tail: z.number().int().min(1).max(2000).optional().describe('For logs: trailing lines. Default 200.'),
  timeout_seconds: z.number().int().min(5).max(1800).optional().describe('Default 300.'),
});
export class DockerComposeTool extends Tool<z.infer<typeof ComposeArgs>> {
  name = 'docker_compose';
  description = 'Drive docker compose: up (-d), down, ps, logs, build, restart. ps/logs are read-only; up/down/build/restart mutate and are permission-gated. Uses the modern `docker compose` subcommand.';
  isReadOnly = false; isDestructive = true; argsSchema = ComposeArgs;
  async execute(a: z.infer<typeof ComposeArgs>): Promise<ToolResult> {
    const args = ['compose'];
    if (a.file) args.push('-f', a.file);
    switch (a.action) {
      case 'up': args.push('up', '-d'); if (a.service) args.push(a.service); break;
      case 'down': args.push('down'); break;
      case 'ps': args.push('ps'); break;
      case 'logs': args.push('logs', '--tail', String(a.tail ?? 200)); if (a.service) args.push(a.service); break;
      case 'build': args.push('build'); if (a.service) args.push(a.service); break;
      case 'restart': args.push('restart'); if (a.service) args.push(a.service); break;
    }
    return docker(args, (a.timeout_seconds ?? 300) * 1000);
  }
}
