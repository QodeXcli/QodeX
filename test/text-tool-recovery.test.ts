import { describe, it, expect } from 'vitest';
import { recoverToolCallsFromText } from '../src/llm/text-tool-recovery.js';

const knownTools = new Set(['read_file', 'write_file', 'edit_text', 'shell', 'grep']);

describe('Text-tool recovery (Ollama JSON-in-text fallback)', () => {
  it('returns empty on plain prose', () => {
    const r = recoverToolCallsFromText('Sure, I will read the file for you.', knownTools);
    expect(r.calls).toEqual([]);
  });

  it('extracts an XML-tagged tool call', () => {
    const text = `Let me check.\n<tool_call>{"name":"read_file","arguments":{"path":"src/index.ts"}}</tool_call>`;
    const r = recoverToolCallsFromText(text, knownTools);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.function.name).toBe('read_file');
    expect(JSON.parse(r.calls[0]!.function.arguments)).toEqual({ path: 'src/index.ts' });
    expect(r.cleanedText).not.toContain('<tool_call>');
  });

  it('extracts a code-fenced JSON tool call', () => {
    const text = "I'll read this:\n```json\n{\"name\":\"read_file\",\"arguments\":{\"path\":\"x.ts\"}}\n```\nand then edit.";
    const r = recoverToolCallsFromText(text, knownTools);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.function.name).toBe('read_file');
    expect(r.cleanedText).not.toContain('```');
  });

  it('extracts a bare top-level JSON object', () => {
    const text = '{"name":"shell","arguments":{"command":"ls"}}';
    const r = recoverToolCallsFromText(text, knownTools);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.function.name).toBe('shell');
  });

  it('extracts OpenAI-legacy {function: {...}} shape', () => {
    const text = '<tool_call>{"function":{"name":"grep","arguments":"{\\"pattern\\":\\"TODO\\"}"}}</tool_call>';
    const r = recoverToolCallsFromText(text, knownTools);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.function.name).toBe('grep');
  });

  it('ignores calls to unknown tools (false-positive guard)', () => {
    const text = '<tool_call>{"name":"hallucinated_tool","arguments":{}}</tool_call>';
    const r = recoverToolCallsFromText(text, knownTools);
    expect(r.calls).toEqual([]);
  });

  it('does not match prose that happens to contain "name" in a JSON-shaped string', () => {
    const text = 'My friend\'s name is Reza and his arguments were valid.';
    const r = recoverToolCallsFromText(text, knownTools);
    expect(r.calls).toEqual([]);
  });

  it('extracts multiple tool calls when emitted sequentially', () => {
    const text =
      '<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>\n' +
      '<tool_call>{"name":"read_file","arguments":{"path":"b.ts"}}</tool_call>';
    const r = recoverToolCallsFromText(text, knownTools);
    expect(r.calls).toHaveLength(2);
    expect(JSON.parse(r.calls[0]!.function.arguments)).toEqual({ path: 'a.ts' });
    expect(JSON.parse(r.calls[1]!.function.arguments)).toEqual({ path: 'b.ts' });
  });

  it('handles tool_use tag variant', () => {
    const text = '<tool_use>{"name":"shell","arguments":{"command":"pwd"}}</tool_use>';
    const r = recoverToolCallsFromText(text, knownTools);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.function.name).toBe('shell');
  });

  it('accepts parameters/input as aliases for arguments', () => {
    const text = '<tool_call>{"name":"grep","parameters":{"pattern":"x"}}</tool_call>';
    const r = recoverToolCallsFromText(text, knownTools);
    expect(r.calls).toHaveLength(1);
    expect(JSON.parse(r.calls[0]!.function.arguments)).toEqual({ pattern: 'x' });
  });

  // ============================================================
  // v0.3.3 — Chinese-model / additional-vendor pattern coverage
  // ============================================================

  describe('Qwen3 / ChatGLM pipe-delimited special tokens', () => {
    it('extracts <|tool_call_begin|>...<|tool_call_end|> (Qwen3)', () => {
      const text = `Let me check that file.\n<|tool_call_begin|>{"name":"read_file","arguments":{"path":"src/app.ts"}}<|tool_call_end|>`;
      const r = recoverToolCallsFromText(text, knownTools);
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0]!.function.name).toBe('read_file');
      expect(JSON.parse(r.calls[0]!.function.arguments)).toEqual({ path: 'src/app.ts' });
      expect(r.cleanedText).not.toContain('<|tool_call_begin|>');
    });

    it('extracts <|FunctionCallBegin|>...<|FunctionCallEnd|> (ChatGLM / GLM-4)', () => {
      const text = `<|FunctionCallBegin|>{"name":"shell","arguments":{"command":"ls"}}<|FunctionCallEnd|>`;
      const r = recoverToolCallsFromText(text, knownTools);
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0]!.function.name).toBe('shell');
    });

    it('extracts tag-closure variant <|tool_call|>...<|/tool_call|>', () => {
      const text = `<|tool_call|>{"name":"grep","arguments":{"pattern":"TODO"}}<|/tool_call|>`;
      const r = recoverToolCallsFromText(text, knownTools);
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0]!.function.name).toBe('grep');
    });

    it('false-positive guard: pipe-delimited block with unknown tool name is ignored', () => {
      const text = `<|tool_call_begin|>{"name":"hallucinated_tool","arguments":{}}<|tool_call_end|>`;
      const r = recoverToolCallsFromText(text, knownTools);
      expect(r.calls).toEqual([]);
    });
  });

  describe('Bare <tool>...</tool> tag (Hermes / Nous lineage)', () => {
    it('extracts a single <tool> tag', () => {
      const text = `<tool>{"name":"write_file","arguments":{"path":"x.ts","content":"//"}}</tool>`;
      const r = recoverToolCallsFromText(text, knownTools);
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0]!.function.name).toBe('write_file');
    });

    it('does not match prose containing the word "tool"', () => {
      const text = 'I will use a tool to read this file.';
      const r = recoverToolCallsFromText(text, knownTools);
      expect(r.calls).toEqual([]);
    });
  });

  describe('Mistral [TOOL_CALLS] format', () => {
    it('extracts a JSON ARRAY of tool calls', () => {
      const text = `[TOOL_CALLS] [{"name":"read_file","arguments":{"path":"a.ts"}},{"name":"read_file","arguments":{"path":"b.ts"}}]`;
      const r = recoverToolCallsFromText(text, knownTools);
      expect(r.calls).toHaveLength(2);
      expect(JSON.parse(r.calls[0]!.function.arguments)).toEqual({ path: 'a.ts' });
      expect(JSON.parse(r.calls[1]!.function.arguments)).toEqual({ path: 'b.ts' });
      expect(r.cleanedText).not.toContain('[TOOL_CALLS]');
    });

    it('extracts a single object after [TOOL_CALLS]', () => {
      const text = `[TOOL_CALLS] {"name":"shell","arguments":{"command":"pwd"}}`;
      const r = recoverToolCallsFromText(text, knownTools);
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0]!.function.name).toBe('shell');
    });

    it('filters out array entries with unknown tool names but keeps known ones', () => {
      const text = `[TOOL_CALLS] [{"name":"read_file","arguments":{"path":"a"}},{"name":"hallucinated","arguments":{}}]`;
      const r = recoverToolCallsFromText(text, knownTools);
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0]!.function.name).toBe('read_file');
    });

    it('false-positive guard: bare "[TOOL_CALLS]" in prose with no JSON is ignored', () => {
      const text = 'The Mistral model documentation mentions [TOOL_CALLS] as a format.';
      const r = recoverToolCallsFromText(text, knownTools);
      expect(r.calls).toEqual([]);
    });
  });

  describe('<tools> plural tag', () => {
    it('extracts a JSON array of tool calls', () => {
      const text = `<tools>[{"name":"read_file","arguments":{"path":"a"}},{"name":"grep","arguments":{"pattern":"x"}}]</tools>`;
      const r = recoverToolCallsFromText(text, knownTools);
      expect(r.calls).toHaveLength(2);
      expect(r.calls[0]!.function.name).toBe('read_file');
      expect(r.calls[1]!.function.name).toBe('grep');
    });

    it('also accepts a single object inside <tools>', () => {
      const text = `<tools>{"name":"shell","arguments":{"command":"ls"}}</tools>`;
      const r = recoverToolCallsFromText(text, knownTools);
      expect(r.calls).toHaveLength(1);
    });
  });

  describe('DeepSeek-V3 fullwidth-pipe markers (U+FF5C / U+2581)', () => {
    it('extracts a single <｜tool▁call▁begin｜>...<｜tool▁call▁end｜> block', () => {
      const text = `<｜tool▁call▁begin｜>{"name":"read_file","arguments":{"path":"d.ts"}}<｜tool▁call▁end｜>`;
      const r = recoverToolCallsFromText(text, knownTools);
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0]!.function.name).toBe('read_file');
    });

    it('extracts MULTIPLE calls from a <｜tool▁calls▁begin｜>...<｜tool▁calls▁end｜> wrapper', () => {
      const text = `<｜tool▁calls▁begin｜>
        {"name":"read_file","arguments":{"path":"a.ts"}}
        some prose between calls
        {"name":"grep","arguments":{"pattern":"foo"}}
      <｜tool▁calls▁end｜>`;
      const r = recoverToolCallsFromText(text, knownTools);
      expect(r.calls).toHaveLength(2);
      expect(r.calls[0]!.function.name).toBe('read_file');
      expect(r.calls[1]!.function.name).toBe('grep');
    });

    it('outer multi-call wrapper does not double-count when inner blocks are also present', () => {
      // The wrapper is consumed first; the singular pattern then skips because its match
      // index falls inside an already-consumed range.
      const text = `<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>{"name":"read_file","arguments":{"path":"x"}}<｜tool▁call▁end｜><｜tool▁calls▁end｜>`;
      const r = recoverToolCallsFromText(text, knownTools);
      // The outer wrapper finds the JSON object inside via findAllJsonObjects, exactly once.
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0]!.function.name).toBe('read_file');
    });

    it('false-positive guard: DeepSeek wrapper with only unknown tools yields nothing', () => {
      const text = `<｜tool▁calls▁begin｜>{"name":"hallucinated_tool","arguments":{}}<｜tool▁calls▁end｜>`;
      const r = recoverToolCallsFromText(text, knownTools);
      expect(r.calls).toEqual([]);
    });
  });
});
