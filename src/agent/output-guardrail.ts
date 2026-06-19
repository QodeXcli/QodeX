/**
 * Output Guardrail & Self-Correction.
 *
 * Local models (Qwen3, etc.) sometimes emit *structurally* broken output: an
 * unclosed `<thinking>` tag, a `<tool_call>` with truncated/invalid JSON, or a
 * fenced JSON block that never closes. The existing layers handle two adjacent
 * cases already:
 *
 *   - constrained.ts        — proactively repairs tool ARGUMENTS against the schema
 *   - text-tool-recovery.ts — reactively extracts a tool call from prose
 *
 * What was missing is the *reflection* case from the spec: when the output is
 * malformed in a way those two can't silently fix, instead of dropping it on the
 * floor we detect the specific defect and feed ONE hidden corrective turn back to
 * the model ("your <thinking> tag was never closed — re-emit it correctly"),
 * then let it try again. One shot only — we never loop on correction, to avoid
 * burning the iteration budget on a model that simply can't comply.
 *
 * This module is pure detection + message construction (no I/O, no model calls),
 * so it's unit-testable and the agent loop stays the only place that does I/O.
 */

export type GuardrailDefect =
  | 'unclosed_thinking'
  | 'unclosed_tool_call'
  | 'malformed_tool_json'
  | 'unclosed_code_fence'
  | 'empty_response';

export interface GuardrailResult {
  ok: boolean;
  defect?: GuardrailDefect;
  /** Human/he-model-readable description of exactly what to fix. */
  feedback?: string;
}

const OPEN_THINK = /<(thinking|think|reasoning|reflection)>/gi;
const CLOSE_THINK = /<\/(thinking|think|reasoning|reflection)>/gi;
const OPEN_TOOLCALL = /<tool_call>/gi;
const CLOSE_TOOLCALL = /<\/tool_call>/gi;

function countMatches(re: RegExp, s: string): number {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(s) !== null) n++;
  return n;
}

/** Count unescaped ``` fences. Odd → an unclosed fence. */
function countCodeFences(s: string): number {
  const m = s.match(/```/g);
  return m ? m.length : 0;
}

/**
 * Inspect a completed assistant turn that produced NO usable tool calls. If the
 * text is structurally broken, return a defect + corrective feedback. If it's
 * fine (e.g. a legitimate final answer), return ok:true.
 *
 * @param hadToolCalls whether the loop already extracted/recovered tool calls.
 *   When true, the turn is actionable and we never inject a correction.
 */
export function inspectOutput(text: string, hadToolCalls: boolean): GuardrailResult {
  if (hadToolCalls) return { ok: true };

  const trimmed = (text ?? '').trim();

  // An empty response with no tool call is itself a defect — the model stalled.
  if (trimmed.length === 0) {
    return {
      ok: false,
      defect: 'empty_response',
      feedback:
        'Your last response was empty. Either call a tool using ' +
        '`<tool_call>{"name": "...", "arguments": {...}}</tool_call>` to make ' +
        'progress, or give your final answer as plain text.',
    };
  }

  // Unbalanced <thinking> family.
  if (countMatches(OPEN_THINK, trimmed) > countMatches(CLOSE_THINK, trimmed)) {
    return {
      ok: false,
      defect: 'unclosed_thinking',
      feedback:
        'Your reasoning block was opened but never closed — add the matching ' +
        '`</thinking>` tag. Keep reasoning inside `<thinking>…</thinking>`, then ' +
        'either emit a `<tool_call>` or your final answer outside it.',
    };
  }

  // Unbalanced <tool_call>.
  const openTC = countMatches(OPEN_TOOLCALL, trimmed);
  const closeTC = countMatches(CLOSE_TOOLCALL, trimmed);
  if (openTC > closeTC) {
    return {
      ok: false,
      defect: 'unclosed_tool_call',
      feedback:
        'You started a `<tool_call>` but never closed it with `</tool_call>`. ' +
        'Re-emit the entire call on one line: ' +
        '`<tool_call>{"name": "TOOL", "arguments": { ... }}</tool_call>`.',
    };
  }

  // A closed tool_call whose body is present but didn't parse (the loop would
  // have extracted it otherwise) — signal malformed JSON.
  if (openTC > 0 && openTC === closeTC) {
    return {
      ok: false,
      defect: 'malformed_tool_json',
      feedback:
        'Your `<tool_call>` JSON could not be parsed. Re-emit it as STRICT JSON: ' +
        'double-quoted keys and strings, no trailing commas, no comments, no ' +
        'unescaped newlines inside strings. Format: ' +
        '`<tool_call>{"name": "TOOL", "arguments": { ... }}</tool_call>`.',
    };
  }

  // Unclosed markdown code fence — common when output was truncated mid-block.
  if (countCodeFences(trimmed) % 2 === 1) {
    return {
      ok: false,
      defect: 'unclosed_code_fence',
      feedback:
        'A markdown code fence (```) was opened but never closed. Re-send the ' +
        'response with the closing ``` so the code block is complete.',
    };
  }

  return { ok: true };
}

/** Build the hidden corrective system message fed back to the model (one shot). */
export function buildCorrectionMessage(result: GuardrailResult): string {
  return (
    `[FORMAT CORRECTION] ${result.feedback} ` +
    `Do not apologize or explain this correction — just re-send the corrected output.`
  );
}
