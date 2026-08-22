import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  classifyPromptClass,
  compileTaskBrief,
  extractConstraints,
  extractMentionedPaths,
  formatTaskBrief,
  inferTaskEffort,
  readNamedFileSnippets,
} from '../src/agent/task-brief.js';

describe('classifyPromptClass', () => {
  it('keeps backend ahead of frontend for Django', () => {
    expect(classifyPromptClass('design the Django models for billing')).toBe('backend');
  });
  it('classifies debug vs feature', () => {
    expect(classifyPromptClass('fix the crash in login')).toBe('debug');
    expect(classifyPromptClass('add a logout endpoint')).toBe('feature');
  });
  it('does not treat ui.tsx in a path as a frontend task', () => {
    expect(classifyPromptClass('fix the crash in src/cli/ui.tsx')).toBe('debug');
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
    expect(text).toMatch(/do not ls\/glob/);
  });
});

describe('readNamedFileSnippets', () => {
  it('injects existing files and refuses path escape', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qodex-named-'));
    fs.writeFileSync(path.join(dir, 'hello.ts'), 'export const n = 1;\n');
    const block = await readNamedFileSnippets(dir, ['hello.ts', '../secret.ts']);
    expect(block).toMatch(/hello\.ts/);
    expect(block).toMatch(/export const n = 1/);
    expect(block).not.toMatch(/secret/);
  });
});

describe('extractMentionedPaths', () => {
  it('skips http urls', () => {
    expect(extractMentionedPaths('see https://example.com/foo.ts and src/a.ts')).toEqual(['src/a.ts']);
  });
  it('does not treat versions or abbreviations as files', () => {
    expect(extractMentionedPaths('shipped in v2.7.0; edit src/index.ts')).toEqual(['src/index.ts']);
    expect(extractMentionedPaths('e.g. foo.ts')).toEqual(['foo.ts']);
    expect(extractMentionedPaths('Node 20.11.0')).toEqual([]);
    expect(extractMentionedPaths('see www.example.com and bar.py')).toEqual(['bar.py']);
  });
  it('still names real source files', () => {
    expect(extractMentionedPaths('touch package.json and src/cli/ui.tsx')).toEqual([
      'src/cli/ui.tsx',
      'package.json',
    ]);
  });
});

describe('extractConstraints', () => {
  it('keeps explicit do-not / without-changing', () => {
    const c = extractConstraints('In src/a.ts add a timestamp. Do not change any other file.');
    expect(c.some(s => /do not change/i.test(s))).toBe(true);
    expect(extractConstraints('fix the typo without changing tests').some(s => /without changing/i.test(s))).toBe(true);
  });
  it('does not treat prose only/without as constraints', () => {
    expect(extractConstraints('The only output is ISO 8601.')).toEqual([]);
    expect(extractConstraints('without tests this will break')).toEqual([]);
  });
});
