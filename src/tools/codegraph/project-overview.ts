/**
 * `project_overview` tool — comprehensive project structure scan.
 *
 * Returns a single text payload covering EVERYTHING a refactoring agent
 * should know before making non-trivial changes:
 *
 *   - Tech stack (framework, languages, package manager, test runner)
 *   - Entry points (main, bin, scripts)
 *   - Build / config files (tsconfig, vite.config, webpack, babel, eslint, prettier)
 *   - CI / deployment (.github/workflows, .gitlab-ci, Dockerfile)
 *   - Tests (where, what runner, rough count)
 *   - Migrations (if a DB layer is detected)
 *   - Subpackage boundaries (workspaces, lerna, etc)
 *   - Code statistics: file count, total LOC, top 10 biggest files
 *
 * The output is meant to be READ by the agent and synthesized into a plan.
 * It is NOT a dependency graph (that's analyze_impact's job).
 *
 * Read-only; safe to call anywhere.
 */

import { z } from 'zod';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { logger } from '../../utils/logger.js';

const ProjectOverviewArgs = z.object({
  path: z.string().optional().describe('Directory to scan (absolute, or relative to the working dir). Defaults to the current working directory. Use this to overview a DIFFERENT local folder (e.g. an uploaded project) instead of the one QodeX was started in.'),
  max_files: z.number().int().min(1).max(50_000).optional().describe('Cap on files scanned. Default 10000. Set lower for a faster sample.'),
});

interface FileStat {
  path: string;
  size: number;
  lines: number;
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt',
  'target', '__pycache__', '.venv', 'venv', '.cache', 'coverage',
  '.pytest_cache', '.mypy_cache', '.ruff_cache', '.parcel-cache',
  'vendor', '.idea', '.vscode-test',
]);

const CONFIG_PATTERNS = [
  /^package\.json$/, /^tsconfig.*\.json$/, /^jsconfig\.json$/,
  /^vite\.config\.[jt]s$/, /^webpack\.config\.[jt]s$/, /^rollup\.config\.[jt]s$/,
  /^babel\.config\.[jt]s$/, /^\.babelrc/, /^\.eslintrc/, /^eslint\.config\./,
  /^\.prettierrc/, /^prettier\.config/, /^pyproject\.toml$/, /^setup\.py$/,
  /^Cargo\.toml$/, /^go\.mod$/, /^pom\.xml$/, /^build\.gradle$/,
  /^Gemfile$/, /^composer\.json$/, /^Dockerfile$/, /^docker-compose\./,
  /^\.gitignore$/, /^\.env\.example$/, /^Makefile$/, /^\.editorconfig$/,
  /^next\.config\./, /^nuxt\.config\./, /^tailwind\.config\./, /^postcss\.config\./,
  /^jest\.config\./, /^vitest\.config\./, /^playwright\.config\./, /^cypress\.config\./,
];

const CI_PATTERNS = [
  /\.github\/workflows\//, /\.gitlab-ci\.yml$/, /\.circleci\//,
  /Jenkinsfile$/, /\.travis\.yml$/, /azure-pipelines\.yml$/,
];

const TEST_HINT_PATTERNS = [
  /\.test\.[jt]sx?$/, /\.spec\.[jt]sx?$/, /__tests__\//, /\/tests?\//, /_test\.py$/,
  /test_.*\.py$/, /_test\.go$/, /\.feature$/,
];

const MIGRATION_PATTERNS = [
  /\/migrations?\//, /\/migrate\//, /\/db\/migrations\//,
  /^V\d+__.*\.sql$/, /^\d{14}_.*\.rb$/, /^\d{4}_.*\.py$/,
];

async function walkDir(
  root: string,
  maxFiles: number,
): Promise<{ files: FileStat[]; truncated: boolean }> {
  const files: FileStat[] = [];
  let truncated = false;
  const stack: string[] = [root];
  while (stack.length > 0 && files.length < maxFiles) {
    const dir = stack.pop()!;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (files.length >= maxFiles) { truncated = true; break; }
      if (entry.name.startsWith('.') && entry.name !== '.github' && entry.name !== '.gitlab-ci.yml' && entry.name !== '.env.example' && entry.name !== '.editorconfig' && entry.name !== '.eslintrc' && entry.name !== '.prettierrc' && entry.name !== '.gitignore') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          const stat = await fs.stat(full);
          if (stat.size > 5_000_000) continue; // skip huge files
          const buf = await fs.readFile(full, 'utf-8').catch(() => null);
          const lines = buf ? buf.split('\n').length : 0;
          files.push({
            path: path.relative(root, full),
            size: stat.size,
            lines,
          });
        } catch { /* unreadable, skip */ }
      }
    }
  }
  return { files, truncated };
}

function detectLanguages(files: FileStat[]): Record<string, { files: number; lines: number }> {
  const stats: Record<string, { files: number; lines: number }> = {};
  for (const f of files) {
    const ext = path.extname(f.path).toLowerCase().slice(1);
    if (!ext) continue;
    const lang = LANG_BY_EXT[ext];
    if (!lang) continue;
    if (!stats[lang]) stats[lang] = { files: 0, lines: 0 };
    stats[lang].files++;
    stats[lang].lines += f.lines;
  }
  return stats;
}

const LANG_BY_EXT: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript',
  mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', rb: 'Ruby', go: 'Go', rs: 'Rust',
  java: 'Java', kt: 'Kotlin', swift: 'Swift', m: 'Objective-C', mm: 'Objective-C',
  c: 'C', h: 'C', cpp: 'C++', cc: 'C++', hpp: 'C++', cxx: 'C++',
  cs: 'C#', php: 'PHP', sh: 'Shell', bash: 'Shell', zsh: 'Shell',
  sql: 'SQL', html: 'HTML', css: 'CSS', scss: 'SCSS', sass: 'SCSS', less: 'LESS',
  vue: 'Vue', svelte: 'Svelte', astro: 'Astro',
  md: 'Markdown', mdx: 'MDX', yaml: 'YAML', yml: 'YAML', toml: 'TOML', json: 'JSON',
  xml: 'XML', proto: 'Proto', graphql: 'GraphQL', gql: 'GraphQL',
};

/**
 * Reads + parses a JSON config. Returns null when the file is simply absent
 * (ENOENT), but on a real parse failure logs a warning and records the path in
 * `unparseable` so the caller can surface the corruption instead of silently
 * misreporting the tech stack as "config absent".
 */
async function readJsonOrNull(filePath: string, unparseable?: string[]): Promise<any> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8'));
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      logger.warn(`Failed to parse ${filePath}: ${err?.message ?? err}`);
      unparseable?.push(filePath);
    }
    return null;
  }
}

export class ProjectOverviewTool extends Tool<z.infer<typeof ProjectOverviewArgs>> {
  name = 'project_overview';
  description = 'Comprehensive scan of a LOCAL code project on disk: tech stack, entry points, config files, CI, tests, migrations, language stats, biggest files. Scans the working dir by default, or a `path` you pass. Use BEFORE making non-trivial code changes. This is for source code on disk — NOT for analyzing a website or URL (use seo_audit / web_fetch for those). Read-only.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = ProjectOverviewArgs;

  async execute(args: z.infer<typeof ProjectOverviewArgs>, ctx: ToolContext): Promise<ToolResult> {
    const root = args.path ? path.resolve(ctx.cwd, args.path) : ctx.cwd;
    const maxFiles = args.max_files ?? 10_000;
    const { files, truncated } = await walkDir(root, maxFiles);

    const lines: string[] = [];
    lines.push(`# Project Overview: ${path.basename(root)}`);
    lines.push(`Path: ${root}`);
    lines.push(`Files scanned: ${files.length}${truncated ? ' (truncated)' : ''}`);
    lines.push('');

    // Language stats
    const langs = detectLanguages(files);
    const langList = Object.entries(langs)
      .sort((a, b) => b[1].lines - a[1].lines)
      .slice(0, 10);
    lines.push('## Languages (by total lines)');
    for (const [lang, s] of langList) {
      lines.push(`  ${lang.padEnd(15)} ${s.files.toLocaleString().padStart(6)} files, ${s.lines.toLocaleString()} lines`);
    }
    lines.push('');

    // package.json info
    const unparseable: string[] = [];
    const pkg = await readJsonOrNull(path.join(root, 'package.json'), unparseable);
    if (unparseable.length > 0) {
      lines.push('## ⚠ Unparseable config files');
      lines.push('  The following config files exist but could not be parsed; tech-stack detection below may be incomplete:');
      for (const f of unparseable) lines.push(`  - ${path.relative(root, f) || path.basename(f)}`);
      lines.push('');
    }
    if (pkg) {
      lines.push('## Node.js Project (package.json)');
      lines.push(`  Name:     ${pkg.name ?? '(unnamed)'}`);
      lines.push(`  Version:  ${pkg.version ?? '?'}`);
      if (pkg.description) lines.push(`  Desc:     ${pkg.description}`);
      if (pkg.main) lines.push(`  Main:     ${pkg.main}`);
      if (pkg.bin) lines.push(`  Bin:      ${typeof pkg.bin === 'string' ? pkg.bin : Object.keys(pkg.bin).join(', ')}`);
      if (pkg.scripts) {
        lines.push(`  Scripts:`);
        for (const [n, cmd] of Object.entries(pkg.scripts)) lines.push(`    ${n}: ${cmd}`);
      }
      const depCount = Object.keys(pkg.dependencies ?? {}).length;
      const devDepCount = Object.keys(pkg.devDependencies ?? {}).length;
      const peerCount = Object.keys(pkg.peerDependencies ?? {}).length;
      const optCount = Object.keys(pkg.optionalDependencies ?? {}).length;
      lines.push(`  Deps:     ${depCount} runtime, ${devDepCount} dev${peerCount ? `, ${peerCount} peer` : ''}${optCount ? `, ${optCount} optional` : ''}`);
      if (pkg.workspaces) {
        lines.push(`  Workspaces: ${Array.isArray(pkg.workspaces) ? pkg.workspaces.join(', ') : JSON.stringify(pkg.workspaces)}`);
      }
      lines.push('');
    }

    // Other config files
    const configs = files.filter(f => {
      const base = path.basename(f.path);
      return CONFIG_PATTERNS.some(p => p.test(base));
    });
    if (configs.length > 0) {
      lines.push('## Build / Config Files');
      for (const c of configs.slice(0, 30)) lines.push(`  - ${c.path}`);
      if (configs.length > 30) lines.push(`  …and ${configs.length - 30} more`);
      lines.push('');
    }

    // CI files
    const ciFiles = files.filter(f => CI_PATTERNS.some(p => p.test(f.path)));
    if (ciFiles.length > 0) {
      lines.push('## CI / Deployment');
      for (const c of ciFiles) lines.push(`  - ${c.path}`);
      lines.push('');
    }

    // Tests
    const tests = files.filter(f => TEST_HINT_PATTERNS.some(p => p.test(f.path)));
    if (tests.length > 0) {
      lines.push(`## Tests (${tests.length} file(s))`);
      const totalTestLines = tests.reduce((a, b) => a + b.lines, 0);
      lines.push(`  Total test lines: ${totalTestLines.toLocaleString()}`);
      // Show test dir distribution
      const testDirs = new Map<string, number>();
      for (const t of tests) {
        const dir = path.dirname(t.path);
        testDirs.set(dir, (testDirs.get(dir) ?? 0) + 1);
      }
      const topDirs = Array.from(testDirs.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8);
      for (const [d, n] of topDirs) lines.push(`  - ${d}: ${n} file(s)`);
      lines.push('');
    } else {
      lines.push('## Tests');
      lines.push('  ⚠ No test files detected. This codebase has no automated test coverage.');
      lines.push('');
    }

    // Migrations
    const migrations = files.filter(f => MIGRATION_PATTERNS.some(p => p.test(f.path)));
    if (migrations.length > 0) {
      lines.push(`## DB Migrations (${migrations.length} file(s))`);
      for (const m of migrations.slice(0, 10)) lines.push(`  - ${m.path}`);
      if (migrations.length > 10) lines.push(`  …and ${migrations.length - 10} more`);
      lines.push('');
    }

    // Top 10 biggest files (sometimes the most important, sometimes the gnarliest)
    const byLines = [...files].sort((a, b) => b.lines - a.lines).slice(0, 10);
    lines.push('## Top 10 files by line count');
    for (const f of byLines) lines.push(`  ${String(f.lines).padStart(6).padEnd(8)} ${f.path}`);
    lines.push('');

    // Total LOC
    const totalLines = files.reduce((a, b) => a + b.lines, 0);
    lines.push(`## Totals`);
    lines.push(`  Files:     ${files.length.toLocaleString()}`);
    lines.push(`  LOC:       ${totalLines.toLocaleString()}`);
    lines.push('');

    lines.push('## Next steps');
    lines.push('  • For a specific file/symbol\'s blast radius: analyze_impact');
    lines.push('  • For exact symbol locations: code_graph_find_symbol');
    lines.push('  • For dead code: find_dead_code (coming in v1.11)');

    return { content: lines.join('\n'), metadata: { fileCount: files.length, totalLines } };
  }
}
