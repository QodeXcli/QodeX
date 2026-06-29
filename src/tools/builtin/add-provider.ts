/**
 * `add_provider` tool — add an OpenAI-compatible LLM provider by just ASKING in chat.
 *
 * The friendly gap vs. other agents was that wiring up a new provider meant hand-editing
 * ~/.qodex/config.yaml. The `qodex provider add` CLI already fixed that on the command line; this
 * exposes the SAME tested machinery (known-gateway specs + a non-destructive config splice) to the
 * agent, so a user can say "add OpenRouter, my key is in OPENROUTER_API_KEY" and it's wired up —
 * other providers untouched. The model is generated/edited by the user; the config write is
 * deterministic. Mutating, so it goes through the normal permission prompt.
 */
import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../base.js';

const Args = z.object({
  provider: z.string().min(1).describe(
    'A known gateway id (openrouter, gemini, groq, …) — run `qodex provider list` for the set — OR a ' +
    'custom name for any OpenAI-compatible endpoint (then base_url + key_env are required).'),
  base_url: z.string().optional().describe('OpenAI-compatible base URL (…/v1). Required for an UNKNOWN provider.'),
  key_env: z.string().optional().describe('Env var that holds the API key, e.g. OPENROUTER_API_KEY. Required for an unknown provider.'),
  model: z.string().optional().describe('Pin a specific model id (else the gateway default / auto-discovery is used).'),
  context: z.number().int().positive().optional().describe('Context window for the pinned model.'),
  set_default: z.boolean().optional().describe('Also make this provider+model the default.'),
});

export class AddProviderTool extends Tool<z.infer<typeof Args>> {
  name = 'add_provider';
  description =
    'Add an OpenAI-compatible LLM provider to the user config (~/.qodex/config.yaml) from chat — e.g. ' +
    '"add OpenRouter with key OPENROUTER_API_KEY". Use a known gateway id (openrouter/gemini/groq/…) for ' +
    'auto-filled URL + key env, or pass base_url + key_env for any other endpoint. Existing providers are ' +
    'kept; the API key itself is read from the env var, never stored. Reversible with `qodex provider remove`.';
  argsSchema = Args;
  isReadOnly = false;
  isDestructive = false;

  async execute(args: z.infer<typeof Args>, _ctx: ToolContext): Promise<ToolResult> {
    const { findGateway, buildCustomEntry } = await import('../../setup/gateways.js');
    const { addProviderToConfig } = await import('../../setup/provider-writer.js');

    const spec = findGateway(args.provider);
    if (!spec && (!args.base_url || !args.key_env)) {
      return {
        content:
          `"${args.provider}" isn't a known gateway. Either use one of the known ids (run \`qodex provider list\`), ` +
          `or pass base_url and key_env, e.g.:\n  add_provider provider="${args.provider}" base_url="https://…/v1" key_env="MY_API_KEY"`,
        isError: true,
      };
    }

    let entry, res;
    try {
      entry = buildCustomEntry({
        spec,
        name: args.provider,
        baseUrl: args.base_url,
        apiKeyEnv: args.key_env,
        modelId: args.model,
        contextWindow: args.context,
      });
      res = await addProviderToConfig(entry, { setDefault: args.set_default, defaultModel: args.model });
    } catch (e: any) {
      return { content: e?.message ?? String(e), isError: true };
    }

    const keyEnv = entry.apiKeyEnv;
    const keySet = !!process.env[keyEnv];
    const modelId = entry.models?.[0]?.id;
    const lines = [
      `✓ Added provider "${res.name}" to ${res.configPath} — your other providers are untouched.`,
      keySet
        ? `The key env ${keyEnv} is already set in this environment. ✅`
        : `⚠️ Export your key so QodeX can read it:\n    export ${keyEnv}="your-key"      # add to your shell profile to persist`,
      spec?.keyHint ? `   (${spec.keyHint})` : '',
      res.setDefault
        ? `Default model is now ${modelId ?? res.name}.`
        : `Use it with:  qodex --model ${res.name}/${modelId ?? '<model-id>'}   (or /model in a session)`,
      spec?.note ? `Note: ${spec.note}` : '',
    ].filter(Boolean);
    return { content: lines.join('\n'), metadata: { provider: res.name, keyEnv, keySet, model: modelId, setDefault: res.setDefault } };
  }
}
