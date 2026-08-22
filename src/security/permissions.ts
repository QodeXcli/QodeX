import type { QodexConfig } from '../config/defaults.js';
import type { Tool } from '../tools/base.js';
import { assessCommand, canGrantAlways, matchDenyRule, normalizeCommand } from './command-risk.js';
import { compileAllowRules, matchAllowRule, type AllowMatcher } from './allow-rules.js';

export type PermissionDecision = 'allow' | 'ask' | 'deny';

/** Why evaluate() returned what it did — used by the audit trail and tests. */
export type PermissionVia =
  | 'deny-rule'
  | 'deny-pattern'
  | 'irreversible'
  | 'always-ask'
  | 'mode-always'
  | 'mode-auto-edit'
  | 'session-tool'
  | 'session-pair'
  | 'command-grant'
  | 'allow-rule'
  | 'read-only'
  | 'ask';

/** How the TUI answers permission prompts this session. Cycle with Shift+Tab. */
export type ApprovalMode = 'manual' | 'auto' | 'always';

export const APPROVAL_MODES: readonly ApprovalMode[] = ['manual', 'auto', 'always'];

export const APPROVAL_MODE_META: Record<ApprovalMode, { label: string; hint: string }> = {
  manual: { label: 'manual', hint: 'Ask before file edits and shell commands.' },
  auto: { label: 'auto', hint: 'File edits run without asking; shell still asks.' },
  always: { label: 'always yes', hint: 'Tools run without asking. Hard-deny and irreversible still stop.' },
};

/** File-mutating tools that "auto" (accept-edits) covers. Shell / MCP stay on evaluate(). */
const AUTO_EDIT_TOOLS = new Set([
  'write_file',
  'edit_text',
  'multi_edit',
  'multi_file_edit',
  'edit_symbol',
]);

export function isAutoEditTool(tool: string): boolean {
  return AUTO_EDIT_TOOLS.has(tool);
}

/** Picker labels that mean session-wide always yes (not a one-shot accept). PURE. */
export function isAlwaysYesAnswer(answer: string): boolean {
  const a = (answer || '').trim().toLowerCase();
  return a === 'always' || a === 'always yes' || a === 'always-yes' || a === 'alwaysyes';
}

const ONE_SHOT_ALLOW = new Set(['yes', 'y', 'accept', 'ok', 'allow', 'approve', 'بله', 'آره']);

/**
 * How a permission prompt answer should be read. Unrecognized text is deny —
 * shell/MCP used to treat anything that wasn't "no" as yes, so a bot typed
 * reply of "sure"/"ok wait" ran the command.
 */
export function interpretPermissionAnswer(answer: string): 'allow' | 'always' | 'deny' {
  const a = (answer || '').trim().toLowerCase();
  if (isAlwaysYesAnswer(a)) return 'always';
  if (ONE_SHOT_ALLOW.has(a)) return 'allow';
  return 'deny';
}

export function parseApprovalMode(raw: string): ApprovalMode | null {
  const s = raw.trim().toLowerCase();
  if (s === 'manual' || s === 'off' || s === 'ask') return 'manual';
  if (s === 'auto' || s === 'edits' || s === 'accept') return 'auto';
  if (s === 'always' || s === 'on' || s === 'yes' || s === 'always-yes' || s === 'always_yes' || s === 'yolo') return 'always';
  return null;
}

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
  /** Literal /regex allow-list from `execution.allow` — same rank as autoApprove. */
  private executionAllow: AllowMatcher[];
  /** Optional hook (audit log). Never required; a throw here is swallowed. */
  onDecision?: (req: PermissionRequest, decision: PermissionDecision, via: PermissionVia) => void;

  constructor(
    config: QodexConfig,
    /** Optional registry callback for per-tool read-only lookup. */
    private readonly toolLookup?: (name: string) => Tool<any> | undefined,
  ) {
    this.allowPatterns = config.security.autoApprove.map(p => new RegExp(p));
    this.denyPatterns = config.security.autoReject.map(p => new RegExp(p));
    this.alwaysAskPatterns = (config.security.alwaysAsk ?? []).map(p => new RegExp(p));
    this.denyRules = [...(config.security.denyRules ?? [])];
    this.executionAllow = compileAllowRules((config as any).execution?.allow);
  }

  /**
   * Returns a non-asking decision based purely on policy.
   * Returns 'ask' when policy is undecided.
   */
  evaluate(req: PermissionRequest): PermissionDecision {
    const r = this.decide(req);
    try { this.onDecision?.(req, r.decision, r.via); } catch { /* audit must not stall */ }
    return r.decision;
  }

  /** Same as evaluate, plus the reason — for tests and the audit trail. */
  evaluateDetailed(req: PermissionRequest): { decision: PermissionDecision; via: PermissionVia } {
    const r = this.decide(req);
    try { this.onDecision?.(req, r.decision, r.via); } catch { /* */ }
    return r;
  }

  private decide(req: PermissionRequest): { decision: PermissionDecision; via: PermissionVia } {
    // User deny rules outrank everything, including /auto and yolo — that is the point of
    // being able to write one.
    if (this.denyRules.length && matchDenyRule(req.operation, this.denyRules)) {
      return { decision: 'deny', via: 'deny-rule' };
    }

    // Hard deny patterns next — even auto-approve mode can't bypass these.
    for (const p of this.denyPatterns) {
      if (p.test(req.operation)) return { decision: 'deny', via: 'deny-pattern' };
    }

    // Irreversible commands are confirmed EVERY time. No standing grant, no session
    // auto-approve, no yolo: rollback cannot undo `rm -rf` or a force push, so a blanket
    // yes must never reach one. Read-only tools are exempt (their operand is a path).
    const irreversible =
      !this.isReadOnlyTool(req.tool) && assessCommand(req.operation).tier === 'irreversible';
    if (irreversible) {
      const k = `${req.tool}:${req.operation}`;
      if (this.sessionDenies.has(k)) return { decision: 'deny', via: 'session-pair' };
      return { decision: 'ask', via: 'irreversible' };
    }

    // always yes (Shift+Tab / picker): skip the hub for ordinary work AND always-ask
    // (sudo, brew, …). Hard-deny and irreversible already returned above.
    if (_approvalMode === 'always') return { decision: 'allow', via: 'mode-always' };

    // Always-ask patterns — system-mutating commands. These OVERRIDE `auto` (accept
    // edits) and autoApprove regexes, but not `always yes`. The escape hatch is a
    // per-command grant this session, or switching to always yes.
    const isAlwaysAsk = this.alwaysAskPatterns.some(p => p.test(req.operation));
    if (isAlwaysAsk) {
      const key = `${req.tool}:${req.operation}`;
      if (this.sessionDenies.has(key)) return { decision: 'deny', via: 'session-pair' };
      if (this.sessionAllows.has(key)) return { decision: 'allow', via: 'session-pair' };
      if (this.commandGrants.has(normalizeCommand(req.operation))) return { decision: 'allow', via: 'command-grant' };
      if (this.alwaysAllowPatterns.some(p => p.test(req.operation))) return { decision: 'allow', via: 'allow-rule' };
      return { decision: 'ask', via: 'always-ask' };
    }

    if (_approvalMode === 'auto' && isAutoEditTool(req.tool)) return { decision: 'allow', via: 'mode-auto-edit' };

    // "Allow this tool for the whole session" — from gradient picker
    if (this.sessionToolAllows.has(req.tool)) return { decision: 'allow', via: 'session-tool' };

    // Session-level deny
    const key = `${req.tool}:${req.operation}`;
    if (this.sessionDenies.has(key)) return { decision: 'deny', via: 'session-pair' };
    if (this.sessionAllows.has(key)) return { decision: 'allow', via: 'session-pair' };

    // Exact-command grants from a previous "always" answer.
    if (this.commandGrants.has(normalizeCommand(req.operation))) return { decision: 'allow', via: 'command-grant' };

    // Legacy pattern grants (kept for any caller still adding them).
    for (const p of this.alwaysAllowPatterns) {
      if (p.test(req.operation)) return { decision: 'allow', via: 'allow-rule' };
    }

    // Auto-approve regex + execution.allow literals — same rank, hub is never asked.
    if (this.allowPatterns.some(p => p.test(req.operation))) return { decision: 'allow', via: 'allow-rule' };
    if (matchAllowRule(req.operation, this.executionAllow)) return { decision: 'allow', via: 'allow-rule' };

    // For pure read tools: always allow
    if (this.isReadOnlyTool(req.tool)) return { decision: 'allow', via: 'read-only' };

    return { decision: 'ask', via: 'ask' };
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
// Session-wide approval mode.
//
// Shift+Tab cycles manual → auto → always. `/auto on` is "always"; `/auto off` is
// "manual". Module-global because it's session-scoped and reset on process restart.

let _approvalMode: ApprovalMode = 'manual';

export function getApprovalMode(): ApprovalMode { return _approvalMode; }
export function setApprovalMode(mode: ApprovalMode): void { _approvalMode = mode; }
export function cycleApprovalMode(): ApprovalMode {
  const i = APPROVAL_MODES.indexOf(_approvalMode);
  _approvalMode = APPROVAL_MODES[(i + 1) % APPROVAL_MODES.length]!;
  return _approvalMode;
}

/** @deprecated Prefer setApprovalMode. `true` = always, `false` = manual. */
export function setAutoApproveSession(enabled: boolean): void {
  _approvalMode = enabled ? 'always' : 'manual';
}
/** True only in "always yes" — not in accept-edits `auto`. */
export function getAutoApproveSession(): boolean { return _approvalMode === 'always'; }
