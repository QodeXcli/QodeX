import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { git, isGitRepo } from './git-runner.js';

const GitStatusArgs = z.object({
  show_untracked: z.boolean().optional().describe('Include untracked files (default true)'),
});

/**
 * Compact, model-friendly git status. Uses `--porcelain=v2 --branch` for stable parsing.
 *
 * Output shape (deterministic, sorted by section):
 *
 *   Branch: feat/x  ahead 2 behind 0  upstream origin/feat/x
 *
 *   Staged:
 *     A   src/new.ts
 *     M   src/existing.ts
 *
 *   Unstaged:
 *     M   src/another.ts
 *
 *   Untracked:
 *     ??  docs/draft.md
 *
 *   Total: 4 file(s)
 */
export class GitStatusTool extends Tool<z.infer<typeof GitStatusArgs>> {
  name = 'git_status';
  description = 'Show the current git status: branch + upstream tracking + staged / unstaged / untracked files. Use this before any commit or diff to understand the working-tree state. Read-only.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = GitStatusArgs;

  async execute(args: z.infer<typeof GitStatusArgs>, ctx: ToolContext): Promise<ToolResult> {
    if (!await isGitRepo(ctx.cwd, ctx.signal)) {
      return { content: '[NOT_A_GIT_REPO] Current directory is not inside a git working tree.', isError: true };
    }
    const showUntracked = args.show_untracked ?? true;
    const flags = ['status', '--porcelain=v2', '--branch'];
    if (!showUntracked) flags.push('--untracked-files=no');

    const r = await git(flags, { cwd: ctx.cwd, signal: ctx.signal });
    if (r.exitCode !== 0) {
      return { content: `[ERROR] ${r.stderr.trim() || r.stdout.trim()}`, isError: true };
    }

    let branch = '(detached)';
    let upstream: string | null = null;
    let ahead = 0;
    let behind = 0;
    const staged: string[] = [];
    const unstaged: string[] = [];
    const untracked: string[] = [];
    const unmerged: string[] = [];

    for (const raw of r.stdout.split('\n')) {
      if (!raw) continue;
      // # branch.head <name>
      if (raw.startsWith('# branch.head ')) {
        branch = raw.slice('# branch.head '.length).trim();
        continue;
      }
      // # branch.upstream <name>
      if (raw.startsWith('# branch.upstream ')) {
        upstream = raw.slice('# branch.upstream '.length).trim();
        continue;
      }
      // # branch.ab +<ahead> -<behind>
      if (raw.startsWith('# branch.ab ')) {
        const parts = raw.slice('# branch.ab '.length).split(' ');
        ahead = Math.abs(parseInt(parts[0] ?? '0', 10) || 0);
        behind = Math.abs(parseInt(parts[1] ?? '0', 10) || 0);
        continue;
      }
      // "1 XY ..." = changed; "2 XY ..." = renamed/copied; "u XY ..." = unmerged; "? path" = untracked
      const kind = raw[0];
      if (kind === '?') {
        untracked.push(`??  ${raw.slice(2)}`);
        continue;
      }
      if (kind === '!') continue; // ignored
      if (kind === '1' || kind === '2') {
        // Format: 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
        const segs = raw.split(' ');
        const xy = segs[1] ?? '..';
        const x = xy[0]!;
        const y = xy[1]!;
        // For rename/copy, path is the last two-space-separated fields joined by tab
        const path = kind === '2' ? (segs[9] ?? '') : (segs[8] ?? '');
        if (x !== '.') staged.push(`${x}   ${path}`);
        if (y !== '.') unstaged.push(`${y}   ${path}`);
        continue;
      }
      if (kind === 'u') {
        const segs = raw.split(' ');
        const path = segs[10] ?? '';
        unmerged.push(`UU  ${path}`);
        continue;
      }
    }

    const lines: string[] = [];
    const branchInfo = upstream
      ? `Branch: ${branch}  ahead ${ahead} behind ${behind}  upstream ${upstream}`
      : `Branch: ${branch}  (no upstream)`;
    lines.push(branchInfo);

    const sections: Array<[string, string[]]> = [
      ['Staged', staged],
      ['Unstaged', unstaged],
      ['Unmerged (conflicts)', unmerged],
      ['Untracked', untracked],
    ];
    let total = 0;
    for (const [name, items] of sections) {
      if (items.length === 0) continue;
      lines.push('');
      lines.push(`${name}:`);
      // Cap each section at 50 to avoid context bloat on huge changesets
      for (const it of items.slice(0, 50)) lines.push(`  ${it}`);
      if (items.length > 50) lines.push(`  ... [+${items.length - 50} more]`);
      total += items.length;
    }
    if (total === 0) {
      lines.push('');
      lines.push('Working tree clean.');
    } else {
      lines.push('');
      lines.push(`Total: ${total} file(s)`);
    }

    return {
      content: lines.join('\n'),
      metadata: { branch, upstream, ahead, behind, staged: staged.length, unstaged: unstaged.length, untracked: untracked.length, unmerged: unmerged.length },
    };
  }
}
