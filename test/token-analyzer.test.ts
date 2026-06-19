import { describe, it, expect } from 'vitest';
import {
  estimateTokens,
  estimateTokensJson,
  groupIntoTurns,
  analyzeMessages,
  formatReport,
} from '../src/diagnostics/token-analyzer.js';
import type { Message } from '../src/session/store.js';

describe('estimateTokens / estimateTokensJson', () => {
  it('uses 4-chars-per-token approximation, ceil', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);    // 4 chars = 1 token
    expect(estimateTokens('abcde')).toBe(2);   // 5 chars → ceil(5/4) = 2
    expect(estimateTokens('a'.repeat(40))).toBe(10);
  });

  it('handles null/undefined safely', () => {
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
  });

  it('estimateTokensJson serializes then counts', () => {
    expect(estimateTokensJson({ a: 1 })).toBe(estimateTokens('{"a":1}'));
    expect(estimateTokensJson(null)).toBe(0);
    expect(estimateTokensJson(undefined)).toBe(0);
  });
});

describe('groupIntoTurns', () => {
  it('groups messages into turns starting at each user message', () => {
    const msgs: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'task 1' },
      { role: 'assistant', content: 'doing it' },
      { role: 'tool', tool_call_id: 'c1', content: 'result' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'task 2' },
      { role: 'assistant', content: 'done again' },
    ];
    const turns = groupIntoTurns(msgs);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toHaveLength(5);   // system + user + 2 assistant + 1 tool
    expect(turns[1]).toHaveLength(2);   // user + assistant
  });

  it('handles a session that starts without a system message', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hi back' },
    ];
    expect(groupIntoTurns(msgs)).toHaveLength(1);
  });
});

describe('analyzeMessages', () => {
  it('returns zero recommendations for a fresh empty session', () => {
    const r = analyzeMessages('test', [], { systemTokens: 0, toolSchemaTokens: 0 });
    expect(r.turnCount).toBe(0);
    expect(r.totals.grandTotal).toBe(0);
    expect(r.recommendations.length).toBeGreaterThan(0);
  });

  it('breaks down a single-turn session into the four message categories', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'a'.repeat(40) },         // 10 tokens
      { role: 'assistant', content: 'b'.repeat(80) },    // 20 tokens
      { role: 'tool', tool_call_id: 'x', content: 'c'.repeat(200), name: 'read_file' }, // 50 tokens
    ];
    const r = analyzeMessages('test', msgs, { systemTokens: 100, toolSchemaTokens: 1000 });
    expect(r.turnCount).toBe(1);
    expect(r.turns[0]!.user).toBe(10);
    expect(r.turns[0]!.assistant).toBe(20);
    expect(r.turns[0]!.toolResults).toBe(50);
    expect(r.turns[0]!.system).toBe(100);
    expect(r.turns[0]!.toolSchemas).toBe(1000);
    expect(r.turns[0]!.total).toBe(100 + 1000 + 10 + 20 + 50);
  });

  it('includes tool_calls JSON in assistant token count', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'do it' },
      {
        role: 'assistant',
        content: 'calling tool',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"x.ts"}' } }],
      },
    ];
    const r = analyzeMessages('s', msgs, { systemTokens: 0, toolSchemaTokens: 0 });
    // assistant tokens = content + tool_calls JSON
    const expectedContent = estimateTokens('calling tool');
    const expectedToolCalls = estimateTokensJson(msgs[1]!.tool_calls);
    expect(r.turns[0]!.assistant).toBe(expectedContent + expectedToolCalls);
  });

  it('extracts per-tool hotspots from assistant.tool_calls + tool.results', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
          { id: 'c2', type: 'function', function: { name: 'read_file', arguments: '{"path":"b.ts"}' } },
          { id: 'c3', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'x'.repeat(400), name: 'read_file' },
      { role: 'tool', tool_call_id: 'c2', content: 'y'.repeat(800), name: 'read_file' },
      { role: 'tool', tool_call_id: 'c3', content: 'z'.repeat(40), name: 'bash' },
    ];
    const r = analyzeMessages('s', msgs, { systemTokens: 0, toolSchemaTokens: 0 });
    const readFile = r.toolHotspots.find(h => h.tool === 'read_file')!;
    expect(readFile.calls).toBe(2);
    expect(readFile.outputTokens).toBe(estimateTokens('x'.repeat(400)) + estimateTokens('y'.repeat(800)));
    const bash = r.toolHotspots.find(h => h.tool === 'bash')!;
    expect(bash.calls).toBe(1);
    // Hot-spots should be sorted by outputTokens desc
    expect(r.toolHotspots[0]!.tool).toBe('read_file');
  });

  it('extracts per-file hotspots from common arg names', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/app.ts"}' } },
          { id: 'c2', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/app.ts"}' } },
          { id: 'c3', type: 'function', function: { name: 'edit_file', arguments: '{"file_path":"src/lib.ts"}' } },
        ],
      },
    ];
    const r = analyzeMessages('s', msgs, { systemTokens: 0, toolSchemaTokens: 0 });
    const appTs = r.fileHotspots.find(f => f.path === 'src/app.ts')!;
    expect(appTs.reads).toBe(2);
    const libTs = r.fileHotspots.find(f => f.path === 'src/lib.ts')!;
    expect(libTs.reads).toBe(1);
  });

  it('flags tool schemas dominating', () => {
    // 10 turns, each accumulating user+assistant of moderate size, but schemas crushing them
    const msgs: Message[] = [];
    for (let i = 0; i < 10; i++) {
      msgs.push({ role: 'user', content: `q${i}` });
      msgs.push({ role: 'assistant', content: 'short answer' });
    }
    const r = analyzeMessages('s', msgs, { systemTokens: 100, toolSchemaTokens: 5000 });
    const rec = r.recommendations.join(' ');
    expect(rec).toMatch(/Tool schemas account for/);
    expect(rec).toMatch(/caching/);
  });

  it('flags repeated file reads', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: '',
        tool_calls: Array.from({ length: 4 }, (_, i) => ({
          id: `c${i}`,
          type: 'function' as const,
          function: { name: 'read_file', arguments: '{"path":"src/app.ts"}' },
        })),
      },
    ];
    const r = analyzeMessages('s', msgs, { systemTokens: 0, toolSchemaTokens: 0 });
    expect(r.recommendations.some(x => /Repeated reads/.test(x) && /src\/app\.ts/.test(x))).toBe(true);
  });

  it('flags turns approaching context-window limits', () => {
    // One huge tool result
    const huge = 'x'.repeat(120_000); // ~30K tokens
    const msgs: Message[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c', content: huge, name: 'read_file' },
    ];
    const r = analyzeMessages('s', msgs, { systemTokens: 200, toolSchemaTokens: 2000 });
    const rec = r.recommendations.join(' ');
    expect(rec).toMatch(/Latest turn weighs/);
  });
});

describe('formatReport', () => {
  it('produces a readable table with header, per-turn rows, totals, and recommendations', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'a'.repeat(40) },
      { role: 'assistant', content: 'b'.repeat(40) },
    ];
    const r = analyzeMessages('abcdef-1234-5678', msgs, { systemTokens: 100, toolSchemaTokens: 500 });
    const out = formatReport(r);
    expect(out).toContain('Token analysis');
    expect(out).toContain('Per-turn breakdown');
    expect(out).toContain('Recommendations:');
    // Session id shown abbreviated
    expect(out).toContain('abcdef-1');
  });
});
