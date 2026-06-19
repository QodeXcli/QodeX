import { OpenAIProvider } from './openai.js';
import type { ModelInfo } from '../types.js';
import { logger } from '../../utils/logger.js';
import { mapDiscoveredModels, modelsEndpoint, type NormalizedCustomProvider } from './custom-config.js';

/**
 * A user-defined OpenAI-compatible provider (providers.custom[] in config.yaml).
 *
 * Reuses the entire OpenAIProvider request/stream/tool-call path; the only thing
 * that differs is the model catalog:
 *   - explicit `models` in config  → use them verbatim (precise context windows).
 *   - omitted                      → discover from GET {baseUrl}/models at startup,
 *                                     registering each id with default caps.
 *
 * Cloud gateways are assumed reachable when their key is set, so isAvailable()
 * just checks the key (no startup ping) — same as the built-in openai/deepseek
 * slots. In discovery mode a failed fetch logs and yields [] (provider drops out).
 */
export class CustomOpenAIProvider extends OpenAIProvider {
  private readonly customApiKey: string | undefined;
  private readonly discoverBaseUrl: string;
  private readonly explicitModels: ModelInfo[] | null;
  private readonly customHeaders?: Record<string, string>;
  private discovered: ModelInfo[] | null = null;

  constructor(def: NormalizedCustomProvider, apiKey: string | undefined) {
    super({
      providerName: def.name,
      baseURL: def.baseUrl,
      apiKey,
      // When discovering, start with an empty catalog; listModels() fills it.
      models: def.models ?? [],
      defaultHeaders: def.defaultHeaders,
      samplingOptions: def.samplingOptions as any,
    });
    this.customApiKey = apiKey;
    this.discoverBaseUrl = def.baseUrl;
    this.explicitModels = def.models;
    this.customHeaders = def.defaultHeaders;
  }

  async isAvailable(): Promise<boolean> {
    return !!this.customApiKey;
  }

  async listModels(): Promise<ModelInfo[]> {
    if (!this.customApiKey) return [];
    if (this.explicitModels) return this.explicitModels;
    if (this.discovered) return this.discovered;

    // Auto-discovery: ask the gateway what it serves.
    try {
      const res = await fetch(modelsEndpoint(this.discoverBaseUrl), {
        headers: { Authorization: `Bearer ${this.customApiKey}`, ...(this.customHeaders ?? {}) },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        logger.warn(`Custom provider ${this.name}: GET /models returned ${res.status}; no models discovered. ` +
          `List them explicitly under providers.custom[].models if discovery isn't supported.`);
        this.discovered = [];
        return this.discovered;
      }
      const body = await res.json();
      const models = mapDiscoveredModels(body);
      if (models.length === 0) {
        logger.warn(`Custom provider ${this.name}: /models returned no usable ids.`);
      } else {
        logger.info(`Custom provider ${this.name}: discovered ${models.length} models from /models.`);
      }
      this.discovered = models;
      return models;
    } catch (e: any) {
      logger.warn(`Custom provider ${this.name}: model discovery failed (${e?.message ?? e}). ` +
        `Set providers.custom[].models explicitly to use it offline-of-discovery.`);
      this.discovered = [];
      return this.discovered;
    }
  }
}
