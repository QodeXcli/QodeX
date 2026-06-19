import { z } from 'zod';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { hasRipgrep } from '../../utils/ripgrep.js';

const ArgsSchema = z.object({
  pattern: z.string().describe('Regex pattern to search for'),
  path: z.string().optional().describe('Directory or file to search. Defaults to cwd.'),
  glob: z.string().optional().describe('Only search files matching this glob (e.g. "*.ts", "src/**/*.py")'),
  case_insensitive: z.boolean().optional().describe('Case-insensitive search. Default false.'),
  context_lines: z.number().int().min(0).max(10).optional().describe('Lines of context before/after each match. Default 0.'),
  max_results: z.number().int().positive().optional().describe('Max matches to return. Default 100.'),
  output_mode: z.enum(['content', 'files_only', 'count']).optional().describe('content: show matches with context. files_only: just file paths. count: count per file. Default content.'),
});

export class GrepTool extends Tool<z.infer<typeof ArgsSchema>> {
  name = 'grep';
  description = 'Search file contents using regex. Uses ripgrep when available (very fast). Returns matches grouped by file.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = ArgsSchema;

  async execute(args: z.infer<typeof ArgsSchema>, ctx: ToolContext): Promise<ToolResult> {
    const target = args.path
      ? (path.isAbsolute(args.path) ? args.path : path.resolve(ctx.cwd, args.path))
      : ctx.cwd;
    const maxResults = args.max_results ?? 100;
    const outputMode = args.output_mode ?? 'content';

    if (await hasRipgrep()) {
      return await this.runRipgrep(args, target, maxResults, outputMode, ctx);
    }
    return await this.runNative(args, target, maxResults, outputMode);
  }

  private async runRipgrep(
    args: z.infer<typeof ArgsSchema>,
    target: string,
    maxResults: number,
    outputMode: 'content' | 'files_only' | 'count',
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const rgArgs: string[] = [];
    if (args.case_insensitive) rgArgs.push('-i');
    if (args.glob) rgArgs.push('--glob', args.glob);
    if (outputMode === 'files_only') rgArgs.push('-l');
    if (outputMode === 'count') rgArgs.push('-c');
    if (outputMode === 'content' && args.context_lines) {
      rgArgs.push('-C', String(args.context_lines));
    }
    if (outputMode === 'content') rgArgs.push('-n');  // line numbers
    rgArgs.push('--max-count', String(maxResults));
    rgArgs.push('-e', args.pattern, target);

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let proc: ReturnType<typeof spawn>;
      try {
        proc = spawn('rg', rgArgs, { signal: ctx.signal });
      } catch (e: any) {
        resolve({ content: `[GREP_ERROR] failed to spawn ripgrep: ${e.message}`, isError: true });
        return;
      }
      proc.stdout?.on('data', (d: Buffer) => { stdout += d; });
      proc.stderr?.on('data', (d: Buffer) => { stderr += d; });
      proc.on('close', (code, signal) => {
        if (signal) {
          resolve({ content: `[GREP_CANCELLED] ripgrep killed by ${signal}`, isError: true });
          return;
        }
        if (code === 0) {
          const lines = stdout.split('\n').filter(Boolean);
          if (lines.length === 0) {
            resolve({ content: `[NO_MATCHES] Pattern "${args.pattern}" not found in ${target}` });
            return;
          }
          resolve({
            content: lines.join('\n') + (lines.length >= maxResults ? `\n[... truncated at ${maxResults} matches]` : ''),
            metadata: { matches: lines.length },
          });
        } else if (code === 1) {
          // ripgrep returns 1 when no matches
          resolve({ content: `[NO_MATCHES] Pattern "${args.pattern}" not found in ${target}` });
        } else {
          resolve({ content: `[GREP_ERROR] ripgrep exited with code ${code}: ${stderr.slice(0, 300)}`, isError: true });
        }
      });
      proc.on('error', e => {
        resolve({ content: `[GREP_ERROR] ${e.message}`, isError: true });
      });
    });
  }

  private async runNative(
    args: z.infer<typeof ArgsSchema>,
    target: string,
    maxResults: number,
    outputMode: 'content' | 'files_only' | 'count',
  ): Promise<ToolResult> {
    const flags = args.case_insensitive ? 'gi' : 'g';
    let regex: RegExp;
    try {
      regex = new RegExp(args.pattern, flags);
    } catch (e: any) {
      return { content: `[REGEX_ERROR] Invalid pattern: ${e.message}`, isError: true };
    }

    const fileFilter = args.glob ? new RegExp(this.globToRegex(args.glob)) : null;
    const IGNORED_DIRS = new Set([
      'node_modules', '.git', 'dist', 'build', '__pycache__', 'target', '.next', '.cache', 'venv', '.venv',
    ]);

    const fileMatches: Array<{ file: string; lines: Array<{ num: number; text: string }> }> = [];
    let totalMatches = 0;

    async function walk(dir: string): Promise<void> {
      if (totalMatches >= maxResults) return;
      let entries: any[];
      try {
        const stat = await fs.stat(dir);
        if (stat.isFile()) {
          entries = [{ name: path.basename(dir), isDirectory: () => false }];
          dir = path.dirname(dir);
        } else {
          entries = await fs.readdir(dir, { withFileTypes: true });
        }
      } catch { return; }

      for (const entry of entries) {
        if (totalMatches >= maxResults) return;
        if (entry.name.startsWith('.') && entry.name !== '.env') continue;
        if (entry.isDirectory()) {
          if (IGNORED_DIRS.has(entry.name)) continue;
          await walk(path.join(dir, entry.name));
        } else {
          const full = path.join(dir, entry.name);
          if (fileFilter && !fileFilter.test(entry.name)) continue;
          let content: string;
          try {
            const stat = await fs.stat(full);
            if (stat.size > 2 * 1024 * 1024) continue;  // skip huge files
            content = await fs.readFile(full, 'utf-8');
          } catch { continue; }

          const lines = content.split('\n');
          const matches: Array<{ num: number; text: string }> = [];
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i]!)) {
              matches.push({ num: i + 1, text: lines[i]! });
              totalMatches++;
              if (totalMatches >= maxResults) break;
            }
          }
          if (matches.length > 0) {
            fileMatches.push({ file: path.relative(target, full) || full, lines: matches });
          }
        }
      }
    }

    await walk(target);

    if (fileMatches.length === 0) {
      return { content: `[NO_MATCHES] Pattern "${args.pattern}" not found in ${target}` };
    }

    if (outputMode === 'files_only') {
      return { content: fileMatches.map(f => f.file).join('\n'), metadata: { files: fileMatches.length } };
    }
    if (outputMode === 'count') {
      return { content: fileMatches.map(f => `${f.file}:${f.lines.length}`).join('\n') };
    }

    const out: string[] = [];
    for (const fm of fileMatches) {
      out.push(`\n${fm.file}:`);
      for (const ln of fm.lines) {
        out.push(`  ${ln.num}: ${ln.text}`);
      }
    }
    return { content: out.join('\n').trim(), metadata: { matches: totalMatches } };
  }

  private globToRegex(g: string): string {
    let re = '';
    for (let i = 0; i < g.length; i++) {
      const c = g[i]!;
      if (c === '*') re += '.*';
      else if (c === '?') re += '.';
      else if ('.+()[]{}^$|\\'.includes(c)) re += '\\' + c;
      else re += c;
    }
    return '^' + re + '$';
  }
}
