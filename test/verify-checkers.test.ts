import { describe, it, expect } from 'vitest';
import { pickChecker, pickCheckers } from '../src/tools/diagnostics/checkers.js';

const ids = (files: string[]) => pickCheckers(new Set(files)).map(c => c.id);

describe('pickCheckers — one checker per language (polyglot verification)', () => {
  it('monolingual TS project returns exactly tsc — same as the old single pickChecker', () => {
    const files = new Set(['tsconfig.json', 'package.json']);
    expect(ids([...files])).toEqual(['tsc']);
    expect(pickCheckers(files)[0]).toBe(pickChecker(files)); // back-compat: first == old behavior
  });

  it('TS + Python repo runs BOTH tsc and a python checker (the bug: python was skipped)', () => {
    const got = ids(['tsconfig.json', 'pyproject.toml']);
    expect(got).toContain('tsc');
    expect(got.some(id => id === 'ruff' || id === 'pyright')).toBe(true);
    // ruff owns .py first, so pyright (also .py) is NOT added — one checker per language.
    expect(got).toEqual(['tsc', 'ruff']);
  });

  it('TS + eslint adds eslint ONLY for the .js it uniquely owns (tsc still owns .ts)', () => {
    expect(ids(['tsconfig.json', '.eslintrc'])).toEqual(['tsc', 'eslint']);
  });

  it('eslint-only project (no tsconfig) uses eslint', () => {
    expect(ids(['.eslintrc'])).toEqual(['eslint']);
  });

  it('Go project uses govet', () => {
    expect(ids(['go.mod'])).toEqual(['govet']);
  });

  it('returns nothing when no checker config is present', () => {
    expect(ids(['package.json', 'README.md'])).toEqual([]);
  });

  it('does not list two checkers that own the SAME language', () => {
    // pyproject.toml is detected by both ruff and pyright (both own .py) → only the first.
    const got = ids(['pyproject.toml']);
    expect(got).toEqual(['ruff']);
  });
});
