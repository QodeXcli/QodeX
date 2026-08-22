import { describe, it, expect } from 'vitest';
import {
  classifyPromptClass,
  compileTaskBrief,
  extractMentionedPaths,
  formatTaskBrief,
  inferTaskEffort,
} from '../src/agent/task-brief.js';

describe('classifyPromptClass', () => {
  it('keeps backend ahead of frontend for Django', () => {
    expect(classifyPromptClass('design the Django models for billing')).toBe('backend');
  });
  it('classifies debug vs feature', () => {
    expect(classifyPromptClass('fix the crash in login')).toBe('debug');
    expect(classifyPromptClass('add a logout endpoint')).toBe('feature');
  });
});

describe('compileTaskBrief', () => {
  it('extracts paths and constraints', () => {
    const b = compileTaskBrief('In src/utils/log-format.ts add a timestamp. Do not change any other file.');
    expect(b.paths).toContain('src/utils/log-format.ts');
    expect(b.constraints.some(c => /do not change/i.test(c))).toBe(true);
  });
  it('raises effort for architecture / from-scratch', () => {
    expect(inferTaskEffort('rebuild the architecture from scratch', 'feature', [])).toBe('high');
  });
  it('keeps a JSDoc one-file tweak low', () => {
    expect(inferTaskEffort('add a jsdoc comment to foo.ts', 'general', ['foo.ts'])).toBe('low');
  });
  it('formatTaskBrief is empty for greetings', () => {
    expect(formatTaskBrief(compileTaskBrief('سلام'), 'سلام')).toBe('');
  });
  it('formatTaskBrief names files and kind', () => {
    const p = 'fix the crash in src/agent/loop.ts and test/loop.test.ts';
    const text = formatTaskBrief(compileTaskBrief(p), p);
    expect(text).toMatch(/kind: debug/);
    expect(text).toMatch(/src\/agent\/loop\.ts/);
    expect(text).toMatch(/stay on this request/);
  });
});

describe('extractMentionedPaths', () => {
  it('skips http urls', () => {
    expect(extractMentionedPaths('see https://example.com/foo.ts and src/a.ts')).toEqual(['src/a.ts']);
  });
});
