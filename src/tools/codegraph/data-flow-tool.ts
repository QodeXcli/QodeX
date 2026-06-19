/**
 * `data_flow` — show what external state/symbols a function depends on.
 *
 * Answers "what is this function wired to?" by reporting its free variables
 * (identifiers it uses but doesn't declare): imported symbols, module-level
 * state, store dispatches, db handles, closure captures. Cheap (one tree-sitter
 * pass, no model) and read-only. Pairs with the import graph: free vars tell you
 * WHICH symbols, the import graph tells you which FILE they come from.
 */

import { z } from 'zod';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Tool, type ToolContext, type ToolResult } from '../base.js';

const Args = z.object({
  path: z.string().describe('File to analyze (absolute or relative to cwd).'),
  function_name: z.string().optional().describe('Restrict to one function/method by name. Omit to list every function in the file.'),
});

export class DataFlowTool extends Tool<z.infer<typeof Args>> {
  name = 'data_flow';
  description = 'Show what external state/symbols a function depends on (its free variables: imports, module state, store dispatches, db handles). Answers "what is this function wired to?" without reading the whole file. Read-only, AST-based.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = Args;

  async execute(args: z.infer<typeof Args>, ctx: ToolContext): Promise<ToolResult> {
    const abs = path.isAbsolute(args.path) ? args.path : path.resolve(ctx.cwd, args.path);
    const rel = path.relative(ctx.cwd, abs);
    let content: string;
    try {
      content = await fs.readFile(abs, 'utf-8');
    } catch (e: any) {
      return { content: `[FILE_NOT_FOUND] ${args.path}: ${e.message}`, isError: true };
    }

    const { analyzeDataFlow } = await import('../../context/data-flow.js');
    const flows = await analyzeDataFlow(rel, content);
    if (flows.length === 0) {
      return { content: `No functions found in ${rel} (or language not supported for data-flow analysis).` };
    }

    const filtered = args.function_name
      ? flows.filter(f => f.name === args.function_name || f.name.toLowerCase() === args.function_name!.toLowerCase())
      : flows;

    if (filtered.length === 0) {
      return { content: `No function named "${args.function_name}" in ${rel}. Found: ${flows.map(f => f.name).join(', ')}` };
    }

    const lines = [`# Data-flow dependencies — ${rel}`, ''];
    for (const f of filtered) {
      lines.push(`## ${f.name}  (lines ${f.startLine}-${f.endLine})`);
      if (f.freeVars.length === 0) {
        lines.push('  (self-contained — no external dependencies)');
      } else {
        lines.push('  External symbols used (most-referenced first):');
        for (const v of f.freeVars) {
          lines.push(`    - ${v.name}${v.count > 1 ? ` (×${v.count})` : ''}`);
        }
      }
      lines.push('');
    }
    lines.push('Tip: cross-reference these symbols with `find_symbol` / the import graph to locate which files define them.');
    return { content: lines.join('\n'), metadata: { functionCount: filtered.length } };
  }
}
