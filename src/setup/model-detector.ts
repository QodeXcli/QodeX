/**
 * Live detection of locally-installed models.
 *
 * Probes three sources at wizard time:
 *
 *   1. Ollama  — `GET http://localhost:11434/api/tags`. Lists everything pulled
 *      via `ollama pull`. Available iff the daemon is running.
 *
 *   2. LM Studio / llama.cpp — `GET http://127.0.0.1:1234/v1/models` (and a few
 *      other common ports). Lists whatever model is currently LOADED into the
 *      server. May be a single model at a time (LM Studio default), so we treat
 *      this as a sample of "available right now", not the user's full library.
 *
 *   3. (planned) — direct filesystem scan of ~/.lmstudio/models/, ~/.cache/lm-studio/
 *      to find models that are downloaded but not loaded. Skipped for v0.5.9
 *      because parsing the LM Studio model directory structure across versions
 *      is fragile; the curl probe covers the practical case.
 *
 * Returns a stable shape with provider, id, displayName, and size metadata where
 * available. Failures are silent (return empty list for that source) — we don't
 * want a wizard to break because a backend is down.
 *
 * All probes are bounded by a short timeout so the wizard never hangs waiting
 * for an unreachable server.
 */

import { logger } from '../utils/logger.js';

export interface DetectedModel {
  /** What QodeX provider serves this model (`ollama` / `openai` / `anthropic` / `deepseek`). */
  provider: 'ollama' | 'openai';
  /** The exact model id to put into config (must match what the provider expects). */
  id: string;
  /** Human-readable label for the wizard list. */
  label: string;
  /** Where we found it. Used for hints in the UI. */
  source: 'ollama' | 'lm-studio';
  /** Approximate size in GB if known. */
  sizeGb?: number;
  /** Approximate parameter count in billions if parseable from the id. */
  paramsB?: number;
  /** Does the model self-report tool-call support? Best-effort; not always reliable. */
  toolCallsLikely?: boolean;
  /**
   * Real context window in tokens. Sourced from LM Studio's native API
   * (`/api/v0/models` → max_context_length) when available, else a family/size
   * heuristic. This is what fixed the "everything clamped to 32768" bug: the
   * wizard now writes THIS instead of a hardcoded value.
   */
  contextWindow?: number;
  /** Heuristic: does this model accept image input (multimodal)? */
  visionLikely?: boolean;
}

const PROBE_TIMEOUT_MS = 1500;

/**
 * Fetch with timeout helper. We don't want a wizard step to hang for 30s on a
 * stuck socket, so every probe gets a hard budget.
 */
async function fetchWithTimeout(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: controller.signal });
    return r;
  } catch (e: any) {
    logger.debug(`probe failed: ${url}`, { err: e?.message ?? String(e) });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Probe Ollama daemon for installed models. */
export async function detectOllamaModels(baseUrl = 'http://localhost:11434'): Promise<DetectedModel[]> {
  const r = await fetchWithTimeout(`${baseUrl}/api/tags`);
  if (!r || !r.ok) return [];
  try {
    const body = await r.json() as { models?: Array<{ name: string; size?: number; details?: any }> };
    if (!Array.isArray(body.models)) return [];
    return body.models.map(m => {
      const sizeGb = m.size ? m.size / (1024 ** 3) : undefined;
      const paramsB = parseParamsFromId(m.name);
      return {
        provider: 'ollama' as const,
        id: m.name,
        label: m.name,
        source: 'ollama' as const,
        sizeGb: sizeGb ? Math.round(sizeGb * 10) / 10 : undefined,
        paramsB,
        // Ollama models support structured tool_calls IFF they were trained for it.
        // Best-effort heuristic: Qwen 2.5+, Llama 3.1+, DeepSeek-V3/R1, Mistral support it natively.
        // We err toward 'true' for known coder/instruct families since QodeX's recovery layer catches the rest.
        toolCallsLikely: looksLikeToolCallCapable(m.name),
      };
    });
  } catch (e: any) {
    logger.debug('Ollama response parse failed', { err: e?.message });
    return [];
  }
}

/**
 * Probe LM Studio / llama.cpp server on common ports.
 * 1234 is LM Studio default; 8080 is llama.cpp default; 11435 is a common Ollama-clone port.
 */
export async function detectLMStudioModels(): Promise<DetectedModel[]> {
  const ports = [1234, 8080];
  const all: DetectedModel[] = [];
  const seen = new Set<string>();
  // Pull real context windows from LM Studio's native API up-front (one probe).
  const ctxMap = await detectLmStudioContextWindows(ports);
  for (const port of ports) {
    const r = await fetchWithTimeout(`http://127.0.0.1:${port}/v1/models`);
    if (!r || !r.ok) continue;
    try {
      const body = await r.json() as { data?: Array<{ id: string; meta?: any }> };
      if (!Array.isArray(body.data)) continue;
      for (const m of body.data) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        // Skip embedding-only models — they can't drive a chat agent.
        if (/embed/i.test(m.id)) continue;
        const paramsB = parseParamsFromId(m.id) ?? (m.meta?.n_params ? m.meta.n_params / 1e9 : undefined);
        const sizeGb = m.meta?.size ? m.meta.size / (1024 ** 3) : undefined;
        all.push({
          provider: 'openai',
          id: m.id,
          label: m.id,
          source: 'lm-studio',
          sizeGb: sizeGb ? Math.round(sizeGb * 10) / 10 : undefined,
          paramsB: paramsB ? Math.round(paramsB) : undefined,
          // LM Studio surfaces an OpenAI-compatible API; whether the model honours
          // structured tool_calls depends on the model itself. Same heuristic.
          toolCallsLikely: looksLikeToolCallCapable(m.id),
          // Real window from the native API, else a RAM-safe family heuristic.
          contextWindow: ctxMap[m.id] ?? guessContextWindow(m.id),
          visionLikely: looksVisionCapable(m.id),
        });
      }
    } catch (e: any) {
      logger.debug(`LM Studio response parse failed on port ${port}`, { err: e?.message });
    }
  }
  return all;
}

/** Run all detectors in parallel; combine + sort results. */
export async function detectAllLocalModels(): Promise<DetectedModel[]> {
  const [ollama, lmStudio] = await Promise.all([
    detectOllamaModels(),
    detectLMStudioModels(),
  ]);
  // Sort: native-tool-calling first, then larger models first within each tier.
  // This is what humans actually want: "show me my best option first".
  const all = [...ollama, ...lmStudio];
  all.sort((a, b) => {
    const aTC = a.toolCallsLikely ? 1 : 0;
    const bTC = b.toolCallsLikely ? 1 : 0;
    if (aTC !== bTC) return bTC - aTC;
    return (b.paramsB ?? 0) - (a.paramsB ?? 0);
  });
  return all;
}

/** Try to extract parameter count in billions from a model id. */
function parseParamsFromId(id: string): number | undefined {
  // Patterns: ":32b", "-32b", "70B", "8x22b", ":3b", "qwen3-coder:30b"
  const colonOrDash = id.match(/[:\-](\d+(?:\.\d+)?)b\b/i);
  if (colonOrDash) return parseFloat(colonOrDash[1]!);
  const xMatch = id.match(/(\d+)x(\d+)b/i);
  if (xMatch) {
    // MoE: experts × size, with rough "active params" heuristic of 30% for routing
    return parseInt(xMatch[1]!, 10) * parseInt(xMatch[2]!, 10);
  }
  // Some HF-style ids embed the size in name: "Qwen3-Coder-30B-Instruct"
  const bareMatch = id.match(/(\d+(?:\.\d+)?)[bB]\b/);
  if (bareMatch) return parseFloat(bareMatch[1]!);
  return undefined;
}

/** Heuristic: does this model id look like it has native tool-call training? */
function looksLikeToolCallCapable(id: string): boolean {
  const lower = id.toLowerCase();
  // Known native-tool-calling families
  if (/qwen3/.test(lower)) return true;       // Qwen3 family — strong native support
  if (/qwen2\.5/.test(lower)) return true;    // Qwen 2.5 — works via recovery layer
  if (/gemma-?4/.test(lower)) return true;    // Gemma 4 — native function-calling + system role
  if (/gemma-?3/.test(lower)) return true;    // Gemma 3 — function-calling support
  if (/llama-?4/.test(lower)) return true;    // Llama 4 family
  if (/llama-?3\.[12]/.test(lower)) return true;
  if (/llama-?3-/.test(lower)) return true;
  if (/mistral/.test(lower) && !/codestral/.test(lower)) return true;
  if (/mixtral/.test(lower)) return true;
  if (/deepseek-v3/.test(lower)) return true;
  if (/deepseek-r1/.test(lower)) return true;
  if (/nemotron/.test(lower)) return true;    // NVIDIA Nemotron — agentic/tool-first
  // Codestral has tool calling on newer versions
  if (/codestral/.test(lower)) return true;
  // DeepSeek-V2 / Coder-V2 use a non-standard format — flag as NOT native
  if (/deepseek-coder-v2/.test(lower)) return false;
  if (/deepseek-v2/.test(lower)) return false;
  // Default unknown → false (be conservative, the model may need recovery layer)
  return false;
}

/**
 * Heuristic: does the model id look multimodal (accepts images)? Used so the
 * vision tool can prefer the PRIMARY model when it can already see — instead of
 * always spinning up a separate vision sub-agent.
 */
export function looksVisionCapable(id: string): boolean {
  const lower = id.toLowerCase();
  if (/gemma-?4/.test(lower)) return true;            // Gemma 4 — multimodal (incl. 31B)
  // "vl" not surrounded by other letters: qwen2.5vl, qwen3-vl, qwen3vl, ...-vl-32b
  if (/(^|[^a-z])vl([^a-z]|$)/.test(lower)) return true;
  if (/vision/.test(lower)) return true;              // llama3.2-vision, etc.
  if (/llava|minicpm-?v|pixtral|moondream|internvl|cogvlm/.test(lower)) return true;
  // Cloud multimodal: GPT-4o family, Gemini, and every modern Claude (3.x AND 4.x —
  // sonnet/opus/haiku are all image-capable; the old `claude-3`-only test missed claude-4).
  if (/gpt-?4o|gemini/.test(lower)) return true;
  if (/claude-(3|4|5|sonnet|opus|haiku)/.test(lower)) return true;
  return false;
}

/**
 * Family/size heuristic for context window when the live API doesn't report one.
 * RAM-safe defaults — deliberately conservative (a too-large window risks OOM on
 * load; the user can always raise it). The live LM Studio value, when present,
 * overrides this.
 */
export function guessContextWindow(id: string): number {
  const lower = id.toLowerCase();
  if (/gemma-?4/.test(lower)) return 131072;          // supports 256k; 128k is RAM-safe
  if (/qwen3-coder|coder-next/.test(lower)) return 131072; // supports 256k
  if (/qwen3-235b|qwen3.*235/.test(lower)) return 131072;  // supports 256k
  if (/qwen3/.test(lower)) return 65536;
  if (/nemotron/.test(lower)) return 131072;          // supports 1M; 128k is RAM-safe
  if (/llama-?4/.test(lower)) return 131072;
  if (/qwen2\.5/.test(lower)) return 32768;
  if (/llama-?3\.[12]/.test(lower)) return 131072;
  return 32768;                                       // safe fallback
}

/**
 * Query LM Studio's NATIVE REST API (`/api/v0/models`) for the real per-model
 * context window. The OpenAI-compat `/v1/models` endpoint does NOT include this,
 * which is why the wizard used to fall back to a hardcoded 32768. Returns a map
 * of model id → max_context_length. Best-effort: returns {} if the endpoint
 * isn't reachable (older LM Studio, llama.cpp, etc.).
 */
export async function detectLmStudioContextWindows(
  ports: number[] = [1234, 8080],
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const port of ports) {
    const r = await fetchWithTimeout(`http://127.0.0.1:${port}/api/v0/models`);
    if (!r || !r.ok) continue;
    try {
      const body = await r.json() as {
        data?: Array<{ id: string; max_context_length?: number; loaded_context_length?: number }>;
      };
      if (!Array.isArray(body.data)) continue;
      for (const m of body.data) {
        // Prefer the loaded window (what's actually usable right now); fall back
        // to the model's max. Either is vastly better than a hardcoded 32768.
        const ctx = m.loaded_context_length || m.max_context_length;
        if (m.id && typeof ctx === 'number' && ctx > 0) out[m.id] = ctx;
      }
    } catch {
      /* ignore parse errors — heuristic will cover it */
    }
  }
  return out;
}

/**
 * Recommend a primary model from the detected list.
 * Returns the best candidate for "the model that does the actual work" — preferring:
 *   1. Native tool calling
 *   2. Bigger param count (more capability)
 *   3. MLX-served (LM Studio) over GGUF (Ollama) for Apple Silicon speed
 */
export function recommendPrimary(models: DetectedModel[]): DetectedModel | undefined {
  if (models.length === 0) return undefined;
  // Already sorted by (toolCalls, paramsB) — tie-break with MLX preference.
  const sorted = [...models].sort((a, b) => {
    const aTC = a.toolCallsLikely ? 1 : 0;
    const bTC = b.toolCallsLikely ? 1 : 0;
    if (aTC !== bTC) return bTC - aTC;
    const aParams = a.paramsB ?? 0;
    const bParams = b.paramsB ?? 0;
    if (aParams !== bParams) return bParams - aParams;
    // Same size + same tool-call status → prefer LM Studio (MLX is faster on M-series)
    if (a.source !== b.source) return a.source === 'lm-studio' ? -1 : 1;
    return 0;
  });
  return sorted[0];
}

/**
 * Recommend a sub-agent from the detected list, given the chosen parent.
 * Heuristic:
 *   - Prefer a DIFFERENT runtime than parent (so real parallel is possible)
 *   - Prefer tool-call capable
 *   - Prefer something a bit smaller than parent (faster spin-up, lighter load)
 */
export function recommendSubagent(models: DetectedModel[], parent: DetectedModel): DetectedModel | undefined {
  const candidates = models.filter(m => m.id !== parent.id);
  if (candidates.length === 0) return undefined;
  const parentParams = parent.paramsB ?? 0;
  const sorted = [...candidates].sort((a, b) => {
    // Different runtime = real parallel
    const aDiff = a.source !== parent.source ? 1 : 0;
    const bDiff = b.source !== parent.source ? 1 : 0;
    if (aDiff !== bDiff) return bDiff - aDiff;
    // Tool calling
    const aTC = a.toolCallsLikely ? 1 : 0;
    const bTC = b.toolCallsLikely ? 1 : 0;
    if (aTC !== bTC) return bTC - aTC;
    // Closer to (parent - 30%) is ideal — "a bit smaller"
    const target = parentParams * 0.7;
    const aDist = Math.abs((a.paramsB ?? 0) - target);
    const bDist = Math.abs((b.paramsB ?? 0) - target);
    return aDist - bDist;
  });
  return sorted[0];
}

/** Pretty-format a detected model for display in the wizard list. */
export function formatModel(m: DetectedModel): { label: string; hint: string } {
  const parts: string[] = [];
  if (m.source === 'lm-studio') parts.push('LM Studio');
  else parts.push('Ollama');
  if (m.paramsB) parts.push(`~${m.paramsB}B params`);
  if (m.sizeGb) parts.push(`${m.sizeGb} GB`);
  if (m.toolCallsLikely) parts.push('✓ tool-calls');
  return {
    label: m.label,
    hint: parts.join(' · '),
  };
}
