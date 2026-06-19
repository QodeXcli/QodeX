import { describe, it, expect } from 'vitest';
import {
  coerceArgsToSchema,
  tryParseJson,
  genericJsonGbnf,
  toolChoiceJsonSchema,
  type JsonSchemaNode,
} from '../src/llm/constrained.js';

describe('tryParseJson', () => {
  it('parses clean JSON', () => {
    expect(tryParseJson('{"a":1}')).toEqual({ a: 1 });
  });
  it('salvages raw newlines inside string literals', () => {
    const broken = '{"code":"line1\nline2"}';
    expect(tryParseJson(broken)).toEqual({ code: 'line1\nline2' });
  });
  it('returns undefined for hopeless input', () => {
    expect(tryParseJson('not json at all {')).toBeUndefined();
    expect(tryParseJson('')).toBeUndefined();
  });
});

describe('coerceArgsToSchema — leaves valid args untouched', () => {
  const schema: JsonSchemaNode = {
    type: 'object',
    properties: {
      path: { type: 'string' },
      count: { type: 'number' },
      recursive: { type: 'boolean' },
      globs: { type: 'array', items: { type: 'string' } },
    },
  };
  it('no-ops on already-valid args', () => {
    const args = { path: 'src/x.ts', count: 3, recursive: true, globs: ['*.ts', '*.tsx'] };
    expect(coerceArgsToSchema(args, schema)).toEqual(args);
  });
});

describe('coerceArgsToSchema — repairs unambiguous mistakes', () => {
  const schema: JsonSchemaNode = {
    type: 'object',
    properties: {
      count: { type: 'number' },
      limit: { type: 'integer' },
      recursive: { type: 'boolean' },
      name: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
    },
  };

  it('numeric string -> number', () => {
    expect(coerceArgsToSchema({ count: '5' }, schema)).toEqual({ count: 5 });
  });
  it('integer string -> truncated integer', () => {
    expect(coerceArgsToSchema({ limit: '10' }, schema)).toEqual({ limit: 10 });
  });
  it('"true"/"false" -> boolean', () => {
    expect(coerceArgsToSchema({ recursive: 'true' }, schema)).toEqual({ recursive: true });
    expect(coerceArgsToSchema({ recursive: 'false' }, schema)).toEqual({ recursive: false });
  });
  it('number/boolean -> string when schema wants a string', () => {
    expect(coerceArgsToSchema({ name: 42 }, schema)).toEqual({ name: '42' });
    expect(coerceArgsToSchema({ name: true }, schema)).toEqual({ name: 'true' });
  });
  it('JSON-string array -> real array', () => {
    expect(coerceArgsToSchema({ tags: '["a","b"]' }, schema)).toEqual({ tags: ['a', 'b'] });
  });
  it('lone scalar -> single-element array', () => {
    expect(coerceArgsToSchema({ tags: 'only' }, schema)).toEqual({ tags: ['only'] });
  });
  it('whole-args JSON string -> parsed object then coerced', () => {
    expect(coerceArgsToSchema('{"count":"7"}', schema)).toEqual({ count: 7 });
  });
});

describe('coerceArgsToSchema — safety', () => {
  it('does not invent missing fields', () => {
    const schema: JsonSchemaNode = { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } } };
    expect(coerceArgsToSchema({ a: 'x' }, schema)).toEqual({ a: 'x' });
  });
  it('leaves non-coercible mismatches for zod to reject', () => {
    const schema: JsonSchemaNode = { type: 'object', properties: { count: { type: 'number' } } };
    // "abc" is not numeric — pass through unchanged so the real validator complains.
    expect(coerceArgsToSchema({ count: 'abc' }, schema)).toEqual({ count: 'abc' });
  });
  it('handles array<string|null> type unions', () => {
    const schema: JsonSchemaNode = { type: ['string', 'null'] };
    expect(coerceArgsToSchema(5, schema)).toBe('5');
  });
  it('recurses into nested objects and array items', () => {
    const schema: JsonSchemaNode = {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          items: { type: 'object', properties: { line: { type: 'number' } } },
        },
      },
    };
    expect(coerceArgsToSchema({ edits: [{ line: '3' }, { line: '4' }] }, schema)).toEqual({
      edits: [{ line: 3 }, { line: 4 }],
    });
  });
  it('returns raw when schema is undefined', () => {
    expect(coerceArgsToSchema({ x: '1' }, undefined)).toEqual({ x: '1' });
  });
});

describe('server constraints', () => {
  it('genericJsonGbnf is a non-empty GBNF with a root rule', () => {
    const g = genericJsonGbnf();
    expect(g).toContain('root');
    expect(g).toContain('object');
    expect(g.length).toBeGreaterThan(50);
  });
  it('toolChoiceJsonSchema enumerates the given tool names', () => {
    const s = toolChoiceJsonSchema(['read_file', 'write_file']);
    expect(s.properties?.name.enum).toEqual(['read_file', 'write_file']);
    expect(s.required).toEqual(['name', 'arguments']);
  });
});
