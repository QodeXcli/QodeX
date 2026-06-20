/**
 * `smart_diff` — contextual diff between two files (or git ranges).
 *
 * Wraps `git diff` with:
 *   - Color-coded output (ANSI in terminal, kept plain in tool result)
 *   - File-mode awareness (binary, deletions, renames)
 *   - Per-hunk context expansion
 *   - Optional explanation hints (heuristic categorization of each hunk:
 *     "logic change", "formatting only", "import shuffle", "comment-only")
 *
 * Modes:
 *   - left + right paths → file-vs-file diff
 *   - git_ref (single)   → that ref vs HEAD
 *   - git_ref_a + git_ref_b → ref-to-ref
 *   - omit everything    → HEAD vs working tree (uncommitted changes)
 */

import { z } from 'zod';
import { promises as fs } from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { Tool, type ToolContext, type ToolResult } from '../base.js';

const SmartDiffArgs = z.object({
  left: z.string().optional().describe('Left-side file path (relative to cwd or absolute).'),
  right: z.string().optional().describe('Right-side file path.'),
  git_ref: z.string().optional().describe('Single git ref to diff vs HEAD (e.g. "main", "HEAD~3", "v1.0.0").'),
  git_ref_a: z.string().optional().describe('Diff between two refs: base. Use with git_ref_b.'),
  git_ref_b: z.string().optional().describe('Diff between two refs: target.'),
  path_filter: z.string().optional().describe('Restrict diff to this path/glob (when using git mode).'),
  context_lines: z.number().int().min(0).max(20).optional().describe('Lines of context around each hunk. Default 3.'),
  categorize_hunks: z.boolean().optional().describe('Annotate each hunk with heuristic category (logic/formatting/imports/comments-only). Default true.'),
});

function runGit(cwd: string, args: string[]): { exitCode: number; stdout: string; stderr: string } {
  try {
    const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf-8', timeout: 15_000, maxBuffer: 50 * 1024 * 1024 });
    return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  } catch (e: any) {
    return { exitCode: 127, stdout: '', stderr: `git failed: ${e?.message ?? e}` };
  }
}

type HunkCategory = 'logic' | 'formatting' | 'imports' | 'comments' | 'mixed' | 'empty';

function categorizeHunk(hunkLines: string[]): HunkCategory {
  const adds = hunkLines.filter(l => l.startsWith('+') && !l.startsWith('+++'));
  const dels = hunkLines.filter(l => l.startsWith('-') && !l.startsWith('---'));
  if (adds.length === 0 && dels.length === 0) return 'empty';

  const all = [...adds, ...dels].map(l => l.slice(1));

  // Imports-only: every changed line looks like an import statement
  const importRe = /^\s*(import\b|from\b.+import|require\(|use\s+|using\s+|#include\s+)/;
  if (all.every(l => l.trim() === '' || importRe.test(l))) return 'imports';

  // Comments-only: every changed line is whitespace or a comment
  const commentRe = /^\s*(\/\/|\/\*|\*|#|--|<!--)/;
  if (all.every(l => l.trim() === '' || commentRe.test(l))) return 'comments';

  // Formatting-only heuristic: if every removed line has a matching added line that's
  // identical after stripping whitespace, it's formatting (reindent/wrap).
  if (adds.length === dels.length && adds.length > 0) {
    const formattingOnly = adds.every((a, i) => {
      const an = a.slice(1).replace(/\s+/g, ' ').trim();
      const dn = (dels[i] ?? '').slice(1).replace(/\s+/g, ' ').trim();
      return an === dn;
    });
    if (formattingOnly) return 'formatting';
  }

  // Mixed if both logic and other categories appear
  const hasCommentChanges = all.some(l => commentRe.test(l));
  const hasLogicChanges = all.some(l => !commentRe.test(l) && !importRe.test(l) && l.trim() !== '');
  if (hasLogicChanges && hasCommentChanges) return 'mixed';

  return 'logic';
}

function splitIntoHunks(diff: string): { header: string; hunks: { range: string; body: string[] }[] }[] {
  const fileBlocks: { header: string; hunks: { range: string; body: string[] }[] }[] = [];
  const lines = diff.split('\n');
  let currentFile: { header: string; hunks: { range: string; body: string[] }[] } | null = null;
  let currentHunk: { range: string; body: string[] } | null = null;

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (currentFile) {
        if (currentHunk) currentFile.hunks.push(currentHunk);
        fileBlocks.push(currentFile);
      }
      currentFile = { header: line, hunks: [] };
      currentHunk = null;
    } else if (line.startsWith('@@')) {
      if (currentHunk && currentFile) currentFile.hunks.push(currentHunk);
      currentHunk = { range: line, body: [] };
    } else if (currentHunk) {
      currentHunk.body.push(line);
    } else if (currentFile) {
      currentFile.header += '\n' + line;
    }
  }
  if (currentFile) {
    if (currentHunk) currentFile.hunks.push(currentHunk);
    fileBlocks.push(currentFile);
  }
  return fileBlocks;
}

export class SmartDiffTool extends Tool<z.infer<typeof SmartDiffArgs>> {
  name = 'smart_diff';
  description = 'Diff between two files, two git refs, a ref vs HEAD, or uncommitted changes. Annotates each hunk with category (logic/formatting/imports/comments) so you can quickly tell which hunks need close review. Read-only.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = SmartDiffArgs;

  async execute(args: z.infer<typeof SmartDiffArgs>, ctx: ToolContext): Promise<ToolResult> {
    const ctxLines = args.context_lines ?? 3;
    const categorize = args.categorize_hunks !== false;
    let diff = '';
    let mode = '';

    if (args.left && args.right) {
      const leftAbs = path.isAbsolute(args.left) ? args.left : path.join(ctx.cwd, args.left);
      const rightAbs = path.isAbsolute(args.right) ? args.right : path.join(ctx.cwd, args.right);
      mode = `file-vs-file: ${args.left} ↔ ${args.right}`;
      // Use git diff --no-index even outside a repo
      const r = runGit(ctx.cwd, ['diff', '--no-index', `--unified=${ctxLines}`, leftAbs, rightAbs]);
      // --no-index returns exit 1 on differences (not an error)
      if (r.exitCode > 1) return { content: `[SMART_DIFF_ERROR] ${r.stderr.trim()}`, isError: true };
      diff = r.stdout;
    } else if (args.git_ref_a && args.git_ref_b) {
      mode = `git: ${args.git_ref_a}..${args.git_ref_b}`;
      const gitArgs = ['diff', `--unified=${ctxLines}`, `${args.git_ref_a}..${args.git_ref_b}`];
      if (args.path_filter) gitArgs.push('--', args.path_filter);
      const r = runGit(ctx.cwd, gitArgs);
      if (r.exitCode !== 0) return { content: `[SMART_DIFF_ERROR] ${r.stderr.trim()}`, isError: true };
      diff = r.stdout;
    } else if (args.git_ref) {
      mode = `git: ${args.git_ref} vs HEAD`;
      const gitArgs = ['diff', `--unified=${ctxLines}`, args.git_ref, 'HEAD'];
      if (args.path_filter) gitArgs.push('--', args.path_filter);
      const r = runGit(ctx.cwd, gitArgs);
      if (r.exitCode !== 0) return { content: `[SMART_DIFF_ERROR] ${r.stderr.trim()}`, isError: true };
      diff = r.stdout;
    } else {
      mode = `git: HEAD vs working tree (uncommitted)`;
      const gitArgs = ['diff', 'HEAD', `--unified=${ctxLines}`];
      if (args.path_filter) gitArgs.push('--', args.path_filter);
      const r = runGit(ctx.cwd, gitArgs);
      if (r.exitCode !== 0) return { content: `[SMART_DIFF_ERROR] ${r.stderr.trim()}`, isError: true };
      diff = r.stdout;
    }

    if (!diff.trim()) {
      return { content: `[SMART_DIFF] No differences.\nMode: ${mode}`, metadata: { mode, fileCount: 0 } };
    }

    if (!categorize) {
      return { content: `# smart_diff (${mode})\n\n${diff}`, metadata: { mode } };
    }

    // Categorize hunks
    const fileBlocks = splitIntoHunks(diff);
    const out: string[] = [`# smart_diff (${mode})`, ''];

    // Summary first
    const totalsByCat: Record<HunkCategory, number> = { logic: 0, formatting: 0, imports: 0, comments: 0, mixed: 0, empty: 0 };
    for (const fb of fileBlocks) {
      for (const h of fb.hunks) {
        totalsByCat[categorizeHunk(h.body)]++;
      }
    }
    out.push(`## Summary across ${fileBlocks.length} file(s):`);
    out.push(`  Logic changes:       ${totalsByCat.logic}`);
    if (totalsByCat.mixed > 0)      out.push(`  Mixed hunks:         ${totalsByCat.mixed}`);
    if (totalsByCat.imports > 0)    out.push(`  Imports-only:        ${totalsByCat.imports}`);
    if (totalsByCat.formatting > 0) out.push(`  Formatting-only:     ${totalsByCat.formatting}`);
    if (totalsByCat.comments > 0)   out.push(`  Comments-only:       ${totalsByCat.comments}`);
    out.push('');

    // Per-file detail
    for (const fb of fileBlocks) {
      out.push(`### ${fb.header.split('\n')[0]}`);
      for (const h of fb.hunks) {
        const cat = categorizeHunk(h.body);
        const tag = cat === 'logic' ? '🟠 LOGIC' :
                    cat === 'mixed' ? '🟡 MIXED' :
                    cat === 'imports' ? '🔵 IMPORTS' :
                    cat === 'formatting' ? '⚪ FORMAT' :
                    cat === 'comments' ? '⚪ COMMENTS' : '∅';
        out.push(`  ${h.range}  ${tag}`);
        for (const l of h.body.slice(0, 80)) out.push(`    ${l}`);
        if (h.body.length > 80) out.push(`    …${h.body.length - 80} more line(s)`);
      }
      out.push('');
    }
    return {
      content: out.join('\n'),
      metadata: { mode, fileCount: fileBlocks.length, totalsByCat },
    };
  }
}
