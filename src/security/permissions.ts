import type { QodexConfig } from '../config/defaults.js';
import type { Tool } from '../tools/base.js';
import { assessCommand, canGrantAlways, matchDenyRule, normalizeCommand } from './command-risk.js';

export type PermissionDecision = 'allow' | 'ask' | 'deny';

export interface PermissionRequest {
  tool: string;
  operation: string;        // e.g., shell command, file path
  description?: string;     // human-readable summary
}

export class PermissionEngine {
  private allowPatterns: RegExp[];
  private denyPatterns: RegExp[];
  private alwaysAskPatterns: RegExp[];
  private sessionAllows = new Set<string>();
  private sessionDenies = new Set<string>();
  /** Exact normalized commands the user granted "always". Replaces the old first-word
   *  prefix patterns, which over-granted an entire command family. */
  private commandGrants = new Set<string>();
  /** User deny rules — checked before everything, including auto-approve/yolo. */
  private denyRules: string[] = [];
  private alwaysAllowPatterns: RegExp[] = [];
  private sessionToolAllows = new Set<string>();
  private toolReadOnlyCache = new Map<string, boolean>();

  constructor(
    config: QodexConfig,
    /** Optional registry callback for per-tool read-only lookup. */
    private readonly toolLookup?: (name: string) => Tool<any> | undefined,
  ) {
    this.allowPatterns = config.security.autoApprove.map(p => new RegExp(p));
    this.denyPatterns = config.security.autoReject.map(p => new RegExp(p));
    this.alwaysAskPatterns = (config.security.alwaysAsk ?? []).map(p => new RegExp(p));
    this.denyRules = [...(config.security.denyRules ?? [])];
  }

  /**
   * Returns a non-asking decision based purely on policy.
   * Returns 'ask' when policy is undecided.
   */
  evaluate(req: PermissionRequest): PermissionDecision {
    // User deny rules outrank everything, including /auto and yolo — that is the point of
    // being able to write one.
    if (this.denyRules.length && matchDenyRule(req.operation, this.denyRules)) return 'deny';

    // Hard deny patterns next — even auto-approve mode can't bypass these.
    for (const p of this.denyPatterns) {
      if (p.test(req.operation)) return 'deny';
    }

    // Irreversible commands are confirmed EVERY time. No standing grant, no session
    // auto-approve, no yolo: rollback cannot undo `rm -rf` or a force push, so a blanket
    // yes must never reach one. Read-only tools are exempt (their operand is a path).
    const irreversible =
      !this.isReadOnlyTool(req.tool) && assessCommand(req.operation).tier === 'irreversible';
    if (irreversible) {
      const k = `${req.tool}:${req.operation}`;
      if (this.sessionDenies.has(k)) return 'deny';
      return 'ask';
    }

    // Always-ask patterns next — system-mutating commands (defaults write, sudo,
    // package installs, disk/network config). These OVERRIDE session auto-approve
    // and autoApprove patterns: silently running them risks destabilizing the
    // user's machine, so we force an explicit prompt every time. The only escape
    // is a per-pair/pattern decision the user themselves granted THIS session
    // (handled below), so a user who already said "always allow" for one specific
    // command isn't re-nagged — but `/auto on` alone never covers these.
    const isAlwaysAsk = this.alwaysAskPatterns.some(p => p.test(req.operation));
    if (isAlwaysAsk) {
      const key = `${req.tool}:${req.operation}`;
      if (this.sessionDenies.has(key)) return 'deny';
      if (this.sessionAllows.has(key)) return 'allow';
      if (this.commandGrants.has(normalizeCommand(req.operation))) return 'allow';
      if (this.alwaysAllowPatterns.some(p => p.test(req.operation))) return 'allow';
      return 'ask';
    }

    // Session-wide auto-approve overrides everything except hard denies and
    // always-ask (handled above).
    // Set by `/auto on`; cleared by `/auto off`.
    if (_autoApproveSession) return 'allow';

    // "Allow this tool for the whole session" — from gradient picker
    if (this.sessionToolAllows.has(req.tool)) return 'allow';

    // Session-level deny
    const key = `${req.tool}:${req.operation}`;
    if (this.sessionDenies.has(key)) return 'deny';
    if (this.sessionAllows.has(key)) return 'allow';

    // Exact-command grants from a previous "always" answer.
    if (this.commandGrants.has(normalizeCommand(req.operation))) return 'allow';

    // Legacy pattern grants (kept for any caller still adding them).
    for (const p of this.alwaysAllowPatterns) {
      if (p.test(req.operation)) return 'allow';
    }

    // Auto-approve patterns
    for (const p of this.allowPatterns) {
      if (p.test(req.operation)) return 'allow';
    }

    // For pure read tools: always allow
    if (this.isReadOnlyTool(req.tool)) return 'allow';

    return 'ask';
  }

  /**
   * Persist a decision. Scopes:
   *   - 'once'        — just for this call (no-op here; caller acts)
   *   - 'session'     — until QodeX restart, for THIS exact tool:operation pair
   *   - 'pattern'     — until QodeX restart, for anything matching the command prefix
   *   - 'tool'        — until QodeX restart, ALL invocations of this tool name
   */
  rememberDecision(req: PermissionRequest, decision: 'allow' | 'deny', scope: 'once' | 'session' | 'pattern' | 'tool'): void {
    const key = `${req.tool}:${req.operation}`;
    if (scope === 'session') {
      if (decision === 'allow') this.sessionAllows.add(key);
      else this.sessionDenies.add(key);
    } else if (scope === 'pattern' && decision === 'allow') {
      // A grant binds to the EXACT command, not to its first word. The old behaviour built
      // `^git( |$)` from `git status`, which then auto-approved `git push --force`; and
      // `^rm( |$)` from `rm -rf /tmp/x`, which auto-approved `rm -rf /`. That is the one
      // failure mode rollback cannot undo — the journal covers file writes, not shell
      // commands — so "always" now means "this command", nothing broader.
      if (canGrantAlways(req.operation).allowed) {
        this.commandGrants.add(normalizeCommand(req.operation));
      }
      // Irreversible commands deliberately get NO standing grant: they are asked every time.
    } else if (scope === 'tool' && decision === 'allow') {
      this.sessionToolAllows.add(req.tool);
    }
  }

  /** Why a standing grant was refused, for the UI to explain instead of silently not saving. */
  grantRefusalReason(operation: string): string | null {
    return canGrantAlways(operation).reason ?? null;
  }

  /** User-defined deny rules that override auto-approve and yolo. */
  setDenyRules(rules: readonly string[]): void {
    this.denyRules = [...rules];
  }

  /**
   * Check if a tool is read-only. Uses the registry callback if available
   * (so new tools are automatically recognized via their `isReadOnly` property).
   * Falls back to a hardcoded list for back-compat.
   */
  private isReadOnlyTool(tool: string): boolean {
    if (this.toolLookup) {
      const cached = this.toolReadOnlyCache.get(tool);
      if (cached !== undefined) return cached;
      const t = this.toolLookup(tool);
      if (t) {
        const ro = t.isReadOnly;
        this.toolReadOnlyCache.set(tool, ro);
        return ro;
      }
    }
    // Fallback list for tools we know to be read-only (used when registry unset)
    return [
      'read_file', 'ls', 'glob', 'grep', 'code_graph_find_symbol',
      'code_graph_find_callers', 'code_graph_find_references',
      'code_graph_search_symbols', 'code_graph_list_symbols',
      'code_graph_explain_symbol', 'code_graph_stats',
      'web_search', 'web_fetch', 'todo_read',
      'network_check',
      'browser_screenshot', 'browser_console', 'browser_get_text',
      'dev_server_log', 'dev_server_list',
      'background_job_status', 'background_job_log',
      'background_job_wait', 'background_job_list',
      'vision_analyze',
      'git_status', 'git_diff', 'git_log',
    ].includes(tool);
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// Session-wide auto-approve toggle.
//
// `/auto on` flips this on, making PermissionEngine.evaluate() return 'allow' for
// everything except hard-denied patterns. Single global flag because it's session-
// scoped and reset on process restart — file-system / DB state would be inappropriate.

let _autoApproveSession = false;
export function setAutoApproveSession(enabled: boolean): void { _autoApproveSession = enabled; }
export function getAutoApproveSession(): boolean { return _autoApproveSession; }
