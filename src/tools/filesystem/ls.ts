import { z } from 'zod';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { outsideCwdHint } from '../../utils/path-hint.js';

const ArgsSchema = z.object({
  path: z.string().optional().describe('Directory to list. Defaults to cwd.'),
  show_hidden: z.boolean().optional().describe('Include dotfiles. Default false.'),
});

const IGNORED = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__', 'target', '.next', '.cache']);

export class LsTool extends Tool<z.infer<typeof ArgsSchema>> {
  name = 'ls';
  description = 'List files and directories in a directory. Like Unix `ls -la` but cleaner. Shows file sizes and types.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = ArgsSchema;

  async execute(args: z.infer<typeof ArgsSchema>, ctx: ToolContext): Promise<ToolResult> {
    const target = args.path
      ? (path.isAbsolute(args.path) ? args.path : path.resolve(ctx.cwd, args.path))
      : ctx.cwd;

    let entries: any[];
    try {
      entries = await fs.readdir(target, { withFileTypes: true });
    } catch (e: any) {
      if (e.code === 'ENOENT') {
        return { content: `[NOT_FOUND] Directory ${target} does not exist.${outsideCwdHint(args.path ?? '', target, ctx.cwd)}`, isError: true };
      }
      if (e.code === 'ENOTDIR') {
        return { content: `[ERROR] ${target} is not a directory. Use read_file instead.`, isError: true };
      }
      return { content: `[ERROR] ${e.message}`, isError: true };
    }

    const visible = entries.filter(e => {
      if (!args.show_hidden && e.name.startsWith('.')) return false;
      if (IGNORED.has(e.name)) return false;
      return true;
    });

    visible.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const lines: string[] = [`Contents of ${target}:`];
    for (const entry of visible) {
      if (entry.isDirectory()) {
        lines.push(`  📁 ${entry.name}/`);
      } else {
        try {
          const stat = await fs.stat(path.join(target, entry.name));
          const size = stat.size < 1024 ? `${stat.size}B`
            : stat.size < 1024 * 1024 ? `${(stat.size / 1024).toFixed(1)}K`
            : `${(stat.size / 1024 / 1024).toFixed(1)}M`;
          lines.push(`  📄 ${entry.name}  (${size})`);
        } catch {
          lines.push(`  📄 ${entry.name}`);
        }
      }
    }

    if (visible.length === 0) {
      lines.push('  (empty)');
    } else {
      const hidden = entries.length - visible.length;
      if (hidden > 0) lines.push(`\n  ... ${hidden} hidden/ignored entries`);
    }

    return { content: lines.join('\n'), metadata: { count: visible.length } };
  }
}
