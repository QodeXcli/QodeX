/**
 * Interactive "add a provider" flow — the smart, hand-holding path behind `qodex provider add`
 * when run without enough flags to do it non-interactively.
 *
 * What it does, in order:
 *   1. Shows the known gateways (OpenRouter, Gemini, Groq, …) in a scrollable picker, plus a
 *      "something else (custom)" escape hatch.
 *   2. For a known gateway: we already know its base URL, key env var, and a good default model
 *      — the user only has to paste their key.
 *   3. For a custom one: we ask for the base URL and a name, and derive the env var.
 *   4. Pastes the key straight into ~/.qodex/.env (chmod 600) so it Just Works on next launch —
 *      no hand-editing ~/.zshrc.
 *   5. Writes the provider into config.yaml without clobbering the user's other providers, and
 *      offers to make it the default.
 *
 * Everything here is additive: the non-interactive `provider add <id> --flags` path is unchanged.
 */
import { KNOWN_GATEWAYS, listGatewayIds, findGateway, buildCustomEntry, type GatewaySpec } from './gateways.js';
import { addProviderToConfig } from './provider-writer.js';
import { setEnvKey } from './env-writer.js';
import { choose, text, confirm, isInteractiveTTY, type PromptOptions } from './prompt.js';

const CUSTOM_SENTINEL = '__custom__';

export interface InteractiveAddResult {
  name: string;
  model?: string;
  keyStored: boolean;
  setDefault: boolean;
}

/**
 * Run the interactive add flow. `preselectId` lets `provider add groq` jump straight to pasting
 * the Groq key while still using the friendly key-prompt + auto-wire path.
 */
export async function interactiveAddProvider(preselectId?: string): Promise<InteractiveAddResult | null> {
  const opts: PromptOptions = { interactive: isInteractiveTTY() };
  if (!opts.interactive) {
    throw new Error('Interactive add needs a TTY. Use: qodex provider add <id> --base-url <url> --key-env <ENV> [--model <id>]');
  }

  // 1. Resolve the gateway — either preselected or chosen from the list.
  let spec: GatewaySpec | undefined;
  let customName = '';
  let customBaseUrl = '';
  let customKeyEnv = '';

  if (preselectId && findGateway(preselectId)) {
    spec = findGateway(preselectId);
  } else if (preselectId) {
    // A name we don't know — treat it as a custom provider with that name.
    customName = preselectId.trim().toLowerCase();
  } else {
    const ids = listGatewayIds();
    const choices = [
      ...ids.map(id => {
        const g = KNOWN_GATEWAYS[id]!;
        return { value: id, label: g.title, hint: g.baseUrl };
      }),
      { value: CUSTOM_SENTINEL, label: 'Something else (custom OpenAI-compatible endpoint)', hint: 'enter base URL yourself' },
    ];
    const picked = await choose('\nWhich provider do you want to add?', choices, ids[0]!, opts);
    if (picked === CUSTOM_SENTINEL) {
      customName = (await text('  Provider name (one word, e.g. "myhost")', '', opts)).trim().toLowerCase();
      if (!customName) { console.log('  ✗ Cancelled — no name given.'); return null; }
    } else {
      spec = findGateway(picked);
    }
  }

  // 2. For a custom provider, gather base URL + derive the env var name.
  if (!spec) {
    if (!customBaseUrl) {
      customBaseUrl = (await text('  OpenAI-compatible base URL (…/v1)', '', opts)).trim();
      if (!customBaseUrl) { console.log('  ✗ Cancelled — no base URL given.'); return null; }
    }
    customKeyEnv = `${customName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
  }

  const name = spec ? spec.name : customName;
  const apiKeyEnv = spec ? spec.apiKeyEnv : customKeyEnv;
  const title = spec ? spec.title : name;

  // If the provider came from the interactive menu (not a `provider add <id>` argument), confirm
  // the pick before doing anything. This catches the case where a stray Enter — e.g. from pasting
  // multiple lines into the terminal — lands on the default row and would otherwise silently
  // configure the wrong provider.
  if (!preselectId) {
    const right = await confirm(`\n  Configure ${title}?`, true, opts);
    if (!right) { console.log('  ✗ Cancelled. Re-run `qodex provider add` to pick again.'); return null; }
  }

  // 3. Tell the user exactly what we're about to do, then ask for the key.
  console.log(`\n  Setting up: ${title}`);
  if (spec) {
    console.log(`    base URL : ${spec.baseUrl}`);
    console.log(`    key env  : ${spec.apiKeyEnv}`);
    if (spec.keyHint) console.log(`    ${spec.keyHint}`);
  } else {
    console.log(`    base URL : ${customBaseUrl}`);
    console.log(`    key env  : ${apiKeyEnv}`);
  }

  const key = (await text(`\n  Paste your ${name} API key (or leave blank to set it later)`, '', opts)).trim();

  let keyStored = false;
  if (key) {
    const where = await setEnvKey(apiKeyEnv, key);
    keyStored = true;
    console.log(`  ✓ Key saved to ${where} (chmod 600 — loaded automatically next launch).`);
  } else {
    console.log(`  ⓘ No key stored. Set it later with:  export ${apiKeyEnv}="your-key"`);
  }

  // 4. Pick / confirm the model.
  let modelId: string | undefined = spec?.suggestedModel;
  if (spec?.suggestedModel) {
    const useSuggested = await confirm(`\n  Use the default model "${spec.suggestedModel}"?`, true, opts);
    if (!useSuggested) {
      const custom = (await text('  Model id (leave blank to auto-discover from /models)', '', opts)).trim();
      modelId = custom || undefined;
    }
  } else {
    const custom = (await text('\n  Model id to pin (leave blank to auto-discover from /models)', '', opts)).trim();
    modelId = custom || undefined;
  }

  // 5. Build the entry and write it (non-destructively) to config.yaml.
  const entry = spec
    ? buildCustomEntry({ spec, modelId })
    : buildCustomEntry({ name, baseUrl: customBaseUrl, apiKeyEnv, modelId });

  const makeDefault = await confirm(`\n  Make ${name}${modelId ? ` (${modelId})` : ''} your default provider?`, false, opts);

  const res = await addProviderToConfig(entry, { setDefault: makeDefault, defaultModel: modelId });
  console.log(`\n  ✓ Added "${res.name}" to ${res.configPath} (your other providers are untouched).`);

  if (spec?.note) console.log(`\n  Note: ${spec.note}`);

  if (makeDefault) {
    console.log(`\n  ${name} is now your default. Just run:  qodex`);
  } else {
    console.log(`\n  Use it with:  qodex --model ${name}/${modelId ?? '<model-id>'}`);
  }
  console.log(`  Verify with:  qodex --list-models\n`);

  return { name, model: modelId, keyStored, setDefault: makeDefault };
}
