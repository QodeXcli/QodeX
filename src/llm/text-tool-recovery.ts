/**
 * Some local models (especially smaller Ollama models like llama3.1-8b, mistral-7b)
 * do not reliably use the `tool_calls` field. Instead they emit the tool invocation
 * directly in the text stream, in one of several common shapes:
 *
 *   1. XML-tagged:        <tool_call>{"name":"read_file","arguments":{...}}</tool_call>
 *   2. Function-tag:      <function_call>{...}</function_call>
 *   3. Code-fenced JSON:  ```json\n{"name":"read_file","arguments":{...}}\n```
 *   4. Bare top-level:    {"name":"read_file","arguments":{...}}    (whole message is JSON)
 *   5. OpenAI legacy:     {"function":{"name":"...","arguments":"..."}}
 *
 * This module attempts to recover those into proper ToolCall objects. It is INTENTIONALLY
 * conservative — it must only return calls whose `name` matches a known tool, and whose
 * `arguments` parse as a JSON object. False positives degrade the model's authoritative voice,
 * so we err toward leaving text alone.
 */

import type { ToolCall } from '../session/store.js';

interface RecoveredCall {
  toolCall: ToolCall;
  /** The exact substring in the original text that produced this call. Used to clean the visible text. */
  matchedText: string;
}

/**
 * Llama-3.1 / Granite / qwen3-coder-on-ollama style:
 *
 *   <function=read_file>
 *   <parameter=path>./src/main.ts</parameter>
 *   <parameter=offset>1</parameter>
 *   </function>
 *
 * Detected separately from JSON-style patterns because the args are NOT JSON —
 * each `<parameter=NAME>VALUE</parameter>` is one key/value pair. Values may be
 * raw strings, numbers, or JSON sub-objects. We collect them into a flat object
 * and JSON.stringify the result to match the standard ToolCall shape.
 *
 * Closing tag variants seen in the wild:
 *   - </function>        (most common)
 *   - </function_call>   (some Granite finetunes)
 *   - no closing tag, EOF terminates (rare; we accept this when the rest of the
 *     text contains no further tags)
 */
const LLAMA_FUNCTION_TAG_RE = /<function=([a-zA-Z_][\w.-]*)>([\s\S]*?)(?:<\/function(?:_call)?>|$)/g;
const LLAMA_PARAMETER_RE = /<parameter=([a-zA-Z_][\w.-]*)>([\s\S]*?)<\/parameter>/g;

function extractLlamaStyleCalls(
  text: string,
  knownToolNames: ReadonlySet<string>,
): Array<{ toolCall: ToolCall; matchedText: string; start: number; end: number }> {
  const out: Array<{ toolCall: ToolCall; matchedText: string; start: number; end: number }> = [];
  const re = new RegExp(LLAMA_FUNCTION_TAG_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[1]!;
    if (!knownToolNames.has(name)) continue;
    const inner = m[2] ?? '';
    const args: Record<string, any> = {};
    const paramRe = new RegExp(LLAMA_PARAMETER_RE.source, 'g');
    let pm: RegExpExecArray | null;
    while ((pm = paramRe.exec(inner)) !== null) {
      const key = pm[1]!;
      const raw = (pm[2] ?? '').trim();
      // Try to coerce: JSON literal first (true/false/null/number/array/object), else string
      let value: any = raw;
      if (/^(true|false|null)$/.test(raw)) value = JSON.parse(raw);
      else if (/^-?\d+(\.\d+)?$/.test(raw)) value = Number(raw);
      else if ((raw.startsWith('{') && raw.endsWith('}')) || (raw.startsWith('[') && raw.endsWith(']'))) {
        try { value = JSON.parse(raw); } catch { /* keep string */ }
      }
      args[key] = value;
    }
    out.push({
      toolCall: {
        id: `recovered_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
      matchedText: m[0],
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return out;
}

const XML_PATTERNS = [
  // --- ASCII-pipe XML-style (most common across vendors) ---
  /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g,
  /<function_call>\s*([\s\S]*?)\s*<\/function_call>/g,
  /<tool_use>\s*([\s\S]*?)\s*<\/tool_use>/g,

  // --- Bare <tool> tag (Hermes / Nous-Hermes lineage) ---
  /<tool>\s*([\s\S]*?)\s*<\/tool>/g,

  // --- Pipe-delimited special-token variants ---
  // Qwen3 / Qwen2.5 sometimes leak these as text when sampled below the tool-call temperature
  /<\|tool_call_begin\|>\s*([\s\S]*?)\s*<\|tool_call_end\|>/g,
  // ChatGLM, GLM-4
  /<\|FunctionCallBegin\|>\s*([\s\S]*?)\s*<\|FunctionCallEnd\|>/g,
  // Tag-closure variants observed in newer ChatGLM / Yi
  /<\|tool_call\|>\s*([\s\S]*?)\s*<\|\/tool_call\|>/g,
  /<\|tool_use\|>\s*([\s\S]*?)\s*<\|\/tool_use\|>/g,
  /<\|function_call\|>\s*([\s\S]*?)\s*<\|\/function_call\|>/g,

  // --- DeepSeek-V3 single-call marker ---
  // Uses Unicode fullwidth pipe U+FF5C (｜) and lower-one-eighth-block U+2581 (▁)
  // — these are special tokens in DeepSeek's tokenizer that occasionally leak as text.
  /<｜tool▁call▁begin｜>\s*([\s\S]*?)\s*<｜tool▁call▁end｜>/g,
];

/**
 * Multi-call patterns: a single match yields ZERO OR MORE ToolCall objects.
 * Format:
 *   - 'json'      → captured group is JSON; if array, iterate; if object, extract single
 *   - 'find-all'  → captured group contains free-form text; extract every balanced JSON object
 */
const MULTI_PATTERNS: Array<{ regex: RegExp; format: 'json' | 'find-all' }> = [
  // Mistral: [TOOL_CALLS] [{"name":...}, {"name":...}]  OR  [TOOL_CALLS] {"name":...}
  // Greedy (not lazy): a single object with nested args — {"name":"x","arguments":{...}} —
  // closes on its FIRST '}' under a lazy quantifier, capturing an unbalanced fragment.
  // Greedy reaches the final bracket; tryExtractMultiple's balanced-object fallback
  // recovers the leading value if a greedy match ever overshoots into trailing prose.
  { regex: /\[TOOL_CALLS\]\s*(\[[\s\S]*\]|\{[\s\S]*\})/g, format: 'json' },
  // <tools>...</tools> (plural) — content is JSON array, or sometimes a single object
  { regex: /<tools>\s*([\s\S]*?)\s*<\/tools>/g, format: 'json' },
  // DeepSeek-V3 multi-call wrapper — interior contains one or more individual call blocks
  // (we use find-all because the inner format mixes prose markers and JSON fences)
  { regex: /<｜tool▁calls▁begin｜>([\s\S]*?)<｜tool▁calls▁end｜>/g, format: 'find-all' },
];

const CODE_FENCE_PATTERN = /```(?:json|tool|tool_call|tool_use|function_call)?\s*\n([\s\S]*?)\n```/g;

/**
 * Attempt to extract tool calls from a model's text output.
 * @param text - The assistant's text content
 * @param knownToolNames - Set of valid tool names; calls referencing other names are ignored
 */
export function recoverToolCallsFromText(
  text: string,
  knownToolNames: ReadonlySet<string>,
): { calls: ToolCall[]; cleanedText: string } {
  if (!text || knownToolNames.size === 0) {
    return { calls: [], cleanedText: text };
  }

  const recovered: RecoveredCall[] = [];
  const consumedRanges: Array<[number, number]> = [];

  // Helper: extract a call from a JSON snippet
  const tryExtract = (raw: string): ToolCall | null => {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // The most common JSON-from-LLM failure: literal newlines / tabs inside string
      // values (the model wrote them as raw \n, not as the escape sequence "\\n").
      // Try a forgiving parse before falling back to balanced-object scanning.
      const relaxed = tryParseRelaxed(trimmed);
      if (relaxed !== null) {
        parsed = relaxed;
      } else {
        // try to find the first balanced { ... } block
        const objText = findFirstJsonObject(trimmed);
        if (!objText) return null;
        try {
          parsed = JSON.parse(objText);
        } catch {
          const relaxedObj = tryParseRelaxed(objText);
          if (relaxedObj === null) return null;
          parsed = relaxedObj;
        }
      }
    }
    return parsedObjectToToolCall(parsed, knownToolNames);
  };

  // Helper: extract MULTIPLE calls from a snippet. Used by MULTI_PATTERNS.
  //   - 'json'     → parse as JSON; if array, iterate; if object, treat as single
  //   - 'find-all' → scan for every balanced JSON object and try each
  const tryExtractMultiple = (raw: string, format: 'json' | 'find-all'): ToolCall[] => {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    if (format === 'json') {
      let parsed: any;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // Fallback: maybe the array has trailing junk — try first balanced object
        const objText = findFirstJsonObject(trimmed);
        if (!objText) return [];
        try { parsed = JSON.parse(objText); } catch { return []; }
      }
      const out: ToolCall[] = [];
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const call = parsedObjectToToolCall(item, knownToolNames);
          if (call) out.push(call);
        }
      } else {
        const single = parsedObjectToToolCall(parsed, knownToolNames);
        if (single) out.push(single);
      }
      return out;
    }
    // 'find-all'
    const objects = findAllJsonObjects(trimmed);
    const out: ToolCall[] = [];
    for (const obj of objects) {
      try {
        const parsed = JSON.parse(obj.text);
        const call = parsedObjectToToolCall(parsed, knownToolNames);
        if (call) out.push(call);
      } catch {
        /* skip unparsable */
      }
    }
    return out;
  };

  // 1. Multi-call wrappers FIRST (Mistral [TOOL_CALLS], <tools> plural, DeepSeek-V3
  //    `<｜tool▁calls▁begin｜>` wrapper). A wrapper can ENCLOSE singular XML markers
  //    (e.g. an inner `<｜tool▁call▁begin｜>` block), so it must be consumed as a unit
  //    before the singular patterns run — otherwise the inner block is recovered twice:
  //    once by the wrapper's find-all, once by the singular XML pattern.
  //    Each match may yield zero or more ToolCall objects.
  for (const { regex, format } of MULTI_PATTERNS) {
    const reset = new RegExp(regex.source, regex.flags);
    let match: RegExpExecArray | null;
    while ((match = reset.exec(text)) !== null) {
      if (isInConsumed(match.index, consumedRanges)) continue;
      const inner = match[1] ?? '';
      const calls = tryExtractMultiple(inner, format);
      if (calls.length > 0) {
        for (const call of calls) {
          // Same matchedText for every call from this match so cleanedText strips the whole wrapper.
          recovered.push({ toolCall: call, matchedText: match[0] });
        }
        consumedRanges.push([match.index, match.index + match[0].length]);
      }
    }
  }

  // 2. XML-tagged singular patterns. Skip any match whose start falls inside a wrapper
  //    range already consumed in step 1 — that JSON has been recovered.
  for (const pattern of XML_PATTERNS) {
    const reset = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = reset.exec(text)) !== null) {
      if (isInConsumed(match.index, consumedRanges)) continue;
      const inner = match[1] ?? '';
      const call = tryExtract(inner);
      if (call) {
        recovered.push({ toolCall: call, matchedText: match[0] });
        consumedRanges.push([match.index, match.index + match[0].length]);
      }
    }
  }

  // 3. Llama-3.1 / Granite / qwen3-coder-on-ollama style — `<function=name><parameter=key>val</parameter>...</function>`
  //     Args are key/value pairs, not JSON. Handled by a dedicated extractor.
  const llamaCalls = extractLlamaStyleCalls(text, knownToolNames);
  for (const lc of llamaCalls) {
    if (isInConsumed(lc.start, consumedRanges)) continue;
    recovered.push({ toolCall: lc.toolCall, matchedText: lc.matchedText });
    consumedRanges.push([lc.start, lc.end]);
  }

  // 4. Code-fenced JSON blocks
  const fenceRegex = new RegExp(CODE_FENCE_PATTERN.source, 'g');
  let fenceMatch: RegExpExecArray | null;
  while ((fenceMatch = fenceRegex.exec(text)) !== null) {
    if (isInConsumed(fenceMatch.index, consumedRanges)) continue;
    const inner = fenceMatch[1] ?? '';
    const call = tryExtract(inner);
    if (call) {
      recovered.push({ toolCall: call, matchedText: fenceMatch[0] });
      consumedRanges.push([fenceMatch.index, fenceMatch.index + fenceMatch[0].length]);
    }
  }

  // 4b. Shell-intent fallback (weak models, e.g. glm4): they often describe a shell
  //     command as `shell: echo hi > f.txt` or in a ```shell / ```bash / ```sh fenced
  //     block instead of calling the bash tool. Only fires when (a) `bash` is a known
  //     tool, (b) nothing else was recovered, and (c) we find one of those shapes.
  //     Conservative: a single command, mapped to the bash tool.
  if (recovered.length === 0 && knownToolNames.has('bash')) {
    const shellCmd = extractShellIntent(text);
    if (shellCmd) {
      recovered.push({
        toolCall: {
          id: `recovered_sh_${Date.now()}`,
          type: 'function',
          function: { name: 'bash', arguments: JSON.stringify({ command: shellCmd.command }) },
        },
        matchedText: shellCmd.matchedText,
      });
      consumedRanges.push([shellCmd.start, shellCmd.end]);
    }
  }

  // 5. Bare top-level JSON — only consider if (a) text is mostly JSON, or
  //    (b) we found no calls yet AND there's a JSON object in the text.
  if (recovered.length === 0) {
    const trimmed = text.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      const call = tryExtract(trimmed);
      if (call) {
        recovered.push({ toolCall: call, matchedText: text });
        consumedRanges.push([0, text.length]);
      }
    } else {
      // Find any standalone-looking JSON object near the end
      const tail = findLastJsonObject(text);
      if (tail) {
        const call = tryExtract(tail.text);
        if (call) {
          recovered.push({ toolCall: call, matchedText: tail.text });
          consumedRanges.push([tail.start, tail.end]);
        }
      }
    }
  }

  if (recovered.length === 0) {
    return { calls: [], cleanedText: text };
  }

  // Strip the matched JSON from the cleaned text — the user shouldn't see raw blobs.
  consumedRanges.sort((a, b) => a[0] - b[0]);
  let cleaned = '';
  let cursor = 0;
  for (const [s, e] of consumedRanges) {
    cleaned += text.slice(cursor, s);
    cursor = e;
  }
  cleaned += text.slice(cursor);
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

  return {
    calls: recovered.map(r => r.toolCall),
    cleanedText: cleaned,
  };
}

function isInConsumed(index: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([s, e]) => index >= s && index < e);
}

/**
 * Last-ditch recovery for weak models that describe a shell command instead of calling
 * the bash tool. Recognizes two shapes and returns the command + the matched span:
 *
 *   1. A fenced block tagged shell/bash/sh:   ```bash\n<cmd>\n```
 *   2. An inline "shell: <cmd>" / "bash: <cmd>" line.
 *
 * Intentionally narrow: a single command, no chaining heuristics, mapped to `bash`. We'd
 * rather miss an ambiguous case than fabricate a destructive command from prose.
 */
function extractShellIntent(text: string): { command: string; matchedText: string; start: number; end: number } | null {
  // 1. Fenced ```bash / ```sh / ```shell block.
  const fence = /```(?:bash|sh|shell)\s*\n([\s\S]*?)\n```/i.exec(text);
  if (fence && fence[1]) {
    const body = fence[1].trim();
    // Strip a leading "shell:"/"bash:" the model sometimes puts inside the fence too.
    const cmd = body.replace(/^(?:shell|bash|sh)\s*:\s*/i, '').trim();
    // Single logical command only — bail if it looks like a multi-line script (too risky
    // to auto-run from prose). One trailing newline is fine.
    if (cmd && !cmd.includes('\n')) {
      return { command: cmd, matchedText: fence[0], start: fence.index, end: fence.index + fence[0].length };
    }
  }
  // 2. Inline "shell: <cmd>" or "bash: <cmd>" on its own line.
  const inline = /^[ \t>*-]*(?:shell|bash|sh)\s*:\s*(`?)([^\n`]+)\1\s*$/im.exec(text);
  if (inline && inline[2]) {
    const cmd = inline[2].trim();
    if (cmd) {
      return { command: cmd, matchedText: inline[0], start: inline.index, end: inline.index + inline[0].length };
    }
  }
  return null;
}

/** Convert a parsed JSON object into a ToolCall iff its shape and tool name are recognized. */
function parsedObjectToToolCall(obj: any, knownToolNames: ReadonlySet<string>): ToolCall | null {
  if (!obj || typeof obj !== 'object') return null;

  // Shape 1: { name, arguments | parameters | input }
  if (typeof obj.name === 'string' && knownToolNames.has(obj.name)) {
    const args = obj.arguments ?? obj.parameters ?? obj.input ?? {};
    return {
      id: typeof obj.id === 'string' ? obj.id : `recovered_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      type: 'function',
      function: {
        name: obj.name,
        arguments: typeof args === 'string' ? args : JSON.stringify(args),
      },
    };
  }

  // Shape 2: { function: { name, arguments } }  (OpenAI legacy)
  if (obj.function && typeof obj.function.name === 'string' && knownToolNames.has(obj.function.name)) {
    const args = obj.function.arguments ?? {};
    return {
      id: typeof obj.id === 'string' ? obj.id : `recovered_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      type: 'function',
      function: {
        name: obj.function.name,
        arguments: typeof args === 'string' ? args : JSON.stringify(args),
      },
    };
  }

  // Shape 3: { tool, args } (Claude-style)
  if (typeof obj.tool === 'string' && knownToolNames.has(obj.tool)) {
    const args = obj.args ?? obj.arguments ?? obj.parameters ?? {};
    return {
      id: typeof obj.id === 'string' ? obj.id : `recovered_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      type: 'function',
      function: {
        name: obj.tool,
        arguments: typeof args === 'string' ? args : JSON.stringify(args),
      },
    };
  }

  return null;
}

/** Find the first balanced JSON object in a string (depth-counting on braces, respecting strings). */
function findFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Find the last balanced JSON object — useful when the model writes prose then ends with a call. */
function findLastJsonObject(text: string): { text: string; start: number; end: number } | null {
  // Walk backward to find the last '}', then find its matching '{'
  let end = text.lastIndexOf('}');
  if (end === -1) return null;
  let depth = 0;
  let inString = false;
  // Scan backward — string awareness is tricky in reverse, so we scan forward from each candidate '{'.
  // Find candidate '{' positions and try each from rightmost.
  const opens: number[] = [];
  for (let i = 0; i < text.length; i++) if (text[i] === '{') opens.push(i);
  for (let k = opens.length - 1; k >= 0; k--) {
    const start = opens[k]!;
    depth = 0;
    inString = false;
    let escape = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i]!;
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          return { text: text.slice(start, i + 1), start, end: i + 1 };
        }
      }
    }
  }
  return null;
}

/**
 * Find every balanced JSON object in `text`, in left-to-right order, non-overlapping.
 * Used by multi-call patterns (e.g. DeepSeek-V3's `<｜tool▁calls▁begin｜>` wrapper)
 * where the interior contains multiple JSON snippets interleaved with prose / special markers.
 */
function findAllJsonObjects(text: string): Array<{ text: string; start: number; end: number }> {
  const results: Array<{ text: string; start: number; end: number }> = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf('{', cursor);
    if (start === -1) break;
    let depth = 0;
    let inString = false;
    let escape = false;
    let consumed = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i]!;
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          results.push({ text: text.slice(start, i + 1), start, end: i + 1 });
          cursor = i + 1;
          consumed = true;
          break;
        }
      }
    }
    if (!consumed) break; // unbalanced — bail to avoid infinite loop
  }
  return results;
}

/**
 * Relaxed JSON parser.
 *
 * The single most common JSON-from-LLM failure in QodeX traces is a literal newline
 * (or tab, or unescaped quote) inside a string value. The model wrote `"content": "line1\nline2"`
 * but typed an actual `\n` byte instead of the two-character escape sequence. JSON spec
 * forbids that — JSON.parse rejects it with "Bad control character in string literal".
 *
 * We walk the text once, tracking string-literal scope, and escape any disallowed
 * raw control characters we encounter inside a string. Then re-parse with strict JSON.
 *
 * Returns null when even the relaxed pass can't make sense of the input.
 *
 * Why a hand-written walker instead of regex: regex can't track quote scope reliably
 * across escaped quotes (`\"`) and would corrupt valid `\n` escape sequences.
 */
function tryParseRelaxed(input: string): unknown | null {
  if (!input) return null;
  let fixed = '';
  let inString = false;
  let escape = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (escape) {
      fixed += c;
      escape = false;
      continue;
    }
    if (c === '\\') {
      fixed += c;
      escape = true;
      continue;
    }
    if (c === '"') {
      fixed += c;
      inString = !inString;
      continue;
    }
    if (inString) {
      // Raw control characters inside a string literal are illegal JSON.
      // Replace with the proper escape sequence so the second JSON.parse can succeed.
      if (c === '\n') { fixed += '\\n'; continue; }
      if (c === '\r') { fixed += '\\r'; continue; }
      if (c === '\t') { fixed += '\\t'; continue; }
      if (c === '\b') { fixed += '\\b'; continue; }
      if (c === '\f') { fixed += '\\f'; continue; }
    }
    fixed += c;
  }
  try {
    return JSON.parse(fixed);
  } catch {
    return null;
  }
}
