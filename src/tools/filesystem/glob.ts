import { z } from 'zod';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Tool, type ToolContext, type ToolResult } from '../base.js';

const ArgsSchema = z.object({
  pattern: z.string().describe('Glob pattern like "**/*.ts", "src/**/test*.py", "**/Cargo.toml"'),
  path: z.string().optional().describe('Base directory to search from. Defaults to cwd.'),
});

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.turbo',
  '__pycache__', '.pytest_cache', '.mypy_cache', 'target', 'vendor', '.venv', 'venv', '.cache',
  'coverage', '.nyc_output',
]);

function globToRegex(pattern: string): RegExp {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i += 2;
        if (pattern[i] === '/') i++; // **/ matches zero or more dirs
      } else {
        re += '[^/]*';
        i++;
      }
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else if (c === '.' || c === '(' || c === ')' || c === '+' || c === '|' || c === '^' || c === '$' || c === '{' || c === '}' || c === '[' || c === ']') {
      re += '\\' + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  return new RegExp('^' + re + '$');
}

export class GlobTool extends Tool<z.infer<typeof ArgsSchema>> {
  name = 'glob';
  description = 'Find files matching a glob pattern (e.g. "**/*.ts", "src/**/*.py"). Returns relative paths sorted by modification time (newest first).';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = ArgsSchema;

  async execute(args: z.infer<typeof ArgsSchema>, ctx: ToolContext): Promise<ToolResult> {
    const base = args.path
      ? (path.isAbsolute(args.path) ? args.path : path.resolve(ctx.cwd, args.path))
      : ctx.cwd;
    const regex = globToRegex(args.pattern);

    const matches: Array<{ path: string; mtime: number }> = [];
    const maxResults = 500;

    async function walk(dir: string): Promise<void> {
      if (matches.length >= maxResults) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch { return; }

      for (const entry of entries) {
        if (entry.name.startsWith('.') && entry.name !== '.env') continue;
        if (entry.isDirectory()) {
          if (IGNORED_DIRS.has(entry.name)) continue;
          await walk(path.join(dir, entry.name));
        } else {
          const full = path.join(dir, entry.name);
          const rel = path.relative(base, full).split(path.sep).join('/');
          if (regex.test(rel)) {
            try {
              const stat = await fs.stat(full);
              matches.push({ path: rel, mtime: stat.mtime.getTime() });
            } catch {}
          }
        }
        if (matches.length >= maxResults) return;
      }
    }

    await walk(base);
    matches.sort((a, b) => b.mtime - a.mtime);

    if (matches.length === 0) {
      return { content: `[NO_MATCHES] No files match "${args.pattern}" in ${base}. Verify the pattern and base path.` };
    }

    const truncationNote = matches.length >= maxResults ? `\n[... result truncated at ${maxResults}]` : '';
    return {
      content: matches.map(m => m.path).join('\n') + truncationNote,
      metadata: { count: matches.length, pattern: args.pattern },
    };
  }
}
