import { describe, it, expect } from 'vitest';
import { withCacheBreakpoints } from '../src/llm/providers/anthropic.ts';

const EPH = { type: 'ephemeral' };

describe('withCacheBreakpoints — hierarchical prompt cache', () => {
  const tools = [{ name: 'a', input_schema: {} }, { name: 'b', input_schema: {} }, { name: 'c', input_schema: {} }];
  const messages = [
    { role: 'user', content: 'first task' },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 't1', name: 'a', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'big shell output' }] },
  ];

  it('marks the static tier: system + the LAST tool only', () => {
    const { system, tools: out } = withCacheBreakpoints('SYSTEM CORE', messages, tools);
    expect(system).toEqual([{ type: 'text', text: 'SYSTEM CORE', cache_control: EPH }]);
    expect(out!.map((t: any) => !!t.cache_control)).toEqual([false, false, true]); // only last tool
  });

  it('adds the ROLLING breakpoint on the last message — the prefix QodeX was NOT caching', () => {
    const { messages: out } = withCacheBreakpoints('s', messages, tools);
    // earlier messages untouched
    expect(out[0].content).toBe('first task');
    expect(out[1].content[1].cache_control).toBeUndefined();
    // last message's last block is marked → its whole prefix becomes cacheable next turn
    const lastBlocks = out[out.length - 1].content;
    expect(lastBlocks[lastBlocks.length - 1].cache_control).toEqual(EPH);
  });

  it('wraps a string-content last message into a marked text block', () => {
    const { messages: out } = withCacheBreakpoints('s', [{ role: 'user', content: 'just text' }], tools);
    expect(out[0].content).toEqual([{ type: 'text', text: 'just text', cache_control: EPH }]);
  });

  it('uses at most 3 of the 4 allowed breakpoints (system + last tool + last message)', () => {
    const { system, messages: out, tools: t } = withCacheBreakpoints('s', messages, tools);
    const count =
      (Array.isArray(system) ? system.filter((b: any) => b.cache_control).length : 0) +
      t!.filter((x: any) => x.cache_control).length +
      out.flatMap((m: any) => (Array.isArray(m.content) ? m.content : [])).filter((b: any) => b.cache_control).length;
    expect(count).toBe(3);
    expect(count).toBeLessThanOrEqual(4);
  });

  it('does not mutate the inputs (pure)', () => {
    const msgsCopy = JSON.parse(JSON.stringify(messages));
    withCacheBreakpoints('s', messages, tools);
    expect(messages).toEqual(msgsCopy);           // originals untouched
    expect(tools.some((t: any) => t.cache_control)).toBe(false);
  });

  it('handles empty messages / no tools without throwing', () => {
    const r = withCacheBreakpoints('s', [], undefined);
    expect(r.messages).toEqual([]);
    expect(r.tools).toBeUndefined();
    expect(r.system).toEqual([{ type: 'text', text: 's', cache_control: EPH }]);
  });
});
