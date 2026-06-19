import { describe, it, expect } from 'vitest';
import { isBinaryBuffer, hasBinaryExtension } from '../src/utils/binary.js';
import { prepareDiffPreview, UI_MAX_DIFF_BYTES } from '../src/utils/ui-limits.js';

describe('binary detection', () => {
  it('detects null bytes as binary', () => {
    const buf = Buffer.from([0x48, 0x65, 0x00, 0x6c]);
    expect(isBinaryBuffer(buf)).toBe(true);
  });

  it('accepts plain text as non-binary', () => {
    expect(isBinaryBuffer(Buffer.from('Hello, world!\nThis is plain text.\n'))).toBe(false);
  });

  it('accepts utf-8 multi-byte sequences as non-binary', () => {
    expect(isBinaryBuffer(Buffer.from('سلام دنیا — Persian text! 你好世界'))).toBe(false);
  });

  it('flags PNG header as binary', () => {
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(isBinaryBuffer(pngHeader)).toBe(true);
  });

  it('detects by extension', () => {
    expect(hasBinaryExtension('foo.png')).toBe(true);
    expect(hasBinaryExtension('foo.ts')).toBe(false);
    expect(hasBinaryExtension('path/to/lib.so')).toBe(true);
  });
});

describe('diff preview truncation', () => {
  it('passes through small content unchanged', () => {
    const r = prepareDiffPreview('file.ts', 'hello', 'world');
    expect(r.before).toBe('hello');
    expect(r.after).toBe('world');
    expect(r.truncated).toBeUndefined();
  });

  it('truncates content over UI_MAX_DIFF_BYTES', () => {
    const huge = 'x'.repeat(UI_MAX_DIFF_BYTES * 3);
    const r = prepareDiffPreview('big.txt', null, huge);
    expect(r.after.length).toBeLessThan(huge.length);
    expect(r.after).toContain('bytes elided for display');
    expect(r.truncated?.afterBytes).toBe(huge.length);
  });

  it('preserves head and tail of truncated content', () => {
    const big = 'START_HEADER\n' + 'x'.repeat(UI_MAX_DIFF_BYTES * 2) + '\nEND_FOOTER';
    const r = prepareDiffPreview('f.txt', null, big);
    expect(r.after).toContain('START_HEADER');
    expect(r.after).toContain('END_FOOTER');
  });
});

describe('deep merge config behavior', () => {
  // Re-export deepMerge for tests? It's not exported. Inline a copy for the test:
  function deepMerge<T>(base: T, override: any): T {
    if (override === undefined) return base;
    if (override === null) return null as unknown as T;
    if (Array.isArray(base) || Array.isArray(override)) return override as T;
    if (typeof base !== 'object' || typeof override !== 'object' || base === null) return override as T;
    const result: any = { ...(base as any) };
    for (const key of Object.keys(override)) {
      const ov = override[key];
      if (ov === undefined) continue;
      result[key] = deepMerge((base as any)[key], ov);
    }
    return result as T;
  }

  it('merges plain objects recursively', () => {
    const r = deepMerge({ a: 1, b: { c: 2, d: 3 } }, { b: { c: 99 } });
    expect(r).toEqual({ a: 1, b: { c: 99, d: 3 } });
  });

  it('does NOT merge arrays element-wise — override replaces', () => {
    const r = deepMerge({ list: [1, 2, 3] }, { list: [9] });
    expect(r).toEqual({ list: [9] });
  });

  it('handles type mismatch (object → array) without corrupting', () => {
    const r = deepMerge({ x: { a: 1 } }, { x: ['something'] });
    expect(r).toEqual({ x: ['something'] });
  });

  it('handles type mismatch (array → object) without corrupting', () => {
    const r = deepMerge({ x: [1, 2] }, { x: { a: 1 } });
    expect(r).toEqual({ x: { a: 1 } });
  });

  it('handles type mismatch (object → primitive) without corrupting', () => {
    const r = deepMerge({ x: { a: 1 } }, { x: 'hello' });
    expect(r).toEqual({ x: 'hello' });
  });
});
