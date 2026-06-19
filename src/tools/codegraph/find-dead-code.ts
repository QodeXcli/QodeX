/**
 * `find_dead_code` tool — detect orphaned files, unused exports, and uncalled
 * functions across the project.
 *
 * Three layers of "dead":
 *
 *   1. **Orphaned files** — source files that no other source file imports
 *      and that don't appear as entry points (package.json main/bin, config
 *      references, test discovery globs). Most actionable: candidates for
 *      deletion.
 *
 *   2. **Unused exports** — `export function X` / `export const X` / `export
 *      default` where no other file references X across the project. Even
 *      if the containing file IS imported, individual exports can be dead.
 *
 *   3. **Uncalled local functions** — function declarations that are never
 *      called within their own file. Lower confidence (dynamic calls hide
 *      from grep), so labeled "review" not "delete".
 *
 * IMPORTANT — false-positive sources we explicitly warn about:
 *   - Entry points referenced only by config (Vite, Webpack, Next.js routes,
 *     bin scripts, server entry, plugin hooks). We try to detect common
 *     cases; review before deleting.
 *   - Dynamic require/import (`require(varName)`, `import(varName)`)
 *   - Reflection / decorators (`@SomeDecorator`)
 *   - Templates (Vue/Svelte/Astro <script>+<template>)
 *   - WordPress action/filter hooks (PHP) — invisible call edges
 *
 * Read-only. Output is a structured report, NOT a delete command.
 * The agent should propose deletions via safe_delete_file, not act directly.
 */

import { z } from 'zod';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Tool, type ToolContext, type ToolResult } from '../base.js';

const FindDeadCodeArgs = z.object({
  scope: z.enum(['files', 'exports', 'functions', 'all']).optional().describe('Which kind of dead code to look for. Default: all.'),
  path: z.string().optional().describe('Restrict scan to this subdirectory (relative to cwd). Default: full project.'),
  max_files: z.number().int().min(1).max(50_000).optional().describe('File scan cap. Default 10000.'),
  include_tests: z.boolean().optional().describe('If true, include test files when looking for usage. Usually false (you might WANT to delete a test). Default false.'),
});

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt',
  '__pycache__', '.venv', 'venv', '.cache', 'coverage', 'vendor', '.idea',
]);

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.php', '.rb', '.go', '.vue', '.svelte', '.astro']);

const TEST_EXT_RE = /\.(test|spec)\.[jt]sx?$|__tests__\/|\/tests?\/|_test\.py$|test_.*\.py$/;

const ENTRY_HINT_PATTERNS = [
  // Files that are likely entry points and shouldn't be flagged
  /^index\.(t|j)sx?$/, /^main\.(t|j)sx?$/, /^app\.(t|j)sx?$/,
  /^server\.(t|j)sx?$/, /^cli\.(t|j)sx?$/, /^bin\//,
  /\/pages\//, /\/app\//, /\/routes\//, /\/api\//,
  /^manage\.py$/, /^app\.py$/, /^main\.py$/, /^wsgi\.py$/, /^asgi\.py$/, /__init__\.py$/,
];

interface FileInfo {
  abs: string;
  rel: string;
  content: string;
  ext: string;
  isTest: boolean;
}

async function walkSource(root: string, maxFiles: number): Promise<FileInfo[]> {
  const out: FileInfo[] = [];
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
          const rel = path.relative(root, abs);
          out.push({ abs, rel, content, ext, isTest: TEST_EXT_RE.test(rel) });
        } catch { /* skip */ }
      }
    }
  }
  return out;
}

function isLikelyEntryPoint(rel: string, packageJson: any): boolean {
  if (ENTRY_HINT_PATTERNS.some(p => p.test(rel))) return true;
  if (packageJson) {
    if (packageJson.main && rel === packageJson.main.replace(/^\.\//, '')) return true;
    if (packageJson.module && rel === packageJson.module.replace(/^\.\//, '')) return true;
    if (packageJson.bin) {
      const bins = typeof packageJson.bin === 'string' ? [packageJson.bin] : Object.values(packageJson.bin);
      if (bins.some((b: any) => typeof b === 'string' && rel === b.replace(/^\.\//, ''))) return true;
    }
    if (Array.isArray(packageJson.files) && packageJson.files.some((f: string) => rel.startsWith(f))) {
      // listed in `files` — meant to ship to npm, treat as potential entry
      return true;
    }
  }
  return false;
}

/** Build the set of "anything that looks like an import or reference TO `target`'s stem". */
function buildReferencePatterns(targetRel: string): string[] {
  const stem = path.basename(targetRel).replace(/\.[^.]+$/, '');
  const noExt = targetRel.replace(/\.[^.]+$/, '');
  return [
    // ES imports
    `from './${stem}'`, `from "./${stem}"`,
    `from '../${stem}'`, `from "../${stem}"`,
    `from '${noExt}'`, `from "${noExt}"`,
    `from '/${noExt}'`, `from "/${noExt}"`,
    // require
    `require('${stem}')`, `require("${stem}")`,
    `require('${noExt}')`, `require("${noExt}")`,
    // module path (in path-alias projects)
    `'/${stem}'`, `"/${stem}"`,
    `/${stem}'`, `/${stem}"`,
    // Python
    `import ${noExt.replace(/[/\\]/g, '.')}`,
    `from ${noExt.replace(/[/\\]/g, '.')} import`,
  ];
}

/** Extract `export` names (ES/TS only) from file content. Imperfect but pragmatic. */
function extractExports(content: string): { name: string; line: number }[] {
  const out: { name: string; line: number }[] = [];
  const lines = content.split('\n');
  const reExportNamed = /^\s*export\s+(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;
  const reExportBlock = /^\s*export\s+\{([^}]+)\}/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m1 = reExportNamed.exec(line);
    if (m1) out.push({ name: m1[1]!, line: i + 1 });
    const m2 = reExportBlock.exec(line);
    if (m2) {
      for (const part of m2[1]!.split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0]!.trim();
        if (name) out.push({ name, line: i + 1 });
      }
    }
  }
  return out;
}

/** Extract local (non-exported) function declarations. */
function extractLocalFunctions(content: string): { name: string; line: number }[] {
  const out: { name: string; line: number }[] = [];
  const lines = content.split('\n');
  const reLocal = /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/;
  const reArrow = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Skip exports — those are covered by extractExports
    if (/^\s*export\s/.test(line)) continue;
    const m1 = reLocal.exec(line);
    if (m1) out.push({ name: m1[1]!, line: i + 1 });
    const m2 = reArrow.exec(line);
    if (m2) out.push({ name: m2[1]!, line: i + 1 });
  }
  return out;
}

export class FindDeadCodeTool extends Tool<z.infer<typeof FindDeadCodeArgs>> {
  name = 'find_dead_code';
  description = 'Detect orphaned source files, unused exports, and uncalled local functions across the project. Returns a structured report — does NOT delete anything. Use before cleanup refactors. Read-only.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = FindDeadCodeArgs;

  async execute(args: z.infer<typeof FindDeadCodeArgs>, ctx: ToolContext): Promise<ToolResult> {
    const root = args.path ? path.join(ctx.cwd, args.path) : ctx.cwd;
    const maxFiles = args.max_files ?? 10_000;
    const scope = args.scope ?? 'all';
    const includeTests = args.include_tests ?? false;

    const files = await walkSource(root, maxFiles);

    // package.json for entry-point hinting
    let pkg: any = null;
    try { pkg = JSON.parse(await fs.readFile(path.join(ctx.cwd, 'package.json'), 'utf-8')); } catch { /* none */ }

    const lines: string[] = [];
    lines.push(`# Dead Code Report`);
    lines.push(`Scanned ${files.length} source file(s) in ${path.relative(ctx.cwd, root) || '.'}`);
    lines.push(`Scope: ${scope}${includeTests ? ' (incl. tests)' : ' (excl. tests)'}`);
    lines.push('');

    // ─── 1. Orphaned files ───
    const orphanedFiles: { rel: string; isEntry: boolean; reason: string }[] = [];
    if (scope === 'files' || scope === 'all') {
      // For each non-test file, check if anyone references it
      const refSources = includeTests ? files : files.filter(f => !f.isTest);
      for (const target of files) {
        if (target.isTest) continue; // we don't flag test files as dead
        const isEntry = isLikelyEntryPoint(target.rel, pkg);
        if (isEntry) continue; // skip entry points

        const patterns = buildReferencePatterns(target.rel);
        let referenced = false;
        for (const src of refSources) {
          if (src.abs === target.abs) continue;
          for (const pat of patterns) {
            if (src.content.includes(pat)) { referenced = true; break; }
          }
          if (referenced) break;
        }
        if (!referenced) {
          orphanedFiles.push({
            rel: target.rel,
            isEntry: false,
            reason: 'No imports detected. May still be referenced by config, dynamic import, or framework convention.',
          });
        }
      }

      lines.push(`## 1. Orphaned files (${orphanedFiles.length})`);
      if (orphanedFiles.length === 0) {
        lines.push(`  None detected — every non-test file appears to be imported somewhere.`);
      } else {
        lines.push(`  ⚠ Before deleting any of these, run:  analyze_impact target="<path>"`);
        lines.push(``);
        for (const f of orphanedFiles.slice(0, 80)) lines.push(`  - ${f.rel}`);
        if (orphanedFiles.length > 80) lines.push(`  …and ${orphanedFiles.length - 80} more`);
      }
      lines.push('');
    }

    // ─── 2. Unused exports ───
    const unusedExports: { file: string; symbol: string; line: number }[] = [];
    if (scope === 'exports' || scope === 'all') {
      const refSources = includeTests ? files : files.filter(f => !f.isTest);
      for (const target of files) {
        if (target.isTest) continue;
        // Skip JSX/Vue/Svelte — exported components are referenced by name in templates we don't parse
        if (target.ext === '.tsx' || target.ext === '.jsx' || target.ext === '.vue' || target.ext === '.svelte' || target.ext === '.astro') continue;
        const exports = extractExports(target.content);
        for (const ex of exports) {
          // Word-boundary search across other files
          const re = new RegExp(`\\b${ex.name}\\b`);
          let found = false;
          for (const src of refSources) {
            if (src.abs === target.abs) continue;
            if (re.test(src.content)) { found = true; break; }
          }
          if (!found) unusedExports.push({ file: target.rel, symbol: ex.name, line: ex.line });
        }
      }
      lines.push(`## 2. Unused exports (${unusedExports.length})`);
      if (unusedExports.length === 0) {
        lines.push(`  None detected.`);
      } else {
        lines.push(`  ⚠ Components/types referenced only in JSX/templates may be false positives.`);
        lines.push(``);
        for (const e of unusedExports.slice(0, 60)) lines.push(`  - ${e.file}:${e.line}  ${e.symbol}`);
        if (unusedExports.length > 60) lines.push(`  …and ${unusedExports.length - 60} more`);
      }
      lines.push('');
    }

    // ─── 3. Uncalled local functions ───
    const uncalledLocals: { file: string; symbol: string; line: number }[] = [];
    if (scope === 'functions' || scope === 'all') {
      for (const target of files) {
        if (target.isTest) continue;
        const locals = extractLocalFunctions(target.content);
        for (const fn of locals) {
          // Search within the same file (locals only used within file)
          const re = new RegExp(`\\b${fn.name}\\s*\\(`);
          const occurrences = (target.content.match(re) || []).length;
          // Declaration itself counts as one occurrence. If only 1, it's never called.
          if (occurrences <= 1) {
            uncalledLocals.push({ file: target.rel, symbol: fn.name, line: fn.line });
          }
        }
      }
      lines.push(`## 3. Uncalled local functions (${uncalledLocals.length}) — review only`);
      if (uncalledLocals.length === 0) {
        lines.push(`  None detected.`);
      } else {
        lines.push(`  ⚠ Dynamic calls (event handlers, decorators, reflection) won't show here.`);
        lines.push(``);
        for (const f of uncalledLocals.slice(0, 60)) lines.push(`  - ${f.file}:${f.line}  ${f.symbol}()`);
        if (uncalledLocals.length > 60) lines.push(`  …and ${uncalledLocals.length - 60} more`);
      }
      lines.push('');
    }

    lines.push(`## Next steps`);
    lines.push(`  • For any file you want to delete: analyze_impact target="<path>" (confirm zero importers)`);
    lines.push(`  • Then: safe_delete_file path="<path>"  (snapshots first, refuses if anything imports)`);
    lines.push(`  • Don't auto-delete from this report — false positives are common, especially around:`);
    lines.push(`      • framework conventions (Next.js routes, plugin hooks, WordPress filters)`);
    lines.push(`      • path-alias imports the regex didn't catch`);
    lines.push(`      • runtime/string imports`);

    return {
      content: lines.join('\n'),
      metadata: {
        orphanedFileCount: orphanedFiles.length,
        unusedExportCount: unusedExports.length,
        uncalledLocalCount: uncalledLocals.length,
      },
    };
  }
}
