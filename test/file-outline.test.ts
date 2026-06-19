import { describe, it, expect } from 'vitest';
import { fileOutline, renderLargeFileMap } from '../src/context/file-outline.js';

const SAMPLE = `import { useState } from 'react';
import { Link } from 'react-router-dom';

function Counter() {
  return null;
}

function Section() {
  return null;
}

export default function HomePage() {
  return null;
}
`;

describe('fileOutline', () => {
  it('extracts top-level declarations with line ranges', async () => {
    const out = await fileOutline('HomePage.jsx', SAMPLE);
    const symbols = out.map(o => o.symbol);
    expect(symbols).toContain('Counter');
    expect(symbols).toContain('Section');
    expect(symbols).toContain('HomePage');
  });

  it('returns entries sorted by start line', async () => {
    const out = await fileOutline('HomePage.jsx', SAMPLE);
    for (let i = 1; i < out.length; i++) {
      expect(out[i].startLine).toBeGreaterThanOrEqual(out[i - 1].startLine);
    }
  });

  it('degrades to an array for unparseable / unknown content', async () => {
    const out = await fileOutline('data.bin', '\x00\x01 not code at all \xff');
    expect(Array.isArray(out)).toBe(true);
  });

  it('catches arrow-function components and classes', async () => {
    const src = [
      'export const Button = ({ label }) => {',
      '  return null;',
      '};',
      '',
      'class Widget {',
      '  render() {}',
      '}',
    ].join('\n');
    const out = await fileOutline('Button.jsx', src);
    const symbols = out.map(o => o.symbol);
    expect(symbols).toContain('Button');
    expect(symbols).toContain('Widget');
  });

  it('outline entries can resolve a symbol to a line range (used by read symbol=)', async () => {
    const out = await fileOutline('HomePage.jsx', SAMPLE);
    const hp = out.find(e => e.symbol === 'HomePage');
    expect(hp).toBeDefined();
    expect(hp!.startLine).toBeGreaterThan(0);
    expect(hp!.endLine).toBeGreaterThanOrEqual(hp!.startLine);
  });
});

describe('renderLargeFileMap', () => {
  it('includes a head and flags the file as large, with a read hint', async () => {
    const big = Array.from({ length: 500 }, (_, i) => `// line ${i}`).join('\n');
    const withSym = `export function bigThing() {\n${big}\n}\n`;
    const map = await renderLargeFileMap('Big.ts', withSym, { headLines: 10 });
    expect(map).toContain('LARGE FILE');
    expect(map).toContain('HEAD (lines 1-10)');
    expect(map).toContain('offset');
  });

  it('does not dump the whole file (head is bounded)', async () => {
    const lines = Array.from({ length: 600 }, (_, i) => `const x${i} = ${i};`).join('\n');
    const map = await renderLargeFileMap('Big.ts', lines, { headLines: 20 });
    expect(map).not.toContain('const x500 = 500;');
  });
});
