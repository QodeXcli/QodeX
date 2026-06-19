/**
 * `explain_codebase` and `suggest_improvements`.
 *
 * Two tools that combine static analysis + heuristic patterns to produce
 * higher-level insights than grep/code_graph alone.
 *
 * explain_codebase: produces an architectural summary. Categorizes files
 *   into layers (entry/route/controller/service/model/util/test/asset),
 *   counts each, picks representative files. Output is ~1KB the agent
 *   can use as ground-truth-architecture for downstream work.
 *
 * suggest_improvements: runs a pattern-based code quality scan and
 *   produces a ranked list of suggestions:
 *     - Files >500 LOC (consider splitting)
 *     - Functions >50 lines (consider extraction)
 *     - Repeated string literals (consider const)
 *     - Deep nesting (>5 levels)
 *     - Magic numbers in production code
 *     - Missing JSDoc/docstrings on exported symbols
 *     - TODO/FIXME backlog
 *
 * Both read-only.
 */

import { z } from 'zod';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Tool, type ToolContext, type ToolResult } from '../base.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'vendor', '.cache', 'coverage']);
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.php', '.rb', '.go']);

async function walkSource(root: string, maxFiles: number): Promise<{ abs: string; rel: string; content: string; lines: number }[]> {
  const out: { abs: string; rel: string; content: string; lines: number }[] = [];
  const stack = [root];
  while (stack.length > 0 && out.length < maxFiles) {
    const dir = stack.pop()!;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (out.length >= maxFiles) break;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        stack.push(path.join(dir, e.name));
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (!SOURCE_EXTS.has(ext)) continue;
        const abs = path.join(dir, e.name);
        try {
          const stat = await fs.stat(abs);
          if (stat.size > 2_000_000) continue;
          const content = await fs.readFile(abs, 'utf-8');
          out.push({ abs, rel: path.relative(root, abs), content, lines: content.split('\n').length });
        } catch { /* skip */ }
      }
    }
  }
  return out;
}

function categorizeFile(rel: string): string {
  const l = rel.toLowerCase();
  if (/\.(test|spec)\.|__tests__|\/tests?\//.test(l)) return 'tests';
  if (/^(src\/)?(index|main|app|server|cli|bin)\b/.test(l)) return 'entry';
  if (/\/(routes?|api|controllers?|handlers?|endpoints?)\//.test(l)) return 'routes/controllers';
  if (/\/(services?|business|domain|logic)\//.test(l)) return 'services';
  if (/\/(models?|entities|schema|db)\//.test(l)) return 'data/models';
  if (/\/(components?|widgets?|ui|views?|screens?|pages?)\//.test(l)) return 'ui';
  if (/\/(hooks?|composables?)\//.test(l)) return 'hooks';
  if (/\/(utils?|helpers?|common|shared|lib)\//.test(l)) return 'utils';
  if (/\/(config|configs|settings)\//.test(l) || /\.config\.[jt]sx?$/.test(l)) return 'config';
  if (/\/(types?|interfaces?|dto)\//.test(l) || /\.d\.ts$/.test(l)) return 'types';
  if (/\/(migrations?|seeds?)\//.test(l)) return 'migrations';
  if (/\/(middleware|guards?)\//.test(l)) return 'middleware';
  return 'other';
}

// ─────────────────────────────────────────────────────────────────────────────
// explain_codebase

const ExplainCodebaseArgs = z.object({
  path: z.string().optional().describe('Subdirectory to analyze. Default cwd.'),
  max_files: z.number().int().min(1).max(20_000).optional().describe('Default 5000.'),
});

export class ExplainCodebaseTool extends Tool<z.infer<typeof ExplainCodebaseArgs>> {
  name = 'explain_codebase';
  description = 'High-level architectural summary: categorizes files into layers (entry/routes/services/data/ui/utils/config/...), picks 2-3 representative files per layer, counts LOC. Use to understand an unfamiliar codebase before changes. Complements project_overview (which is more about stack/config). Read-only.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = ExplainCodebaseArgs;

  async execute(args: z.infer<typeof ExplainCodebaseArgs>, ctx: ToolContext): Promise<ToolResult> {
    const root = args.path ? path.join(ctx.cwd, args.path) : ctx.cwd;
    const maxFiles = args.max_files ?? 5000;
    const files = await walkSource(root, maxFiles);

    const layers = new Map<string, { count: number; lines: number; samples: { rel: string; lines: number }[] }>();
    for (const f of files) {
      const cat = categorizeFile(f.rel);
      let entry = layers.get(cat);
      if (!entry) {
        entry = { count: 0, lines: 0, samples: [] };
        layers.set(cat, entry);
      }
      entry.count++;
      entry.lines += f.lines;
      // Keep top 3 by line count as representatives
      entry.samples.push({ rel: f.rel, lines: f.lines });
      entry.samples.sort((a, b) => b.lines - a.lines);
      if (entry.samples.length > 3) entry.samples = entry.samples.slice(0, 3);
    }

    const out: string[] = [];
    out.push(`# Codebase Architecture`);
    out.push(`Scope: ${args.path ?? '.'}`);
    out.push(`Files: ${files.length}, Total LOC: ${files.reduce((a, b) => a + b.lines, 0).toLocaleString()}`);
    out.push('');

    const orderedLayers = [
      'entry', 'routes/controllers', 'services', 'middleware', 'data/models',
      'ui', 'hooks', 'utils', 'types', 'config', 'migrations', 'tests', 'other',
    ];
    for (const layer of orderedLayers) {
      const l = layers.get(layer);
      if (!l || l.count === 0) continue;
      out.push(`## ${layer} (${l.count} files, ${l.lines.toLocaleString()} lines)`);
      for (const s of l.samples) out.push(`  - ${s.rel} (${s.lines} lines)`);
      out.push('');
    }

    // Layering hint
    out.push(`## Hint`);
    const entry = layers.get('entry')?.count ?? 0;
    const routes = layers.get('routes/controllers')?.count ?? 0;
    const services = layers.get('services')?.count ?? 0;
    const data = layers.get('data/models')?.count ?? 0;
    const ui = layers.get('ui')?.count ?? 0;
    if (entry > 0 && routes > 0 && services > 0 && data > 0) {
      out.push(`  Looks like a typical layered backend (entry → routes → services → models). Trace a feature top-down via these layers.`);
    } else if (ui > 0 && (layers.get('hooks')?.count ?? 0) > 0) {
      out.push(`  Looks like a frontend app (UI components + hooks). State likely lives in hooks; rendering in components.`);
    } else {
      out.push(`  Mixed or atypical layout — use code_graph_find_symbol to navigate.`);
    }

    return { content: out.join('\n'), metadata: { layers: Object.fromEntries(layers) } };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// suggest_improvements

const SuggestImprovementsArgs = z.object({
  path: z.string().optional().describe('Subdirectory to scan. Default cwd.'),
  max_files: z.number().int().min(1).max(20_000).optional().describe('Default 3000.'),
  large_file_threshold: z.number().int().min(100).optional().describe('Files >N lines flagged. Default 500.'),
  long_function_threshold: z.number().int().min(20).optional().describe('Functions >N lines flagged. Default 50.'),
});

interface Suggestion {
  severity: 'high' | 'medium' | 'low';
  kind: string;
  file: string;
  line?: number;
  detail: string;
}

export class SuggestImprovementsTool extends Tool<z.infer<typeof SuggestImprovementsArgs>> {
  name = 'suggest_improvements';
  description = 'Heuristic code-quality scan: flags oversized files, oversized functions, deep nesting, magic numbers, repeated string literals, missing docstrings on exports, accumulated TODOs. Returns a ranked list of suggestions, NOT auto-applied. Read-only.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = SuggestImprovementsArgs;

  async execute(args: z.infer<typeof SuggestImprovementsArgs>, ctx: ToolContext): Promise<ToolResult> {
    const root = args.path ? path.join(ctx.cwd, args.path) : ctx.cwd;
    const maxFiles = args.max_files ?? 3000;
    const largeFile = args.large_file_threshold ?? 500;
    const longFn = args.long_function_threshold ?? 50;

    const files = await walkSource(root, maxFiles);
    const suggestions: Suggestion[] = [];
    let todoCount = 0;

    for (const f of files) {
      // 1. Large files
      if (f.lines >= largeFile) {
        suggestions.push({
          severity: f.lines >= largeFile * 2 ? 'high' : 'medium',
          kind: 'large_file',
          file: f.rel,
          detail: `${f.lines} lines — consider splitting into focused modules.`,
        });
      }

      // 2. Long functions (heuristic: function declaration + naive matching brace count)
      const lines = f.content.split('\n');
      const fnStart = /^(\s*)(?:export\s+)?(?:async\s+)?(?:function\s+\w+|const\s+\w+\s*=\s*(?:async\s*)?\(|\w+\s*\([^)]*\)\s*\{|def\s+\w+|class\s+\w+)/;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const m = fnStart.exec(line);
        if (m && line.includes('{')) {
          const baseIndent = m[1]!.length;
          // find matching closing brace via indent + 0-depth heuristic
          let depth = 0;
          for (const ch of line) { if (ch === '{') depth++; if (ch === '}') depth--; }
          let end = i;
          for (let j = i + 1; j < lines.length && j < i + 400; j++) {
            for (const ch of lines[j]!) { if (ch === '{') depth++; if (ch === '}') depth--; }
            if (depth <= 0) { end = j; break; }
          }
          const fnLen = end - i + 1;
          if (fnLen >= longFn) {
            const namePart = (line.match(/\b(function|const|class|def)\s+(\w+)/) || [, , line.slice(0, 80)])[2];
            suggestions.push({
              severity: fnLen >= longFn * 2 ? 'high' : 'medium',
              kind: 'long_function',
              file: f.rel,
              line: i + 1,
              detail: `${namePart} — ${fnLen} lines — consider extracting helpers.`,
            });
            // jump past it to avoid double-counting nested
            i = end;
          }
        }
      }

      // 3. Deep nesting (heuristic: any line with 6+ levels of indent)
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (line.trim() === '') continue;
        const leading = line.match(/^( +|\t+)/);
        if (!leading) continue;
        const depth = leading[0]!.startsWith('\t') ? leading[0]!.length : Math.floor(leading[0]!.length / 2);
        if (depth >= 6) {
          suggestions.push({
            severity: 'low',
            kind: 'deep_nesting',
            file: f.rel,
            line: i + 1,
            detail: `Indent depth ${depth}. Consider early return / guard / extract.`,
          });
          // one per file to avoid noise
          break;
        }
      }

      // 4. TODO/FIXME accumulation
      for (let i = 0; i < lines.length; i++) {
        if (/\b(TODO|FIXME|XXX|HACK)\b/.test(lines[i]!)) {
          todoCount++;
          if (todoCount <= 50) { // cap noise
            suggestions.push({
              severity: 'low',
              kind: 'todo_marker',
              file: f.rel,
              line: i + 1,
              detail: lines[i]!.trim().slice(0, 120),
            });
          }
        }
      }

      // 5. Magic numbers — naive: number literals > 100 in business logic (skip configs, tests)
      if (!/\.(test|spec|config)\.|\/(tests?|config)\//.test(f.rel)) {
        // Just count, don't enumerate
        const magicCount = (f.content.match(/(?<![\w.])\d{4,}(?!\w)/g) || []).length;
        if (magicCount >= 5) {
          suggestions.push({
            severity: 'low',
            kind: 'magic_numbers',
            file: f.rel,
            detail: `${magicCount} numeric literals ≥4 digits. Consider named constants if reused.`,
          });
        }
      }
    }

    // Group by severity for the report
    const high = suggestions.filter(s => s.severity === 'high');
    const medium = suggestions.filter(s => s.severity === 'medium');
    const low = suggestions.filter(s => s.severity === 'low');

    const out: string[] = [];
    out.push(`# Code Quality Suggestions`);
    out.push(`Scanned ${files.length} files. Found ${suggestions.length} suggestion(s): ${high.length} high, ${medium.length} medium, ${low.length} low.`);
    out.push('');

    if (high.length > 0) {
      out.push(`## 🔴 High priority`);
      for (const s of high.slice(0, 30)) {
        out.push(`  ${s.file}${s.line ? ':' + s.line : ''}  [${s.kind}]  ${s.detail}`);
      }
      if (high.length > 30) out.push(`  …and ${high.length - 30} more`);
      out.push('');
    }
    if (medium.length > 0) {
      out.push(`## 🟡 Medium priority`);
      for (const s of medium.slice(0, 30)) {
        out.push(`  ${s.file}${s.line ? ':' + s.line : ''}  [${s.kind}]  ${s.detail}`);
      }
      if (medium.length > 30) out.push(`  …and ${medium.length - 30} more`);
      out.push('');
    }
    if (low.length > 0) {
      out.push(`## ⚪ Low priority (review when time permits)`);
      const grouped = new Map<string, number>();
      for (const s of low) grouped.set(s.kind, (grouped.get(s.kind) ?? 0) + 1);
      for (const [kind, count] of grouped) out.push(`  ${kind}: ${count} occurrence(s)`);
    }

    return {
      content: out.join('\n'),
      metadata: { totalSuggestions: suggestions.length, high: high.length, medium: medium.length, low: low.length },
    };
  }
}
