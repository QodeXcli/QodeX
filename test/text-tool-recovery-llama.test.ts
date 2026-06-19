/**
 * Regression test for v1.15.3: Llama/Granite/qwen3-coder-on-ollama
 * `<function=name><parameter=k>v</parameter></function>` format.
 *
 * Real example reported in audit:
 *
 *   <function=read_file>
 *   <parameter=path>
 *   package.json
 *   </parameter>
 *   </function>
 *
 * Before the fix QodeX printed the raw text and got stuck.
 * After: recovered as a proper ToolCall with arguments {"path":"package.json"}.
 */

import { describe, it, expect } from 'vitest';
import { recoverToolCallsFromText } from '../src/llm/text-tool-recovery.js';

const KNOWN_TOOLS = new Set(['read_file', 'write_file', 'bash', 'glob', 'edit_text']);

describe('text-tool-recovery: llama/qwen3-coder function-tag format', () => {
  it('recovers a single function-tag call with one string parameter', () => {
    const text = `<function=read_file>
<parameter=path>
package.json
</parameter>
</function>`;
    const { calls, cleanedText } = recoverToolCallsFromText(text, KNOWN_TOOLS);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe('read_file');
    const args = JSON.parse(calls[0].function.arguments);
    expect(args).toEqual({ path: 'package.json' });
    expect(cleanedText.trim()).toBe('');
  });

  it('handles multiple parameters of different types', () => {
    const text = `Let me read the file.

<function=read_file>
<parameter=path>src/index.ts</parameter>
<parameter=offset>10</parameter>
<parameter=limit>50</parameter>
</function>`;
    const { calls } = recoverToolCallsFromText(text, KNOWN_TOOLS);
    expect(calls).toHaveLength(1);
    const args = JSON.parse(calls[0].function.arguments);
    expect(args.path).toBe('src/index.ts');
    expect(args.offset).toBe(10);  // coerced to number
    expect(args.limit).toBe(50);
  });

  it('coerces boolean and null literals', () => {
    const text = `<function=write_file>
<parameter=path>foo.txt</parameter>
<parameter=content>hi</parameter>
<parameter=overwrite>true</parameter>
<parameter=binary>false</parameter>
</function>`;
    const { calls } = recoverToolCallsFromText(text, KNOWN_TOOLS);
    expect(calls).toHaveLength(1);
    const args = JSON.parse(calls[0].function.arguments);
    expect(args.overwrite).toBe(true);
    expect(args.binary).toBe(false);
  });

  it('parses JSON object/array param values', () => {
    const text = `<function=edit_text>
<parameter=path>file.ts</parameter>
<parameter=replacements>[{"old":"foo","new":"bar"}]</parameter>
</function>`;
    const { calls } = recoverToolCallsFromText(text, KNOWN_TOOLS);
    expect(calls).toHaveLength(1);
    const args = JSON.parse(calls[0].function.arguments);
    expect(args.replacements).toEqual([{ old: 'foo', new: 'bar' }]);
  });

  it('ignores calls to unknown tool names', () => {
    const text = `<function=fake_tool>
<parameter=x>1</parameter>
</function>`;
    const { calls } = recoverToolCallsFromText(text, KNOWN_TOOLS);
    expect(calls).toHaveLength(0);
  });

  it('recovers multiple function-tag calls in one message', () => {
    const text = `First:
<function=read_file><parameter=path>a.ts</parameter></function>

Then:
<function=read_file><parameter=path>b.ts</parameter></function>`;
    const { calls } = recoverToolCallsFromText(text, KNOWN_TOOLS);
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0].function.arguments).path).toBe('a.ts');
    expect(JSON.parse(calls[1].function.arguments).path).toBe('b.ts');
  });

  it('accepts </function_call> as the closing tag (Granite finetunes)', () => {
    const text = `<function=bash>
<parameter=command>ls</parameter>
</function_call>`;
    const { calls } = recoverToolCallsFromText(text, KNOWN_TOOLS);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe('bash');
  });

  it('preserves surrounding prose in cleanedText', () => {
    const text = `Let me check that file.

<function=read_file><parameter=path>x.ts</parameter></function>

Done.`;
    const { calls, cleanedText } = recoverToolCallsFromText(text, KNOWN_TOOLS);
    expect(calls).toHaveLength(1);
    expect(cleanedText).toContain('Let me check that file.');
    expect(cleanedText).toContain('Done.');
    expect(cleanedText).not.toContain('<function=');
  });
});
