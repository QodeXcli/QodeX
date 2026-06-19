import { describe, it, expect } from 'vitest';
import { AnthropicProvider } from '../src/llm/providers/anthropic.js';
import type { Message } from '../src/session/store.js';

describe('AnthropicProvider message conversion', () => {
  // Access the private method via casting for testing
  const provider = new AnthropicProvider('test-key-fake');
  const convert = (provider as any).convertMessages.bind(provider) as (
    msgs: Message[],
  ) => { system: string; messages: any[] };

  it('extracts system messages', () => {
    const r = convert([
      { role: 'system', content: 'you are X' },
      { role: 'user', content: 'hi' },
    ]);
    expect(r.system).toBe('you are X');
    expect(r.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('CRITICAL: merges multiple consecutive tool_result blocks into a single user message', () => {
    const r = convert([
      { role: 'user', content: 'do X' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } },
          { id: 'call_2', type: 'function', function: { name: 'read_file', arguments: '{"path":"b"}' } },
          { id: 'call_3', type: 'function', function: { name: 'read_file', arguments: '{"path":"c"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'result 1' },
      { role: 'tool', tool_call_id: 'call_2', content: 'result 2' },
      { role: 'tool', tool_call_id: 'call_3', content: 'result 3' },
      { role: 'assistant', content: 'done' },
    ]);

    // Should produce: user / assistant(tool_uses) / user(3 tool_results) / assistant
    expect(r.messages).toHaveLength(4);
    expect(r.messages[0].role).toBe('user');
    expect(r.messages[1].role).toBe('assistant');
    expect(r.messages[2].role).toBe('user');
    expect(Array.isArray(r.messages[2].content)).toBe(true);
    expect(r.messages[2].content).toHaveLength(3);
    expect(r.messages[2].content.every((b: any) => b.type === 'tool_result')).toBe(true);
    expect(r.messages[3].role).toBe('assistant');
  });

  it('preserves strict user/assistant alternation', () => {
    const r = convert([
      { role: 'user', content: 'one' },
      { role: 'user', content: 'two' },  // accidentally two user messages
      { role: 'assistant', content: 'reply' },
    ]);

    // Should merge into one user message
    expect(r.messages).toHaveLength(2);
    expect(r.messages[0].role).toBe('user');
    expect(r.messages[1].role).toBe('assistant');
  });

  it('handles malformed JSON tool arguments without crashing', () => {
    const r = convert([
      { role: 'user', content: 'do it' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_x', type: 'function', function: { name: 't', arguments: 'NOT-JSON{{{' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_x', content: 'whatever' },
    ]);
    // Should not throw. On malformed JSON the provider prepends a [CALL_NOTE]
    // text block so the model can self-correct, then emits the tool_use with
    // input={}. So assert on the tool_use block itself, not a fixed index.
    const toolUse = r.messages[1].content.find((b: any) => b.type === 'tool_use');
    expect(toolUse).toBeDefined();
    expect(toolUse.input).toEqual({});
  });

  it('drops leading non-user messages (Anthropic requires user first)', () => {
    const r = convert([
      { role: 'system', content: 'sys' },
      { role: 'assistant', content: 'orphan' },
      { role: 'user', content: 'hi' },
    ]);
    expect(r.messages[0].role).toBe('user');
    expect(r.system).toBe('sys');
  });
});
