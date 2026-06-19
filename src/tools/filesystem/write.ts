import { z } from 'zod';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { confirmEdit, reviseResult } from './edit-approval.js';
import { isBinaryBuffer } from '../../utils/binary.js';

const ArgsSchema = z.object({
  path: z.string().describe('Path to write to (absolute or relative). Will be created if not exists.'),
  content: z.string().describe('Full file content to write'),
});

export class WriteFileTool extends Tool<z.infer<typeof ArgsSchema>> {
  name = 'write_file';
  description = 'Create a new file or overwrite an existing one with the given content. Goes through the transaction journal — reversible.';
  isReadOnly = false;
  isDestructive = true;
  argsSchema = ArgsSchema;

  async execute(args: z.infer<typeof ArgsSchema>, ctx: ToolContext): Promise<ToolResult> {
    const abs = path.isAbsolute(args.path) ? args.path : path.resolve(ctx.cwd, args.path);

    // Safety: refuse to write outside cwd unless explicitly absolute and user-approved
    const rel = path.relative(ctx.cwd, abs);
    if (rel.startsWith('..') && !path.isAbsolute(args.path)) {
      return { content: `[ERROR] Refusing to write outside cwd: ${args.path}`, isError: true };
    }

    // Refuse to overwrite binary files (would corrupt utf-8 conversion)
    let before: string | null = null;
    try {
      const stat = await fs.stat(abs);
      // Read as buffer first to check binary-ness
      const buf = await fs.readFile(abs);
      if (isBinaryBuffer(buf)) {
        return {
          content: `[BINARY_FILE_REFUSED] ${rel} is an existing binary file (${(stat.size / 1024).toFixed(1)}KB). write_file refuses to overwrite binary files because utf-8 round-tripping would corrupt them. If you really mean to replace this file, delete it first with: shell({ command: "rm '${rel}'", ... })`,
          isError: true,
        };
      }
      before = buf.toString('utf-8');
    } catch (e: any) {
      if (e.code !== 'ENOENT') {
        // not a missing-file error
        return { content: `[ERROR] Cannot inspect ${args.path}: ${e.message}`, isError: true };
      }
      // File doesn't exist — that's fine, we're creating it
    }

    // Permission check
    const permReq = { tool: 'write_file', operation: rel, description: before ? `Overwrite ${rel}` : `Create ${rel}` };
    const decision = ctx.permissions.evaluate(permReq);
    if (decision === 'deny') {
      return { content: `[PERMISSION_DENIED] Cannot write to ${args.path} (blocked by policy)`, isError: true };
    }
    let contentToWrite = args.content;
    if (decision === 'ask') {
      const sizeNote = (args.content.length > 64 * 1024)
        ? ` [large file: ${(args.content.length / 1024).toFixed(1)}KB — diff display truncated]`
        : '';
      const dec = await confirmEdit(ctx, {
        rel, before, after: args.content, absPath: abs, permReq,
        label: (before ? `Overwrite ${rel}?` : `Create ${rel}?`) + sizeNote,
      });
      if (dec.kind === 'reject') {
        return { content: `[USER_REJECTED] User declined to write ${args.path}`, isError: true };
      }
      if (dec.kind === 'revise') return reviseResult(rel);
      contentToWrite = dec.content; // may be the user-edited version from [E] Edit
    }

    // Execute through transaction
    try {
      await ctx.transaction.write(abs, contentToWrite);
    } catch (e: any) {
      return { content: `[ERROR] Failed to write ${args.path}: ${e.message}`, isError: true };
    }

    const action = before === null ? 'Created' : 'Updated';
    const lines = args.content.split('\n').length;
    return {
      content: `${action} ${rel} (${lines} lines, ${Buffer.byteLength(args.content)} bytes)`,
      metadata: { path: abs, isCreate: before === null, lines },
    };
  }
}
