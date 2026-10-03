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
 *   4. every meaningful decision → audit log + bus event {kind:'sentinel'}.
 *
 * afterTool: tools flagged `untrustedOutput` get their text scanned for prompt
 * injection and fenced as data (injection.ts).
 *
 * preflight: the same review for the agent loop to run BEFORE it arms a tool's
 * timeout (a remote approval can take minutes); an allowed preflight leaves a
 * one-shot pass so the registry's beforeTool for that same ctx doesn't ask twice.
 *
 * Fails closed: an internal error while reviewing a guarded call refuses it.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { resolveSentinelConfig, type SentinelConfig } from '../config/agent-config.js';
import { getActiveConfig } from '../config/loader.js';
import { QODEX_WORKFLOWS_DIR, sanitizeName } from '../config/paths.js';
import { getBus } from '../control/bus.js';
import {
  getApprovalBroker, isApproval, isInteractiveHuman, normalizeAnswer, type ApprovalBroker,
} from '../control/approvals.js';
import type { ToolContext, ToolResult } from '../tools/base.js';
import { peekBrowserManager, type BrowserManager, type ElementInfo } from '../tools/browser/types.js';
import { SentinelAudit, redactForAudit } from './audit.js';
import { fenceUntrusted, injectionBanner, isFenced, scanInjection } from './injection.js';
import {
  classifyAction, isGuardedTool, maskSecrets, type PolicyClassification, type PolicyContext,
  type ProtectedPaths, type WorkflowLike,
} from './policy.js';
import type { ActionClassification, SentinelDecision, SentinelGuard } from './types.js';

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
}

/** Outcome of a review, before any prompting. */
export interface SentinelVerdict {
  decision: SentinelDecision;
  /** policy | low-risk | auto-approve | session | permission | needs-human | needs-permission | no-human */
  via: string;
}

const CRITICAL_OPTIONS = ['yes', 'no'];
const ASK_OPTIONS = ['yes', 'no', 'always'];

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

  constructor(private readonly opts: SentinelOptions = {}) {
    this.auditWriter = opts.audit;
  }

  config(): SentinelConfig {
    return this.opts.config ? this.opts.config() : resolveSentinelConfig(getActiveConfig());
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
        out.element = /enter|return/i.test(str(args.key)) ? await describe(undefined, '*:focus') : null;
      } else {
        out.element = await describe(ref || undefined, selector || undefined);
      }
    } else if (toolName === 'browser_fill_form' && Array.isArray(args.fields)) {
      const refs = (args.fields as Array<Record<string, unknown>>).map(f => str(f?.ref)).filter(Boolean).slice(0, 25);
      const infos = await Promise.all(refs.map(r => describe(r)));
      out.elements = Object.fromEntries(refs.map((r, i) => [r, infos[i]]));
    }
    return out;
  }

  private async loadWorkflow(name: string): Promise<WorkflowLike | null> {
    const dir = this.opts.workflowsDir ?? QODEX_WORKFLOWS_DIR;
    const candidates = [...new Set([name, sanitizeName(name)])].filter(c => c && !/[/\\]/.test(c) && c !== '.' && c !== '..');
    for (const c of candidates) {
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(dir, `${c}.json`), 'utf-8'));
        if (parsed && typeof parsed === 'object') return parsed as WorkflowLike;
      } catch { /* try next */ }
    }
    return null;
  }

  /** Gather context and classify a call (no prompting). */
  async review(toolName: string, args: Record<string, unknown>, ctx: ToolContext): Promise<PolicyClassification> {
    const cfg = this.config();
    const extra = await this.gather(toolName, args ?? {}, ctx);
    return classifyAction(toolName, args ?? {}, { ...extra, config: cfg });
  }

  // ── decisions ───────────────────────────────────────────────────────────

  private approvalKey(c: ActionClassification): string {
    return `${c.category}|${c.domain ?? ''}`;
  }

  /** Decide without prompting. 'ask' means a human (critical) or the permission flow must answer. */
  decide(toolName: string, cls: PolicyClassification, ctx: ToolContext, cfg: SentinelConfig = this.config()): SentinelVerdict {
    if (cls.block) {
      return { via: 'policy', decision: { action: 'deny', classification: cls, message: `[SENTINEL_BLOCKED] ${cls.summary} — ${cls.reason}. This is a hard policy block; do not retry or work around it. Tell the user if the task needs it.` } };
    }
    if (!cls.category || cls.risk === 'low') return { via: 'low-risk', decision: { action: 'allow', classification: cls } };
    if (cfg.autoApprove.includes(cls.category)) return { via: 'auto-approve', decision: { action: 'allow', classification: cls } };
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
      return { via: 'needs-human', decision: { action: 'ask', classification: cls, prompt: this.buildPrompt(toolName, cls, true) } };
    }
    const operation = this.operation(toolName, cls);
    let perm: 'allow' | 'ask' | 'deny' = 'ask';
    try {
      perm = ctx?.permissions ? ctx.permissions.evaluate({ tool: toolName, operation, description: cls.reason }) : 'ask';
    } catch {
      perm = 'ask';
    }
    if (perm === 'allow') return { via: 'permission', decision: { action: 'allow', classification: cls } };
    if (perm === 'deny') {
      return { via: 'permission', decision: { action: 'deny', classification: cls, message: `[PERMISSION_DENIED] ${toolName} was blocked by your security.autoReject rules (${cls.category}: ${cls.summary}).` } };
    }
    return { via: 'needs-permission', decision: { action: 'ask', classification: cls, prompt: this.buildPrompt(toolName, cls, false) } };
  }

  /**
   * Operation string for the permission engine: `sentinel:<category> <domain|-> <tool>`.
   * Deliberately free of page text so a site can't make the user's autoReject /
   * alwaysAsk / autoApprove regexes match by naming a button.
   */
  private operation(toolName: string, cls: ActionClassification): string {
    return `sentinel:${cls.category} ${cls.domain || '-'} ${toolName}`;
  }

  private buildPrompt(toolName: string, cls: PolicyClassification, critical: boolean): string {
    const lines = [
      '🛡 Sentinel — approval needed · نیاز به تأیید شما',
      `Action: ${cls.summary}`,
      `Category: ${cls.category} · risk: ${cls.risk}`,
      `Why: ${cls.reason}`,
      `Tool: ${toolName}`,
    ];
    if (critical) lines.push('Critical actions always need your explicit answer (/auto and --yes do not apply).');
    else lines.push(`"always" allows ${cls.category} actions${cls.domain ? ` on ${cls.domain}` : ''} for the rest of this session.`);
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
      cls = await this.review(toolName, a, ctx);
      const verdict = this.decide(toolName, cls, ctx, cfg);
      const d = verdict.decision;
      if (d.action === 'allow') {
        this.report(cfg, toolName, a, ctx, cls, 'allow', verdict.via);
        return this.allow(ctx, toolName, grant);
      }
      if (d.action === 'deny') {
        this.report(cfg, toolName, a, ctx, cls, 'deny', verdict.via);
        return this.denied(d.message, cls, verdict.via);
      }
      const r = verdict.via === 'needs-human'
        ? await this.askHuman(toolName, a, ctx, cls, d.prompt, cfg)
        : await this.askPermission(toolName, a, ctx, cls, d.prompt, cfg);
      return r ?? this.allow(ctx, toolName, grant);
    } catch (e: any) {
      const c = cls ?? { category: null, risk: 'high' as const, summary: toolName, reason: 'review failed' };
      this.report(cfg, toolName, a, ctx, c, 'deny', 'error');
      return this.denied(`[SENTINEL_BLOCKED] Sentinel could not review this ${toolName} call (${e?.message ?? e}). The action was not performed.`, c, 'error');
    }
  }

  private async askHuman(toolName: string, args: Record<string, unknown>, ctx: ToolContext, cls: PolicyClassification, prompt: string, cfg: SentinelConfig): Promise<ToolResult | null> {
    this.progress(ctx, `🛡 Sentinel: waiting for a human to approve — ${cls.summary}`);
    let answer = 'no';
    let by = 'local';
    if (this.interactive()) {
      answer = await raceAbort(Promise.resolve().then(() => ctx.askUser(prompt, CRITICAL_OPTIONS)), ctx.signal, 'no');
      if (ctx.signal?.aborted) by = 'abort';
    } else {
      const r = await this.broker().request({
        prompt, options: CRITICAL_OPTIONS, category: cls.category ?? undefined, risk: 'critical', source: toolName,
        timeoutMs: cfg.remoteApprovalTimeoutSec * 1000, signal: ctx.signal,
        meta: { summary: cls.summary, domain: cls.domain, reason: cls.reason, sessionId: ctx.sessionId },
      });
      answer = r.answer;
      by = r.by;
    }
    if (isApproval(answer, CRITICAL_OPTIONS)) {
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
      const hideTyped = cls.category === 'credential' || cls.category === 'payment' || toolName === 'computer_use_type';
      audit.record({
        type: 'decision', ...data, sessionId: ctx?.sessionId,
        args: redactForAudit(args, { hideTyped }),
      });
    }
  }

  afterTool(toolName: string, args: Record<string, unknown>, result: ToolResult, meta: { untrustedOutput?: boolean } = {}): ToolResult {
    try {
      if (!meta?.untrustedOutput || !result) return result;
      const cfg = this.config();
      if (!cfg.enabled || !cfg.injectionDefense) return result;
      const content = result.content;
      if (typeof content !== 'string' || !content.trim() || isFenced(content)) return result;
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
    url = maskSecrets(url).slice(0, 160);
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
