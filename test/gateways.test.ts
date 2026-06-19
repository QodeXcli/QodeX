/**
 * Tests for src/setup/gateways.ts — known-gateway registry + non-destructive config merge.
 * Run: node --experimental-strip-types test/gateways.test.ts
 */
import {
  KNOWN_GATEWAYS, listGatewayIds, findGateway, buildCustomEntry, mergeCustomProvider,
} from '../src/setup/gateways.ts';

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log('— registry —');
{
  check('has openrouter, gemini, groq', !!findGateway('openrouter') && !!findGateway('gemini') && !!findGateway('groq'));
  check('lookup is case-insensitive', findGateway('OpenRouter')?.name === 'openrouter');
  check('unknown returns undefined', findGateway('nope') === undefined);
  check('lists several gateways', listGatewayIds().length >= 8);
  // every spec has the essential fields
  let allValid = true;
  for (const id of listGatewayIds()) {
    const g = KNOWN_GATEWAYS[id];
    if (!g.name || !g.baseUrl || !g.apiKeyEnv || !/^https?:\/\//.test(g.baseUrl)) allValid = false;
  }
  check('every gateway has name/baseUrl/apiKeyEnv with valid URL', allValid);
}

console.log('— buildCustomEntry —');
{
  const e = buildCustomEntry({ spec: findGateway('openrouter')! });
  check('builds from spec', e.name === 'openrouter' && e.baseUrl.includes('openrouter.ai'));
  check('pins suggested model', !!e.models && e.models[0].id.includes('llama'));
  check('model has tool calls on', e.models![0].supportsToolCalls === true);

  // explicit override for an unlisted gateway
  const c = buildCustomEntry({ name: 'mygw', baseUrl: 'https://x.example/v1', apiKeyEnv: 'MYGW_KEY' });
  check('builds from explicit fields', c.name === 'mygw' && c.apiKeyEnv === 'MYGW_KEY');
  check('omits models when no model id (auto-discover)', c.models === undefined);

  // missing required fields throw
  let threw = false;
  try { buildCustomEntry({ name: 'x' }); } catch { threw = true; }
  check('throws without baseUrl/apiKeyEnv', threw);
}

console.log('— mergeCustomProvider: non-destructive —');
{
  // start with a config that already has gemini + an openai default
  const existing = {
    defaults: { provider: 'openai', model: 'gpt-4o-mini' },
    providers: { custom: [{ name: 'gemini', apiKeyEnv: 'GEMINI_API_KEY', baseUrl: 'https://g/v1' }] },
  };
  const entry = buildCustomEntry({ spec: findGateway('openrouter')! });
  const merged = mergeCustomProvider(existing, entry);
  check('keeps the existing gemini provider', merged.providers.custom.some((c: any) => c.name === 'gemini'));
  check('adds the new openrouter provider', merged.providers.custom.some((c: any) => c.name === 'openrouter'));
  check('does NOT touch defaults when setDefault not passed', merged.defaults.provider === 'openai');
  check('now has 2 custom providers', merged.providers.custom.length === 2);
}
{
  // replacing same-named provider doesn't duplicate
  const cfg = { providers: { custom: [{ name: 'groq', apiKeyEnv: 'OLD', baseUrl: 'https://old/v1' }] } };
  const merged = mergeCustomProvider(cfg, buildCustomEntry({ spec: findGateway('groq')! }));
  check('replaces same-named in place (no dup)', merged.providers.custom.filter((c: any) => c.name === 'groq').length === 1);
  check('uses the new baseUrl', merged.providers.custom[0].baseUrl.includes('groq.com'));
}
{
  // setDefault flips defaults to the new provider
  const merged = mergeCustomProvider({}, buildCustomEntry({ spec: findGateway('gemini')! }), { setDefault: true });
  check('setDefault sets provider', merged.defaults.provider === 'gemini');
  check('setDefault sets model', merged.defaults.model === 'gemini-2.5-flash');
}
{
  // merging into an empty/undefined config doesn't crash
  const merged = mergeCustomProvider(undefined, buildCustomEntry({ spec: findGateway('groq')! }));
  check('handles empty config', merged.providers.custom.length === 1);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
