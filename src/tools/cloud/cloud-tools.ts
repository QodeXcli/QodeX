import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { runProcess, notInstalledMessage } from '../../utils/run-process.js';

/**
 * Cloud + CI tools — thin structured wrappers over the `aws` and `gh` CLIs.
 *
 *   s3_sync   — aws s3 sync/cp between local and S3 (writes → destructive)
 *   ci_status — gh run list/view: GitHub Actions run status (read-only)
 *
 * Honest scope note: GitHub Actions is *also* available via the GitHub MCP server
 * (`qodex mcp add github`), which is richer (issues, PRs, full API). `ci_status`
 * is the zero-config local-CLI shortcut for the common "did my last run pass?"
 * question. Both these tools require their CLI (aws / gh) to be installed and
 * authenticated; if not, a clear hint is returned instead of a crash.
 */

// ---- s3_sync ----
const S3Args = z.object({
  source: z.string().describe('Source: a local path or an s3://bucket/prefix URI.'),
  dest: z.string().describe('Destination: a local path or an s3://bucket/prefix URI.'),
  mode: z.enum(['sync', 'cp']).optional().describe('sync (mirror a tree, default) or cp (single object/recursive copy).'),
  dryrun: z.boolean().optional().describe('Pass --dryrun to preview what WOULD transfer without doing it. Strongly recommended first. Default false.'),
  delete: z.boolean().optional().describe('For sync: also delete files in dest not present in source (--delete). Default false — dangerous, off by default.'),
  recursive: z.boolean().optional().describe('For cp: recurse into directories (--recursive). Default false.'),
  timeout_seconds: z.number().int().min(5).max(3600).optional().describe('Default 600.'),
});
export class S3SyncTool extends Tool<z.infer<typeof S3Args>> {
  name = 's3_sync';
  description = 'Sync or copy files between local disk and AWS S3 via the aws CLI. Destructive (writes to S3 or local, and can --delete). Use dryrun:true first to preview. Requires an installed + configured aws CLI.';
  isReadOnly = false; isDestructive = true; argsSchema = S3Args;

  async execute(a: z.infer<typeof S3Args>): Promise<ToolResult> {
    const mode = a.mode ?? 'sync';
    const args = ['s3', mode, a.source, a.dest];
    if (a.dryrun) args.push('--dryrun');
    if (mode === 'sync' && a.delete) args.push('--delete');
    if (mode === 'cp' && a.recursive) args.push('--recursive');

    const r = await runProcess('aws', args, { timeoutMs: (a.timeout_seconds ?? 600) * 1000 });
    if (r.notFound) return { content: notInstalledMessage('aws', 'Install the AWS CLI v2 from https://aws.amazon.com/cli/ and run `aws configure`.'), isError: true };
    if (r.timedOut) return { content: 'aws s3 timed out — for large transfers use background_job_start with a shell aws command.', isError: true };
    const out = [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n');
    if (!r.ok) return { content: out || 'aws s3 failed', isError: true };
    return { content: `${a.dryrun ? '(dry run) ' : ''}✓ ${mode} ${a.source} → ${a.dest}\n${out}`.trim() };
  }
}

// ---- ci_status ----
const CiArgs = z.object({
  action: z.enum(['list', 'view']).optional().describe('list recent runs (default) or view one run by id.'),
  run_id: z.string().optional().describe('For view: the run id (from list).'),
  limit: z.number().int().min(1).max(50).optional().describe('For list: number of recent runs. Default 10.'),
  branch: z.string().optional().describe('For list: filter to a branch.'),
  cwd: z.string().optional().describe('Repo directory (gh infers the repo from git remote). Default current dir.'),
});
export class CiStatusTool extends Tool<z.infer<typeof CiArgs>> {
  name = 'ci_status';
  description = 'Check GitHub Actions CI status via the gh CLI: list recent workflow runs (status/conclusion/branch/workflow) or view one run\'s jobs. Read-only. Requires an installed + authenticated gh CLI. (The GitHub MCP server is the richer alternative.)';
  isReadOnly = true; isDestructive = false; argsSchema = CiArgs;

  async execute(a: z.infer<typeof CiArgs>, ctx: ToolContext): Promise<ToolResult> {
    const cwd = a.cwd ?? ctx.cwd ?? process.cwd();
    const action = a.action ?? 'list';

    if (action === 'view') {
      if (!a.run_id) return { content: 'view requires run_id (get one from ci_status action:list).', isError: true };
      const r = await runProcess('gh', ['run', 'view', a.run_id], { cwd, timeoutMs: 30_000 });
      if (r.notFound) return { content: notInstalledMessage('gh', 'Install GitHub CLI from https://cli.github.com/ and run `gh auth login`.'), isError: true };
      return { content: (r.stdout || r.stderr).trim() || '(no output)', isError: !r.ok };
    }

    // list — request JSON for a clean condensed table.
    const args = ['run', 'list', '--limit', String(a.limit ?? 10), '--json', 'databaseId,workflowName,status,conclusion,headBranch,createdAt,displayTitle'];
    if (a.branch) args.push('--branch', a.branch);
    const r = await runProcess('gh', args, { cwd, timeoutMs: 30_000 });
    if (r.notFound) return { content: notInstalledMessage('gh', 'Install GitHub CLI from https://cli.github.com/ and run `gh auth login`.'), isError: true };
    if (!r.ok) return { content: (r.stderr || r.stdout).trim() || 'gh run list failed', isError: true };
    try {
      const runs = JSON.parse(r.stdout);
      if (!runs.length) return { content: 'No workflow runs found.' };
      const lines = ['# Recent CI runs', ''];
      for (const run of runs) {
        const mark = run.conclusion === 'success' ? '✓' : run.conclusion === 'failure' ? '✗' : run.status === 'in_progress' ? '⟳' : '·';
        lines.push(`  ${mark} [${run.databaseId}] ${String(run.workflowName).padEnd(20)} ${run.headBranch}  ${run.conclusion ?? run.status}  — ${run.displayTitle}`);
      }
      lines.push('');
      lines.push('View one with ci_status action:view, run_id:<id>.');
      return { content: lines.join('\n') };
    } catch {
      return { content: r.stdout.slice(0, 4000) };
    }
  }
}
