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
  /** USD per million tokens. Omitted when we genuinely don't know the price. */
  inputCostPerMillion?: number;
  outputCostPerMillion?: number;
  /** True for models that are free by construction (local weights). */
  free?: boolean;
}

export interface ResolvedCapability extends ModelCapability {
  /** Where the WINDOW came from — 'live' is authoritative, 'default' means we guessed. */
  source: 'live' | 'catalog' | 'default';
  /** The catalog pattern that matched, when source === 'catalog'. */
  matched?: string;
  /**
   * Where the PRICE came from, tracked separately because it can differ from the window's
   * source (a gateway often advertises its window but not its price, or vice-versa).
   * 'unknown' is the honest answer that keeps a bogus $0.00 out of spend reports.
   */
  pricingSource: 'live' | 'catalog' | 'free' | 'unknown';
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
  { pattern: 'claude-opus-4', cap: { contextWindow: 200_000, maxOutput: 32_000, supportsToolCalls: true, vision: true , inputCostPerMillion: 15, outputCostPerMillion: 75 } },
  { pattern: 'claude-sonnet-4', cap: { contextWindow: 200_000, maxOutput: 64_000, supportsToolCalls: true, vision: true , inputCostPerMillion: 3, outputCostPerMillion: 15 } },
  { pattern: 'claude-haiku-4', cap: { contextWindow: 200_000, maxOutput: 32_000, supportsToolCalls: true, vision: true , inputCostPerMillion: 1, outputCostPerMillion: 5 } },
  { pattern: 'claude-3-5-sonnet', cap: { contextWindow: 200_000, maxOutput: 8_192, supportsToolCalls: true, vision: true , inputCostPerMillion: 3, outputCostPerMillion: 15 } },
  { pattern: 'claude', cap: { contextWindow: 200_000, maxOutput: 8_192, supportsToolCalls: true, vision: true , inputCostPerMillion: 3, outputCostPerMillion: 15 } },

  // ── Moonshot / Kimi — the one that prompted this work. K2 ships a 256k window. ──
  { pattern: 'kimi-k2', cap: { contextWindow: 262_144, maxOutput: 16_384, supportsToolCalls: true , inputCostPerMillion: 0.6, outputCostPerMillion: 2.5 } },
  { pattern: 'kimi', cap: { contextWindow: 262_144, maxOutput: 16_384, supportsToolCalls: true , inputCostPerMillion: 0.6, outputCostPerMillion: 2.5 } },
  { pattern: 'moonshot', cap: { contextWindow: 262_144, maxOutput: 16_384, supportsToolCalls: true , inputCostPerMillion: 0.6, outputCostPerMillion: 2.5 } },

  // ── Qwen — the coder line is long-context; plain qwen3 varies by size. ──
  { pattern: 'qwen3-coder', cap: { contextWindow: 262_144, maxOutput: 16_384, supportsToolCalls: true } },
  { pattern: 'qwen3', cap: { contextWindow: 131_072, maxOutput: 16_384, supportsToolCalls: true } },
  { pattern: 'qwen2.5-coder', cap: { contextWindow: 131_072, maxOutput: 8_192, supportsToolCalls: true } },
  { pattern: 'qwen2.5', cap: { contextWindow: 131_072, maxOutput: 8_192, supportsToolCalls: true } },
  { pattern: 'qwen', cap: { contextWindow: 32_768, maxOutput: 8_192, supportsToolCalls: true } },

  // ── OpenAI ──
  { pattern: 'gpt-4.1', cap: { contextWindow: 1_047_576, maxOutput: 32_768, supportsToolCalls: true, vision: true , inputCostPerMillion: 2, outputCostPerMillion: 8 } },
  { pattern: 'gpt-4o-mini', cap: { contextWindow: 128_000, maxOutput: 16_384, supportsToolCalls: true, vision: true , inputCostPerMillion: 0.15, outputCostPerMillion: 0.6 } },
  { pattern: 'gpt-4o', cap: { contextWindow: 128_000, maxOutput: 16_384, supportsToolCalls: true, vision: true , inputCostPerMillion: 2.5, outputCostPerMillion: 10 } },
  { pattern: 'gpt-4-turbo', cap: { contextWindow: 128_000, maxOutput: 4_096, supportsToolCalls: true, vision: true , inputCostPerMillion: 10, outputCostPerMillion: 30 } },
  { pattern: 'o3-mini', cap: { contextWindow: 200_000, maxOutput: 100_000, supportsToolCalls: true , inputCostPerMillion: 1.1, outputCostPerMillion: 4.4 } },
  { pattern: 'o1', cap: { contextWindow: 200_000, maxOutput: 100_000, supportsToolCalls: true , inputCostPerMillion: 15, outputCostPerMillion: 60 } },

  // ── Google — the 1M+ windows the old flat 128k default hurt most. ──
  { pattern: 'gemini-2.5-pro', cap: { contextWindow: 1_048_576, maxOutput: 65_536, supportsToolCalls: true, vision: true , inputCostPerMillion: 1.25, outputCostPerMillion: 10 } },
  { pattern: 'gemini-2.5-flash', cap: { contextWindow: 1_048_576, maxOutput: 65_536, supportsToolCalls: true, vision: true , inputCostPerMillion: 0.3, outputCostPerMillion: 2.5 } },
  { pattern: 'gemini-1.5-pro', cap: { contextWindow: 2_097_152, maxOutput: 8_192, supportsToolCalls: true, vision: true , inputCostPerMillion: 1.25, outputCostPerMillion: 5 } },
  { pattern: 'gemini', cap: { contextWindow: 1_048_576, maxOutput: 8_192, supportsToolCalls: true, vision: true } },

  // ── DeepSeek — v3/r1 are 128k, not the 16k the old guess claimed. ──
  { pattern: 'deepseek-r1', cap: { contextWindow: 131_072, maxOutput: 32_768, supportsToolCalls: true , inputCostPerMillion: 0.55, outputCostPerMillion: 2.19 } },
  { pattern: 'deepseek-v3', cap: { contextWindow: 131_072, maxOutput: 8_192, supportsToolCalls: true , inputCostPerMillion: 0.27, outputCostPerMillion: 1.1 } },
  { pattern: 'deepseek-coder', cap: { contextWindow: 131_072, maxOutput: 8_192, supportsToolCalls: true } },
  { pattern: 'deepseek', cap: { contextWindow: 131_072, maxOutput: 8_192, supportsToolCalls: true , inputCostPerMillion: 0.27, outputCostPerMillion: 1.1 } },

  // ── Other open-weight families commonly served by gateways / locally ──
  { pattern: 'glm-4', cap: { contextWindow: 131_072, maxOutput: 16_384, supportsToolCalls: true } },
  { pattern: 'minimax', cap: { contextWindow: 1_000_000, maxOutput: 16_384, supportsToolCalls: true } },
  { pattern: 'llama-4', cap: { contextWindow: 1_048_576, maxOutput: 16_384, supportsToolCalls: true, vision: true } },
  { pattern: 'llama3.3', cap: { contextWindow: 131_072, maxOutput: 8_192, supportsToolCalls: true } },
  { pattern: 'llama3.2', cap: { contextWindow: 131_072, maxOutput: 8_192, supportsToolCalls: true } },
  { pattern: 'llama3.1', cap: { contextWindow: 131_072, maxOutput: 8_192, supportsToolCalls: true } },
  { pattern: 'llama', cap: { contextWindow: 8_192, maxOutput: 4_096 } },
  { pattern: 'mistral-large', cap: { contextWindow: 131_072, maxOutput: 8_192, supportsToolCalls: true , inputCostPerMillion: 2, outputCostPerMillion: 6 } },
  { pattern: 'mistral', cap: { contextWindow: 32_768, maxOutput: 8_192, supportsToolCalls: true } },
  { pattern: 'devstral', cap: { contextWindow: 131_072, maxOutput: 8_192, supportsToolCalls: true } },
  { pattern: 'codestral', cap: { contextWindow: 262_144, maxOutput: 8_192, supportsToolCalls: true } },
  { pattern: 'gemma3', cap: { contextWindow: 131_072, maxOutput: 8_192, vision: true } },
  { pattern: 'gemma2', cap: { contextWindow: 8_192, maxOutput: 4_096 } },
  { pattern: 'phi-4', cap: { contextWindow: 16_384, maxOutput: 4_096 } },
  { pattern: 'grok', cap: { contextWindow: 131_072, maxOutput: 16_384, supportsToolCalls: true , inputCostPerMillion: 3, outputCostPerMillion: 15 } },
  { pattern: 'command-r', cap: { contextWindow: 131_072, maxOutput: 4_096, supportsToolCalls: true , inputCostPerMillion: 0.15, outputCostPerMillion: 0.6 } },
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
 * Extract advertised PRICING. Gateways quote per-TOKEN (OpenRouter's
 * `pricing: { prompt: "0.0000006", completion: "0.0000025" }`), while we work in USD per
 * MILLION tokens — so values are scaled by 1e6.
 *
 * A quoted 0 is meaningful (free tiers exist) and is preserved as an explicit 0, distinct
 * from "not quoted at all", which returns undefined. PURE.
 */
export function livePricing(entry: any): { input: number; output: number } | undefined {
  const p = entry?.pricing ?? entry?.price ?? entry?.cost;
  if (!p || typeof p !== 'object') return undefined;
  const num = (v: any): number | undefined => {
    const n = typeof v === 'string' ? Number(v) : v;
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const inPerToken = num(p.prompt ?? p.input ?? p.input_tokens ?? p.inputCostPerToken);
  const outPerToken = num(p.completion ?? p.output ?? p.output_tokens ?? p.outputCostPerToken);
  if (inPerToken === undefined && outPerToken === undefined) return undefined;
  // Some providers already quote per-million (values ≥ 0.01 per token would be absurd —
  // $10k per million — so treat those as already-scaled rather than multiplying again).
  const scale = (v: number) => (v > 0 && v < 0.01 ? v * 1_000_000 : v);
  return { input: scale(inPerToken ?? 0), output: scale(outPerToken ?? 0) };
}

/**
 * Resolve a model's capabilities, trusting the provider over our table and our table over a
 * guess. `liveEntry` is the raw object the gateway returned for this model (from /v1/models),
 * when there is one.
 *
 * The returned `source` is the honesty knob: a user can be told "128k (our catalog)" versus
 * "1M (reported by the provider)" instead of a bare number they cannot sanity-check.
 */
export function resolveCapability(
  modelId: string,
  liveEntry?: any,
  opts: { local?: boolean } = {},
): ResolvedCapability {
  const hit = lookupCatalog(modelId);
  const base = hit?.cap ?? UNKNOWN_MODEL_DEFAULT;

  const liveCtx = liveContextWindow(liveEntry);
  const liveOut = liveMaxOutput(liveEntry);
  const livePrice = livePricing(liveEntry);

  // Price resolution is INDEPENDENT of the window's: a gateway commonly advertises one and
  // not the other. 'unknown' is deliberate — reporting $0.00 for a model we cannot price
  // makes spend reports lie and `--budget-usd` silently unenforceable.
  let inputCostPerMillion: number;
  let outputCostPerMillion: number;
  let pricingSource: ResolvedCapability['pricingSource'];
  if (livePrice) {
    inputCostPerMillion = livePrice.input;
    outputCostPerMillion = livePrice.output;
    pricingSource = 'live';
  } else if (opts.local || base.free) {
    inputCostPerMillion = 0;
    outputCostPerMillion = 0;
    pricingSource = 'free'; // local weights genuinely cost nothing per token
  } else if (base.inputCostPerMillion !== undefined) {
    inputCostPerMillion = base.inputCostPerMillion;
    outputCostPerMillion = base.outputCostPerMillion ?? 0;
    pricingSource = 'catalog';
  } else {
    inputCostPerMillion = 0;
    outputCostPerMillion = 0;
    pricingSource = 'unknown'; // the 0 is a placeholder, NOT a claim that it is free
  }

  const priced = { inputCostPerMillion, outputCostPerMillion, pricingSource };

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
      ...priced,
    };
  }
  return {
    ...base,
    ...(liveOut ? { maxOutput: liveOut } : {}),
    source: hit ? 'catalog' : 'default',
    matched: hit?.matched,
    ...priced,
  };
}

/** Every pattern in the catalog — for `qodex models` output and tests. PURE. */
export function catalogPatterns(): string[] {
  return CATALOG.map(e => e.pattern);
}
