/**
 * Model capability catalog — what we know about a model when the provider won't tell us.
 *
 * Two things were wrong before this existed:
 *   1. `mapDiscoveredModels` asked the gateway for its model list and then threw away every
 *      field except `id`, so a provider that DID advertise a 1M-token window was recorded as
 *      128k (the flat fallback in `fillModelDefaults`). Users with big-context models were
 *      silently capped at a fraction of what they were paying for.
 *   2. The per-provider name guesses went stale — `qwen3-coder` was mapped to 32k when it
 *      ships 256k, `deepseek` to 16k when v3 is 128k.
 *
 * So capability resolution is now ordered by trust:
 *   LIVE metadata from the provider  →  this catalog (by name)  →  a conservative default,
 * and the result says which of those it came from, so a wrong number is diagnosable instead
 * of mysterious.
 *
 * Keeping this in ONE data table also means adding a new model (Kimi, GLM, MiniMax…) is a
 * data edit, not a code change in three provider files.
 */

export interface ModelCapability {
  /** Total context window in tokens. */
  contextWindow: number;
  /** Max output tokens per response. */
  maxOutput: number;
  supportsToolCalls?: boolean;
  /** Model can read images. */
  vision?: boolean;
}

export interface ResolvedCapability extends ModelCapability {
  /** Where the numbers came from — 'live' is authoritative, 'default' means we guessed. */
  source: 'live' | 'catalog' | 'default';
  /** The catalog pattern that matched, when source === 'catalog'. */
  matched?: string;
}

/**
 * Known model families, matched against a lowercased model id by SUBSTRING.
 *
 * Order matters: the FIRST match wins, so more specific patterns must come first
 * (`qwen3-coder` before `qwen`, `gpt-4o-mini` before `gpt-4o`). The tests assert this
 * ordering property directly, because getting it wrong is silent and easy.
 */
const CATALOG: { pattern: string; cap: ModelCapability }[] = [
  // ── Anthropic ──
  { pattern: 'claude-opus-4', cap: { contextWindow: 200_000, maxOutput: 32_000, supportsToolCalls: true, vision: true } },
  { pattern: 'claude-sonnet-4', cap: { contextWindow: 200_000, maxOutput: 64_000, supportsToolCalls: true, vision: true } },
  { pattern: 'claude-haiku-4', cap: { contextWindow: 200_000, maxOutput: 32_000, supportsToolCalls: true, vision: true } },
  { pattern: 'claude-3-5-sonnet', cap: { contextWindow: 200_000, maxOutput: 8_192, supportsToolCalls: true, vision: true } },
  { pattern: 'claude', cap: { contextWindow: 200_000, maxOutput: 8_192, supportsToolCalls: true, vision: true } },

  // ── Moonshot / Kimi — the one that prompted this work. K2 ships a 256k window. ──
  { pattern: 'kimi-k2', cap: { contextWindow: 262_144, maxOutput: 16_384, supportsToolCalls: true } },
  { pattern: 'kimi', cap: { contextWindow: 262_144, maxOutput: 16_384, supportsToolCalls: true } },
  { pattern: 'moonshot', cap: { contextWindow: 262_144, maxOutput: 16_384, supportsToolCalls: true } },

  // ── Qwen — the coder line is long-context; plain qwen3 varies by size. ──
  { pattern: 'qwen3-coder', cap: { contextWindow: 262_144, maxOutput: 16_384, supportsToolCalls: true } },
  { pattern: 'qwen3', cap: { contextWindow: 131_072, maxOutput: 16_384, supportsToolCalls: true } },
  { pattern: 'qwen2.5-coder', cap: { contextWindow: 131_072, maxOutput: 8_192, supportsToolCalls: true } },
  { pattern: 'qwen2.5', cap: { contextWindow: 131_072, maxOutput: 8_192, supportsToolCalls: true } },
  { pattern: 'qwen', cap: { contextWindow: 32_768, maxOutput: 8_192, supportsToolCalls: true } },

  // ── OpenAI ──
  { pattern: 'gpt-4.1', cap: { contextWindow: 1_047_576, maxOutput: 32_768, supportsToolCalls: true, vision: true } },
  { pattern: 'gpt-4o-mini', cap: { contextWindow: 128_000, maxOutput: 16_384, supportsToolCalls: true, vision: true } },
  { pattern: 'gpt-4o', cap: { contextWindow: 128_000, maxOutput: 16_384, supportsToolCalls: true, vision: true } },
  { pattern: 'gpt-4-turbo', cap: { contextWindow: 128_000, maxOutput: 4_096, supportsToolCalls: true, vision: true } },
  { pattern: 'o3-mini', cap: { contextWindow: 200_000, maxOutput: 100_000, supportsToolCalls: true } },
  { pattern: 'o1', cap: { contextWindow: 200_000, maxOutput: 100_000, supportsToolCalls: true } },

  // ── Google — the 1M+ windows the old flat 128k default hurt most. ──
  { pattern: 'gemini-2.5-pro', cap: { contextWindow: 1_048_576, maxOutput: 65_536, supportsToolCalls: true, vision: true } },
  { pattern: 'gemini-2.5-flash', cap: { contextWindow: 1_048_576, maxOutput: 65_536, supportsToolCalls: true, vision: true } },
  { pattern: 'gemini-1.5-pro', cap: { contextWindow: 2_097_152, maxOutput: 8_192, supportsToolCalls: true, vision: true } },
  { pattern: 'gemini', cap: { contextWindow: 1_048_576, maxOutput: 8_192, supportsToolCalls: true, vision: true } },

  // ── DeepSeek — v3/r1 are 128k, not the 16k the old guess claimed. ──
  { pattern: 'deepseek-r1', cap: { contextWindow: 131_072, maxOutput: 32_768, supportsToolCalls: true } },
  { pattern: 'deepseek-v3', cap: { contextWindow: 131_072, maxOutput: 8_192, supportsToolCalls: true } },
  { pattern: 'deepseek-coder', cap: { contextWindow: 131_072, maxOutput: 8_192, supportsToolCalls: true } },
  { pattern: 'deepseek', cap: { contextWindow: 131_072, maxOutput: 8_192, supportsToolCalls: true } },

  // ── Other open-weight families commonly served by gateways / locally ──
  { pattern: 'glm-4', cap: { contextWindow: 131_072, maxOutput: 16_384, supportsToolCalls: true } },
  { pattern: 'minimax', cap: { contextWindow: 1_000_000, maxOutput: 16_384, supportsToolCalls: true } },
  { pattern: 'llama-4', cap: { contextWindow: 1_048_576, maxOutput: 16_384, supportsToolCalls: true, vision: true } },
  { pattern: 'llama3.3', cap: { contextWindow: 131_072, maxOutput: 8_192, supportsToolCalls: true } },
  { pattern: 'llama3.2', cap: { contextWindow: 131_072, maxOutput: 8_192, supportsToolCalls: true } },
  { pattern: 'llama3.1', cap: { contextWindow: 131_072, maxOutput: 8_192, supportsToolCalls: true } },
  { pattern: 'llama', cap: { contextWindow: 8_192, maxOutput: 4_096 } },
  { pattern: 'mistral-large', cap: { contextWindow: 131_072, maxOutput: 8_192, supportsToolCalls: true } },
  { pattern: 'mistral', cap: { contextWindow: 32_768, maxOutput: 8_192, supportsToolCalls: true } },
  { pattern: 'devstral', cap: { contextWindow: 131_072, maxOutput: 8_192, supportsToolCalls: true } },
  { pattern: 'codestral', cap: { contextWindow: 262_144, maxOutput: 8_192, supportsToolCalls: true } },
  { pattern: 'gemma3', cap: { contextWindow: 131_072, maxOutput: 8_192, vision: true } },
  { pattern: 'gemma2', cap: { contextWindow: 8_192, maxOutput: 4_096 } },
  { pattern: 'phi-4', cap: { contextWindow: 16_384, maxOutput: 4_096 } },
  { pattern: 'grok', cap: { contextWindow: 131_072, maxOutput: 16_384, supportsToolCalls: true } },
  { pattern: 'command-r', cap: { contextWindow: 131_072, maxOutput: 4_096, supportsToolCalls: true } },
];

/**
 * Conservative fallback for a model nobody recognises. 32k rather than the old 128k: an
 * OVER-estimate is the dangerous direction — the agent packs a context the model then
 * truncates server-side, and the failure looks like the model "forgetting" mid-task.
 * Under-estimating only costs a little headroom, and live metadata overrides it anyway.
 */
export const UNKNOWN_MODEL_DEFAULT: ModelCapability = {
  contextWindow: 32_768,
  maxOutput: 8_192,
  supportsToolCalls: true,
};

/** Look a model up by name. Returns null when nothing matches. PURE. */
export function lookupCatalog(modelId: string): { cap: ModelCapability; matched: string } | null {
  const id = (modelId ?? '').toLowerCase();
  if (!id) return null;
  for (const entry of CATALOG) {
    if (id.includes(entry.pattern)) return { cap: entry.cap, matched: entry.pattern };
  }
  return null;
}

/**
 * Field names providers use to advertise a context window, in the order we trust them.
 * Different gateways spell this differently and there is no standard: OpenRouter uses
 * `context_length`, LM Studio `max_context_length`, others `context_window`.
 */
const LIVE_CONTEXT_FIELDS = [
  'context_length', 'context_window', 'max_context_length', 'max_context_window',
  'max_input_tokens', 'contextWindow', 'context_size', 'n_ctx',
];
const LIVE_OUTPUT_FIELDS = [
  'max_output_tokens', 'max_completion_tokens', 'max_tokens', 'maxOutput',
];

function firstPositiveNumber(obj: any, fields: readonly string[]): number | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const f of fields) {
    const v = obj[f];
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  // Some gateways nest the numbers (e.g. OpenRouter's `top_provider`).
  for (const nested of ['top_provider', 'capabilities', 'limits', 'meta']) {
    const found = firstPositiveNumber(obj[nested], fields);
    if (found) return found;
  }
  return undefined;
}

/** Extract a context window a provider actually advertised. PURE. Returns undefined if none. */
export function liveContextWindow(entry: any): number | undefined {
  return firstPositiveNumber(entry, LIVE_CONTEXT_FIELDS);
}

/** Extract an advertised max-output. PURE. */
export function liveMaxOutput(entry: any): number | undefined {
  return firstPositiveNumber(entry, LIVE_OUTPUT_FIELDS);
}

/**
 * Resolve a model's capabilities, trusting the provider over our table and our table over a
 * guess. `liveEntry` is the raw object the gateway returned for this model (from /v1/models),
 * when there is one.
 *
 * The returned `source` is the honesty knob: a user can be told "128k (our catalog)" versus
 * "1M (reported by the provider)" instead of a bare number they cannot sanity-check.
 */
export function resolveCapability(modelId: string, liveEntry?: any): ResolvedCapability {
  const hit = lookupCatalog(modelId);
  const base = hit?.cap ?? UNKNOWN_MODEL_DEFAULT;

  const liveCtx = liveContextWindow(liveEntry);
  const liveOut = liveMaxOutput(liveEntry);

  if (liveCtx) {
    return {
      contextWindow: liveCtx,
      // A provider that states the window but not the output cap still tells us more than
      // nothing — keep the catalog's output figure, clamped so it can't exceed the window.
      maxOutput: Math.min(liveOut ?? base.maxOutput, liveCtx),
      supportsToolCalls: base.supportsToolCalls,
      vision: base.vision,
      source: 'live',
      matched: hit?.matched,
    };
  }
  return {
    ...base,
    ...(liveOut ? { maxOutput: liveOut } : {}),
    source: hit ? 'catalog' : 'default',
    matched: hit?.matched,
  };
}

/** Every pattern in the catalog — for `qodex models` output and tests. PURE. */
export function catalogPatterns(): string[] {
  return CATALOG.map(e => e.pattern);
}
