import { z } from 'zod';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { prepareDiffPreview } from '../../utils/ui-limits.js';
import { detectLanguage, getParser, findSyntaxErrors, type FoundSymbol } from './parser.js';
import { logger } from '../../utils/logger.js';

const ArgsSchema = z.object({
  path: z.string().describe('Path to source file'),
  symbol_name: z.string().describe('Name of the symbol, e.g. "calculateTotal" or "User"'),
  symbol_kind: z.enum(['function', 'method', 'class', 'interface', 'type']).describe('Kind of symbol'),
  new_code: z.string().describe('Complete new code for the symbol including signature, braces, and body'),
  parent_class: z.string().optional().describe('For methods inside a class, the containing class name to disambiguate'),
});

// Tree-sitter node types per language
const NODE_TYPES: Record<string, Record<string, string[]>> = {
  typescript: {
    function: ['function_declaration', 'arrow_function', 'function'],
    class: ['class_declaration', 'abstract_class_declaration'],
    method: ['method_definition', 'method_signature'],
    interface: ['interface_declaration'],
    type: ['type_alias_declaration'],
  },
  tsx: {
    function: ['function_declaration', 'arrow_function', 'function'],
    class: ['class_declaration', 'abstract_class_declaration'],
    method: ['method_definition', 'method_signature'],
    interface: ['interface_declaration'],
    type: ['type_alias_declaration'],
  },
  javascript: {
    function: ['function_declaration', 'arrow_function', 'function'],
    class: ['class_declaration'],
    method: ['method_definition'],
  },
  python: {
    function: ['function_definition'],
    class: ['class_definition'],
    method: ['function_definition'],
  },
  rust: {
    function: ['function_item'],
    class: ['struct_item', 'enum_item'],
    method: ['function_item'],
    type: ['type_item'],
    interface: ['trait_item'],
  },
  go: {
    function: ['function_declaration', 'method_declaration'],
    type: ['type_declaration'],
    method: ['method_declaration'],
  },
  php: {
    function: ['function_definition'],
    class: ['class_declaration'],
    method: ['method_declaration'],
    interface: ['interface_declaration'],
  },
};

function findSymbolByName(
  rootNode: any,
  nodeTypes: string[],
  name: string,
  parentClassName?: string,
): FoundSymbol[] {
  const matches: FoundSymbol[] = [];

  function getSymbolName(node: any): string | null {
    // Try common field names
    for (const field of ['name']) {
      const f = node.childForFieldName(field);
      if (f) return f.text;
    }
    // Fallback: look for first identifier child
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c && (c.type === 'identifier' || c.type === 'property_identifier' || c.type === 'type_identifier')) {
        return c.text;
      }
    }
    return null;
  }

  function getEnclosingClassName(node: any): string | null {
    let cur = node.parent;
    while (cur) {
      if (
        cur.type === 'class_declaration' ||
        cur.type === 'abstract_class_declaration' ||
        cur.type === 'class_definition' ||
        cur.type === 'struct_item' ||
        cur.type === 'class' // generic
      ) {
        return getSymbolName(cur);
      }
      cur = cur.parent;
    }
    return null;
  }

  function visit(node: any) {
    if (nodeTypes.includes(node.type)) {
      const symName = getSymbolName(node);
      if (symName === name) {
        const enclosing = getEnclosingClassName(node);
        if (!parentClassName || enclosing === parentClassName) {
          matches.push({
            name,
            kind: node.type,
            startIndex: node.startIndex,
            endIndex: node.endIndex,
            startRow: node.startPosition.row,
            endRow: node.endPosition.row,
            startColumn: node.startPosition.column,
            endColumn: node.endPosition.column,
          });
        }
      }
    }
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c) visit(c);
    }
  }

  visit(rootNode);
  return matches;
}

function listAvailableSymbols(rootNode: any, nodeTypes: string[]): string[] {
  const names: string[] = [];
  function visit(node: any) {
    if (nodeTypes.includes(node.type)) {
      const nameNode = node.childForFieldName('name');
      if (nameNode) names.push(nameNode.text);
      else {
        for (let i = 0; i < node.childCount; i++) {
          const c = node.child(i);
          if (c && (c.type === 'identifier' || c.type === 'property_identifier' || c.type === 'type_identifier')) {
            names.push(c.text);
            break;
          }
        }
      }
    }
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c) visit(c);
    }
  }
  visit(rootNode);
  return [...new Set(names)];
}

export class EditSymbolTool extends Tool<z.infer<typeof ArgsSchema>> {
  name = 'edit_symbol';
  description = 'Edit a named function, method, class, interface, or type using AST. Much safer than edit_text — cannot break syntax. PREFERRED for code edits. Provide the COMPLETE new code for the symbol (including signature and braces).';
  isReadOnly = false;
  isDestructive = true;
  argsSchema = ArgsSchema;

  async execute(args: z.infer<typeof ArgsSchema>, ctx: ToolContext): Promise<ToolResult> {
    const abs = path.isAbsolute(args.path) ? args.path : path.resolve(ctx.cwd, args.path);
    const rel = path.relative(ctx.cwd, abs);

    const lang = detectLanguage(abs);
    if (!lang) {
      return {
        content: `[UNSUPPORTED_LANGUAGE] No AST grammar for ${path.extname(abs)}. Use edit_text instead for this file type.`,
        isError: true,
      };
    }

    const nodeTypes = NODE_TYPES[lang]?.[args.symbol_kind];
    if (!nodeTypes) {
      return {
        content: `[UNSUPPORTED] AST editing of ${args.symbol_kind} not supported for ${lang}. Use edit_text.`,
        isError: true,
      };
    }

    let parserResult;
    try {
      parserResult = await getParser(lang);
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      // Common failure: bundled .wasm grammar was built for a tree-sitter ABI
      // version that doesn't match the installed `web-tree-sitter` runtime.
      // Surface a clear, actionable message — and recommend edit_text as the
      // immediate workaround instead of looping.
      if (/Incompatible language version|abi/i.test(msg)) {
        return {
          content: `[AST_GRAMMAR_INCOMPATIBLE] The bundled tree-sitter grammar for ${lang} is incompatible with the installed runtime (${msg}). This is a packaging issue, not your code. Workaround: use \`edit_text\` for this edit — it's slightly less safe but works reliably. Don't retry edit_symbol on this file.`,
          isError: true,
        };
      }
      return {
        content: `[AST_GRAMMAR_LOAD_ERROR] Could not load grammar for ${lang}: ${msg}. Use \`edit_text\` instead.`,
        isError: true,
      };
    }
    if (!parserResult) {
      return {
        content: `[AST_UNAVAILABLE] Tree-sitter grammar for ${lang} not loaded. Use edit_text instead. To enable AST editing, install the grammar wasm into grammars/tree-sitter-${lang}.wasm`,
        isError: true,
      };
    }

    let source: string;
    try {
      source = await fs.readFile(abs, 'utf-8');
    } catch (e: any) {
      return { content: `[ERROR] Cannot read ${args.path}: ${e.message}`, isError: true };
    }

    let tree;
    try {
      tree = parserResult.parser.parse(source);
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (/Incompatible language version|abi/i.test(msg)) {
        return {
          content: `[AST_GRAMMAR_INCOMPATIBLE] tree-sitter parse failed for ${lang} due to ABI mismatch (${msg}). Use \`edit_text\` instead for this file.`,
          isError: true,
        };
      }
      return { content: `[AST_PARSE_ERROR] ${msg}. Fallback: use edit_text.`, isError: true };
    }
    const matches = findSymbolByName(tree.rootNode, nodeTypes, args.symbol_name, args.parent_class);

    if (matches.length === 0) {
      const available = listAvailableSymbols(tree.rootNode, nodeTypes).slice(0, 20);
      return {
        content: `[SYMBOL_NOT_FOUND] ${args.symbol_kind} "${args.symbol_name}"${args.parent_class ? ` in class ${args.parent_class}` : ''} not found in ${rel}.\n` +
          (available.length > 0
            ? `Available ${args.symbol_kind}s in this file: ${available.join(', ')}`
            : `No ${args.symbol_kind}s found in this file at all.`),
        isError: true,
      };
    }

    if (matches.length > 1) {
      return {
        content: `[AMBIGUOUS] Multiple ${args.symbol_kind}s named "${args.symbol_name}" found in ${rel}. ` +
          `Use parent_class to disambiguate methods.`,
        isError: true,
      };
    }

    const match = matches[0]!;
    const before = source.slice(0, match.startIndex);
    const after = source.slice(match.endIndex);
    const updated = before + args.new_code + after;

    // Validate: re-parse to check syntax
    const newTree = parserResult.parser.parse(updated);
    const errors = findSyntaxErrors(newTree.rootNode, updated);
    if (errors.length > 0) {
      const errList = errors.slice(0, 3).map(e =>
        `  Line ${e.line}:${e.column} — ${e.missing ? `missing ${e.text || 'token'}` : `unexpected "${e.text}"`}`
      ).join('\n');
      return {
        content: `[SYNTAX_ERROR] Your new_code introduces syntax errors:\n${errList}\n` +
          `Review your new_code carefully. Common issues: unbalanced braces/parens, missing semicolons, broken string escapes. Try again with corrected code.`,
        isError: true,
      };
    }

    // Permission check
    const permReq = { tool: 'edit_symbol', operation: rel, description: `Edit ${args.symbol_kind} ${args.symbol_name} in ${rel}` };
    const decision = ctx.permissions.evaluate(permReq);
    if (decision === 'deny') return { content: `[PERMISSION_DENIED]`, isError: true };
    if (decision === 'ask') {
      const preview = prepareDiffPreview(rel, source, updated);
      ctx.emit({ type: 'diff', path: preview.path, before: preview.before, after: preview.after });
      const answer = await ctx.askUser(`Replace ${args.symbol_kind} ${args.symbol_name} in ${rel}?`, ['yes', 'no', 'always']);
      if (answer === 'no') return { content: `[USER_REJECTED]`, isError: true };
      if (answer === 'always') ctx.permissions.rememberDecision(permReq, 'allow', 'pattern');
    }

    await ctx.transaction.write(abs, updated);

    const lineCount = args.new_code.split('\n').length;
    return {
      content: `Replaced ${args.symbol_kind} "${args.symbol_name}" in ${rel} (${lineCount} lines, syntax validated)`,
      metadata: { path: abs, symbolKind: args.symbol_kind, symbolName: args.symbol_name },
    };
  }
}
