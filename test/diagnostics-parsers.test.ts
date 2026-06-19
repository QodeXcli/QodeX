import { describe, it, expect } from 'vitest';
import {
  parseTsc, parseEslintJson, parseRuffJson, parsePyrightJson, parseLineColMessage,
  formatDiagnostics,
} from '../src/tools/diagnostics/parsers.js';

describe('parseTsc', () => {
  it('parses position + code + message', () => {
    const out = `src/app.ts(12,5): error TS2304: Cannot find name 'foo'.
src/util.ts(3,1): warning TS6133: 'x' is declared but never read.
random noise line that should be ignored`;
    const d = parseTsc(out);
    expect(d).toHaveLength(2);
    expect(d[0]).toEqual({ file: 'src/app.ts', line: 12, col: 5, severity: 'error', code: 'TS2304', message: "Cannot find name 'foo'." });
    expect(d[1]!.severity).toBe('warning');
    expect(d[1]!.code).toBe('TS6133');
  });
  it('returns empty for clean output', () => {
    expect(parseTsc('')).toEqual([]);
  });
});

describe('parseEslintJson', () => {
  it('maps severity 2→error, 1→warning', () => {
    const json = JSON.stringify([
      { filePath: '/p/a.js', messages: [
        { line: 1, column: 2, severity: 2, message: 'no-undef', ruleId: 'no-undef' },
        { line: 5, column: 1, severity: 1, message: 'unused', ruleId: 'no-unused-vars' },
      ] },
      { filePath: '/p/b.js', messages: [] },
    ]);
    const d = parseEslintJson(json);
    expect(d).toHaveLength(2);
    expect(d[0]!.severity).toBe('error');
    expect(d[1]!.severity).toBe('warning');
    expect(d[0]!.code).toBe('no-undef');
  });
  it('tolerates null ruleId', () => {
    const json = JSON.stringify([{ filePath: 'x', messages: [{ line: 1, column: 1, severity: 2, message: 'm', ruleId: null }] }]);
    expect(parseEslintJson(json)[0]!.code).toBeUndefined();
  });
});

describe('parseRuffJson', () => {
  it('parses ruff violations', () => {
    const json = JSON.stringify([
      { filename: 'app.py', location: { row: 10, column: 3 }, code: 'F401', message: 'imported but unused' },
    ]);
    const d = parseRuffJson(json);
    expect(d[0]).toEqual({ file: 'app.py', line: 10, col: 3, severity: 'error', message: 'imported but unused', code: 'F401' });
  });
});

describe('parsePyrightJson', () => {
  it('converts 0-based positions to 1-based', () => {
    const json = JSON.stringify({
      generalDiagnostics: [
        { file: 'm.py', severity: 'error', message: 'bad', rule: 'reportGeneralTypeIssues', range: { start: { line: 4, character: 2 } } },
        { file: 'm.py', severity: 'warning', message: 'meh', range: { start: { line: 0, character: 0 } } },
      ],
    });
    const d = parsePyrightJson(json);
    expect(d[0]).toEqual({ file: 'm.py', line: 5, col: 3, severity: 'error', message: 'bad', code: 'reportGeneralTypeIssues' });
    expect(d[1]).toEqual({ file: 'm.py', line: 1, col: 1, severity: 'warning', message: 'meh', code: undefined });
  });
});

describe('parseLineColMessage', () => {
  it('parses file:line:col: message and file:line: message', () => {
    const out = `main.go:12:6: undefined: foo
helper.go:3: something wrong
# a comment line ignored`;
    const d = parseLineColMessage(out);
    expect(d).toHaveLength(2);
    expect(d[0]).toEqual({ file: 'main.go', line: 12, col: 6, severity: 'error', message: 'undefined: foo' });
    expect(d[1]).toEqual({ file: 'helper.go', line: 3, severity: 'error', message: 'something wrong' });
  });
});

describe('formatDiagnostics', () => {
  it('reports a clean result', () => {
    const r = formatDiagnostics([], { checker: 'tsc', maxResults: 50 });
    expect(r).toContain('No problems found');
  });
  it('groups by file and caps results', () => {
    const diags = [
      { file: 'a.ts', line: 1, col: 1, severity: 'error' as const, message: 'e1', code: 'TS1' },
      { file: 'a.ts', line: 2, severity: 'warning' as const, message: 'w1' },
      { file: 'b.ts', line: 9, severity: 'error' as const, message: 'e2' },
    ];
    const r = formatDiagnostics(diags, { checker: 'tsc', maxResults: 2 });
    expect(r).toContain('## a.ts');
    expect(r).toContain('showing first 2');
    // header counts the full set (2 errors, 1 warning) even though the body is capped
    expect(r).toContain('2 error(s), 1 warning(s)');
  });
});
