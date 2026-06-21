import { describe, it, expect } from 'vitest';
import { slugifyProviderName, buildCustomEntry } from '../src/setup/gateways.js';

/**
 * Regression for the `provider add <url>` bug: the URL was stored as the provider
 * NAME (e.g. "https://api.203668.xyz/v1"), which the config loader rejects
 * ("name must not contain spaces or /"), so the provider was silently dropped and
 * the configured default model became unreachable. The name must be slugified to
 * a valid identifier while the baseUrl keeps the full URL — and the API key must
 * never leak into a config field.
 */
describe('slugifyProviderName', () => {
  it('reduces a URL to a valid host slug (the exact bug)', () => {
    expect(slugifyProviderName('https://api.203668.xyz/v1')).toBe('api-203668-xyz');
  });
  it('passes a plain one-word name through unchanged', () => {
    expect(slugifyProviderName('myhost')).toBe('myhost');
  });
  it('lowercases and dashes spaces/symbols', () => {
    expect(slugifyProviderName('My Cool API!')).toBe('my-cool-api');
  });
  it('strips scheme and trailing path/port', () => {
    expect(slugifyProviderName('http://localhost:1234/v1')).toBe('localhost-1234');
  });
  it('trims leading/trailing dashes', () => {
    expect(slugifyProviderName('  --weird--  ')).toBe('weird');
  });
  it('never yields a name containing space, "/" or ":"', () => {
    for (const raw of ['https://a.b.c/v1', 'A B/C:D', 'x://y/z']) {
      expect(slugifyProviderName(raw)).not.toMatch(/[\s/:]/);
    }
  });
});

describe('buildCustomEntry — name safety + no key leakage', () => {
  it('slugifies a URL passed as the custom name, keeping baseUrl intact', () => {
    const e = buildCustomEntry({
      name: 'https://api.203668.xyz/v1',
      baseUrl: 'https://api.203668.xyz/v1',
      apiKeyEnv: 'GLM_API_KEY',
      modelId: 'glm-5.2',
    });
    expect(e.name).toBe('api-203668-xyz');
    expect(e.name).not.toMatch(/[\s/:]/); // the loader would have rejected this
    expect(e.baseUrl).toBe('https://api.203668.xyz/v1'); // URL preserved
    expect(e.models?.[0]?.id).toBe('glm-5.2');
  });

  it('the API key never lands in a config field (name/baseUrl/apiKeyEnv)', () => {
    // The entry stores only an env-var NAME, never the secret itself.
    const e = buildCustomEntry({
      name: 'glm',
      baseUrl: 'https://api.203668.xyz/v1',
      apiKeyEnv: 'GLM_API_KEY',
      modelId: 'glm-5.2',
    });
    const serialized = JSON.stringify(e);
    expect(serialized).not.toMatch(/sk-/);            // no key-looking secret
    expect(e.apiKeyEnv).toBe('GLM_API_KEY');          // only the env-var name
    expect(e.baseUrl).toBe('https://api.203668.xyz/v1'); // baseUrl is a URL, not a key
    expect(e.baseUrl.startsWith('http')).toBe(true);
  });

  it('throws on an invalid provider name rather than silently writing it', () => {
    // Defense for the spec path (not slugified) — an invalid name must fail loudly,
    // not get written and silently dropped at config load.
    expect(() => buildCustomEntry({
      spec: { name: 'bad/name', baseUrl: 'https://x/v1', apiKeyEnv: 'K', title: 'x' } as any,
    })).toThrow(/invalid provider name/i);
  });
});
