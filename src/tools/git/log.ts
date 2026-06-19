import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { git, isGitRepo } from './git-runner.js';

const GitLogArgs = z.object({
  limit: z.number().int().min(1).max(200).optional().describe('Max commits to show (default 20)'),
  paths: z.array(z.string()).optional().describe('Only show commits touching these paths'),
  author: z.string().optional().describe('Filter by author name/email substring'),
  since: z.string().optional().describe('Only commits more recent than this date (e.g. "2 weeks ago", "2026-01-01")'),
  branch: z.string().optional().describe('Show log for a specific branch / ref (default: current HEAD)'),
});

/**
 * Compact recent-commits log. Uses a stable single-line format that's easy for the model
 * to scan and disambiguate. We separate fields with NUL inside one line, then re-emit
 * with vertical bars for readability — this avoids breakage when commit messages
 * contain pipe characters.
 */
export class GitLogTool extends Tool<z.infer<typeof GitLogArgs>> {
  name = 'git_log';
  description = 'Show recent git commit history (default 20 commits). Optional filters by path, author, date range, or branch. One line per commit: shortsha | date | author | subject. Read-only.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = GitLogArgs;

  async execute(args: z.infer<typeof GitLogArgs>, ctx: ToolContext): Promise<ToolResult> {
    if (!await isGitRepo(ctx.cwd, ctx.signal)) {
      return { content: '[NOT_A_GIT_REPO] Current directory is not inside a git working tree.', isError: true };
    }
    const limit = args.limit ?? 20;
    // NUL-separated fields, newline-separated commits. Format codes:
    //   %h short sha, %ad author-date short, %an author name, %s subject
    const gitArgs = ['log', `-${limit}`, '--date=short', `--pretty=format:%h%x00%ad%x00%an%x00%s`];
    if (args.author) gitArgs.push(`--author=${args.author}`);
    if (args.since) gitArgs.push(`--since=${args.since}`);
    if (args.branch) gitArgs.push(args.branch);
    if (args.paths && args.paths.length > 0) {
      gitArgs.push('--');
      gitArgs.push(...args.paths);
    }

    const r = await git(gitArgs, { cwd: ctx.cwd, signal: ctx.signal });
    if (r.exitCode !== 0) {
      // Empty repo, unknown ref, etc.
      return { content: `[ERROR] ${r.stderr.trim() || r.stdout.trim()}`, isError: true };
    }
    const lines = r.stdout.split('\n').filter(Boolean);
    if (lines.length === 0) {
      return { content: '[NO_COMMITS] No commits match those filters.' };
    }
    const formatted = lines.map(l => {
      const [sha, date, author, ...rest] = l.split('\x00');
      const subject = rest.join('\x00'); // subject can contain NUL if anyone embedded one; very unlikely
      return `${sha}  ${date}  ${author?.padEnd(20).slice(0, 20)}  ${subject}`;
    });
    return {
      content: `${lines.length} commit${lines.length > 1 ? 's' : ''}:\n${formatted.join('\n')}`,
      metadata: { count: lines.length },
    };
  }
}
