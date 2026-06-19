import { z } from 'zod';
import { spawn } from 'cross-spawn';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { git, isGitRepo } from './git-runner.js';

const GitCreatePrArgs = z.object({
  title: z.string().min(1).describe('PR title. First line of commit message is a sensible default if you have only one commit.'),
  body: z.string().optional().describe('PR description. Markdown is supported. Include a brief "What" and "Why".'),
  base: z.string().optional().describe('Target branch (default: repo default branch, usually main/master).'),
  draft: z.boolean().optional().describe('Create as draft PR'),
  push: z.boolean().optional().describe('Push the current branch first if it has no upstream (default true). Set false to require the branch already exists on origin.'),
  reviewers: z.array(z.string()).optional().describe('GitHub usernames to request review from'),
  labels: z.array(z.string()).optional().describe('Labels to add'),
});

/**
 * Create a pull request via the `gh` CLI. We use `gh` rather than directly hitting the
 * GitHub API because:
 *   - It picks up the user's existing auth (gh auth login), no token mgmt in QodeX.
 *   - It Just Works for both github.com and self-hosted GitHub Enterprise.
 *   - For non-GitHub forges (GitLab, Bitbucket, Gitea), users can write their own
 *     `git_create_mr` via a custom slash command + bash.
 *
 * Flow:
 *   1. Verify we're in a git repo
 *   2. Verify `gh` is available (return a clear instruction if not)
 *   3. If push=true (default), push the current branch to origin with `--set-upstream`
 *      when needed. This handles the common "I just created a feature branch and want a PR" case.
 *   4. Run `gh pr create` with the assembled flags.
 *   5. Return the PR URL on success.
 *
 * Destructive: technically creates a remote object (the PR) and may push a branch.
 * Permission engine should prompt.
 */
export class GitCreatePrTool extends Tool<z.infer<typeof GitCreatePrArgs>> {
  name = 'git_create_pr';
  description = 'Create a GitHub pull request for the current branch via the `gh` CLI. Pushes the branch first if needed. Requires `gh` to be installed and authenticated. Destructive — creates a remote PR and may push a branch.';
  isReadOnly = false;
  isDestructive = true;
  argsSchema = GitCreatePrArgs;

  async execute(args: z.infer<typeof GitCreatePrArgs>, ctx: ToolContext): Promise<ToolResult> {
    if (!await isGitRepo(ctx.cwd, ctx.signal)) {
      return { content: '[NOT_A_GIT_REPO] Current directory is not inside a git working tree.', isError: true };
    }

    // Verify gh is available
    const ghAvail = await runOnce('gh', ['--version'], ctx.cwd, ctx.signal);
    if (ghAvail.exitCode !== 0) {
      return {
        content: '[GH_NOT_INSTALLED] The GitHub CLI (`gh`) is not installed or not in PATH. ' +
          'Install it from https://cli.github.com/, then run `gh auth login`. ' +
          'For non-GitHub remotes (GitLab, Gitea, etc.), use `bash` directly with the relevant tool.',
        isError: true,
      };
    }

    // Verify gh is authenticated
    const authR = await runOnce('gh', ['auth', 'status'], ctx.cwd, ctx.signal);
    if (authR.exitCode !== 0) {
      return {
        content: '[GH_NOT_AUTHENTICATED] `gh` is installed but not authenticated. Run `gh auth login` first.\n' +
          (authR.stderr.trim() || authR.stdout.trim()),
        isError: true,
      };
    }

    // Get current branch
    const branchR = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ctx.cwd, signal: ctx.signal });
    if (branchR.exitCode !== 0 || branchR.stdout.trim() === 'HEAD') {
      return {
        content: '[DETACHED_HEAD] Cannot create a PR from a detached HEAD. Check out a branch first.',
        isError: true,
      };
    }
    const branch = branchR.stdout.trim();

    // Push if requested and no upstream is set
    const doPush = args.push !== false;
    if (doPush) {
      const upstreamR = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd: ctx.cwd, signal: ctx.signal });
      const hasUpstream = upstreamR.exitCode === 0 && upstreamR.stdout.trim() !== '';
      const pushArgs = hasUpstream ? ['push'] : ['push', '--set-upstream', 'origin', branch];
      const pushR = await git(pushArgs, { cwd: ctx.cwd, signal: ctx.signal, timeoutMs: 120_000 });
      if (pushR.exitCode !== 0) {
        return {
          content: `[PUSH_FAILED] Could not push branch '${branch}'.\n${pushR.stderr.trim()}`,
          isError: true,
        };
      }
    }

    // Build gh pr create command
    const prArgs = ['pr', 'create', '--title', args.title, '--body', args.body ?? ''];
    if (args.base) prArgs.push('--base', args.base);
    if (args.draft) prArgs.push('--draft');
    if (args.reviewers) for (const r of args.reviewers) prArgs.push('--reviewer', r);
    if (args.labels) for (const l of args.labels) prArgs.push('--label', l);

    const prR = await runOnce('gh', prArgs, ctx.cwd, ctx.signal, 180_000);
    if (prR.exitCode !== 0) {
      return {
        content: `[PR_CREATE_FAILED] gh pr create exited ${prR.exitCode}.\n${prR.stderr.trim()}\n${prR.stdout.trim()}`.trim(),
        isError: true,
      };
    }

    // gh prints the PR URL on stdout
    const url = prR.stdout.trim().split('\n').pop() ?? '';
    return {
      content: `Created PR for branch '${branch}': ${url}`,
      metadata: { branch, url, draft: !!args.draft },
    };
  }
}

interface OnceResult { exitCode: number; stdout: string; stderr: string }

function runOnce(cmd: string, args: string[], cwd: string, signal?: AbortSignal, timeoutMs = 30_000): Promise<OnceResult> {
  return new Promise<OnceResult>((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(cmd, args, { cwd, signal, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e: any) {
      resolve({ exitCode: 127, stdout: '', stderr: e.message });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (r: OnceResult): void => { if (!settled) { settled = true; clearTimeout(t); clearTimeout(k); resolve(r); } };
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    const t = setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} }, timeoutMs);
    const k = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, timeoutMs + 2000);
    proc.on('close', (code) => done({ exitCode: code ?? 130, stdout, stderr }));
    proc.on('error', (e: any) => {
      if (e?.code === 'ENOENT') {
        done({ exitCode: 127, stdout: '', stderr: `${cmd} not found in PATH` });
      } else {
        done({ exitCode: 1, stdout, stderr: stderr + (e?.message ?? '') });
      }
    });
  });
}
