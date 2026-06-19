import { z } from 'zod';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { isBinaryBuffer, hasBinaryExtension } from '../../utils/binary.js';
import { outsideCwdHint } from '../../utils/path-hint.js';

const ArgsSchema = z.object({
  path: z.string().describe('Path to file (absolute or relative to cwd)'),
  offset: z.number().int().min(0).optional().describe('Line number to start from (1-indexed)'),
  limit: z.number().int().positive().optional().describe('Max lines to read (default: all)'),
  symbol: z.string().optional().describe('Read just this declaration (function/class/component name) by name, using the file outline. Easier than guessing offset/limit on a large file. e.g. symbol="HomePage".'),
});

export class ReadFileTool extends Tool<z.infer<typeof ArgsSchema>> {
  name = 'read_file';
  description = 'Read a file from the filesystem. Returns numbered lines for easy reference. For large files (>400 lines) called without offset/limit, returns a structural outline (symbols + line ranges) plus the head — then read the part you need with offset/limit, or pass symbol="Name" to read one declaration directly. Refuses binary files.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = ArgsSchema;

  async execute(args: z.infer<typeof ArgsSchema>, ctx: ToolContext): Promise<ToolResult> {
    const abs = path.isAbsolute(args.path) ? args.path : path.resolve(ctx.cwd, args.path);

    let buf: Buffer;
    try {
      const stat = await fs.stat(abs);
      if (stat.isDirectory()) {
        return { content: `[ERROR] ${args.path} is a directory. Use ls to list its contents.`, isError: true };
      }
      if (stat.size > 5 * 1024 * 1024) {
        return {
          content: `[ERROR] File ${args.path} is ${(stat.size / 1024 / 1024).toFixed(1)}MB which is too large. Use offset/limit to read in chunks, or use grep to find specific content.`,
          isError: true,
        };
      }
      // Fast-path reject for known binary extensions
      if (hasBinaryExtension(abs)) {
        return {
          content: `[BINARY_FILE] ${args.path} is a binary file by extension (${(stat.size / 1024).toFixed(1)}KB). I cannot read binary content as text. If you need metadata, use shell with: file '${path.basename(abs)}' or stat. If you need byte-level inspection, use: hexdump -C '${path.basename(abs)}' | head.`,
          isError: true,
        };
      }
      buf = await fs.readFile(abs);
    } catch (e: any) {
      if (e.code === 'ENOENT') {
        const { notFoundWithSuggestions } = await import('./suggest-paths.js');
        const msg = await notFoundWithSuggestions(
          ctx.cwd, args.path,
          `[FILE_NOT_FOUND] ${args.path} does not exist.${outsideCwdHint(args.path, abs, ctx.cwd)}`,
        );
        return { content: msg, isError: true };
      }
      return { content: `[ERROR] Failed to read ${args.path}: ${e.message}`, isError: true };
    }

    // Content-sniff for binary
    if (isBinaryBuffer(buf)) {
      return {
        content: `[BINARY_FILE] ${args.path} appears to be binary content (${(buf.length / 1024).toFixed(1)}KB, contains null bytes or non-printable bytes). I cannot read it as text. Use shell with hexdump/file/strings for binary inspection.`,
        isError: true,
      };
    }

    const content = buf.toString('utf-8');

    const allLines = content.split('\n');

    // Symbol-targeted read: resolve a declaration by name via the outline and
    // return exactly that range. Lets the model say symbol="HomePage" instead of
    // guessing line numbers on a big file.
    if (args.symbol) {
      const { fileOutline } = await import('../../context/file-outline.js');
      const rel = path.relative(ctx.cwd, abs) || path.basename(abs);
      const outline = await fileOutline(rel, content);
      const want = args.symbol.toLowerCase();
      const hit = outline.find(e => e.symbol.toLowerCase() === want)
        ?? outline.find(e => e.symbol.toLowerCase().endsWith('.' + want))
        ?? outline.find(e => e.symbol.toLowerCase().includes(want));
      if (hit) {
        const s = hit.startLine;
        const slice = allLines.slice(s - 1, hit.endLine);
        const maxDigits = String(hit.endLine).length;
        const numbered = slice
          .map((line, i) => `${String(s + i).padStart(maxDigits, ' ')}\t${line}`)
          .join('\n');
        return {
          content: `[${hit.symbol} — lines ${s}-${hit.endLine}]\n${numbered}`,
          metadata: { path: abs, symbol: hit.symbol, startLine: s, endLine: hit.endLine },
        };
      }
      // Symbol not found — fall through to normal/outline behavior with a hint.
      const names = outline.map(e => e.symbol).slice(0, 30).join(', ');
      return {
        content: `[SYMBOL_NOT_FOUND] No declaration named "${args.symbol}" in ${rel}.` +
          (names ? ` Known symbols: ${names}.` : ' (No symbols detected; read with offset/limit.)'),
        isError: true,
      };
    }

    // Smart large-file handling: if the file is big AND the caller didn't ask
    // for a specific slice, return a structural MAP (symbols + line ranges) plus
    // the head — not the whole file. This stops one big file from flooding the
    // context window and lets the model jump straight to the section it needs.
    // An explicit offset/limit always wins (the model knows what it wants).
    const LARGE_FILE_LINES = 400;
    if (allLines.length > LARGE_FILE_LINES && args.offset === undefined && args.limit === undefined) {
      const { renderLargeFileMap } = await import('../../context/file-outline.js');
      const rel = path.relative(ctx.cwd, abs) || path.basename(abs);
      return {
        content: await renderLargeFileMap(rel, content, { headLines: 40 }),
        metadata: { path: abs, totalLines: allLines.length, mode: 'outline' },
      };
    }

    const start = args.offset ?? 1;
    const limit = args.limit ?? allLines.length;
    const sliced = allLines.slice(start - 1, start - 1 + limit);

    const maxDigits = String(start + sliced.length - 1).length;
    const numbered = sliced
      .map((line, i) => `${String(start + i).padStart(maxDigits, ' ')}\t${line}`)
      .join('\n');

    const truncatedNote = sliced.length < allLines.length - (start - 1)
      ? `\n[... showing lines ${start}-${start + sliced.length - 1} of ${allLines.length} total]`
      : '';

    return {
      content: numbered + truncatedNote,
      metadata: { path: abs, totalLines: allLines.length, shownLines: sliced.length },
    };
  }
}
