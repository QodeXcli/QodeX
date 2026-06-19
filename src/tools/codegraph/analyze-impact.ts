/**
 * `analyze_impact` tool — blast-radius analysis for a file or symbol.
 *
 * Use BEFORE non-trivial edits to understand what depends on what you're
 * about to touch. Combines:
 *
 *   1. Reverse import graph — every file that imports the target file
 *      (or any of its exports)
 *   2. Symbol-level references — if a symbol name is given, find every call
 *      site via the code-graph index
 *   3. Test coverage hint — list test files in the same/sibling directory
 *      that likely cover the target
 *   4. Config files that reference the target (config blocks, scripts)
 *   5. Risk score: 0 (isolated leaf) to 4 (core module touched by many)
 *
 * Read-only. Outputs structured text the agent can reason over before editing.
 *
 * This is the "warning, this is load-bearing" check Hamed asked for.
 */

import { z } from 'zod';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { logger } from '../../utils/logger.js';

const AnalyzeImpactArgs = z.object({
  target: z.string().min(1).describe(
    'Target to analyze. Either a file path (relative to cwd or absolute) or a symbol name. ' +
    'Examples: "src/auth/login.ts", "getUserData", "Footer.tsx".'
  ),
  symbol: z.string().optional().describe('If target is a file AND you also want symbol-level analysis, name the specific export here.'),
  max_results: z.number().int().min(1).max(2000).optional().describe('Cap on dependent files listed. Default 50.'),
});

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt',
  '__pycache__', '.venv', 'venv', '.cache', 'coverage', 'vendor',
]);

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.php', '.rb', '.go', '.java', '.kt', '.swift', '.rs', '.vue', '.svelte']);

interface FileMatch {
  path: string;
  line: number;
  text: string;
}

/** Walk source files, calling `cb` for each. */
async function walkSource(root: string, cb: (filePath: string) => Promise<void>): Promise<void> {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        stack.push(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!SOURCE_EXTS.has(ext)) continue;
        await cb(full);
      }
    }
  }
}

/** Find files that contain any of the given search patterns (substring match). */
async function searchInProject(
  root: string,
  patterns: string[],
  maxMatches: number,
): Promise<FileMatch[]> {
  const matches: FileMatch[] = [];
  await walkSource(root, async (filePath) => {
    if (matches.length >= maxMatches) return;
    let content: string;
    try { content = await fs.readFile(filePath, 'utf-8'); } catch { return; }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= maxMatches) break;
      const line = lines[i]!;
      for (const pat of patterns) {
        if (line.includes(pat)) {
          matches.push({ path: path.relative(root, filePath), line: i + 1, text: line.trim().slice(0, 200) });
          break;
        }
      }
    }
  });
  return matches;
}

/** Heuristic: produce the import-style patterns for a given file. */
function importPatternsFor(filePath: string, root: string): string[] {
  const rel = path.relative(root, filePath);
  const dir = path.dirname(rel);
  const base = path.basename(rel);
  const stem = base.replace(/\.[^.]+$/, '');

  const patterns: string[] = [];
  // import {x} from "<path>"  /  import "<path>"  / require("<path>")
  patterns.push(`from './${stem}'`, `from "./${stem}"`);
  patterns.push(`from '../${stem}'`, `from "../${stem}"`);
  patterns.push(`from '${rel}'`, `from "${rel}"`);
  patterns.push(`from '${rel.replace(/\.tsx?$/, '')}'`, `from "${rel.replace(/\.tsx?$/, '')}"`);
  patterns.push(`require('${stem}')`, `require("${stem}")`);
  patterns.push(`require('${rel}')`, `require("${rel}")`);
  // Module-path style (TS path alias agnostic)
  patterns.push(`/${stem}'`, `/${stem}"`);
  if (dir !== '.' && dir !== '') {
    patterns.push(`${dir}/${stem}'`, `${dir}/${stem}"`);
  }
  // Python imports — use the stem with dots converted from path separator
  const pyPath = rel.replace(/\\/g, '/').replace(/\.py$/, '').replace(/\//g, '.');
  patterns.push(`from ${pyPath} import`, `import ${pyPath}`);
  return Array.from(new Set(patterns));
}

interface RiskAssessment {
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
  reason: string;
}

function assessRisk(importerCount: number, refCount: number, hasTests: boolean, isConfig: boolean): RiskAssessment {
  if (isConfig) return { score: 4, label: 'CRITICAL', reason: 'Config file — affects build/runtime behavior of the whole project' };
  if (importerCount >= 20 || refCount >= 50) return { score: 4, label: 'HIGH', reason: `Touched by ${importerCount} importers / ${refCount} refs — core module` };
  if (importerCount >= 5 || refCount >= 20) return { score: 3, label: 'ELEVATED', reason: `${importerCount} importers / ${refCount} refs — shared utility/component` };
  if (importerCount >= 1 || refCount >= 5) return { score: 2, label: 'MODERATE', reason: `Used by ${importerCount} importer(s) / ${refCount} refs` };
  if (refCount > 0) return { score: 1, label: 'LOW', reason: 'A few isolated references; small blast radius' };
  return { score: 0, label: 'ISOLATED', reason: 'No detected dependents. Safe to refactor in isolation (but verify with the code-graph index too).' };
}

export class AnalyzeImpactTool extends Tool<z.infer<typeof AnalyzeImpactArgs>> {
  name = 'analyze_impact';
  description = 'Before changing a file or code symbol in THIS local codebase, find every place that depends on it. Returns: importers list, symbol references, test files likely covering it, config files referencing it, and a risk score (0=isolated → 4=critical). Use BEFORE multi-file refactors. The query should be a file path or code identifier — NOT a URL or domain name (matching a domain string against source will just hit unrelated test fixtures). Read-only.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = AnalyzeImpactArgs;

  async execute(args: z.infer<typeof AnalyzeImpactArgs>, ctx: ToolContext): Promise<ToolResult> {
    const root = ctx.cwd;
    const maxResults = args.max_results ?? 50;

    // Determine whether target is a file path or a symbol name
    const absTarget = path.isAbsolute(args.target) ? args.target : path.join(root, args.target);
    let isFile = false;
    let fileExists = false;
    try {
      const stat = await fs.stat(absTarget);
      isFile = stat.isFile();
      fileExists = true;
    } catch { /* not a file */ }

    const lines: string[] = [];
    lines.push(`# Impact Analysis: ${args.target}`);
    lines.push('');

    let importerCount = 0;
    let refCount = 0;
    let isConfigFile = false;

    if (fileExists && isFile) {
      // File-based analysis
      const targetBasename = path.basename(absTarget).toLowerCase();
      isConfigFile = /^(package\.json|tsconfig|vite\.config|webpack\.config|babel\.config|\.eslintrc|jest\.config|vitest\.config|next\.config|tailwind\.config|postcss\.config|pyproject\.toml|cargo\.toml|gemfile|composer\.json|dockerfile)/i.test(targetBasename);

      lines.push(`Target type: file (${path.relative(root, absTarget)})`);
      if (isConfigFile) lines.push(`⚠️  This is a CONFIG file — changes affect build/runtime behavior globally.`);
      lines.push('');

      // Find importers
      const patterns = importPatternsFor(absTarget, root);
      const matches = await searchInProject(root, patterns, maxResults * 3);
      // Don't count the file itself as importing itself
      const targetRel = path.relative(root, absTarget);
      const filtered = matches.filter(m => m.path !== targetRel);
      const uniqueFiles = new Set(filtered.map(m => m.path));
      importerCount = uniqueFiles.size;

      lines.push(`## Importers (${importerCount} unique file${importerCount !== 1 ? 's' : ''})`);
      if (uniqueFiles.size === 0) {
        lines.push('  None detected. This file may be:');
        lines.push('    - An entry point (referenced by config not code)');
        lines.push('    - Truly orphaned (candidate for find_dead_code)');
        lines.push('    - Imported via path-alias (try analyze_impact with the symbol name)');
      } else {
        const shown = Array.from(uniqueFiles).slice(0, maxResults);
        for (const f of shown) {
          const ms = filtered.filter(x => x.path === f).slice(0, 2);
          lines.push(`  ${f}`);
          for (const m of ms) lines.push(`    L${m.line}: ${m.text}`);
        }
        if (uniqueFiles.size > maxResults) lines.push(`  …and ${uniqueFiles.size - maxResults} more`);
      }
      lines.push('');
    }

    // Symbol-level analysis (always run if a symbol arg given, or if target wasn't a file)
    const symbolName = args.symbol ?? (isFile ? undefined : args.target);
    if (symbolName) {
      lines.push(`## Symbol References: \`${symbolName}\``);
      // word-boundary search — best-effort without a full parser
      const matches = await searchInProject(root, [symbolName], maxResults * 3);
      // Filter out declaration lines (where the symbol is defined, not called)
      const declRe = new RegExp(`(function|class|const|let|var|def|fn|public|private)\\s+${symbolName}\\b`);
      const refs = matches.filter(m => !declRe.test(m.text));
      refCount = refs.length;
      if (refs.length === 0) {
        lines.push(`  No references found.`);
      } else {
        const shown = refs.slice(0, maxResults);
        for (const m of shown) {
          lines.push(`  ${m.path}:${m.line}  ${m.text}`);
        }
        if (refs.length > maxResults) lines.push(`  …and ${refs.length - maxResults} more refs`);
      }
      lines.push('');
    }

    // Test coverage hint
    if (fileExists && isFile) {
      const stem = path.basename(absTarget).replace(/\.[^.]+$/, '');
      const testMatches = await searchInProject(root, [stem], 30);
      const tests = testMatches.filter(m => /\.(test|spec)\./.test(m.path) || /__tests__/.test(m.path) || /\/tests?\//.test(m.path));
      const testFiles = Array.from(new Set(tests.map(t => t.path)));
      lines.push(`## Test coverage hint`);
      if (testFiles.length === 0) {
        lines.push(`  ⚠ No test files reference \`${stem}\`. Editing this file is unverified — consider writing tests first or adding manual verification steps.`);
      } else {
        for (const t of testFiles.slice(0, 10)) lines.push(`  - ${t}`);
        if (testFiles.length > 10) lines.push(`  …and ${testFiles.length - 10} more test files`);
      }
      lines.push('');
    }

    // Risk score
    const risk = assessRisk(importerCount, refCount, false, isConfigFile);
    const emoji = ['🟢', '🟡', '🟠', '🔴', '🚨'][risk.score];
    lines.push(`## Risk Assessment: ${emoji} ${risk.label} (${risk.score}/4)`);
    lines.push(`  ${risk.reason}`);
    lines.push('');

    if (risk.score >= 3) {
      lines.push(`## Recommended workflow before changing this`);
      lines.push(`  1. Read the file fully (read_file)`);
      lines.push(`  2. Check 2-3 importers above — understand how they use it`);
      lines.push(`  3. present_plan with the specific edit you'll make + why`);
      lines.push(`  4. Make the edit`);
      lines.push(`  5. auto_fix with the test command to verify nothing broke`);
      lines.push(`  6. If anything fails: /restore to roll back`);
    }

    return {
      content: lines.join('\n'),
      metadata: { importerCount, refCount, risk: risk.score, riskLabel: risk.label },
    };
  }
}
