/**
 * `background_job_*` tools — fire-and-forget long-running tasks.
 *
 * Use case: the user asks "run the full test suite while I keep coding" or
 * "fetch this 200-page docs site and summarize it". These take minutes.
 * Blocking the agent loop for that long is wasteful — the user can't iterate
 * with the model meanwhile.
 *
 * Solution: a job is started, returns an ID immediately, runs in the background,
 * and the agent can check on it (or wait for it) later.
 *
 * Distinct from `dev_server_*`: dev servers run FOREVER (until stopped) and
 * the value is the side effects. Background jobs run to COMPLETION and the
 * value is the captured output.
 *
 * Distinct from the `task` tool: `task` is synchronous sub-agent dispatch
 * (parent waits). Background jobs are async — parent gets an ID, keeps working,
 * checks back later.
 *
 * Job types supported:
 *   - 'bash':         shell command
 *   - 'subagent':     spawn a sub-agent with a prompt (async version of task)
 *   - 'web_fetch':    one-shot URL fetch (rarely needed since web_fetch is fast,
 *                     but useful for "fetch all 50 of these URLs in background")
 *
 * Storage: jobs live in memory only within the QodeX process. They DON'T
 * survive QodeX restart. (Persistence to ~/.qodex/jobs.db is a v0.9.x item.)
 */

import { z } from 'zod';
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { logger } from '../../utils/logger.js';

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  kind: 'bash' | 'subagent' | 'web_fetch';
  description: string;
  status: JobStatus;
  startedAt: number;
  finishedAt?: number;
  stdout: string;
  stderr: string;
  exitCode?: number | null;
  error?: string;
  /** For 'subagent' jobs, the final synthesis content. */
  result?: string;
  /** Internal: handle so we can cancel. */
  _abort?: AbortController;
}

const jobs = new Map<string, Job>();

const MAX_BUFFER = 100_000;

function appendCapped(s: string, chunk: string): string {
  const combined = s + chunk;
  if (combined.length <= MAX_BUFFER) return combined;
  const keep = Math.floor(MAX_BUFFER * 0.75);
  return '…[earlier output truncated]…\n' + combined.slice(combined.length - keep);
}

function newId(): string {
  return 'job_' + randomBytes(6).toString('hex');
}

/** Start a bash command in the background. */
function startBash(description: string, command: string, cwd?: string, env?: Record<string, string>): Job {
  const job: Job = {
    id: newId(),
    kind: 'bash',
    description,
    status: 'pending',
    startedAt: Date.now(),
    stdout: '',
    stderr: '',
  };
  jobs.set(job.id, job);
  const abort = new AbortController();
  job._abort = abort;

  setImmediate(() => {
    job.status = 'running';
    const child = spawn(command, {
      cwd,
      env: { ...process.env, ...(env ?? {}) },
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (d: Buffer) => { job.stdout = appendCapped(job.stdout, d.toString('utf-8')); });
    child.stderr?.on('data', (d: Buffer) => { job.stderr = appendCapped(job.stderr, d.toString('utf-8')); });
    abort.signal.addEventListener('abort', () => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      job.status = 'cancelled';
      job.finishedAt = Date.now();
    });
    child.on('exit', (code) => {
      if (job.status === 'cancelled') return;
      job.exitCode = code;
      job.status = code === 0 ? 'completed' : 'failed';
      job.finishedAt = Date.now();
    });
    child.on('error', (err) => {
      job.error = err.message;
      job.status = 'failed';
      job.finishedAt = Date.now();
    });
  });

  return job;
}

/** Start a sub-agent in the background. Wires through the SubAgentRunner from the task tool. */
function startSubagent(description: string, prompt: string, model?: string, role?: string, opts?: { maxIterations?: number }): Job {
  const job: Job = {
    id: newId(),
    kind: 'subagent',
    description,
    status: 'pending',
    startedAt: Date.now(),
    stdout: '',
    stderr: '',
  };
  jobs.set(job.id, job);
  const abort = new AbortController();
  job._abort = abort;

  setImmediate(async () => {
    job.status = 'running';
    try {
      // Pull the registered sub-agent runner. It's set by the UI layer at startup.
      // We import lazily to avoid a circular dep between agent/loop ↔ background-jobs.
      const { getSubAgentRunner } = await import('./task.js');
      const runner = getSubAgentRunner();
      if (!runner) {
        job.error = 'Sub-agents not enabled in this QodeX configuration. Set subagents.mode in config to enable.';
        job.status = 'failed';
        job.finishedAt = Date.now();
        return;
      }
      const result = await runner(prompt, {
        maxIterations: opts?.maxIterations ?? 8,
        signal: abort.signal,
        sessionId: `bg-${job.id}`,
        modelOverride: model,
        role,
      });
      // Stream the sub-agent's final text into stdout for tail/wait consumers.
      job.stdout = appendCapped(job.stdout, result.finalText ?? '');
      job.result = result.finalText ?? '';
      if (result.ok) {
        job.status = 'completed';
        job.exitCode = 0;
      } else {
        job.error = result.error;
        job.status = 'failed';
        job.exitCode = 1;
        job.stderr = appendCapped(job.stderr, result.error ?? '');
      }
      job.finishedAt = Date.now();
    } catch (e: any) {
      job.error = e?.message ?? String(e);
      job.status = 'failed';
      job.finishedAt = Date.now();
    }
  });

  return job;
}

const StartArgs = z.object({
  kind: z.enum(['bash', 'subagent']).describe('Job type. "bash" runs a shell command, "subagent" runs a sub-agent prompt asynchronously (parent keeps working).'),
  description: z.string().min(1).describe('Short description shown in job list and logs.'),
  command: z.string().optional().describe('For kind="bash": the shell command to run.'),
  prompt: z.string().optional().describe('For kind="subagent": the prompt to send.'),
  model: z.string().optional().describe('For kind="subagent": override model.'),
  role: z.string().optional().describe('For kind="subagent": role name (subagent, vision, etc) — same as task tool.'),
  max_iterations: z.number().int().min(1).max(20).optional().describe('For kind="subagent": iteration cap. Default 8.'),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
});

export class BackgroundJobStartTool extends Tool<z.infer<typeof StartArgs>> {
  name = 'background_job_start';
  description = 'Start a long-running task in the background and return immediately with a job ID. Use for tasks taking >30s where you want to keep working. Check progress with background_job_status / background_job_log.';
  isReadOnly = false;
  isDestructive = false;
  argsSchema = StartArgs;

  async execute(args: z.infer<typeof StartArgs>, _ctx: ToolContext): Promise<ToolResult> {
    let job: Job;
    if (args.kind === 'bash') {
      if (!args.command) return { content: '[BG_JOB_ERROR] kind=bash requires `command`', isError: true };
      job = startBash(args.description, args.command, args.cwd, args.env);
    } else if (args.kind === 'subagent') {
      if (!args.prompt) return { content: '[BG_JOB_ERROR] kind=subagent requires `prompt`', isError: true };
      job = startSubagent(args.description, args.prompt, args.model, args.role, { maxIterations: args.max_iterations });
    } else {
      return { content: '[BG_JOB_ERROR] unsupported kind', isError: true };
    }
    return {
      content: `Started ${job.kind} job ${job.id}: "${job.description}"\nCheck status with background_job_status id="${job.id}"`,
      metadata: { jobId: job.id },
    };
  }
}

const StatusArgs = z.object({
  id: z.string().min(1),
});

export class BackgroundJobStatusTool extends Tool<z.infer<typeof StatusArgs>> {
  name = 'background_job_status';
  description = 'Check the status of a background job. Returns: pending/running/completed/failed/cancelled, runtime, exit code. Read-only.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = StatusArgs;

  async execute(args: z.infer<typeof StatusArgs>, _ctx: ToolContext): Promise<ToolResult> {
    const job = jobs.get(args.id);
    if (!job) return { content: `[BG_JOB_ERROR] no such job: ${args.id}`, isError: true };
    const runtime = (job.finishedAt ?? Date.now()) - job.startedAt;
    const lines = [
      `Job: ${job.id}`,
      `Kind: ${job.kind}`,
      `Description: ${job.description}`,
      `Status: ${job.status}`,
      `Runtime: ${Math.floor(runtime / 1000)}s`,
    ];
    if (job.exitCode !== undefined) lines.push(`Exit code: ${job.exitCode}`);
    if (job.error) lines.push(`Error: ${job.error}`);
    lines.push(`Output: ${job.stdout.length} bytes stdout, ${job.stderr.length} bytes stderr`);
    return { content: lines.join('\n') };
  }
}

const LogArgs = z.object({
  id: z.string().min(1),
  source: z.enum(['stdout', 'stderr', 'combined']).optional(),
  max_bytes: z.number().int().min(1).max(50_000).optional(),
});

export class BackgroundJobLogTool extends Tool<z.infer<typeof LogArgs>> {
  name = 'background_job_log';
  description = 'Read captured output of a background job. Returns last N bytes. Read-only.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = LogArgs;

  async execute(args: z.infer<typeof LogArgs>, _ctx: ToolContext): Promise<ToolResult> {
    const job = jobs.get(args.id);
    if (!job) return { content: `[BG_JOB_ERROR] no such job: ${args.id}`, isError: true };
    const max = args.max_bytes ?? 4000;
    const source = args.source ?? 'combined';
    let out = '';
    if (source === 'stdout') out = job.stdout;
    else if (source === 'stderr') out = job.stderr;
    else out = job.stdout + (job.stderr ? '\n=== stderr ===\n' + job.stderr : '');
    return { content: out.length > max ? out.slice(out.length - max) : out };
  }
}

const WaitArgs = z.object({
  id: z.string().min(1),
  timeout_ms: z.number().int().min(100).max(600_000).optional().describe('Max time to wait. Default 60000.'),
});

export class BackgroundJobWaitTool extends Tool<z.infer<typeof WaitArgs>> {
  name = 'background_job_wait';
  description = 'Block until a background job completes (or timeout). Returns final status + output. Use when you actually need the result before continuing.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = WaitArgs;

  async execute(args: z.infer<typeof WaitArgs>, _ctx: ToolContext): Promise<ToolResult> {
    const job = jobs.get(args.id);
    if (!job) return { content: `[BG_JOB_ERROR] no such job: ${args.id}`, isError: true };
    const timeout = args.timeout_ms ?? 60_000;
    const start = Date.now();
    while (job.status === 'pending' || job.status === 'running') {
      if (Date.now() - start > timeout) {
        return { content: `[BG_JOB_TIMEOUT] Job ${args.id} still ${job.status} after ${timeout}ms. Status: ${job.status}` };
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    const lines = [
      `Job ${args.id} finished: ${job.status}`,
      `Runtime: ${Math.floor(((job.finishedAt ?? Date.now()) - job.startedAt) / 1000)}s`,
    ];
    if (job.exitCode !== undefined) lines.push(`Exit code: ${job.exitCode}`);
    if (job.error) lines.push(`Error: ${job.error}`);
    if (job.stdout) lines.push('', '=== stdout ===', job.stdout.length > 8000 ? job.stdout.slice(job.stdout.length - 8000) : job.stdout);
    if (job.stderr) lines.push('', '=== stderr ===', job.stderr.length > 4000 ? job.stderr.slice(job.stderr.length - 4000) : job.stderr);
    return { content: lines.join('\n') };
  }
}

const ListArgs = z.object({
  status: z.enum(['all', 'pending', 'running', 'completed', 'failed', 'cancelled']).optional(),
});

export class BackgroundJobListTool extends Tool<z.infer<typeof ListArgs>> {
  name = 'background_job_list';
  description = 'List all background jobs in this session with their status and runtime. Read-only.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = ListArgs;

  async execute(args: z.infer<typeof ListArgs>, _ctx: ToolContext): Promise<ToolResult> {
    const filter = args.status ?? 'all';
    const all = Array.from(jobs.values());
    const matching = filter === 'all' ? all : all.filter(j => j.status === filter);
    if (matching.length === 0) return { content: filter === 'all' ? '(no jobs)' : `(no jobs with status ${filter})` };
    const lines = matching.map(j => {
      const runtime = Math.floor(((j.finishedAt ?? Date.now()) - j.startedAt) / 1000);
      return `  ${j.id}  ${j.kind.padEnd(10)} ${j.status.padEnd(11)} ${runtime}s  ${j.description}`;
    });
    return { content: `Jobs (${matching.length}/${all.length}):\n${lines.join('\n')}` };
  }
}

const CancelArgs = z.object({
  id: z.string().min(1),
});

export class BackgroundJobCancelTool extends Tool<z.infer<typeof CancelArgs>> {
  name = 'background_job_cancel';
  description = 'Cancel a running background job by sending SIGTERM. Idempotent. Read-only on user filesystem.';
  isReadOnly = false;
  isDestructive = false;
  argsSchema = CancelArgs;

  async execute(args: z.infer<typeof CancelArgs>, _ctx: ToolContext): Promise<ToolResult> {
    const job = jobs.get(args.id);
    if (!job) return { content: `[BG_JOB_ERROR] no such job: ${args.id}`, isError: true };
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      return { content: `Job ${args.id} already finished (${job.status}); nothing to cancel.` };
    }
    job._abort?.abort();
    return { content: `Cancelled ${args.id}` };
  }
}

// Cleanup on process exit
process.on('exit', () => {
  for (const job of jobs.values()) {
    if (job.status === 'running') job._abort?.abort();
  }
});
