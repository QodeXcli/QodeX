import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraphDB } from '../src/codegraph/schema.js';
import { Indexer } from '../src/codegraph/indexer.js';
import {
  computeBlastRadius,
  graphIsFresh,
  isTestFile,
  isCodeFile,
  IMPACT_NOTE_MAX_CHARS,
} from '../src/agent/blast-radius.js';

let tmpDir: string;
let dbPath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qodex-blast-'));
  dbPath = path.join(tmpDir, 'codegraph.db');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Tiny fixture: lib.ts (edited file) + two callers + one test file. Returns an indexed DB. */
async function buildFixture(): Promise<{ db: CodeGraphDB; libPath: string; cartPath: string; reportPath: string; testPath: string }> {
  const libPath = path.join(tmpDir, 'lib.ts');
  await fs.writeFile(libPath,
    'export function calculateTotal(items: number[]) {\n' +
    '  return items.reduce((a, b) => a + b, 0);\n' +
    '}\n');
  const cartPath = path.join(tmpDir, 'cart.ts');
  await fs.writeFile(cartPath,
    'import { calculateTotal } from "./lib";\n' +
    'export function checkout(cart: { items: number[] }) {\n' +
    '  return calculateTotal(cart.items);\n' +
    '}\n');
  const reportPath = path.join(tmpDir, 'report.ts');
  await fs.writeFile(reportPath,
    'import { calculateTotal } from "./lib";\n' +
    'export const total = calculateTotal([1, 2, 3]);\n');
  await fs.mkdir(path.join(tmpDir, 'test'));
  const testPath = path.join(tmpDir, 'test', 'lib.test.ts');
  await fs.writeFile(testPath,
    'import { calculateTotal } from "../lib";\n' +
    'it("sums", () => { expect(calculateTotal([1])).toBe(1); });\n');

  const db = new CodeGraphDB(dbPath);
  await new Indexer(db, tmpDir).indexAll();
  return { db, libPath, cartPath, reportPath, testPath };
}

describe('blast-radius: impact summary', () => {
  it('lists callers, reference count, and covering tests', async () => {
    const { db, libPath } = await buildFixture();

    const impact = await computeBlastRadius(db, libPath, {
      cwd: tmpDir,
      wasRead: () => true, // everything read — no warning expected
    });

    expect(impact.note).toContain('[impact]');
    expect(impact.note).toContain('lib.ts');
    expect(impact.symbols).toContain('calculateTotal');
    // Both consumer files show up as callers; the test file is classified separately
    expect(impact.callerFiles).toContain('cart.ts');
    expect(impact.callerFiles).toContain('report.ts');
    expect(impact.testFiles).toEqual([path.join('test', 'lib.test.ts')]);
    expect(impact.note).toContain('cart.ts');
    expect(impact.note).toContain('tests:');
    // References exclude the edited file itself (import + call in each consumer)
    expect(impact.refCount).toBeGreaterThanOrEqual(4);
    // All caller files were "read" → no warning
    expect(impact.unreadCallerFiles).toEqual([]);
    expect(impact.note).not.toContain('⚠');
  }, 30000);

  it('warns about unread caller files only when the ledger lacks them', async () => {
    const { db, libPath, cartPath } = await buildFixture();

    // Ledger knows cart.ts but not report.ts
    const readSet = new Set([cartPath]);
    const impact = await computeBlastRadius(db, libPath, {
      cwd: tmpDir,
      wasRead: (p) => readSet.has(p),
    });
    expect(impact.unreadCallerFiles).toEqual(['report.ts']);
    expect(impact.note).toContain('⚠ 1 caller file not read this session: report.ts');

    // Same analysis with a fully-read ledger → warning disappears
    const clean = await computeBlastRadius(db, libPath, { cwd: tmpDir, wasRead: () => true });
    expect(clean.unreadCallerFiles).toEqual([]);
    expect(clean.note).not.toContain('not read this session');

    // No ledger at all (CLI mode) → no warning either
    const cli = await computeBlastRadius(db, libPath, { cwd: tmpDir });
    expect(cli.unreadCallerFiles).toEqual([]);
    expect(cli.note).not.toContain('⚠');
  }, 30000);

  it('is a graceful no-op when the DB is absent or the file is unindexed', async () => {
    const somePath = path.join(tmpDir, 'nope.ts');

    // No DB at all
    const noDb = await computeBlastRadius(null, somePath, { cwd: tmpDir });
    expect(noDb.note).toBe('');
    expect(noDb.symbols).toEqual([]);

    // DB exists but never indexed this file
    const db = new CodeGraphDB(dbPath);
    const unindexed = await computeBlastRadius(db, somePath, { cwd: tmpDir });
    expect(unindexed.note).toBe('');
    expect(unindexed.callerFiles).toEqual([]);
  }, 30000);

  it('stays silent when the graph is stale (freshness window)', async () => {
    const { db, libPath } = await buildFixture();
    // Backdate the index timestamp far beyond the freshness window
    db.setMeta('last_full_index', new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString());
    // Also backdate the per-file fallback timestamp
    db.db.prepare(`UPDATE files SET indexed_at = '2020-01-01 00:00:00'`).run();

    expect(graphIsFresh(db, 7 * 24 * 3600 * 1000)).toBe(false);
    const impact = await computeBlastRadius(db, libPath, { cwd: tmpDir });
    expect(impact.note).toBe('');

    // Infinity window (CLI mode) still answers
    const cli = await computeBlastRadius(db, libPath, { cwd: tmpDir, maxGraphAgeMs: Number.POSITIVE_INFINITY });
    expect(cli.note).toContain('[impact]');
  }, 30000);

  it('respects the character cap and keeps the warning line under pressure', async () => {
    // A fat file: many exported symbols, many long-named caller files
    const symNames = Array.from({ length: 8 }, (_, i) => `veryLongExportedSymbolName${i}`);
    await fs.writeFile(path.join(tmpDir, 'fat.ts'),
      symNames.map(n => `export function ${n}() { return 0; }`).join('\n') + '\n');
    for (let i = 0; i < 10; i++) {
      await fs.writeFile(path.join(tmpDir, `extremely-long-consumer-file-name-${i}.ts`),
        `import { ${symNames[0]} } from "./fat";\n` +
        symNames.map(n => `${n}();`).join('\n') + '\n');
    }
    const db = new CodeGraphDB(dbPath);
    await new Indexer(db, tmpDir).indexAll();

    const impact = await computeBlastRadius(db, path.join(tmpDir, 'fat.ts'), {
      cwd: tmpDir,
      wasRead: () => false, // nothing read → warning must survive the cap
    });
    expect(impact.note.length).toBeLessThanOrEqual(IMPACT_NOTE_MAX_CHARS);
    expect(impact.note).toContain('⚠');

    // Tighter explicit cap is honored too, still preserving the warning
    const tight = await computeBlastRadius(db, path.join(tmpDir, 'fat.ts'), {
      cwd: tmpDir,
      wasRead: () => false,
      maxChars: 200,
    });
    expect(tight.note.length).toBeLessThanOrEqual(200);
    expect(tight.note).toContain('not read this session');
  }, 30000);

  it('symbolFilter narrows the analysis to one symbol (CLI symbol mode)', async () => {
    const { db, libPath } = await buildFixture();
    const impact = await computeBlastRadius(db, libPath, {
      cwd: tmpDir,
      symbolFilter: ['calculateTotal'],
      maxGraphAgeMs: Number.POSITIVE_INFINITY,
    });
    expect(impact.symbols).toEqual(['calculateTotal']);
    expect(impact.callerFiles).toContain('cart.ts');

    // Filtering for a symbol the file doesn't define → empty note
    const miss = await computeBlastRadius(db, libPath, {
      cwd: tmpDir,
      symbolFilter: ['doesNotExist'],
    });
    expect(miss.note).toBe('');
  }, 30000);
});

describe('blast-radius: helpers', () => {
  it('isTestFile matches common test layouts', () => {
    expect(isTestFile('test/lib.test.ts')).toBe(true);
    expect(isTestFile('src/__tests__/foo.tsx')).toBe(true);
    expect(isTestFile('foo.spec.js')).toBe(true);
    expect(isTestFile('pkg/thing_test.go')).toBe(true);
    expect(isTestFile('test_models.py')).toBe(true);
    expect(isTestFile('src/lib.ts')).toBe(false);
    expect(isTestFile('src/latest.ts')).toBe(false);
  });

  it('isCodeFile follows the indexed-language map', () => {
    expect(isCodeFile('/a/b.ts')).toBe(true);
    expect(isCodeFile('/a/b.py')).toBe(true);
    expect(isCodeFile('/a/b.md')).toBe(false);
    expect(isCodeFile('/a/codegraph.db')).toBe(false);
  });
});
