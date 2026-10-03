/**
 * Sentinel guard — the SentinelGuard implementation that sits at the single
 * tool-execution choke point (ToolRegistry.execute), so it covers the main
 * loop, sub-agents, missions and the MCP server alike.
 *
 * beforeTool:
 *   1. fast exit for tools that are never guarded (most coding tools);
 *   2. gather context best-effort: the active tab URL and the element behind a
 *      ref/selector via the ALREADY RUNNING browser manager (never launches one;
 *      1.5 s cap), or the recorded workflow a workflow_run would replay;
 *   3. classify (policy.ts, pure) and decide:
 *      - policy block (blocked domain, QodeX secret store, ...) → [SENTINEL_BLOCKED];
 *      - no category / low risk → allow;
 *      - category in sentinel.autoApprove, or approved "always" for this
 *        category+domain earlier in the session (non-critical only) → allow;
 *      - CRITICAL (category in sentinel.requireApproval) → an explicit human
 *        answer, independent of `/auto on` and `--yes`: the interactive
 *        terminal's askUser (brokered, so remote channels can answer too) when a
 *        human is at this process, else the ApprovalBroker's remote channels
 *        (control center / Telegram / mission queue) with a timeout, else refuse;
 *      - HIGH / MEDIUM → the normal permission engine (`sentinel:<category> ...`
 *        operation), asking yes / no / always when it is undecided;
 *      - HIGH / MEDIUM in the autonomous 'auto' approval mode → allowed without a
 *        prompt (still audited), except deleting / changing data on a remote service
 *        and uploading files from outside the project (auto-mode.ts), which ask with
 *        the reason; the user's deny rules still refuse;
 *   4. every meaningful decision → audit log + bus event {kind:'sentinel'}.
 *
 * afterTool: tools flagged `untrustedOutput` — plus web_fetch / web_search /
 * remote http_request and MCP tools — get their text scanned for prompt
 * injection and fenced as data (injection.ts). "Already fenced" is decided by
 * the result's metadata, never by its text (page text could start with a fake
 * fence). Every result also has control-center access tokens masked.
 *
 * preflight: the same review for the agent loop to run BEFORE it arms a tool's
 * timeout (a remote approval can take minutes); an allowed preflight leaves a
 * one-shot pass so the registry's beforeTool for that same ctx doesn't ask twice.
 *
 * Fails closed: an internal error while reviewing a guarded call refuses it.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { DEFAULT_SENTINEL_CONFIG, resolveSentinelConfig, type SentinelConfig } from '../config/agent-config.js';
import { getActiveConfig } from '../config/loader.js';
import { QODEX_WORKFLOWS_DIR, sanitizeName } from '../config/paths.js';
import { getBus } from '../control/bus.js';
import {
  getApprovalBroker, isApproval, isInteractiveHuman, normalizeAnswer, type ApprovalBroker,
} from '../control/approvals.js';
import type { ToolContext, ToolResult } from '../tools/base.js';
import { peekBrowserManager, type BrowserManager, type ElementInfo } from '../tools/browser/types.js';
import { normalizeWorkflowName } from '../workflows/types.js';
import { SentinelAudit, redactForAudit } from './audit.js';
import { fenceUntrusted, injectionBanner, scanInjection } from './injection.js';
import {
  classifyAction, isEnterKey, isGuardedTool, isPrivateHost, isSpaceKey, maskControlTokens, maskSecrets, parseTarget, scriptSelectors,
  type ControlCenterLike,
  type PolicyClassification, type PolicyContext, type ProtectedPaths, type WorkflowLike,
} from './policy.js';
import type { ActionClassification, SentinelDecision, SentinelGuard } from './types.js';
import {
  AUTO_MODE_ASKS, autoModeAskReason, clearSentinelApproval, isAutonomousContext, recordSentinelApproval, rootsFor,
} from './auto-mode.js';
import { getGrantStore, bareAddress, type GrantStore } from '../grants/store.js';
import { getReceivedIndex, type ReceivedIndex } from '../grants/received.js';
import { MAIL_SEND_TOOL, checkMailReplyScope, factsFromArgs, resolveMailSend, type MailSendResolution } from '../grants/mail-scope.js';
import { publishMailEvent } from '../grants/mail-events.js';

export interface SentinelOptions {
  /** Config source (default: resolveSentinelConfig(getActiveConfig())). */
  config?: () => SentinelConfig;
  /** Audit writer; null disables auditing regardless of config. */
  audit?: SentinelAudit | null;
  /** Where recorded workflows live (workflow_run review). */
  workflowsDir?: string;
  protectedPaths?: ProtectedPaths;
  /** Browser manager accessor (default: peekBrowserManager — never launches). */
  browser?: () => BrowserManager | null;
  /** Cap for element introspection, ms. Default 1500. */
  describeTimeoutMs?: number;
  broker?: () => ApprovalBroker;
  /** Is a human sitting at this process's askUser? Default: isInteractiveHuman(). */
  interactive?: () => boolean;
  /**
   * The control center running in this process (default: src/control/server.ts
   * getControlCenter(), loaded lazily). Its port and token are off-limits to the agent.
   */
  controlCenter?: () => { port?: number; token?: string; url?: string; urls?: string[]; tunnelUrl?: string } | null;
  /** Standing grants (default: ~/.qodex/grants.json). */
  grants?: () => GrantStore;
  /** Received-mail index used to scope mail-reply grants (default: ~/.qodex/mail-auto/received.json). */
  receivedIndex?: () => ReceivedIndex;
}

/** Outcome of a review, before any prompting. */
export interface SentinelVerdict {
  decision: SentinelDecision;
  /** policy | low-risk | auto-approve | session | permission | auto-mode | needs-human | needs-permission | auto-asks | no-human */
  via: string;
  /** Auto mode: why this still needs a human (shown in the prompt and to remote channels). */
  autoReason?: string;
}

const CRITICAL_OPTIONS = ['yes', 'no'];
const ASK_OPTIONS = ['yes', 'no', 'always'];

/**
 * Extra option on a mail_send prompt that is a plain same-thread reply to the original
 * sender: a human picking it creates a standing mail-reply grant for that account +
 * sender (src/grants) — the only way an approval prompt creates a grant.
 */
export const ALWAYS_REPLIES_OPTION = 'always allow replies like this';

/** Channels whose answer is not a human's (the safe option they return never picks the grant option, but be explicit). */
const NON_HUMAN_BY = new Set(['timeout', 'abort', 'fallback', 'local-error', 'reset', 'cancel', 'error']);

interface ReplyOffer { account: string; from: string }

type MailGrantCheck =
  | { allowed: true; grantId: string; used: number; cap: number; recipient: string; account: string; subject: string }
  | { allowed: false; offer: ReplyOffer | null; note?: string };

/** Insert lines just above the closing question of a Sentinel prompt. */
function beforeQuestion(prompt: string, lines: string[]): string {
  const add = lines.filter(Boolean);
  if (!add.length) return prompt;
  const q = '\nAllow this action?';
  return prompt.endsWith(q) ? `${prompt.slice(0, -q.length)}\n${add.join('\n')}${q}` : `${prompt}\n${add.join('\n')}`;
}

/** Key that ties a mail_send review to its execution (preflight sees raw args, afterTool parsed ones). */
function mailSendKey(args: Record<string, unknown>): string {
  const draft = str(args?.draft_id ?? args?.draftId).trim();
  if (draft) return `d:${draft}`;
  const f = factsFromArgs(args ?? {});
  return f ? `f:${f.to.map(bareAddress).sort().join(',')}|${f.inReplyTo ?? ''}` : '';
}

/** First line of every Sentinel approval prompt. */
export const SENTINEL_PROMPT_TITLE = '🛡 Sentinel — approval needed · نیاز به تأیید شما';

/**
 * Is this an approval prompt Sentinel built? Its text quotes page-controlled
 * content (button labels, URLs), so automatic answerers (the MCP server's path
 * rules) must not match against it. A spoof only makes such a prompt be declined.
 */
export function isSentinelPrompt(prompt: string): boolean {
  return String(prompt ?? '').includes('Sentinel — approval needed');
}

/** Resolve to `fallback` when `signal` aborts first. Never rejects for the abort. */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal | undefined, fallback: T): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.resolve(fallback);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => resolve(fallback);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(v => { signal.removeEventListener('abort', onAbort); resolve(v); },
      e => { signal.removeEventListener('abort', onAbort); reject(e); });
  });
}

/** Resolve to null on timeout or error. */
function withTimeout<T>(p: Promise<T> | undefined, ms: number): Promise<T | null> {
  if (!p) return Promise.resolve(null);
  return new Promise<T | null>((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    t.unref?.();
    p.then(v => { clearTimeout(t); resolve(v ?? null); }, () => { clearTimeout(t); resolve(null); });
  });
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

const ELEMENT_TOOLS = new Set(['browser_click', 'browser_fill', 'browser_type', 'browser_press', 'browser_upload', 'browser_fill_secret']);

/** Tools that can reach QodeX's own control center (URL / command arguments). */
const CONTROL_REACHING_TOOLS = new Set([
  'browser_navigate', 'browser_tabs', 'browser_agent', 'computer_use_open', 'http_request', 'workflow_run',
  'shell', 'code_run', 'background_job_start', 'dev_server_start', 'docker_exec',
]);

/**
 * Tools whose output is text from the outside world even though they don't set
 * `untrustedOutput` themselves (web pages, search results, HTTP bodies, MCP
 * servers such as mail or chat): they get the same injection scan + fence.
 */
const EXTERNAL_TEXT_TOOLS = new Set(['web_fetch', 'web_search', 'http_request']);
const MCP_TOOL_RE = /^mcp(?::|__)/i;

type ControlInfo = NonNullable<ReturnType<NonNullable<SentinelOptions['controlCenter']>>>;
/** Lazily loaded getControlCenter (src/control/server.ts is only imported when a guarded call could reach it). */
let controlGetter: (() => ControlInfo | null) | null = null;
let controlLoading: Promise<void> | null = null;
function loadControlGetter(): Promise<void> {
  if (controlGetter) return Promise.resolve();
  if (!controlLoading) {
    controlLoading = import('../control/server.js')
      .then((m: any) => { controlGetter = typeof m?.getControlCenter === 'function' ? () => m.getControlCenter() : () => null; })
      .catch(() => { controlGetter = () => null; });
  }
  return controlLoading;
}

function hostOfUrl(u: string | undefined): string {
  try { return u ? new URL(u).hostname.toLowerCase().replace(/^\[|\]$/g, '') : ''; } catch { return ''; }
}

function toControlLike(info: ControlInfo | null | undefined): ControlCenterLike | null {
  if (!info) return null;
  const hosts = [...new Set([info.url, ...(info.urls ?? []), info.tunnelUrl].map(hostOfUrl).filter(Boolean))];
  return { port: typeof info.port === 'number' ? info.port : undefined, token: info.token || undefined, hosts };
}

export class Sentinel implements SentinelGuard {
  private readonly approvals = new Set<string>();
  /**
   * One-shot passes granted by preflight(), per ToolContext object + tool name.
   * Lets the agent loop review a call BEFORE its per-tool timeout starts (a remote
   * approval may take minutes) while ToolRegistry.execute keeps reviewing every
   * other caller (MCP server, direct callers) — without asking the human twice.
   * Only preflight() creates a pass and beforeTool() consumes it, so a caller that
   * only goes through the registry is always reviewed.
   */
  private readonly passes = new WeakMap<object, Map<string, number>>();
  private auditWriter: SentinelAudit | null | undefined;
  /** mail_send calls a standing grant let through, waiting for their result (→ "Auto-replied to …" notice). */
  private readonly autoReplies = new Map<string, { at: number; account: string; to: string; subject: string; grantId: string; used: number; cap: number }>();

  constructor(private readonly opts: SentinelOptions = {}) {
    this.auditWriter = opts.audit;
  }

  /** The Sentinel settings; the safe defaults when they can't be read (fail closed, never off). */
  config(): SentinelConfig {
    try {
      return this.opts.config ? this.opts.config() : resolveSentinelConfig(getActiveConfig());
    } catch {
      return { ...DEFAULT_SENTINEL_CONFIG };
    }
  }

  /** "category|domain" pairs the user answered "always" for this session. */
  sessionApprovals(): string[] {
    return [...this.approvals];
  }

  /** Forget session approvals (e.g. `/sentinel reset`). */
  resetSession(): void {
    this.approvals.clear();
  }

  private broker(): ApprovalBroker {
    return this.opts.broker ? this.opts.broker() : getApprovalBroker();
  }

  private interactive(): boolean {
    return this.opts.interactive ? this.opts.interactive() : isInteractiveHuman();
  }

  private browser(): BrowserManager | null {
    try {
      return this.opts.browser ? this.opts.browser() : peekBrowserManager();
    } catch {
      return null;
    }
  }

  /** The in-process control center (port, token, hosts), loading the accessor on first use. */
  private async controlInfo(): Promise<ControlCenterLike | null> {
    try {
      if (this.opts.controlCenter) return toControlLike(this.opts.controlCenter());
      // A running control center registers the 'control' approval channel; without
      // one there is nothing to protect and no reason to load the server module.
      if (!controlGetter && !this.controlChannelUp()) return null;
      await loadControlGetter();
      return toControlLike(controlGetter?.());
    } catch {
      return null;
    }
  }

  /** Same, synchronously (afterTool): only when the accessor is already loaded. */
  private controlTokenSync(): string | undefined {
    try {
      if (this.opts.controlCenter) return this.opts.controlCenter()?.token || undefined;
      if (!controlGetter) {
        if (this.controlChannelUp()) void loadControlGetter();
        return undefined;
      }
      return controlGetter()?.token || undefined;
    } catch {
      return undefined;
    }
  }

  private controlChannelUp(): boolean {
    try { return this.broker().channelNames().includes('control'); } catch { return false; }
  }

  private audit(cfg: SentinelConfig): SentinelAudit | null {
    if (!cfg.audit || this.auditWriter === null) return null;
    if (!this.auditWriter) this.auditWriter = new SentinelAudit();
    return this.auditWriter;
  }

  /** Flush pending audit writes (tests / shutdown). */
  async flush(): Promise<void> {
    await this.auditWriter?.flush();
  }

  // ── context gathering ───────────────────────────────────────────────────

  private async gather(toolName: string, args: Record<string, unknown>, ctx: ToolContext): Promise<Omit<PolicyContext, 'config'>> {
    const out: Omit<PolicyContext, 'config'> = { cwd: ctx?.cwd, protectedPaths: this.opts.protectedPaths };
    if (CONTROL_REACHING_TOOLS.has(toolName)) out.control = await this.controlInfo();
    if (toolName === 'workflow_run' && str(args.name)) {
      out.workflow = await this.loadWorkflow(str(args.name));
    }
    if (!toolName.startsWith('browser_')) return out;
    const mgr = this.browser();
    let running = false;
    try { running = !!mgr?.isRunning(); } catch { running = false; }
    if (!mgr || !running) return out;
    try { out.url = mgr.activeUrl() || undefined; } catch { /* ignore */ }
    const ms = this.opts.describeTimeoutMs ?? 1500;
    const describe = (ref?: string, selector?: string): Promise<ElementInfo | null> => {
      try {
        if (ref) return withTimeout(mgr.describeRef(ref), ms);
        if (selector) return withTimeout(mgr.describeSelector(selector), ms);
      } catch { /* sync throw from a fake/old manager */ }
      return Promise.resolve(null);
    };
    if (ELEMENT_TOOLS.has(toolName)) {
      const ref = str(args.ref);
      const selector = str(args.selector);
      if (toolName === 'browser_press' && !ref && !selector) {
        // Enter submits and Space activates whatever has focus.
        const key = str(args.key);
        out.element = isEnterKey(key) || isSpaceKey(key) ? await describe(undefined, '*:focus') : null;
      } else if (toolName === 'browser_type' && !ref && !selector) {
        // Without a target the text goes into the focused element (maybe a password field).
        out.element = await describe(undefined, '*:focus');
      } else {
        out.element = await describe(ref || undefined, selector || undefined);
      }
    } else if (toolName === 'browser_fill_form' && Array.isArray(args.fields)) {
      // Fields are keyed by ref, or by selector when they have no ref (policy reads the same key).
      const targets = (args.fields as Array<Record<string, unknown>>)
        .map(f => ({ ref: str(f?.ref), selector: str(f?.selector) }))
        .filter(t => t.ref || t.selector)
        .slice(0, 25);
      const infos = await Promise.all(targets.map(t => describe(t.ref || undefined, t.ref ? undefined : t.selector)));
      out.elements = Object.fromEntries(targets.map((t, i) => [t.ref || t.selector, infos[i]]));
    } else if (toolName === 'browser_evaluate' || (toolName === 'browser_wait_for' && str(args.kind) === 'function') || /^\s*javascript:/i.test(str(args.url))) {
      // A script (a wait_for predicate, a javascript: URL) that clicks/submits: describe what it selects.
      let script = toolName === 'browser_evaluate' ? str(args.script)
        : toolName === 'browser_wait_for' ? str(args.value)
          : str(args.url).trim().replace(/^javascript:/i, '');
      if (toolName !== 'browser_evaluate' && toolName !== 'browser_wait_for') { try { script = decodeURIComponent(script); } catch { /* keep */ } }
      const sels = scriptSelectors(script);
      if (sels.length) out.scriptTargets = await Promise.all(sels.map(sel => describe(undefined, sel)));
    } else if (toolName === 'browser_dialog' && str(args.action) === 'accept') {
      // The manager's status carries the active tab's waiting dialog ({type, message}).
      try {
        const pd = (mgr.status() as unknown as { pendingDialog?: { type?: string; message?: string } })?.pendingDialog;
        out.dialog = pd && typeof pd === 'object' ? { type: str(pd.type), message: str(pd.message) } : null;
      } catch { out.dialog = null; }
    }
    return out;
  }

  private async loadWorkflow(name: string): Promise<WorkflowLike | null> {
    const dir = this.opts.workflowsDir ?? QODEX_WORKFLOWS_DIR;
    // The workflow store files a workflow under normalizeWorkflowName(name) (lower-case slug,
    // hash suffix for Persian names) — look there first, like workflow_run does.
    let id = '';
    try { id = normalizeWorkflowName(name); } catch { id = ''; }
    const candidates = [...new Set([id, name, sanitizeName(name)])].filter(c => c && !/[/\\]/.test(c) && c !== '.' && c !== '..');
    for (const c of candidates) {
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(dir, `${c}.json`), 'utf-8'));
        if (parsed && typeof parsed === 'object') return parsed as WorkflowLike;
      } catch { /* try next */ }
    }
    return null;
  }

  /** Gather context and classify a call (no prompting). `known` = context the caller already resolved (mail_send facts). */
  async review(toolName: string, args: Record<string, unknown>, ctx: ToolContext, known?: Pick<PolicyContext, 'mail'>): Promise<PolicyClassification> {
    const cfg = this.config();
    const extra = await this.gather(toolName, args ?? {}, ctx);
    return classifyAction(toolName, args ?? {}, { ...extra, ...(known ?? {}), config: cfg });
  }

  private grants(): GrantStore {
    return this.opts.grants ? this.opts.grants() : getGrantStore();
  }

  /** What a mail_send would send + the trusted facts about the message it replies to (null = unknown). */
  private async resolveMail(args: Record<string, unknown>, ctx: ToolContext): Promise<MailSendResolution | null> {
    try {
      const index = this.opts.receivedIndex ? this.opts.receivedIndex() : getReceivedIndex();
      return await resolveMailSend(args, { cwd: ctx?.cwd, sessionId: ctx?.sessionId }, { index });
    } catch {
      return null;
    }
  }

  /**
   * Standing mail-reply grants (src/grants): a mail_send inside a grant's exact scope is
   * allowed without a prompt (the daily cap is counted here); otherwise say why, and
   * offer "always allow replies like this" when it is a plain same-thread reply.
   * A user deny rule for the operation always wins. Fails closed (no grant).
   */
  private async standingMailGrant(toolName: string, ctx: ToolContext, cls: PolicyClassification, mail: MailSendResolution | null): Promise<MailGrantCheck> {
    try {
      if (!mail) return { allowed: false, offer: null };
      let perm: 'allow' | 'ask' | 'deny' = 'ask';
      try { perm = ctx?.permissions ? ctx.permissions.evaluate({ tool: toolName, operation: this.operation(toolName, cls), description: cls.reason }) : 'ask'; } catch { perm = 'ask'; }
      if (perm === 'deny') return { allowed: false, offer: null };
      const store = this.grants();
      const rows = await store.listWithUsage();
      const used = new Map(rows.map(r => [r.grant.id, r.usedToday]));
      const v = checkMailReplyScope(mail.send, mail.source, rows.map(r => r.grant), { usedToday: id => used.get(id) ?? 0 });
      if (v.ok) {
        const c = await store.consume(v.grant.id);
        if (c.ok) return { allowed: true, grantId: v.grant.id, used: c.used, cap: c.cap, recipient: v.recipient, account: mail.send.account, subject: str(mail.send.subject) };
        return { allowed: false, offer: null, note: `Not covered by standing grant ${v.grant.id}: ${c.reason}.` };
      }
      const hasGrants = rows.some(r => r.grant.kind === 'mail-reply');
      const note = hasGrants || v.blockedByCap ? `Not covered by your standing reply grant: ${v.reasons.slice(0, 3).join('; ')}.` : undefined;
      const offer = v.replyShaped && !v.blockedByCap && v.recipient && mail.send.account ? { account: mail.send.account, from: v.recipient } : null;
      return { allowed: false, offer, note };
    } catch {
      return { allowed: false, offer: null };
    }
  }

  /** A grant-allowed mail_send finished: tell the user ("Auto-replied to X: subject"). */
  private settleAutoReply(args: Record<string, unknown>, result: ToolResult): void {
    const key = mailSendKey(args);
    const now = Date.now();
    for (const [k, v] of this.autoReplies) if (now - v.at > 30 * 60_000) this.autoReplies.delete(k);
    const pending = key ? this.autoReplies.get(key) : undefined;
    if (!pending) return;
    this.autoReplies.delete(key);
    const data = { account: pending.account, to: pending.to, subject: pending.subject, grantId: pending.grantId, used: pending.used, cap: pending.cap };
    if (result?.isError) void publishMailEvent('auto-reply-failed', { ...data, error: String(result.content ?? '').split('\n')[0] });
    else void publishMailEvent('auto-reply', data);
  }

  // ── decisions ───────────────────────────────────────────────────────────

  private approvalKey(c: ActionClassification): string {
    return `${c.category}|${c.domain ?? ''}`;
  }

  /**
   * Decide without prompting. 'ask' means a human (critical) or the permission flow must answer.
   * `args` (the tool call's arguments) let auto mode look at upload paths / HTTP methods.
   */
  decide(toolName: string, cls: PolicyClassification, ctx: ToolContext, cfg: SentinelConfig = this.config(), args?: Record<string, unknown>): SentinelVerdict {
    if (cls.block) {
      return { via: 'policy', decision: { action: 'deny', classification: cls, message: `[SENTINEL_BLOCKED] ${cls.summary} — ${cls.reason}. This is a hard policy block; do not retry or work around it. Tell the user if the task needs it.` } };
    }
    if (!cls.category || cls.risk === 'low') return { via: 'low-risk', decision: { action: 'allow', classification: cls } };
    // Integrity rules (QodeX's config, vault CLI, approval channels) are never pre-approved:
    // `autoApprove: [account]` for website settings must not let the agent approve itself.
    if (cfg.autoApprove.includes(cls.category) && !cls.integrity) return { via: 'auto-approve', decision: { action: 'allow', classification: cls } };
    if (cls.risk !== 'critical' && this.approvals.has(this.approvalKey(cls))) {
      return { via: 'session', decision: { action: 'allow', classification: cls } };
    }
    if (cls.risk === 'critical') {
      if (!this.interactive() && !this.broker().hasRemoteChannel()) {
        return {
          via: 'no-human',
          decision: {
            action: 'deny', classification: cls,
            message: `[SENTINEL_BLOCKED] ${cls.category} needs a human approval but no one is available (${cls.summary}). Run interactively, or start the control center (qodex control / /control) or Telegram (qodex telegram start) to approve remotely, or allow it with sentinel.autoApprove: [${cls.category}]. The action was not performed; do not retry it — report this to the user.`,
          },
        };
      }
      const autoReason = isAutonomousContext(ctx)
        ? `${cls.integrity ? "changing QodeX's own safety settings" : cls.category} always needs a human (purchases, payments, passwords, sending messages and QodeX's safety settings are never automatic).`
        : undefined;
      return { via: 'needs-human', autoReason, decision: { action: 'ask', classification: cls, prompt: this.buildPrompt(toolName, cls, true, autoReason) } };
    }
    const operation = this.operation(toolName, cls);
    let perm: 'allow' | 'ask' | 'deny';
    try {
      perm = ctx?.permissions ? ctx.permissions.evaluate({ tool: toolName, operation, description: cls.reason }) : 'ask';
    } catch {
      perm = 'ask';
    }
    if (perm === 'deny') {
      return { via: 'permission', decision: { action: 'deny', classification: cls, message: `[PERMISSION_DENIED] ${toolName} was blocked by your security.autoReject rules (${cls.category}: ${cls.summary}).` } };
    }
    // Autonomous 'auto' mode: Sentinel's own policy decides (the engine's auto-mode
    // "allow" is a blanket one and its "ask" would only be a shell heuristic matching
    // the operation string) — silent, except remote deletes / account changes /
    // publishing and uploads from outside the project.
    if (isAutonomousContext(ctx)) {
      const why = autoModeAskReason(toolName, cls, args, rootsFor(ctx?.cwd, this.extraRoots()));
      if (!why) return { via: 'auto-mode', decision: { action: 'allow', classification: cls } };
      // Asked like a critical action: an explicit human (this terminal / chat, else the
      // remote channels), never an unattended auto-answerer (--yes, mission auto mode).
      if (!this.interactive() && !this.broker().hasRemoteChannel()) {
        return {
          via: 'no-human', autoReason: why,
          decision: {
            action: 'deny', classification: cls,
            message: `[SENTINEL_BLOCKED] Auto mode still asks a human before this: ${why} No one is available to answer (${cls.summary}). Approve it from the control center (qodex control / /control) or Telegram (qodex telegram start), or run it interactively. The action was not performed; do not retry it — report this to the user.`,
          },
        };
      }
      return { via: 'auto-asks', autoReason: why, decision: { action: 'ask', classification: cls, prompt: this.buildPrompt(toolName, cls, false, why) } };
    }
    if (perm === 'allow') return { via: 'permission', decision: { action: 'allow', classification: cls } };
    return { via: 'needs-permission', decision: { action: 'ask', classification: cls, prompt: this.buildPrompt(toolName, cls, false) } };
  }

  /** The user's approval.extraRoots (directories auto mode treats as part of the project). */
  private extraRoots(): string[] {
    try {
      const r = (getActiveConfig() as { approval?: { extraRoots?: unknown } })?.approval?.extraRoots;
      return Array.isArray(r) ? r.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  /**
   * Operation string for the permission engine: `sentinel:<category> <domain|-> <tool>`.
   * Deliberately free of page text so a site can't make the user's autoReject /
   * alwaysAsk / autoApprove regexes match by naming a button.
   */
  private operation(toolName: string, cls: ActionClassification): string {
    return `sentinel:${cls.category} ${cls.domain || '-'} ${toolName}`;
  }

  private buildPrompt(toolName: string, cls: PolicyClassification, critical: boolean, autoReason?: string): string {
    const lines = [
      SENTINEL_PROMPT_TITLE,
      `Action: ${cls.summary}`,
      `Category: ${cls.category} · risk: ${cls.risk}`,
      `Why: ${cls.reason}`,
      `Tool: ${toolName}`,
      ...(cls.details ?? []),
    ];
    if (critical) {
      lines.push('Critical actions always need your explicit answer (/auto and --yes do not apply).');
      if (autoReason) lines.push(`${AUTO_MODE_ASKS}: ${autoReason}`);
    } else {
      if (autoReason) lines.push(`${AUTO_MODE_ASKS}: ${autoReason}`);
      lines.push(`"always" allows ${cls.category} actions${cls.domain ? ` on ${cls.domain}` : ''} for the rest of this session.`);
    }
    lines.push('Allow this action?');
    return lines.join('\n');
  }

  // ── SentinelGuard ───────────────────────────────────────────────────────

  async beforeTool(toolName: string, args: Record<string, unknown>, ctx: ToolContext, _meta: { untrustedOutput?: boolean; isReadOnly?: boolean } = {}): Promise<ToolResult | null> {
    let cfg: SentinelConfig;
    try {
      cfg = this.config();
    } catch {
      return null;
    }
    if (!cfg.enabled || !isGuardedTool(toolName)) return null;
    if (this.consumePass(ctx, toolName)) return null;
    return this.run(toolName, args, ctx, cfg, false);
  }

  /**
   * Same review as beforeTool, for the agent loop to call BEFORE it starts the
   * tool's timeout. When the call is allowed, the following beforeTool() for the
   * same ctx + tool (inside ToolRegistry.execute) passes without a second review.
   */
  async preflight(toolName: string, args: Record<string, unknown>, ctx: ToolContext, _meta: { untrustedOutput?: boolean; isReadOnly?: boolean } = {}): Promise<ToolResult | null> {
    let cfg: SentinelConfig;
    try {
      cfg = this.config();
    } catch {
      return null;
    }
    if (!cfg.enabled || !isGuardedTool(toolName)) return null;
    return this.run(toolName, args, ctx, cfg, true);
  }

  private consumePass(ctx: ToolContext, toolName: string): boolean {
    if (!ctx || typeof ctx !== 'object') return false;
    const m = this.passes.get(ctx);
    const n = m?.get(toolName) ?? 0;
    if (n <= 0) return false;
    if (n === 1) m!.delete(toolName); else m!.set(toolName, n - 1);
    return true;
  }

  private async run(toolName: string, args: Record<string, unknown>, ctx: ToolContext, cfg: SentinelConfig, grant: boolean): Promise<ToolResult | null> {
    const a = args && typeof args === 'object' ? args : {};

    let cls: PolicyClassification | null = null;
    try {
      // mail_send: what would actually go out (a draft's contents) — for the prompt and standing grants.
      const mail = toolName === MAIL_SEND_TOOL ? await this.resolveMail(a, ctx) : undefined;
      cls = await this.review(toolName, a, ctx, mail === undefined ? undefined : { mail });
      clearSentinelApproval(ctx, toolName);
      const verdict = this.decide(toolName, cls, ctx, cfg, a);
      let d = verdict.decision;
      if (d.action === 'allow') {
        this.report(cfg, toolName, a, ctx, cls, 'allow', verdict.via);
        // The human's earlier "always" for this category + domain answers for this call too.
        if (verdict.via === 'session') recordSentinelApproval(ctx, toolName);
        return this.allow(ctx, toolName, grant);
      }
      // A standing mail-reply grant the human created answers for an in-scope reply (also
      // when no human is around — that is what it is for). Never past a policy block or a deny rule.
      let criticalOptions = CRITICAL_OPTIONS;
      let replyOffer: ReplyOffer | null = null;
      if (toolName === MAIL_SEND_TOOL && !cls.block && cls.category === 'send' && verdict.via !== 'permission') {
        const g = await this.standingMailGrant(toolName, ctx, cls, mail ?? null);
        if (g.allowed) {
          this.report(cfg, toolName, a, ctx, cls, 'allow', 'grant', `grant:${g.grantId} (${g.used}/${g.cap} today)`, 'standing-grant');
          const key = mailSendKey(a);
          if (key) this.autoReplies.set(key, { at: Date.now(), account: g.account, to: g.recipient, subject: g.subject, grantId: g.grantId, used: g.used, cap: g.cap });
          return this.allow(ctx, toolName, grant);
        }
        if (d.action === 'ask') {
          const lines = [g.note ?? ''];
          if (g.offer && verdict.via === 'needs-human') {
            replyOffer = g.offer;
            criticalOptions = [...CRITICAL_OPTIONS, ALWAYS_REPLIES_OPTION];
            lines.push(`"${ALWAYS_REPLIES_OPTION}" = send this, and from now on send same-thread replies to ${g.offer.from} from ${g.offer.account} without asking (no cc/bcc/attachments, max 50/day; revoke with /allow revoke).`);
          }
          d = { ...d, prompt: beforeQuestion(d.prompt, lines) };
        }
      }
      if (d.action === 'deny') {
        this.report(cfg, toolName, a, ctx, cls, 'deny', verdict.via);
        return this.denied(d.message, cls, verdict.via);
      }
      const r = verdict.via === 'needs-human'
        ? await this.askHuman(toolName, a, ctx, cls, d.prompt, cfg, criticalOptions, verdict.autoReason, replyOffer)
        : verdict.via === 'auto-asks'
          ? await this.askHuman(toolName, a, ctx, cls, d.prompt, cfg, ASK_OPTIONS, verdict.autoReason)
          : await this.askPermission(toolName, a, ctx, cls, d.prompt, cfg);
      // A human said yes: the MCP wrapper must not ask the same thing again (takeSentinelApproval).
      if (!r) recordSentinelApproval(ctx, toolName);
      return r ?? this.allow(ctx, toolName, grant);
    } catch (e: any) {
      const c = cls ?? { category: null, risk: 'high' as const, summary: toolName, reason: 'review failed' };
      this.report(cfg, toolName, a, ctx, c, 'deny', 'error');
      return this.denied(`[SENTINEL_BLOCKED] Sentinel could not review this ${toolName} call (${e?.message ?? e}). The action was not performed.`, c, 'error');
    }
  }

  /**
   * An explicit human answer: this process's askUser when a human sits at it, else the
   * remote channels with a timeout. Critical actions get yes / no; auto mode's remaining
   * asks (`options` with "always") may also grant the category + domain for the session.
   */
  private async askHuman(
    toolName: string, args: Record<string, unknown>, ctx: ToolContext, cls: PolicyClassification, prompt: string, cfg: SentinelConfig,
    options: string[] = CRITICAL_OPTIONS, autoReason?: string, replyOffer?: ReplyOffer | null,
  ): Promise<ToolResult | null> {
    this.progress(ctx, `🛡 Sentinel: waiting for a human to approve — ${cls.summary}`);
    let answer: string;
    let by = 'local';
    if (this.interactive()) {
      answer = await raceAbort(Promise.resolve().then(() => ctx.askUser(prompt, options)), ctx.signal, 'no');
      if (ctx.signal?.aborted) by = 'abort';
    } else {
      const r = await this.broker().request({
        prompt, options, category: cls.category ?? undefined, risk: cls.risk === 'low' ? 'medium' : cls.risk, source: toolName,
        timeoutMs: cfg.remoteApprovalTimeoutSec * 1000, signal: ctx.signal,
        meta: { summary: cls.summary, domain: cls.domain, reason: cls.reason, sessionId: ctx.sessionId, ...(autoReason ? { autoMode: autoReason } : {}) },
      });
      answer = r.answer;
      by = r.by;
    }
    const picked = normalizeAnswer(answer, options) ?? answer;
    if (replyOffer && options.includes(ALWAYS_REPLIES_OPTION) && picked === ALWAYS_REPLIES_OPTION && !NON_HUMAN_BY.has(by)) {
      // A human clicked "Always allow replies like this": the one approval answer that creates a grant.
      try {
        const store = this.grants();
        const { grant } = await store.add({ kind: 'mail-reply', account: replyOffer.account, from: [replyOffer.from] }, 'approval', by);
        await store.consume(grant.id);
        void publishMailEvent('grant-created', { grantId: grant.id, by: `approval:${by}`, account: replyOffer.account, summary: `mail replies · account ${replyOffer.account} · from ${replyOffer.from}` });
      } catch { /* the send itself was still approved */ }
      this.report(cfg, toolName, args, ctx, cls, 'allow', 'human', picked, by);
      return null;
    }
    if (cls.risk !== 'critical' && options.includes('always') && picked === 'always') {
      this.approvals.add(this.approvalKey(cls));
      this.report(cfg, toolName, args, ctx, cls, 'allow', 'human', picked, by);
      return null;
    }
    if (isApproval(answer, options)) {
      this.report(cfg, toolName, args, ctx, cls, 'allow', 'human', answer, by);
      return null;
    }
    this.report(cfg, toolName, args, ctx, cls, 'deny', by === 'timeout' ? 'timeout' : 'human', answer, by);
    return this.denied(this.declineMessage(cls, by, cfg), cls, 'human');
  }

  private async askPermission(toolName: string, args: Record<string, unknown>, ctx: ToolContext, cls: PolicyClassification, prompt: string, cfg: SentinelConfig): Promise<ToolResult | null> {
    const operation = this.operation(toolName, cls);
    try { ctx.emit?.({ type: 'permission-request', tool: toolName, operation, description: cls.reason }); } catch { /* UI only */ }
    const raw = await raceAbort(Promise.resolve().then(() => ctx.askUser(prompt, ASK_OPTIONS)), ctx.signal, 'no');
    const answer = normalizeAnswer(raw, ASK_OPTIONS) ?? raw;
    const by = ctx.signal?.aborted ? 'abort' : 'local';
    if (answer === 'always') {
      this.approvals.add(this.approvalKey(cls));
      this.report(cfg, toolName, args, ctx, cls, 'allow', 'permission', answer, by);
      return null;
    }
    if (isApproval(answer, ASK_OPTIONS)) {
      this.report(cfg, toolName, args, ctx, cls, 'allow', 'permission', answer, by);
      return null;
    }
    this.report(cfg, toolName, args, ctx, cls, 'deny', 'permission', answer, by);
    return this.denied(this.declineMessage(cls, by, cfg), cls, 'permission');
  }

  private declineMessage(cls: PolicyClassification, by: string, cfg: SentinelConfig): string {
    if (by === 'timeout') {
      return `[SENTINEL_DENIED] No approval arrived within ${cfg.remoteApprovalTimeoutSec}s for: ${cls.summary}. The action was not performed. Do not retry on your own; tell the user it is waiting for their approval.`;
    }
    if (by === 'abort') return `[SENTINEL_DENIED] Cancelled while waiting for approval of: ${cls.summary}. The action was not performed.`;
    if (by === 'fallback') {
      return `[SENTINEL_BLOCKED] ${cls.category} needs a human approval but no one is available (${cls.summary}). Start the control center (qodex control) or Telegram (qodex telegram start), or allow it with sentinel.autoApprove: [${cls.category}].`;
    }
    return `[SENTINEL_DENIED] The user declined: ${cls.summary}. Do not retry; ask the user how to proceed.`;
  }

  /** Allow; from preflight() also leave a one-shot pass for the registry's beforeTool(). */
  private allow(ctx: ToolContext, toolName: string, grant: boolean): null {
    if (grant && ctx && typeof ctx === 'object') {
      const m = this.passes.get(ctx) ?? new Map<string, number>();
      m.set(toolName, (m.get(toolName) ?? 0) + 1);
      this.passes.set(ctx, m);
    }
    return null;
  }

  private denied(message: string, cls: ActionClassification, via: string): ToolResult {
    return {
      content: message,
      isError: true,
      metadata: { sentinel: { action: 'deny', via, category: cls.category, risk: cls.risk, domain: cls.domain } },
    };
  }

  private progress(ctx: ToolContext, message: string): void {
    try { ctx.emit?.({ type: 'progress', message }); } catch { /* UI only */ }
  }

  /** Audit + bus for meaningful decisions (denies, and anything with a category above low risk). */
  private report(cfg: SentinelConfig, toolName: string, args: Record<string, unknown>, ctx: ToolContext, cls: ActionClassification, action: 'allow' | 'deny', via: string, answer?: string, answeredBy?: string): void {
    const meaningful = action === 'deny' || (!!cls.category && cls.risk !== 'low');
    const trail = meaningful || cls.category === 'navigation';
    if (!trail) return;
    const data = {
      tool: toolName, action, via, category: cls.category, risk: cls.risk, domain: cls.domain,
      summary: cls.summary, reason: cls.reason, answer, answeredBy,
    };
    if (meaningful) {
      try { getBus().publish({ kind: 'sentinel', type: 'decision', data }); } catch { /* never break the tool */ }
    }
    const audit = this.audit(cfg);
    if (audit) {
      const hideTyped = cls.category === 'credential' || cls.category === 'payment' || toolName === 'computer_use_type' || toolName === MAIL_SEND_TOOL;
      audit.record({
        type: 'decision', ...data, sessionId: ctx?.sessionId,
        args: redactForAudit(args, { hideTyped }),
      });
    }
  }

  afterTool(toolName: string, args: Record<string, unknown>, result: ToolResult, meta: { untrustedOutput?: boolean } = {}): ToolResult {
    try {
      if (toolName === MAIL_SEND_TOOL && this.autoReplies.size) this.settleAutoReply(args ?? {}, result);
      if (!result || typeof result.content !== 'string') return result;
      const cfg = this.config();
      if (!cfg.enabled) return result;
      // Control-center access tokens (a mission's live URL, `qodex control` output, a
      // sessions.db dump) never reach the model: with one it could approve its own actions.
      const token = this.controlTokenSync();
      const masked = maskControlTokens(result.content, token ? [token] : []);
      if (masked !== result.content) result = { ...result, content: masked };

      // web_fetch / http_request against the user's own dev server (localhost, LAN) is
      // their own code's output, not the outside world: left unfenced.
      const target = parseTarget(str(args?.url));
      const external = EXTERNAL_TEXT_TOOLS.has(toolName) && !(target?.host && isPrivateHost(target.host));
      const untrusted = meta?.untrustedOutput === true || external || MCP_TOOL_RE.test(toolName);
      if (!untrusted || !cfg.injectionDefense) return result;
      const content = result.content as string;
      // Already fenced BY SENTINEL (metadata, not a text prefix: page text could start with a fake fence).
      if (!content.trim() || (result.metadata as any)?.sentinel?.fenced === true) return result;
      const findings = scanInjection(content);
      const source = this.sourceFor(toolName, args ?? {});
      if (findings.length) {
        const brief = findings.map(f => ({ id: f.id, excerpt: f.excerpt }));
        try { getBus().publish({ kind: 'sentinel', type: 'injection', data: { tool: toolName, source, findings: brief } }); } catch { /* ignore */ }
        this.audit(cfg)?.record({ type: 'injection', tool: toolName, source, findings: brief });
      }
      if (result.isError) {
        // Keep the leading [CODE] token intact for the loop's error heuristics.
        return findings.length ? { ...result, content: `${content}\n${injectionBanner(findings)}` } : result;
      }
      return {
        ...result,
        content: fenceUntrusted(content, source, findings),
        metadata: { ...(result.metadata ?? {}), sentinel: { fenced: true, findings: findings.map(f => f.id) } },
      };
    } catch {
      return result;
    }
  }

  private sourceFor(toolName: string, args: Record<string, unknown>): string {
    let url = str(args.url) || str(args.start_url);
    if (!url && toolName.startsWith('browser_')) {
      const mgr = this.browser();
      try { if (mgr?.isRunning()) url = mgr.activeUrl(); } catch { /* ignore */ }
    }
    url = maskControlTokens(maskSecrets(url)).slice(0, 160);
    return url ? `${toolName} ${url}` : toolName;
  }
}

// ── singleton ───────────────────────────────────────────────────────────────

let instance: Sentinel | null = null;

/** The process-wide Sentinel (session approvals live on it). */
export function getSentinel(): Sentinel {
  if (!instance) instance = new Sentinel();
  return instance;
}

/** Test hook: inject a Sentinel (or null to reset to a fresh default on next use). */
export function setSentinelForTests(s: Sentinel | null): void {
  instance = s;
}

/** Human-readable status for `/sentinel` and `qodex sentinel status`. */
export function formatSentinelStatus(s: Sentinel = getSentinel()): string {
  const cfg = s.config();
  const broker = getApprovalBroker();
  const list = (v: string[]) => (v.length ? v.join(', ') : '—');
  return [
    `🛡 Sentinel: ${cfg.enabled ? 'ON' : 'OFF (actions are NOT guarded)'}`,
    `  always ask a human for: ${list(cfg.requireApproval)}`,
    `  pre-approved categories: ${list(cfg.autoApprove)}`,
    `  blocked domains: ${list(cfg.blockedDomains)}`,
    `  allowed domains only: ${list(cfg.allowedDomains)}`,
    `  block private network: ${cfg.blockPrivateNetwork ? 'yes' : 'no'}`,
    `  prompt-injection defense: ${cfg.injectionDefense ? 'on' : 'off'}`,
    `  audit log: ${cfg.audit ? new SentinelAudit().file() : 'off'}`,
    `  remote approval timeout: ${cfg.remoteApprovalTimeoutSec}s`,
    `  approval channels: ${list(broker.channelNames())}${isInteractiveHuman() ? ' + this terminal' : ''}`,
    `  approved for this session: ${list(s.sessionApprovals())}`,
  ].join('\n');
}
