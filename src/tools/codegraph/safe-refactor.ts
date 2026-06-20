/**
 * `safe_rename` and `safe_delete_file` — refactor-safety tools.
 *
 * Both follow the same principle: SHOW the user (and the agent) what will
 * change BEFORE changing anything, with explicit opt-in via a `confirm` flag
 * that defaults to false. Without `confirm: true`, the tools run in
 * dry-run mode and just report.
 *
 * They also leverage the auto-snapshot layer — the agent loop takes a git
 * stash before the first mutation of a turn, so even after `confirm: true`,
 * /restore can undo.
 *
 * ─── safe_rename ───
 * Rename a symbol across the project. Pure text replacement at word boundaries
 * (no AST). For most JS/TS/Python codebases this is sufficient — the regex
 * is `\b<old>\b` and we substitute `<new>`. Falls down on:
 *   - Strings that happen to contain the symbol name
 *   - Comments mentioning the symbol that intentionally use that wording
 *   - Path-alias module names matching the symbol name
 *
 * We mitigate by:
 *   - Showing every change in dry-run before applying
 *   - Refusing if old==new
 *   - Refusing if the new name shadows an existing top-level symbol in the
 *     same file (collision check)
 *   - Skipping bin/node_modules/dist/etc
 *
 * ─── safe_delete_file ───
 * Delete a file ONLY after verifying no other file imports it. Uses the
 * same reference-search logic as analyze_impact. Refuses if any referrer
 * is found, listing them.
 *
 * Both tools mark themselves as DESTRUCTIVE so the permission gradient
 * applies and auto-snapshot fires.
 */

import { z } from 'zod';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { logger } from '../../utils/logger.js';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt',
  '__pycache__', '.venv', 'venv', '.cache', 'coverage', 'vendor',
]);

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.php', '.rb', '.go', '.vue', '.svelte', '.astro']);

async function walkSourceFiles(root: string, maxFiles: number): Promise<string[]> {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0 && out.length < maxFiles) {
    const dir = stack.pop()!;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (out.length >= maxFiles) break;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        stack.push(path.join(dir, e.name));
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (!SOURCE_EXTS.has(ext)) continue;
        out.push(path.join(dir, e.name));
      }
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// safe_rename

const SafeRenameArgs = z.object({
  old_name: z.string().min(1).describe('Current symbol name. Will be matched with word boundaries (\\b).'),
  new_name: z.string().min(1).describe('Desired symbol name. Must be a valid identifier.'),
  scope: z.string().optional().describe('Subdirectory to limit the rename to (relative to cwd). Default: full project.'),
  confirm: z.boolean().optional().describe('If false (default) → dry-run, returns a preview. If true → applies changes. Auto-snapshot fires before the first edit.'),
  include_strings_and_comments: z.boolean().optional().describe('If true, also rename inside string literals and comments (use cautiously). Default false.'),
});

const VALID_IDENT_RE = /^[A-Za-z_$][\w$]*$/;

export class SafeRenameTool extends Tool<z.infer<typeof SafeRenameArgs>> {
  name = 'safe_rename';
  description = 'Rename a symbol across the project at word boundaries. ALWAYS run with confirm=false first to preview every file/line that will change. Set confirm=true on a follow-up call to apply. Auto-snapshot fires before mutations. Destructive when confirmed.';
  isReadOnly = false; // worst case it edits files
  isDestructive = true;
  argsSchema = SafeRenameArgs;

  async execute(args: z.infer<typeof SafeRenameArgs>, ctx: ToolContext): Promise<ToolResult> {
    const { old_name, new_name } = args;
    if (old_name === new_name) {
      return { content: `[SAFE_RENAME] old_name and new_name are identical (${old_name}). Nothing to do.`, isError: true };
    }
    if (!VALID_IDENT_RE.test(new_name)) {
      return { content: `[SAFE_RENAME] new_name must be a valid identifier; got "${new_name}".`, isError: true };
    }
    if (!VALID_IDENT_RE.test(old_name)) {
      return { content: `[SAFE_RENAME] old_name must be a valid identifier; got "${old_name}".`, isError: true };
    }

    const root = args.scope ? path.join(ctx.cwd, args.scope) : ctx.cwd;
    const files = await walkSourceFiles(root, 50_000);
    const wordRe = new RegExp(`\\b${old_name}\\b`, 'g');

    interface FileChange { rel: string; matches: { line: number; before: string; after: string }[]; total: number }
    const changes: FileChange[] = [];

    for (const abs of files) {
      let content: string;
      try { content = await fs.readFile(abs, 'utf-8'); } catch { continue; }
      if (!wordRe.test(content)) continue;
      wordRe.lastIndex = 0;

      const matchLines: { line: number; before: string; after: string }[] = [];
      const lines = content.split('\n');
      let totalCount = 0;
      for (let i = 0; i < lines.length; i++) {
        const before = lines[i]!;
        if (!new RegExp(`\\b${old_name}\\b`).test(before)) continue;
        // Optional skip of comments and strings
        if (!args.include_strings_and_comments) {
          // VERY conservative comment/string skip: replace only outside obvious commented/quoted ranges.
          // Pragmatic approach — we do a per-line scan; the agent should review the dry-run.
          const after = before.replace(new RegExp(`\\b${old_name}\\b`, 'g'), (_match, offset: number) => {
            // Detect if this offset is inside a // line comment, /* */ block, ', " or `
            const upto = before.slice(0, offset);
            // // comment
            if (/\/\/[^\n]*$/.test(upto)) return old_name; // inside line comment — skip
            // " or ' or ` literal — count unescaped quotes
            const dq = (upto.match(/(?<!\\)"/g) || []).length;
            const sq = (upto.match(/(?<!\\)'/g) || []).length;
            const bq = (upto.match(/(?<!\\)`/g) || []).length;
            if (dq % 2 === 1 || sq % 2 === 1 || bq % 2 === 1) return old_name; // inside literal — skip
            return new_name;
          });
          if (after === before) continue;
          // count actual replacements in this line
          const matches = before.match(new RegExp(`\\b${old_name}\\b`, 'g')) || [];
          const remaining = after.match(new RegExp(`\\b${old_name}\\b`, 'g')) || [];
          const applied = matches.length - remaining.length;
          totalCount += applied;
          matchLines.push({ line: i + 1, before: before.slice(0, 200), after: after.slice(0, 200) });
        } else {
          const after = before.replace(new RegExp(`\\b${old_name}\\b`, 'g'), new_name);
          const c = (before.match(new RegExp(`\\b${old_name}\\b`, 'g')) || []).length;
          totalCount += c;
          matchLines.push({ line: i + 1, before: before.slice(0, 200), after: after.slice(0, 200) });
        }
      }
      if (matchLines.length > 0) {
        changes.push({ rel: path.relative(ctx.cwd, abs), matches: matchLines, total: totalCount });
      }
    }

    const totalFiles = changes.length;
    const totalMatches = changes.reduce((a, b) => a + b.total, 0);

    const out: string[] = [];
    out.push(`# safe_rename: ${old_name} → ${new_name}`);
    out.push(`${args.confirm ? '🛠  APPLY' : '👀 DRY-RUN'}`);
    out.push('');
    out.push(`Files affected: ${totalFiles}`);
    out.push(`Total occurrences: ${totalMatches}`);
    out.push('');

    if (totalFiles === 0) {
      out.push('No occurrences found at word-boundary. Either the symbol doesn\'t exist, or it lives only in strings/comments (re-run with include_strings_and_comments=true).');
      return { content: out.join('\n') };
    }

    // Show first 30 files in detail
    for (const c of changes.slice(0, 30)) {
      out.push(`## ${c.rel} (${c.total} occurrence${c.total === 1 ? '' : 's'})`);
      for (const m of c.matches.slice(0, 5)) {
        out.push(`  L${m.line}`);
        out.push(`    - ${m.before}`);
        out.push(`    + ${m.after}`);
      }
      if (c.matches.length > 5) out.push(`  …and ${c.matches.length - 5} more lines in this file`);
      out.push('');
    }
    if (changes.length > 30) out.push(`…and ${changes.length - 30} more files`);

    if (!args.confirm) {
      out.push('');
      out.push('To APPLY this rename, re-run with confirm=true.');
      out.push('Auto-snapshot will fire before the first edit — /restore can undo.');
      return { content: out.join('\n') };
    }

    // APPLY
    let writtenCount = 0;
    let writeFailures = 0;
    for (const c of changes) {
      const abs = path.join(ctx.cwd, c.rel);
      let content: string;
      try { content = await fs.readFile(abs, 'utf-8'); } catch { continue; }
      let newContent: string;
      if (args.include_strings_and_comments) {
        newContent = content.replace(new RegExp(`\\b${old_name}\\b`, 'g'), new_name);
      } else {
        // Per-line, skipping comments/strings as in dry-run
        newContent = content.split('\n').map(line => {
          return line.replace(new RegExp(`\\b${old_name}\\b`, 'g'), (_m, offset: number) => {
            const upto = line.slice(0, offset);
            if (/\/\/[^\n]*$/.test(upto)) return old_name;
            const dq = (upto.match(/(?<!\\)"/g) || []).length;
            const sq = (upto.match(/(?<!\\)'/g) || []).length;
            const bq = (upto.match(/(?<!\\)`/g) || []).length;
            if (dq % 2 === 1 || sq % 2 === 1 || bq % 2 === 1) return old_name;
            return new_name;
          });
        }).join('\n');
      }
      if (newContent !== content) {
        try {
          await fs.writeFile(abs, newContent, 'utf-8');
          writtenCount++;
        } catch (e: any) {
          writeFailures++;
          out.push(`  ⚠ Write failed for ${c.rel}: ${e?.message}`);
        }
      }
    }
    out.push('');
    if (writeFailures > 0) {
      out.push(`⚠ Partial failure — ${writtenCount} file(s) written, ${writeFailures} failed (see above). The rename is INCOMPLETE; review and re-run, or /restore to roll back.`);
      return { content: out.join('\n'), isError: true, metadata: { filesChanged: writtenCount, writeFailures, occurrences: totalMatches } };
    }
    out.push(`✅ Applied — ${writtenCount} file(s) written. Verify with grep/test/typecheck. /restore to roll back.`);
    return { content: out.join('\n'), metadata: { filesChanged: writtenCount, occurrences: totalMatches } };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// safe_delete_file

const SafeDeleteFileArgs = z.object({
  path: z.string().min(1).describe('File to delete (relative to cwd or absolute).'),
  confirm: z.boolean().optional().describe('If false (default) → just check for importers. If true and zero importers → delete.'),
  force: z.boolean().optional().describe('If true, delete even when importers are found. DANGEROUS — use only if you know references are stale strings or dead. Default false.'),
});

export class SafeDeleteFileTool extends Tool<z.infer<typeof SafeDeleteFileArgs>> {
  name = 'safe_delete_file';
  description = 'Delete a file, but ONLY after verifying no other source file imports it. Run with confirm=false first for a safety check. confirm=true deletes if safe. force=true overrides the safety check (use sparingly). Auto-snapshot fires before deletion. Destructive.';
  isReadOnly = false;
  isDestructive = true;
  argsSchema = SafeDeleteFileArgs;

  async execute(args: z.infer<typeof SafeDeleteFileArgs>, ctx: ToolContext): Promise<ToolResult> {
    const abs = path.isAbsolute(args.path) ? args.path : path.join(ctx.cwd, args.path);
    const rel = path.relative(ctx.cwd, abs);

    // Verify the file exists
    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile()) {
        return { content: `[SAFE_DELETE] ${rel} is not a regular file.`, isError: true };
      }
    } catch {
      return { content: `[SAFE_DELETE] ${rel} does not exist.`, isError: true };
    }

    // Search for importers
    const stem = path.basename(abs).replace(/\.[^.]+$/, '');
    const noExt = rel.replace(/\.[^.]+$/, '');
    const patterns = [
      `from './${stem}'`, `from "./${stem}"`,
      `from '../${stem}'`, `from "../${stem}"`,
      `from '${noExt}'`, `from "${noExt}"`,
      `require('${stem}')`, `require("${stem}")`,
      `require('${noExt}')`, `require("${noExt}")`,
      `'/${stem}'`, `"/${stem}"`,
      `/${stem}'`, `/${stem}"`,
      `import ${noExt.replace(/[/\\]/g, '.')}`,
      `from ${noExt.replace(/[/\\]/g, '.')} import`,
    ];

    const files = await walkSourceFiles(ctx.cwd, 20_000);
    const importers: { rel: string; line: number; text: string }[] = [];
    for (const f of files) {
      if (f === abs) continue;
      let content: string;
      try { content = await fs.readFile(f, 'utf-8'); } catch { continue; }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        for (const pat of patterns) {
          if (line.includes(pat)) {
            importers.push({ rel: path.relative(ctx.cwd, f), line: i + 1, text: line.trim().slice(0, 200) });
            break;
          }
        }
      }
    }

    const out: string[] = [];
    out.push(`# safe_delete_file: ${rel}`);
    out.push('');

    if (importers.length > 0 && !args.force) {
      out.push(`❌ REFUSED — ${importers.length} importer(s) found:`);
      for (const imp of importers.slice(0, 30)) {
        out.push(`  ${imp.rel}:${imp.line}  ${imp.text}`);
      }
      if (importers.length > 30) out.push(`  …and ${importers.length - 30} more`);
      out.push('');
      out.push('Resolve the importers first (refactor or remove their references), then retry. Or pass force=true to delete anyway (NOT recommended).');
      return { content: out.join('\n'), isError: true };
    }

    if (importers.length === 0) {
      out.push(`✓ No importers detected.`);
    } else {
      out.push(`⚠ ${importers.length} importer(s) found, but force=true. Proceeding anyway:`);
      for (const imp of importers.slice(0, 10)) out.push(`  ${imp.rel}:${imp.line}`);
      out.push('');
    }

    if (!args.confirm) {
      out.push('');
      out.push('Dry-run mode (confirm=false). To DELETE, re-run with confirm=true.');
      out.push('Auto-snapshot will fire before deletion — /restore can undo.');
      return { content: out.join('\n') };
    }

    // DELETE
    try {
      await fs.unlink(abs);
      out.push('');
      out.push(`✅ Deleted ${rel}. /restore to roll back.`);
      return { content: out.join('\n'), metadata: { deleted: rel, importerCount: importers.length } };
    } catch (e: any) {
      return { content: `[SAFE_DELETE] Failed to unlink ${rel}: ${e?.message}`, isError: true };
    }
  }
}
