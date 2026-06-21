import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveOllamaVisionModel, resolveConfiguredVisionModel } from '../src/tools/vision/vision-analyze.js';
import { looksVisionCapable } from '../src/setup/model-detector.js';
import { setActiveConfig } from '../src/config/loader.js';

const ENV_KEYS = ['QODEX_OLLAMA_VISION_MODEL', 'QODEX_LOCAL_VISION_MODEL'];

describe('resolveOllamaVisionModel — vision model from env or config', () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    setActiveConfig({} as any);
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('returns undefined when nothing is configured', () => {
    expect(resolveOllamaVisionModel()).toBeUndefined();
  });

  it('prefers the env var', () => {
    process.env.QODEX_OLLAMA_VISION_MODEL = 'qwen2.5vl:7b';
    setActiveConfig({ roles: { vision: { provider: 'ollama', model: 'qwen2.5vl:32b' } } } as any);
    expect(resolveOllamaVisionModel()).toBe('qwen2.5vl:7b');
  });

  it('reads roles.vision when its provider is ollama (the intuitive config)', () => {
    setActiveConfig({ roles: { vision: { provider: 'ollama', model: 'qwen2.5vl:32b' } } } as any);
    expect(resolveOllamaVisionModel()).toBe('qwen2.5vl:32b');
  });

  it('falls back to roles.subagent when the vision model was put there (common misconfig)', () => {
    setActiveConfig({ roles: { subagent: { provider: 'ollama', model: 'qwen2.5vl:32b' } } } as any);
    expect(resolveOllamaVisionModel()).toBe('qwen2.5vl:32b');
  });

  it('ignores a roles.vision bound to a non-ollama provider', () => {
    setActiveConfig({ roles: { vision: { provider: 'openai', model: 'gpt-4o' } } } as any);
    expect(resolveOllamaVisionModel()).toBeUndefined();
  });

  it('prefers roles.vision over roles.subagent', () => {
    setActiveConfig({ roles: {
      vision: { provider: 'ollama', model: 'qwen2.5vl:72b' },
      subagent: { provider: 'ollama', model: 'qwen2.5vl:7b' },
    } } as any);
    expect(resolveOllamaVisionModel()).toBe('qwen2.5vl:72b');
  });
});

describe('looksVisionCapable — modern Claude (regression)', () => {
  it('detects Claude 4.x as vision-capable (the old claude-3-only test missed it)', () => {
    expect(looksVisionCapable('claude-sonnet-4-6')).toBe(true);
    expect(looksVisionCapable('claude-haiku-4-5')).toBe(true);
    expect(looksVisionCapable('claude-3-haiku')).toBe(true);
    expect(looksVisionCapable('gemini-2.5-flash')).toBe(true);
    expect(looksVisionCapable('gpt-4o')).toBe(true);
    expect(looksVisionCapable('qwen2.5-coder:7b')).toBe(false);
  });
});

describe('resolveConfiguredVisionModel — use the user\'s own vision-capable API model', () => {
  const KEY = 'TEST_GEMINI_VKEY';
  afterEach(() => { delete process.env[KEY]; });

  const cfgWith = (defaults: any, sub?: any) => ({
    defaults,
    roles: sub ? { subagent: sub } : undefined,
    providers: { custom: [
      { name: 'gemini', apiKeyEnv: KEY, baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/' },
    ] },
  });

  it('routes vision to a vision-capable PRIMARY served by a custom API', () => {
    process.env[KEY] = 'k-123';
    setActiveConfig(cfgWith({ provider: 'gemini', model: 'gemini-2.5-flash' }) as any);
    const r = resolveConfiguredVisionModel();
    expect(r?.model).toBe('gemini-2.5-flash');
    expect(r?.baseUrl).toBe('https://generativelanguage.googleapis.com/v1beta/openai'); // trailing slash trimmed
    expect(r?.apiKey).toBe('k-123');
  });

  it('falls back to the SUB-AGENT when the primary is text-only but the sub-agent can see', () => {
    process.env[KEY] = 'k-123';
    setActiveConfig(cfgWith({ provider: 'glm', model: 'glm-5.2' }, { provider: 'gemini', model: 'gemini-2.5-flash' }) as any);
    expect(resolveConfiguredVisionModel()?.model).toBe('gemini-2.5-flash');
  });

  it('returns undefined when neither primary nor sub-agent is vision-capable', () => {
    process.env[KEY] = 'k-123';
    setActiveConfig(cfgWith({ provider: 'glm', model: 'glm-5.2' }) as any);
    expect(resolveConfiguredVisionModel()).toBeUndefined();
  });

  it('returns undefined when the provider key is not set (can\'t call it)', () => {
    setActiveConfig(cfgWith({ provider: 'gemini', model: 'gemini-2.5-flash' }) as any);
    expect(resolveConfiguredVisionModel()).toBeUndefined();
  });
});
