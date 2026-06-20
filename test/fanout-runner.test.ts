import { describe, it, expect, afterEach } from 'vitest';
import { runFanout, type FanoutJob } from '../src/orchestration/fanout.js';
import { setSubAgentRunner } from '../src/tools/builtin/task.js';

function job(label: string, extra: Partial<FanoutJob> = {}): FanoutJob {
  return { label, prompt: `do ${label}`, sessionId: `s/${label}`, ...extra };
}

afterEach(() => setSubAgentRunner(null));

describe('runFanout', () => {
  it('runs every job and returns results in input order', async () => {
    setSubAgentRunner(async (prompt) => ({
      finalText: `done: ${prompt}`,
      toolCallsRun: 1,
      ok: true,
    }));
    const jobs = ['a', 'b', 'c'].map((l) => job(l));
    const results = await runFanout(jobs, { maxConcurrency: 2 });
    expect(results.map((r) => r.label)).toEqual(['a', 'b', 'c']);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results[1]!.finalText).toBe('done: do b');
  });

  it('never exceeds maxConcurrency in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    setSubAgentRunner(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { finalText: 'ok', toolCallsRun: 0, ok: true };
    });
    const jobs = Array.from({ length: 10 }, (_, i) => job(`j${i}`));
    await runFanout(jobs, { maxConcurrency: 3 });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // actually ran in parallel
  });

  it('captures a thrown runner as ok:false without killing the pool', async () => {
    setSubAgentRunner(async (prompt) => {
      if (prompt.includes('boom')) throw new Error('kaboom');
      return { finalText: 'fine', toolCallsRun: 1, ok: true };
    });
    const jobs = [job('ok1'), job('boom'), job('ok2')];
    const results = await runFanout(jobs, { maxConcurrency: 3 });
    expect(results[0]!.ok).toBe(true);
    expect(results[1]!.ok).toBe(false);
    expect(results[1]!.error).toBe('kaboom');
    expect(results[2]!.ok).toBe(true); // pool survived the throw
  });

  it('propagates a runner-returned failure (ok:false) verbatim', async () => {
    setSubAgentRunner(async () => ({ finalText: 'partial', toolCallsRun: 2, ok: false, error: 'budget exhausted' }));
    const results = await runFanout([job('x')], { maxConcurrency: 1 });
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.error).toBe('budget exhausted');
    expect(results[0]!.finalText).toBe('partial');
  });

  it('marks not-yet-started jobs as aborted when the signal fires first', async () => {
    const ac = new AbortController();
    ac.abort(); // aborted before we even start
    setSubAgentRunner(async () => ({ finalText: 'ok', toolCallsRun: 0, ok: true }));
    const jobs = Array.from({ length: 4 }, (_, i) => job(`j${i}`));
    const results = await runFanout(jobs, { maxConcurrency: 2, signal: ac.signal });
    expect(results).toHaveLength(4);
    expect(results.every((r) => !r.ok && r.error === 'aborted before start')).toBe(true);
  });

  it('throws if sub-agents are not enabled', async () => {
    setSubAgentRunner(null);
    await expect(runFanout([job('x')], { maxConcurrency: 1 })).rejects.toThrow(/sub-agents/i);
  });
});
