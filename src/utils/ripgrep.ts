/**
 * Shared line-search helper. Uses ripgrep when it's on PATH (fast, .gitignore-aware)
 * and falls back to a pure-JS directory walk when it isn't — so features that lean on
 * search (codegraph navigation, etc.) degrade gracefully instead of hard-failing with
 * `spawn rg ENOENT` on machines without ripgrep installed.
 */

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { isBinaryBuffer } from './binary.js';

let ripgrepAvailable: boolean | null = null;

/** Cached check for whether the `rg` binary is callable. */
export async function hasRipgrep(): Promise<boolean> {
  if (ripgrepAvailable !== null) return ripgrepAvailable;
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn('rg', ['--version'], { stdio: 'ignore' });
    } catch {
      ripgrepAvailable = false;
      resolve(false);
      return;
    }
    proc.on('close', (code) => { ripgrepAvailable = code === 0; resolve(ripgrepAvailable); });
    proc.on('error', () => { ripgrepAvailable = false; resolve(false); });
  });
}

/** Test hook: force the availability cache (pass `null` to clear and re-probe). */
export function __setRipgrepAvailable(v: boolean | null): void {
  ripgrepAvailable = v;
}

// Mirror the indexer's ignore list so fallback results match what gets indexed.
const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg',
  'dist', 'build', 'out', '.next', '.nuxt', '.turbo', '.cache',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  'target', 'vendor', '.gradle', '.dart_tool',
  '.venv', 'venv', 'env',
  'coverage', '.nyc_output',
  '.qodex',
]);

const MAX_FILE_SIZE = 1 * 1024 * 1024; // 1MB

// Loose ripgrep `--type` → extension mapping for the JS fallback. Unknown languages
// don't filter (ripgrep would error, but the fallback just searches everything).
const TYPE_EXT: Record<string, string[]> = {
  ts: ['.ts', '.tsx', '.mts', '.cts'],
  typescript: ['.ts', '.tsx', '.mts', '.cts'],
  js: ['.js', '.jsx', '.mjs', '.cjs'],
  javascript: ['.js', '.jsx', '.mjs', '.cjs'],
  py: ['.py', '.pyi'], python: ['.py', '.pyi'],
  rs: ['.rs'], rust: ['.rs'],
  go: ['.go'],
  java: ['.java'],
  rb: ['.rb'], ruby: ['.rb'],
  php: ['.php'],
  c: ['.c', '.h'],
  cpp: ['.cpp', '.cc', '.cxx', '.hpp', '.hh'],
  cs: ['.cs'], csharp: ['.cs'],
};

export interface LineSearchOptions {
  /** Full ripgrep argv (pattern, flags, and the search root all included). */
  rgArgs: string[];
  /** JS-equivalent per-line regex used by the fallback walk. */
  regex: RegExp;
  /** Optional ripgrep `--type` / extension filter (applied in the fallback too). */
  language?: string;
  /** Stop after this many matched lines (fallback only; rg honors --max-count itself). */
  maxCount: number;
  signal?: AbortSignal;
}

export type LineSearchResult =
  | { stdout: string; usedFallback: boolean }
  | { error: string; isError: true };

/**
 * Run a line search rooted at `cwd`. Returns ripgrep-style `file:line:content` lines in
 * `stdout`. When ripgrep is unavailable, transparently uses the JS fallback.
 */
export async function runLineSearch(cwd: string, opts: LineSearchOptions): Promise<LineSearchResult> {
  if (await hasRipgrep()) {
    return runRipgrep(opts.rgArgs, opts.signal);
  }
  const stdout = await jsLineSearch(cwd, opts);
  return { stdout, usedFallback: true };
}

function runRipgrep(rgArgs: string[], signal?: AbortSignal): Promise<LineSearchResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let proc;
    try {
      proc = spawn('rg', rgArgs, { signal });
    } catch (e: any) {
      resolve({ error: `[ERROR] ${e.message}`, isError: true });
      return;
    }
    proc.stdout?.on('data', (d: Buffer) => { stdout += d; });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d; });
    proc.on('close', (code, sig) => {
      if (sig) { resolve({ error: `[CANCELLED] killed by ${sig}`, isError: true }); return; }
      // ripgrep exits 1 when there are simply no matches — not an error.
      if (code !== 0 && code !== 1) {
        resolve({ error: `[ERROR] ripgrep exited ${code}: ${stderr.slice(0, 300)}`, isError: true });
        return;
      }
      resolve({ stdout, usedFallback: false });
    });
    proc.on('error', (e) => resolve({ error: `[ERROR] ${e.message}`, isError: true }));
  });
}

/** Pure-JS line search. Exported for direct testing. Emits absolute `file:line:content`. */
export async function jsLineSearch(cwd: string, opts: LineSearchOptions): Promise<string> {
  const exts = opts.language ? (TYPE_EXT[opts.language.toLowerCase()] ?? null) : null;
  // Use a non-global clone so `.test()` doesn't advance lastIndex across lines.
  const re = new RegExp(opts.regex.source, opts.regex.flags.replace(/g/g, ''));
  const out: string[] = [];
  let count = 0;

  async function walk(dir: string): Promise<void> {
    if (count >= opts.maxCount || opts.signal?.aborted) return;
    let entries: any[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch { return; }

    for (const entry of entries) {
      if (count >= opts.maxCount || opts.signal?.aborted) return;
      if (entry.name.startsWith('.') && entry.name !== '.env') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        await walk(full);
      } else if (entry.isFile()) {
        if (exts && !exts.includes(path.extname(full).toLowerCase())) continue;
        let buf: Buffer;
        try {
          const st = await fs.stat(full);
          if (st.size > MAX_FILE_SIZE) continue;
          buf = await fs.readFile(full);
        } catch { continue; }
        if (isBinaryBuffer(buf)) continue;
        const lines = buf.toString('utf-8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i]!)) {
            out.push(`${full}:${i + 1}:${lines[i]}`);
            count++;
            if (count >= opts.maxCount) break;
          }
        }
      }
    }
  }

  // Allow searching a single file path too (matches ripgrep's behaviour).
  try {
    const st = await fs.stat(cwd);
    if (st.isFile()) {
      const buf = await fs.readFile(cwd);
      if (!isBinaryBuffer(buf)) {
        const lines = buf.toString('utf-8').split('\n');
        for (let i = 0; i < lines.length && count < opts.maxCount; i++) {
          if (re.test(lines[i]!)) { out.push(`${cwd}:${i + 1}:${lines[i]}`); count++; }
        }
      }
      return out.join('\n');
    }
  } catch { return ''; }

  await walk(cwd);
  return out.join('\n');
}
