import { describe, it, expect } from 'vitest';
import { emergencyStop, registerStopHandler, formatStopReport } from '../src/control/emergency-stop.js';
import { getBus } from '../src/control/bus.js';

const quietDeps = {
  listSideRuns: () => [],
  stopSideRun: () => false,
  stopManagedProcesses: async () => 0,
  listActiveMissions: () => [],
  cancelMission: () => ({ ok: true, message: '' }),
};

describe('emergency stop', () => {
  it('stops the registered run, side runs and processes; missions only with /stop all', async () => {
    let aborted = '';
    const off = registerStopHandler('current run', (reason) => { aborted = reason; return 'the running turn'; });
    const cancelled: string[] = [];
    const deps = {
      ...quietDeps,
      listSideRuns: () => [{ id: 's1', status: 'running' }, { id: 's2', status: 'done' }],
      stopSideRun: (id: string) => id === 's1',
      stopManagedProcesses: async () => 2,
      listActiveMissions: () => [{ id: 'm1', goal: 'watch prices' }],
      cancelMission: (id: string) => { cancelled.push(id); return { ok: true, message: '' }; },
    };
    try {
      const r = await emergencyStop({ deps, reason: 'test', by: 'tester' });
      expect(aborted).toBe('test');
      expect(r.stopped).toEqual(['the running turn', 'side run s1', '2 managed processes (dev servers)']);
      expect(cancelled).toEqual([]);
      expect(formatStopReport(r, false)).toMatch(/\/stop all/);

      const all = await emergencyStop({ deps, missions: true, by: 'tester' });
      expect(cancelled).toEqual(['m1']);
      expect(all.stopped).toContain('mission m1 (watch prices)');
      expect(formatStopReport(all, true)).not.toMatch(/\/stop all/);
    } finally { off(); }
  });

  it('a failing step never stops the others, and the bus hears about it', async () => {
    const seen: string[] = [];
    const unsub = getBus().subscribe(ev => { if (ev.kind === 'notice') seen.push(ev.message); });
    const off = registerStopHandler('broken', () => { throw new Error('boom'); });
    try {
      const r = await emergencyStop({ deps: { ...quietDeps, stopManagedProcesses: async () => 1 }, by: 'phone' });
      expect(r.errors).toEqual(['broken: boom']);
      expect(r.stopped).toEqual(['1 managed process (dev servers)']);
      expect(seen.some(m => /Emergency stop by phone/.test(m))).toBe(true);
    } finally { off(); unsub(); }
  });

  it('nothing running reads as such', async () => {
    const r = await emergencyStop({ deps: quietDeps });
    expect(formatStopReport(r, true)).toBe('⏹ Nothing was running.');
  });
});
