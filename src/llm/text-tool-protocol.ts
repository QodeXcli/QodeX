/**
 * Text-mode tool calling — make tool-incapable models (e.g. glm4, older Ollama models)
 * usable as agents.
 *
 * The problem: some models reject the OpenAI `tools` field outright (Ollama returns
 * `HTTP 400: <model> does not support tools`), so they can never call write_file/bash/etc
 * and are dead weight in an agent loop. But every chat model can follow a TEXT convention.
 *
 * The fix (this module + the existing recovery layer):
 *   1. Detect such a model (modelInfo.supportsToolCalls === false).
 *   2. DON'T send the `tools` field (avoids the 400).
 *   3. Inject a system block that (a) teaches a single emit format and (b) lists every
 *      available tool with its parameters — because without the tools field the model has
 *      no other way to know what it can call.
 *   4. The model emits `<tool_call>{"name":...,"arguments":{...}}</tool_call>` in TEXT.
 *      The loop's existing `recoverToolCallsFromText` already parses exactly that shape
 *      into real ToolCall objects — so execution, permissions, the verify gate, everything
 *      downstream works unchanged.
 *
 * Result: this is the last piece of "any model you connect gets amplified" — even a model
 * with zero native tool support becomes a working agent, just over a text channel.
 *
 * All functions here are PURE (schemas in → strings/messages out), so they're fully
 * unit-tested with no model in the loop.
 */

import type { Message } from '../session/store.js';
import type { ToolSchema } from './types.js';

/** True when this model can't take the native `tools` field and must use the text channel. */
export function needsTextToolMode(supportsToolCalls: boolean): boolean {
  return supportsToolCalls === false;
}

/** Render one tool schema as a compact, model-readable spec line block. */
function renderToolSpec(schema: ToolSchema): string {
  const fn = schema.function;
  const params = fn.parameters?.properties ?? {};
  const required = new Set(fn.parameters?.required ?? []);
  const keys = Object.keys(params);

  const argLines = keys.map(k => {
    const p: any = params[k] ?? {};
    const type = Array.isArray(p.type) ? p.type.join('|') : (p.type ?? 'any');
    const req = required.has(k) ? 'required' : 'optional';
    const enumNote = Array.isArray(p.enum) ? ` (one of: ${p.enum.join(', ')})` : '';
    const desc = p.description ? ` — ${String(p.description).replace(/\s+/g, ' ').trim()}` : '';
    return `      - ${k} (${type}, ${req})${enumNote}${desc}`;
  });

  const head = `  • ${fn.name} — ${(fn.description ?? '').replace(/\s+/g, ' ').trim()}`;
  return keys.length > 0 ? `${head}\n    args:\n${argLines.join('\n')}` : `${head}\n    args: (none)`;
}

/**
 * Build the system block that teaches text-mode tool calling and lists every tool.
 * Empty string if no schemas (the model just answers in prose, which is correct).
 */
export function buildTextToolInstructions(schemas: ToolSchema[]): string {
  if (schemas.length === 0) return '';
  const toolList = schemas.map(renderToolSpec).join('\n');
  return `# HOW TO ACT — READ THIS FIRST (this overrides any other instinct)

You have NO native tool channel, so you act by writing a special TEXT tag. This is the ONLY
way anything actually happens. Writing a command in a \`\`\`code block\`\`\`, or as "shell: ..."
or "I would run ...", does NOTHING — the file is never created, the command never runs.

To DO something, write EXACTLY this and nothing else:

<tool_call>{"name": "<EXACT_TOOL_NAME>", "arguments": { ...json... }}</tool_call>

Hard rules:
1. Use the EXACT tool name from the list below. To run a shell command the tool is \`bash\`
   (NOT "shell"). To create a file it is \`write_file\`. To edit it is \`edit_file\`.
2. Inside the tags: ONE valid JSON object with "name" and "arguments". "arguments" holds the
   tool's parameters. Escape newlines inside strings as \\n — never a raw line break in JSON.
3. NEVER describe the command in prose or a markdown code block instead of calling it. If you
   catch yourself writing "I would run \`echo ...\`" or "\`\`\`shell" — STOP and write the
   <tool_call> tag instead.
4. After your tool calls, STOP. The results arrive next turn. Don't invent the output.
5. ONLY when the whole task is finished and you need no tool, reply in plain prose (no tag).

Worked examples (copy this shape exactly):
- Create a file:
  <tool_call>{"name": "write_file", "arguments": {"path": "hello.txt", "content": "Hello, QodeX!\\n"}}</tool_call>
- Run a shell command:
  <tool_call>{"name": "bash", "arguments": {"command": "ls -la"}}</tool_call>
- Read a file:
  <tool_call>{"name": "read_file", "arguments": {"path": "src/index.ts"}}</tool_call>

## Available tools (use these EXACT names)
${toolList}`;
}

/**
 * Return a copy of `messages` with the text-tool protocol block injected as its OWN system
 * message, placed right after the existing leading system message(s). Keeping it separate
 * (rather than concatenated into the main system prompt) means the primary system prefix
 * stays byte-stable for any KV/prompt cache, and the block is trivial to add/remove.
 *
 * No-op (returns the same array reference semantics, new array) when `block` is empty.
 */
export function withTextToolProtocol(messages: Message[], block: string): Message[] {
  if (!block) return messages;
  // Find the index just past the leading run of system messages.
  let insertAt = 0;
  while (insertAt < messages.length && messages[insertAt]!.role === 'system') insertAt++;
  const protocolMsg: Message = { role: 'system', content: block };
  return [...messages.slice(0, insertAt), protocolMsg, ...messages.slice(insertAt)];
}
