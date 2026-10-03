import { describe, it, expect } from 'vitest';
import { resolveCapability, resolveModelAlias, MODEL_ALIASES } from '../src/llm/model-catalog.js';
import { AnthropicProvider, rejectsSamplingParams, supportsEffort } from '../src/llm/providers/anthropic.js';
import { ModelRouter } from '../src/llm/router.js';
import { handleSlashCommand } from '../src/cli/slash-commands.js';
import { buildModelChoices, CLOUD_DEFAULT_MODEL } from '../src/setup/wizard.js';
import type { HardwareProfile } from '../src/setup/hardware-profile.js';

describe('current Claude models in the catalog (Anthropic pricing, 2026-10)', () => {
  it('Opus 5.5: $4/$20, 1M window, 128K output', () => {
    const c = resolveCapability('claude-opus-5-5');
    expect(c).toMatchObject({ contextWindow: 1_000_000, maxOutput: 128_000, inputCostPerMillion: 4, outputCostPerMillion: 20, source: 'catalog' });
    expect(c.matched).toBe('claude-opus-5-5');
  });

  it('Sonnet 5.5: $2/$10, 1M window, 128K output', () => {
    expect(resolveCapability('claude-sonnet-5-5')).toMatchObject({ contextWindow: 1_000_000, maxOutput: 128_000, inputCostPerMillion: 2, outputCostPerMillion: 10 });
  });

  it('Fable 5.1: $10/$50', () => {
    expect(resolveCapability('claude-fable-5-1')).toMatchObject({ inputCostPerMillion: 10, outputCostPerMillion: 50, pricingSource: 'catalog' });
  });

  it('Haiku 4.5 stays $1/$5', () => {
    expect(resolveCapability('claude-haiku-4-5')).toMatchObject({ inputCostPerMillion: 1, outputCostPerMillion: 5, contextWindow: 200_000 });
  });

  it('5.5 ids are never priced as the generic claude row or their predecessor', () => {
    expect(resolveCapability('claude-opus-5-5').matched).not.toBe('claude');
    expect(resolveCapability('claude-opus-5').inputCostPerMillion).toBe(5);
    // Bedrock-style ids carry a prefix; substring matching still finds the row.
    expect(resolveCapability('anthropic.claude-opus-5-5').inputCostPerMillion).toBe(4);
  });
});

describe('model aliases', () => {
  it('maps each alias to the latest id of its line', () => {
    expect(resolveModelAlias('opus')).toBe('claude-opus-5-5');
    expect(resolveModelAlias('sonnet')).toBe('claude-sonnet-5-5');
    expect(resolveModelAlias('haiku')).toBe('claude-haiku-4-5');
    expect(resolveModelAlias('fable')).toBe('claude-fable-5-1');
    expect(resolveModelAlias(' Sonnet ')).toBe('claude-sonnet-5-5');
  });

  it('keeps a provider prefix and ignores non-aliases', () => {
    expect(resolveModelAlias('anthropic/opus')).toBe('anthropic/claude-opus-5-5');
    expect(resolveModelAlias('claude-opus-5-5')).toBeUndefined();
    expect(resolveModelAlias('qwen2.5-coder:32b')).toBeUndefined();
    expect(resolveModelAlias('')).toBeUndefined();
  });

  it('every alias target is in the catalog with a price', () => {
    for (const id of Object.values(MODEL_ALIASES)) {
      expect(resolveCapability(id).pricingSource).toBe('catalog');
    }
  });
});

/** A router whose index holds exactly `models` (bypasses provider discovery). */
function routerWith(models: Array<{ provider: string; id: string; local?: boolean }>): ModelRouter {
  const router = new ModelRouter({ defaults: { provider: 'anthropic', model: 'claude-opus-5-5' } } as any);
  const index: Map<string, any> = (router as any).modelIndex;
  const providers: Map<string, any> = (router as any).providers;
  for (const m of models) {
    const provider = providers.get(m.provider) ?? { name: m.provider, isLocal: !!m.local };
    providers.set(m.provider, provider);
    const info = { id: m.id, contextWindow: 1000, maxOutput: 100, inputCostPerMillion: 0, outputCostPerMillion: 0, supportsToolCalls: true, supportsStreaming: true };
    index.set(`${m.provider}/${m.id}`, { provider, info });
    index.set(m.id, { provider, info });
  }
  (router as any).initialized = true;
  return router;
}

describe('router resolves aliases (/model sonnet, qodex -m opus)', () => {
  const anthropicIds = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'claude-fable-5-1', 'claude-opus-4-7', 'claude-sonnet-4-6'];

  it('"sonnet" is no longer ambiguous between Sonnet 5.5 and 4.6', () => {
    const router = routerWith(anthropicIds.map(id => ({ provider: 'anthropic', id })));
    expect(router.resolveModel('sonnet')?.resolvedId).toBe('claude-sonnet-5-5');
    expect(router.resolveModel('opus')?.resolvedId).toBe('claude-opus-5-5');
    expect(router.resolveModel('anthropic/haiku')?.resolvedId).toBe('claude-haiku-4-5');
    expect(router.route('general', 0, { explicitModel: 'fable' }).model).toBe('claude-fable-5-1');
  });

  it('an exact model named like an alias still wins', () => {
    const router = routerWith([
      { provider: 'anthropic', id: 'claude-sonnet-5-5' },
      { provider: 'ollama', id: 'sonnet', local: true },
    ]);
    expect(router.resolveModel('sonnet')?.provider.name).toBe('ollama');
  });

  it('falls back to the old partial match when the alias target is not served', () => {
    const router = routerWith([{ provider: 'openrouter', id: 'anthropic/claude-sonnet-4.5' }]);
    expect(router.resolveModel('sonnet')?.resolvedId).toBe('anthropic/claude-sonnet-4.5');
  });
});

describe('Anthropic provider', () => {
  it('lists the new ids first and keeps the old ones resolvable', async () => {
    const ids = (await new AnthropicProvider('k').listModels()).map(m => m.id);
    expect(ids.slice(0, 4)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'claude-fable-5-1']);
    expect(ids).toContain('claude-sonnet-4-6');
    const opus = (await new AnthropicProvider('k').listModels()).find(m => m.id === 'claude-opus-5-5')!;
    expect(opus).toMatchObject({ contextWindow: 1_000_000, maxOutput: 128_000, inputCostPerMillion: 4, outputCostPerMillion: 20 });
  });

  it('knows which models reject sampling params and which take effort', () => {
    for (const m of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-opus-4-7']) expect(rejectsSamplingParams(m)).toBe(true);
    for (const m of ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-6']) expect(rejectsSamplingParams(m)).toBe(false);
    expect(supportsEffort('claude-opus-5-5')).toBe(true);
    expect(supportsEffort('claude-haiku-4-5')).toBe(false);
  });

  /** Run one completion against a fake SDK client; returns the request body and the events. */
  async function runOnce(model: string, extra: Record<string, unknown> = {}, sdkEvents?: any[]) {
    const provider = new AnthropicProvider('k');
    let body: any;
    const events = sdkEvents ?? [
      { type: 'message_start', message: { usage: { input_tokens: 5 } } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    ];
    (provider as any).client = {
      messages: {
        create: async (b: any) => { body = b; return (async function* () { for (const e of events) yield e; })(); },
      },
    };
    const out: any[] = [];
    for await (const ev of provider.complete({ model, messages: [{ role: 'user', content: 'x' }], ...extra } as any)) out.push(ev);
    return { body, out };
  }

  it('omits temperature for Opus 5.5 (a 400 otherwise) and keeps it for Haiku 4.5', async () => {
    expect('temperature' in (await runOnce('claude-opus-5-5')).body).toBe(false);
    expect((await runOnce('claude-haiku-4-5')).body.temperature).toBe(0.3);
  });

  it('maps /effort onto output_config.effort only where supported', async () => {
    expect((await runOnce('claude-opus-5-5', { reasoningEffort: 'high' })).body.output_config).toEqual({ effort: 'high' });
    expect((await runOnce('claude-haiku-4-5', { reasoningEffort: 'high' })).body.output_config).toBeUndefined();
  });

  it('gives always-thinking models room in max_tokens; an explicit value still wins', async () => {
    expect((await runOnce('claude-opus-5-5')).body.max_tokens).toBe(32_000);
    expect((await runOnce('claude-haiku-4-5')).body.max_tokens).toBe(8192);
    expect((await runOnce('claude-opus-5-5', { maxTokens: 1000 })).body.max_tokens).toBe(1000);
  });

  it('turns a refusal stop into a clear error instead of an empty answer', async () => {
    const { out } = await runOnce('claude-opus-5-5', {}, [
      { type: 'message_start', message: { usage: { input_tokens: 5 } } },
      { type: 'message_delta', delta: { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } }, usage: { output_tokens: 0 } },
    ]);
    const err = out.find(e => e.type === 'error');
    expect(err?.error).toMatch(/declined.*refusal.*cyber/);
    expect(out.some(e => e.type === 'done')).toBe(false);
  });
});

describe('/model lists aliases; setup wizard defaults', () => {
  it('bare /model shows the alias table', async () => {
    const r = await handleSlashCommand('/model', 's', process.cwd(), { defaults: { model: 'claude-opus-5-5' } });
    expect(r.message).toContain('sonnet  → claude-sonnet-5-5');
    expect(r.message).toContain('fable   → claude-fable-5-1');
  });

  it('/model sonnet sets the alias and says what it means', async () => {
    const r = await handleSlashCommand('/model sonnet', 's', process.cwd());
    expect(r.action).toEqual({ type: 'set_model', model: 'sonnet' });
    expect(r.message).toContain('claude-sonnet-5-5');
  });

  it('wizard offers Opus 5.5 (new default) then Sonnet 5.5 as the cloud picks', () => {
    const hw = { tier: 'small', ramGb: 8, gpu: {}, recommendedModels: [] } as unknown as HardwareProfile;
    const values = buildModelChoices(hw, [], []).map(c => c.value);
    expect(CLOUD_DEFAULT_MODEL).toBe('claude-opus-5-5');
    expect(values.indexOf('claude-opus-5-5')).toBeLessThan(values.indexOf('claude-sonnet-5-5'));
    expect(buildModelChoices(hw, [], []).find(c => c.value === 'claude-opus-5-5')!.hint).toContain('new default');
  });
});
