import { z } from 'zod';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { confirmEdit, reviseResult } from './edit-approval.js';

const ArgsSchema = z.object({
  path: z.string().describe('Path to file (absolute or relative)'),
  old_string: z.string().describe('The exact text to find. Must appear EXACTLY ONCE in the file (or use replace_all=true). Include enough surrounding context to be unique.'),
  new_string: z.string().describe('The replacement text'),
  replace_all: z.boolean().optional().describe('Replace ALL occurrences instead of requiring uniqueness. Default false.'),
});

export class EditTextTool extends Tool<z.infer<typeof ArgsSchema>> {
  name = 'edit_text';
  description = 'String-based find-and-replace edit. For named functions/classes/methods PREFER edit_symbol which is AST-safe. Use this for non-code files, imports, or precise text changes. old_string must appear EXACTLY ONCE unless replace_all=true.';
  isReadOnly = false;
  isDestructive = true;
  argsSchema = ArgsSchema;

  async execute(args: z.infer<typeof ArgsSchema>, ctx: ToolContext): Promise<ToolResult> {
    const abs = path.isAbsolute(args.path) ? args.path : path.resolve(ctx.cwd, args.path);
    const rel = path.relative(ctx.cwd, abs);

    let content: string;
    try {
      content = await fs.readFile(abs, 'utf-8');
    } catch (e: any) {
      if (e.code === 'ENOENT') {
        const { notFoundWithSuggestions } = await import('./suggest-paths.js');
        const msg = await notFoundWithSuggestions(
          ctx.cwd, args.path,
          `[FILE_NOT_FOUND] ${args.path} doesn't exist. Use write_file to create it, or check the path with ls.`,
        );
        return { content: msg, isError: true };
      }
      return { content: `[ERROR] Cannot read ${args.path}: ${e.message}`, isError: true };
    }

    if (args.old_string === args.new_string) {
      return { content: `[ERROR] old_string and new_string are identical — nothing to do.`, isError: true };
    }

    const { findMatch, reindentReplacement } = await import('./fuzzy-match.js');

    let updated: string;
    let occurrences: number;
    let tierNote = '';

    // replace_all keeps exact semantics (it's an explicit "every occurrence" op);
    // fuzzy only applies to the single-match path where drift is the usual cause
    // of failure.
    if (args.replace_all) {
      occurrences = content.split(args.old_string).length - 1;
      if (occurrences === 0) {
        return {
          content: `[STRING_NOT_FOUND] old_string was not found in ${rel} (replace_all). ` +
            `For a single fuzzy-tolerant edit, omit replace_all.`,
          isError: true,
        };
      }
      updated = content.split(args.old_string).join(args.new_string);
    } else {
      const match = findMatch(content, args.old_string, { allowFuzzy: true });
      if (!match) {
        // Helpful approximate-line hints, same as before.
        const lines = content.split('\n');
        const firstLine = args.old_string.split('\n')[0]?.trim();
        const hints: string[] = [];
        if (firstLine && firstLine.length > 3) {
          for (let i = 0; i < lines.length; i++) {
            if (lines[i]?.trim().startsWith(firstLine.slice(0, Math.min(40, firstLine.length)))) {
              hints.push(`  Line ${i + 1}: ${lines[i]?.trim().slice(0, 80)}`);
              if (hints.length >= 3) break;
            }
          }
        }
        return {
          content: `[STRING_NOT_FOUND] old_string was not found in ${rel} (tried exact, whitespace-insensitive, and fuzzy matching).\n` +
            `${hints.length ? `Similar lines found:\n${hints.join('\n')}\n` : ''}` +
            `Read the file again and copy the EXACT current text including indentation.`,
          isError: true,
        };
      }

      if (match.occurrences > 1) {
        return {
          content: `[MULTIPLE_MATCHES] old_string matches ${match.occurrences} places in ${rel} (${match.tier} tier). Either:\n` +
            `  1. Include more surrounding context to make old_string unique, OR\n` +
            `  2. Set replace_all=true to replace all occurrences.`,
          isError: true,
        };
      }

      occurrences = 1;
      // For non-exact matches, re-indent the replacement to the file's actual
      // indentation so the result stays clean.
      const replacement = match.tier === 'exact'
        ? args.new_string
        : reindentReplacement(match.matched, args.old_string, args.new_string);
      updated = content.slice(0, match.start) + replacement + content.slice(match.end);

      if (match.tier === 'whitespace') {
        tierNote = ' (matched ignoring whitespace differences)';
      } else if (match.tier === 'fuzzy') {
        tierNote = ` (fuzzy match, ${Math.round((match.score ?? 0) * 100)}% similar — verify the result)`;
      }
    }

    // Permission check
    const permReq = { tool: 'edit_text', operation: rel, description: `Edit ${rel} (${occurrences} replacement${occurrences > 1 ? 's' : ''})` };
    const decision = ctx.permissions.evaluate(permReq);
    if (decision === 'deny') {
      return { content: `[PERMISSION_DENIED] Cannot edit ${args.path}`, isError: true };
    }
    if (decision === 'ask') {
      const dec = await confirmEdit(ctx, {
        rel, before: content, after: updated, absPath: abs, permReq,
        label: `Edit ${rel}?`,
      });
      if (dec.kind === 'reject') {
        return { content: `[USER_REJECTED] User declined the edit to ${args.path}`, isError: true };
      }
      if (dec.kind === 'revise') return reviseResult(rel);
      updated = dec.content; // may be the user-edited version from [E] Edit
    }

    await ctx.transaction.write(abs, updated);

    return {
      content: `Edited ${rel} (${occurrences} replacement${occurrences > 1 ? 's' : ''})${tierNote}`,
      metadata: { path: abs, occurrences },
    };
  }
}
