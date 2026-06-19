import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveOllamaVisionModel } from '../src/tools/vision/vision-analyze.js';
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
