import { describe, it, expect, vi } from 'vitest';
import {
  classifyDispatch,
  resolveCheapModel,
  offloadOverride,
  routeWithOffload,
  toolsetIsReadOnly,
  type OffloadDispatch,
} from '../src/llm/offload-policy.js';
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

/** Config with offload ON and a cheap model configured via roles.offload. */
function enabledConfig(extra: Partial<QodexConfig> = {}): QodexConfig {
  return makeConfig({
    offload: { enabled: true },
    roles: { offload: { provider: 'ollama', model: 'qwen2.5-coder:7b' } },
    ...extra,
  } as any);
}

const COMPACTION: OffloadDispatch = { kind: 'compaction', taskClass: 'general', estimatedTokens: 12_000, mutating: false };

describe('classifyDispatch', () => {
  it('marks the safe set cheap-ok', () => {
    expect(classifyDispatch({ kind: 'compaction' })).toBe('cheap-ok');
    expect(classifyDispatch({ kind: 'summarization' })).toBe('cheap-ok');
    expect(classifyDispatch({ kind: 'scout' })).toBe('cheap-ok');
    expect(classifyDispatch({ kind: 'title' })).toBe('cheap-ok');
  });

  it('never marks plan / main-turn / final-answer cheap-ok', () => {
    expect(classifyDispatch({ kind: 'plan' })).toBe('needs-main');
    expect(classifyDispatch({ kind: 'main-turn' })).toBe('needs-main');
    expect(classifyDispatch({ kind: 'final-answer' })).toBe('needs-main');
  });

  it('a mutating dispatch needs main whatever its kind claims', () => {
    expect(classifyDispatch({ kind: 'scout', mutating: true })).toBe('needs-main');
    expect(classifyDispatch({ kind: 'compaction', mutating: true })).toBe('needs-main');
  });
});

describe('toolsetIsReadOnly', () => {
  it('accepts a pure recon toolset', () => {
    expect(toolsetIsReadOnly(['read_file', 'grep', 'git_diff', 'web_fetch'])).toBe(true);
  });
  it('rejects any mutating tool and unknown/empty sets', () => {
    expect(toolsetIsReadOnly(['read_file', 'edit_file'])).toBe(false);
    expect(toolsetIsReadOnly(['shell'])).toBe(false);
    expect(toolsetIsReadOnly([])).toBe(false);
    expect(toolsetIsReadOnly(undefined)).toBe(false);
  });
});

describe('resolveCheapModel', () => {
  it('prefers roles.offload over roles.subagent', () => {
    const cfg = makeConfig({
      roles: {
        offload: { provider: 'ollama', model: 'qwen2.5-coder:7b' },
        subagent: { provider: 'anthropic', model: 'claude-haiku-4-5' },
      },
    } as any);
    expect(resolveCheapModel(cfg)).toEqual({ provider: 'ollama', model: 'qwen2.5-coder:7b', source: 'roles.offload' });
  });

  it('falls back to roles.subagent', () => {
    const cfg = makeConfig({ roles: { subagent: { provider: 'anthropic', model: 'claude-haiku-4-5' } } } as any);
    expect(resolveCheapModel(cfg)).toEqual({ provider: 'anthropic', model: 'claude-haiku-4-5', source: 'roles.subagent' });
  });

  it('infers the provider when the role entry omits it', () => {
    const cfg = makeConfig({ roles: { offload: { model: 'claude-haiku-4-5' } } } as any);
    expect(resolveCheapModel(cfg)?.provider).toBe('anthropic');
  });

  it('returns null when no cheap model is configured', () => {
    expect(resolveCheapModel(makeConfig())).toBeNull();
  });
});

describe('offloadOverride', () => {
  it('is disabled by default — no override even with a cheap model configured', () => {
    const cfg = makeConfig({ roles: { offload: { provider: 'ollama', model: 'qwen2.5-coder:7b' } } } as any);
    expect(offloadOverride(COMPACTION, cfg)).toBeNull();
  });

  it('returns the override only when enabled AND a cheap model resolves', () => {
    const r = offloadOverride(COMPACTION, enabledConfig());
    expect(r).toEqual({ provider: 'ollama', model: 'qwen2.5-coder:7b', source: 'roles.offload' });
    // Enabled but nothing to offload to → null
    expect(offloadOverride(COMPACTION, makeConfig({ offload: { enabled: true } } as any))).toBeNull();
  });

  it('never offloads plan / mutating / final-answer dispatches', () => {
    const cfg = enabledConfig();
    expect(offloadOverride({ kind: 'plan' }, cfg)).toBeNull();
    expect(offloadOverride({ kind: 'final-answer' }, cfg)).toBeNull();
    expect(offloadOverride({ kind: 'main-turn' }, cfg)).toBeNull();
    expect(offloadOverride({ kind: 'scout', mutating: true }, cfg)).toBeNull();
  });

  it('skips the no-op offload when the cheap model IS the main default', () => {
    const cfg = makeConfig({
      offload: { enabled: true },
      roles: { offload: { provider: 'ollama', model: 'qwen2.5-coder:32b' } }, // == defaults.model
    } as any);
    expect(offloadOverride(COMPACTION, cfg)).toBeNull();
  });
});

describe('routeWithOffload — the compaction dispatch path (mock router)', () => {
  it('pins the cheap model via explicitModel when the policy fires', () => {
    const route = vi.fn().mockReturnValue({ model: 'qwen2.5-coder:7b' });
    const r = routeWithOffload({ route }, 'general', 12_000, COMPACTION, enabledConfig());
    expect(route).toHaveBeenCalledTimes(1);
    expect(route).toHaveBeenCalledWith('general', 12_000, { explicitModel: 'qwen2.5-coder:7b' });
    expect(r.offloaded).toEqual({ provider: 'ollama', model: 'qwen2.5-coder:7b', source: 'roles.offload' });
    expect(r.route).toEqual({ model: 'qwen2.5-coder:7b' });
  });

  it('routes normally (no explicitModel) when offload is disabled — the default', () => {
    const route = vi.fn().mockReturnValue({ model: 'qwen2.5-coder:32b' });
    const cfg = makeConfig({ roles: { offload: { provider: 'ollama', model: 'qwen2.5-coder:7b' } } } as any);
    const r = routeWithOffload({ route }, 'general', 12_000, COMPACTION, cfg);
    expect(route).toHaveBeenCalledWith('general', 12_000, {});
    expect(r.offloaded).toBeNull();
  });

  it('falls back to the normal route when the cheap model is unresolvable', () => {
    // Router throws on the pinned cheap model (provider down / not pulled) — the dispatch
    // must still succeed on the class route. Offload never breaks a call.
    const route = vi.fn()
      .mockImplementationOnce(() => { throw new Error('Model not available: qwen2.5-coder:7b'); })
      .mockReturnValueOnce({ model: 'qwen2.5-coder:32b' });
    const r = routeWithOffload({ route }, 'general', 12_000, COMPACTION, enabledConfig());
    expect(route).toHaveBeenCalledTimes(2);
    expect(route).toHaveBeenLastCalledWith('general', 12_000, {});
    expect(r.offloaded).toBeNull();
    expect(r.route).toEqual({ model: 'qwen2.5-coder:32b' });
  });

  it('never consults the cheap model for a needs-main dispatch', () => {
    const route = vi.fn().mockReturnValue({ model: 'qwen2.5-coder:32b' });
    const r = routeWithOffload({ route }, 'planning', 5_000, { kind: 'plan' }, enabledConfig());
    expect(route).toHaveBeenCalledTimes(1);
    expect(route).toHaveBeenCalledWith('planning', 5_000, {});
    expect(r.offloaded).toBeNull();
  });
});
