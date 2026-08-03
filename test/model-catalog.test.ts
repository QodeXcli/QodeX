import { describe, it, expect } from 'vitest';
import {
  resolveCapability, lookupCatalog, liveContextWindow, liveMaxOutput,
  catalogPatterns, UNKNOWN_MODEL_DEFAULT, livePricing,
} from '../src/llm/model-catalog.js';
import { fillModelDefaults, mapDiscoveredModels } from '../src/llm/providers/custom-config.js';

describe('live provider metadata wins', () => {
  // The original bug: mapDiscoveredModels called fillModelDefaults({ id }) and threw the
  // rest of the gateway's response away, so every discovered model became 128k.
  it('uses context_length from an OpenRouter-style response', () => {
    const cap = resolveCapability('some-unknown-model', { id: 'x', context_length: 1_000_000 });
    expect(cap.contextWindow).toBe(1_000_000);
    expect(cap.source).toBe('live');
  });

  it('uses max_context_length from an LM Studio-style response', () => {
    expect(resolveCapability('local-model', { max_context_length: 262_144 }).contextWindow).toBe(262_144);
  });

  it('reads a NESTED window (OpenRouter top_provider)', () => {
    const cap = resolveCapability('m', { top_provider: { context_length: 400_000 } });
    expect(cap.contextWindow).toBe(400_000);
    expect(cap.source).toBe('live');
  });

  it('accepts a numeric string', () => {
    expect(resolveCapability('m', { context_length: '200000' }).contextWindow).toBe(200_000);
  });

  it('live metadata OVERRIDES the catalog, even downward', () => {
    // A gateway serving a trimmed build of a known model is authoritative about it.
    const cap = resolveCapability('kimi-k2', { context_length: 32_000 });
    expect(cap.contextWindow).toBe(32_000);
    expect(cap.source).toBe('live');
  });

  it('never lets maxOutput exceed the window', () => {
    const cap = resolveCapability('claude-opus-4', { context_length: 10_000 });
    expect(cap.maxOutput).toBeLessThanOrEqual(10_000);
  });

  it('ignores junk values instead of trusting them', () => {
    for (const bad of [0, -5, 'abc', null, undefined, NaN]) {
      expect(liveContextWindow({ context_length: bad })).toBeUndefined();
    }
  });

  it('returns undefined when the entry carries no window at all', () => {
    expect(liveContextWindow({ id: 'm', object: 'model', owned_by: 'x' })).toBeUndefined();
  });
});

describe('catalog fallback — the models that were wrong or missing', () => {
  it('knows Kimi (the model that prompted this) at 256k, not 128k', () => {
    const cap = resolveCapability('kimi-k2.7-code');
    expect(cap.contextWindow).toBe(262_144);
    expect(cap.source).toBe('catalog');
  });

  it('fixes the stale qwen3-coder guess (was 32k, really 256k)', () => {
    expect(resolveCapability('qwen3-coder:30b').contextWindow).toBe(262_144);
  });

  it('fixes the stale deepseek guess (was 16k, really 128k)', () => {
    expect(resolveCapability('deepseek-v3').contextWindow).toBe(131_072);
  });

  it('knows the 1M+ windows a flat 128k default was hiding', () => {
    expect(resolveCapability('gemini-2.5-pro').contextWindow).toBeGreaterThanOrEqual(1_000_000);
    expect(resolveCapability('gpt-4.1').contextWindow).toBeGreaterThanOrEqual(1_000_000);
    expect(resolveCapability('minimax-m2').contextWindow).toBeGreaterThanOrEqual(1_000_000);
  });

  it('marks an unknown model as a guess, and guesses CONSERVATIVELY', () => {
    const cap = resolveCapability('totally-made-up-model-9000');
    expect(cap.source).toBe('default');
    expect(cap.contextWindow).toBe(UNKNOWN_MODEL_DEFAULT.contextWindow);
    // Over-estimating is the dangerous direction: the agent packs a context the model then
    // truncates server-side, which looks like the model "forgetting" mid-task.
    expect(cap.contextWindow).toBeLessThan(128_000);
  });

  it('is case-insensitive', () => {
    expect(resolveCapability('KIMI-K2').contextWindow).toBe(resolveCapability('kimi-k2').contextWindow);
  });
});

describe('catalog ordering — specific patterns must precede general ones', () => {
  // Getting this wrong is silent: 'qwen' would swallow 'qwen3-coder' and report 32k.
  const pairs: [string, string][] = [
    ['qwen3-coder', 'qwen'],
    ['qwen2.5-coder', 'qwen'],
    ['gpt-4o-mini', 'gpt-4o'],
    ['deepseek-r1', 'deepseek'],
    ['llama3.3', 'llama'],
    ['mistral-large', 'mistral'],
    ['claude-opus-4', 'claude'],
    ['kimi-k2', 'kimi'],
  ];
  const patterns = catalogPatterns();

  for (const [specific, general] of pairs) {
    it(`"${specific}" is listed before "${general}"`, () => {
      const si = patterns.indexOf(specific);
      const gi = patterns.indexOf(general);
      expect(si, `${specific} missing from catalog`).toBeGreaterThanOrEqual(0);
      expect(gi, `${general} missing from catalog`).toBeGreaterThanOrEqual(0);
      expect(si).toBeLessThan(gi);
    });
  }

  it('matches the most specific pattern, not merely the first plausible one', () => {
    expect(lookupCatalog('qwen3-coder:30b')?.matched).toBe('qwen3-coder');
    expect(lookupCatalog('gpt-4o-mini')?.matched).toBe('gpt-4o-mini');
  });
});

describe('fillModelDefaults / mapDiscoveredModels', () => {
  it('an explicit user value still wins over everything', () => {
    const m = fillModelDefaults({ id: 'kimi-k2', contextWindow: 999 });
    expect(m!.contextWindow).toBe(999);
  });

  it('a discovered model keeps the window the gateway advertised', () => {
    const models = mapDiscoveredModels({
      data: [
        { id: 'big-model', context_length: 1_000_000 },
        { id: 'kimi-k2.7-code' },                       // no metadata → catalog
        { id: 'mystery-model' },                        // nothing known → conservative
      ],
    });
    expect(models.find(m => m.id === 'big-model')!.contextWindow).toBe(1_000_000);
    expect(models.find(m => m.id === 'kimi-k2.7-code')!.contextWindow).toBe(262_144);
    expect(models.find(m => m.id === 'mystery-model')!.contextWindow).toBe(UNKNOWN_MODEL_DEFAULT.contextWindow);
  });

  it('no discovered model is silently pinned to the old flat 128k', () => {
    const models = mapDiscoveredModels({ data: [{ id: 'kimi-k2' }, { id: 'gemini-2.5-pro' }] });
    for (const m of models) expect(m.contextWindow).not.toBe(128_000);
  });

  it('still tolerates a bare string list', () => {
    const models = mapDiscoveredModels({ data: ['kimi-k2'] });
    expect(models[0]!.contextWindow).toBe(262_144);
  });

  it('rejects entries with no id', () => {
    expect(fillModelDefaults({})).toBeNull();
    expect(mapDiscoveredModels({ data: [{ object: 'model' }] })).toEqual([]);
  });
});

describe('liveMaxOutput', () => {
  it('reads the common spellings', () => {
    expect(liveMaxOutput({ max_output_tokens: 8000 })).toBe(8000);
    expect(liveMaxOutput({ max_completion_tokens: 4096 })).toBe(4096);
  });
  it('is used even when no window was advertised', () => {
    const cap = resolveCapability('kimi-k2', { max_output_tokens: 999 });
    expect(cap.maxOutput).toBe(999);
    expect(cap.source).toBe('catalog'); // window still came from the catalog
  });
});

describe('pricing — the "$0.00 for a model that costs money" bug', () => {
  it('reads OpenRouter-style per-TOKEN pricing and scales it to per-million', () => {
    const cap = resolveCapability('x', { pricing: { prompt: '0.0000006', completion: '0.0000025' } });
    expect(cap.inputCostPerMillion).toBeCloseTo(0.6, 6);
    expect(cap.outputCostPerMillion).toBeCloseTo(2.5, 6);
    expect(cap.pricingSource).toBe('live');
  });

  it('does not double-scale a provider that already quotes per-million', () => {
    const cap = resolveCapability('x', { pricing: { prompt: 3, completion: 15 } });
    expect(cap.inputCostPerMillion).toBe(3);
    expect(cap.outputCostPerMillion).toBe(15);
  });

  it('falls back to catalog pricing for a known model', () => {
    const cap = resolveCapability('kimi-k2');
    expect(cap.pricingSource).toBe('catalog');
    expect(cap.inputCostPerMillion).toBeGreaterThan(0);
  });

  it('marks an unpriced model UNKNOWN — never a silent $0', () => {
    const cap = resolveCapability('some-gateway-model-nobody-knows');
    expect(cap.pricingSource).toBe('unknown');
    // The 0 is a placeholder; the SOURCE is what callers must check before trusting spend.
    expect(cap.inputCostPerMillion).toBe(0);
  });

  it('distinguishes genuinely free (local) from unpriced', () => {
    const local = resolveCapability('qwen3-coder:30b', undefined, { local: true });
    expect(local.pricingSource).toBe('free');
    expect(resolveCapability('qwen3-coder:30b').pricingSource).not.toBe('free');
  });

  it('preserves an explicitly quoted zero as live (free tiers are real)', () => {
    const cap = resolveCapability('x', { pricing: { prompt: 0, completion: 0 } });
    expect(cap.pricingSource).toBe('live');
    expect(cap.inputCostPerMillion).toBe(0);
  });

  it('ignores malformed pricing rather than trusting it', () => {
    expect(livePricing({ pricing: { prompt: 'free' } })).toBeUndefined();
    expect(livePricing({ pricing: null })).toBeUndefined();
    expect(livePricing({})).toBeUndefined();
  });

  it('a discovered model carries its pricing source through fillModelDefaults', () => {
    const [priced, unpriced] = mapDiscoveredModels({
      data: [
        { id: 'a', pricing: { prompt: '0.000003', completion: '0.000015' } },
        { id: 'totally-unknown-thing' },
      ],
    });
    expect(priced!.inputCostPerMillion).toBeCloseTo(3, 6);
    expect(priced!.pricingSource).toBe('live');
    expect(unpriced!.pricingSource).toBe('unknown');
  });
});
