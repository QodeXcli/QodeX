/**
 * Token-efficiency auto-offload policy — decides which LLM dispatches are safe to route
 * to a CHEAP model instead of the main one. Opt-in via `offload.enabled` (default false).
 *
 * The classification is deliberately conservative. 'cheap-ok' covers only dispatches whose
 * output the user never reads verbatim and that can't mutate anything:
 *   - context compaction / summarization calls (lossy by design — a small model is fine)
 *   - read-only scout sub-agents (recon for the parent to act on)
 *   - title / log-line generation
 * Everything else — plan mode, edit/mutating turns, the final user-facing answer, and the
 * main conversation turn itself — is 'needs-main' and NEVER offloaded.
 *
 * The cheap model resolves as `roles.offload.model` → `roles.subagent.model` → none
 * (no cheap model configured ⇒ the policy is a no-op even when enabled).
 *
 * PURE: no I/O, no config loading, no router import cycle — the caller supplies the config
 * and (for routeWithOffload) a router-like object, so tests can mock everything.
 */

import type { QodexConfig } from '../config/defaults.js';
import type { TaskClass } from './router.js';
import { inferProvider } from './role-resolver.js';

/** What kind of LLM dispatch is being made. Callers stamp this at the callsite. */
export type DispatchKind =
  | 'compaction'      // auto-compaction / /compact summarizer call
  | 'summarization'   // other non-user-facing summarize calls
  | 'scout'           // read-only sub-agent recon (gather tool / role:'scout')
  | 'title'           // one-line titles / log lines
  | 'main-turn'       // the parent conversation turn — never offloaded
  | 'plan'            // plan-mode dispatch — never offloaded
  | 'final-answer';   // the final user-facing answer — never offloaded

export interface OffloadDispatch {
  kind: DispatchKind;
  /** Already-computed task class from the loop's classifier (informational for logs). */
  taskClass?: TaskClass;
  /** Estimated prompt tokens — the "savings" figure for the offload log line. */
  estimatedTokens?: number;
  /** True when the dispatch can run mutating tools (edit/shell/git…). Mutating ⇒ needs-main. */
  mutating?: boolean;
}

/**
 * Tool names treated as read-only for offload purposes. Mirrors the scout role's default
 * allow-list in loop.ts `runSubagent` — keep the two in sync when adding recon tools.
 */
const READ_ONLY_TOOLS = new Set([
  'read_file', 'ls', 'glob', 'grep', 'semantic_search',
  'project_overview', 'explain_codebase', 'data_flow', 'analyze_impact', 'find_dead_code',
  'git_status', 'git_diff', 'git_log',
  'db_schema', 'db_query', 'openapi_digest', 'backend_routemap',
  'web_search', 'web_fetch', 'media_probe',
  'project_recall', 'recall',
]);

/** True when EVERY tool in the set is known read-only. Unknown/empty set ⇒ assume mutating. */
export function toolsetIsReadOnly(tools: string[] | undefined): boolean {
  if (!tools || tools.length === 0) return false;
  return tools.every(t => READ_ONLY_TOOLS.has(t));
}

/** Classify a dispatch: safe on a cheap model, or must stay on the main one. PURE. */
export function classifyDispatch(d: OffloadDispatch): 'cheap-ok' | 'needs-main' {
  // A dispatch that can mutate is never cheap-ok, whatever its kind claims.
  if (d.mutating) return 'needs-main';
  switch (d.kind) {
    case 'compaction':
    case 'summarization':
    case 'scout':
    case 'title':
      return 'cheap-ok';
    default:
      // main-turn / plan / final-answer / anything future-unknown → main model.
      return 'needs-main';
  }
}

export interface OffloadTarget {
  provider: string;
  model: string;
  /** Where the cheap model came from — for logs / the /roles listing. */
  source: 'roles.offload' | 'roles.subagent';
}

/**
 * Resolve the cheap model: `roles.offload` wins, else `roles.subagent`, else none.
 * Provider falls back to inferProvider(model) when the role entry omits it. PURE.
 */
export function resolveCheapModel(config: QodexConfig): OffloadTarget | null {
  const roles = (config as any).roles as Record<string, { provider?: string; model?: string } | undefined> | undefined;
  const offloadRole = roles?.['offload'];
  if (offloadRole?.model) {
    return { provider: offloadRole.provider ?? inferProvider(offloadRole.model), model: offloadRole.model, source: 'roles.offload' };
  }
  const subagentRole = roles?.['subagent'];
  if (subagentRole?.model) {
    return { provider: subagentRole.provider ?? inferProvider(subagentRole.model), model: subagentRole.model, source: 'roles.subagent' };
  }
  return null;
}

/**
 * The policy entry point: return the cheap-model override for this dispatch, or null.
 * Null whenever: offload disabled (the default), the dispatch needs the main model,
 * no cheap model is configured, or the "cheap" model IS the main default (zero savings —
 * an offload log line would be misleading noise).
 */
export function offloadOverride(d: OffloadDispatch, config: QodexConfig): OffloadTarget | null {
  if ((config as any).offload?.enabled !== true) return null;   // opt-in, default OFF
  if (classifyDispatch(d) !== 'cheap-ok') return null;
  const target = resolveCheapModel(config);
  if (!target) return null;
  if (target.model === config.defaults.model) return null;      // no-op offload guard
  return target;
}

/** Minimal router surface the offload path needs — lets tests supply a mock. */
export interface RouterLike<R> {
  route(taskClass: TaskClass, contextTokens: number, options?: { explicitModel?: string }): R;
}

/**
 * Route a dispatch through the offload policy: when it fires, pin the cheap model via
 * the router's explicitModel path; otherwise (or when the cheap model isn't resolvable
 * by the router — e.g. its provider isn't running) fall back to the normal class route.
 * Offload must never break a dispatch, so the fallback is unconditional on error.
 */
export function routeWithOffload<R>(
  router: RouterLike<R>,
  taskClass: TaskClass,
  contextTokens: number,
  dispatch: OffloadDispatch,
  config: QodexConfig,
): { route: R; offloaded: OffloadTarget | null } {
  const target = offloadOverride(dispatch, config);
  if (target) {
    try {
      return { route: router.route(taskClass, contextTokens, { explicitModel: target.model }), offloaded: target };
    } catch {
      // Cheap model unknown to the router (not pulled / provider down) — degrade silently.
    }
  }
  return { route: router.route(taskClass, contextTokens, {}), offloaded: null };
}
