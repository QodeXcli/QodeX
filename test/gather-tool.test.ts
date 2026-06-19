import { describe, it, expect } from 'vitest';
import { runWithConcurrency, buildScoutPrompt, consolidateFindings, GatherTool } from '../src/tools/builtin/gather.js';

describe('runWithConcurrency', () => {
  it('runs every item and preserves result order', async () => {
    const items = [1, 2, 3, 4, 5];
    const out = await runWithConcurrency(items, 2, async (n) => n * 10);
    expect(out).toEqual([10, 20, 30, 40, 50]);
  });

  it('never exceeds the concurrency limit in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);
    await runWithConcurrency(items, 3, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      return null;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // actually ran concurrently
  });

  it('handles a single item and limit larger than the list', async () => {
    expect(await runWithConcurrency([7], 5, async (n) => n + 1)).toEqual([8]);
    expect(await runWithConcurrency([], 3, async (n: number) => n)).toEqual([]);
  });
});

describe('buildScoutPrompt', () => {
  it('frames the scout as read-only and includes the focus', () => {
    const p = buildScoutPrompt('map auth call sites', 'src/auth');
    expect(p).toContain('READ-ONLY');
    expect(p).toContain('map auth call sites');
    expect(p).toContain('WHERE TO LOOK: src/auth');
    expect(p.toLowerCase()).toContain('do not'); // mutation prohibition
  });
  it('omits the WHERE line when no hint', () => {
    expect(buildScoutPrompt('just this')).not.toContain('WHERE TO LOOK');
  });
});

describe('consolidateFindings', () => {
  it('numbers each probe and includes ok findings', () => {
    const out = consolidateFindings([
      { focus: 'A', ok: true, findings: 'found a1' },
      { focus: 'B', ok: true, findings: 'found b1' },
    ]);
    expect(out).toContain('2 scouts');
    expect(out).toContain('[1] A');
    expect(out).toContain('found a1');
    expect(out).toContain('[2] B');
    expect(out).toContain('Now decide');
  });
  it('surfaces failed scouts without throwing', () => {
    const out = consolidateFindings([{ focus: 'X', ok: false, findings: '', error: 'timeout' }]);
    expect(out).toContain('1 scout)'); // singular
    expect(out).toContain('scout failed: timeout');
  });
  it('handles empty findings gracefully', () => {
    const out = consolidateFindings([{ focus: 'Y', ok: true, findings: '   ' }]);
    expect(out).toContain('(no findings reported)');
  });
});

describe('GatherTool metadata', () => {
  it('is read-only (scouts cannot mutate) with a 1-8 probe schema', () => {
    const t = new GatherTool();
    expect(t.name).toBe('gather');
    expect(t.isReadOnly).toBe(true);
    expect(t.isDestructive).toBe(false);
    expect(() => t.argsSchema.parse({ probes: [{ focus: 'x' }] })).not.toThrow();
    expect(() => t.argsSchema.parse({ probes: [] })).toThrow();       // need >=1
    expect(() => t.argsSchema.parse({ probes: [{}] })).toThrow();      // focus required
  });
});
