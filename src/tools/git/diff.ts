import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { git, isGitRepo } from './git-runner.js';

const GitDiffArgs = z.object({
  scope: z.enum(['unstaged', 'staged', 'all', 'commit'])
    .describe('"unstaged" = working tree vs index, "staged" = index vs HEAD, "all" = working tree vs HEAD, "commit" = diff for a specific commit (requires ref)'),
  ref: z.string().optional().describe('Required when scope="commit": commit SHA, branch name, or HEAD~N'),
  paths: z.array(z.string()).optional().describe('Limit diff to these paths'),
  mode: z.enum(['stat', 'patch', 'name-only']).optional()
    .describe('"stat" = files-changed summary, "patch" = full unified diff (default), "name-only" = paths only'),
  max_bytes: z.number().int().min(1024).max(1_000_000).optional().describe('Truncate patch output at this many bytes (default 80000)'),
});

/**
 * Show git diff. Defaults to unified patch (mode="patch") for the working tree vs index.
 * Truncates large diffs to keep context bounded — model can re-run with --paths if it
 * needs a specific file.
 *
 * Scope mapping to underlying git invocations:
 *   - unstaged: `git diff`
 *   - staged:   `git diff --cached`
 *   - all:      `git diff HEAD`
 *   - commit:   `git show <ref>` (with --format= so we omit the commit header)
 *
 * Note: we deliberately don't expose `--word-diff` or other formats — keep the tool
 * surface tight. If a user needs them, they can use bash directly.
 */
export class GitDiffTool extends Tool<z.infer<typeof GitDiffArgs>> {
  name = 'git_diff';
  description = 'Show git diff for unstaged / staged / all changes, or for a specific commit. Truncates very large diffs to ~80KB. Use mode="stat" for a quick overview, "patch" (default) for full content, or "name-only" to just list changed files. Read-only.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = GitDiffArgs;

  async execute(args: z.infer<typeof GitDiffArgs>, ctx: ToolContext): Promise<ToolResult> {
    if (!await isGitRepo(ctx.cwd, ctx.signal)) {
      return { content: '[NOT_A_GIT_REPO] Current directory is not inside a git working tree.', isError: true };
    }
    if (args.scope === 'commit' && !args.ref) {
      return { content: '[INVALID_ARGS] scope="commit" requires `ref` (commit SHA, branch, or HEAD~N).', isError: true };
    }

    const mode = args.mode ?? 'patch';
    const maxBytes = args.max_bytes ?? 80_000;

    let gitArgs: string[];
    if (args.scope === 'commit') {
      gitArgs = ['show', '--format=', args.ref!];
    } else if (args.scope === 'staged') {
      gitArgs = ['diff', '--cached'];
    } else if (args.scope === 'all') {
      gitArgs = ['diff', 'HEAD'];
    } else {
      gitArgs = ['diff'];
    }

    if (mode === 'stat') gitArgs.push('--stat');
    else if (mode === 'name-only') gitArgs.push('--name-only');

    if (args.paths && args.paths.length > 0) {
      gitArgs.push('--');
      gitArgs.push(...args.paths);
    }

    const r = await git(gitArgs, { cwd: ctx.cwd, signal: ctx.signal });
    if (r.exitCode !== 0) {
      return { content: `[ERROR] ${r.stderr.trim() || r.stdout.trim()}`, isError: true };
    }

    let out = r.stdout;
    if (out.trim() === '') {
      return { content: `[NO_CHANGES] No diff for scope=${args.scope}${args.ref ? ` ref=${args.ref}` : ''}.` };
    }

    let truncatedNote = '';
    if (out.length > maxBytes) {
      out = out.slice(0, maxBytes);
      const lastNewline = out.lastIndexOf('\n');
      if (lastNewline > 0) out = out.slice(0, lastNewline);
      truncatedNote = `\n\n[...truncated at ${maxBytes} bytes. Re-run with smaller --paths to see the rest of a specific file.]`;
    }

    return {
      content: out + truncatedNote,
      metadata: { scope: args.scope, mode, bytes: r.stdout.length, truncated: truncatedNote !== '' },
    };
  }
}
