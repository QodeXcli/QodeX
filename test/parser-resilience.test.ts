import { describe, it, expect } from 'vitest';
import { getParser, detectLanguage } from '../src/tools/ast/parser.js';

/**
 * Regression guard for the crash where reading a .jsx file made web-tree-sitter's
 * Emscripten loader float an ENOENT (missing grammar wasm) outside any awaited
 * promise, taking down the whole CLI. getParser must degrade to null gracefully
 * — never throw, never reject — when a grammar isn't present.
 */
describe('tree-sitter parser resilience', () => {
  it('maps extensions to languages', () => {
    expect(detectLanguage('/x/Foo.jsx')).toBe('javascript');
    expect(detectLanguage('/x/Foo.ts')).toBe('typescript');
    expect(detectLanguage('/x/Foo.unknownext')).toBeNull();
  });

  it('getParser never rejects for a normal language (null when no grammar installed)', async () => {
    // The bug: a missing grammar crashed the process. This must resolve, not reject.
    const r = await getParser('javascript');
    expect(r === null || (r !== null && typeof r === 'object')).toBe(true);
  });

  it('getParser resolves to null for a language with no grammar, without throwing', async () => {
    const r = await getParser('definitely-not-a-real-language');
    expect(r).toBeNull();
  });
});
