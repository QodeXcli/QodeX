import { z } from 'zod';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { confirmEdit, reviseResult } from './edit-approval.js';

const EditSchema = z.object({
  old_string: z.string().describe('Exact text to find'),
  new_string: z.string().describe('Replacement text'),
  replace_all: z.boolean().optional(),
});

const ArgsSchema = z.object({
  path: z.string().describe('Path to file'),
  edits: z.array(EditSchema).describe('Edits applied in order. Each edit operates on the result of previous edits.'),
});

export class MultiEditTool extends Tool<z.infer<typeof ArgsSchema>> {
  name = 'multi_edit';
  description = 'Apply multiple sequential string edits to a single file atomically. If any edit fails, none are applied. Each edit sees the result of the previous.';
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
      return { content: `[ERROR] Cannot read ${args.path}: ${e.message}`, isError: true };
    }

    const original = content;
    let applied = 0;
    for (let i = 0; i < args.edits.length; i++) {
      const edit = args.edits[i]!;
      if (!content.includes(edit.old_string)) {
        return {
          content: `[MULTI_EDIT_FAILED] Edit #${i + 1} failed: old_string not found. ` +
            `${applied} previous edits would have been applied — rolling back. Re-read the file and provide accurate old_strings.`,
          isError: true,
        };
      }
      const occ = content.split(edit.old_string).length - 1;
      if (occ > 1 && !edit.replace_all) {
        return {
          content: `[MULTI_EDIT_FAILED] Edit #${i + 1}: old_string appears ${occ} times. Make it unique or set replace_all=true. Rolled back.`,
          isError: true,
        };
      }
      content = edit.replace_all
        ? content.split(edit.old_string).join(edit.new_string)
        : content.replace(edit.old_string, edit.new_string);
      applied++;
    }

    if (content === original) {
      return { content: `[NO_OP] All edits resulted in no change to ${rel}.`, isError: true };
    }

    // Permission check
    const permReq = { tool: 'multi_edit', operation: rel, description: `Multi-edit ${rel} (${args.edits.length} changes)` };
    const decision = ctx.permissions.evaluate(permReq);
    if (decision === 'deny') return { content: `[PERMISSION_DENIED]`, isError: true };
    if (decision === 'ask') {
      const dec = await confirmEdit(ctx, {
        rel, before: original, after: content, absPath: abs, permReq,
        label: `Apply ${args.edits.length} edits to ${rel}?`,
      });
      if (dec.kind === 'reject') return { content: `[USER_REJECTED]`, isError: true };
      if (dec.kind === 'revise') return reviseResult(rel);
      content = dec.content; // may be the user-edited version from [E] Edit
    }

    await ctx.transaction.write(abs, content);

    return { content: `Applied ${args.edits.length} edits to ${rel}` };
  }
}
