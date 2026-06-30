import { describe, it, expect } from 'vitest';
import { buildModelsUrl, probeProvider } from '../src/setup/provider-test.ts';
import { parsePid, pidFilePath } from '../src/cli/bot-process.ts';
import { dispatchAction } from '../src/cli/dashboard-control.ts';

describe('provider-test', () => {
  it('builds the /models URL, trimming trailing slashes', () => {
    expect(buildModelsUrl('https://openrouter.ai/api/v1')).toBe('https://openrouter.ai/api/v1/models');
    expect(buildModelsUrl('http://localhost:1234/v1/')).toBe('http://localhost:1234/v1/models');
  });
  it('reports a missing key env var without hitting the network', async () => {
    const r = await probeProvider({ baseUrl: 'https://x/v1', keyEnv: 'DEFINITELY_UNSET_KEY_ENV_XYZ' });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/DEFINITELY_UNSET_KEY_ENV_XYZ.*\.env/);
  });
  it('handles no base URL', async () => {
    expect((await probeProvider({ baseUrl: '' })).ok).toBe(false);
  });
});

describe('bot-process (pure bits)', () => {
  it('parses a pid, rejecting junk / non-positive', () => {
    expect(parsePid('1234\n')).toBe(1234);
    expect(parsePid('  77 ')).toBe(77);
    expect(parsePid('0')).toBeNull();
    expect(parsePid('-3')).toBeNull();
    expect(parsePid('nope')).toBeNull();
    expect(parsePid(null)).toBeNull();
  });
  it('pidFilePath lives under ~/.qodex', () => {
    expect(pidFilePath()).toMatch(/\.qodex[/\\]bot\.pid$/);
  });
});

describe('dispatchAction — provider/bot validation (no side effects on the reject path)', () => {
  it('provider.add needs name + baseUrl + keyEnv', async () => {
    expect((await dispatchAction('provider.add', { name: 'x', baseUrl: '' }, '/tmp')).ok).toBe(false);
  });
  it('provider.test / remove on an unknown name fail cleanly', async () => {
    expect((await dispatchAction('provider.test', { name: 'nope-provider-xyz' }, '/tmp')).ok).toBe(false);
    expect((await dispatchAction('provider.remove', { name: 'nope-provider-xyz' }, '/tmp')).ok).toBe(false);
  });
});
