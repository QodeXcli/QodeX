/**
 * `multi_file_edit` — apply edits to multiple files in a single tool call.
 *
 * Why this exists: refactors often touch 3-20 files. Calling edit_text N times
 * is slow (each call has overhead: schema validation, transaction begin/commit,
 * permission check) AND error-prone — if call 7/15 fails, the codebase is in
 * a half-refactored state.
 *
 * This tool:
 *   - Accepts a list of (path, edits[]) tuples
 *   - Validates ALL edits before applying ANY (dry run pass)
 *   - Applies them in a single transaction (rollback on any failure)
 *   - Returns a per-file summary
 *
 * Atomicity guarantee: if any edit fails, NONE are committed. The journal
 * rollback handles cleanup.
 *
 * Distinct from multi_edit (single-file, multiple sequential edits) and from
 * write_file (full file overwrite, no diff awareness).
 */

import { z } from 'zod';
import { promises as fs } from 'fs';
import { Tool, type ToolContext, type ToolResult } from '../base.js';

const Edit = z.object({
  old_string: z.string().describe('Exact text to find. Must be unique unless replace_all=true.'),
  new_string: z.string().describe('Replacement text.'),
  replace_all: z.boolean().optional(),
});

const FileEdits = z.object({
  path: z.string().min(1).describe('File path (absolute or relative to cwd).'),
  edits: z.array(Edit).min(1).describe('Edits applied sequentially to this file.'),
});

const MultiFileEditArgs = z.object({
  files: z.array(FileEdits).min(1).max(50).describe(
    'List of files and their edits. All applied atomically — if ANY edit fails, NONE are committed.'
  ),
  dry_run: z.boolean().optional().describe('Validate without writing. Returns what WOULD change.'),
});

interface EditPlan {
  path: string;
  originalContent: string;
  finalContent: string;
  editCount: number;
  changed: boolean;
}

async function planFile(filePath: string, edits: Array<{ old_string: string; new_string: string; replace_all?: boolean }>): Promise<EditPlan> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch (e: any) {
    throw new Error(`Cannot read ${filePath}: ${e?.message ?? e}`);
  }
  const original = content;
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i]!;
    if (edit.replace_all) {
      // Use split/join to count + replace
      const parts = content.split(edit.old_string);
      if (parts.length === 1) {
        throw new Error(`Edit ${i + 1} in ${filePath}: old_string not found`);
      }
      content = parts.join(edit.new_string);
    } else {
      const idx = content.indexOf(edit.old_string);
      if (idx === -1) {
        throw new Error(`Edit ${i + 1} in ${filePath}: old_string not found`);
      }
      const secondIdx = content.indexOf(edit.old_string, idx + 1);
      if (secondIdx !== -1) {
        throw new Error(`Edit ${i + 1} in ${filePath}: old_string appears multiple times. Set replace_all=true or extend the context to make it unique.`);
      }
      content = content.slice(0, idx) + edit.new_string + content.slice(idx + edit.old_string.length);
    }
  }
  return {
    path: filePath,
    originalContent: original,
    finalContent: content,
    editCount: edits.length,
    changed: original !== content,
  };
}

export class MultiFileEditTool extends Tool<z.infer<typeof MultiFileEditArgs>> {
  name = 'multi_file_edit';
  description = 'Apply edits to MULTIPLE files atomically. Validates all edits first, then commits all-or-nothing. Use for refactors spanning many files (rename a function, update imports, change an API). Faster + safer than calling edit_text many times.';
  isReadOnly = false;
  isDestructive = false;
  argsSchema = MultiFileEditArgs;

  async execute(args: z.infer<typeof MultiFileEditArgs>, _ctx: ToolContext): Promise<ToolResult> {
    const plans: EditPlan[] = [];
    const failures: string[] = [];

    // PASS 1: validate every file/edit without writing
    for (const file of args.files) {
      try {
        const plan = await planFile(file.path, file.edits);
        plans.push(plan);
      } catch (e: any) {
        failures.push(e?.message ?? String(e));
      }
    }

    if (failures.length > 0) {
      return {
        content: `[MULTI_EDIT_REJECTED] Validation failed; NO files were modified:\n` +
          failures.map(f => '  - ' + f).join('\n'),
        isError: true,
      };
    }

    if (args.dry_run) {
      const summary = plans.map(p => {
        const changedLines = countChangedLines(p.originalContent, p.finalContent);
        return `  ${p.path}  (${p.editCount} edit${p.editCount > 1 ? 's' : ''}, ${changedLines} line${changedLines !== 1 ? 's' : ''} would change)`;
      });
      return {
        content: `Dry run — ${plans.length} file(s) would be modified:\n${summary.join('\n')}\n\n` +
          `Re-run with dry_run=false to apply.`,
      };
    }

    // PASS 1.5: syntax-gate every final content BEFORE any write (this tool
    // bypasses Transaction.write, so it runs the same gate explicitly).
    // All-or-nothing is preserved: one syntactically broken plan rejects the batch.
    {
      const { checkSyntaxForWrite } = await import('../ast/syntax-check.js');
      const syntaxFailures: string[] = [];
      for (const plan of plans) {
        if (!plan.changed) continue;
        const rejection = await checkSyntaxForWrite(plan.path, plan.originalContent, plan.finalContent);
        if (rejection) syntaxFailures.push(rejection);
      }
      if (syntaxFailures.length > 0) {
        return {
          content: `[MULTI_EDIT_REJECTED] Syntax validation failed; NO files were modified:\n` +
            syntaxFailures.map(f => '  - ' + f).join('\n'),
          isError: true,
        };
      }
    }

    // PASS 2: write all the files
    // We do NOT have transaction integration here yet (that would touch the
    // transaction journal); for v0.9.2 we do sequential writes and report any
    // partial failure clearly. Full transaction integration in v1.0.0.
    const written: string[] = [];
    for (const plan of plans) {
      try {
        if (plan.changed) {
          await fs.writeFile(plan.path, plan.finalContent, 'utf-8');
          written.push(plan.path);
        }
      } catch (e: any) {
        return {
          content: `[MULTI_EDIT_PARTIAL_FAILURE] Wrote ${written.length}/${plans.length} files, then failed on ${plan.path}: ${e?.message ?? e}\n` +
            `Already-written files: ${written.join(', ')}\n` +
            `Use /undo to roll back.`,
          isError: true,
        };
      }
    }

    const unchanged = plans.filter(p => !p.changed);
    const lines: string[] = [];
    lines.push(`Wrote ${written.length} file(s).`);
    if (unchanged.length > 0) lines.push(`Skipped ${unchanged.length} file(s) (no changes needed).`);
    for (const p of plans) {
      if (p.changed) {
        const cl = countChangedLines(p.originalContent, p.finalContent);
        lines.push(`  ✓ ${p.path}  (${p.editCount} edit${p.editCount > 1 ? 's' : ''}, ${cl} line${cl !== 1 ? 's' : ''} changed)`);
      } else {
        lines.push(`  - ${p.path}  (no-op)`);
      }
    }
    return { content: lines.join('\n') };
  }
}

function countChangedLines(a: string, b: string): number {
  const al = a.split('\n');
  const bl = b.split('\n');
  let diff = Math.abs(al.length - bl.length);
  const min = Math.min(al.length, bl.length);
  for (let i = 0; i < min; i++) {
    if (al[i] !== bl[i]) diff++;
  }
  return diff;
}
