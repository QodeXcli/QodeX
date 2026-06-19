/**
 * AST-aware chunking.
 *
 * The old chunker (`chunkFile` in retrieval.ts) split every file into fixed
 * 30-line windows with 5-line overlap. That's simple and language-agnostic,
 * but it cuts functions in half: a 50-line function becomes two chunks,
 * neither of which is a complete, embeddable unit of meaning. Retrieval then
 * returns "the bottom half of validateOrder()" with no signature, no context.
 *
 * This module chunks on SEMANTIC boundaries instead. Using the tree-sitter
 * grammars QodeX already bundles, it walks the syntax tree and emits one chunk
 * per top-level (and one-level-nested) declaration: functions, methods,
 * classes, interfaces, exported consts. Each chunk is a whole unit — the
 * embedding captures the function's full intent, and retrieval points at
 * something the model can act on directly.
 *
 * Design:
 *   - `astChunkFile()` is the entry point. It tries the tree-sitter path; on
 *     ANY failure (no grammar for the language, ABI mismatch, parse error) it
 *     falls back to the existing line-based chunker so we never hard-fail.
 *   - Declarations larger than `maxLines` are sub-split by lines (a 400-line
 *     God-function still needs to fit an embedding's context window).
 *   - Leading code before the first declaration (imports, top-level config)
 *     becomes its own chunk so it's still searchable.
 *   - Each chunk records `symbol` (the declaration name) when known — this is
 *     surfaced in retrieval output and used by the hybrid ranker as a strong
 *     keyword signal.
 *
 * The node-type sets are per-language; anything not listed just isn't treated
 * as a boundary (its lines fold into the surrounding chunk), which is the safe
 * default.
 */

import { createHash } from 'crypto';
import * as path from 'path';
import { getParser, detectLanguage } from '../tools/ast/parser.js';
import type { Chunk } from './retrieval.js';

/** Tree-sitter node types that represent a "chunk-worthy" declaration, per language. */
const BOUNDARY_TYPES: Record<string, Set<string>> = {
  typescript: new Set([
    'function_declaration', 'method_definition', 'class_declaration',
    'interface_declaration', 'type_alias_declaration', 'enum_declaration',
    'lexical_declaration', 'export_statement', 'abstract_class_declaration',
  ]),
  tsx: new Set([
    'function_declaration', 'method_definition', 'class_declaration',
    'interface_declaration', 'type_alias_declaration', 'enum_declaration',
    'lexical_declaration', 'export_statement', 'abstract_class_declaration',
  ]),
  javascript: new Set([
    'function_declaration', 'method_definition', 'class_declaration',
    'lexical_declaration', 'export_statement', 'variable_declaration',
  ]),
  python: new Set(['function_definition', 'class_definition', 'decorated_definition']),
  php: new Set([
    'function_definition', 'method_declaration', 'class_declaration',
    'interface_declaration', 'trait_declaration', 'enum_declaration',
  ]),
  go: new Set(['function_declaration', 'method_declaration', 'type_declaration']),
  rust: new Set(['function_item', 'struct_item', 'enum_item', 'impl_item', 'trait_item', 'mod_item']),
  java: new Set(['method_declaration', 'class_declaration', 'interface_declaration', 'enum_declaration']),
  ruby: new Set(['method', 'class', 'module', 'singleton_method']),
  c: new Set(['function_definition', 'struct_specifier', 'enum_specifier']),
  cpp: new Set(['function_definition', 'class_specifier', 'struct_specifier', 'enum_specifier', 'namespace_definition']),
};

export function langForFile(rel: string): string | null {
  return detectLanguage(rel);
}

/** Best-effort name extraction for a declaration node. */
function extractSymbolName(node: any, source: string): string | undefined {
  // Most grammars expose a `name` child; some wrap (export_statement → declaration → name).
  const nameNode = node.childForFieldName?.('name');
  if (nameNode) return source.slice(nameNode.startIndex, nameNode.endIndex);
  // export_statement / decorated_definition: dig one level.
  for (let i = 0; i < (node.childCount ?? 0); i++) {
    const child = node.child(i);
    if (!child) continue;
    const inner = child.childForFieldName?.('name');
    if (inner) return source.slice(inner.startIndex, inner.endIndex);
  }
  // lexical_declaration: `const X = ...` → variable_declarator → name
  for (let i = 0; i < (node.childCount ?? 0); i++) {
    const child = node.child(i);
    if (child?.type === 'variable_declarator') {
      const id = child.childForFieldName?.('name');
      if (id) return source.slice(id.startIndex, id.endIndex);
    }
  }
  return undefined;
}

function mkChunk(rel: string, lines: string[], start: number, end: number, symbol?: string): Chunk {
  const text = lines.slice(start, end).join('\n');
  const hash = createHash('sha1').update(text).digest('hex').slice(0, 12);
  return { file: rel, startLine: start + 1, endLine: end, text, hash, symbol } as Chunk;
}

/** Line-based fallback — identical semantics to the original chunkFile. */
export function lineChunk(rel: string, content: string, chunkLines = 40, overlap = 8): Chunk[] {
  const lines = content.split('\n');
  const out: Chunk[] = [];
  for (let i = 0; i < lines.length; i += (chunkLines - overlap)) {
    const start = i;
    const end = Math.min(i + chunkLines, lines.length);
    if (end - start < 4) continue;
    out.push(mkChunk(rel, lines, start, end));
    if (end >= lines.length) break;
  }
  return out;
}

/**
 * Chunk a file on AST boundaries. Falls back to line chunking on any failure.
 * `maxLines` caps a single chunk; larger declarations are line-split.
 */
export async function astChunkFile(rel: string, content: string, maxLines = 80): Promise<Chunk[]> {
  const lang = langForFile(rel);
  if (!lang) return lineChunk(rel, content);
  const boundary = BOUNDARY_TYPES[lang];
  if (!boundary) return lineChunk(rel, content);

  let parser;
  try {
    parser = await getParser(lang);
  } catch {
    return lineChunk(rel, content);
  }
  if (!parser) return lineChunk(rel, content);

  let tree;
  try {
    tree = parser.parser.parse(content);
  } catch {
    return lineChunk(rel, content);
  }

  const lines = content.split('\n');
  const root = tree.rootNode;
  const chunks: Chunk[] = [];
  const boundaries: Array<{ startLine: number; endLine: number; symbol?: string; qualifiedSymbol?: string }> = [];

  // Container node types whose children we descend into to chunk members
  // (methods, nested functions, nested classes) as their own units.
  //   - JS/TS: class_declaration, class_body
  //   - Python: class_definition (+ block body)
  //   - PHP: class_declaration, trait/interface declaration
  //   - Rust: impl_item, trait_item, mod_item (bodies are declaration_list)
  //   - Go: a struct is type_declaration but holds NO methods (methods are
  //     top-level funcs with receivers), so Go intentionally has no container
  //     to descend — its functions are already top-level boundaries.
  const CONTAINER_RE = /^(class_declaration|abstract_class_declaration|class_definition|class_specifier|class_body|class|interface_declaration|trait_declaration|trait_item|impl_item|mod_item|module|namespace_definition|namespace|object|enum_declaration|enum_item|declaration_list)$/;
  // Body node types that hold a container's members.
  const BODY_RE = /^(body|class_body|declaration_list|field_declaration_list|enum_body|block|impl_item|trait_item)$/;

  /**
   * Recursively collect chunk boundaries.
   *
   * Strategy (depth-unbounded, but cost-bounded by maxLines):
   *  - A boundary node that fits in maxLines becomes ONE chunk, with its full
   *    text (decorators included — see decorator handling below).
   *  - A boundary node that is a CONTAINER and is LARGER than maxLines is split:
   *    we don't emit the whole container, we descend into its body and chunk each
   *    member (method / nested function / nested class) separately, qualifying
   *    each member's symbol with the container name (e.g. "UserService.login").
   *    This is what fixes deeply-nested React/Django/FastAPI code: a 400-line
   *    class no longer becomes one giant chunk or gets cut mid-method.
   *  - Decorators (Python @decorator, TS @Component) are part of the
   *    decorated_definition / are preceding siblings; tree-sitter's
   *    decorated_definition node already spans them, and for TS the decorators
   *    are children of the class/method node, so the node's start..end already
   *    includes them. We therefore chunk on the OUTERMOST node so the decorator
   *    travels with the thing it decorates.
   */
  const collect = (node: any, prefix: string) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (!child) continue;
      if (!boundary.has(child.type)) {
        // Not a boundary itself, but might contain boundaries (e.g. an
        // export_statement wrapping a class, or a decorated_definition).
        if (CONTAINER_RE.test(child.type) || /export_statement|decorated_definition/.test(child.type)) {
          collect(child, prefix);
        }
        continue;
      }

      const startLine = child.startPosition.row;
      const endLine = child.endPosition.row + 1;
      const span = endLine - startLine;
      const rawName = extractSymbolName(child, content);
      const qualified = rawName ? (prefix ? `${prefix}.${rawName}` : rawName) : undefined;
      const isContainer = CONTAINER_RE.test(child.type);

      if (isContainer && span > maxLines) {
        // Too big to embed as one unit → emit a lightweight "header" chunk for the
        // container signature (so the class/interface itself is searchable), then
        // descend and chunk each member.
        const headerEnd = Math.min(startLine + 3, endLine); // signature + a couple lines
        boundaries.push({ startLine, endLine: headerEnd, symbol: qualified });
        let descended = false;
        for (let j = 0; j < child.childCount; j++) {
          const body = child.child(j);
          if (body && BODY_RE.test(body.type)) {
            collect(body, qualified ?? prefix);
            descended = true;
          }
        }
        // If we somehow found no body, fall back to emitting the whole thing.
        if (!descended) {
          boundaries.pop();
          boundaries.push({ startLine, endLine, symbol: qualified });
        }
      } else {
        // Fits, or isn't a container → one chunk. Decorators are included because
        // we chunk on the outer node (decorated_definition / the node whose span
        // covers leading decorators).
        boundaries.push({ startLine, endLine, symbol: qualified });
      }
    }
  };
  collect(root, '');

  if (boundaries.length === 0) return lineChunk(rel, content);

  // De-duplicate overlapping boundaries (a container header + its members can
  // produce a header inside a member's range if grammars nest oddly). Keep the
  // most specific (smallest) span when two share a start line.
  boundaries.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);

  // Drop boundaries fully contained within an earlier-emitted larger boundary
  // that wasn't split (keeps us from emitting both a whole small class AND its
  // methods). A container that WAS split emits only a 3-line header, so its
  // members (which start after the header) are not contained and survive.
  const deduped: typeof boundaries = [];
  for (const b of boundaries) {
    const containedInPrev = deduped.some(p =>
      p.startLine <= b.startLine && p.endLine >= b.endLine && !(p.startLine === b.startLine && p.endLine === b.endLine),
    );
    if (!containedInPrev) deduped.push(b);
  }
  boundaries.length = 0;
  boundaries.push(...deduped);

  // Leading gap (imports / top-level code before first declaration)
  const firstStart = boundaries[0]!.startLine;
  if (firstStart > 0) {
    const lead = mkChunk(rel, lines, 0, Math.min(firstStart, lines.length));
    if (lead.text.trim().length > 0) chunks.push(lead);
  }

  for (const b of boundaries) {
    const span = b.endLine - b.startLine;
    if (span <= maxLines) {
      chunks.push(mkChunk(rel, lines, b.startLine, b.endLine, b.symbol));
    } else {
      // Large declaration → sub-split by lines but keep the symbol on each piece.
      for (let i = b.startLine; i < b.endLine; i += (maxLines - 10)) {
        const end = Math.min(i + maxLines, b.endLine);
        chunks.push(mkChunk(rel, lines, i, end, b.symbol));
        if (end >= b.endLine) break;
      }
    }
  }

  return chunks.length > 0 ? chunks : lineChunk(rel, content);
}
