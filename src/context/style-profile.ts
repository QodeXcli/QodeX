/**
 * Automatic user-preference modeling (code style).
 *
 * The agent should write code that matches the user's house style — indentation, quotes,
 * semicolons, naming — WITHOUT the user having to `remember` it. We infer that style
 * DETERMINISTICALLY from the project's own source (and any committed formatter config),
 * then inject a compact "Code style" block into the system prompt so generated code blends
 * in. No model, no guessing: same discipline as the rest of the learning system.
 *
 * An explicit formatter config (.editorconfig) is authoritative when present; otherwise we
 * infer statistically from a sample of files. The pure inference functions are unit-tested.
 */

export interface StyleProfile {
  indent: { type: 'space' | 'tab'; width: number };
  quotes: 'single' | 'double' | 'mixed';
  semicolons: boolean;
  naming: 'camelCase' | 'snake_case' | 'mixed';
  /** How confident we are overall (0–1), from sample size. */
  confidence: number;
  /** True if an .editorconfig pinned the indentation. */
  fromEditorConfig?: boolean;
  sampleFiles: number;
}

const STRING_RE = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g;

/** Most common positive step in leading-space count between consecutive lines = indent unit. */
export function inferIndent(content: string): { type: 'space' | 'tab'; width: number } | null {
  const lines = content.split('\n');
  let tabLines = 0, spaceLines = 0;
  const leadSpaces: number[] = [];
  for (const ln of lines) {
    const m = ln.match(/^([ \t]+)\S/);
    if (!m) continue;
    const ws = m[1]!;
    if (ws[0] === '\t') { tabLines++; continue; }
    spaceLines++;
    leadSpaces.push(ws.length);
  }
  if (tabLines === 0 && spaceLines === 0) return null;
  if (tabLines > spaceLines) return { type: 'tab', width: 1 };
  // Width = most frequent positive delta between consecutive indented lines' leading spaces.
  const deltas = new Map<number, number>();
  for (let i = 1; i < leadSpaces.length; i++) {
    const d = leadSpaces[i]! - leadSpaces[i - 1]!;
    if (d > 0 && d <= 8) deltas.set(d, (deltas.get(d) ?? 0) + 1);
  }
  let width = 0, best = 0;
  for (const [d, n] of deltas) if (n > best) { best = n; width = d; }
  if (!width) {
    // No step signal (flat file) — fall back to the smallest common non-zero indent.
    const min = Math.min(...leadSpaces.filter(n => n > 0));
    width = Number.isFinite(min) ? min : 2;
  }
  return { type: 'space', width: width || 2 };
}

export function inferQuotes(content: string): 'single' | 'double' | 'mixed' | null {
  const strs = content.match(STRING_RE) ?? [];
  let single = 0, double = 0;
  for (const s of strs) (s[0] === "'" ? single++ : double++);
  if (single + double < 3) return null;
  const ratio = single / (single + double);
  if (ratio >= 0.7) return 'single';
  if (ratio <= 0.3) return 'double';
  return 'mixed';
}

export function inferSemicolons(content: string): boolean | null {
  // Look at lines that plausibly END a statement (end with ; or with a value/paren/brace).
  let withSemi = 0, without = 0;
  for (const raw of content.split('\n')) {
    const ln = raw.replace(/\/\/.*$/, '').trimEnd();
    if (!ln) continue;
    if (/[;{}(]$/.test(ln) || /^\s*(import|export|const|let|var|return|type)\b/.test(ln) === false) {
      // crude: a line ending in ; vs one ending in a closing paren/identifier
    }
    if (/;$/.test(ln)) withSemi++;
    else if (/[\w)\]'"`]$/.test(ln) && !/[,{([:=>]$/.test(ln) && /^(?!\s*(\/\/|\*|#|<|}|\)|\]|import\s+type)).+/.test(ln)) without++;
  }
  if (withSemi + without < 5) return null;
  return withSemi >= without;
}

export function inferNaming(content: string): 'camelCase' | 'snake_case' | 'mixed' | null {
  // Function/variable declarations only, to avoid counting keywords/types.
  const ids = [...content.matchAll(/\b(?:const|let|var|function|def|fn|func)\s+([a-zA-Z_]\w*)/g)].map(m => m[1]!);
  let camel = 0, snake = 0;
  for (const id of ids) {
    if (/_/.test(id) && id === id.toLowerCase()) snake++;
    else if (/[a-z][A-Z]/.test(id)) camel++;
  }
  if (camel + snake < 3) return null;
  const r = camel / (camel + snake);
  if (r >= 0.7) return 'camelCase';
  if (r <= 0.3) return 'snake_case';
  return 'mixed';
}

/** Aggregate a profile from a set of file contents (majority vote per dimension). */
export function profileFromSamples(files: Array<{ path: string; content: string }>): StyleProfile | null {
  if (files.length === 0) return null;
  const indents: Array<{ type: 'space' | 'tab'; width: number }> = [];
  const quoteVotes: string[] = [];
  const semiVotes: boolean[] = [];
  const nameVotes: string[] = [];
  for (const f of files) {
    const i = inferIndent(f.content); if (i) indents.push(i);
    const q = inferQuotes(f.content); if (q) quoteVotes.push(q);
    const s = inferSemicolons(f.content); if (s !== null) semiVotes.push(s);
    const n = inferNaming(f.content); if (n) nameVotes.push(n);
  }
  const mode = <T,>(arr: T[], fallback: T): T => {
    const c = new Map<string, number>(); let best = fallback, bestN = 0;
    for (const x of arr) { const k = JSON.stringify(x); const n = (c.get(k) ?? 0) + 1; c.set(k, n); if (n > bestN) { bestN = n; best = x; } }
    return best;
  };
  if (indents.length === 0 && quoteVotes.length === 0) return null;
  return {
    indent: mode(indents, { type: 'space', width: 2 }),
    quotes: mode(quoteVotes, 'single') as StyleProfile['quotes'],
    semicolons: mode(semiVotes, true),
    naming: mode(nameVotes, 'camelCase') as StyleProfile['naming'],
    confidence: Math.min(1, files.length / 15),
    sampleFiles: files.length,
  };
}

// ── I/O: scan the project ────────────────────────────────────────────────────

import { promises as fs } from 'fs';
import * as path from 'path';

const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.rb', '.php', '.java', '.css', '.scss']);
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'vendor', '__pycache__', '.venv', 'coverage']);

/** Parse .editorconfig (root) for an authoritative indent, if present. */
async function readEditorConfigIndent(cwd: string): Promise<{ type: 'space' | 'tab'; width: number } | null> {
  try {
    const raw = await fs.readFile(path.join(cwd, '.editorconfig'), 'utf-8');
    const style = raw.match(/^\s*indent_style\s*=\s*(tab|space)/im)?.[1]?.toLowerCase();
    const size = parseInt(raw.match(/^\s*indent_size\s*=\s*(\d+)/im)?.[1] ?? '', 10);
    if (style === 'tab') return { type: 'tab', width: 1 };
    if (style === 'space') return { type: 'space', width: Number.isFinite(size) ? size : 2 };
  } catch { /* none */ }
  return null;
}

/** Collect up to `max` source files (bounded BFS, skipping vendored dirs). */
async function sampleSourceFiles(cwd: string, max = 25): Promise<Array<{ path: string; content: string }>> {
  const out: Array<{ path: string; content: string }> = [];
  const queue: string[] = [cwd];
  while (queue.length && out.length < max) {
    const dir = queue.shift()!;
    let ents;
    try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (out.length >= max) break;
      if (e.isDirectory()) { if (!SKIP_DIR.has(e.name) && !e.name.startsWith('.')) queue.push(path.join(dir, e.name)); continue; }
      if (!CODE_EXT.has(path.extname(e.name))) continue;
      try {
        const content = await fs.readFile(path.join(dir, e.name), 'utf-8');
        if (content.length > 50) out.push({ path: path.join(dir, e.name), content: content.slice(0, 20_000) });
      } catch { /* skip */ }
    }
  }
  return out;
}

/** Infer the project's code-style profile (editorconfig authoritative for indent). */
export async function scanProjectStyle(cwd: string): Promise<StyleProfile | null> {
  const files = await sampleSourceFiles(cwd);
  const profile = profileFromSamples(files);
  if (!profile) return null;
  const ec = await readEditorConfigIndent(cwd);
  if (ec) { profile.indent = ec; profile.fromEditorConfig = true; }
  return profile;
}

/** Build the compact system-prompt block. Empty when confidence is too low to bother. */
export function buildStyleBlock(p: StyleProfile | null): string {
  if (!p || p.confidence < 0.2) return '';
  const indent = p.indent.type === 'tab' ? 'tabs' : `${p.indent.width}-space`;
  const lines = [
    '# Code style (match the project)',
    '',
    `Write new code in this project's existing style — inferred from its source${p.fromEditorConfig ? ' + .editorconfig' : ''}:`,
    `- Indentation: ${indent}`,
    `- Strings: ${p.quotes === 'mixed' ? 'mixed (match the file you edit)' : p.quotes + ' quotes'}`,
    `- Semicolons: ${p.semicolons ? 'yes' : 'no (omit them)'}`,
    `- Identifiers: ${p.naming === 'mixed' ? 'match the surrounding file' : p.naming}`,
    'Follow the project\'s linter/formatter config if one exists; when in doubt, match the file you are editing.',
  ];
  return lines.join('\n');
}
