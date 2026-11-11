import { describe, it, expect } from 'vitest';
import { groupByCwd, drainDesks } from '../src/resident/desks.js';
import { residentPass, pidAlive } from '../src/resident/loop.js';
import { sealCandidates, sealContentHash, type SealCache, type SealDeps } from '../src/resident/seal.js';
import type { WitnessVerdict } from '../src/skills/learning/witness.js';

const passWitness = (): WitnessVerdict => ({
  pass: true, replay: 'applied', errorCount: 0, files: 1, checker: 'tsc', at: 't',
});

function sealDeps(over: Partial<SealDeps> & { md?: string }): SealDeps {
  const cache: SealCache = {};
  let replayCalls = 0;
  const md = over.md ?? '---\nname: x\n---\nbody\n';
  const base: SealDeps = {
    list: async () => [{ name: 'x' }],
    read: async () => md,
    replay: async () => { replayCalls += 1; return passWitness(); },
    active: async () => null,
    promote: async () => ({ promoted: true, reason: 'ok' }),
    snapshot: async () => 'snap',
    record: async () => {},
    loadCache: async () => cache,
    saveCache: async next => {
      const copy = { ...next };
      for (const k of Object.keys(cache)) delete cache[k];
      Object.assign(cache, copy);
    },
  };
  const deps = { ...base, ...over };
  (deps as any).replayCalls = () => replayCalls;
  return deps;
}

describe('resident desks', () => {
  it('keeps one directory sequential and splits the others', () => {
    const groups = groupByCwd([
      { name: 'a', cwd: '/one' },
      { name: 'c', cwd: '/two' },
      { name: 'b', cwd: '/one' },
    ]);
    expect(groups).toEqual([['a', 'b'], ['c']]);
  });

  it('does not run two desks in the same directory at once', async () => {
    let busy = 0;
    let overlap = false;
    const codes = await drainDesks(async name => {
      if (name === 'a' || name === 'b') {
        if (busy > 0) overlap = true;
        busy += 1;
      }
      await new Promise(r => setTimeout(r, 30));
      if (name === 'a' || name === 'b') busy -= 1;
      return 0;
    }, async () => [
      { name: 'a', cwd: '/one' },
      { name: 'b', cwd: '/one' },
      { name: 'c', cwd: '/two' },
    ]);
    expect(overlap).toBe(false);
    expect(codes.map(c => c.name).sort()).toEqual(['a', 'b', 'c']);
    expect(codes.every(c => c.code === 0)).toBe(true);
  });
});

describe('seal', () => {
  it('hashes the skill text', () => {
    expect(sealContentHash('abc')).toBe(sealContentHash('abc'));
    expect(sealContentHash('abc')).not.toBe(sealContentHash('abd'));
  });

  it('promotes a clean witness and does not ask a model', async () => {
    let promoted = '';
    const deps = sealDeps({
      promote: async name => { promoted = name; return { promoted: true, reason: 'ok' }; },
    });
    const result = await sealCandidates('/repo', deps);
    expect(result.promoted).toEqual(['x']);
    expect(promoted).toBe('x');
    expect(result.snapshot).toBe('snap');
  });

  it('does not overwrite a human skill', async () => {
    let called = false;
    const deps = sealDeps({
      active: async () => ({ provenance: 'user' }),
      promote: async () => { called = true; return { promoted: true, reason: 'no' }; },
    });
    const result = await sealCandidates('/repo', deps);
    expect(called).toBe(false);
    expect(result.promoted).toEqual([]);
    expect(result.rejected[0]?.reason).toMatch(/human-authored/);
  });

  it('does not replay a patch that already failed', async () => {
    let calls = 0;
    const failed: WitnessVerdict = { pass: false, replay: 'conflict', errorCount: 0, files: 1, note: 'no', at: 't' };
    const deps = sealDeps({
      replay: async () => { calls += 1; return failed; },
    });
    const first = await sealCandidates('/repo', deps);
    const second = await sealCandidates('/repo', deps);
    expect(first.rejected).toHaveLength(1);
    expect(second.skipped[0]?.reason).toMatch(/already failed/);
    expect(calls).toBe(1);
  });
});

describe('resident pass', () => {
  it('runs schedules and desks without sealing unless asked', async () => {
    let sealed = 0;
    const status = await residentPass({
      cwd: '/repo',
      seal: false,
      tickFn: async () => ({ ranIds: ['nightly'], skipped: [], failed: [], acquired: true }),
      loadJobs: async () => [],
      sealFn: async () => { sealed += 1; return { promoted: [], rejected: [], skipped: [], snapshot: null }; },
    });
    expect(status.schedule.ran).toBe(1);
    expect(sealed).toBe(0);
    expect(status.seal.enabled).toBe(false);
  });

  it('seals when the pass asks it to', async () => {
    const status = await residentPass({
      cwd: '/repo',
      seal: true,
      tickFn: async () => ({ ranIds: [], skipped: [], failed: [], acquired: true }),
      loadJobs: async () => [],
      sealFn: async () => ({ promoted: ['fix-tsc'], rejected: [], skipped: [], snapshot: null }),
    });
    expect(status.seal.promoted).toEqual(['fix-tsc']);
  });

  it('pidAlive knows this process', () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(0)).toBe(false);
  });
});
