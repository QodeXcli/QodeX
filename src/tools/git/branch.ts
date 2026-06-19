import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { git, isGitRepo } from './git-runner.js';

const GitBranchArgs = z.object({
  action: z.enum(['list', 'create', 'checkout', 'delete', 'current'])
    .describe('"list" = local + remote heads, "create" = branch off current HEAD, "checkout" = switch (creates if --create), "delete" = remove local branch, "current" = print HEAD branch name'),
  name: z.string().optional().describe('Branch name (required for create/checkout/delete)'),
  from: z.string().optional().describe('Base ref when creating (default: current HEAD)'),
  create_if_missing: z.boolean().optional().describe('For action="checkout": create the branch if it doesn\'t exist (uses `git switch -c`)'),
  force: z.boolean().optional().describe('For action="delete": use `git branch -D` to delete even unmerged branches'),
});

/**
 * Branch operations: list / current / create / checkout / delete.
 *
 * - `list` and `current` are read-only.
 * - `create` and `checkout` modify the working tree's branch state; require permission.
 * - `delete` is irreversible if the branch is unmerged AND force=true; we mark this tool
 *   destructive so the permission system can warn before run.
 *
 * We deliberately don't expose `git branch -m` (rename) or `--set-upstream-to` to keep the
 * surface tight. For uncommon ops, the agent can fall back to bash with explicit confirmation.
 */
export class GitBranchTool extends Tool<z.infer<typeof GitBranchArgs>> {
  name = 'git_branch';
  description = 'List, create, switch, or delete git branches. Use action="current" to just print the active branch. Destructive (create/checkout/delete modify repo state).';
  isReadOnly = false;
  isDestructive = true;
  argsSchema = GitBranchArgs;

  async execute(args: z.infer<typeof GitBranchArgs>, ctx: ToolContext): Promise<ToolResult> {
    if (!await isGitRepo(ctx.cwd, ctx.signal)) {
      return { content: '[NOT_A_GIT_REPO] Current directory is not inside a git working tree.', isError: true };
    }

    switch (args.action) {
      case 'current': {
        const r = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ctx.cwd, signal: ctx.signal });
        if (r.exitCode !== 0) return { content: `[ERROR] ${r.stderr.trim()}`, isError: true };
        return { content: r.stdout.trim() };
      }

      case 'list': {
        // Local + remote heads in one shot, with sortable date
        const r = await git(
          ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)\t%(committerdate:short)\t%(authorname)',
            'refs/heads/', 'refs/remotes/'],
          { cwd: ctx.cwd, signal: ctx.signal },
        );
        if (r.exitCode !== 0) return { content: `[ERROR] ${r.stderr.trim()}`, isError: true };
        const cur = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ctx.cwd, signal: ctx.signal });
        const currentBranch = cur.stdout.trim();
        const lines = r.stdout.split('\n').filter(Boolean).map(l => {
          const [name, date, author] = l.split('\t');
          const marker = name === currentBranch ? '* ' : '  ';
          return `${marker}${name?.padEnd(40).slice(0, 40)}  ${date}  ${author}`;
        });
        return { content: `Branches (newest first):\n${lines.join('\n')}`, metadata: { count: lines.length, current: currentBranch } };
      }

      case 'create': {
        if (!args.name) return { content: '[INVALID_ARGS] action="create" requires `name`.', isError: true };
        const baseArgs = ['branch', args.name];
        if (args.from) baseArgs.push(args.from);
        const r = await git(baseArgs, { cwd: ctx.cwd, signal: ctx.signal });
        if (r.exitCode !== 0) return { content: `[ERROR] ${r.stderr.trim()}`, isError: true };
        return { content: `Created branch '${args.name}'${args.from ? ` from ${args.from}` : ''}.` };
      }

      case 'checkout': {
        if (!args.name) return { content: '[INVALID_ARGS] action="checkout" requires `name`.', isError: true };
        const flags = args.create_if_missing ? ['switch', '-c', args.name] : ['switch', args.name];
        const r = await git(flags, { cwd: ctx.cwd, signal: ctx.signal });
        if (r.exitCode !== 0) return { content: `[ERROR] ${r.stderr.trim()}`, isError: true };
        return { content: `Switched to branch '${args.name}'.${r.stdout.trim() ? '\n' + r.stdout.trim() : ''}` };
      }

      case 'delete': {
        if (!args.name) return { content: '[INVALID_ARGS] action="delete" requires `name`.', isError: true };
        const flag = args.force ? '-D' : '-d';
        const r = await git(['branch', flag, args.name], { cwd: ctx.cwd, signal: ctx.signal });
        if (r.exitCode !== 0) return { content: `[ERROR] ${r.stderr.trim()}`, isError: true };
        return { content: `Deleted branch '${args.name}'.${r.stdout.trim() ? '\n' + r.stdout.trim() : ''}` };
      }
    }
  }
}
