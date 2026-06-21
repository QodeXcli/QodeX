import { describe, it, expect } from 'vitest';
import { buildModelChoices, type ApiCatalogModel } from '../src/setup/wizard.js';
import type { HardwareProfile } from '../src/setup/hardware-profile.js';

// Minimal hardware profile with no recommendations, so the only choices come from
// detected + api models + the fixed cloud trio.
const HW = {
  tier: 'small', ramGb: 8, appleSilicon: false, gpu: {},
  recommendedModels: [] as string[],
} as unknown as HardwareProfile;

describe('buildModelChoices — configured-API model merge (setup wizard)', () => {
  it('adds configured-API models as provider/id choices', () => {
    const api: ApiCatalogModel[] = [
      { provider: 'glm', id: 'glm-5.2', contextWindow: 262144 },
      { provider: 'openrouter', id: 'meta-llama/llama-3.3-70b-instruct' },
    ];
    const choices = buildModelChoices(HW, [], api);
    const values = choices.map(c => c.value);
    expect(values).toContain('glm/glm-5.2');
    expect(values).toContain('openrouter/meta-llama/llama-3.3-70b-instruct');
    // context window surfaces in the hint
    expect(choices.find(c => c.value === 'glm/glm-5.2')!.hint).toContain('262k ctx');
  });

  it('still lists the built-in cloud options after the API models', () => {
    const choices = buildModelChoices(HW, [], [{ provider: 'glm', id: 'glm-5.2' }]);
    const values = choices.map(c => c.value);
    expect(values).toContain('claude-sonnet-4-6');
    // API model comes before the built-in cloud trio
    expect(values.indexOf('glm/glm-5.2')).toBeLessThan(values.indexOf('claude-sonnet-4-6'));
  });

  it('dedupes a repeated provider/id', () => {
    const api: ApiCatalogModel[] = [
      { provider: 'glm', id: 'glm-5.2' },
      { provider: 'glm', id: 'glm-5.2' },
    ];
    const choices = buildModelChoices(HW, [], api);
    expect(choices.filter(c => c.value === 'glm/glm-5.2')).toHaveLength(1);
  });

  it('is a no-op (no API rows) when no configured-API models are passed', () => {
    const choices = buildModelChoices(HW, [], []);
    expect(choices.every(c => !c.hint?.startsWith('API ·'))).toBe(true);
  });
});
