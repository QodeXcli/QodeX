import * as path from 'path';
import type { QodexConfig } from '../config/defaults.js';
import type { Tool } from '../tools/base.js';
import { assessAnalysis, canGrantAlways, matchDenyRule, matchesAtCommandPosition, normalizeCommand } from './command-risk.js';
import { compileAllowRules, matchAllowRule, type AllowMatcher } from './allow-rules.js';
import { analyzeShell, isNeutralSegment, type ShellAnalysis } from './shell-analyze.js';
import { autonomousDecision, editPathDecision, isCommandTool, isFileEditTool, workspaceRoots, type AutoPolicyContext } from './autonomy.js';

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
  /** Auto mode: the autonomous policy (src/security/autonomy.ts) allowed it. */
  | 'auto-policy'
  /** Auto mode: the policy asks a human (outside-project destructive, remote, system-level). */
  | 'auto-policy-ask'
  | 'ask';

/** evaluate() plus the words a prompt shows. */
export interface PermissionExplanation {
  decision: PermissionDecision;
  via: PermissionVia;
  /** Why it asks (or denies), in words — shown in the prompt and the audit trail. */
  reason?: string;
  /**
   * Whether an "always yes" answer can stop this prompt. "always yes" switches the session
   * to auto mode, so it is offered only when the auto policy would run this without asking.
   */
  canAlways: boolean;
}

/**
 * How permission prompts are answered this session. Cycle with Shift+Tab.
 *   - manual: ask before file edits and shell commands.
 *   - edits:  file edits run without asking; shell still asks (was called "auto").
 *   - auto:   autonomous — nothing asks except purchases, payments, passwords, sending
 *             messages (Sentinel critical) and destructive actions outside the project
 *             (see src/security/autonomy.ts). Replaces the old "always yes".
 */
export type ApprovalMode = 'manual' | 'edits' | 'auto';

export const APPROVAL_MODES: readonly ApprovalMode[] = ['manual', 'edits', 'auto'];

export const APPROVAL_MODE_META: Record<ApprovalMode, { label: string; hint: string }> = {
  manual: { label: 'manual', hint: 'Ask before file edits and shell commands.' },
  edits: { label: 'edits', hint: 'File edits run without asking; shell still asks.' },
  auto: { label: 'auto', hint: 'Autonomous: runs without asking. Still asks for purchases, payments, passwords, sending messages and destructive actions outside the project.' },
};

/** File-mutating tools that "edits" (accept-edits) covers. Shell / MCP stay on evaluate(). */
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
  if (s === 'edits' || s === 'accept' || s === 'accept-edits' || s === 'accept_edits') return 'edits';
  if (s === 'auto' || s === 'autonomous' || s === 'always' || s === 'on' || s === 'yes' || s === 'always-yes' || s === 'always_yes' || s === 'yolo') return 'auto';
  return null;
}

export interface PermissionRequest {
  tool: string;
  operation: string;        // e.g., shell command, file path
  description?: string;     // human-readable summary
  /** Working directory of the call (tools pass ctx.cwd). Relative paths and `cd` resolve
   *  against it, and it is the project root auto mode trusts. Defaults to process.cwd(). */
  cwd?: string;
}

type Decided = { decision: PermissionDecision; via: PermissionVia; reason?: string };

export class PermissionEngine {
  private allowPatterns: RegExp[];
  private denyPatterns: RegExp[];
  private alwaysAskPatterns: RegExp[];
  private sessionAllows = new Set<string>();
  private sessionDenies = new Set<string>();
  /** Exact normalized commands the user granted "always". Replaces the old first-word
   *  prefix patterns, which over-granted an entire command family. */
  private commandGrants = new Set<string>();
  /** User deny rules — checked before everything, including auto mode. */
  private denyRules: string[] = [];
  private alwaysAllowPatterns: RegExp[] = [];
  private sessionToolAllows = new Set<string>();
  private toolReadOnlyCache = new Map<string, boolean>();
  /** Literal /regex allow-list from `execution.allow` — same rank as autoApprove. */
  private executionAllow: AllowMatcher[];
  /** Extra workspace roots for auto mode (user config `approval.extraRoots`). */
  private extraRoots: string[];
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
    const extra = (config as any).approval?.extraRoots;
    this.extraRoots = Array.isArray(extra) ? extra.filter((r: unknown): r is string => typeof r === 'string') : [];
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
  evaluateDetailed(req: PermissionRequest): { decision: PermissionDecision; via: PermissionVia; reason?: string } {
    const r = this.decide(req);
    try { this.onDecision?.(req, r.decision, r.via); } catch { /* */ }
    return r;
  }

  /**
   * What a prompt needs to know about a request: the decision, WHY, and whether "always yes"
   * could stop this prompt. Does not fire the audit hook (the caller already evaluated).
   */
  explain(req: PermissionRequest): PermissionExplanation {
    const r = this.decide(req);
    return { ...r, canAlways: r.decision === 'ask' && this.autoWouldAllow(req) };
  }

  /** Workspace roots for a request: its cwd, `approval.extraRoots` and the temp dir. */
  policyContext(req: { cwd?: string }): AutoPolicyContext {
    const cwd = path.resolve(req.cwd || process.cwd());
    return { cwd, roots: workspaceRoots(cwd, this.extraRoots) };
  }

  /** Would the autonomous policy run this without asking? */
  private autoWouldAllow(req: PermissionRequest): boolean {
    if (this.isReadOnlyTool(req.tool)) return true;
    try {
      return autonomousDecision(req, this.policyContext(req)).decision === 'allow';
    } catch {
      return false;
    }
  }

  private decide(req: PermissionRequest): Decided {
    // User deny rules outrank everything, including auto mode — that is the point of
    // being able to write one.
    if (this.denyRules.length) {
      const rule = matchDenyRule(req.operation, this.denyRules);
      if (rule) return { decision: 'deny', via: 'deny-rule', reason: `matches your deny rule "${rule}"` };
    }

    // Hard deny patterns next — no mode can bypass these.
    for (const p of this.denyPatterns) {
      if (p.test(req.operation)) return { decision: 'deny', via: 'deny-pattern', reason: `matches security.autoReject (${p.source})` };
    }

    const key = `${req.tool}:${req.operation}`;
    const commandTool = isCommandTool(req.tool);

    // Auto mode: the autonomous policy decides (src/security/autonomy.ts). It asks only for
    // destructive actions outside the project, remote-destructive / publish / deploy, and
    // system-level commands. No grant ("always yes", a session allow) can switch those off:
    // they are exactly the cases the user wants to see. Sentinel-critical actions never come
    // through here — Sentinel asks a human for them in every mode.
    if (_approvalMode === 'auto') {
      if (this.sessionDenies.has(key)) return { decision: 'deny', via: 'session-pair', reason: 'you declined this for the session' };
      if (this.isReadOnlyTool(req.tool)) return { decision: 'allow', via: 'read-only' };
      const v = autonomousDecision(req, this.policyContext(req));
      if (v.decision === 'ask') return { decision: 'ask', via: 'auto-policy-ask', reason: v.reason ?? 'auto mode asks a human for this' };
      if (v.decision === 'deny') return { decision: 'deny', via: 'auto-policy', reason: v.reason ?? 'blocked by the auto-mode policy' };
      return { decision: 'allow', via: 'auto-policy' };
    }

    // manual / edits. Command-only rules (irreversible tier, always-ask patterns, per-segment
    // allow rules) run ONLY for command-executing tools, and by command position — never on
    // an edit path (`src/shutdown.ts`), an MCP tool name or a mission goal.
    let analysis: ShellAnalysis | null = null;
    let pctx: AutoPolicyContext | null = null;
    const ctx = () => (pctx ??= this.policyContext(req));
    if (commandTool) {
      analysis = analyzeShell(req.operation, ctx());
      // Irreversible commands are confirmed EVERY time. No standing grant, no session
      // allow: rollback cannot undo `rm -rf` or a force push.
      const risk = assessAnalysis(analysis);
      if (risk.tier === 'irreversible') {
        if (this.sessionDenies.has(key)) return { decision: 'deny', via: 'session-pair', reason: 'you declined this for the session' };
        return { decision: 'ask', via: 'irreversible', reason: `${risk.reason} (irreversible — confirmed every time)` };
      }
      // Always-ask patterns — system-mutating commands. These OVERRIDE `edits` and the
      // allow rules. The escape hatch is a per-command grant this session, or auto mode.
      if (this.alwaysAskPatterns.some(p => matchesAtCommandPosition(p, analysis!))) {
        if (this.sessionDenies.has(key)) return { decision: 'deny', via: 'session-pair' };
        if (this.sessionAllows.has(key)) return { decision: 'allow', via: 'session-pair' };
        if (this.commandGrants.has(normalizeCommand(req.operation))) return { decision: 'allow', via: 'command-grant' };
        if (this.legacyAllows(analysis)) return { decision: 'allow', via: 'allow-rule' };
        return { decision: 'ask', via: 'always-ask', reason: 'system-changing command (security.alwaysAsk)' };
      }
    }

    // edits (accept-edits): file edits inside the project run. Outside the project they ask
    // — this mode must never be looser than auto.
    let editReason: string | undefined;
    if (_approvalMode === 'edits' && isAutoEditTool(req.tool)) {
      const v = editPathDecision(req.operation, ctx());
      if (v.decision === 'allow') return { decision: 'allow', via: 'mode-auto-edit' };
      editReason = `${v.reason} — edits mode only accepts edits inside the project`;
    }

    // "Allow this tool for the whole session" — from gradient picker
    if (this.sessionToolAllows.has(req.tool)) return { decision: 'allow', via: 'session-tool' };

    // Session-level pair
    if (this.sessionDenies.has(key)) return { decision: 'deny', via: 'session-pair', reason: 'you declined this for the session' };
    if (this.sessionAllows.has(key)) return { decision: 'allow', via: 'session-pair' };

    // Exact-command grants from a previous "always" answer.
    if (this.commandGrants.has(normalizeCommand(req.operation))) return { decision: 'allow', via: 'command-grant' };

    // Allow rules: auto-approve regexes, execution.allow literals and legacy grants. For a
    // command, EVERY segment must match one (`ls && git push` is not `ls`), and nothing may
    // write outside the project (`echo hi > ~/.bashrc` is not `echo`).
    if (analysis ? this.segmentsAllowed(analysis) : this.ruleAllows(req.operation)) {
      return { decision: 'allow', via: 'allow-rule' };
    }

    // For pure read tools: always allow
    if (this.isReadOnlyTool(req.tool)) return { decision: 'allow', via: 'read-only' };

    const mode = _approvalMode;
    const reason = editReason
      ?? (commandTool ? `${mode} mode asks before shell commands that are not on your allow list`
        : isFileEditTool(req.tool) ? `${mode} mode asks before file edits` : undefined);
    return reason ? { decision: 'ask', via: 'ask', reason } : { decision: 'ask', via: 'ask' };
  }

  /** One text against every allow source (autoApprove regex, execution.allow, legacy grants). */
  private ruleAllows(text: string): boolean {
    return this.allowPatterns.some(p => p.test(text))
      || matchAllowRule(text, this.executionAllow)
      || this.alwaysAllowPatterns.some(p => p.test(text));
  }

  private legacyAllows(a: ShellAnalysis): boolean {
    if (!this.alwaysAllowPatterns.length || a.parseError || a.outsideWrites.length) return false;
    const segs = a.segments.filter(s => !isNeutralSegment(s));
    return segs.length > 0 && segs.every(s => this.alwaysAllowPatterns.some(p => p.test(s.ruleText)));
  }

  /** Every executed segment matches an allow rule and nothing writes outside the project. */
  private segmentsAllowed(a: ShellAnalysis): boolean {
    if (a.parseError || a.outsideWrites.length) return false;
    const segs = a.segments.filter(s => !isNeutralSegment(s));
    if (!segs.length) return false;
    return segs.every(s => this.ruleAllows(s.ruleText));
  }

  /**
   * Persist a decision. Scopes:
   *   - 'once'        — just for this call (no-op here; caller acts)
   *   - 'session'     — until QodeX restart, for THIS exact tool:operation pair
   *   - 'pattern'     — until QodeX restart, for this exact (normalized) command
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
      // Irreversible commands get NO standing grant (they are asked every time), and neither
      // does anything auto mode itself would ask about (outside the project, remote,
      // system-level): "always yes" must never turn those into silent yeses.
      if (canGrantAlways(req.operation).allowed && this.autoWouldAllow(req)) {
        this.commandGrants.add(normalizeCommand(req.operation));
      }
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
    return FALLBACK_READ_ONLY_TOOLS.has(tool);
  }
}

/**
 * Tools known to be read-only, used when the engine has no registry lookup (or the
 * lookup does not know the tool). Every engine QodeX builds passes `(n) => registry.get(n)`
 * (src/index.ts, the MCP server's tool context, the workflow CLI).
 * Every entry MUST be `isReadOnly` in the real registry (test/core-review.test.ts checks
 * this): Sentinel's permission step auto-allows "pure reads", so a mutating or
 * Sentinel-guarded tool listed here would skip the user's approval. Page/screen tools that
 * must run in model order after an action — browser_screenshot / browser_get_text /
 * browser_console / browser_network / browser_downloads (Sentinel-guarded) /
 * computer_use_screenshot — are non-read-only and deliberately NOT here.
 */
export const FALLBACK_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'read_file', 'ls', 'glob', 'grep', 'code_graph_find_symbol',
  'code_graph_find_callers', 'code_graph_find_references',
  'code_graph_search_symbols', 'code_graph_list_symbols',
  'code_graph_explain_symbol', 'code_graph_stats',
  'web_search', 'web_fetch', 'todo_read',
  'network_check',
  'browser_status',
  'computer_use_screen_info', 'computer_use_active_window', 'computer_use_list_windows',
  'workflow_list', 'workflow_show',
  'mission_status', 'mission_list',
  'vault_list',
  'dev_server_log', 'dev_server_list',
  'background_job_status', 'background_job_log',
  'background_job_wait', 'background_job_list',
  'vision_analyze',
  'git_status', 'git_diff', 'git_log',
]);

// ────────────────────────────────────────────────────────────────────────────────
// Session-wide approval mode.
//
// Shift+Tab cycles manual → edits → auto. `/auto on` is "auto"; `/auto off` is
// "manual". Module-global because it's session-scoped and reset on process restart.

let _approvalMode: ApprovalMode = 'manual';

export function getApprovalMode(): ApprovalMode { return _approvalMode; }
/** Legacy 'always' (the old "always yes") is the autonomous 'auto' mode now. */
export function setApprovalMode(mode: ApprovalMode | 'always'): void { _approvalMode = mode === 'always' ? 'auto' : mode; }
/** True in the autonomous 'auto' mode. */
export function isAutonomousMode(): boolean { return _approvalMode === 'auto'; }
export function cycleApprovalMode(): ApprovalMode {
  const i = APPROVAL_MODES.indexOf(_approvalMode);
  _approvalMode = APPROVAL_MODES[(i + 1) % APPROVAL_MODES.length]!;
  return _approvalMode;
}

/** @deprecated Prefer setApprovalMode. `true` = auto, `false` = manual. */
export function setAutoApproveSession(enabled: boolean): void {
  _approvalMode = enabled ? 'auto' : 'manual';
}
/** True only in the autonomous 'auto' mode — not in accept-edits 'edits'. */
export function getAutoApproveSession(): boolean { return _approvalMode === 'auto'; }
