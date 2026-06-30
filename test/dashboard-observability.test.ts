import { describe, it, expect } from 'vitest';
import { tailLines, computeHealth } from '../src/cli/dashboard-observability.ts';

describe('tailLines', () => {
  it('returns the last n non-empty lines, oldest→newest', () => {
    expect(tailLines('a\n\nb\nc\n\n', 2)).toEqual(['b', 'c']);
    expect(tailLines('only', 5)).toEqual(['only']);
    expect(tailLines('', 5)).toEqual([]);
  });
});

describe('computeHealth', () => {
  it('flags missing cloud keys, surfaces model/scheduler/bot status', () => {
    const h = computeHealth({
      providers: [{ keyEnv: 'A', keySet: true }, { keyEnv: 'B', keySet: false }, { keySet: undefined }],
      schedulesEnabled: 2, botRunning: true, modelSet: true, lastRunStatus: 'success',
    });
    const keys = h.find(x => x.label === 'Provider keys')!;
    expect(keys.ok).toBe(false);                 // 1 of 2 cloud keys missing
    expect(keys.detail).toBe('1/2 cloud keys set');
    expect(h.find(x => x.label === 'Default model')!.ok).toBe(true);
    expect(h.find(x => x.label === 'Scheduler')!.detail).toContain('2 task');
    expect(h.find(x => x.label === 'Bot')!.detail).toBe('running');
    expect(h.find(x => x.label === 'Last scheduled run')!.ok).toBe(true);
  });

  it('is healthy when all providers are local and the model is set', () => {
    const h = computeHealth({ providers: [{ keySet: undefined }], schedulesEnabled: 0, botRunning: false, modelSet: true });
    expect(h.find(x => x.label === 'Provider keys')!.ok).toBe(true);
    expect(h.find(x => x.label === 'Provider keys')!.detail).toBe('all local');
    expect(h.find(x => x.label === 'Default model')!.ok).toBe(true);
  });

  it('warns when the model is unset', () => {
    const h = computeHealth({ providers: [], schedulesEnabled: 0, botRunning: false, modelSet: false });
    expect(h.find(x => x.label === 'Default model')!.ok).toBe(false);
  });
});
