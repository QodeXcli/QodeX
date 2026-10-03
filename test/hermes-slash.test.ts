/**
 * Slash commands for standing goals, the emergency stop and /learn.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { handleSlashCommand } from '../src/cli/slash-commands.js';
import { SLASH_CATALOG } from '../src/cli/slash-catalog.js';
import { getStandingGoal, newGoal, setStandingGoal } from '../src/goals/goal.js';
import { registerStopHandler } from '../src/control/emergency-stop.js';

afterEach(() => { setStandingGoal(null); });

describe('/goal', () => {
  it('sets a standing goal and submits the kickoff prompt', async () => {
    const r = await handleSlashCommand('/goal all tests pass --check "npm test" --max 3', 'sess-1234', process.cwd());
    expect(r.handled).toBe(true);
    const g = getStandingGoal();
    expect(g?.objective).toBe('all tests pass');
    expect(g?.check).toBe('npm test');
    expect(g?.maxRounds).toBe(3);
    expect(r.action?.type).toBe('submit_prompt');
    expect((r.action as { prompt: string }).prompt).toMatch(/^all tests pass\n/);
    expect(r.message).toMatch(/`npm test` passes/);
  });

  it('bare /goal shows the goal; /goal clear ends it', async () => {
    await handleSlashCommand('/goal ship the docs', 'sess-1234', process.cwd());
    const status = await handleSlashCommand('/goal', 'sess-1234', process.cwd());
    expect(status.action).toBeUndefined();
    expect(status.message).toMatch(/ship the docs/);
    const cleared = await handleSlashCommand('/goal clear', 'sess-1234', process.cwd());
    expect(cleared.message).toMatch(/Goal cleared: ship the docs/);
    expect(getStandingGoal()).toBeNull();
  });
});

describe('/stop', () => {
  it('runs the stop handlers and clears the standing goal', async () => {
    let stopped = false;
    const off = registerStopHandler('test run', () => { stopped = true; return 'the test run'; });
    try {
      setStandingGoal(newGoal('x', undefined, 2));
      const r = await handleSlashCommand('/stop', 'sess-1234', process.cwd());
      expect(r.handled).toBe(true);
      expect(stopped).toBe(true);
      expect(getStandingGoal()).toBeNull();
      expect(r.message).toMatch(/test run/);
    } finally { off(); }
  });
});

describe('catalog', () => {
  it('lists /goal, /stop and /learn', () => {
    const names = SLASH_CATALOG.map(c => c.name);
    for (const n of ['goal', 'stop', 'learn']) expect(names).toContain(n);
  });
});
