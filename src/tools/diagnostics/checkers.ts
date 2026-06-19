/**
 * Shared checker registry — the detect/run/parse specs for the project type-checkers and
 * linters QodeX understands (tsc, eslint, ruff, pyright, go vet, cargo).
 *
 * Extracted so TWO callers can share one source of truth:
 *   - the `diagnostics` TOOL (model-invoked, on demand), and
 *   - the AUTO-VERIFY GATE in the agent loop (harness-invoked, after every set of edits).
 *
 * The auto-verify gate is the heart of QodeX's model-agnostic amplification: whatever
 * model is connected, it is NOT allowed to declare a coding task "done" while the files it
 * touched still have type errors. A weak model that writes broken code gets the errors fed
 * straight back and is forced to fix them; a strong model just sails through. Either way
 * the OUTPUT quality is lifted toward "it actually type-checks" — independent of the model.
 *
 * The parsers (parsers.ts) are already pure + tested; this module adds the (impure) spawn
 * + detection around them.
 */

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import {
  parseTsc, parseEslintJson, parseRuffJson, parsePyrightJson, parseLineColMessage, parsePhpLint,
  type Diagnostic,
} from './parsers.js';

export type CheckerId = 'tsc' | 'eslint' | 'ruff' | 'pyright' | 'govet' | 'cargo' | 'php';

export interface CheckerSpec {
  id: CheckerId;
  /** Argv (no shell). First element is the binary. For perFile checkers the file
   * path is appended to this argv on each invocation. */
  argv: string[];
  /** Which stream carries the diagnostics. */
  stream: 'stdout' | 'stderr' | 'both';
  parse: (text: string) => Diagnostic[];
  /** True if this checker looks relevant for a project whose root entries are `files`. */
  detect: (files: Set<string>) => boolean;
  /** Languages this checker covers — used by the gate to decide if touched files qualify. */
  exts: string[];
  /** When true, the checker runs ONCE PER touched file (argv + filepath) instead of
   * once for the whole project. For tools like `php -l` that take a single file. */
  perFile?: boolean;
}

export const CHECKERS: CheckerSpec[] = [
  {
    id: 'tsc',
    argv: ['npx', '--no-install', 'tsc', '--noEmit', '--pretty', 'false'],
    stream: 'stdout',
    parse: parseTsc,
    detect: (f) => f.has('tsconfig.json'),
    exts: ['.ts', '.tsx', '.mts', '.cts'],
  },
  {
    id: 'ruff',
    argv: ['ruff', 'check', '--output-format', 'json', '.'],
    stream: 'stdout',
    parse: (t) => parseRuffJson(t),
    detect: (f) => f.has('pyproject.toml') || f.has('ruff.toml') || f.has('requirements.txt'),
    exts: ['.py'],
  },
  {
    id: 'pyright',
    argv: ['pyright', '--outputjson'],
    stream: 'stdout',
    parse: (t) => parsePyrightJson(t),
    detect: (f) => f.has('pyrightconfig.json') || f.has('pyproject.toml'),
    exts: ['.py'],
  },
  {
    id: 'govet',
    argv: ['go', 'vet', './...'],
    stream: 'stderr',
    parse: (t) => parseLineColMessage(t, 'error'),
    detect: (f) => f.has('go.mod'),
    exts: ['.go'],
  },
  {
    id: 'cargo',
    argv: ['cargo', 'check', '--quiet'],
    stream: 'stderr',
    parse: (t) => parseLineColMessage(t, 'error'),
    detect: (f) => f.has('Cargo.toml'),
    exts: ['.rs'],
  },
  {
    id: 'eslint',
    argv: ['npx', '--no-install', 'eslint', '.', '-f', 'json'],
    stream: 'stdout',
    parse: (t) => parseEslintJson(t),
    detect: (f) => f.has('.eslintrc') || f.has('.eslintrc.js') || f.has('.eslintrc.json') || f.has('.eslintrc.cjs') || f.has('eslint.config.js') || f.has('eslint.config.mjs'),
    exts: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'],
  },
  {
    // `php -l` ships with every PHP install and needs NO config — so unlike the
    // others it fires on any PHP project, catching the syntax errors that would
    // otherwise let the agent claim "done"/"tested" on code that won't even parse.
    // It lints ONE file at a time, hence perFile.
    id: 'php',
    argv: ['php', '-l', '-d', 'display_errors=1', '-d', 'error_reporting=E_ALL'],
    stream: 'both',
    parse: (t) => parsePhpLint(t),
    detect: (f) => f.has('composer.json') || [...f].some(n => n.endsWith('.php')),
    exts: ['.php'],
    perFile: true,
  },
];

export interface CheckerRun {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError?: string;
}

/** Run a checker spec's argv (no shell) in `cwd`, capturing both streams. Never rejects. */
export function runChecker(argv: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<CheckerRun> {
  return new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0', CI: '1' },
    });
    let stdout = '';
    let stderr = '';
    const cap = 200_000;
    const onAbort = (): void => { try { child.kill('SIGKILL'); } catch { /* ignore */ } };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(onAbort, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => { if (stdout.length < cap) stdout += d.toString('utf-8'); });
    child.stderr?.on('data', (d: Buffer) => { if (stderr.length < cap) stderr += d.toString('utf-8'); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr });
    });
    child.on('error', (err: any) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ code: -1, stdout, stderr, spawnError: err?.message ?? String(err) });
    });
  });
}

/** Pick the captured stream a checker's diagnostics live on. */
export function checkerText(spec: CheckerSpec, run: CheckerRun): string {
  return spec.stream === 'stdout' ? run.stdout
    : spec.stream === 'stderr' ? run.stderr
    : `${run.stdout}\n${run.stderr}`;
}

/** Root-directory entry names, for checker detection. Never throws. */
export async function detectProjectFiles(root: string): Promise<Set<string>> {
  try {
    return new Set(await fs.readdir(root));
  } catch {
    return new Set();
  }
}

/** First checker whose detect() fires for the given root entries, or undefined. */
export function pickChecker(files: Set<string>): CheckerSpec | undefined {
  return CHECKERS.find(c => c.detect(files));
}
