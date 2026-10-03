import { describe, it, expect } from 'vitest';
import {
  parseMissionPlan, planMission, fallbackPlan, buildPlannerPrompt, hasCycle, extractJson, MAX_PLAN_STEPS,
} from '../src/missions/planner.js';

const PLAN = {
  steps: [
    { id: 's1', title: 'Research', instruction: 'Find three vendors', depends_on: [] },
    { id: 's2', title: 'Compare', instruction: 'Compare prices', depends_on: ['s1'] },
  ],
  success_criteria: 'A comparison table exists',
};

describe('mission planner parsing', () => {
  it('parses plain JSON', () => {
    const p = parseMissionPlan(JSON.stringify(PLAN));
    expect(p.fallback).toBe(false);
    expect(p.steps.map(s => s.id)).toEqual(['s1', 's2']);
    expect(p.steps[1]!.depends_on).toEqual(['s1']);
    expect(p.success_criteria).toBe('A comparison table exists');
  });

  it('parses fenced JSON with thinking and prose around it', () => {
    const text = '<think>let me plan</think>Sure! Here is the plan:\n```json\n' + JSON.stringify(PLAN, null, 2) + '\n```\nGood luck.';
    const p = parseMissionPlan(text);
    expect(p.steps).toHaveLength(2);
    expect(p.steps[0]!.title).toBe('Research');
  });

  it('parses prose-wrapped JSON without fences, trailing commas and alias keys', () => {
    const text = 'Plan follows. {"tasks":[{"name":"A","description":"do a","dependsOn":[]},{"name":"B","prompt":"do b","deps":[1],},],"criteria":"done",} thanks';
    const p = parseMissionPlan(text);
    expect(p.steps.map(s => s.title)).toEqual(['A', 'B']);
    expect(p.steps[0]!.id).toBe('s1');
    expect(p.steps[1]!.depends_on).toEqual(['s1']);
    expect(p.steps[1]!.instruction).toBe('do b');
    expect(p.success_criteria).toBe('done');
  });

  it('accepts a bare array of steps and string steps', () => {
    const p = parseMissionPlan('["open the site", "fill the form"]');
    expect(p.steps.map(s => s.instruction)).toEqual(['open the site', 'fill the form']);
    expect(p.success_criteria.length).toBeGreaterThan(10);
  });

  it('accepts a nested {plan:{steps}} object', () => {
    const p = parseMissionPlan(JSON.stringify({ plan: { steps: PLAN.steps, success_criteria: 'nested ok' } }));
    expect(p.steps).toHaveLength(2);
    expect(p.success_criteria).toBe('nested ok');
  });

  it('fixes duplicate/missing ids and drops unknown or self deps', () => {
    const p = parseMissionPlan(JSON.stringify({
      steps: [
        { id: 'a', title: 'one', instruction: 'x', depends_on: ['ghost', 'a'] },
        { id: 'a', title: 'two', instruction: 'y', depends_on: ['a'] },
        { title: 'three', instruction: 'z', depends_on: [2] },
      ],
    }));
    expect(p.steps.map(s => s.id)).toEqual(['a', 's2', 's3']);
    expect(p.steps[0]!.depends_on).toEqual([]);
    expect(p.steps[1]!.depends_on).toEqual(['a']);
    expect(p.steps[2]!.depends_on).toEqual(['s2']);
  });

  it('rejects cycles', () => {
    const cyclic = JSON.stringify({
      steps: [
        { id: 's1', title: 'a', instruction: 'a', depends_on: ['s2'] },
        { id: 's2', title: 'b', instruction: 'b', depends_on: ['s1'] },
      ],
    });
    expect(() => parseMissionPlan(cyclic)).toThrow(/PLAN_CYCLE/);
    expect(hasCycle([{ id: 'x', depends_on: ['y'] }, { id: 'y', depends_on: [] }])).toBe(false);
  });

  it('rejects garbage', () => {
    expect(() => parseMissionPlan('I cannot help with that.')).toThrow(/PLAN_PARSE/);
    expect(() => parseMissionPlan('{"steps": []}')).toThrow(/PLAN_INVALID/);
    expect(() => extractJson('')).toThrow(/PLAN_PARSE/);
  });

  it(`caps the plan at ${MAX_PLAN_STEPS} steps and folds the rest into the last step`, () => {
    const steps = Array.from({ length: 15 }, (_, i) => ({ id: `s${i + 1}`, title: `T${i + 1}`, instruction: `do ${i + 1}`, depends_on: i ? [`s${i}`] : [] }));
    const p = parseMissionPlan(JSON.stringify({ steps }));
    expect(p.steps).toHaveLength(MAX_PLAN_STEPS);
    expect(p.steps[MAX_PLAN_STEPS - 1]!.instruction).toContain('T13');
    expect(p.steps[MAX_PLAN_STEPS - 1]!.instruction).toContain('T15');
    const ids = new Set(p.steps.map(s => s.id));
    for (const s of p.steps) for (const d of s.depends_on) expect(ids.has(d)).toBe(true);
    // a smaller explicit cap
    expect(parseMissionPlan(JSON.stringify({ steps }), { maxSteps: 3 }).steps).toHaveLength(3);
  });
});

describe('planMission', () => {
  it('uses the model reply when it parses', async () => {
    let seen = '';
    const p = await planMission('Compare vendors', { complete: async (prompt) => { seen = prompt; return JSON.stringify(PLAN); } });
    expect(p.fallback).toBe(false);
    expect(p.steps).toHaveLength(2);
    expect(seen).toContain('Compare vendors');
    expect(seen).toContain('depends_on');
  });

  it('falls back to a single step on cyclic plans', async () => {
    const p = await planMission('Do the thing', {
      complete: async () => JSON.stringify({ steps: [
        { id: 'a', title: 'a', instruction: 'a', depends_on: ['b'] },
        { id: 'b', title: 'b', instruction: 'b', depends_on: ['a'] },
      ] }),
    });
    expect(p.fallback).toBe(true);
    expect(p.fallbackReason).toMatch(/PLAN_CYCLE/);
    expect(p.steps).toEqual([{ id: 's1', title: 'Do the thing', instruction: 'Do the thing', depends_on: [] }]);
  });

  it('falls back when the model errors or returns prose', async () => {
    const e = await planMission('goal A', { complete: async () => { throw new Error('model offline'); } });
    expect(e.fallback).toBe(true);
    expect(e.fallbackReason).toMatch(/model offline/);
    const prose = await planMission('goal B', { complete: async () => 'You should first think about it.' });
    expect(prose.fallback).toBe(true);
    expect(prose.steps[0]!.instruction).toBe('goal B');
  });

  it('rethrows when aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(planMission('g', { signal: ac.signal, complete: async () => { throw new Error('aborted'); } })).rejects.toThrow('aborted');
  });

  it('fallback titles are truncated, prompt mentions limits and language', () => {
    const long = 'x'.repeat(200);
    expect(fallbackPlan(long).steps[0]!.title.length).toBeLessThanOrEqual(80);
    const prompt = buildPlannerPrompt('هدف فارسی', { maxSteps: 5 });
    expect(prompt).toContain('1 to 5 steps');
    expect(prompt).toContain('same language as the goal');
    expect(prompt).toContain('هدف فارسی');
  });
});
