/**
 * Known LLM gateways — the "general formula" for adding any OpenAI-compatible provider.
 *
 * Most cloud LLM endpoints today speak the OpenAI chat-completions wire format, so QodeX can
 * talk to any of them through one `providers.custom[]` entry: a name, the env var holding the
 * key, and a base URL. This module captures the base URLs + sensible defaults for the popular
 * ones so a user can run `qodex provider add openrouter` instead of hand-writing YAML (and
 * accidentally overwriting their whole config with `cat >`).
 *
 * Adding a gateway not listed here is still one command — pass --base-url and --key-env.
 */

export interface GatewaySpec {
  /** Config/provider name written into providers.custom[].name. */
  name: string;
  /** Human label for prompts. */
  title: string;
  /** OpenAI-compatible base URL (…/v1 style). */
  baseUrl: string;
  /** Env var the user exports with their key. */
  apiKeyEnv: string;
  /** Hint about where to get the key / what it looks like. */
  keyHint: string;
  /** A reasonable default model id to seed defaults.model with (optional). */
  suggestedModel?: string;
  /** Context window for the suggested model, if we want to pin it. */
  suggestedContextWindow?: number;
  /** Whether the suggested model supports tool calls (artifacts need this). */
  suggestedToolCalls?: boolean;
  /** Caveats worth surfacing (e.g. free-tier rate limits, no vision). */
  note?: string;
}

export const KNOWN_GATEWAYS: Record<string, GatewaySpec> = {
  openrouter: {
    name: 'openrouter',
    title: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    keyHint: 'Get a key at https://openrouter.ai/keys (starts with sk-or-).',
    suggestedModel: 'meta-llama/llama-3.3-70b-instruct',
    suggestedContextWindow: 131072,
    suggestedToolCalls: true,
    note: 'Models ending in ":free" share a heavily-contended pool and often hit 429 under load — use a paid model id for reliable throughput on multi-step tasks.',
  },
  gemini: {
    name: 'gemini',
    title: 'Google Gemini (OpenAI-compatible endpoint)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    apiKeyEnv: 'GEMINI_API_KEY',
    keyHint: 'Get a key at https://aistudio.google.com/apikey (starts with AIza).',
    suggestedModel: 'gemini-2.5-flash',
    suggestedContextWindow: 1048576,
    suggestedToolCalls: true,
    note: 'The free tier has per-minute and per-day request caps; sustained testing can hit 429 until the daily reset. Gemini models are vision-capable.',
  },
  groq: {
    name: 'groq',
    title: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    keyHint: 'Get a key at https://console.groq.com/keys (starts with gsk_).',
    suggestedModel: 'llama-3.3-70b-versatile',
    suggestedContextWindow: 131072,
    suggestedToolCalls: true,
    note: 'Very fast. Free tier has generous but real rate limits.',
  },
  mistral: {
    name: 'mistral',
    title: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    apiKeyEnv: 'MISTRAL_API_KEY',
    keyHint: 'Get a key at https://console.mistral.ai/api-keys/.',
    suggestedModel: 'mistral-large-latest',
    suggestedContextWindow: 131072,
    suggestedToolCalls: true,
  },
  github: {
    name: 'github',
    title: 'GitHub Models',
    baseUrl: 'https://models.github.ai/inference',
    apiKeyEnv: 'GITHUB_TOKEN',
    keyHint: 'Use a GitHub PAT with the models scope (https://github.com/settings/tokens).',
    suggestedModel: 'gpt-4o',
    suggestedContextWindow: 128000,
    suggestedToolCalls: true,
    note: 'Rate-limited per GitHub plan; intended for experimentation.',
  },
  together: {
    name: 'together',
    title: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    apiKeyEnv: 'TOGETHER_API_KEY',
    keyHint: 'Get a key at https://api.together.ai/settings/api-keys.',
    suggestedModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    suggestedContextWindow: 131072,
    suggestedToolCalls: true,
  },
  deepinfra: {
    name: 'deepinfra',
    title: 'DeepInfra',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    apiKeyEnv: 'DEEPINFRA_API_KEY',
    keyHint: 'Get a key at https://deepinfra.com/dash/api_keys.',
    suggestedModel: 'meta-llama/Llama-3.3-70B-Instruct',
    suggestedContextWindow: 131072,
    suggestedToolCalls: true,
  },
  fireworks: {
    name: 'fireworks',
    title: 'Fireworks AI',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    apiKeyEnv: 'FIREWORKS_API_KEY',
    keyHint: 'Get a key at https://fireworks.ai/account/api-keys.',
    suggestedModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
    suggestedContextWindow: 131072,
    suggestedToolCalls: true,
  },
  xai: {
    name: 'xai',
    title: 'xAI (Grok)',
    baseUrl: 'https://api.x.ai/v1',
    apiKeyEnv: 'XAI_API_KEY',
    keyHint: 'Get a key at https://console.x.ai/.',
    suggestedModel: 'grok-2-latest',
    suggestedContextWindow: 131072,
    suggestedToolCalls: true,
  },
  perplexity: {
    name: 'perplexity',
    title: 'Perplexity',
    baseUrl: 'https://api.perplexity.ai',
    apiKeyEnv: 'PERPLEXITY_API_KEY',
    keyHint: 'Get a key at https://www.perplexity.ai/settings/api.',
    suggestedModel: 'sonar',
    suggestedContextWindow: 127072,
    suggestedToolCalls: true,
  },
};

export function listGatewayIds(): string[] {
  return Object.keys(KNOWN_GATEWAYS);
}

export function findGateway(id: string): GatewaySpec | undefined {
  return KNOWN_GATEWAYS[id.trim().toLowerCase()];
}

/** A custom-provider config entry, matching providers.custom[] shape. */
export interface CustomProviderEntry {
  name: string;
  apiKeyEnv: string;
  baseUrl: string;
  models?: Array<{ id: string; contextWindow?: number; supportsToolCalls?: boolean }>;
}

/**
 * Build a providers.custom[] entry from a gateway spec (or explicit fields for an unlisted
 * gateway). If a model id is given we pin it (with the spec's defaults); otherwise we omit
 * `models` so the provider auto-discovers from GET {baseUrl}/models.
 */
/**
 * Turn a user-supplied provider identifier into a valid provider NAME.
 *
 * A provider name must not contain spaces, "/", or ":" (the config loader rejects
 * such names — `providers.custom[].name must not contain spaces or "/"`). Users
 * commonly run `qodex provider add https://api.example.com/v1`, which would
 * otherwise store the whole URL as the name and get silently dropped at load.
 * We reduce a URL to its host and slugify: `https://api.203668.xyz/v1` → `api-203668-xyz`.
 * A plain name like `myhost` passes through unchanged.
 */
export function slugifyProviderName(raw: string): string {
  let s = (raw ?? '').trim().toLowerCase();
  const url = s.match(/^[a-z][a-z0-9+.-]*:\/\/([^/]+)/); // scheme://host/... → host
  if (url) s = url[1]!;
  return s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function buildCustomEntry(opts: {
  spec?: GatewaySpec;
  name?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  modelId?: string;
  contextWindow?: number;
  toolCalls?: boolean;
}): CustomProviderEntry {
  // spec names are already valid; a user-supplied custom name may be a raw URL → slugify it.
  const name = opts.spec ? (opts.spec.name ?? '').trim() : slugifyProviderName(opts.name ?? '');
  const baseUrl = (opts.baseUrl ?? opts.spec?.baseUrl ?? '').trim();
  const apiKeyEnv = (opts.apiKeyEnv ?? opts.spec?.apiKeyEnv ?? '').trim();
  if (!name) throw new Error('provider name is required');
  if (/[\s/:]/.test(name)) throw new Error(`invalid provider name "${name}": must not contain spaces, "/", or ":"`);
  if (!baseUrl) throw new Error('baseUrl is required');
  if (!apiKeyEnv) throw new Error('apiKeyEnv is required');

  const entry: CustomProviderEntry = { name, apiKeyEnv, baseUrl };
  const modelId = opts.modelId ?? opts.spec?.suggestedModel;
  if (modelId) {
    entry.models = [{
      id: modelId,
      contextWindow: opts.contextWindow ?? opts.spec?.suggestedContextWindow ?? 131072,
      supportsToolCalls: opts.toolCalls ?? opts.spec?.suggestedToolCalls ?? true,
    }];
  }
  return entry;
}

/**
 * Merge a custom provider entry into an existing parsed config object WITHOUT discarding
 * anything else. This is the fix for "cat > config.yaml wipes my other providers": we read,
 * splice, and write back. Returns the mutated config. If a custom provider with the same name
 * exists, it's replaced in place (no duplicates).
 */
export function mergeCustomProvider(config: any, entry: CustomProviderEntry, opts?: { setDefault?: boolean; defaultModel?: string }): any {
  const cfg = config && typeof config === 'object' ? config : {};
  cfg.providers = cfg.providers && typeof cfg.providers === 'object' ? cfg.providers : {};
  const custom: CustomProviderEntry[] = Array.isArray(cfg.providers.custom) ? cfg.providers.custom : [];

  const idx = custom.findIndex(c => c && c.name === entry.name);
  if (idx >= 0) custom[idx] = entry;
  else custom.push(entry);
  cfg.providers.custom = custom;

  if (opts?.setDefault) {
    cfg.defaults = cfg.defaults && typeof cfg.defaults === 'object' ? cfg.defaults : {};
    cfg.defaults.provider = entry.name;
    const model = opts.defaultModel ?? entry.models?.[0]?.id;
    if (model) cfg.defaults.model = model;
  }
  return cfg;
}
