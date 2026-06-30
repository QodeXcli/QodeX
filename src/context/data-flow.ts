/**
 * Lightweight intra-function data-flow: free-variable extraction.
 *
 * Full data-flow analysis (SSA form, abstract interpretation, points-to) is a
 * compiler-scale undertaking and overkill for a coding assistant. But the
 * PRACTICAL question behind "data flow" for our use case is answerable cheaply:
 *
 *   "What external state does this function touch?"
 *
 * We answer it by computing each function's FREE VARIABLES — identifiers it
 * references that it does NOT itself declare (not params, not locals). Those are
 * exactly the function's data dependencies: imported symbols, module-level
 * state, closure captures, `this.x` fields. Cross-referenced with the import
 * graph, this tells us a component's `dispatch`/`useSelector`/`db.query` touch
 * points — the "what is this wired to" answer — without an interpreter.
 *
 * Algorithm (per function subtree, via tree-sitter):
 *   1. Collect DECLARED names: the function's parameters + any local
 *      declarations (let/const/var, := , Python assignment targets, `for` binds).
 *   2. Walk all identifier nodes in the body; any identifier NOT in the declared
 *      set and NOT a property-access key is a free variable.
 *   3. De-dupe, drop language keywords/builtins, and rank by frequency.
 *
 * This is a sound OVER-approximation for retrieval purposes (we'd rather list a
 * couple extra candidate dependencies than miss the real one). It is NOT a
 * precise dataflow result and isn't used for any correctness-critical decision —
 * only to widen/explain context.
 */

import { getParser, detectLanguage } from '../tools/ast/parser.js';

export interface FunctionDataFlow {
  name: string;
  startLine: number;
  endLine: number;
  /** Free variables (external dependencies), most-referenced first. */
  freeVars: Array<{ name: string; count: number }>;
}

// Identifiers we never report as dependencies (language builtins / noise).
const BUILTINS = new Set([
  // JS/TS
  'this', 'super', 'arguments', 'undefined', 'null', 'true', 'false', 'console',
  'window', 'document', 'globalThis', 'process', 'require', 'module', 'exports',
  'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Promise',
  'Date', 'Map', 'Set', 'Symbol', 'Error', 'RegExp', 'parseInt', 'parseFloat',
  'isNaN', 'setTimeout', 'setInterval', 'await', 'async', 'return', 'if', 'else',
  'for', 'while', 'const', 'let', 'var', 'function', 'class', 'new', 'typeof',
  // Python
  'self', 'cls', 'None', 'True', 'False', 'print', 'len', 'range', 'dict', 'list',
  'str', 'int', 'float', 'bool', 'tuple', 'set', 'enumerate', 'zip', 'map', 'filter',
  'super', 'isinstance', 'type', 'open', 'import', 'from', 'def', 'return', 'raise',
]);

const FUNC_NODE_RE = /function_declaration|function_definition|method_definition|method_declaration|arrow_function|function_item|function|method/;
const LOCAL_DECL_RE = /variable_declarator|lexical_declaration|let_declaration|assignment|short_var_declaration|expression_statement/;

/** Extract the function name from a function-ish node. */
function funcName(node: any, source: string): string {
  const n = node.childForFieldName?.('name');
  if (n) return source.slice(n.startIndex, n.endIndex);
  return '<anonymous>';
}

/** Collect identifier strings declared as parameters within `node`. */
function collectParams(node: any, source: string, into: Set<string>): void {
  const params = node.childForFieldName?.('parameters');
  if (!params) return;
  const walk = (n: any) => {
    if (!n) return;
    if (n.type === 'identifier' || n.type === 'shorthand_property_identifier_pattern') {
      into.add(source.slice(n.startIndex, n.endIndex));
    }
    for (let i = 0; i < (n.childCount ?? 0); i++) walk(n.child(i));
  };
  walk(params);
}

/**
 * Analyze every top-level-ish function in a file and return its free variables.
 * Best-effort: returns [] on parse failure / unsupported language.
 */
export async function analyzeDataFlow(rel: string, content: string): Promise<FunctionDataFlow[]> {
  const lang = detectLanguage(rel);
  if (!lang) return [];
  let parser;
  try { parser = await getParser(lang); } catch { return []; }
  if (!parser) return [];
  let tree;
  try { tree = parser.parser.parse(content); } catch { return []; }

  const results: FunctionDataFlow[] = [];

  const analyzeFunction = (fnNode: any) => {
    const declared = new Set<string>();
    collectParams(fnNode, content, declared);

    // First pass: gather locally-declared names so they don't count as free.
    const gatherDecls = (n: any) => {
      if (!n) return;
      if (LOCAL_DECL_RE.test(n.type)) {
        const nameNode = n.childForFieldName?.('name') ?? n.childForFieldName?.('left');
        if (nameNode && (nameNode.type === 'identifier')) {
          declared.add(content.slice(nameNode.startIndex, nameNode.endIndex));
        }
        // variable_declarator with destructuring / multiple
        for (let i = 0; i < (n.childCount ?? 0); i++) {
          const c = n.child(i);
          if (c?.type === 'identifier' && i === 0) {
            declared.add(content.slice(c.startIndex, c.endIndex));
          }
        }
      }
      // nested function params are declared in their own scope but we keep it
      // simple: treat them as declared so we don't over-report.
      if (FUNC_NODE_RE.test(n.type) && n !== fnNode) {
        collectParams(n, content, declared);
      }
      for (let i = 0; i < (n.childCount ?? 0); i++) gatherDecls(n.child(i));
    };
    const body = fnNode.childForFieldName?.('body') ?? fnNode;
    gatherDecls(body);

    // Second pass: count free identifiers (not declared, not a property key).
    const freq = new Map<string, number>();
    const walk = (n: any) => {
      if (!n) return;
      if (n.type === 'identifier') {
        const name = content.slice(n.startIndex, n.endIndex);
        // Allow single-char identifiers — they can be real function refs (g, _, $).
        // Only skip empty strings and pure noise: single underscores are common
        // throwaway vars, but we keep everything else including single letters.
        if (name.length >= 1 && name !== '_' && !declared.has(name) && !BUILTINS.has(name)) {
          freq.set(name, (freq.get(name) ?? 0) + 1);
        }
      } else if (n.type === 'member_expression') {
        // obj.property — only walk the OBJECT side (left); skip the property name (right).
        // Field names: object (left side), property (right side = what we skip).
        const obj = n.childForFieldName?.('object');
        if (obj) walk(obj);
        // Don't descend into property — it's always a reference to a key, not a variable.
      } else if (n.type === 'pair' || n.type === 'shorthand_property_identifier_pattern') {
        // Object literal { key: val } — skip the key, walk the value.
        const val = n.childForFieldName?.('value');
        if (val) walk(val);
      } else {
        for (let i = 0; i < (n.childCount ?? 0); i++) walk(n.child(i));
      }
    };
    walk(body);

    const freeVars = [...freq.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15);

    results.push({
      name: funcName(fnNode, content),
      startLine: fnNode.startPosition.row + 1,
      endLine: fnNode.endPosition.row + 1,
      freeVars,
    });
  };

  // Find function nodes anywhere in the tree (depth-unbounded, like ast-chunk).
  const findFns = (n: any, depth: number) => {
    if (depth > 12 || !n) return;
    if (FUNC_NODE_RE.test(n.type)) {
      analyzeFunction(n);
      // still descend — nested functions are analyzed too
    }
    for (let i = 0; i < (n.childCount ?? 0); i++) findFns(n.child(i), depth + 1);
  };
  findFns(tree.rootNode, 0);

  return results;
}

/**
 * Given a target symbol/function name in a file, return the external symbols it
 * depends on (free variables). Convenience wrapper for the data_flow tool.
 */
export async function dependenciesOf(rel: string, content: string, functionName: string): Promise<string[]> {
  const flows = await analyzeDataFlow(rel, content);
  const match = flows.find(f => f.name === functionName)
    ?? flows.find(f => f.name.toLowerCase() === functionName.toLowerCase());
  return match ? match.freeVars.map(v => v.name) : [];
}
