import { describe, it, expect } from 'vitest';
import {
  relevantTouchedFiles, filterToTouched,
  buildVerifyRepairMessage, buildVerifyGiveupMessage,
} from '../src/agent/verification.js';
import { CHECKERS } from '../src/tools/diagnostics/checkers.js';
import type { Diagnostic } from '../src/tools/diagnostics/parsers.js';

const tsc = CHECKERS.find(c => c.id === 'tsc')!;
const ruff = CHECKERS.find(c => c.id === 'ruff')!;

describe('relevantTouchedFiles', () => {
  it('keeps only files in the checker\'s language', () => {
    const touched = ['src/a.ts', 'src/b.tsx', 'README.md', 'data.json', 'x.py'];
    expect(relevantTouchedFiles(touched, tsc)).toEqual(['src/a.ts', 'src/b.tsx']);
    expect(relevantTouchedFiles(touched, ruff)).toEqual(['x.py']);
  });
  it('is empty when nothing matches', () => {
    expect(relevantTouchedFiles(['a.md', 'b.json'], tsc)).toEqual([]);
  });
});

describe('filterToTouched', () => {
  const cwd = '/proj';
  const diags: Diagnostic[] = [
    { file: 'src/a.ts', line: 1, severity: 'error', message: 'boom' },
    { file: 'src/b.ts', line: 2, severity: 'error', message: 'pre-existing' },
    { file: '/proj/src/c.ts', line: 3, severity: 'warning', message: 'abs path' },
  ];
  it('keeps only diagnostics in touched files (relative or absolute)', () => {
    const out = filterToTouched(diags, ['src/a.ts', '/proj/src/c.ts'], cwd);
    expect(out.map(d => d.file)).toEqual(['src/a.ts', '/proj/src/c.ts']);
  });
  it('drops diagnostics in files the model did not touch (pre-existing errors)', () => {
    const out = filterToTouched(diags, ['src/a.ts'], cwd);
    expect(out).toHaveLength(1);
    expect(out[0]!.file).toBe('src/a.ts');
  });
  it('matches a relative diag against an absolute touched path and vice versa', () => {
    const out = filterToTouched([{ file: 'src/a.ts', line: 1, severity: 'error', message: 'x' }], ['/proj/src/a.ts'], cwd);
    expect(out).toHaveLength(1);
  });
});

describe('buildVerifyRepairMessage', () => {
  const cwd = '/proj';
  const diags: Diagnostic[] = [
    { file: '/proj/src/a.ts', line: 12, col: 5, severity: 'error', code: 'TS2304', message: "Cannot find name 'foo'." },
    { file: 'src/a.ts', line: 20, severity: 'warning', message: 'unused' },
  ];
  it('reports the error count and lists errors (not warnings)', () => {
    const msg = buildVerifyRepairMessage(diags, 'tsc', 1, 2, cwd);
    expect(msg).toContain('[AUTO-VERIFY]');
    expect(msg).toContain('1 error(s)');
    expect(msg).toContain('auto-repair 1/2');
    expect(msg).toContain('src/a.ts:12:5');
    expect(msg).toContain('TS2304');
    expect(msg).not.toContain('unused'); // warnings excluded from the list
  });
  it('relativizes absolute paths against cwd', () => {
    const msg = buildVerifyRepairMessage(diags, 'tsc', 1, 2, cwd);
    expect(msg).toContain('src/a.ts:12:5');
    expect(msg).not.toContain('/proj/src/a.ts:12');
  });
  it('truncates long error lists with a "more" line', () => {
    const many: Diagnostic[] = Array.from({ length: 20 }, (_, i) => ({ file: 'a.ts', line: i + 1, severity: 'error' as const, message: `e${i}` }));
    const msg = buildVerifyRepairMessage(many, 'tsc', 2, 2, cwd);
    expect(msg).toContain('and 5 more.');
  });
});

describe('buildVerifyGiveupMessage', () => {
  it('explains it is stopping and tells the model not to claim done', () => {
    const msg = buildVerifyGiveupMessage(3, 'tsc');
    expect(msg).toContain('3 tsc error(s) remain');
    expect(msg).toContain('do not claim the task is fully done');
  });
});

describe('checker registry sanity', () => {
  it('every checker has exts and a detect function', () => {
    for (const c of CHECKERS) {
      expect(Array.isArray(c.exts)).toBe(true);
      expect(c.exts.length).toBeGreaterThan(0);
      expect(typeof c.detect).toBe('function');
    }
  });
  it('tsc detects on tsconfig.json, ruff on pyproject.toml', () => {
    expect(tsc.detect(new Set(['tsconfig.json']))).toBe(true);
    expect(tsc.detect(new Set(['go.mod']))).toBe(false);
    expect(ruff.detect(new Set(['pyproject.toml']))).toBe(true);
  });
});
