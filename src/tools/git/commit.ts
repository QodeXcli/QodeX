import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { git, isGitRepo } from './git-runner.js';

const GitCommitArgs = z.object({
  message: z.string().min(1).describe('The commit message. Multi-line is supported — first line is the subject.'),
  stage_all: z.boolean().optional().describe('If true, run `git add -u` first (stages modifications & deletions, but NOT untracked files). Default false.'),
  paths: z.array(z.string()).optional().describe('Explicitly stage these paths before committing. Use this to commit a focused subset rather than everything.'),
  amend: z.boolean().optional().describe('Amend the previous commit instead of creating a new one. Be careful — rewrites history.'),
  allow_empty: z.boolean().optional().describe('Permit empty commits (rarely useful — usually a mistake)'),
  sign_off: z.boolean().optional().describe('Add a Signed-off-by trailer'),
});

/**
 * Create a git commit.
 *
 * Safety stance:
 *   - Refuses to commit when there's nothing staged (unless allow_empty=true).
 *   - Message is passed via stdin (`-F -`), never on the command line. That avoids
 *     argv length limits AND shell-escaping bugs (multi-line messages, quotes, $vars
 *     in commit message would all be wrong if we tried to interpolate).
 *   - `--no-verify` is NOT passed. Pre-commit hooks run normally — if they fail, the
 *     model sees the failure and adapts.
 *   - We never push. That's a separate explicit step the user can request.
 *
 * Destructive: yes (creates a permanent commit object). Permission engine should prompt
 * unless the session is in bypass mode.
 */
export class GitCommitTool extends Tool<z.infer<typeof GitCommitArgs>> {
  name = 'git_commit';
  description = 'Create a git commit. Optionally stage paths first. Refuses to commit when nothing is staged. Never pushes. Pre-commit hooks run normally. Destructive — creates a permanent commit object.';
  isReadOnly = false;
  isDestructive = true;
  argsSchema = GitCommitArgs;

  async execute(args: z.infer<typeof GitCommitArgs>, ctx: ToolContext): Promise<ToolResult> {
    if (!await isGitRepo(ctx.cwd, ctx.signal)) {
      return { content: '[NOT_A_GIT_REPO] Current directory is not inside a git working tree.', isError: true };
    }

    // Stage if requested
    if (args.paths && args.paths.length > 0) {
      const addR = await git(['add', '--', ...args.paths], { cwd: ctx.cwd, signal: ctx.signal });
      if (addR.exitCode !== 0) {
        return { content: `[ERROR] git add failed: ${addR.stderr.trim()}`, isError: true };
      }
    } else if (args.stage_all) {
      const addR = await git(['add', '-u'], { cwd: ctx.cwd, signal: ctx.signal });
      if (addR.exitCode !== 0) {
        return { content: `[ERROR] git add -u failed: ${addR.stderr.trim()}`, isError: true };
      }
    }

    // Safety: bail if nothing staged (unless amending or empty allowed)
    if (!args.amend && !args.allow_empty) {
      const stagedR = await git(['diff', '--cached', '--quiet'], { cwd: ctx.cwd, signal: ctx.signal });
      // diff --cached --quiet exits 0 when no diff, 1 when there's a diff
      if (stagedR.exitCode === 0) {
        return {
          content: '[NOTHING_STAGED] No changes are staged for commit. ' +
            'Use `paths` or `stage_all=true` to stage first, or call `git_status` to inspect the working tree.',
          isError: true,
        };
      }
    }

    // Build commit args
    const commitArgs = ['commit', '-F', '-'];
    if (args.amend) commitArgs.push('--amend');
    if (args.allow_empty) commitArgs.push('--allow-empty');
    if (args.sign_off) commitArgs.push('--signoff');

    const r = await git(commitArgs, {
      cwd: ctx.cwd,
      signal: ctx.signal,
      stdin: args.message,
      timeoutMs: 120_000, // pre-commit hooks can take a while
    });

    if (r.exitCode !== 0) {
      // Pre-commit hook failure or other reason — bubble both streams so the model sees lint output
      return {
        content: `[COMMIT_FAILED] git commit exited ${r.exitCode}.\n${r.stderr.trim()}\n${r.stdout.trim()}`.trim(),
        isError: true,
      };
    }

    // Fetch the resulting commit SHA + subject for the result
    const showR = await git(['log', '-1', '--pretty=format:%h%x00%s'], { cwd: ctx.cwd, signal: ctx.signal });
    let summary = r.stdout.trim();
    if (showR.exitCode === 0 && showR.stdout) {
      const [sha, subject] = showR.stdout.split('\x00');
      summary = `Created commit ${sha}: ${subject}`;
    }

    return {
      content: summary,
      metadata: { amended: !!args.amend },
    };
  }
}
