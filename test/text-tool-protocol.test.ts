import { describe, it, expect } from 'vitest';
import {
  needsTextToolMode, buildTextToolInstructions, withTextToolProtocol,
} from '../src/llm/text-tool-protocol.js';
import { recoverToolCallsFromText } from '../src/llm/text-tool-recovery.js';
import type { ToolSchema } from '../src/llm/types.js';
import type { Message } from '../src/session/store.js';

const writeFile: ToolSchema = {
  type: 'function',
  function: {
    name: 'write_file',
    description: 'Create or overwrite a file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Where to write' },
        content: { type: 'string', description: 'File body' },
      },
      required: ['path', 'content'],
    },
  },
};
const ls: ToolSchema = {
  type: 'function',
  function: {
    name: 'ls',
    description: 'List a directory.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Dir' } }, required: [] },
  },
};

describe('needsTextToolMode', () => {
  it('is true only when the model has no native tool channel', () => {
    expect(needsTextToolMode(false)).toBe(true);
    expect(needsTextToolMode(true)).toBe(false);
    // Defensive: undefined-as-any should NOT force text mode (default native).
    expect(needsTextToolMode(undefined as any)).toBe(false);
  });
});

describe('buildTextToolInstructions', () => {
  it('returns empty string for no tools', () => {
    expect(buildTextToolInstructions([])).toBe('');
  });
  it('teaches the <tool_call> format and lists tools with params', () => {
    const block = buildTextToolInstructions([writeFile, ls]);
    expect(block).toContain('HOW TO ACT');
    expect(block).toContain('<tool_call>{"name"');
    expect(block).toContain('write_file');
    expect(block).toContain('ls');
    expect(block).toContain('path (string, required)');
    expect(block).toContain('content (string, required)');
    // ls.path is not required
    expect(block).toContain('path (string, optional)');
  });
  it('notes enum options when present', () => {
    const withEnum: ToolSchema = {
      type: 'function',
      function: {
        name: 'diagnostics',
        description: 'Run a checker.',
        parameters: { type: 'object', properties: { checker: { type: 'string', enum: ['auto', 'tsc'], description: 'which' } }, required: [] },
      },
    };
    expect(buildTextToolInstructions([withEnum])).toContain('one of: auto, tsc');
  });
  it('handles a tool with no params', () => {
    const noArgs: ToolSchema = { type: 'function', function: { name: 'git_status', description: 'status', parameters: { type: 'object', properties: {} } } };
    expect(buildTextToolInstructions([noArgs])).toContain('args: (none)');
  });
});

describe('withTextToolProtocol', () => {
  const sys: Message = { role: 'system', content: 'You are QodeX.' };
  const user: Message = { role: 'user', content: 'make a file' };

  it('inserts the protocol block right after the leading system message(s)', () => {
    const out = withTextToolProtocol([sys, user], 'PROTOCOL');
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(sys);
    expect(out[1]!.role).toBe('system');
    expect(out[1]!.content).toBe('PROTOCOL');
    expect(out[2]).toBe(user);
  });
  it('handles multiple leading system messages', () => {
    const sys2: Message = { role: 'system', content: 'extra' };
    const out = withTextToolProtocol([sys, sys2, user], 'P');
    expect(out[2]!.content).toBe('P');
    expect(out[2]!.role).toBe('system');
    expect(out[3]).toBe(user);
  });
  it('is a no-op for an empty block', () => {
    const msgs = [sys, user];
    expect(withTextToolProtocol(msgs, '')).toBe(msgs);
  });
});

describe('end-to-end: instructed format round-trips through recovery', () => {
  it('a model following the protocol produces a recoverable call', () => {
    // The exact shape the protocol block tells the model to emit:
    const modelOutput = 'Sure.\n<tool_call>{"name": "write_file", "arguments": {"path": "hello.txt", "content": "Hi\\n"}}</tool_call>';
    const { calls } = recoverToolCallsFromText(modelOutput, new Set(['write_file', 'ls']));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.function.name).toBe('write_file');
    expect(JSON.parse(calls[0]!.function.arguments)).toEqual({ path: 'hello.txt', content: 'Hi\n' });
  });
  it('also recovers GLM-style <|FunctionCallBegin|> output', () => {
    const glm = '<|FunctionCallBegin|>{"name": "ls", "arguments": {"path": "."}}<|FunctionCallEnd|>';
    const { calls } = recoverToolCallsFromText(glm, new Set(['ls']));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.function.name).toBe('ls');
  });
});
