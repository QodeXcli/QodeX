/**
 * Constrained / structured decoding for tool calls.
 *
 * THE PROBLEM (local-first specific): smaller / quantized open models (Qwen 6-bit,
 * DeepSeek, GLM…) frequently emit tool calls with broken argument JSON, or emit the
 * call as prose instead of the structured `tool_calls` field. QodeX already carries a
 * pile of *reactive* band-aids for this — `text-tool-recovery.ts`,
 * `stripStandaloneJsonObjects`, the Ollama relaxed-args parser, refusal-language
 * injection. They run AFTER the damage is done.
 *
 * This module is the *proactive* half:
 *
 *   1. `coerceArgsToSchema()` — schema-guided argument repair. Given the raw arguments
 *      a model produced and the tool's own JSON Schema, fix the unambiguous mistakes
 *      (a number sent as "5", an array sent as a JSON string, a bool sent as "true")
 *      WITHOUT touching anything already valid. Deterministic, backend-agnostic, and
 *      fully unit-testable with no model in the loop. Runs in the registry before zod
 *      validation, so EVERY tool benefits.
 *
 *   2. `genericJsonGbnf()` / `toolChoiceJsonSchema()` — constraints we can hand to the
 *      inference server itself so malformed JSON can't be generated in the first place:
 *        - llama.cpp / LM Studio accept a GBNF `grammar`.
 *        - Ollama / LM Studio accept a JSON-Schema `format` / `response_format`.
 *      These are opt-in (a server that ignores them is harmless).
 *
 * Together: the server is pushed to emit valid JSON; whatever still slips through is
 * repaired against the schema before it reaches zod. The reactive band-aids remain as
 * a last line of defence.
 */

/** A minimal JSON-Schema shape — the subset `Tool.schema()` actually produces. */
export interface JsonSchemaNode {
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  required?: string[];
  enum?: unknown[];
  description?: string;
  default?: unknown;
  [k: string]: unknown;
}

/** Best-effort JSON parse that also tolerates the most common local-model breakage:
 *  raw (unescaped) newlines/tabs inside string literals. Returns `undefined` on failure. */
export function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Salvage: escape raw control chars that appear *inside* string literals.
    try {
      let fixed = '';
      let inString = false;
      let escape = false;
      for (let i = 0; i < trimmed.length; i++) {
        const c = trimmed[i]!;
        if (escape) { fixed += c; escape = false; continue; }
        if (c === '\\') { fixed += c; escape = true; continue; }
        if (c === '"') { fixed += c; inString = !inString; continue; }
        if (inString) {
          if (c === '\n') { fixed += '\\n'; continue; }
          if (c === '\r') { fixed += '\\r'; continue; }
          if (c === '\t') { fixed += '\\t'; continue; }
        }
        fixed += c;
      }
      return JSON.parse(fixed);
    } catch {
      return undefined;
    }
  }
}

/** Normalize a JSON-Schema `type` (which may be an array like `["string","null"]`). */
function primaryType(node: JsonSchemaNode): string | undefined {
  if (Array.isArray(node.type)) return node.type.find(t => t !== 'null');
  return node.type;
}

/**
 * Repair `raw` so it conforms to `schema`, fixing ONLY unambiguous type mismatches.
 *
 * Guarantees:
 *  - Anything already matching the schema is returned untouched (referential where possible).
 *  - Never invents required fields, never drops fields, never changes a value's meaning.
 *  - Safe to run on every tool call: a no-op for well-formed args.
 *
 * Handled coercions:
 *  - object field whose value is a JSON string  → parsed object
 *  - array field whose value is a JSON string   → parsed array
 *  - array field whose value is a lone scalar    → wrapped in a single-element array
 *  - number/integer field sent as numeric string → Number(...)
 *  - boolean field sent as "true"/"false"        → boolean
 *  - string field sent as number/boolean         → String(...)
 *  - recurses into object properties and array items
 */
export function coerceArgsToSchema(raw: unknown, schema: JsonSchemaNode | undefined): unknown {
  if (!schema) return raw;
  const t = primaryType(schema);

  if (t === 'object' || (!t && schema.properties)) {
    let val: unknown = raw;
    if (typeof val === 'string') {
      const parsed = tryParseJson(val);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) val = parsed;
      else return raw;
    }
    if (val == null || typeof val !== 'object' || Array.isArray(val)) return val;
    const props = schema.properties ?? {};
    const out: Record<string, unknown> = { ...(val as Record<string, unknown>) };
    for (const key of Object.keys(props)) {
      if (key in out) out[key] = coerceArgsToSchema(out[key], props[key]);
    }
    return out;
  }

  if (t === 'array') {
    let val: unknown = raw;
    if (typeof val === 'string') {
      const parsed = tryParseJson(val);
      // Only adopt a parsed value when it's actually an array; otherwise keep the raw
      // string so the wrap-as-single-element step below turns "a.ts" into ["a.ts"].
      if (Array.isArray(parsed)) val = parsed;
    }
    if (!Array.isArray(val)) {
      // A lone scalar where an array was expected — wrap it. This is the single most
      // common local-model array mistake (`"paths": "a.ts"` for a list of paths).
      if (val == null) return val;
      val = [val];
    }
    const items = schema.items;
    return (val as unknown[]).map(v => coerceArgsToSchema(v, items));
  }

  if (t === 'number' || t === 'integer') {
    if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) {
      const n = Number(raw);
      return t === 'integer' ? Math.trunc(n) : n;
    }
    return raw;
  }

  if (t === 'boolean') {
    if (raw === 'true' || raw === 'True' || raw === '1') return true;
    if (raw === 'false' || raw === 'False' || raw === '0') return false;
    return raw;
  }

  if (t === 'string') {
    if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
    return raw;
  }

  return raw;
}

/**
 * A standard JSON GBNF grammar (llama.cpp / LM Studio).
 *
 * Handing this to the server as `grammar` forces *syntactically valid* JSON for the
 * completion — eliminating the "unterminated string / trailing comma / raw newline"
 * class of tool-arg failures at the source. It does NOT constrain the shape to a
 * specific tool (that's `toolChoiceJsonSchema`), only that the bytes parse as JSON.
 */
export function genericJsonGbnf(): string {
  return [
    'root   ::= object',
    'value  ::= object | array | string | number | ("true" | "false" | "null") ws',
    'object ::= "{" ws ( string ":" ws value ("," ws string ":" ws value)* )? "}" ws',
    'array  ::= "[" ws ( value ("," ws value)* )? "]" ws',
    'string ::= "\\"" ( [^"\\\\] | "\\\\" (["\\\\/bfnrt] | "u" [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F]) )* "\\"" ws',
    'number ::= ("-"? ([0-9] | [1-9] [0-9]*)) ("." [0-9]+)? ([eE] [-+]? [0-9]+)? ws',
    'ws     ::= [ \\t\\n]*',
  ].join('\n');
}

/**
 * Build a JSON Schema that constrains output to EXACTLY ONE tool call envelope:
 *   { "name": <one of the given tool names>, "arguments": <object> }
 *
 * Usable as Ollama `format` or an OpenAI-compatible `response_format.json_schema` when
 * the loop wants to *force* a tool call (e.g. the corrective retry after a refusal).
 * Not used for ordinary turns, where the model must be free to answer in prose.
 */
export function toolChoiceJsonSchema(toolNames: string[]): JsonSchemaNode {
  return {
    type: 'object',
    properties: {
      name: { type: 'string', enum: [...toolNames] },
      arguments: { type: 'object' },
    },
    required: ['name', 'arguments'],
  };
}
