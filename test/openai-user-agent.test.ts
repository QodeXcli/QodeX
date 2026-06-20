import { describe, it, expect } from 'vitest';
import { OpenAIProvider, DeepSeekProvider } from '../src/llm/providers/openai.js';

/**
 * Regression: the `openai` SDK defaults its User-Agent to `OpenAI/JS <ver>`,
 * which some OpenAI-compatible relays block at a WAF (403 "Your request was
 * blocked"). We override it with `qodex-cli` so requests aren't rejected for
 * impersonating the OpenAI SDK. A caller-supplied User-Agent must still win.
 *
 * The SDK stores constructor options (including `defaultHeaders`) on the
 * instance under `_options`, so we read the header straight off the built client.
 */
function uaOf(provider: any): string | undefined {
  const client = provider.client; // private field; read directly for the assertion
  expect(client, 'provider must build an OpenAI client when an apiKey is present').toBeTruthy();
  const headers = client._options?.defaultHeaders ?? {};
  return headers['User-Agent'];
}

describe('OpenAI client User-Agent override', () => {
  it('builds the client with the qodex-cli User-Agent, not the SDK default', () => {
    const p = new OpenAIProvider({ apiKey: 'sk-test', baseURL: 'https://relay.example/v1' });
    const ua = uaOf(p);
    expect(ua).toBe('qodex-cli');
    expect(ua).not.toMatch(/OpenAI\/JS/i);
  });

  it('lets a caller-supplied User-Agent win over the default', () => {
    const p = new OpenAIProvider({
      apiKey: 'sk-test',
      defaultHeaders: { 'User-Agent': 'custom-agent/9.9' },
    });
    expect(uaOf(p)).toBe('custom-agent/9.9');
  });

  it('keeps the override even when other custom headers are supplied', () => {
    const p = new OpenAIProvider({
      apiKey: 'sk-test',
      defaultHeaders: { Authorization: 'Token abc' },
    });
    const headers = (p as any).client._options?.defaultHeaders ?? {};
    expect(headers['User-Agent']).toBe('qodex-cli');
    expect(headers['Authorization']).toBe('Token abc');
  });

  it('applies the same override to the DeepSeek provider', () => {
    const p = new DeepSeekProvider({ apiKey: 'sk-test' });
    const ua = uaOf(p);
    expect(ua).toBe('qodex-cli');
    expect(ua).not.toMatch(/OpenAI\/JS/i);
  });

  it('does not build a client (nothing to assert on) when no apiKey is present', () => {
    const p = new OpenAIProvider({});
    expect((p as any).client).toBeNull();
  });
});
