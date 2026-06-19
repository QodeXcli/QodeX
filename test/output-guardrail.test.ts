import { describe, it, expect } from 'vitest';
import { inspectOutput, buildCorrectionMessage } from '../src/agent/output-guardrail.js';

describe('inspectOutput', () => {
  it('passes a clean final answer', () => {
    expect(inspectOutput('Here is the summary of what I did.', false).ok).toBe(true);
  });

  it('never corrects when tool calls were already extracted', () => {
    expect(inspectOutput('<thinking>unclosed', true).ok).toBe(true);
  });

  it('flags an unclosed <thinking> tag', () => {
    const r = inspectOutput('<thinking>let me reason about this', false);
    expect(r.ok).toBe(false);
    expect(r.defect).toBe('unclosed_thinking');
  });

  it('accepts a balanced <thinking> block', () => {
    expect(inspectOutput('<thinking>reasoning</thinking>\nDone.', false).ok).toBe(true);
  });

  it('flags an unclosed <tool_call>', () => {
    const r = inspectOutput('<tool_call>{"name":"read_file"', false);
    expect(r.ok).toBe(false);
    expect(r.defect).toBe('unclosed_tool_call');
  });

  it('flags a closed-but-unparsed tool_call as malformed json', () => {
    const r = inspectOutput('<tool_call>{name: read_file,}</tool_call>', false);
    expect(r.ok).toBe(false);
    expect(r.defect).toBe('malformed_tool_json');
  });

  it('flags an empty response', () => {
    const r = inspectOutput('   ', false);
    expect(r.ok).toBe(false);
    expect(r.defect).toBe('empty_response');
  });

  it('flags an unclosed code fence', () => {
    const r = inspectOutput('Here:\n```js\nconst x = 1;', false);
    expect(r.ok).toBe(false);
    expect(r.defect).toBe('unclosed_code_fence');
  });

  it('accepts a balanced code fence', () => {
    expect(inspectOutput('```js\nconst x = 1;\n```', false).ok).toBe(true);
  });

  it('builds a correction message that tells the model not to apologize', () => {
    const r = inspectOutput('<thinking>x', false);
    const msg = buildCorrectionMessage(r);
    expect(msg).toMatch(/FORMAT CORRECTION/);
    expect(msg).toMatch(/Do not apologize/);
  });
});
