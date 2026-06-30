import { describe, it, expect } from 'vitest';
import { parseUnusedDiagnostics } from '../src/cli/maintain-preview.ts';

describe('parseUnusedDiagnostics', () => {
  it('extracts unused-symbol candidates (TS6133/TS6196) with file + name', () => {
    const out = [
      "src/a.ts(10,1): error TS6133: 'logger' is declared but its value is never read.",
      "src/ui.tsx(21,26): error TS6133: 'AgentEvent' is declared but its value is never read.",
      "src/t.ts(3,7): error TS6196: 'Foo' is declared but never used.",
      "src/ok.ts(5,5): error TS2304: Cannot find name 'x'.",   // unrelated — ignored
    ].join('\n');
    const r = parseUnusedDiagnostics(out);
    expect(r.count).toBe(3);
    expect(r.sample.map(c => c.name)).toEqual(['logger', 'AgentEvent', 'Foo']);
    expect(r.sample[0]).toEqual({ file: 'src/a.ts', name: 'logger' });
  });

  it('caps the sample at 8 but counts all', () => {
    const out = Array.from({ length: 20 }, (_, i) => `f${i}.ts(1,1): error TS6133: 'v${i}' is declared but its value is never read.`).join('\n');
    const r = parseUnusedDiagnostics(out);
    expect(r.count).toBe(20);
    expect(r.sample).toHaveLength(8);
  });

  it('empty / clean output → no candidates', () => {
    expect(parseUnusedDiagnostics('')).toEqual({ count: 0, sample: [] });
  });
});
