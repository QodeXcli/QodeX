/**
 * Extract symbols (functions, classes, methods, types) from source code.
 * Uses Tree-sitter when a grammar is loaded; falls back to language-specific
 * regex heuristics otherwise so the indexer still works without WASM files installed.
 */

import { detectLanguage, getParser } from '../tools/ast/parser.js';
import type { ExtractedSymbol } from './schema.js';
import { logger } from '../utils/logger.js';

// Tree-sitter node types per language. Mirrors edit-symbol.ts but in extraction direction.
const SYMBOL_NODE_TYPES: Record<string, Record<string, string[]>> = {
  typescript: {
    function: ['function_declaration'],
    class: ['class_declaration', 'abstract_class_declaration'],
    method: ['method_definition', 'method_signature'],
    interface: ['interface_declaration'],
    type: ['type_alias_declaration'],
    enum: ['enum_declaration'],
  },
  tsx: {
    function: ['function_declaration'],
    class: ['class_declaration', 'abstract_class_declaration'],
    method: ['method_definition', 'method_signature'],
    interface: ['interface_declaration'],
    type: ['type_alias_declaration'],
    enum: ['enum_declaration'],
  },
  javascript: {
    function: ['function_declaration'],
    class: ['class_declaration'],
    method: ['method_definition'],
  },
  python: {
    function: ['function_definition'],
    class: ['class_definition'],
  },
  rust: {
    function: ['function_item'],
    class: ['struct_item', 'enum_item'],
    method: ['function_item'],
    type: ['type_item'],
    interface: ['trait_item'],
    impl: ['impl_item'],
  },
  go: {
    function: ['function_declaration'],
    method: ['method_declaration'],
    type: ['type_declaration'],
  },
  php: {
    function: ['function_definition'],
    class: ['class_declaration'],
    method: ['method_declaration'],
    interface: ['interface_declaration'],
  },
};

export async function extractSymbols(filePath: string, source: string): Promise<ExtractedSymbol[]> {
  const lang = detectLanguage(filePath);
  if (!lang) return [];

  // Try Tree-sitter first
  const parserResult = await getParser(lang).catch(() => null);
  if (parserResult) {
    try {
      return extractWithTreeSitter(parserResult, lang, source);
    } catch (e: any) {
      logger.warn('Tree-sitter extraction failed, falling back to regex', { file: filePath, err: e.message });
    }
  }

  // Fallback: regex heuristics per language
  return extractWithRegex(lang, source);
}

function extractWithTreeSitter(
  parserResult: { parser: any; language: any },
  lang: string,
  source: string,
): ExtractedSymbol[] {
  const tree = parserResult.parser.parse(source);
  const root = tree.rootNode;
  const nodeMap = SYMBOL_NODE_TYPES[lang];
  if (!nodeMap) return [];

  const symbols: ExtractedSymbol[] = [];
  // Build a flat reverse lookup: node type → kind name
  const typeToKind = new Map<string, string>();
  for (const [kind, types] of Object.entries(nodeMap)) {
    for (const t of types) typeToKind.set(t, kind);
  }

  function getName(node: any): string | null {
    const nameNode = node.childForFieldName('name');
    if (nameNode) return nameNode.text;
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c && (c.type === 'identifier' || c.type === 'property_identifier' || c.type === 'type_identifier')) {
        return c.text;
      }
    }
    return null;
  }

  function getEnclosingNamedSymbol(node: any): string | null {
    let cur = node.parent;
    while (cur) {
      const kind = typeToKind.get(cur.type);
      if (kind) {
        const name = getName(cur);
        if (name) return name;
      }
      cur = cur.parent;
    }
    return null;
  }

  function visit(node: any) {
    let kind = typeToKind.get(node.type);
    // Rust maps `function_item` to BOTH `function` and `method`, so the flat
    // type→kind map can't tell them apart (last write wins). Disambiguate by
    // context: a `fn` enclosed in an impl/trait block is a method, otherwise a
    // free function.
    if (lang === 'rust' && node.type === 'function_item') {
      let cur = node.parent;
      let insideImplOrTrait = false;
      while (cur) {
        if (cur.type === 'impl_item' || cur.type === 'trait_item') { insideImplOrTrait = true; break; }
        cur = cur.parent;
      }
      kind = insideImplOrTrait ? 'method' : 'function';
    }
    if (kind) {
      const name = getName(node);
      if (name) {
        const parentName = getEnclosingNamedSymbol(node);
        // Build a tiny signature: first line of the symbol, capped
        const sig = (node.text ?? '').split('\n')[0]?.slice(0, 200) ?? '';
        symbols.push({
          name,
          kind,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          startColumn: node.startPosition.column,
          parentName: parentName ?? undefined,
          signature: sig,
        });
      }
    }
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c) visit(c);
    }
  }

  visit(root);
  return symbols;
}

// ---------- Regex fallback ----------
// Conservative — only catches the most common patterns. Misses anonymous functions,
// destructured exports, generics, etc. Better than nothing when WASM grammars aren't installed.

const REGEX_PATTERNS: Record<string, Array<{ pattern: RegExp; kind: string }>> = {
  typescript: [
    { pattern: /^[ \t]*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm, kind: 'function' },
    { pattern: /^[ \t]*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm, kind: 'class' },
    { pattern: /^[ \t]*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/gm, kind: 'interface' },
    { pattern: /^[ \t]*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/gm, kind: 'type' },
    { pattern: /^[ \t]*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/gm, kind: 'enum' },
    { pattern: /^[ \t]*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/gm, kind: 'function' },
  ],
  tsx: [
    { pattern: /^[ \t]*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm, kind: 'function' },
    { pattern: /^[ \t]*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm, kind: 'class' },
    { pattern: /^[ \t]*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/gm, kind: 'interface' },
    { pattern: /^[ \t]*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/gm, kind: 'type' },
  ],
  javascript: [
    { pattern: /^[ \t]*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm, kind: 'function' },
    { pattern: /^[ \t]*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/gm, kind: 'class' },
    { pattern: /^[ \t]*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/gm, kind: 'function' },
  ],
  python: [
    { pattern: /^[ \t]*(?:async\s+)?def\s+([A-Za-z_][\w]*)/gm, kind: 'function' },
    { pattern: /^[ \t]*class\s+([A-Za-z_][\w]*)/gm, kind: 'class' },
  ],
  rust: [
    { pattern: /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/gm, kind: 'function' },
    { pattern: /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_][\w]*)/gm, kind: 'class' },
    { pattern: /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_][\w]*)/gm, kind: 'class' },
    { pattern: /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_][\w]*)/gm, kind: 'interface' },
    { pattern: /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_][\w]*)/gm, kind: 'type' },
  ],
  go: [
    { pattern: /^func\s+(?:\([^)]*\)\s+)?([A-Za-z_][\w]*)/gm, kind: 'function' },
    { pattern: /^type\s+([A-Za-z_][\w]*)\s+(?:struct|interface)/gm, kind: 'class' },
  ],
  php: [
    { pattern: /^[ \t]*(?:public|private|protected|static|\s)*function\s+([A-Za-z_][\w]*)/gm, kind: 'function' },
    { pattern: /^[ \t]*(?:abstract\s+|final\s+)?class\s+([A-Za-z_][\w]*)/gm, kind: 'class' },
    { pattern: /^[ \t]*interface\s+([A-Za-z_][\w]*)/gm, kind: 'interface' },
  ],
};

function extractWithRegex(lang: string, source: string): ExtractedSymbol[] {
  const patterns = REGEX_PATTERNS[lang];
  if (!patterns) return [];

  const lines = source.split('\n');
  const lineOffsets: number[] = [0];
  for (let i = 0; i < lines.length; i++) {
    lineOffsets.push(lineOffsets[i]! + lines[i]!.length + 1);
  }
  const positionToLine = (pos: number): { line: number; col: number } => {
    // Binary search
    let lo = 0, hi = lineOffsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (lineOffsets[mid]! <= pos) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, col: pos - lineOffsets[lo]! };
  };

  const symbols: ExtractedSymbol[] = [];
  for (const { pattern, kind } of patterns) {
    const re = new RegExp(pattern.source, pattern.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const name = m[1];
      if (!name) continue;
      const { line, col } = positionToLine(m.index);
      const lineText = (lines[line - 1] ?? '').slice(0, 200);
      symbols.push({
        name,
        kind,
        startLine: line,
        endLine: line, // regex doesn't know body bounds
        startColumn: col,
        signature: lineText,
      });
    }
  }
  return symbols;
}
