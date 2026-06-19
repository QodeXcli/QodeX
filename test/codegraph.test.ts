import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraphDB } from '../src/codegraph/schema.js';
import { Indexer } from '../src/codegraph/indexer.js';
import { extractSymbols } from '../src/codegraph/extractor.js';

let tmpDir: string;
let dbPath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qodex-cg-'));
  dbPath = path.join(tmpDir, 'codegraph.db');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('Code graph regex extractor (no WASM grammars needed)', () => {
  it('extracts TypeScript functions and classes via regex fallback', async () => {
    const source = `
export function calculateTotal(items: number[]) {
  return items.reduce((a, b) => a + b, 0);
}

export class ShoppingCart {
  total() { return 0; }
}

export interface Discount { amount: number; }
export type Money = { amount: number; currency: string };
`;
    const filePath = path.join(tmpDir, 'cart.ts');
    await fs.writeFile(filePath, source);
    const syms = await extractSymbols(filePath, source);

    const names = syms.map(s => `${s.kind}:${s.name}`);
    expect(names).toContain('function:calculateTotal');
    expect(names).toContain('class:ShoppingCart');
    expect(names).toContain('interface:Discount');
    expect(names).toContain('type:Money');
  });

  it('extracts Python functions and classes', async () => {
    const source = `
def add(a, b):
    return a + b

async def fetch_user(id):
    pass

class User:
    def __init__(self):
        pass
`;
    const filePath = path.join(tmpDir, 'user.py');
    await fs.writeFile(filePath, source);
    const syms = await extractSymbols(filePath, source);
    const names = syms.map(s => `${s.kind}:${s.name}`);
    expect(names).toContain('function:add');
    expect(names).toContain('function:fetch_user');
    expect(names).toContain('class:User');
  });

  it('extracts Rust functions and structs', async () => {
    const source = `
pub fn parse_args() -> Vec<String> {
    std::env::args().collect()
}

pub struct Config {
    pub verbose: bool,
}

pub trait Loader {
    fn load(&self) -> String;
}
`;
    const filePath = path.join(tmpDir, 'cfg.rs');
    await fs.writeFile(filePath, source);
    const syms = await extractSymbols(filePath, source);
    const names = syms.map(s => `${s.kind}:${s.name}`);
    expect(names).toContain('function:parse_args');
    expect(names).toContain('class:Config');
    expect(names).toContain('interface:Loader');
  });
});

describe('Indexer + CodeGraphDB integration', () => {
  it('indexes a small project end-to-end', async () => {
    await fs.writeFile(path.join(tmpDir, 'a.ts'),
      'export function fooBar() { return 42; }\nexport class Widget {}\n');
    await fs.writeFile(path.join(tmpDir, 'b.ts'),
      'export function bazQux(x: number) { return x; }\n');
    await fs.mkdir(path.join(tmpDir, 'node_modules')); // should be ignored
    await fs.writeFile(path.join(tmpDir, 'node_modules', 'noise.ts'), 'export function ignoreMe() {}');

    const db = new CodeGraphDB(dbPath);
    const indexer = new Indexer(db, tmpDir);
    const result = await indexer.indexAll();

    expect(result.filesIndexed).toBe(2);
    expect(result.symbolCount).toBeGreaterThanOrEqual(3);

    const fooMatches = db.findSymbolsByName('fooBar');
    expect(fooMatches).toHaveLength(1);
    expect(fooMatches[0]!.kind).toBe('function');

    // node_modules should not have been indexed
    const ignoreMatches = db.findSymbolsByName('ignoreMe');
    expect(ignoreMatches).toEqual([]);
  });

  it('prefix search finds matches', async () => {
    await fs.writeFile(path.join(tmpDir, 'a.ts'),
      'export function handleClick() {}\nexport function handleSubmit() {}\nexport function unrelated() {}\n');

    const db = new CodeGraphDB(dbPath);
    await new Indexer(db, tmpDir).indexAll();

    const matches = db.searchSymbolsByPrefix('handle');
    const names = matches.map(m => m.name).sort();
    expect(names).toEqual(['handleClick', 'handleSubmit']);
  });

  it('removes deleted files from the index on next run', async () => {
    const aPath = path.join(tmpDir, 'a.ts');
    await fs.writeFile(aPath, 'export function tempThing() {}');

    const db = new CodeGraphDB(dbPath);
    const indexer = new Indexer(db, tmpDir);
    await indexer.indexAll();
    expect(db.findSymbolsByName('tempThing')).toHaveLength(1);

    await fs.unlink(aPath);
    const result = await indexer.indexAll();
    expect(result.filesRemoved).toBe(1);
    expect(db.findSymbolsByName('tempThing')).toEqual([]);
  });

  it('skips unchanged files on incremental run', async () => {
    await fs.writeFile(path.join(tmpDir, 'a.ts'), 'export function alpha() {}');

    const db = new CodeGraphDB(dbPath);
    const indexer = new Indexer(db, tmpDir);
    const r1 = await indexer.indexAll();
    expect(r1.filesIndexed).toBe(1);

    // Second run — nothing changed
    const r2 = await indexer.indexAll();
    expect(r2.filesIndexed).toBe(0);
    expect(r2.filesSkipped).toBe(1);
  });

  it('list_symbols_in_file returns indexed symbols by file path', async () => {
    const filePath = path.join(tmpDir, 'multi.ts');
    await fs.writeFile(filePath,
      'export function one() {}\nexport function two() {}\nexport class Three {}\n');

    const db = new CodeGraphDB(dbPath);
    await new Indexer(db, tmpDir).indexAll();

    const syms = db.listSymbolsInFile(filePath);
    expect(syms.length).toBeGreaterThanOrEqual(3);
    expect(syms.map(s => s.name).sort()).toContain('one');
  });
});

// ============================================================
// v0.4.0 — find_callers / find_references / explain_symbol
// ============================================================

import {
  CodeGraphFindCallersTool,
  CodeGraphFindReferencesTool,
  CodeGraphExplainSymbolTool,
  setCodeGraphDB,
} from '../src/codegraph/tools.js';
import { __setRipgrepAvailable } from '../src/utils/ripgrep.js';
import type { ToolContext } from '../src/tools/base.js';

function makeCtx(cwd: string): ToolContext {
  // The three navigation tools are read-only and don't touch transaction/permissions,
  // so a loose stub is fine. Cast through unknown to silence the strict ToolContext type.
  return {
    cwd,
    sessionId: 'test',
    transaction: {} as any,
    permissions: { check: () => ({ ok: true }) } as any,
    askUser: async () => 'allow',
    signal: new AbortController().signal,
    onUiEvent: () => {},
  } as ToolContext;
}

describe('Code graph: navigation tools (v0.4.0)', () => {
  it('find_callers locates call sites and excludes the definition line', async () => {
    // Build a tiny multi-file project
    await fs.writeFile(path.join(tmpDir, 'lib.ts'),
      'export function calculateTotal(items: number[]) {\n  return items.reduce((a, b) => a + b, 0);\n}\n');
    await fs.writeFile(path.join(tmpDir, 'cart.ts'),
      'import { calculateTotal } from "./lib";\n' +
      'export function checkout(cart) {\n' +
      '  const sum = calculateTotal(cart.items);\n' +
      '  return sum;\n' +
      '}\n');
    await fs.writeFile(path.join(tmpDir, 'report.ts'),
      'import { calculateTotal } from "./lib";\n' +
      'const total = calculateTotal([1,2,3]);\n');

    const db = new CodeGraphDB(dbPath);
    await new Indexer(db, tmpDir).indexAll();
    setCodeGraphDB(db);

    const tool = new CodeGraphFindCallersTool();
    const result = await tool.execute({ name: 'calculateTotal' }, makeCtx(tmpDir));

    expect(result.isError).toBeFalsy();
    // Must reference both caller files but NOT the lib.ts definition line
    expect(result.content).toContain('cart.ts');
    expect(result.content).toContain('report.ts');
    // The definition `export function calculateTotal` is line 1 of lib.ts —
    // it should be filtered out. We verify by checking the result doesn't mention `lib.ts:1`.
    expect(result.content).not.toMatch(/lib\.ts[\s\S]*:1[^0-9]/);
    // Count metadata should be 2 (one call from each consumer file)
    expect((result.metadata as any)?.count).toBe(2);
  }, 30000);

  it('find_callers returns NO_CALLERS when nothing references the symbol', async () => {
    await fs.writeFile(path.join(tmpDir, 'unused.ts'),
      'export function nobodyCallsMe() { return 0; }\n');

    const db = new CodeGraphDB(dbPath);
    await new Indexer(db, tmpDir).indexAll();
    setCodeGraphDB(db);

    const tool = new CodeGraphFindCallersTool();
    const result = await tool.execute({ name: 'nobodyCallsMe' }, makeCtx(tmpDir));
    expect(result.content).toMatch(/NO_CALLERS/);
  }, 30000);

  it('find_references catches usages that find_callers misses (type annotations, imports)', async () => {
    await fs.writeFile(path.join(tmpDir, 'types.ts'),
      'export interface Discount { amount: number; }\n');
    await fs.writeFile(path.join(tmpDir, 'use.ts'),
      'import type { Discount } from "./types";\n' +
      'export function apply(d: Discount) { return d.amount; }\n');

    const db = new CodeGraphDB(dbPath);
    await new Indexer(db, tmpDir).indexAll();
    setCodeGraphDB(db);

    // find_callers wouldn't match "Discount" because it's never `Discount(`
    const callers = new CodeGraphFindCallersTool();
    const cResult = await callers.execute({ name: 'Discount' }, makeCtx(tmpDir));
    expect(cResult.content).toMatch(/NO_CALLERS/);

    // find_references should find the import + type annotation
    const refs = new CodeGraphFindReferencesTool();
    const rResult = await refs.execute({ name: 'Discount' }, makeCtx(tmpDir));
    expect(rResult.isError).toBeFalsy();
    expect(rResult.content).toContain('use.ts');
    expect((rResult.metadata as any)?.count).toBeGreaterThanOrEqual(2); // import + annotation
  }, 30000);

  it('explain_symbol returns signature + body preview + leading docstring', async () => {
    await fs.writeFile(path.join(tmpDir, 'doc.ts'),
`/**
 * Computes the sum of all items.
 * Throws on empty input.
 */
export function calculateTotal(items: number[]): number {
  if (items.length === 0) throw new Error('empty');
  return items.reduce((a, b) => a + b, 0);
}
`);

    const db = new CodeGraphDB(dbPath);
    await new Indexer(db, tmpDir).indexAll();
    setCodeGraphDB(db);

    const tool = new CodeGraphExplainSymbolTool();
    const result = await tool.execute({ name: 'calculateTotal' }, makeCtx(tmpDir));

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('function calculateTotal');
    expect(result.content).toContain('doc.ts');
    // Leading docstring captured
    expect(result.content).toContain('Computes the sum');
    // Body included
    expect(result.content).toContain("throw new Error('empty')");
  }, 30000);

  it('explain_symbol caps body at max_body_lines and notes truncation', async () => {
    // Build a fat function so we can verify the cap
    const lines = ['export function big() {'];
    for (let i = 0; i < 100; i++) lines.push(`  const v${i} = ${i};`);
    lines.push('  return 0;');
    lines.push('}');
    await fs.writeFile(path.join(tmpDir, 'big.ts'), lines.join('\n'));

    const db = new CodeGraphDB(dbPath);
    await new Indexer(db, tmpDir).indexAll();
    setCodeGraphDB(db);

    const tool = new CodeGraphExplainSymbolTool();
    const result = await tool.execute({ name: 'big', max_body_lines: 10 }, makeCtx(tmpDir));
    expect(result.content).toMatch(/more lines/);
  }, 30000);

  it('explain_symbol returns NOT_FOUND with hints when symbol is unknown', async () => {
    await fs.writeFile(path.join(tmpDir, 'a.ts'),
      'export function userProfile() {}\n' +
      'export function userSettings() {}\n');

    const db = new CodeGraphDB(dbPath);
    await new Indexer(db, tmpDir).indexAll();
    setCodeGraphDB(db);

    const tool = new CodeGraphExplainSymbolTool();
    const result = await tool.execute({ name: 'user' }, makeCtx(tmpDir));
    expect(result.content).toMatch(/NOT_FOUND/);
    // Prefix hints should mention the two similar functions
    expect(result.content).toMatch(/userProfile|userSettings/);
  }, 30000);
});

describe('Code graph: navigation tools degrade gracefully without ripgrep', () => {
  // Force the JS fallback path (rg unavailable) for these tests, then restore.
  beforeEach(() => __setRipgrepAvailable(false));
  afterEach(() => __setRipgrepAvailable(null));

  it('find_callers works via the JS fallback when rg is missing', async () => {
    await fs.writeFile(path.join(tmpDir, 'lib.ts'),
      'export function calculateTotal(items) { return 0; }\n');
    await fs.writeFile(path.join(tmpDir, 'cart.ts'),
      'import { calculateTotal } from "./lib";\n' +
      'const sum = calculateTotal([1,2,3]);\n');

    const db = new CodeGraphDB(dbPath);
    await new Indexer(db, tmpDir).indexAll();
    setCodeGraphDB(db);

    const result = await new CodeGraphFindCallersTool().execute({ name: 'calculateTotal' }, makeCtx(tmpDir));
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('cart.ts');
    // Definition line in lib.ts must still be filtered out
    expect((result.metadata as any)?.count).toBe(1);
  }, 30000);

  it('find_callers returns NO_CALLERS (not an error) via fallback when unreferenced', async () => {
    await fs.writeFile(path.join(tmpDir, 'unused.ts'),
      'export function nobodyCallsMe() { return 0; }\n');

    const db = new CodeGraphDB(dbPath);
    await new Indexer(db, tmpDir).indexAll();
    setCodeGraphDB(db);

    const result = await new CodeGraphFindCallersTool().execute({ name: 'nobodyCallsMe' }, makeCtx(tmpDir));
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatch(/NO_CALLERS/);
  }, 30000);

  it('find_references works via the JS fallback when rg is missing', async () => {
    await fs.writeFile(path.join(tmpDir, 'types.ts'),
      'export interface Discount { amount: number; }\n');
    await fs.writeFile(path.join(tmpDir, 'use.ts'),
      'import type { Discount } from "./types";\n' +
      'export function apply(d: Discount) { return d.amount; }\n');

    const db = new CodeGraphDB(dbPath);
    await new Indexer(db, tmpDir).indexAll();
    setCodeGraphDB(db);

    const result = await new CodeGraphFindReferencesTool().execute({ name: 'Discount' }, makeCtx(tmpDir));
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('use.ts');
    expect((result.metadata as any)?.count).toBeGreaterThanOrEqual(2);
  }, 30000);
});
