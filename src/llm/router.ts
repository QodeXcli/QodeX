/*
 * QodeX — Local-first agentic coding CLI
 * Copyright 2026 7 SEVEN
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { Provider, type ModelInfo, type CompletionRequest, type StreamEvent } from './types.js';
import { OllamaProvider } from './providers/ollama.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { OpenAIProvider, DeepSeekProvider } from './providers/openai.js';
import { CustomOpenAIProvider } from './providers/custom.js';
import { validateCustomProviders } from './providers/custom-config.js';
import type { QodexConfig } from '../config/defaults.js';
import { logger } from '../utils/logger.js';
import { ProviderError } from '../utils/errors.js';

export type TaskClass = 'planning' | 'tool-decision' | 'code-generation' | 'reflection' | 'general';

export interface RouteDecision {
  provider: Provider;
  model: string;
  modelInfo: ModelInfo;
  reason: string;
}

export class ModelRouter {
  private providers = new Map<string, Provider>();
  private modelIndex = new Map<string, { provider: Provider; info: ModelInfo }>();
  private localAvailable = false;
  private initialized = false;

  constructor(private config: QodexConfig) {}

  /** Access a registered provider by name (e.g. 'ollama', 'openai'). For tooling
   *  like the speculative-decoding helper that needs to enumerate local models. */
  getProvider(name: string): Provider | undefined {
    return this.providers.get(name);
  }

  /** All registered provider names. */
  providerNames(): string[] {
    return [...this.providers.keys()];
  }

  async initialize(): Promise<void> {
    // Register providers
    const ollamaCfg = this.config.providers.ollama;
    this.providers.set('ollama', new OllamaProvider(ollamaCfg.baseUrl, {
      keepAlive: ollamaCfg.keepAlive,
      options: ollamaCfg.options,
      draftModel: ollamaCfg.draftModel,
    }));
    // Anthropic prompt caching is opt-in via config. Default off — first run after
    // `qx setup` may flip this on when the user opts in.
    const anthropicUseCaching = (this.config.providers.anthropic as any)?.useCaching === true;
    this.providers.set('anthropic', new AnthropicProvider(
      process.env[this.config.providers.anthropic.apiKeyEnv],
      { useCaching: anthropicUseCaching },
    ));
    const openaiCfg = this.config.providers.openai;
    this.providers.set('openai', new OpenAIProvider({
      apiKey: process.env[openaiCfg.apiKeyEnv],
      baseURL: openaiCfg.baseUrl,
      extraModels: openaiCfg.extraModels as any,
      defaultHeaders: openaiCfg.defaultHeaders,
      samplingOptions: openaiCfg.samplingOptions as any,
      draftModel: (openaiCfg as any).draftModel,
    }));
    const deepseekCfg = this.config.providers.deepseek;
    this.providers.set('deepseek', new DeepSeekProvider({
      apiKey: process.env[deepseekCfg.apiKeyEnv],
      baseURL: deepseekCfg.baseUrl,
      extraModels: deepseekCfg.extraModels as any,
      defaultHeaders: deepseekCfg.defaultHeaders,
    }));

    // User-defined OpenAI-compatible providers (providers.custom[] in config.yaml).
    // Lets QodeX talk to ANY gateway that issues an API key — Groq, Gemini's compat
    // layer, GitHub Models, Mistral, OpenRouter, a self-host — with no code change.
    // Invalid entries are skipped with a warning rather than crashing the CLI.
    const { providers: customDefs, errors: customErrors } =
      validateCustomProviders((this.config.providers as any).custom);
    for (const err of customErrors) {
      logger.warn(`Ignoring custom provider: ${err}`);
    }
    for (const def of customDefs) {
      if (this.providers.has(def.name)) {
        logger.warn(`Custom provider "${def.name}" collides with an already-registered provider — skipping.`);
        continue;
      }
      const key = process.env[def.apiKeyEnv];
      if (!key) {
        logger.info(`Custom provider "${def.name}" configured but ${def.apiKeyEnv} is not set — it will stay inactive until you export it.`);
      }
      this.providers.set(def.name, new CustomOpenAIProvider(def, key));
    }

    // Discover available models
    for (const [name, provider] of this.providers) {
      let available = await provider.isAvailable();
      // Local providers (Ollama/LM Studio) can be cold at launch — a single retry
      // after a short backoff avoids dropping all their models on a transient miss.
      // A truly-down server fails fast (ECONNREFUSED), so this costs ~250ms only
      // in the rare slow-start case, never when the server is simply absent.
      if (!available && provider.isLocal) {
        await new Promise(r => setTimeout(r, 250));
        available = await provider.isAvailable();
      }
      if (!available) {
        logger.debug(`Provider ${name} unavailable`);
        continue;
      }
      try {
        const models = await provider.listModels();
        for (const m of models) {
          this.modelIndex.set(`${name}/${m.id}`, { provider, info: m });
          this.modelIndex.set(m.id, { provider, info: m });
        }
        if (provider.isLocal && models.length > 0) {
          this.localAvailable = true;
        }
        logger.info(`Provider ${name} ready with ${models.length} models`);
      } catch (e: any) {
        logger.warn(`Failed to list models for ${name}`, { err: e.message });
      }
    }

    this.initialized = true;

    // Sanity check: the configured default model should actually be available.
    // If not, the router will silently fall back; warn loudly so the user knows.
    const defaultId = this.config.defaults?.model;
    if (defaultId && !this.resolveModel(defaultId)) {
      const localCount = [...this.providers.entries()]
        .filter(([_, p]) => p.isLocal)
        .map(([n, _]) => n)
        .join(', ') || '(none)';
      logger.warn(
        `Configured default model '${defaultId}' is NOT available. ` +
        `Local providers: ${localCount}. The router will fall back to whatever model fits. ` +
        `Either start Ollama (\`ollama serve\`) and \`ollama pull ${defaultId}\`, ` +
        `or change \`defaults.model\` in your config to an available cloud model.`,
      );
    }
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  hasLocal(): boolean {
    return this.localAvailable;
  }

  listAvailableModels(): Array<{ provider: string; model: string; info: ModelInfo; local: boolean }> {
    // Use the stored provider + model id directly instead of parsing index keys.
    // The index holds each model under both `${provider}/${id}` and `${id}`, and an
    // id can itself contain a '/' (e.g. LM Studio's `qwen/qwen3-coder-next`), so
    // splitting the key produced bogus/truncated rows like `openai/qwen`.
    const seen = new Set<string>();
    const out: Array<{ provider: string; model: string; info: ModelInfo; local: boolean }> = [];
    for (const val of this.modelIndex.values()) {
      const provider = val.provider.name;
      const model = val.info.id;
      const tag = `${provider}/${model}`;
      if (seen.has(tag)) continue;
      seen.add(tag);
      out.push({ provider, model, info: val.info, local: val.provider.isLocal });
    }
    return out;
  }

  resolveModel(modelId: string): { provider: Provider; modelInfo: ModelInfo; resolvedId: string } | null {
    // Try exact match first
    const direct = this.modelIndex.get(modelId);
    if (direct) {
      // The map stores entries under both `${providerName}/${modelId}` AND `${modelId}`.
      // We only want to strip the prefix if it's actually a QodeX provider name
      // (ollama, openai, anthropic, deepseek) — NOT a HuggingFace-style publisher
      // prefix like `qwen/qwen3-coder-next` that LM Studio uses.
      let resolvedId = modelId;
      if (modelId.includes('/')) {
        const [first, ...rest] = modelId.split('/');
        if (first && this.providers.has(first)) {
          resolvedId = rest.join('/');
        }
      }
      return { provider: direct.provider, modelInfo: direct.info, resolvedId };
    }
    // Try fuzzy match — only for QodeX-provider prefixes, same rule as above.
    for (const [key, val] of this.modelIndex) {
      if (key.includes('/') && key.endsWith('/' + modelId)) {
        const prefix = key.slice(0, key.length - modelId.length - 1);
        if (this.providers.has(prefix)) {
          return { provider: val.provider, modelInfo: val.info, resolvedId: modelId };
        }
      }
    }

    // Partial match (case-insensitive): lets `--model qwen2.5` select
    // `qwen2.5-coder:32b` when that's the ONLY model matching. Prefix matches are
    // preferred over substring; an ambiguous query (matching 2+ distinct models)
    // resolves to nothing so we never silently pick the wrong model — route()
    // turns that into an error listing the candidates.
    const matches = this.matchModelCandidates(modelId);
    if (matches.length === 1) {
      const val = matches[0]!;
      return { provider: val.provider, modelInfo: val.info, resolvedId: val.info.id };
    }

    return null;
  }

  /**
   * Distinct models whose id (or `provider/id`) matches `query` case-insensitively.
   * Prefix matches win: if any id starts with the query, only those are returned;
   * otherwise substring matches are returned. Used by resolveModel (unique case)
   * and by route() to build a helpful "be more specific" error.
   */
  matchModelCandidates(query: string): Array<{ provider: Provider; info: ModelInfo }> {
    const q = query.toLowerCase();
    const distinct = new Map<string, { provider: Provider; info: ModelInfo }>();
    for (const val of this.modelIndex.values()) {
      distinct.set(`${val.provider.name}/${val.info.id}`, val);
    }
    const prefix: Array<{ provider: Provider; info: ModelInfo }> = [];
    const substr: Array<{ provider: Provider; info: ModelInfo }> = [];
    for (const val of distinct.values()) {
      const id = val.info.id.toLowerCase();
      const full = `${val.provider.name}/${val.info.id}`.toLowerCase();
      if (id.startsWith(q) || full.startsWith(q)) prefix.push(val);
      else if (id.includes(q) || full.includes(q)) substr.push(val);
    }
    return prefix.length > 0 ? prefix : substr;
  }

  route(taskClass: TaskClass, contextTokens: number, options: { explicitModel?: string } = {}): RouteDecision {
    if (!this.initialized) {
      throw new ProviderError('Router not initialized', 'router');
    }

    // Explicit user override
    if (options.explicitModel) {
      const resolved = this.resolveModel(options.explicitModel);
      if (!resolved) {
        const candidates = this.matchModelCandidates(options.explicitModel);
        const all = this.listAvailableModels();
        let msg = `Model not available: ${options.explicitModel}`;
        if (candidates.length > 1) {
          msg += `. ${candidates.length} models match — be more specific:\n` +
            candidates.map(c => `  ${c.provider.name}/${c.info.id}`).join('\n');
        } else if (all.length > 0) {
          msg += `. Available models:\n` + all.map(m => `  ${m.provider}/${m.model}`).join('\n');
        } else {
          msg += `. No models are currently available — is a provider running? ` +
            `(e.g. \`ollama serve\` then \`ollama pull qwen2.5-coder:32b\`, or set an API key).`;
        }
        throw new ProviderError(msg, 'router');
      }
      return {
        provider: resolved.provider,
        model: resolved.resolvedId,
        modelInfo: resolved.modelInfo,
        reason: `Explicit user choice: ${options.explicitModel}`,
      };
    }

    // Class-based routing
    let candidateId: string;
    switch (taskClass) {
      case 'planning':
      case 'tool-decision':
      case 'reflection':
        candidateId = this.config.routing[taskClass === 'tool-decision' ? 'toolDecision' : taskClass];
        break;
      case 'code-generation':
      case 'general':
        candidateId = this.config.routing.codeGeneration;
        break;
      default:
        candidateId = this.config.defaults.model;
    }

    let resolved = this.resolveModel(candidateId);

    // Fall back to default if class-specific isn't available
    if (!resolved) {
      resolved = this.resolveModel(this.config.defaults.model);
    }

    // Last resort: any model that fits context
    if (!resolved) {
      for (const { provider, info } of this.modelIndex.values()) {
        if (info.contextWindow >= contextTokens * 1.2) {
          resolved = { provider, modelInfo: info, resolvedId: info.id };
          break;
        }
      }
    }

    if (!resolved) {
      throw new ProviderError(
        'No model available. Check that Ollama is running or set ANTHROPIC_API_KEY / OPENAI_API_KEY.',
        'router',
      );
    }

    return {
      provider: resolved.provider,
      model: resolved.resolvedId,
      modelInfo: resolved.modelInfo,
      reason: `${resolved.provider.isLocal ? 'Local' : 'Cloud'} ${resolved.provider.name}: ${resolved.resolvedId} for ${taskClass}`,
    };
  }
}

export function computeCost(usage: { input: number; output: number }, info: ModelInfo): number {
  return (usage.input * info.inputCostPerMillion + usage.output * info.outputCostPerMillion) / 1_000_000;
}