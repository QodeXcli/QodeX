import { describe, it, expect } from 'vitest';
import { diffDiagnostics } from '../src/agent/verification.js';
import type { Diagnostic } from '../src/tools/diagnostics/parsers.js';

const mk = (file: string, line: number, message: string, code?: string): Diagnostic => ({
  file, line, column: 1, severity: 'error', message, code,
});

describe('diffDiagnostics (verify baseline)', () => {
  it('reports only genuinely new errors', () => {
    const baseline = [mk('a.ts', 10, 'Cannot find name foo', 'TS2304')];
    const current = [
      mk('a.ts', 12, 'Cannot find name foo', 'TS2304'),  // pre-existing, shifted line
      mk('a.ts', 30, 'Property bar missing', 'TS2339'),   // NEW
    ];
    const fresh = diffDiagnostics(baseline, current);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].code).toBe('TS2339');
  });

  it('ignores line shifts of a pre-existing error', () => {
    const baseline = [mk('a.ts', 10, 'Type X not assignable', 'TS2322')];
    const current = [mk('a.ts', 99, 'Type X not assignable', 'TS2322')]; // same error, moved
    expect(diffDiagnostics(baseline, current)).toHaveLength(0);
  });

  it('returns nothing when the model introduced no new errors', () => {
    const baseline = [mk('a.ts', 1, 'e1'), mk('a.ts', 2, 'e2')];
    const current = [mk('a.ts', 5, 'e1'), mk('a.ts', 6, 'e2')];
    expect(diffDiagnostics(baseline, current)).toHaveLength(0);
  });

  it('occurrence-counts duplicates (2 before, 3 now → 1 new)', () => {
    const baseline = [mk('a.ts', 1, 'dup', 'TS1'), mk('a.ts', 2, 'dup', 'TS1')];
    const current = [mk('a.ts', 1, 'dup', 'TS1'), mk('a.ts', 2, 'dup', 'TS1'), mk('a.ts', 3, 'dup', 'TS1')];
    expect(diffDiagnostics(baseline, current)).toHaveLength(1);
  });

  it('with an empty baseline, every current error is new', () => {
    const current = [mk('a.ts', 1, 'e1'), mk('b.ts', 2, 'e2')];
    expect(diffDiagnostics([], current)).toHaveLength(2);
  });
});
