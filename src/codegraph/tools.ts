import { z } from 'zod';
import * as path from 'path';
import { promises as fs } from 'fs';
import { Tool, type ToolContext, type ToolResult } from '../tools/base.js';
import { CodeGraphDB } from './schema.js';
import { runLineSearch } from '../utils/ripgrep.js';

let _db: CodeGraphDB | null = null;
export function setCodeGraphDB(db: CodeGraphDB): void { _db = db; }
export function getCodeGraphDB(): CodeGraphDB | null { return _db; }

let _indexer: import('./indexer.js').Indexer | null = null;
export function setIndexer(idx: import('./indexer.js').Indexer): void { _indexer = idx; }
export function getIndexer(): import('./indexer.js').Indexer | null { return _indexer; }

function requireDB(): CodeGraphDB | { error: string } {
  if (!_db) return { error: '[CODE_GRAPH_NOT_READY] The code graph has not been built yet. Run `qx index` or `/index` to build it.' };
  return _db;
}

// ---------------- find_symbol ----------------

const FindSymbolArgs = z.object({
  name: z.string().describe('Exact symbol name to find'),
  kind: z.enum(['function', 'class', 'method', 'interface', 'type', 'enum', 'impl']).optional()
    .describe('Filter by kind'),
});

export class CodeGraphFindSymbolTool extends Tool<z.infer<typeof FindSymbolArgs>> {
  name = 'code_graph_find_symbol';
  description = 'Find where a symbol (function, class, method, interface, type) is defined across the indexed codebase. Much faster than grep for navigation. Returns file paths + line numbers.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = FindSymbolArgs;

  async execute(args: z.infer<typeof FindSymbolArgs>, ctx: ToolContext): Promise<ToolResult> {
    const db = requireDB();
    if ('error' in db) return { content: db.error, isError: true };

    const rows = db.findSymbolsByName(args.name, args.kind);
    if (rows.length === 0) {
      // Try prefix search as a hint
      const prefixMatches = db.searchSymbolsByPrefix(args.name, args.kind, 10);
      if (prefixMatches.length > 0) {
        const hints = prefixMatches.slice(0, 8).map(r => `  ${r.kind} ${r.name}  → ${path.relative(ctx.cwd, r.file_path)}:${r.start_line}`).join('\n');
        return {
          content: `[NOT_FOUND] No ${args.kind ?? 'symbol'} named exactly "${args.name}". Did you mean one of:\n${hints}`,
          isError: false,
        };
      }
      return {
        content: `[NOT_FOUND] No ${args.kind ?? 'symbol'} named "${args.name}" in the indexed codebase. If you recently added it, run /index to refresh.`,
        isError: false,
      };
    }

    const lines = rows.map(r => {
      const rel = path.relative(ctx.cwd, r.file_path);
      const sig = r.signature ? `    ${r.signature}` : '';
      return `${r.kind} ${r.name}  → ${rel}:${r.start_line}${sig ? '\n' + sig : ''}`;
    });
    return {
      content: `Found ${rows.length} definition${rows.length > 1 ? 's' : ''}:\n${lines.join('\n')}`,
      metadata: { count: rows.length },
    };
  }
}

// ---------------- search_symbols (prefix) ----------------

const SearchArgs = z.object({
  prefix: z.string().describe('Symbol name prefix to search for'),
  kind: z.enum(['function', 'class', 'method', 'interface', 'type', 'enum', 'impl']).optional(),
  limit: z.number().int().min(1).max(200).optional().describe('Max results (default 50)'),
});

export class CodeGraphSearchSymbolsTool extends Tool<z.infer<typeof SearchArgs>> {
  name = 'code_graph_search_symbols';
  description = 'Search for symbols whose name starts with a given prefix. Useful for fuzzy navigation when you remember only part of a name.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = SearchArgs;

  async execute(args: z.infer<typeof SearchArgs>, ctx: ToolContext): Promise<ToolResult> {
    const db = requireDB();
    if ('error' in db) return { content: db.error, isError: true };

    const rows = db.searchSymbolsByPrefix(args.prefix, args.kind, args.limit ?? 50);
    if (rows.length === 0) {
      return { content: `[NO_MATCHES] No symbols starting with "${args.prefix}"`, isError: false };
    }
    const lines = rows.map(r => {
      const rel = path.relative(ctx.cwd, r.file_path);
      return `  ${r.kind} ${r.name}  → ${rel}:${r.start_line}`;
    });
    return {
      content: `${rows.length} match${rows.length > 1 ? 'es' : ''}:\n${lines.join('\n')}`,
      metadata: { count: rows.length },
    };
  }
}

// ---------------- list_symbols_in_file ----------------

const ListSymArgs = z.object({
  path: z.string().describe('Path to source file (absolute or relative to cwd)'),
});

export class CodeGraphListSymbolsTool extends Tool<z.infer<typeof ListSymArgs>> {
  name = 'code_graph_list_symbols';
  description = 'List all symbols (functions, classes, methods, types) defined in a file with their line numbers. A fast outline view — much cheaper than read_file when you only need the structure.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = ListSymArgs;

  async execute(args: z.infer<typeof ListSymArgs>, ctx: ToolContext): Promise<ToolResult> {
    const db = requireDB();
    if ('error' in db) return { content: db.error, isError: true };

    const abs = path.isAbsolute(args.path) ? args.path : path.resolve(ctx.cwd, args.path);
    const rows = db.listSymbolsInFile(abs);
    if (rows.length === 0) {
      return {
        content: `[NO_SYMBOLS] No indexed symbols in ${args.path}. The file may not be indexed (run /index) or may not be a supported language.`,
        isError: false,
      };
    }

    // Compute indentation by parent depth — easier to read
    const byId = new Map(rows.map(r => [r.id, r]));
    const depthOf = (r: typeof rows[number]): number => {
      let d = 0;
      let cur = r.parent_symbol_id;
      while (cur !== null && byId.has(cur) && d < 10) {
        d++;
        cur = byId.get(cur)!.parent_symbol_id;
      }
      return d;
    };

    const lines = rows.map(r => {
      const indent = '  '.repeat(depthOf(r));
      return `${indent}${String(r.start_line).padStart(4)}  ${r.kind}  ${r.name}`;
    });
    return {
      content: `${args.path} — ${rows.length} symbol${rows.length > 1 ? 's' : ''}:\n${lines.join('\n')}`,
      metadata: { count: rows.length },
    };
  }
}

// ---------------- find_callers ----------------

const FindCallersArgs = z.object({
  name: z.string().describe('Name of the function/method to find call sites for'),
  language: z.string().optional().describe('Optional ripgrep --type filter (e.g. "ts", "py", "rs", "go")'),
  limit: z.number().int().min(1).max(500).optional().describe('Max results (default 100)'),
});

/**
 * Find call sites — `name(...)` — across the project using ripgrep. Definition lines
 * (from the indexed symbols table) are filtered out so the agent doesn't waste tokens
 * on the symbol's own declaration.
 *
 * Pattern: `\bname\s*\(`. Works for most call-style syntaxes (function call, method call,
 * constructor) but misses chained property access like `obj.name(` because the word boundary
 * after `.` is also a word boundary — wait, `.` IS a non-word char so `\b` succeeds there
 * too. Good. So `foo.bar(` matches `\bbar\s*\(`.
 *
 * Caveats:
 *   - String literals containing `name(` are matched (e.g. logging strings, docs).
 *   - Type annotations like `x: name<T>` are not call sites and aren't matched (good).
 *   - Comments containing `name(` are matched — the model can disambiguate.
 */
export class CodeGraphFindCallersTool extends Tool<z.infer<typeof FindCallersArgs>> {
  name = 'code_graph_find_callers';
  description = 'Find places that CALL the given function/method. Returns file:line locations with a preview of each call site, excluding the symbol\'s own definition. Use this for impact analysis before refactoring.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = FindCallersArgs;

  async execute(args: z.infer<typeof FindCallersArgs>, ctx: ToolContext): Promise<ToolResult> {
    const db = requireDB();
    if ('error' in db) return { content: db.error, isError: true };

    // Build a set of definition locations to filter out from ripgrep results
    const defs = db.findSymbolsByName(args.name);
    const defKeys = new Set(defs.map(d => `${d.file_path}:${d.start_line}`));

    const escaped = args.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = `\\b${escaped}\\s*\\(`;
    const limit = args.limit ?? 100;

    const rgArgs = ['-n', '--no-heading', '--max-count', String(limit + defs.length), '-e', pattern];
    if (args.language) rgArgs.push('--type', args.language);
    rgArgs.push(ctx.cwd);

    const search = await runLineSearch(ctx.cwd, {
      rgArgs,
      regex: new RegExp(pattern),
      language: args.language,
      maxCount: limit + defs.length,
      signal: ctx.signal,
    });
    if ('error' in search) return { content: search.error, isError: true };

    const lines = search.stdout.split('\n').filter(Boolean);
    // Format: file:line:content
    const callers: Array<{ file: string; line: number; preview: string }> = [];
    for (const raw of lines) {
      const firstColon = raw.indexOf(':');
      const secondColon = raw.indexOf(':', firstColon + 1);
      if (firstColon === -1 || secondColon === -1) continue;
      const file = raw.slice(0, firstColon);
      const lineNum = parseInt(raw.slice(firstColon + 1, secondColon), 10);
      if (!Number.isFinite(lineNum)) continue;
      const preview = raw.slice(secondColon + 1).trim();
      // Filter out definition lines
      if (defKeys.has(`${file}:${lineNum}`)) continue;
      callers.push({ file, line: lineNum, preview: preview.slice(0, 200) });
      if (callers.length >= limit) break;
    }
    if (callers.length === 0) {
      return { content: `[NO_CALLERS] No call sites found for "${args.name}". Either it's only defined (never called from the indexed paths), or the project hasn't been indexed yet (try /index).` };
    }
    // Group by file
    const byFile = new Map<string, typeof callers>();
    for (const c of callers) {
      const rel = path.relative(ctx.cwd, c.file);
      if (!byFile.has(rel)) byFile.set(rel, []);
      byFile.get(rel)!.push(c);
    }
    const out: string[] = [`Found ${callers.length} call site${callers.length > 1 ? 's' : ''} for "${args.name}":`];
    for (const [rel, items] of byFile) {
      out.push(`\n  ${rel}`);
      for (const it of items) {
        out.push(`    :${it.line}  ${it.preview}`);
      }
    }
    if (callers.length >= limit) out.push(`\n[...truncated at ${limit} results]`);
    return { content: out.join('\n'), metadata: { count: callers.length, files: byFile.size } };
  }
}

// ---------------- find_references ----------------

const FindReferencesArgs = z.object({
  name: z.string().describe('Identifier to find all references for'),
  language: z.string().optional().describe('Optional ripgrep --type filter'),
  include_definitions: z.boolean().optional().describe('If true, include the symbol\'s own definitions in the results (default false)'),
  limit: z.number().int().min(1).max(500).optional(),
});

/**
 * Find every word-boundary occurrence of a name. Broader than find_callers — matches
 * type references, imports, comments, doc strings, log lines. Use this for full impact
 * analysis (rename, removal) where you need to see EVERYTHING that mentions the name.
 */
export class CodeGraphFindReferencesTool extends Tool<z.infer<typeof FindReferencesArgs>> {
  name = 'code_graph_find_references';
  description = 'Find ALL references to a symbol — call sites, type references, imports, comments, log messages. Use before renaming or removing a symbol to assess the full impact across the codebase.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = FindReferencesArgs;

  async execute(args: z.infer<typeof FindReferencesArgs>, ctx: ToolContext): Promise<ToolResult> {
    const db = requireDB();
    if ('error' in db) return { content: db.error, isError: true };

    const defs = db.findSymbolsByName(args.name);
    const defKeys = args.include_definitions
      ? new Set<string>()
      : new Set(defs.map(d => `${d.file_path}:${d.start_line}`));

    const escaped = args.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const limit = args.limit ?? 200;

    const rgArgs = ['-n', '--no-heading', '--word-regexp', '--max-count', String(limit + defs.length), '-e', escaped];
    if (args.language) rgArgs.push('--type', args.language);
    rgArgs.push(ctx.cwd);

    const search = await runLineSearch(ctx.cwd, {
      rgArgs,
      regex: new RegExp(`\\b${escaped}\\b`),
      language: args.language,
      maxCount: limit + defs.length,
      signal: ctx.signal,
    });
    if ('error' in search) return { content: search.error, isError: true };

    const lines = search.stdout.split('\n').filter(Boolean);
    const refs: Array<{ file: string; line: number; preview: string }> = [];
    for (const raw of lines) {
      const firstColon = raw.indexOf(':');
      const secondColon = raw.indexOf(':', firstColon + 1);
      if (firstColon === -1 || secondColon === -1) continue;
      const file = raw.slice(0, firstColon);
      const lineNum = parseInt(raw.slice(firstColon + 1, secondColon), 10);
      if (!Number.isFinite(lineNum)) continue;
      if (defKeys.has(`${file}:${lineNum}`)) continue;
      refs.push({ file, line: lineNum, preview: raw.slice(secondColon + 1).trim().slice(0, 200) });
      if (refs.length >= limit) break;
    }
    if (refs.length === 0) {
      const note = args.include_definitions
        ? 'No references found at all'
        : 'No references found (other than definitions)';
      return { content: `[NO_REFERENCES] ${note} for "${args.name}". The project may not be indexed (try /index).` };
    }
    const byFile = new Map<string, typeof refs>();
    for (const r of refs) {
      const rel = path.relative(ctx.cwd, r.file);
      if (!byFile.has(rel)) byFile.set(rel, []);
      byFile.get(rel)!.push(r);
    }
    const out: string[] = [`Found ${refs.length} reference${refs.length > 1 ? 's' : ''} to "${args.name}" across ${byFile.size} file${byFile.size > 1 ? 's' : ''}:`];
    for (const [rel, items] of byFile) {
      out.push(`\n  ${rel}  (${items.length})`);
      for (const it of items.slice(0, 30)) {
        out.push(`    :${it.line}  ${it.preview}`);
      }
      if (items.length > 30) out.push(`    ... [+${items.length - 30} more in this file]`);
    }
    if (refs.length >= limit) out.push(`\n[...truncated at ${limit} total results]`);
    return { content: out.join('\n'), metadata: { count: refs.length, files: byFile.size } };
  }
}

// ---------------- explain_symbol ----------------

const ExplainSymbolArgs = z.object({
  name: z.string().describe('Symbol name to explain'),
  kind: z.enum(['function', 'class', 'method', 'interface', 'type', 'enum', 'impl']).optional()
    .describe('Filter by kind to disambiguate when multiple symbols share a name'),
  max_body_lines: z.number().int().min(1).max(500).optional().describe('Maximum body lines to include per symbol (default 60)'),
});

/**
 * Show a symbol's signature, leading documentation comment, and a preview of its body.
 * Far cheaper than read_file when you only need to understand what a symbol does.
 * Resolves the symbol(s) via the indexed graph, then reads the source slice from disk.
 *
 * Output for each match:
 *   <kind> <name>  → <relative-path>:<startLine>-<endLine>
 *   [leading docstring/comment if any]
 *   <body, up to max_body_lines>
 */
export class CodeGraphExplainSymbolTool extends Tool<z.infer<typeof ExplainSymbolArgs>> {
  name = 'code_graph_explain_symbol';
  description = 'Show a symbol\'s signature, leading doc comment, and body preview. Cheaper than read_file when you only need to understand one function/class/type. Handles multiple matches (e.g. overloads) up to 5.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = ExplainSymbolArgs;

  async execute(args: z.infer<typeof ExplainSymbolArgs>, ctx: ToolContext): Promise<ToolResult> {
    const db = requireDB();
    if ('error' in db) return { content: db.error, isError: true };

    const rows = db.findSymbolsByName(args.name, args.kind);
    if (rows.length === 0) {
      const hints = db.searchSymbolsByPrefix(args.name, args.kind, 8);
      if (hints.length > 0) {
        const hintList = hints.map(h => `  ${h.kind} ${h.name}  → ${path.relative(ctx.cwd, h.file_path)}:${h.start_line}`).join('\n');
        return { content: `[NOT_FOUND] No exact match for "${args.name}". Similar:\n${hintList}` };
      }
      return { content: `[NOT_FOUND] No symbol named "${args.name}" in the indexed codebase.` };
    }

    const maxBody = args.max_body_lines ?? 60;
    const sections: string[] = [];
    const MAX_MATCHES = 5;

    for (const row of rows.slice(0, MAX_MATCHES)) {
      const rel = path.relative(ctx.cwd, row.file_path);
      let body: string[] = [];
      let leading: string[] = [];

      try {
        const buf = await fs.readFile(row.file_path, 'utf-8');
        const lines = buf.split('\n');
        const startIdx = Math.max(0, row.start_line - 1);
        const endIdx = Math.min(lines.length - 1, row.end_line - 1);

        // Capture leading docstring/comment block (look up to 15 lines above for comments)
        for (let i = startIdx - 1; i >= Math.max(0, startIdx - 15); i--) {
          const ln = lines[i] ?? '';
          const trimmed = ln.trim();
          if (trimmed === '') {
            if (leading.length > 0) break; // blank line ends the comment block
            continue;
          }
          if (
            trimmed.startsWith('//') ||
            trimmed.startsWith('*') ||
            trimmed.startsWith('/*') ||
            trimmed.startsWith('#') ||
            trimmed.startsWith('"""') ||
            trimmed.endsWith('*/') ||
            trimmed.startsWith("'''")
          ) {
            leading.unshift(ln);
          } else {
            break;
          }
        }

        // Body, capped at maxBody lines
        const totalLines = endIdx - startIdx + 1;
        const sliceEnd = Math.min(endIdx, startIdx + maxBody - 1);
        body = lines.slice(startIdx, sliceEnd + 1);
        if (sliceEnd < endIdx) {
          body.push(`  /* ... ${totalLines - maxBody} more lines (use read_file to see the rest) */`);
        }
      } catch (e: any) {
        body = [`  [READ_ERROR] could not read source file: ${e.message}`];
      }

      const header = `${row.kind} ${row.name}  →  ${rel}:${row.start_line}-${row.end_line}`;
      let parent = '';
      if (row.parent_symbol_id !== null) {
        const parentSym = db.getSymbolById(row.parent_symbol_id);
        if (parentSym) parent = ` (member of ${parentSym.kind} ${parentSym.name})`;
      }

      sections.push(
        header + parent +
        (leading.length > 0 ? '\n' + leading.join('\n') : '') +
        '\n' + body.join('\n'),
      );
    }

    if (rows.length > MAX_MATCHES) {
      sections.push(`\n[... ${rows.length - MAX_MATCHES} additional matches not shown — refine with the \`kind\` arg]`);
    }
    return { content: sections.join('\n\n────────\n\n'), metadata: { matches: rows.length } };
  }
}

// ---------------- stats ----------------

const StatsArgs = z.object({});

export class CodeGraphStatsTool extends Tool<z.infer<typeof StatsArgs>> {
  name = 'code_graph_stats';
  description = 'Show statistics about the indexed code graph (number of files, symbols, last index time).';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = StatsArgs;

  async execute(_args: z.infer<typeof StatsArgs>, _ctx: ToolContext): Promise<ToolResult> {
    const db = requireDB();
    if ('error' in db) return { content: db.error, isError: true };

    const s = db.stats();
    return {
      content: `Code graph stats:
  Files indexed:   ${s.files}
  Symbols indexed: ${s.symbols}
  Last full index: ${s.lastIndexed ?? 'never'}`,
    };
  }
}
