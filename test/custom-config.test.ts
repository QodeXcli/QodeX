/**
 * Tests for src/llm/providers/custom-config.ts (user-defined providers).
 * Run: node --experimental-strip-types test/custom-config.test.ts
 */
import {
  validateCustomProvider,
  validateCustomProviders,
  fillModelDefaults,
  mapDiscoveredModels,
  modelsEndpoint,
  findCustomProviderPromptConfig,
  RESERVED_PROVIDER_NAMES,
} from '../src/llm/providers/custom-config.ts';

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log('— model default filling —');
{
  const m = fillModelDefaults({ id: 'llama-3.3-70b-versatile' });
  check('id-only entry gets defaults', !!m && m.contextWindow === 128000 && m.maxOutput === 8192);
  check('defaults: tool calls + streaming on', !!m && m.supportsToolCalls === true && m.supportsStreaming === true);
  check('defaults: zero cost', !!m && m.inputCostPerMillion === 0 && m.outputCostPerMillion === 0);

  const m2 = fillModelDefaults({ id: 'x', contextWindow: 1048576, maxOutput: 65536, supportsToolCalls: false });
  check('explicit fields win over defaults', m2!.contextWindow === 1048576 && m2!.maxOutput === 65536 && m2!.supportsToolCalls === false);

  check('missing id → null', fillModelDefaults({ contextWindow: 1000 }) === null);
  check('blank id → null', fillModelDefaults({ id: '   ' }) === null);
  check('id is trimmed', fillModelDefaults({ id: '  gpt-4o  ' })!.id === 'gpt-4o');
}

console.log('— single-provider validation —');
{
  const ok = validateCustomProvider({ name: 'groq', apiKeyEnv: 'GROQ_API_KEY', baseUrl: 'https://api.groq.com/openai/v1' }, 0);
  check('minimal valid entry (no models → discover)', ok.ok === true && ok.value.models === null);

  const withModels = validateCustomProvider({
    name: 'gemini', apiKeyEnv: 'GEMINI_API_KEY',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    models: [{ id: 'gemini-2.5-flash', contextWindow: 1048576 }],
  }, 1);
  check('entry with models normalizes them', withModels.ok === true && withModels.value.models!.length === 1 && withModels.value.models![0].contextWindow === 1048576);

  check('missing name → error', validateCustomProvider({ apiKeyEnv: 'K', baseUrl: 'https://x.co' }, 0).ok === false);
  check('name with slash → error', validateCustomProvider({ name: 'a/b', apiKeyEnv: 'K', baseUrl: 'https://x.co' }, 0).ok === false);
  check('name with space → error', validateCustomProvider({ name: 'a b', apiKeyEnv: 'K', baseUrl: 'https://x.co' }, 0).ok === false);
  check('reserved name (openai) → error', validateCustomProvider({ name: 'openai', apiKeyEnv: 'K', baseUrl: 'https://x.co' }, 0).ok === false);
  check('all 4 built-ins reserved', RESERVED_PROVIDER_NAMES.size === 4);
  check('missing apiKeyEnv → error', validateCustomProvider({ name: 'x', baseUrl: 'https://x.co' }, 0).ok === false);
  check('non-http baseUrl → error', validateCustomProvider({ name: 'x', apiKeyEnv: 'K', baseUrl: 'ftp://x.co' }, 0).ok === false);
  check('missing baseUrl → error', validateCustomProvider({ name: 'x', apiKeyEnv: 'K' }, 0).ok === false);
  check('models present but all invalid → error', validateCustomProvider({ name: 'x', apiKeyEnv: 'K', baseUrl: 'https://x.co', models: [{ foo: 1 }] }, 0).ok === false);
  check('models not a list → error', validateCustomProvider({ name: 'x', apiKeyEnv: 'K', baseUrl: 'https://x.co', models: 'nope' }, 0).ok === false);

  const hdr = validateCustomProvider({ name: 'gh', apiKeyEnv: 'GITHUB_TOKEN', baseUrl: 'https://models.github.ai/inference', defaultHeaders: { 'X-GitHub-Api-Version': '2026-03-10' } }, 0);
  check('defaultHeaders preserved', hdr.ok === true && hdr.value.defaultHeaders?.['X-GitHub-Api-Version'] === '2026-03-10');
}

console.log('— whole-list validation —');
{
  const r = validateCustomProviders([
    { name: 'groq', apiKeyEnv: 'GROQ_API_KEY', baseUrl: 'https://api.groq.com/openai/v1' },
    { name: 'gemini', apiKeyEnv: 'GEMINI_API_KEY', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/' },
    { name: 'openai', apiKeyEnv: 'X', baseUrl: 'https://x.co' }, // reserved → skipped
    { name: 'groq', apiKeyEnv: 'Y', baseUrl: 'https://api.groq.com/openai/v1' }, // dup → skipped
  ]);
  check('two valid providers accepted', r.providers.length === 2);
  check('reserved + duplicate produce 2 errors', r.errors.length === 2);
  check('first groq wins (dedup keeps first)', r.providers[0].name === 'groq' && r.providers[0].apiKeyEnv === 'GROQ_API_KEY');

  check('undefined list → empty, no error', validateCustomProviders(undefined).providers.length === 0 && validateCustomProviders(undefined).errors.length === 0);
  check('non-array list → error', validateCustomProviders({} as any).errors.length === 1);
  check('empty list → empty', validateCustomProviders([]).providers.length === 0);
}

console.log('— /models discovery mapping —');
{
  const openaiShape = mapDiscoveredModels({ object: 'list', data: [{ id: 'llama-3.3-70b-versatile' }, { id: 'mixtral-8x7b' }] });
  check('OpenAI {data:[...]} shape mapped', openaiShape.length === 2 && openaiShape[0].id === 'llama-3.3-70b-versatile');
  check('discovered models get default caps', openaiShape[0].contextWindow === 128000);

  check('bare array shape mapped', mapDiscoveredModels([{ id: 'a' }, { id: 'b' }]).length === 2);
  check('array of strings mapped', mapDiscoveredModels(['a', 'b']).length === 2);
  check('junk body → []', mapDiscoveredModels({ nope: true }).length === 0);
  check('entries without id dropped', mapDiscoveredModels({ data: [{ id: 'ok' }, { foo: 1 }] }).length === 1);
}

console.log('— models endpoint join —');
{
  check('trailing slash handled', modelsEndpoint('https://api.groq.com/openai/v1/') === 'https://api.groq.com/openai/v1/models');
  check('no trailing slash handled', modelsEndpoint('https://api.groq.com/openai/v1') === 'https://api.groq.com/openai/v1/models');
  check('multiple trailing slashes handled', modelsEndpoint('https://x.co/v1///') === 'https://x.co/v1/models');
}

console.log('— per-provider prompt steering —');
{
  const v = validateCustomProvider({
    name: 'gemini', apiKeyEnv: 'GEMINI_API_KEY', baseUrl: 'https://x.co/v1',
    systemPromptAppend: '  You have a 1M-token context; read whole files freely.  ',
    systemPromptOverride: '',  // blank → ignored
  }, 0);
  check('systemPromptAppend trimmed + kept', v.ok === true && v.value.systemPromptAppend === 'You have a 1M-token context; read whole files freely.');
  check('blank systemPromptOverride ignored', v.ok === true && v.value.systemPromptOverride === undefined);

  const v2 = validateCustomProvider({
    name: 'groq', apiKeyEnv: 'GROQ_API_KEY', baseUrl: 'https://x.co/v1',
    systemPromptAppend: 42,  // wrong type → ignored, not an error
  }, 0);
  check('non-string append ignored (fail-soft, still valid)', v2.ok === true && v2.value.systemPromptAppend === undefined);

  // lookup helper
  const raw = [
    { name: 'groq', apiKeyEnv: 'G', baseUrl: 'https://x.co/v1' },
    { name: 'gemini', apiKeyEnv: 'M', baseUrl: 'https://x.co/v1', systemPromptAppend: 'big ctx', systemPromptOverride: 'be a senior dev' },
  ];
  const found = findCustomProviderPromptConfig(raw, 'gemini');
  check('lookup returns append+override for matching provider', !!found && found!.append === 'big ctx' && found!.override === 'be a senior dev');
  check('provider with no steering → null', findCustomProviderPromptConfig(raw, 'groq') === null);
  check('unknown provider → null', findCustomProviderPromptConfig(raw, 'openai') === null);
  check('undefined provider name → null', findCustomProviderPromptConfig(raw, undefined) === null);
  check('non-array config → null', findCustomProviderPromptConfig({} as any, 'gemini') === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
