import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolveRole,
  setSessionRoleOverride,
  getSessionRoleOverride,
  inferProvider,
  effectiveConcurrencyMode,
} from '../src/llm/role-resolver.js';
import type { QodexConfig } from '../src/config/defaults.js';

function makeConfig(overrides: Partial<QodexConfig> = {}): QodexConfig {
  return {
    defaults: {
      provider: 'ollama',
      model: 'qwen2.5-coder:32b',
      preferLocal: true,
      maxIterations: 25,
    },
    providers: {
      ollama: { baseUrl: 'http://localhost:11434' },
      anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },
      openai: { apiKeyEnv: 'OPENAI_API_KEY' },
      deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseUrl: 'https://api.deepseek.com' },
    },
    routing: { planning: 'qwen', toolDecision: 'qwen', codeGeneration: 'qwen', reflection: 'qwen' },
    budget: { dailyLimitUsd: 100, perTaskLimitUsd: 10, perTaskMaxTokens: 1_000_000, perTaskMaxWallSeconds: 300, toolTimeoutSeconds: 60 },
    security: { autoApprove: [], autoReject: [], sandboxShell: false },
    ui: { theme: 'dark', showThinking: true, showTokenCount: false, showCost: true },
    mcp: { servers: {} },
    ...overrides,
  } as QodexConfig;
}

describe('inferProvider', () => {
  it('maps Anthropic model ids', () => {
    expect(inferProvider('claude-sonnet-4-6')).toBe('anthropic');
    expect(inferProvider('claude-haiku-4-5')).toBe('anthropic');
  });
  it('maps OpenAI model ids', () => {
    expect(inferProvider('gpt-4o')).toBe('openai');
    expect(inferProvider('gpt-4o-mini')).toBe('openai');
    expect(inferProvider('o1-preview')).toBe('openai');
    expect(inferProvider('o3-mini')).toBe('openai');
  });
  it('maps DeepSeek model ids', () => {
    expect(inferProvider('deepseek-chat')).toBe('deepseek');
    expect(inferProvider('deepseek-coder')).toBe('deepseek');
  });
  it('defaults to ollama for unknown', () => {
    expect(inferProvider('qwen2.5-coder:32b')).toBe('ollama');
    expect(inferProvider('mixtral:8x22b')).toBe('ollama');
    expect(inferProvider('some-random-model')).toBe('ollama');
  });
});

describe('resolveRole — precedence', () => {
  beforeEach(() => setSessionRoleOverride('subagent', null));

  it('falls back to parent default when no role configured', () => {
    const cfg = makeConfig();
    const r = resolveRole('subagent', cfg);
    expect(r).toEqual({
      provider: 'ollama',
      model: 'qwen2.5-coder:32b',
      source: 'parent-default',
    });
  });

  it('respects config role over parent default', () => {
    const cfg = makeConfig({
      roles: { subagent: { provider: 'ollama', model: 'qwen2.5-coder:7b' } },
    } as any);
    const r = resolveRole('subagent', cfg);
    expect(r).toEqual({
      provider: 'ollama',
      model: 'qwen2.5-coder:7b',
      source: 'config-role',
    });
  });

  it('respects session override over config role', () => {
    const cfg = makeConfig({
      roles: { subagent: { provider: 'ollama', model: 'qwen2.5-coder:7b' } },
    } as any);
    setSessionRoleOverride('subagent', { provider: 'anthropic', model: 'claude-haiku-4-5' });
    const r = resolveRole('subagent', cfg);
    expect(r).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      source: 'session-override',
    });
  });

  it('explicit per-call override wins above everything', () => {
    const cfg = makeConfig({
      roles: { subagent: { provider: 'ollama', model: 'qwen2.5-coder:7b' } },
    } as any);
    setSessionRoleOverride('subagent', { provider: 'anthropic', model: 'claude-haiku-4-5' });
    const r = resolveRole('subagent', cfg, 'gpt-4o-mini');
    expect(r).toEqual({
      provider: 'openai',
      model: 'gpt-4o-mini',
      source: 'explicit',
    });
  });

  it('session override is cleared by setSessionRoleOverride(..., null)', () => {
    setSessionRoleOverride('subagent', { provider: 'openai', model: 'gpt-4o' });
    expect(getSessionRoleOverride('subagent')).toEqual({ provider: 'openai', model: 'gpt-4o' });
    setSessionRoleOverride('subagent', null);
    expect(getSessionRoleOverride('subagent')).toBeNull();
  });
});

describe('effectiveConcurrencyMode', () => {
  it('returns sequential when mode is off or sequential', () => {
    const cfg = makeConfig({ subagents: { mode: 'sequential' } } as any);
    const r = effectiveConcurrencyMode(cfg, 'ollama', 'ollama');
    expect(r.mode).toBe('sequential');
  });

  it('falls back to sequential when both local under auto policy', () => {
    const cfg = makeConfig({ subagents: { mode: 'parallel', concurrencyMode: 'auto' } } as any);
    const r = effectiveConcurrencyMode(cfg, 'ollama', 'ollama');
    expect(r.mode).toBe('sequential');
    expect(r.reason).toMatch(/single-GPU/);
  });

  it('allows parallel when local parent + cloud sub-agent', () => {
    const cfg = makeConfig({ subagents: { mode: 'parallel', concurrencyMode: 'auto' } } as any);
    const r = effectiveConcurrencyMode(cfg, 'ollama', 'anthropic');
    expect(r.mode).toBe('parallel');
    expect(r.reason).toMatch(/distinct compute/);
  });

  it('allows parallel when cloud parent + local sub-agent', () => {
    const cfg = makeConfig({ subagents: { mode: 'parallel', concurrencyMode: 'auto' } } as any);
    const r = effectiveConcurrencyMode(cfg, 'anthropic', 'ollama');
    expect(r.mode).toBe('parallel');
  });

  it('allows parallel when both cloud', () => {
    const cfg = makeConfig({ subagents: { mode: 'parallel', concurrencyMode: 'auto' } } as any);
    const r = effectiveConcurrencyMode(cfg, 'anthropic', 'openai');
    expect(r.mode).toBe('parallel');
  });

  it('force policy overrides the safety check', () => {
    const cfg = makeConfig({ subagents: { mode: 'parallel', concurrencyMode: 'force' } } as any);
    const r = effectiveConcurrencyMode(cfg, 'ollama', 'ollama');
    expect(r.mode).toBe('parallel');
    expect(r.reason).toMatch(/force/);
  });
});
