/**
 * Role resolver — picks the right (provider, model) for a given role.
 *
 * Precedence, highest to lowest:
 *   1. Per-call explicit override         (e.g. `task` tool args)
 *   2. Slash-command session override     (e.g. `/subagent-model claude-haiku-4-5`)
 *   3. Config `roles.<role>.{provider, model}`
 *   4. Parent default (config.defaults.{provider, model})
 *
 * This lives apart from the router so the resolution logic is pure and testable.
 * The router still does the actual model dispatch — we just decide WHICH model.
 *
 * Why a separate module: as we add more roles (summarization, planning), they all share
 * the same precedence rules. Putting this logic in AgentLoop would copy-paste it.
 */

import type { QodexConfig } from '../config/defaults.js';

/**
 * Role names QodeX understands. Open string type — config.roles is a Record,
 * so users can define custom roles. Built-ins listed here are the ones the
 * agent loop / built-in tools know about.
 */
export type RoleName = 'subagent' | 'vision' | 'summarization' | 'planning' | string;

export interface ResolvedRole {
  // Built-in provider OR a custom gateway name (providers.custom[].name).
  provider: 'ollama' | 'anthropic' | 'openai' | 'deepseek' | (string & {});
  model: string;
  /** How we arrived at this choice — useful in logs and `/roles` output. */
  source: 'explicit' | 'session-override' | 'config-role' | 'parent-default';
}

/**
 * Session-scoped overrides set by slash commands. Cleared on process restart.
 * Keyed by role name → ResolvedRole (minus source, which we re-stamp).
 */
type SessionOverride = { provider: ResolvedRole['provider']; model: string };
const _sessionOverrides = new Map<RoleName, SessionOverride>();

export function setSessionRoleOverride(role: RoleName, choice: SessionOverride | null): void {
  if (choice === null) _sessionOverrides.delete(role);
  else _sessionOverrides.set(role, choice);
}

export function getSessionRoleOverride(role: RoleName): SessionOverride | null {
  return _sessionOverrides.get(role) ?? null;
}

/**
 * Resolve a role to a concrete (provider, model). Pure function with respect to its
 * inputs — session overrides live in module-level state but are read-only from here.
 *
 * @param role          role name (currently always 'subagent')
 * @param config        the active QodexConfig
 * @param explicitModel optional per-call override — e.g. the `task` tool's model arg
 */
export function resolveRole(
  role: RoleName,
  config: QodexConfig,
  explicitModel?: string,
): ResolvedRole {
  // 1. Explicit per-call wins. We have to infer the provider from the model id
  //    because callers (`task` tool) only pass the model string.
  if (explicitModel) {
    return {
      provider: inferProvider(explicitModel),
      model: explicitModel,
      source: 'explicit',
    };
  }

  // 2. Session override (from `/subagent-model <id>` or `/role-model <name> <id>`)
  const session = _sessionOverrides.get(role);
  if (session) {
    return { provider: session.provider, model: session.model, source: 'session-override' };
  }

  // 3. Config-level role binding — try exact role first
  const rolesMap = (config as any).roles as Record<string, { provider: ResolvedRole['provider']; model: string } | undefined> | undefined;
  const roleConfig = rolesMap?.[role];
  if (roleConfig?.model) {
    return { provider: roleConfig.provider, model: roleConfig.model, source: 'config-role' };
  }

  // 4. Fall back to roles.subagent if a different role was requested but unconfigured.
  //    This makes "I asked for vision but didn't set it up" gracefully degrade rather
  //    than silently using the parent model (which probably isn't vision-capable).
  if (role !== 'subagent') {
    const subagentConfig = rolesMap?.['subagent'];
    if (subagentConfig?.model) {
      return { provider: subagentConfig.provider, model: subagentConfig.model, source: 'config-role' };
    }
  }

  // 5. Last resort: parent default
  return {
    provider: config.defaults.provider,
    model: config.defaults.model,
    source: 'parent-default',
  };
}

/**
 * Infer provider from model id. Heuristic — used when a caller passes only a model
 * string (e.g. `task({ model: 'claude-haiku-4-5' })`). Matches our KNOWN_MODELS prefixes.
 *
 * Falls back to 'ollama' for unknown ids (most local models don't have a fixed prefix).
 */
export function inferProvider(modelId: string): ResolvedRole['provider'] {
  if (modelId.startsWith('claude-')) return 'anthropic';
  if (modelId.startsWith('gpt-') || modelId.startsWith('o1') || modelId.startsWith('o3')) return 'openai';
  if (modelId.startsWith('deepseek-')) return 'deepseek';
  // Ollama-style names: `qwen2.5-coder:32b`, `mixtral:8x22b`, `deepseek-v3`.
  // The colon-tag is a strong Ollama signal; bare names default to ollama too.
  return 'ollama';
}

/**
 * Concurrency policy check: should sub-agents actually run in parallel?
 *
 * Rule of thumb: parallel only helps when the workers don't share a GPU with the parent.
 *   - parent local + sub-agent local  → serial (single GPU bottleneck), sequential
 *   - parent local + sub-agent cloud  → parallel OK (cloud has its own compute)
 *   - parent cloud + sub-agent local  → parallel OK (worker compute is local but not shared)
 *   - parent cloud + sub-agent cloud  → parallel OK (different API endpoints)
 *
 * `force` mode overrides this — useful for benchmarking. Default is `auto`.
 *
 * Returns the *effective* mode (which may differ from configured if `auto` decided to
 * fall back) along with a human-readable reason for /roles or wizard output.
 */
export function effectiveConcurrencyMode(
  config: QodexConfig,
  parentProvider: ResolvedRole['provider'],
  subagentProvider: ResolvedRole['provider'],
): { mode: 'sequential' | 'parallel'; reason: string } {
  const configured = (config as any).subagents?.mode as 'off' | 'sequential' | 'parallel' | undefined;
  const policy = (config as any).subagents?.concurrencyMode as 'auto' | 'force' | undefined;

  if (configured !== 'parallel') {
    return { mode: 'sequential', reason: `configured mode = ${configured ?? 'sequential'}` };
  }
  if (policy === 'force') {
    return { mode: 'parallel', reason: 'concurrencyMode=force (override)' };
  }

  // auto policy — parallel only if at least one side is non-local
  const parentLocal = parentProvider === 'ollama';
  const subLocal = subagentProvider === 'ollama';
  if (parentLocal && subLocal) {
    return {
      mode: 'sequential',
      reason: 'both parent and sub-agent are local — single-GPU serialization, parallel offers no speedup',
    };
  }
  return {
    mode: 'parallel',
    reason: `${parentLocal ? 'parent-local' : 'parent-cloud'} + ${subLocal ? 'sub-local' : 'sub-cloud'}: distinct compute paths`,
  };
}
