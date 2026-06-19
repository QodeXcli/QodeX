import { logger } from '../utils/logger.js';
import { runHook } from './executor.js';
import type {
  HookConfig,
  HookContext,
  HookEvent,
  HooksConfig,
  DispatchResult,
} from './types.js';

/**
 * Common tool-arg field names that hold file paths. Extracted into env so hooks like
 * `prettier --write $QODEX_FILE_PATHS` work without knowing per-tool arg shapes.
 */
const FILE_PATH_ARG_KEYS = new Set([
  'path', 'file_path', 'filepath', 'filename',
  'paths', 'files', 'file_paths', 'target',
]);

export function extractFilePathsFromArgs(args: unknown): string[] {
  if (!args || typeof args !== 'object') return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (!FILE_PATH_ARG_KEYS.has(k)) continue;
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) {
      for (const item of v) if (typeof item === 'string') out.push(item);
    }
  }
  return out;
}

export class HooksManager {
  constructor(private cfg: HooksConfig = {}) {}

  /** Returns true if any hook is registered for the event. Cheap check before building context. */
  hasAny(event: HookEvent): boolean {
    return (this.cfg[event] ?? []).length > 0;
  }

  /** Returns all hooks for an event (after matcher filtering when toolName is supplied). */
  matching(event: HookEvent, toolName?: string): HookConfig[] {
    const all = this.cfg[event] ?? [];
    if (!toolName || (event !== 'PreToolUse' && event !== 'PostToolUse')) {
      return all;
    }
    return all.filter(h => {
      if (!h.matcher) return true;
      try {
        return new RegExp(h.matcher).test(toolName);
      } catch {
        // Invalid regex → literal substring match (forgiving)
        return toolName.includes(h.matcher);
      }
    });
  }

  /** Convenience: how many hooks would dispatch for this event/tool combination. */
  countMatching(event: HookEvent, toolName?: string): number {
    return this.matching(event, toolName).length;
  }

  /**
   * Dispatch an event. Hooks run sequentially in declaration order so users have
   * predictable ordering (e.g. lint before format). Returns aggregated results plus
   * an optional vetoMessage when a blocking PreToolUse hook exited non-zero.
   */
  async dispatch(event: HookEvent, ctx: HookContext): Promise<DispatchResult> {
    const hooks = this.matching(event, ctx.toolName);
    if (hooks.length === 0) {
      return { outputs: [], ranCount: 0, runs: [] };
    }

    const runs = [];
    const outputs: string[] = [];
    const blockingMessages: string[] = [];

    for (const hook of hooks) {
      const result = await runHook(hook, ctx);
      runs.push(result);

      logger.info(`Hook [${event}] ${result.hookName}: exit=${result.exitCode} dur=${result.durationMs}ms${result.timedOut ? ' (TIMEOUT)' : ''}`);

      const out = result.stdout.trim();
      if (out) outputs.push(out);

      // Veto policy applies only to PreToolUse, and only when hook.blocking !== false
      const isBlocking = event === 'PreToolUse' && (hook.blocking ?? true);
      if (isBlocking && result.exitCode !== 0) {
        const msg = out || result.stderr.trim() || `Hook ${result.hookName} exited ${result.exitCode}`;
        blockingMessages.push(msg);
      }
    }

    return {
      outputs,
      ranCount: runs.length,
      runs,
      ...(blockingMessages.length > 0 ? { vetoMessage: blockingMessages.join('\n---\n') } : {}),
    };
  }

  /** Used by /hooks slash command to enumerate registered hooks. */
  list(): Array<{ event: HookEvent; index: number; config: HookConfig }> {
    const events: HookEvent[] = ['PreToolUse', 'PostToolUse', 'SessionStart', 'SessionEnd', 'PreCompact'];
    const out: Array<{ event: HookEvent; index: number; config: HookConfig }> = [];
    for (const ev of events) {
      const hooks = this.cfg[ev] ?? [];
      hooks.forEach((h, i) => out.push({ event: ev, index: i, config: h }));
    }
    return out;
  }
}

// Singleton wiring — bootstrap creates it; loop & slash commands read it via getter.
let _manager: HooksManager | null = null;
export function setHooksManager(m: HooksManager): void { _manager = m; }
export function getHooksManager(): HooksManager | null { return _manager; }
