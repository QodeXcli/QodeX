import type { ModelInfo } from '../types.js';

/**
 * Pure config logic for user-defined OpenAI-compatible providers
 * (providers.custom[] in config.yaml). No 'openai' import, no network here, so
 * this is unit-testable without node_modules. The CustomOpenAIProvider class in
 * custom.ts consumes these helpers.
 *
 * Goal: let a user point QodeX at ANY OpenAI-compatible gateway (Groq, Gemini's
 * compat layer, GitHub Models, Mistral, OpenRouter, a self-host, ...) by adding
 * a config block with a name + apiKeyEnv + baseUrl — and optionally a model list.
 * If models are omitted, the provider discovers them from GET {baseUrl}/models.
 */

/** Provider names QodeX ships natively — a custom block may not shadow these. */
export const RESERVED_PROVIDER_NAMES = new Set(['ollama', 'anthropic', 'openai', 'deepseek']);

/** Raw shape as it appears in config.yaml (everything possibly missing/wrong-typed). */
export interface RawCustomProvider {
  name?: unknown;
  apiKeyEnv?: unknown;
  baseUrl?: unknown;
  models?: unknown;
  defaultHeaders?: unknown;
  samplingOptions?: unknown;
  systemPromptAppend?: unknown;
  systemPromptOverride?: unknown;
}

/** Validated, ready-to-instantiate shape. `models: null` means "auto-discover". */
export interface NormalizedCustomProvider {
  name: string;
  apiKeyEnv: string;
  baseUrl: string;
  models: ModelInfo[] | null;
  defaultHeaders?: Record<string, string>;
  samplingOptions?: Record<string, number>;
  /** Extra provider-specific guidance APPENDED to the full system prompt (safe). */
  systemPromptAppend?: string;
  /** Full replacement of the system-prompt BODY (power-user; identity + tool list
   *  are still re-stated around it so small models keep awareness). */
  systemPromptOverride?: string;
}

/** Defaults applied to a model entry when the user omits the numeric/cap fields. */
export function fillModelDefaults(raw: any): ModelInfo | null {
  const id = typeof raw?.id === 'string' ? raw.id.trim() : '';
  if (!id) return null;
  return {
    id,
    contextWindow: Number.isFinite(raw?.contextWindow) ? raw.contextWindow : 128000,
    maxOutput: Number.isFinite(raw?.maxOutput) ? raw.maxOutput : 8192,
    inputCostPerMillion: Number.isFinite(raw?.inputCostPerMillion) ? raw.inputCostPerMillion : 0,
    outputCostPerMillion: Number.isFinite(raw?.outputCostPerMillion) ? raw.outputCostPerMillion : 0,
    supportsToolCalls: raw?.supportsToolCalls !== false,   // default true
    supportsStreaming: raw?.supportsStreaming !== false,   // default true
  };
}

export type ValidationResult =
  | { ok: true; value: NormalizedCustomProvider }
  | { ok: false; error: string };

/**
 * Validate + normalize ONE raw custom-provider entry. Fail-soft by design: the
 * router skips invalid entries with this error rather than crashing the whole CLI.
 */
export function validateCustomProvider(raw: RawCustomProvider, index: number): ValidationResult {
  const where = `providers.custom[${index}]`;

  const name = typeof raw?.name === 'string' ? raw.name.trim() : '';
  if (!name) return { ok: false, error: `${where}: missing "name"` };
  if (/[\s/]/.test(name)) {
    return { ok: false, error: `${where}: name "${name}" must not contain spaces or "/"` };
  }
  if (RESERVED_PROVIDER_NAMES.has(name)) {
    return { ok: false, error: `${where}: "${name}" is a built-in provider name — pick another (e.g. "${name}2")` };
  }

  const apiKeyEnv = typeof raw?.apiKeyEnv === 'string' ? raw.apiKeyEnv.trim() : '';
  if (!apiKeyEnv) return { ok: false, error: `${where} ("${name}"): missing "apiKeyEnv"` };

  const baseUrl = typeof raw?.baseUrl === 'string' ? raw.baseUrl.trim() : '';
  if (!/^https?:\/\//i.test(baseUrl)) {
    return { ok: false, error: `${where} ("${name}"): "baseUrl" must start with http:// or https://` };
  }

  // models: optional. Present → must yield at least one valid entry. Absent → discover.
  let models: ModelInfo[] | null = null;
  if (raw.models !== undefined) {
    if (!Array.isArray(raw.models)) {
      return { ok: false, error: `${where} ("${name}"): "models" must be a list` };
    }
    const filled = raw.models.map(fillModelDefaults).filter((m): m is ModelInfo => m !== null);
    if (filled.length === 0) {
      return { ok: false, error: `${where} ("${name}"): "models" is present but no entry has a valid "id"` };
    }
    models = filled;
  }

  const out: NormalizedCustomProvider = { name, apiKeyEnv, baseUrl, models };
  if (raw.defaultHeaders && typeof raw.defaultHeaders === 'object') {
    out.defaultHeaders = raw.defaultHeaders as Record<string, string>;
  }
  if (raw.samplingOptions && typeof raw.samplingOptions === 'object') {
    out.samplingOptions = raw.samplingOptions as Record<string, number>;
  }
  // Optional per-provider prompt steering. Non-empty strings only; ignore junk
  // (fail-soft — a malformed prompt field shouldn't disable the whole provider).
  if (typeof raw.systemPromptAppend === 'string' && raw.systemPromptAppend.trim()) {
    out.systemPromptAppend = raw.systemPromptAppend.trim();
  }
  if (typeof raw.systemPromptOverride === 'string' && raw.systemPromptOverride.trim()) {
    out.systemPromptOverride = raw.systemPromptOverride.trim();
  }
  return { ok: true, value: out };
}

/**
 * Look up the prompt-steering config for the provider currently serving a request.
 * Reads the RAW config list (loop.ts has raw config, not the router-normalized form)
 * and returns just the trimmed append/override strings, or null when the provider
 * isn't a custom one or has no prompt steering. Pure; no throw.
 */
export function findCustomProviderPromptConfig(
  rawList: unknown,
  providerName: string | undefined,
): { append?: string; override?: string } | null {
  if (!providerName || !Array.isArray(rawList)) return null;
  for (const raw of rawList) {
    const name = typeof raw?.name === 'string' ? raw.name.trim() : '';
    if (name !== providerName) continue;
    const append = typeof raw?.systemPromptAppend === 'string' && raw.systemPromptAppend.trim()
      ? raw.systemPromptAppend.trim() : undefined;
    const override = typeof raw?.systemPromptOverride === 'string' && raw.systemPromptOverride.trim()
      ? raw.systemPromptOverride.trim() : undefined;
    if (!append && !override) return null;
    return { append, override };
  }
  return null;
}

/**
 * Validate a whole custom[] list, deduping by name (first wins). Returns the
 * accepted providers and a list of human-readable errors for the skipped ones.
 */
export function validateCustomProviders(
  rawList: unknown,
): { providers: NormalizedCustomProvider[]; errors: string[] } {
  if (rawList === undefined) return { providers: [], errors: [] };
  if (!Array.isArray(rawList)) {
    return { providers: [], errors: ['providers.custom must be a list'] };
  }
  const providers: NormalizedCustomProvider[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  rawList.forEach((raw, i) => {
    const res = validateCustomProvider(raw as RawCustomProvider, i);
    if (!res.ok) { errors.push(res.error); return; }
    if (seen.has(res.value.name)) {
      errors.push(`providers.custom[${i}]: duplicate name "${res.value.name}" — ignoring the second one`);
      return;
    }
    seen.add(res.value.name);
    providers.push(res.value);
  });
  return { providers, errors };
}

/**
 * Map an OpenAI-style `GET /models` response body into ModelInfo[] with default
 * caps (the endpoint returns ids, not context windows). Tolerates the common
 * shapes: { data: [{id}] } (OpenAI), or a bare [{id}] array. Returns [] on junk.
 */
export function mapDiscoveredModels(body: any): ModelInfo[] {
  const arr = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
  const out: ModelInfo[] = [];
  for (const entry of arr) {
    const id = typeof entry?.id === 'string' ? entry.id : (typeof entry === 'string' ? entry : '');
    const m = fillModelDefaults({ id });
    if (m) out.push(m);
  }
  return out;
}

/** Normalize baseUrl + "/models" without doubling slashes. */
export function modelsEndpoint(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '') + '/models';
}
