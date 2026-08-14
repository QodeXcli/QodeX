import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { git, isGitRepo } from './git-runner.js';

const GitStatusArgs = z.object({
  show_untracked: z.boolean().optional().describe('Include untracked files (default true)'),
});

/** Everything after the Nth ASCII space — so a path with spaces is not chopped. */
export function restAfterNthSpace(s: string, n: number): string {
  let seen = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ' ') {
      seen++;
      if (seen === n) return s.slice(i + 1);
    }
  }
  return '';
}

export type PorcelainLine =
  | { kind: 'head'; value: string }
  | { kind: 'upstream'; value: string }
  | { kind: 'ab'; ahead: number; behind: number }
  | { kind: 'untracked'; path: string }
  | { kind: 'changed'; x: string; y: string; path: string }
  | { kind: 'unmerged'; path: string };

/**
 * Parse one `git status --porcelain=v2 --branch` line.
 * The old `split(' ')[8]` parser dropped everything after the first space in a
 * path (`src/My File.ts` → `src/My`), which made status/commit tools miss files.
 */
export function parsePorcelainV2Line(raw: string): PorcelainLine | null {
  if (!raw) return null;
  if (raw.startsWith('# branch.head ')) return { kind: 'head', value: raw.slice('# branch.head '.length).trim() };
  if (raw.startsWith('# branch.upstream ')) return { kind: 'upstream', value: raw.slice('# branch.upstream '.length).trim() };
  if (raw.startsWith('# branch.ab ')) {
    const parts = raw.slice('# branch.ab '.length).split(' ');
    return {
      kind: 'ab',
      ahead: Math.abs(parseInt(parts[0] ?? '0', 10) || 0),
      behind: Math.abs(parseInt(parts[1] ?? '0', 10) || 0),
    };
  }
  const kind = raw[0];
  if (kind === '?') return { kind: 'untracked', path: raw.slice(2) };
  if (kind === '!') return null;
  if (kind === '1' || kind === '2') {
    const xy = raw.split(' ', 3)[1] ?? '..';
    const x = xy[0] ?? '.';
    const y = xy[1] ?? '.';
    // 1: 8 fields then path. 2 (rename): 9 fields then `path\torigPath`.
    const rest = restAfterNthSpace(raw, kind === '2' ? 9 : 8);
    const path = kind === '2' ? (rest.split('\t')[0] ?? rest) : rest;
    return { kind: 'changed', x, y, path };
  }
  if (kind === 'u') {
    return { kind: 'unmerged', path: restAfterNthSpace(raw, 10) };
  }
  return null;
}

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
      const parsed = parsePorcelainV2Line(raw);
      if (!parsed) continue;
      if (parsed.kind === 'head') { branch = parsed.value; continue; }
      if (parsed.kind === 'upstream') { upstream = parsed.value; continue; }
      if (parsed.kind === 'ab') { ahead = parsed.ahead; behind = parsed.behind; continue; }
      if (parsed.kind === 'untracked') { untracked.push(`??  ${parsed.path}`); continue; }
      if (parsed.kind === 'changed') {
        if (parsed.x !== '.') staged.push(`${parsed.x}   ${parsed.path}`);
        if (parsed.y !== '.') unstaged.push(`${parsed.y}   ${parsed.path}`);
        continue;
      }
      if (parsed.kind === 'unmerged') { unmerged.push(`UU  ${parsed.path}`); continue; }
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
