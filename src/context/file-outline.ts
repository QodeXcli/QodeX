/**
 * Structural outline for large files.
 *
 * Dumping a 600-line file into the context on every read is what makes the
 * agent "get stuck on big files": the window fills with one file, the model
 * loses the thread, and iterations burn re-reading the same thing. Instead,
 * for a large file we hand back a MAP — the declarations and their line ranges —
 * plus the head of the file. The model sees where everything is and then reads
 * the exact slice it needs with offset/limit. One targeted read instead of
 * carrying the whole file around.
 *
 * The outline is built from the AST chunker (same tree-sitter grammars QodeX
 * already bundles). On any failure it degrades to "no outline" and the caller
 * falls back to a plain head-of-file slice — never a hard error.
 */

import { astChunkFile } from './ast-chunk.js';

export interface OutlineEntry {
  symbol: string;
  startLine: number;
  endLine: number;
}

/**
 * Produce a deduped, line-sorted list of top-level declarations for a file.
 * Returns [] when the language isn't parseable or has no clear symbols.
 */
export async function fileOutline(relPath: string, content: string): Promise<OutlineEntry[]> {
  let chunks;
  try {
    chunks = await astChunkFile(relPath, content, 80);
  } catch {
    return [];
  }

  const seen = new Set<string>();
  const entries: OutlineEntry[] = [];
  for (const c of chunks) {
    if (!c.symbol) continue;
    // Top-level only: keep the qualified leaf but collapse duplicate symbol
    // names that the sub-splitter may have emitted for one big declaration.
    const key = c.symbol;
    if (seen.has(key)) {
      // Extend the range of the existing entry instead of adding a dupe.
      const prev = entries.find(e => e.symbol === key);
      if (prev) {
        prev.startLine = Math.min(prev.startLine, c.startLine);
        prev.endLine = Math.max(prev.endLine, c.endLine);
      }
      continue;
    }
    seen.add(key);
    entries.push({ symbol: c.symbol, startLine: c.startLine, endLine: c.endLine });
  }
  entries.sort((a, b) => a.startLine - b.startLine);

  // Merge in regex-detected declarations. The AST chunker can miss everyday
  // constructs (e.g. `export const Button = () =>` arrow components in .jsx)
  // while still returning *something* (like a sibling class), which previously
  // suppressed the regex pass entirely. Instead we always run the regex scan and
  // union it in, so a symbol either path finds is included. AST entries win on
  // line ranges (they're more precise); regex fills the gaps.
  const regexEntries = regexOutline(content);
  for (const re of regexEntries) {
    if (!seen.has(re.symbol)) {
      seen.add(re.symbol);
      entries.push(re);
    }
  }
  entries.sort((a, b) => a.startLine - b.startLine);

  return entries;
}

/** Patterns that mark a top-level declaration across the languages QodeX targets. */
const DECL_PATTERNS: RegExp[] = [
  // JS/TS: function foo(  |  export function foo(  |  export default function foo(
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  // JS/TS: class Foo  |  export class Foo  |  export abstract class Foo
  /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  // JS/TS: const Foo = (  |  export const Foo = (  — arrow components / fns
  /^\s*(?:export\s+)?(?:default\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
  // TS: interface Foo  |  type Foo =  |  enum Foo
  /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/,
  /^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/,
  // Python: def foo(  |  class Foo  (any indentation = nested, but top-level wins)
  /^(?:async\s+)?def\s+([A-Za-z_][\w]*)/,
  /^class\s+([A-Za-z_][\w]*)/,
  // PHP: function foo(  |  class Foo
  /^\s*(?:public\s+|private\s+|protected\s+|static\s+)*function\s+([A-Za-z_][\w]*)/,
];

/** Line-based outline: walk lines, match a declaration pattern, record its start. */
function regexOutline(content: string): OutlineEntry[] {
  const lines = content.split('\n');
  const seen = new Set<string>();
  const raw: Array<{ symbol: string; startLine: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const re of DECL_PATTERNS) {
      const m = re.exec(line);
      if (m && m[1] && !seen.has(m[1])) {
        seen.add(m[1]);
        raw.push({ symbol: m[1], startLine: i + 1 });
        break;
      }
    }
  }
  // endLine = the line before the next declaration (or EOF). Good enough for a map.
  const entries: OutlineEntry[] = raw.map((e, idx) => ({
    symbol: e.symbol,
    startLine: e.startLine,
    endLine: idx + 1 < raw.length ? raw[idx + 1]!.startLine - 1 : lines.length,
  }));
  return entries;
}

/**
 * Render an outline + head-of-file into a compact, model-friendly block.
 * `headLines` of the file are included verbatim (imports + top of file) so the
 * model gets immediate orientation without a second call.
 */
export async function renderLargeFileMap(
  relPath: string,
  content: string,
  opts: { headLines?: number } = {},
): Promise<string> {
  const headLines = opts.headLines ?? 40;
  const allLines = content.split('\n');
  const outline = await fileOutline(relPath, content);

  const head = allLines.slice(0, headLines)
    .map((line, i) => `${String(i + 1).padStart(4, ' ')}\t${line}`)
    .join('\n');

  const parts: string[] = [];
  parts.push(`[LARGE FILE — ${allLines.length} lines. Showing a structural map + the first ${Math.min(headLines, allLines.length)} lines.`);
  parts.push(`Read a specific section with read_file offset=<startLine> limit=<n>, pass symbol="Name" to read one declaration, or grep for a term.]`);
  parts.push('');

  if (outline.length > 0) {
    parts.push('OUTLINE (symbol → lines):');
    for (const e of outline) {
      parts.push(`  ${e.symbol}  —  lines ${e.startLine}-${e.endLine}`);
    }
    parts.push('');
  }

  parts.push(`HEAD (lines 1-${Math.min(headLines, allLines.length)}):`);
  parts.push(head);
  if (allLines.length > headLines) {
    parts.push(`[... ${allLines.length - headLines} more lines below. Use the outline above to jump to a section.]`);
  }

  return parts.join('\n');
}
