import { describe, it, expect } from 'vitest';
import {
  inferIndent, inferQuotes, inferSemicolons, inferNaming, profileFromSamples, buildStyleBlock,
} from '../src/context/style-profile.js';

const twoSpace = `function a() {\n  const x = 1;\n  if (x) {\n    return x;\n  }\n}\n`;
const fourSpace = `def main():\n    x = 1\n    if x:\n        return x\n`;
const tabbed = `function a() {\n\tconst x = 1\n\tif (x) {\n\t\treturn x\n\t}\n}\n`;

describe('inferIndent', () => {
  it('detects 2-space, 4-space, and tabs', () => {
    expect(inferIndent(twoSpace)).toEqual({ type: 'space', width: 2 });
    expect(inferIndent(fourSpace)).toEqual({ type: 'space', width: 4 });
    expect(inferIndent(tabbed)).toEqual({ type: 'tab', width: 1 });
  });
  it('returns null on a file with no indentation', () => {
    expect(inferIndent('const x = 1\nconst y = 2\n')).toBeNull();
  });
});

describe('inferQuotes', () => {
  it('single vs double vs mixed', () => {
    expect(inferQuotes(`const a='x'; const b='y'; const c='z';`)).toBe('single');
    expect(inferQuotes(`const a="x"; const b="y"; const c="z";`)).toBe('double');
    expect(inferQuotes(`const a='x'; const b="y"; const c='z'; const d="w";`)).toBe('mixed');
  });
  it('null when too few strings to judge', () => {
    expect(inferQuotes(`const a = 1`)).toBeNull();
  });
});

describe('inferSemicolons', () => {
  it('detects presence vs omission', () => {
    expect(inferSemicolons(`const a = 1;\nconst b = 2;\nreturn a;\nlet c = 3;\nfoo();`)).toBe(true);
    expect(inferSemicolons(`const a = 1\nconst b = 2\nreturn a\nlet c = 3\nfoo()`)).toBe(false);
  });
});

describe('inferNaming', () => {
  it('camelCase vs snake_case', () => {
    expect(inferNaming(`const fooBar = 1; function bazQux() {} let myVar = 2;`)).toBe('camelCase');
    expect(inferNaming(`def parse_config(): pass\ndef load_defaults(): pass\ndef build_index(): pass`)).toBe('snake_case');
  });
});

describe('profileFromSamples — majority vote + confidence', () => {
  it('aggregates a coherent profile and scales confidence with sample size', () => {
    const files = Array.from({ length: 15 }, (_, i) => ({ path: `f${i}.ts`, content: twoSpace + `const fooBar${i} = 'v';` }));
    const p = profileFromSamples(files)!;
    expect(p.indent).toEqual({ type: 'space', width: 2 });
    expect(p.quotes).toBe('single');
    expect(p.semicolons).toBe(true);
    expect(p.confidence).toBe(1);
    expect(p.sampleFiles).toBe(15);
  });
  it('null on empty input', () => {
    expect(profileFromSamples([])).toBeNull();
  });
});

describe('buildStyleBlock', () => {
  it('renders a readable block above the confidence floor', () => {
    const block = buildStyleBlock({ indent: { type: 'space', width: 4 }, quotes: 'double', semicolons: false, naming: 'snake_case', confidence: 0.8, sampleFiles: 12 });
    expect(block).toContain('# Code style');
    expect(block).toContain('4-space');
    expect(block).toContain('double quotes');
    expect(block).toContain('no (omit them)');
    expect(block).toContain('snake_case');
  });
  it('empty when confidence is too low or profile is null', () => {
    expect(buildStyleBlock(null)).toBe('');
    expect(buildStyleBlock({ indent: { type: 'space', width: 2 }, quotes: 'single', semicolons: true, naming: 'camelCase', confidence: 0.1, sampleFiles: 1 })).toBe('');
  });
});
