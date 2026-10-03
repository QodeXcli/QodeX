import { describe, it, expect } from 'vitest';
import {
  normalizeFailureSignature, taskKey, detectFailurePatterns, buildLesson, buildLessonsBlock,
  type FailureEvent,
} from '../src/skills/learning/failures.js';

describe('normalizeFailureSignature — same KIND clusters despite specifics', () => {
  it('strips paths, line:col, quoted ids, and numbers', () => {
    const a = normalizeFailureSignature('edit_symbol', "Cannot find symbol 'fooBar' at src/a/x.ts:10:5");
    const b = normalizeFailureSignature('edit_symbol', "Cannot find symbol 'bazQux' at lib/y.ts:99:1");
    expect(a).toBe(b);                       // same signature → clusters
    expect(a).toContain('edit_symbol|');
    expect(a).toContain('<id>');
    expect(a).not.toMatch(/\d/);             // numbers gone
  });
  it('different tools or different error kinds do NOT collide', () => {
    expect(normalizeFailureSignature('edit_symbol', 'not found'))
      .not.toBe(normalizeFailureSignature('shell', 'not found'));
    expect(normalizeFailureSignature('shell', 'permission denied'))
      .not.toBe(normalizeFailureSignature('shell', 'command not found'));
  });
  it('taskKey is stable + case-insensitive', () => {
    expect(taskKey('Fix the bug')).toBe(taskKey('  fix the bug  '));
    expect(taskKey('a')).not.toBe(taskKey('b'));
  });
});

describe('detectFailurePatterns — learns ONLY from repetition across tasks', () => {
  const ev = (task: string, tool: string, err: string): FailureEvent =>
    ({ ts: '', task, tool, signature: normalizeFailureSignature(tool, err), sample: err });

  it('a one-off failure is NOT a pattern', () => {
    const events = [ev('t1', 'edit_symbol', "Cannot find 'a'")];
    expect(detectFailurePatterns(events, { minOccurrences: 3, minDistinctTasks: 2 })).toHaveLength(0);
  });
  it('repeated across distinct tasks → a learned pattern', () => {
    const events = [
      ev('t1', 'edit_symbol', "Cannot find symbol 'a' at x.ts:1:1"),
      ev('t1', 'edit_symbol', "Cannot find symbol 'b' at x.ts:2:1"),
      ev('t2', 'edit_symbol', "Cannot find symbol 'c' at y.ts:3:1"),
    ];
    const p = detectFailurePatterns(events, { minOccurrences: 3, minDistinctTasks: 2 });
    expect(p).toHaveLength(1);
    expect(p[0]!.count).toBe(3);
    expect(p[0]!.distinctTasks).toBe(2);
    expect(p[0]!.tool).toBe('edit_symbol');
  });
  it('many occurrences in ONE task is NOT enough (needs distinct tasks)', () => {
    const events = [
      ev('t1', 'shell', 'permission denied'),
      ev('t1', 'shell', 'permission denied'),
      ev('t1', 'shell', 'permission denied'),
    ];
    expect(detectFailurePatterns(events, { minOccurrences: 3, minDistinctTasks: 2 })).toHaveLength(0);
  });
});

describe('buildLesson / buildLessonsBlock — deterministic, targeted, bounded', () => {
  const mk = (tool: string, sig: string, count = 4, tasks = 3) =>
    ({ signature: `${tool}|${sig}`, tool, count, distinctTasks: tasks, sample: sig });

  it('symbol-not-found → "confirm the symbol exists"', () => {
    expect(buildLesson(mk('edit_symbol', 'cannot find symbol'))).toMatch(/confirm the symbol exists/i);
  });
  it('permission → "check permissions"', () => {
    expect(buildLesson(mk('shell', 'permission denied'))).toMatch(/permission/i);
  });
  it('unknown kind → generic preconditions caution with the count', () => {
    const l = buildLesson(mk('weird_tool', 'kaboom happened'));
    expect(l).toMatch(/preconditions/i);
    expect(l).toContain('weird_tool');
  });
  it('block is bounded to topK and empty when no patterns', () => {
    expect(buildLessonsBlock([])).toBe('');
    const many = Array.from({ length: 10 }, (_, i) => mk(`t${i}`, `err ${i}`));
    const block = buildLessonsBlock(many, 3);
    expect(block).toContain('# Learned cautions');
    expect((block.match(/^- /gm) ?? []).length).toBe(3); // capped
  });
});
