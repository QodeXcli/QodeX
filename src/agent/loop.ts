/*
 * QodeX — Local-first agentic coding CLI
 * Copyright 2026 7 SEVEN
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import * as crypto from 'crypto';
import * as fsSync from 'fs';
import * as path from 'path';
import { extractAttachedDir } from './attached-dir.js';
import { isTrivialMessage } from './trivial-message.js';
import { buildSteerMessage } from './steering.js';
import { userWantsExecution, isExecutionAction } from './scope-guard.js';
import { ModelRouter, computeCost, type TaskClass } from '../llm/router.js';
import { buildSystemPrompt, detectModelFamily } from '../llm/prompts/system.js';
import { findCustomProviderPromptConfig } from '../llm/providers/custom-config.js';
import { filterSchemasByRelevance } from './tool-relevance.js';
import { evaluateCompletion } from './completion-gate.js';
import { runVisualGate, type VisualGateDecision, type VisualReviewFn, type VisualReviewOutcome } from './visual-gate.js';
import { buildSkillsSystemBlock, suggestSkillForPrompt, getSkill, listSkills } from '../skills/registry.js';
import { suggestUninstalledSkill } from '../skills/skill-sources.js';
import { getBuiltinRolePrompt } from '../llm/prompts/role-prompts.js';
import type { Message, ToolCall } from '../session/store.js';
import { getSessionStore } from '../session/store.js';
import { ToolRegistry, expandToolPatterns, type ToolExecutionMode } from '../tools/registry.js';
import type { ToolContext, ToolUIEvent } from '../tools/base.js';
import { getJournal, type Transaction } from '../filesystem/transaction.js';
import type { PermissionEngine } from '../security/permissions.js';
import { BudgetTracker } from './budget.js';
import { transformError, explainStreamError, detectStuckLoop, detectErrorLoop, errorCodeOf, looksFutile, readLoopAction } from './recovery.js';
import { looksLikeBuildTask, isPlanningToolCall, PREFLIGHT_MESSAGE } from './preflight-gate.js';
import { dedupHistory } from './dedup.js';
import { ageToolResults } from './result-aging.js';
import { applySpillGuard } from './tool-spill.js';
import { efficiencyDefaults, resolveSetting } from './efficiency-profile.js';
import { gatherInfraSignals, deriveAutoDisabledTools, ratchetAutoDisabled } from './tool-profile.js';
import { decideThinking, applyThinkingDecision, countTrailingToolErrors, modelSupportsSoftSwitch } from './thinking-control.js';
import { detectLmStudioContextWindows } from '../setup/model-detector.js';
import { SnapshotService } from '../safety/snapshot.js';
import { resolveRole } from '../llm/role-resolver.js';
import { getHooksManager, extractFilePathsFromArgs } from '../hooks/manager.js';
import type { QodexConfig } from '../config/defaults.js';
import { detectProjectInfo } from '../context/project-info.js';
import { loadProjectRules } from '../context/claude-md.js';
import { loadTrellisContext } from '../context/trellis.js';
import { buildDirectoryTree, getGitBranch } from '../context/tree.js';
import { recoverToolCallsFromText } from '../llm/text-tool-recovery.js';
import { inspectOutput, buildCorrectionMessage } from './output-guardrail.js';
import { compactFileReads } from './read-cache.js';
import { ReadLedger, extractMutationPaths, extractReadPath, isGatedMutationTool, buildGateMessage } from './read-ledger.js';
import { computeBlastRadius, isCodeFile, IMPACT_EDIT_TOOLS } from './blast-radius.js';
import { setSyntaxGateEnabled } from '../tools/ast/syntax-check.js';
import { needsTextToolMode, buildTextToolInstructions, withTextToolProtocol } from '../llm/text-tool-protocol.js';
import { describeCacheReuse } from '../llm/cache-layout.js';
import { retrieveRelevantFiles, formatRetrievalBlock } from '../context/retrieval.js';
import { detectStacks, buildStackAddendum, detectProjectSignals } from '../llm/prompts/stack-profiles.js';
import { verifyTouchedFiles, buildVerifyRepairMessage, buildVerifyGiveupMessage, captureBaseline } from './verification.js';
import type { Diagnostic } from '../tools/diagnostics/parsers.js';
import { buildCriticPrompt, parseCriticVerdict, buildCriticRepairMessage, type DiffFile } from './critic.js';
import { GitSandbox } from './git-sandbox.js';
import { logger } from '../utils/logger.js';

export interface AgentEvent {
  type: 'thinking_start' | 'text_delta' | 'thinking_done'
      | 'tool_call_start' | 'tool_call_args_delta' | 'tool_call_executing'
      | 'tool_result' | 'tool_ui'
      | 'iteration_start' | 'iteration_done'
      | 'permission_request' | 'permission_response'
      | 'final' | 'error' | 'budget_update' | 'plan_ready' | 'notice' | 'steer_injected';
  data?: any;
}

export interface AgentOptions {
  mode?: ToolExecutionMode;
  explicitModel?: string;
  signal?: AbortSignal;
  askUser: (prompt: string, options?: string[]) => Promise<string>;
  /** Called immediately when a tool emits a UI event (diff preview, shell output, etc). */
  onToolUI?: (event: ToolUIEvent) => void;
  /**
   * Per-session override for the iteration cap (set via /unlimited or
   * /iterations). 0 = no iteration limit. undefined = use config default.
   */
  maxIterationsOverride?: number;
  /** Per-session reasoning effort (set via /effort). undefined = model default. */
  reasoningEffort?: 'low' | 'medium' | 'high';
}

export class AgentLoop {
  private router: ModelRouter;
  private registry: ToolRegistry;
  private permissions: PermissionEngine;
  private config: QodexConfig;
  private cwd: string;
  /** Working root for tool path-resolution when the user attaches a directory. Sticky across
   *  turns in a session until a new directory is attached. Falls back to `cwd` when unset. */
  private effectiveCwd?: string;
  /** Auto-snapshot service (only set when safety.autoSnapshot is enabled). */
  private snapshotService: SnapshotService | undefined;
  /** Active git sandbox for the current run (set by runSandboxed), exposed to tools. */
  private activeSandbox: GitSandbox | null = null;
  /** Tracks current turn — used for snapshot retention. */
  private currentTurn = 0;
  /**
   * Mid-task steering queue. The UI pushes `/btw …` notes here while a run is in
   * flight; the run loop drains them at the top of each iteration and injects them
   * into the conversation so the model can adjust course without being stopped.
   * Single-threaded JS event loop ⇒ no lock needed.
   */
  private steerQueue: string[] = [];
  /** Session ledger of files the model has demonstrably read (read-before-write gate). */
  private readLedger = new ReadLedger();
  /** Skills already auto-injected this session — never inject the same one twice. */
  private autoInjectedSkills = new Set<string>();
  /** Monotonic union of tool names shipped this session. The relevance gate only ever
   *  ADDS to this — never drops — so the tools block stays a byte-stable cache prefix
   *  across turns (a sliding per-turn set would flip and invalidate the prompt cache). */
  private sessionToolNames = new Set<string>();
  /** Where the active model is actually served from ('ollama'/'lmstudio'/'anthropic'/…) and
   *  its LIVE context window — set each iteration, forwarded on budget_update for the UI. */
  private lastModelSource = '';
  private lastEffectiveCtxWindow = 0;
  private totalToolCalls = 0; // running count of executed tool calls (skill-capture eligibility)
  private currentTaskKey = ''; // stable key for THIS run's task (failure-driven learning)
  // Ground-truth verification ledger: every checker QodeX actually ran this run + its result.
  // Feeds the trust receipt — uncounterfeitable because the WORKER measured it, not the model.
  private verifyLedger: Array<{ command: string; passed: boolean }> = [];
  private styleBlock: string | null = null; // inferred code-style block, computed once per session

  /** Record a tool failure to episodic memory (best-effort, opt-in). Only fires when
   *  failure-driven learning is enabled; the pattern miner later decides what's worth
   *  learning. Fire-and-forget — never blocks or throws into the loop. */
  private recordToolFailure(tool: string, content: string): void {
    if (!(this.config as any).learning?.failureLessons?.enabled) return;
    if (!this.currentTaskKey) return;
    void (async () => {
      try {
        const { recordFailure, normalizeFailureSignature } = await import('../skills/learning/failures.js');
        await recordFailure({
          task: this.currentTaskKey,
          tool,
          signature: normalizeFailureSignature(tool, content),
          sample: (content || '').replace(/\s+/g, ' ').trim().slice(0, 160),
        });
      } catch { /* best-effort */ }
    })();
  }
  /** Auto tool profile: null = not yet derived this session; then a ratcheting list. */
  private autoDisabledTools: string[] | null = null;
  /** Live context windows read from LM Studio's native API, fetched once per session. */
  private liveCtxWindows: Record<string, number> | null = null;
  private liveCtxFetched = false;
  /** Adaptive thinking: force a THINK pass on the next iteration (steer/verify-repair). */
  private forceThinkNext = false;
  /** Reset at the start of each user turn — ensures we snapshot AT MOST once per turn (before the first mutating tool). */
  private turnSnapshotTaken = false;
  /** Pre-flight architecture gate state (reset per run, armed only in normal mode). */
  private planGateComplex = false;    // does this run's request look like a build/refactor?
  private planGateSatisfied = false;  // has the model produced a plan signal this run?
  private planGateFired = false;      // have we already nudged once this run? (one-shot, never locks)
  private completionGateFired = false; // completion-claim gate fires at most once per run
  /** Visual gate state (reset per run): has the single corrective retry been spent? */
  private visualGateRetried = false;
  /** Injectable Layer-3 reviewer for the completion-time visual gate — tests mock this;
   *  when null the loop runs the real `artifact_review` tool (browser + vision). */
  visualReviewFn: VisualReviewFn | null = null;
  /** Auto-compact older turns when context exceeds the threshold of the model's window. Enabled by default. */
  private autoCompactEnabled = true;
  /** Fraction of the context window above which auto-compaction triggers. */
  private autoCompactThreshold = 0.75;
  /** Fallback context window (tokens) when the caller/model doesn't specify one. */
  private defaultContextWindow = 32_768;
  /** True when the user set compaction.contextWindow in config (it then wins over model-detected). */
  private contextWindowExplicit = false;
  /** Within-turn cache for read-only tool calls. Cleared each iteration. */
  private toolCache: import('../utils/tool-cache.js').ToolResultCache | null = null;

  constructor(opts: {
    router: ModelRouter;
    registry: ToolRegistry;
    permissions: PermissionEngine;
    config: QodexConfig;
    cwd: string;
  }) {
    this.router = opts.router;
    this.registry = opts.registry;
    this.permissions = opts.permissions;
    this.config = opts.config;
    this.cwd = opts.cwd;
    // Auto-compaction + efficiency tuning are DERIVED from config. Factored into a method so a
    // mid-session config hot-reload (refreshMutableConfig, run at each run() start) re-derives
    // them too — a dashboard toggle to `context.efficient` then takes effect on the next task.
    this.applyConfigDerived();
    // Snapshot service: only instantiated when the user has explicitly enabled it in config.
    // Constructor is cheap — no I/O — but we still keep this conditional so non-users
    // aren't carrying unused state.
    if ((opts.config as any).safety?.autoSnapshot) {
      // The sessionId here is a placeholder; the real one is set per-run via setSessionForSnapshot().
      // We construct early so the field is always defined for the type system.
      this.snapshotService = new SnapshotService(opts.cwd, 'pending', {
        retentionTurns: (opts.config as any).safety?.snapshotRetentionTurns ?? 50,
      });
    }
  }

  /** Update the snapshot service's session id when a real session starts. */
  private setSessionForSnapshot(sessionId: string): void {
    if (this.snapshotService) {
      // Recreate with the proper session id — cleaner than mutating private state.
      this.snapshotService = new SnapshotService(this.cwd, sessionId, {
        retentionTurns: (this.config as any).safety?.snapshotRetentionTurns ?? 50,
      });
    }
  }

  /** Public read accessor for slash commands to operate on snapshots. */
  getSnapshotService(): SnapshotService | undefined {
    return this.snapshotService;
  }

  /** Allow slash commands to toggle features at runtime without restart. */
  setSubagentMode(mode: 'off' | 'sequential' | 'parallel'): void {
    (this.config as any).subagents = { ...(this.config as any).subagents, mode };
  }
  setAutoSnapshot(enabled: boolean): void {
    if (enabled && !this.snapshotService) {
      this.snapshotService = new SnapshotService(this.cwd, 'runtime-enabled', {
        retentionTurns: (this.config as any).safety?.snapshotRetentionTurns ?? 50,
      });
    }
    if (!enabled && this.snapshotService) {
      // Don't destroy outstanding snapshots — user may still want to restore.
      // Just stop taking NEW ones by nulling the service reference for new tool calls.
      this.snapshotService = undefined;
    }
    (this.config as any).safety = { ...(this.config as any).safety, autoSnapshot: enabled };
  }

  /**
   * Queue a mid-task steering note (from `/btw …`). Picked up at the top of the next
   * run-loop iteration and injected into the conversation. Safe to call while a run
   * is in flight; no-ops on an empty/whitespace note.
   */
  pushSteer(note: string): void {
    if (typeof note === 'string' && note.trim().length > 0) {
      this.steerQueue.push(note.trim());
    }
  }

  /** True when there are steering notes waiting to be injected. */
  hasPendingSteer(): boolean {
    return this.steerQueue.length > 0;
  }

  /**
   * Run a sub-agent inline. Used by the `task` tool.
   *
   * Architecture: sub-agent gets a fresh AgentLoop with the same router/registry/perms
   * but a new session id and an isolated message history. Tools run in 'subagent' mode
   * (task and present_plan filtered). We drain the event stream and collect just the
   * final text + tool-call count.
   *
   * The sub-agent's events ARE persisted to the session store under its sub-session id —
   * so `qx sessions` will list it as a child, debuggable independently. We do NOT
   * pipe sub-agent UI events to the parent's UI; the parent just sees the eventual
   * tool result.
   */
  async runSubagent(
    prompt: string,
    opts: {
      maxIterations: number;
      signal?: AbortSignal;
      sessionId: string;
      modelOverride?: string;
      /** Role name — drives model selection, system prompt, tool restriction. Default 'subagent'. */
      role?: string;
    },
  ): Promise<{ finalText: string; toolCallsRun: number; ok: boolean; error?: string; modelUsed?: string }> {
    let finalText = '';
    let toolCallsRun = 0;
    let errMsg: string | undefined;
    let ok = true;
    let modelUsed: string | undefined;
    try {
      const role = opts.role ?? 'subagent';
      // Resolve which model this sub-agent should use, applying the precedence rules:
      // explicit (opts.modelOverride) > session override > config.roles.<role> > config.roles.subagent > parent default.
      const resolved = resolveRole(role, this.config, opts.modelOverride);
      modelUsed = `${resolved.provider}/${resolved.model}`;
      logger.info('Sub-agent model resolved', {
        role,
        provider: resolved.provider,
        model: resolved.model,
        source: resolved.source,
        sessionId: opts.sessionId,
      });

      // The child session id is fabricated by the dispatcher (`<parent>/sub-<ts>`,
      // `<parent>/fanout-<n>`, …) and has no row in `sessions` yet — but
      // messages.session_id carries a FK to sessions.id, so the sub-agent's FIRST
      // recordTurn would fail with "FOREIGN KEY constraint failed", killing every
      // delegation instantly. Create the parent row up front (idempotent).
      getSessionStore().ensureSession(opts.sessionId, this.cwd, modelUsed);

      // Role-specific tool restriction (allow-list). Built-in policy:
      //   - vision role: only vision_analyze + read-only browser/file/web tools
      //   - subagent role: everything except `task` (no recursion) — handled by mode=subagent
      const roleConfig = (this.config as any).roles?.[role] as { allowedTools?: string[] } | undefined;
      let allowedTools = roleConfig?.allowedTools;
      if (!allowedTools && role === 'vision') {
        // Sensible default for vision role: it should ANALYZE images, not refactor code.
        // Keep it focused — read-only inspection + the vision tool.
        allowedTools = [
          'vision_analyze',
          'read_file', 'ls', 'glob', 'grep',
          'browser_navigate', 'browser_screenshot', 'browser_get_text',
          'browser_console', 'browser_wait_for', 'browser_close',
          'web_fetch',
        ];
      } else if (!allowedTools && role === 'scout') {
        // Scout role: read-only reconnaissance for the `gather` tool. Collects data/
        // context for the parent to decide on — must NEVER mutate. Restricted to
        // read-only inspection tools (any missing one just degrades gracefully).
        allowedTools = [
          'read_file', 'ls', 'glob', 'grep', 'semantic_search',
          'project_overview', 'explain_codebase', 'data_flow', 'analyze_impact', 'find_dead_code',
          'git_status', 'git_diff', 'git_log',
          'db_schema', 'db_query', 'openapi_digest', 'backend_routemap',
          'web_search', 'web_fetch', 'media_probe',
          'project_recall', 'recall',
        ];
      }

      // Build a fresh message stack — sub-agent has NO prior context. The system
      // prompt is selected per-role; built-ins (subagent, vision) have crafted defaults.
      // Custom roles can override via config.roles.<name>.systemPrompt.
      //
      // CRITICAL: we pass `allowedTools` so the system prompt lists ONLY the tools the
      // sub-agent can actually call. Small/quantized models will hallucinate they don't
      // have web_search if it isn't named in prose — see Sub-Agent persona fix.
      const initialMessages = await this.buildInitialMessages(prompt, 'subagent', resolved.model, role, allowedTools);

      for await (const event of this.run(initialMessages, opts.sessionId, {
        mode: { mode: 'subagent', allowedTools },
        signal: opts.signal,
        // run() reads `maxIterationsOverride` (not `maxIterations`) to cap the child's
        // budget — passing the wrong key silently left every sub-agent on the parent's
        // full iteration budget. Pass BOTH so the cap actually applies.
        maxIterationsOverride: opts.maxIterations,
        maxIterations: opts.maxIterations,
        modelOverride: { provider: resolved.provider, model: resolved.model },
        // A sub-agent runs unattended: it has no interactive user to answer a
        // permission prompt. Without an askUser, any tool that prompts would call
        // `ctx.askUser` === undefined and crash the whole delegation. Supply a
        // conservative auto-decline so a gated tool degrades to a tool-level refusal
        // (which the child can adapt to) instead of killing the run.
        askUser: async () => 'no',
      } as any)) {
        if (event.type === 'tool_call_start') toolCallsRun += 1;
        if (event.type === 'final') {
          finalText = (event.data as any)?.content ?? '';
        }
        if (event.type === 'error') {
          ok = false;
          // ROOT CAUSE of "delegation returns nothing useful on failure": the loop
          // emits error events as `{ data: { message } }` (see every `type: 'error'`
          // yield in run()), but this consumer read `data.error` — which is ALWAYS
          // undefined — so the parent got "[SUBAGENT_FAILED] … Error: unknown" with the
          // real reason (stream error, budget-exceeded, cancellation) discarded. Read
          // `message` first; keep `error` as a fallback for any future shape.
          errMsg = (event.data as any)?.message ?? (event.data as any)?.error ?? 'unknown';
        }
      }
    } catch (e: any) {
      ok = false;
      errMsg = e.message ?? String(e);
    }
    return { finalText, toolCallsRun, ok, error: errMsg, modelUsed };
  }

  /** Build the initial system message with full context. */
  async buildInitialMessages(
    userPrompt: string,
    mode: ToolExecutionMode['mode'],
    modelId: string,
    /** Sub-agent role name. Affects system prompt selection. */
    role?: string,
    /** Tools actually available to this run; if provided, drives the "Available tools:"
     *  line so a restricted sub-agent doesn't think it has tools the registry filters out. */
    allowedTools?: string[],
  ): Promise<Message[]> {
    // Resolve the real provider serving this model so the Identity section can
    // report the actual runtime model (not a hardcoded example). Best-effort.
    let providerName: string | undefined;
    let resolvedModelId = modelId;
    try {
      const r = this.router.resolveModel(modelId);
      if (r) { providerName = r.provider.name; resolvedModelId = r.resolvedId || modelId; }
    } catch { /* router not ready / model unknown — fall back to the raw id */ }
    // If the user attached a directory ("[Attached directory: X]"), adopt it as the working
    // root so tools that default to cwd (detect_frontend_stack, analyze_design_system, …) look
    // in the right place instead of the launch dir. Sticky: once attached, it holds for later
    // turns in this session until a new directory is attached.
    const attachedDir = extractAttachedDir(userPrompt);
    if (attachedDir) {
      try { if (fsSync.statSync(attachedDir).isDirectory()) this.effectiveCwd = attachedDir; } catch { /* not a real dir — ignore */ }
    }
    const [projectInfo, projectRules, directoryTree, gitBranch, projectSignals, trellis] = await Promise.all([
      detectProjectInfo(this.cwd),
      loadProjectRules(this.cwd),
      // Pass the user prompt as a hint so the tree builder can weight relevant folders.
      // This is the "Semantic Tree Pruning" optimisation from v0.4.9 — no pre-pass LLM
      // call needed; just keyword matching against TOPIC_FOLDER_HINTS.
      buildDirectoryTree(this.cwd, { userPromptHint: userPrompt }),
      getGitBranch(this.cwd),
      // Stack signals from disk (package.json deps + marker files) — combined with the
      // user's words to pick the specialist expertise block(s) for this turn.
      detectProjectSignals(this.cwd),
      // Trellis harness (.trellis/ spec+tasks+journals), if the project uses it.
      loadTrellisContext(this.cwd),
    ]);
    // Light Memory Mode: in 'lightweight' the prompt carries only !important facts + the newest
    // others within a token budget (the rest stay in the DB, recall-on-demand); 'auto' switches to
    // lightweight on a small context window; 'full' (default) injects everything.
    const { selectInjectedFacts, resolveMemoryMode } = await import('../context/memory-select.js');
    const memCfg = (this.config as any).memory ?? {};
    const memMode = resolveMemoryMode(memCfg.mode, this.defaultContextWindow);
    const allFacts = getSessionStore().getFactsForCwd(this.cwd);
    const knowledgeFacts = selectInjectedFacts(allFacts, { mode: memMode, injectMaxTokens: memCfg.injectMaxTokens });
    if (memMode === 'lightweight' && knowledgeFacts.length < allFacts.length) {
      // Transparency: tell the model (and the log) that memory was injected as a budgeted subset.
      logger.info('Light memory: injected a budgeted subset of facts', { shown: knowledgeFacts.length, total: allFacts.length });
      knowledgeFacts.unshift(`(light memory active — ${knowledgeFacts.length} of ${allFacts.length} learned facts shown within budget; ask me to recall the rest)`);
    }
    // Project memory: prepend a brief of what was done in this project in earlier
    // sessions, so a new/resumed session continues instead of restarting. Rides the
    // existing facts-injection path (no prompt-assembly surgery), and is skipped
    // (null) when there's no project/worklog yet.
    const projectBrief = getSessionStore().getProjectBriefingFact(this.cwd);
    if (projectBrief) knowledgeFacts.unshift(projectBrief);

    // Fold the Trellis harness block (if any) into the project-rules text so it
    // rides the same injection path as CLAUDE.md — present in both the role and
    // non-role prompt branches without duplicating plumbing.
    const mergedProjectRules = trellis
      ? [trellis.block, projectRules?.content].filter(Boolean).join('\n\n')
      : projectRules?.content;

    // Role-specific system prompt override.
    // Precedence: config.roles.<role>.systemPrompt > built-in role prompt > default
    const roleConfig = (this.config as any).roles?.[role ?? ''] as { systemPrompt?: string } | undefined;
    const builtinRolePrompt = role ? getBuiltinRolePrompt(role) : undefined;
    const customSysPromptOverride = roleConfig?.systemPrompt ?? builtinRolePrompt;

    // Resolve which tools the sub-agent can ACTUALLY call this turn, honoring an
    // allowedTools allow-list (vision role, custom role allowlist, etc).
    const allRegistered = this.registry.list().map(t => t.name);
    const effectiveTools = allowedTools && allowedTools.length > 0
      ? allRegistered.filter(n => allowedTools.includes(n))
      : allRegistered;

    // Per-provider prompt steering for custom OpenAI-compatible providers
    // (providers.custom[].systemPromptAppend / systemPromptOverride). Lets you tune
    // behavior per gateway — e.g. "you have 1M context, read whole files" for Gemini
    // vs "be terse" for a fast small model. Tunes BEHAVIOR; it cannot raise the
    // model's reasoning ceiling.
    const providerPromptCfg = findCustomProviderPromptConfig(
      (this.config.providers as any).custom, providerName,
    );

    let sysPrompt: string;
    if (customSysPromptOverride) {
      // Role-specific prompt: skip the heavy project-context preamble since the
      // role is purposefully focused. We still re-state QodeX identity AND the EXACT
      // available tools — small local models (Qwen 6-bit on LM Studio) lose identity
      // and tool awareness when relying only on the role prompt body.
      sysPrompt = `You are **QodeX**, a local-first agentic coding CLI. When asked "who are you" or "what model", answer "I am QodeX" — never identify as the underlying LLM (Claude/GPT/Qwen/DeepSeek). The role brief below tells you your CURRENT JOB:\n\n` +
        `${customSysPromptOverride}\n\n` +
        (trellis?.specBlock ? `${trellis.specBlock}\n\n` : '') +
        `Working directory: ${this.cwd}\n` +
        `Git branch: ${gitBranch ?? '(none)'}\n` +
        `Available tools (the only ones you can call this turn): ${effectiveTools.join(', ')}\n` +
        `If a task needs web data, use \`web_search\` / \`web_fetch\` (if listed above). Do not claim you lack internet access — those tools ARE your internet access.`;
    } else if (providerPromptCfg?.override) {
      // Provider-level full override (power user). Replace the prompt BODY but keep
      // identity + tool awareness — small models lose both without it (same safety
      // the role-override path applies above).
      sysPrompt = `You are **QodeX**, a local-first agentic coding CLI. When asked "who are you" or "what model", answer "I am QodeX" — never identify as the underlying LLM (Claude/GPT/Qwen/DeepSeek/Llama). The guidance below is your operating brief:\n\n` +
        `${providerPromptCfg.override}\n\n` +
        `Working directory: ${this.cwd}\n` +
        `Git branch: ${gitBranch ?? '(none)'}\n` +
        `Available tools (the only ones you can call this turn): ${effectiveTools.join(', ')}\n` +
        `If a task needs web data, use \`web_search\` / \`web_fetch\` (if listed above). Do not claim you lack internet access — those tools ARE your internet access.`;
    } else {
      // Classify the user's intent so the prompt can inject task-shaped reasoning.
      const taskClass = this.classifyForPrompt([{ role: 'user', content: userPrompt }]);
      // Stack-specialist expertise: detect from the user's words + what's on disk, then
      // inject the deep how-an-expert-builds-THIS block(s). Orthogonal to task class.
      const stacks = detectStacks(userPrompt, projectSignals);
      const stackAddendum = buildStackAddendum(stacks);
      if (stacks.length > 0) logger.info('Stack specialist profiles active', { stacks });
      sysPrompt = buildSystemPrompt({
        cwd: this.cwd,
        mode,
        modelFamily: detectModelFamily(modelId),
        modelId: resolvedModelId,
        providerName,
        projectInfo: { ...projectInfo },
        projectRules: mergedProjectRules,
        knowledgeFacts,
        directoryTree,
        gitBranch,
        availableToolNames: effectiveTools,
        taskClass,
        stackAddendum,
        skillsBlock: buildSkillsSystemBlock({ prompt: userPrompt }),
      });
    }

    // Provider-specific guidance, appended on top of whatever base prompt was built
    // (default, role-override, or provider-override). Additive behavioral steering —
    // does NOT replace the read-before-write rule or tool list above it.
    if (providerPromptCfg?.append) {
      sysPrompt = sysPrompt +
        `\n\n# Provider-specific guidance (${providerName})\n${providerPromptCfg.append}`;
    }

    // Static/volatile split: injections are routed into two buffers so the prompt-cache
    // boundary lands between them. `stableTail` holds session-stable guidance (code style,
    // failure lessons) that is byte-identical across turns → folded into the CACHED core.
    // `volatileTail` holds genuinely per-turn context (retrieval, dep-graph, episodic recall)
    // that changes with the query → kept AFTER the boundary so it never invalidates the core.
    let stableTail = '';
    let volatileTail = '';

    // ── Auto-retrieval pre-pass (best-effort) ──
    // Embed the request and inject the most semantically-relevant files so the model
    // starts at the right place in a large codebase instead of grepping blind. Only for
    // top-level normal turns (sub-agents/vision are already scoped). NEVER blocks: bounded
    // by a short timeout and any failure is swallowed to null.
    if (mode === 'normal' && !customSysPromptOverride && !isTrivialMessage(userPrompt)) {
      const ctxCfg = (this.config as any).context ?? {};
      if (ctxCfg.autoRetrieve !== false) {
        try {
          const buildInline = ctxCfg.buildIndexIfMissing === true;
          const files = await retrieveRelevantFiles(this.cwd, userPrompt, {
            embeddingModel: ctxCfg.embeddingModel,
            maxFiles: ctxCfg.retrieveTopFiles ?? 6,
            buildIfMissing: buildInline,
            // Stage-2 cross-encoder rerank (opt-in via config.context.rerank).
            rerank: ctxCfg.rerank === true,
            rerankModel: ctxCfg.rerankModel,
            rerankBaseUrl: ctxCfg.rerankBaseUrl,
            rerankCandidates: ctxCfg.rerankCandidates,
            signal: AbortSignal.timeout(buildInline ? 60_000 : (ctxCfg.rerank ? 8_000 : 4_000)),
          });
          if (files && files.length > 0) {
            const block = formatRetrievalBlock(files);
            if (block) volatileTail += `\n\n${block}`;
            logger.info('Auto-retrieval injected relevant files', { count: files.length });

            // ── Symbol-graph daemon: proactive ripple-effect meta-context ──
            // For the files we're about to show the model, surface their direct
            // upstream/downstream neighbors so it never forgets a change ripples.
            // Opt-in (context.dependencyMap) and best-effort.
            if (ctxCfg.dependencyMap !== false) {
              try {
                const { getSymbolGraph, dependencyContextFor, renderDependencyContext } = await import('../context/symbol-graph.js');
                const graph = await getSymbolGraph(this.cwd, { signal: AbortSignal.timeout(4_000) });
                if (graph) {
                  const seeds = files.map(f => f.file);
                  const deps = dependencyContextFor(graph, seeds);
                  const depBlock = renderDependencyContext(deps);
                  if (depBlock) {
                    volatileTail += `\n\n${depBlock}`;
                    logger.debug('Symbol-graph meta-context injected', { seeds: seeds.length, withDeps: deps.length });
                  }
                }
              } catch (e: any) {
                logger.debug('Symbol-graph injection skipped', { err: e?.message });
              }
            }
          }
        } catch (e: any) {
          logger.debug('Auto-retrieval pre-pass failed (ignored)', { err: e?.message });
        }
      }
    }

    // ── User-preference modeling: match the project's code style automatically ──
    // Inferred once per session (deterministic, cached), injected so generated code blends
    // in without the user having to `remember` their conventions. Off via context.styleProfile:false.
    if ((this.config as any).context?.styleProfile !== false && mode !== 'plan') {
      try {
        if (this.styleBlock === null) {
          const { scanProjectStyle, buildStyleBlock } = await import('../context/style-profile.js');
          this.styleBlock = buildStyleBlock(await scanProjectStyle(this.cwd));
        }
        if (this.styleBlock) stableTail += `\n\n${this.styleBlock}`;
      } catch (e: any) {
        logger.debug('Style-profile injection skipped', { err: e?.message });
        this.styleBlock = ''; // don't retry every turn on failure
      }
    }

    // ── Episodic memory: recall the most SIMILAR past task on this project ──
    // Smart retrieval (top-K above a similarity threshold), concise injection. An unrelated
    // task injects nothing. Opt-in via learning.episodicMemory.enabled.
    const emCfg = (this.config as any).learning?.episodicMemory;
    if (emCfg?.enabled && mode !== 'plan') {
      try {
        const { loadEpisodeBlock } = await import('../context/episodic-memory.js');
        const block = await loadEpisodeBlock(this.cwd, String(userPrompt), {
          topK: emCfg.topK ?? 2,
          minScore: emCfg.minSimilarity ?? 0.18,
          diversity: emCfg.diversity ?? 0.3,
        });
        if (block) { volatileTail += `\n\n${block}`; logger.info('Episodic memory injected'); }
      } catch (e: any) {
        logger.debug('Episodic recall skipped', { err: e?.message });
      }
    }

    // ── Failure-driven learning: inject cautions mined from RECURRING past failures ──
    // Deterministic, bounded, opt-in. Also stamp this run's task key so failures we
    // record below are attributable to a distinct task (the repetition gate counts tasks).
    const flCfg = (this.config as any).learning?.failureLessons;
    if (flCfg?.enabled) {
      try {
        const { loadLessonsBlock, taskKey } = await import('../skills/learning/failures.js');
        this.currentTaskKey = taskKey(String(userPrompt));
        const block = await loadLessonsBlock({
          minOccurrences: flCfg.minOccurrences ?? 3,
          minDistinctTasks: flCfg.minDistinctTasks ?? 2,
          topK: flCfg.maxInjected ?? 5,
        });
        if (block) { stableTail += `\n\n${block}`; logger.info('Learned cautions injected'); }
      } catch (e: any) {
        logger.debug('Failure-lessons injection skipped', { err: e?.message });
      }
    }

    // Assemble: [ cached core = base + stable guidance ] [ boundary ] [ volatile per-turn ctx ].
    const cachedCore = sysPrompt + stableTail;
    return [
      { role: 'system', content: cachedCore + volatileTail, cacheBoundary: cachedCore.length },
      { role: 'user', content: userPrompt },
    ];
  }

  /** Run the agent loop on an existing message history. */
  /**
   * Sandboxed wrapper around run(). When `config.sandbox.enabled` and we're in a
   * git repo, this runs the whole task on a hidden `qodex/sandbox-<id>` branch:
   * the agent experiments freely, and we squash-merge onto the user's branch only
   * if the task completed (a `final` event, not an error/abort). On error or
   * cancel we abandon the branch and restore the user's original state — the
   * messy trial-and-error never touches their working branch.
   *
   * The inner run() generator is reused verbatim (no edits to that complex code
   * path); this wrapper only owns the git lifecycle, keeping concerns separate.
   * If sandbox can't start (non-git, disabled), it transparently delegates to run().
   */
  async *runSandboxed(
    messages: Message[],
    sessionId: string,
    options: AgentOptions,
  ): AsyncGenerator<AgentEvent> {
    const sandboxEnabled = (this.config as any).sandbox?.enabled === true
      && (options.mode?.mode ?? 'normal') === 'normal'
      && process.env.QODEX_SANDBOX !== '0';

    if (!sandboxEnabled) {
      yield* this.run(messages, sessionId, options);
      return;
    }

    const sandbox = new GitSandbox(this.cwd);
    const taskId = sessionId.slice(0, 8) + '-' + Date.now().toString(36);
    const started = await sandbox.begin(taskId, options.signal).catch(() => false);
    if (!started) {
      // Couldn't isolate (non-git, dirty-stash failure, …) → run normally.
      yield* this.run(messages, sessionId, options);
      return;
    }

    // Expose backtrack/checkpoint to tools via the wired sandbox handle.
    this.activeSandbox = sandbox;
    let reachedFinal = false;
    const firstUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content ?? 'task';
    // Flywheel: collect the reasoning trace + final answer from the event stream
    // (no edits to run() needed — we observe what it already emits).
    const flywheelEnabled = (this.config as any).flywheel?.enabled === true;
    const reasoning: string[] = [];
    let finalContent = '';
    try {
      yield { type: 'notice', data: { message: `🔒 Sandbox: working on ${sandbox.branch} (isolated)` } };
      for await (const ev of this.run(messages, sessionId, options)) {
        if (ev.type === 'final') { reachedFinal = true; finalContent = (ev as any).data?.content ?? ''; }
        if (flywheelEnabled && (ev.type as string) === 'thinking') {
          const c = (ev as any).data?.content;
          if (typeof c === 'string' && !c.startsWith('(format correction')) reasoning.push(c);
        }
        yield ev;
      }
    } catch (e: any) {
      logger.warn('runSandboxed: inner run threw — abandoning sandbox', { err: e?.message });
      throw e;
    } finally {
      this.activeSandbox = null;
      const commitMsg = `qodex: ${String(firstUserMsg).slice(0, 72).replace(/\n/g, ' ')}`;
      // Capture the changed-file list from git BEFORE finishing (the sandbox
      // branch still has the diff). Best-effort.
      let changedFiles: string[] = [];
      if ((flywheelEnabled || process.env.QODEX_RECEIPT_FILE) && reachedFinal) {
        try {
          const { git } = await import('../tools/git/git-runner.js');
          const diff = await git(['diff', '--name-only', sandbox.baseCommitRef() ?? 'HEAD'], { cwd: this.cwd, signal: options.signal });
          if (diff.exitCode === 0) changedFiles = diff.stdout.split('\n').map(s => s.trim()).filter(Boolean);
        } catch { /* ignore */ }
      }
      // Capture the branch name BEFORE finish() (it nulls internal state) so we
      // can point the user at their work if the merge fails.
      const sandboxBranch = sandbox.branch;
      const finishResult = await sandbox.finish(reachedFinal, commitMsg, options.signal)
        .catch((e: any) => ({ merged: false as const, reason: 'error' as const, error: e?.message ? String(e.message) : undefined }));
      const merged = finishResult.merged;
      if (reachedFinal && merged) {
        yield { type: 'notice', data: { message: '🔒 Sandbox: changes squash-merged onto your branch ✓' } };
        // ── Data flywheel: record this successful trajectory (opt-in) ──
        if (flywheelEnabled) {
          try {
            const { recordTrajectory } = await import('./trajectory.js');
            await recordTrajectory(this.cwd, {
              prompt: String(firstUserMsg),
              reasoning,
              filesChanged: changedFiles,
              finalSummary: finalContent.slice(0, 500),
              messages: [
                { role: 'user', content: String(firstUserMsg) },
                { role: 'assistant', content: finalContent },
              ],
            });
          } catch (e: any) {
            logger.debug('Flywheel record skipped', { err: e?.message });
          }
          // ── Zero-cost distillation: export the FULL conversation as ShareGPT JSONL ──
          // Same objective-success gate; uses the complete message history (not the
          // truncated summary) so the dataset is training-ready. Strictly local, opt-in.
          if ((this.config as any).flywheel?.datasetExport) {
            try {
              const { appendShareGptRecord } = await import('./dataset-export.js');
              await appendShareGptRecord(this.cwd, messages);
            } catch (e: any) {
              logger.debug('Dataset export skipped', { err: e?.message });
            }
          }
          // ── Episodic memory: record a lean "how I solved this" episode for later recall ──
          if ((this.config as any).learning?.episodicMemory?.enabled) {
            try {
              const { recordEpisode } = await import('../context/episodic-memory.js');
              await recordEpisode(this.cwd, {
                prompt: String(firstUserMsg),
                summary: finalContent.slice(0, 300),
                filesChanged: changedFiles,
                toolsUsed: [...this.sessionToolNames],
                toolCalls: this.totalToolCalls,
                // This branch IS the objective-success path (sandbox compiled + merged, verify +
                // completion gates passed) — recall can boost these over unverified history.
                verified: true,
              });
            } catch (e: any) {
              logger.debug('Episode record skipped', { err: e?.message });
            }
          }
        }
        // ── Skill-learning: capture a CANDIDATE skill (opt-in, quarantined) ──
        // We're on the objectively-successful path: the sandbox compiled and squash-merged,
        // having already passed the inner verify + completion gates. So capture is gated on
        // real signals, never the model's self-grade. The candidate is written to a separate
        // quarantine dir; it is NOT loaded and CANNOT overwrite a human skill until an
        // independent judge promotes it (see src/skills/learning/).
        const learningCfg = (this.config as any).learning;
        let capturedThisRun = false;
        if (learningCfg?.enabled) {
          try {
            const { captureEligible } = await import('../skills/learning/capture.js');
            const signal = { toolCalls: this.totalToolCalls, verifyClean: true, completionHonest: true, toolsUsed: [...this.sessionToolNames], filesChanged: changedFiles };
            const elig = captureEligible(signal, { minToolCalls: learningCfg.minToolCalls ?? 5, requireObjectiveSuccess: learningCfg.requireObjectiveSuccess !== false });
            if (elig.eligible) {
              const { buildCandidateSkill } = await import('../skills/learning/capture.js');
              const { writeCandidate } = await import('../skills/learning/candidate-store.js');
              const { scoreConfidence } = await import('../skills/learning/confidence.js');
              const { recordLearningEvent } = await import('../skills/learning/ledger.js');
              const confidence = scoreConfidence(signal).score;
              const candidate = buildCandidateSkill(
                { prompt: String(firstUserMsg), finalSummary: finalContent.slice(0, 500), toolsUsed: [...this.sessionToolNames], filesChanged: changedFiles },
                { nowIso: new Date().toISOString(), confidence },
              );
              await writeCandidate(candidate);
              capturedThisRun = true;
              await recordLearningEvent({ event: 'capture', name: candidate.name, confidence });
              // Code-graph grounding: how much of this skill references symbols that really exist here.
              let fitSuffix = '';
              try {
                const { getCodeGraphDB } = await import('../codegraph/tools.js');
                const db = getCodeGraphDB();
                if (db) {
                  const { extractSymbolHints, codebaseFitScore } = await import('../skills/learning/codebase-fit.js');
                  const fit = codebaseFitScore(extractSymbolHints(candidate.skillMd), n => db.findSymbolsByName(n, undefined, 1).length > 0);
                  if (!fit.noSignal) fitSuffix = ` · codebase-fit ${Math.round(fit.score * 100)}%`;
                }
              } catch { /* code graph optional */ }
              yield { type: 'notice', data: { message: `🎓 Captured candidate skill "${candidate.name}" (confidence ${confidence}/100${fitSuffix}) — review with \`qodex skill candidates\`, promote with \`qodex skill promote ${candidate.name}\`.` } };

              // Auto-Evaluation (opt-in): immediately replay the captured skill in a clean
              // worktree and record whether it produces verified code. Costs a model call +
              // worktree, so it's behind learning.autoEval. Best-effort — the task already
              // succeeded; an eval failure here never affects it.
              if (learningCfg.autoEval) {
                try {
                  const { evalSkillMd } = await import('../skills/learning/eval.js');
                  const { formatEvalSection, upsertEvalSection, skillContentHash } = await import('../skills/learning/eval-record.js');
                  const { candidatesDir } = await import('../skills/learning/candidate-store.js');
                  const { result } = await evalSkillMd(this.cwd, candidate.skillMd, { noCache: true });
                  if (result) {
                    const fsmod = await import('fs');
                    const pathmod = await import('path');
                    const file = pathmod.join(candidatesDir(), candidate.name, 'SKILL.md');
                    const updated = upsertEvalSection(candidate.skillMd, formatEvalSection(result, skillContentHash(candidate.skillMd)));
                    await fsmod.promises.writeFile(file, updated, 'utf-8');
                    await recordLearningEvent({ event: 'eval', name: candidate.name, evalStatus: result.status });
                    yield { type: 'notice', data: { message: `🧪 Auto-eval of "${candidate.name}": ${result.status}.` } };
                  }
                } catch (e: any) {
                  logger.debug('Auto-eval after capture skipped', { err: e?.message });
                }
              }
            } else {
              logger.debug('Skill capture skipped', { reason: elig.reason });
            }
          } catch (e: any) {
            logger.debug('Skill capture skipped (error)', { err: e?.message });
          }
        }
        // ── Code-graph skill SUGGESTION ── Whenever nothing was captured (learning off, OR on but
        // the task wasn't capture-eligible), still nudge the user when the work looks like a REUSABLE
        // pattern, judged from the SHAPE of the change via the code graph (focused + cohesive +
        // multi-file). The judgment a code-graph-less agent can't make. A gentle one-liner; off via
        // learning.suggestSkills:false; conservative (only fires for real patterns), never duplicative.
        if (!capturedThisRun && learningCfg?.suggestSkills !== false && changedFiles.length >= 2) {
          try {
            const { suggestSkillFromSession, commonArea } = await import('../skills/learning/skill-suggest.js');
            const area = commonArea(changedFiles);
            const inArea = changedFiles.filter(f => f.split('/').slice(0, 2).join('/') === area).length;
            const cohesion = changedFiles.length ? inArea / changedFiles.length : 0;
            const s = suggestSkillFromSession({ prompt: String(firstUserMsg), changedFiles, cohesion });
            if (s.worth) {
              const how = learningCfg?.enabled
                ? `run \`qodex skill candidates\` to capture it`
                : `enable \`learning.enabled\` to auto-capture skills like this`;
              yield { type: 'notice', data: { message: `💡 This looks reusable ("${s.proposedName}") — ${s.reason} ${how}.` } };
            }
          } catch { /* best-effort */ }
        }
      } else if (reachedFinal && !merged) {
        if (!finishResult.merged && finishResult.reason === 'empty') {
          yield { type: 'notice', data: { message: '🔒 Sandbox: nothing to merge (no committed changes)' } };
        } else {
          // Real merge failure (conflict/error): the work is NOT lost — it's still
          // on the sandbox branch. Tell the user distinctly so they don't think
          // their changes simply vanished.
          const reason = !finishResult.merged ? finishResult.reason : 'error';
          const errSuffix = (!finishResult.merged && finishResult.error) ? ` (${finishResult.error})` : '';
          const branchSuffix = sandboxBranch ? ` Your work is preserved on branch '${sandboxBranch}'.` : ' Your work is preserved on the sandbox branch.';
          yield { type: 'notice', data: { message: `🔒 Sandbox: FAILED to merge your changes onto your branch (${reason})${errSuffix}.${branchSuffix}` } };
        }
      } else {
        yield { type: 'notice', data: { message: '🔒 Sandbox: task did not complete — your branch was left untouched' } };
      }

      // Ground-truth trust receipt for unattended/scheduled runs. QodeX writes it from ITS OWN
      // signals — the git diff + the checkers it actually ran — so the model can't fabricate it.
      await this.writeRunReceipt({ reachedFinal, merged, finalContent, changedFiles, signal: options.signal });
    }
  }

  /** Write an audit receipt to QODEX_RECEIPT_FILE (set by the scheduler) from ground-truth
   *  signals: the git diff + the verify ledger. Status/PR come from the model's headline (a
   *  checkable claim); the FACTS (files, checks) are what QodeX measured. Best-effort. */
  private async writeRunReceipt(opts: { reachedFinal: boolean; merged: boolean; finalContent: string; changedFiles: string[]; signal?: AbortSignal }): Promise<void> {
    const file = process.env.QODEX_RECEIPT_FILE;
    if (!file) return;
    try {
      const { parseReceipt, buildGroundTruthReceipt } = await import('../schedule/receipt.js');
      const headline = parseReceipt(opts.finalContent); // the model's claimed status + PR url
      const status: 'opened' | 'blocked' | 'done' | 'failed' =
        headline?.status === 'opened' ? 'opened'
        : headline?.status === 'blocked' ? 'blocked'
        : opts.merged ? 'done'
        : opts.reachedFinal ? 'blocked'
        : 'failed';
      const receipt = buildGroundTruthReceipt({
        status,
        prUrl: headline?.prUrl,
        reason: headline?.reason,
        filesChanged: opts.changedFiles,
        verification: this.verifyLedger,
        summary: opts.finalContent.replace(/\s+/g, ' ').trim().slice(0, 200) || undefined,
      });
      const { promises: fs } = await import('fs');
      await fs.writeFile(file, JSON.stringify(receipt), 'utf-8');
    } catch (e: any) {
      logger.debug('run receipt not written', { err: e?.message });
    }
  }

  /** Re-derive auto-compaction + efficiency state from the current this.config. Idempotent:
   *  resets the two efficiency-affected fields to their base before applying, so a hot-reload
   *  can REVERT a toggle (e.g. context.efficient turned back off) as well as apply one. */
  private applyConfigDerived(): void {
    this.autoCompactEnabled = true;
    this.autoCompactThreshold = 0.75;
    const cfg = this.config as any;
    const compactCfg = cfg.compaction;
    if (cfg?.context?.efficient === true) this.autoCompactThreshold = efficiencyDefaults(true).compactThreshold;
    if (compactCfg) {
      if (typeof compactCfg.enabled === 'boolean') this.autoCompactEnabled = compactCfg.enabled;
      if (typeof compactCfg.threshold === 'number') this.autoCompactThreshold = compactCfg.threshold;
      if (typeof compactCfg.contextWindow === 'number') {
        this.defaultContextWindow = compactCfg.contextWindow;
        this.contextWindowExplicit = true;
      }
    }
  }

  /** Hot-reload the user-toggleable knobs from disk at the START of a run. The dashboard writes
   *  ~/.qodex/config.yaml in a SEPARATE process; without this, a running session kept its
   *  startup config until restart (the "I toggled it but nothing changed" bug). We overlay ONLY
   *  the whitelisted dashboard knobs onto this.config — CLI/session overrides and everything
   *  else are preserved — then re-derive. Best-effort: a bad/locked file never blocks the run. */
  private async refreshMutableConfig(): Promise<void> {
    try {
      const { loadConfig } = await import('../config/loader.js');
      const { CONFIG_KNOBS, getDeep, setDeep } = await import('../cli/dashboard-control.js');
      const fresh = await loadConfig(this.cwd);
      const changed: string[] = [];
      for (const k of CONFIG_KNOBS) {
        const next = getDeep(fresh as any, k.path);
        if (next === undefined) continue;                       // absent in file → leave current
        if (getDeep(this.config as any, k.path) !== next) { setDeep(this.config as any, k.path, next); changed.push(k.path); }
      }
      if (changed.length) {
        this.applyConfigDerived();
        logger.info('Config hot-reloaded for this run', { knobs: changed });
      }
    } catch (e: any) {
      logger.debug('Config hot-reload skipped', { err: e?.message });
    }
  }

  async *run(
    messages: Message[],
    sessionId: string,
    options: AgentOptions,
  ): AsyncGenerator<AgentEvent> {
    await this.refreshMutableConfig();   // pick up dashboard toggles written since the last run
    const mode = options.mode ?? { mode: 'normal' };

    // ── Tool diet (perf): config `tools.disabled` + AUTO PROFILE ──
    // Two layers, user always wins:
    //   1. Explicit `tools.disabled` patterns from config — always applied.
    //   2. Auto profile (default ON, off via `tools.autoProfile:false`): inspects the
    //      project's real infrastructure (Dockerfile? CI config? media deps?) and the
    //      current request, and disables groups that are dead weight for THIS project.
    //      Prompt mentions win over missing infra ("dockerize this" keeps docker tools
    //      even with no Dockerfile yet). Session ratchet: groups re-enable mid-session
    //      when mentioned, but are never newly disabled mid-session — the tool list
    //      only grows, keeping the serialized schema prefix stable for caching.
    {
      const allNames = this.registry.list().map(t => t.name);
      const blocked = new Set<string>(mode.blockedTools ?? []);

      const disabledCfg = (this.config as any).tools?.disabled;
      if (Array.isArray(disabledCfg) && disabledCfg.length > 0) {
        for (const n of expandToolPatterns(disabledCfg.map(String), allNames)) blocked.add(n);
      }

      if ((this.config as any).tools?.autoProfile !== false && mode.mode === 'normal') {
        const lastUser = [...messages].reverse().find(m => m.role === 'user');
        const promptText = typeof lastUser?.content === 'string' ? lastUser.content : '';
        if (this.autoDisabledTools === null) {
          // First run of the session: derive from project infra + this prompt.
          try {
            const signals = await detectProjectSignals(this.cwd);
            const infra = await gatherInfraSignals(this.cwd, signals);
            this.autoDisabledTools = deriveAutoDisabledTools(infra, promptText, allNames);
          } catch {
            this.autoDisabledTools = []; // detection failed — disable nothing
          }
        } else {
          // Later runs: ratchet — only ever re-enable groups the new prompt mentions.
          this.autoDisabledTools = ratchetAutoDisabled(this.autoDisabledTools, promptText);
        }
        for (const n of this.autoDisabledTools) blocked.add(n);
        if (this.autoDisabledTools.length > 0) {
          logger.info('Auto tool profile active', {
            autoDisabled: this.autoDisabledTools.length,
            activeTools: allNames.length - blocked.size,
          });
        }
      }

      if (blocked.size > 0) {
        mode.blockedTools = [...blocked].sort();
        logger.info('Tool diet active', { disabled: blocked.size, activeTools: allNames.length - blocked.size });
      }
    }

    // ── Pre-flight architecture gate: arm per-run, normal mode only ──
    // Default ON; disable with `discipline.preflightGate: false` in config or QODEX_PREFLIGHT=0
    // (the eval harness uses the env switch to A/B its contribution). Computed once from the
    // latest user message so it reflects THIS request, not the whole transcript.
    {
      const gateOff = (this.config as any).discipline?.preflightGate === false || process.env.QODEX_PREFLIGHT === '0';
      const lastUser = [...messages].reverse().find(m => m.role === 'user');
      const userText = typeof lastUser?.content === 'string' ? lastUser.content : '';
      this.planGateComplex = !gateOff && mode.mode === 'normal' && looksLikeBuildTask(userText);
      this.planGateSatisfied = false;
      this.planGateFired = false;
      this.completionGateFired = false;
      this.visualGateRetried = false;
    }
    // If sub-agents are disabled in config, surgically block the task tool. This is
    // cleaner than filtering inside the registry: tool stays registered (so /tools
    // listing remains accurate), it just doesn't show up to the model.
    const subagentMode = (this.config as any).subagents?.mode ?? 'sequential';
    if (subagentMode === 'off' && mode.mode === 'normal') {
      const baseBlocked = mode.blockedTools ?? [];
      if (!baseBlocked.includes('task')) {
        (mode as any).blockedTools = [...baseBlocked, 'task'];
      }
    }
    const budget = BudgetTracker.fromConfig(this.config);
    if (options.maxIterationsOverride !== undefined) {
      budget.setMaxIterations(options.maxIterationsOverride);
    }
    const journal = getJournal();
    const sessionStore = getSessionStore();
    const recentCalls: Array<{ name: string; argsHash: string }> = [];
    // Sliding window of recent ERROR results, to catch a "guessing" loop where the model keeps
    // hitting the same kind of error (e.g. FILE_NOT_FOUND) with different args each time.
    const recentErrors: Array<{ name: string; code: string }> = [];
    const noteResult = (name: string, r: { content: string; isError?: boolean }) => {
      // Record hard errors AND "soft failures": exit-0 results whose output shows the action found
      // nothing ("Vite not found", "command not found"). The model loops on these because they look
      // like success; counting them lets detectErrorLoop break the thrash. Threshold (3) guards
      // against one-off futile results from legitimate probes.
      if (!r.isError && !looksFutile(r.content)) return;
      recentErrors.push({ name, code: errorCodeOf(r.content) });
      if (recentErrors.length > 8) recentErrors.shift();
    };
    // Tracks consecutive failures/no-results from the SAME tool, REGARDLESS of args.
    // Catches a pattern the stuck-loop detector misses: the model varies the query
    // every retry (e.g. web_search with different phrasings) so args-hash differs,
    // but the tool keeps returning [NO_RESULTS] / [WEB_SEARCH_ERROR] / [ERROR].
    // After N consecutive empty results from one tool, we inject a system note
    // telling the model to stop retrying and report the limitation to the user.
    const consecutiveFailures: { tool: string | null; count: number } = { tool: null, count: 0 };

    // Cumulative count of each (tool|argsHash) across the WHOLE run. Catches the "restart"
    // loop the sliding window misses: when the codebase is larger than the context window,
    // the model loses its place and re-reads the same files sweep after sweep. Each sweep is
    // longer than the recent-calls window, so only a run-wide tally spots the repetition.
    const callCounts = new Map<string, number>();
    // When set, the next dispatch sends NO tools, forcing the model to answer in plain text
    // (used to break a stuck read loop by making it summarize what it already found).
    let forceTextOnly = false;
    // When set, the next dispatch forces a tool call (toolChoice:'required') — used after a
    // refusal where a tool-capable model talked instead of acting. Strongest "lead" for weak
    // models: the server must emit a tool call, not prose. One-shot; reset after each dispatch.
    let forceToolChoice = false;
    // Scope guard: did the user ask for run/install/test? If not, a one-time advisory fires the
    // first time the model wanders into starting a dev server or installing packages on its own.
    // Derive the latest user message from `messages` (no `userPrompt` param in this method's scope).
    const latestUserText = (() => {
      const lu = [...messages].reverse().find(m => m.role === 'user');
      return typeof lu?.content === 'string' ? lu.content : '';
    })();
    const userAskedExecution = userWantsExecution(latestUserText);
    let scopeNudged = false;

    // ── Auto-verify gate state (model-agnostic quality floor) ──
    // Every source file the model mutates this run, so the finish-boundary gate can
    // type-check exactly what it touched. `verifyRepairAttempts` caps consecutive
    // forced-repair rounds; `verifyGaveUp` ensures the give-up note is shown only once.
    const touchedSourceFiles = new Set<string>();
    let verifyRepairAttempts = 0;
    let verifyGaveUp = false;
    // LLM-critic rounds spent this run (semantic review after mechanical verify).
    let criticRounds = 0;

    // Auto-compaction cooldown: the iteration index until which we skip the
    // compaction check. Set after a successful compaction so we don't re-summarize
    // for a few iterations (the summary itself is large; let real work accumulate
    // before considering another pass). 0 = check every iteration.
    let compactCooldownUntil = 0;

    // Previous turn's dispatched prompt — used to measure how much of the prompt the
    // inference server can serve from its KV cache (longest byte-stable prefix). A drop
    // here is the canary for an accidental prefix-busting change (reordered tools,
    // mutated system block) that would tank local throughput.
    let prevDispatched: Message[] | null = null;

    // `newMessages` accumulates this run's turns. It's `let` (not `const`)
    // because auto-compaction may replace it wholesale with a summarized version.
    let newMessages: Message[] = [];

    // Output-guardrail self-correction is one-shot: once we've fed a format
    // correction back, we don't do it again, so a non-compliant model can't trap
    // the loop in a correction cycle.
    let formatCorrectionUsed = false;

    // Update snapshot service's session id now that we have it (constructor used a placeholder)
    this.setSessionForSnapshot(sessionId);

    // ─── Hooks: SessionStart (once per run) ────────────────────────────────────
    const hooks = getHooksManager();
    if (hooks?.hasAny('SessionStart')) {
      try {
        const r = await hooks.dispatch('SessionStart', { event: 'SessionStart', sessionId, cwd: this.cwd });
        for (const out of r.outputs) {
          logger.info(`SessionStart hook output: ${out.slice(0, 200)}`);
        }
      } catch (e: any) {
        logger.warn('SessionStart hook dispatch failed', { err: e.message });
      }
    }

    // ─── Just-in-time skill injection ──────────────────────────────────────────
    // The roster of skills is always advertised in the system prompt, but a weaker
    // model often won't call use_skill on its own. So at turn start we match the
    // user's request against installed skills and, if ONE is a confident, dominant
    // match, auto-load its playbook into context now — the right knowledge in front
    // of the model at the right moment, without depending on the model to fetch it.
    // Conservative by design (see suggestSkillForPrompt); off via skills.autoInject:false.
    if (
      mode.mode === 'normal' &&
      (this.config as any).skills?.autoInject !== false
    ) {
      const lastUser = [...messages].reverse().find(m => m.role === 'user');
      const userText = typeof lastUser?.content === 'string' ? lastUser.content : '';
      if (userText && !isTrivialMessage(userText)) {
        const minScore = (this.config as any).skills?.autoInjectMinScore;
        const pick = suggestSkillForPrompt(userText, typeof minScore === 'number' ? { minScore } : {});
        let injected = false;
        if (pick && !this.autoInjectedSkills.has(pick)) {
          const spec = getSkill(pick);
          if (spec?.body) {
            this.autoInjectedSkills.add(pick);
            newMessages.push({
              role: 'user',
              content:
                `[AUTO-LOADED SKILL: ${pick} — this playbook was matched to the current task and ` +
                `loaded for you. Follow it where it applies; you don't need to call use_skill for it.]\n\n` +
                spec.body,
            });
            yield { type: 'notice', data: { message: `✦ Loaded skill: ${pick} (auto-matched to this task)` } };
            injected = true;
          }
        }
        // Nothing installed matched — but a curated skill might fit and just isn't
        // installed yet. Surface it to the USER (never auto-install). This is the
        // gap behind "no skill, so the model fabricated": now QodeX names the
        // available playbook and the install command, and the user decides.
        if (!injected && (this.config as any).skills?.suggestUninstalled !== false) {
          const installedNames = listSkills().map(s => s.name);
          const avail = suggestUninstalledSkill(userText, installedNames);
          if (avail) {
            yield {
              type: 'notice',
              data: {
                message:
                  `💡 No matching skill is installed, but "${avail.names[0]}" fits this task — ` +
                  `${avail.description}. Install it with:  qodex skill install ${avail.source}`,
              },
            };
          }
        }
      }
    }

    // ─── Verify baseline (PVS-Studio "only flag new code" idea) ────────────────
    // Before the model edits anything, snapshot the project's EXISTING checker
    // errors. The auto-verify gate then subtracts these, so the model is held to
    // "don't make it worse" instead of being forced to fix pre-existing debt it
    // didn't cause. Build tasks only (one extra checker run up front); off via
    // Pre-commit syntax gate (default ON): broken-syntax edits are refused before
    // they reach the disk. Off-switch: discipline.syntaxGate: false or QODEX_SYNTAX_GATE=0.
    setSyntaxGateEnabled(
      (this.config as any).discipline?.syntaxGate !== false &&
      process.env.QODEX_SYNTAX_GATE !== '0',
    );

    // discipline.verifyBaseline:false or QODEX_VERIFY=0.
    let verifyBaseline: Diagnostic[] | undefined;
    if (
      mode.mode === 'normal' &&
      this.planGateComplex &&
      (this.config as any).discipline?.verifyBaseline !== false &&
      process.env.QODEX_VERIFY !== '0'
    ) {
      try {
        const base = await captureBaseline({ cwd: this.cwd, signal: options.signal });
        if (base.length > 0) {
          verifyBaseline = base;
          logger.info('Verify baseline captured', { preExistingErrors: base.length });
        }
      } catch { /* best-effort — never block the task on baseline capture */ }
    }

    // Token-budget accounting is NOVEL-tokens-only. An agentic turn makes one API call per
    // tool round, and every call re-sends the whole conversation — so counting each call's
    // full input against the budget grows QUADRATICALLY with tool rounds (live: a 21k-context
    // task on a local model "spent" 216k/200k within two minutes and died). The high-water
    // mark counts every context token ONCE: consume = output + max(0, seenNow - seenBefore).
    // Dollar cost stays full-usage per call below — bills are bills; the token budget is a
    // runaway guard, not an invoice.
    let promptHighWater = 0;

    while (true) {
      try {
        budget.incrementIteration();
        budget.checkpoint();
      } catch (e: any) {
        let msg = e.message;
        if (e.budgetType === 'iterations') {
          msg += '\nTo continue without an iteration cap, type /unlimited (this session) ' +
            'or set `defaults.maxIterations: 0` in ~/.qodex/config.yaml. ' +
            'You can also raise it with /iterations <n>.';
        }
        yield { type: 'error', data: { message: msg, budgetType: e.budgetType } };
        return;
      }

      // Warn once at ~80% of the iteration cap so a long task doesn't just stop dead.
      if (budget.shouldWarnIterations()) {
        const u = budget.getUsage();
        yield {
          type: 'notice',
          data: {
            message:
              `⚠ Approaching the iteration limit (${u.iterations}/${budget.getMaxIterations()}). ` +
              `If this task is large, type /unlimited to remove the cap for this session ` +
              `(or /iterations <n> to raise it), then continue.`,
          },
        };
      }

      // Track turn for snapshot retention; prune expired snapshots once per turn.
      this.currentTurn = budget.getUsage().iterations;

      // ── Mid-task steering: drain any `/btw …` notes the user queued while we were
      // working, and inject them as framed user messages so the model weighs them on
      // its NEXT reasoning step. Done at the iteration boundary (never mid tool-call)
      // so in-flight work isn't corrupted; the task is NOT stopped.
      if (this.steerQueue.length > 0) {
        const notes = this.steerQueue.splice(0, this.steerQueue.length);
        this.forceThinkNext = true; // adaptive thinking: re-orient with a THINK pass
        for (const note of notes) {
          newMessages.push({ role: 'user', content: buildSteerMessage(note) });
          yield { type: 'steer_injected', data: { note } };
        }
      }
      this.turnSnapshotTaken = false; // reset — each iteration gets at most one auto-snapshot
      // Initialize / reset within-turn tool cache
      if (!this.toolCache) {
        const { ToolResultCache } = await import('../utils/tool-cache.js');
        this.toolCache = new ToolResultCache();
      } else {
        this.toolCache.reset();
      }
      if (this.snapshotService) {
        try { this.snapshotService.prune(this.currentTurn); } catch (e: any) {
          logger.warn('Snapshot prune failed', { err: e.message });
        }
      }

      if (options.signal?.aborted) {
        yield { type: 'error', data: { message: 'Cancelled by user' } };
        return;
      }

      yield { type: 'iteration_start', data: { iteration: budget.getUsage().iterations } };

      // ── Read-cache ──
      // Collapse redundant file reads before the compaction check, so repeated
      // reads of the same file stop inflating context (and the cheaper, lossless
      // collapse runs before the heavier summarizer even has to fire). It only
      // shrinks the `content` of existing read tool-results and preserves array
      // length, so a tool_call is never severed from its tool_result. Lossless
      // superseded-collapse is always on; outline-aging is default ON (v1.84+),
      // opt-out via config.context.readCacheAging:false.
      {
        const readCacheAging = (this.config as any)?.context?.readCacheAging !== false;
        const split = messages.length;
        const merged = compactFileReads(messages.concat(newMessages), { agingOutline: readCacheAging });
        messages = merged.slice(0, split);
        newMessages = merged.slice(split);
      }

      // ── Auto-compaction ──
      // Fire when the combined context exceeds a fraction of the model window,
      // BEFORE routing so the routing token estimate sees the compacted size.
      // A cooldown after each compaction prevents back-to-back summarization.
      // compactMessages preserves the most recent turns verbatim and never
      // splits a tool_call from its tool_result.
      const iterNow = budget.getUsage().iterations;
      if (this.autoCompactEnabled && iterNow >= compactCooldownUntil) {
        const combined = messages.concat(newMessages);
        const { shouldCompact } = await import('../utils/compaction.js');
        // Use the ROUTED MODEL's real context window, not a fixed 32k guess.
        // A model with a 256k window was being compacted as if it had 32k,
        // throwing away working memory the model could still hold. We resolve
        // the model's actual window and only fall back to the configured /
        // default value when the router can't tell us.
        let modelCtxWindow: number | undefined;
        try {
          const probe = this.router.route(
            (mode.mode === 'plan' ? 'planning' : 'subagent') as any,
            this.estimateTokens(combined),
            {},
          );
          if (probe?.modelInfo?.contextWindow && probe.modelInfo.contextWindow > 0) {
            modelCtxWindow = probe.modelInfo.contextWindow;
          }
        } catch { /* router probe failed — fall back below */ }
        const ctxWindow = (options as any).explicitContextWindow
          ?? (this.contextWindowExplicit ? this.defaultContextWindow : undefined)
          ?? modelCtxWindow
          ?? this.defaultContextWindow
          ?? 32_768;
        if (shouldCompact(combined, ctxWindow, this.autoCompactThreshold)) {
          yield { type: 'progress', data: { message: '🗜  Context over threshold — summarizing older turns…' } } as any;
          const compacted = await this.runCompaction(combined, ctxWindow, options.signal);
          if (compacted) {
            // Replace the whole working set with the compacted list; the summary
            // becomes part of the base, and this run's accumulator resets.
            messages = compacted;
            newMessages = [];
            compactCooldownUntil = iterNow + 3; // skip the next few iterations
            prevDispatched = null; // prefix changed → cache canary reset
            yield { type: 'progress', data: { message: '🗜  Compaction done — recent turns preserved.' } } as any;
          } else {
            // Summarization no-op'd or failed; don't retry immediately.
            compactCooldownUntil = iterNow + 2;
          }
        }
      }

      // Classify task to pick a model
      const taskClass = this.classifyTask(messages, newMessages);
      const allMessagesRaw = messages.concat(newMessages);
      // Sub-agent invocations pin their resolved model via options.modelOverride.
      // This takes precedence over options.explicitModel (which is the parent's /model slash command).
      const pinnedModel = (options as any).modelOverride?.model ?? options.explicitModel;
      const route = this.router.route(
        taskClass,
        this.estimateTokens(allMessagesRaw),
        { explicitModel: pinnedModel },
      );

      logger.info('Routing decision', {
        taskClass,
        model: route.model,
        provider: route.provider.name,
        pinned: pinnedModel ? 'yes' : 'no',
      });

      // Text-tool mode: this model rejects the native `tools` field (e.g. glm4 → Ollama
      // HTTP 400 "does not support tools"). Instead of leaving it dead-weight, we DON'T
      // send `tools`, and inject a system block teaching it to emit tool calls as text.
      // The existing recoverToolCallsFromText layer parses those back into real calls — so
      // every tool-incapable model becomes a working agent over the text channel.
      const wasForceTextOnly = forceTextOnly;
      const textToolMode = !wasForceTextOnly && needsTextToolMode(route.modelInfo.supportsToolCalls);

      // Build tools for this mode. When we're forcing the model to stop and summarize
      // (stuck read loop), send no tools so it must reply in plain text. One-shot.
      // In text-tool mode we also send no native tools (they'd 400) — the protocol block
      // carries the tool list instead.
      const schemasForModeAll = this.registry.getSchemas(mode);
      // Relevance gating: ship CORE tools + only the specialist families this task
      // signals. Cuts the per-request tool tax (≈65 schemas → ~20 for a greeting)
      // without losing capability — registry.execute() can still run any tool the
      // model names, gating only affects what it SEES. Off-switch: discipline.toolGating: false.
      let schemasForMode = schemasForModeAll;
      if ((this.config as any).discipline?.toolGating !== false && mode.mode !== 'plan') {
        const signal = allMessagesRaw
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .slice(-6)
          .map(m => (typeof m.content === 'string' ? m.content : ''))
          .join('\n');
        const gated = filterSchemasByRelevance(schemasForModeAll, signal);
        // Accumulate into a session-monotonic union so the tools block only ever GROWS.
        // A per-turn set would drop families as the signal window slides, flipping the
        // tool block and invalidating the (cloud) prompt cache / (local) KV-cache prefix.
        for (const s of gated.schemas) this.sessionToolNames.add(s.function.name);
        schemasForMode = schemasForModeAll.filter(s => this.sessionToolNames.has(s.function.name));
        if (schemasForMode.length < schemasForModeAll.length) {
          logger.info('Tool gating active', {
            before: schemasForModeAll.length, after: schemasForMode.length, matchedFamilies: gated.matchedFamilies,
          });
        }
      }
      const tools = (wasForceTextOnly || textToolMode) ? [] : schemasForMode;
      forceTextOnly = false;

      // Critical debug log — when an OpenAI/DeepSeek model is "not making tool calls",
      // 95% of the time the tools array got filtered out unexpectedly OR the model is
      // a non-tool-capable model. Surfacing this in the log lets us diagnose in 5 seconds.
      logger.info(`Dispatching to ${route.provider.name}/${route.model}`, {
        toolCount: tools.length,
        textToolMode,
        toolNames: tools.slice(0, 5).map(t => t.function.name),
        messageCount: allMessagesRaw.length,
      });
      // Only warn about a truly toolless dispatch — text-tool mode and the deliberate
      // force-summarize turn both send zero native tools on purpose.
      if (tools.length === 0 && !textToolMode && !wasForceTextOnly) {
        logger.warn('No tools available to the model for this turn — write_file, edit_text, bash, etc. will not be reachable. Check mode/allowedTools settings.');
      }

      // Aging layer FIRST — it truncates the MIDDLE of large, OLD (≥minAgeTurns) tool results
      // (a safe, unambiguous shrink), so we PERSIST it back into the working set. Previously the
      // shrink was ephemeral: thrown away and re-derived from an ever-growing FULL-size history
      // every turn — a confirmed O(turns) token multiplier. Aging preserves array length, so a
      // slice re-split realigns messages/newMessages. Originals stay in the session store for
      // /undo; the model-facing copy shrinks permanently. (Mirrors compactFileReads' persist
      // above; idempotent — an already-aged stub is < maxChars so it never re-ages.)
      let workingRaw = allMessagesRaw;
      if ((this.config as any)?.context?.resultAging !== false) {
        const agingCfg = (this.config as any)?.context ?? {};
        const effDefaults = efficiencyDefaults(agingCfg.efficient === true);
        const ar = ageToolResults(allMessagesRaw, {
          minAgeTurns: resolveSetting(agingCfg.resultAgingMinTurns, effDefaults.agingMinTurns),
          maxChars: resolveSetting(agingCfg.resultAgingMaxChars, effDefaults.agingMaxChars),
        });
        if (ar.aged > 0) {
          logger.info(`Aged ${ar.aged} large old tool result(s)`, { bytesSaved: ar.bytesSaved });
          workingRaw = ar.messages;
          if (workingRaw.length === allMessagesRaw.length) {   // aging preserves length → safe re-split
            const split = messages.length;
            messages = workingRaw.slice(0, split);
            newMessages = workingRaw.slice(split);
          }
        }
      }

      // Dedup layer — replaces duplicate tool results with back-pointers. Kept EPHEMERAL (not
      // persisted): its pointers reference OTHER messages, so a permanent rewrite could dangle
      // after later prune/compaction. Runs on the aged copy for the outbound payload only.
      const { messages: dedupedRaw, replaced: dedupReplaced, bytesSaved: dedupBytes } = dedupHistory(workingRaw);
      if (dedupReplaced > 0) {
        logger.info(`Dedup compacted ${dedupReplaced} tool result(s)`, { bytesSaved: dedupBytes });
      }
      const agedRaw = dedupedRaw;

      // Prune context to fit the chosen model's window. Reserve 20% for output + tools schema.
      // ── Live context sync ── the config's contextWindow goes stale the moment the
      // user reloads the model at a different length in LM Studio (the 32k-clamp OOM
      // class of bugs). Once per session we read the GROUND TRUTH from LM Studio's
      // native API (loaded_context_length) and prefer it over config when it matches
      // the routed model. Timeout-guarded; failure = silently keep config. Off via
      // `context.liveSync: false`.
      if (!this.liveCtxFetched && (this.config as any)?.context?.liveSync !== false) {
        this.liveCtxFetched = true;
        try {
          this.liveCtxWindows = await detectLmStudioContextWindows();
        } catch { this.liveCtxWindows = null; }
      }
      let effectiveCtxWindow = route.modelInfo.contextWindow;
      // Where the model is actually served from, for the status bar. Provider name is the
      // base truth (ollama/anthropic/openai/custom name); a hit in LM Studio's native model
      // registry upgrades it to 'lmstudio' — the OpenAI-compat facade otherwise hides that.
      let modelSource = route.provider.name;
      if (this.liveCtxWindows) {
        const id = route.model;
        const live = this.liveCtxWindows[id]
          ?? this.liveCtxWindows[Object.keys(this.liveCtxWindows).find(k => k.includes(id) || id.includes(k)) ?? ''];
        if (typeof live === 'number' && live > 0) {
          modelSource = 'lmstudio';
          if (live !== effectiveCtxWindow) {
            logger.info('Context window synced from LM Studio', { model: id, config: effectiveCtxWindow, live });
            effectiveCtxWindow = live;
          }
        }
      }
      this.lastModelSource = modelSource;
      this.lastEffectiveCtxWindow = effectiveCtxWindow;
      const contextBudget = Math.floor(effectiveCtxWindow * 0.75);
      const estTokens = this.estimateTokens(agedRaw);
      // ─── Hooks: PreCompact ───────────────────────────────────────────────────
      // Fired right before we drop oldest turn groups. Lets users back up the conversation,
      // ship a snapshot to remote storage, etc.
      if (estTokens > contextBudget && hooks?.hasAny('PreCompact')) {
        try {
          await hooks.dispatch('PreCompact', { event: 'PreCompact', sessionId, cwd: this.cwd });
        } catch (e: any) {
          logger.warn('PreCompact hook dispatch failed', { err: e.message });
        }
      }
      let allMessages = this.pruneMessages(agedRaw, contextBudget);

      // Text-tool mode: inject the protocol + tool-list block as a separate system message
      // (after pruning, so it's never dropped, and after the main system prefix so caches
      // stay stable). Built from the same schemas the native path would have sent.
      if (textToolMode) {
        const block = buildTextToolInstructions(schemasForMode);
        allMessages = withTextToolProtocol(allMessages, block);
      }

      // KV-cache reuse telemetry. On local backends the leading byte-stable prefix is
      // served from cache (no re-prefill); we log how much carried over from last turn.
      if (route.provider.isLocal && prevDispatched) {
        const reuse = describeCacheReuse(prevDispatched, allMessages);
        logger.info('KV-cache prefix reuse', {
          reusedMessages: reuse.reusedMessages,
          totalMessages: reuse.totalMessages,
          reusePct: Math.round(reuse.reuseRatio * 100),
          changedAt: reuse.changedAt,
        });
      }
      prevDispatched = allMessages;

      // ── Adaptive thinking (Qwen3-family) ── decide whether THIS step earns a
      // reasoning pass. /no_think is appended only to the OUTBOUND copy, only at
      // the tail (pure append — prefix cache stays stable); history stays clean.
      // Off via reasoning.adaptive:false. See src/agent/thinking-control.ts.
      let outboundMessages = allMessages;
      if ((this.config as any)?.reasoning?.adaptive !== false && modelSupportsSoftSwitch(route.model)) {
        const decision = decideThinking({
          iteration: this.currentTurn,
          taskComplex: this.planGateComplex,
          recentToolErrors: countTrailingToolErrors(allMessages),
          forceThink: this.forceThinkNext,
          rethinkEvery: (this.config as any)?.reasoning?.rethinkEvery,
        });
        this.forceThinkNext = false;
        outboundMessages = applyThinkingDecision(allMessages, decision, route.model);
        if (decision === 'no_think') {
          logger.info('Adaptive thinking: routine step — /no_think', { iteration: this.currentTurn });
        }
      }

      // Force a tool call only when recovering from a refusal AND native tools are in play
      // (text-tool mode carries no `tools`, so 'required' would be meaningless there).
      const forceCall = forceToolChoice && tools.length > 0;
      forceToolChoice = false;
      const stream = route.provider.complete({
        model: route.model,
        messages: outboundMessages,
        tools,
        signal: options.signal,
        ...(forceCall ? { toolChoice: 'required' as const } : {}),
        ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
      });

      yield { type: 'thinking_start', data: { model: route.model } };

      const toolCalls: ToolCall[] = [];
      const toolCallBuffers = new Map<number, { id?: string; name?: string; args: string }>();
      let assistantText = '';
      let lastUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
      let streamError: string | null = null;

      // Turn timing. TTFT (time-to-first-token) is what the user FEELS as "how long
      // before it answers" — on a local backend it's dominated by prompt prefill, so
      // pairing it with the prompt-token estimate tells prefill-bound apart from a
      // slow link or a huge generation. Logged once per turn at info level.
      const dispatchStart = Date.now();
      let firstTokenAt = 0;

      for await (const event of stream) {
        if (options.signal?.aborted) {
          streamError = 'Cancelled by user';
          break;
        }
        if (!firstTokenAt && (event.type === 'text_delta' || event.type === 'tool_call_delta')) {
          firstTokenAt = Date.now();
        }

        switch (event.type) {
          case 'text_delta':
            assistantText += event.delta ?? '';
            yield { type: 'text_delta', data: { delta: event.delta } };
            break;

          case 'tool_call_delta': {
            const idx = event.toolCallIndex ?? 0;
            let buf = toolCallBuffers.get(idx);
            if (!buf) {
              buf = { args: '' };
              toolCallBuffers.set(idx, buf);
            }
            if (event.toolCallId) buf.id = event.toolCallId;
            if (event.toolName) buf.name = event.toolName;
            if (event.toolArgsDelta) buf.args += event.toolArgsDelta;

            if (event.toolName) {
              yield {
                type: 'tool_call_start',
                data: { index: idx, id: buf.id, name: event.toolName },
              };
            }
            if (event.toolArgsDelta) {
              yield {
                type: 'tool_call_args_delta',
                data: { index: idx, delta: event.toolArgsDelta },
              };
            }
            break;
          }

          case 'usage':
            lastUsage = {
              input: event.usage!.input,
              output: event.usage!.output,
              cacheRead: event.usage!.cacheRead ?? 0,
              cacheCreation: event.usage!.cacheCreation ?? 0,
            };
            break;

          case 'error':
            streamError = event.error ?? 'Unknown stream error';
            break;
        }
      }

      yield { type: 'thinking_done' };

      // Per-turn latency telemetry. ttftMs is the user-perceived "time to answer";
      // on local backends compare it to promptTokensEst to see prefill throughput
      // (tokens / ttft). prefillTokPerSec near the model's known prompt-eval rate ⇒
      // prefill-bound (reduce prompt / raise LM Studio n_batch + flash attention);
      // far below ⇒ a cold load or cache miss instead.
      {
        const ttftMs = firstTokenAt ? firstTokenAt - dispatchStart : 0;
        const totalMs = Date.now() - dispatchStart;
        logger.info('LLM turn timing', {
          model: route.model,
          provider: route.provider.name,
          local: route.provider.isLocal,
          promptTokensEst: estTokens,
          outputTokens: lastUsage.output || undefined,
          ttftMs,
          totalMs,
          prefillTokPerSec: ttftMs > 0 ? Math.round(estTokens / (ttftMs / 1000)) : undefined,
          genTokPerSec: lastUsage.output && firstTokenAt && Date.now() > firstTokenAt
            ? Math.round(lastUsage.output / ((Date.now() - firstTokenAt) / 1000))
            : undefined,
        });
      }

      // Stream errored
      if (streamError) {
        yield { type: 'error', data: { message: explainStreamError(streamError) } };
        return;
      }

      // Track budget — novel tokens only (see promptHighWater above): the re-sent
      // conversation prefix is counted the FIRST time it enters the context, not on
      // every subsequent tool round. Works for every provider, including local ones
      // that report no cache fields at all.
      const cost = computeCost(lastUsage, route.modelInfo);
      const cacheRead = (lastUsage as any).cacheRead ?? 0;
      const totalInputSeen = lastUsage.input + cacheRead;
      const freshInput = Math.max(0, totalInputSeen - promptHighWater);
      promptHighWater = Math.max(promptHighWater, totalInputSeen);
      budget.consume({ tokens: freshInput + lastUsage.output, costUsd: cost });
      // Cache hit-rate: cached reads ÷ total input the model saw (fresh + cached). Lets the
      // status line PROVE the hierarchical cache is working (and how much it's saving).
      const cacheHitRate = totalInputSeen > 0 ? cacheRead / totalInputSeen : 0;
      yield {
        type: 'budget_update',
        data: {
          ...budget.getUsage(),
          lastInputTokens: lastUsage.input, lastOutputTokens: lastUsage.output, lastCostUsd: cost,
          lastCacheRead: cacheRead, lastCacheCreation: (lastUsage as any).cacheCreation ?? 0, cacheHitRate,
          // The LIVE-synced window (LM Studio native API when available), not the static
          // table value — plus where the model is actually served from and whether it bills.
          contextWindow: this.lastEffectiveCtxWindow || route.modelInfo.contextWindow,
          providerName: this.lastModelSource || route.provider.name,
          providerIsLocal: (route.provider as any).isLocal === true || this.lastModelSource === 'lmstudio',
        },
      };

      // Build the toolCalls array from buffers
      for (const [, buf] of [...toolCallBuffers.entries()].sort((a, b) => a[0] - b[0])) {
        if (buf.name) {
          toolCalls.push({
            id: buf.id ?? `call_${toolCalls.length}`,
            type: 'function',
            function: { name: buf.name, arguments: buf.args },
          });
        }
      }

      // RECOVERY: some small local models emit tool calls as JSON in text instead of using
      // the tool_calls field. If we got zero structured calls but the text looks like it
      // contains one, try to extract it. This is conservative — only matches known tool names.
      if (toolCalls.length === 0 && assistantText) {
        const knownNames = new Set(this.registry.list().map(t => t.name));
        const recovered = recoverToolCallsFromText(assistantText, knownNames);
        if (recovered.calls.length > 0) {
          logger.info('Recovered tool calls from text', {
            count: recovered.calls.length,
            names: recovered.calls.map(c => c.function.name),
            model: route.model,
          });
          toolCalls.push(...recovered.calls);
          // Replace the displayed text with the cleaned version (sans the raw JSON blobs)
          assistantText = recovered.cleanedText;
        } else {
          // Defense in depth: if recovery FAILED but the text still looks like a leaked
          // tool-call JSON (e.g. malformed JSON we couldn't parse), strip it anyway. Better
          // to lose the malformed text than to corrupt history and HTTP 400 the next turn.
          const stripped = stripStandaloneJsonObjects(assistantText);
          if (stripped !== assistantText) {
            logger.warn('Stripped unparseable JSON-shaped content from assistant text', {
              originalLen: assistantText.length,
              strippedLen: stripped.length,
              model: route.model,
            });
            assistantText = stripped;
          }
        }
      }

      // CRITICAL: when tool_calls are present, content MUST NOT contain JSON that
      // resembles a tool call. Some local providers (notably Ollama) will try to
      // re-parse historical `content` as structured data and HTTP 400 on broken JSON.
      // We strip any leading/trailing standalone JSON object from the assistant text,
      // and if what remains is only whitespace, set content to null.
      let safeContent: string | null = assistantText || null;
      if (toolCalls.length > 0 && safeContent) {
        safeContent = stripStandaloneJsonObjects(safeContent);
        if (!safeContent.trim()) safeContent = null;
      }

      // ─── Extract <thinking> blocks (Qwen3/reasoning models) ───
      // Strip them from the message that goes into history (they bloat context
      // and seed mistakes), but emit them as UI events so the user can see
      // the model's reasoning if they want.
      if (safeContent) {
        const { extractThinking } = await import('../llm/thinking.js');
        const ex = extractThinking(safeContent);
        if (ex.thinkingBlocks.length > 0) {
          for (const block of ex.thinkingBlocks) {
            yield { type: 'thinking', data: { content: block } } as any;
          }
          safeContent = ex.visibleText || null;
        }
      }

      // Record assistant message
      const assistantMsg: Message = {
        role: 'assistant',
        content: safeContent,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      };
      newMessages.push(assistantMsg);

      // Persist this turn
      sessionStore.recordTurn(
        sessionId,
        [assistantMsg],
        { input: lastUsage.input, output: lastUsage.output, costUsd: cost },
      );

      // No tool calls → done
      if (toolCalls.length === 0) {
        // ── Output Guardrail (one-shot self-correction) ──
        // Before treating a tool-less turn as final, check it isn't structurally
        // broken (unclosed <thinking>/<tool_call>, malformed tool JSON, dangling
        // code fence, empty). If it is, feed ONE hidden corrective turn back and
        // retry — local models often recover with an explicit, specific nudge.
        if (!formatCorrectionUsed) {
          const verdict = inspectOutput(assistantText, false);
          if (!verdict.ok) {
            formatCorrectionUsed = true;
            logger.warn('Output guardrail caught a format defect — injecting one corrective turn', {
              defect: verdict.defect,
              model: route.model,
            });
            yield { type: 'thinking', data: { content: `(format correction: ${verdict.defect})` } } as any;
            newMessages.push({ role: 'user', content: buildCorrectionMessage(verdict) });
            continue; // one-shot retry
          }
        }

        // Refusal-language detection. If the model is making file-creation requests
        // but says "I can't create files / copy this into ..." it forgot to use tools.
        // Inject one corrective turn so it retries with the proper tool.
        const lower = assistantText.toLowerCase();
        const refusalPhrases = [
          "can't create files", "cannot create files", "can not create files",
          "don't have access to", "do not have access to", "don't have the ability",
          "i am a language model", "i'm a language model",
          'نمی‌توانم فایل', 'نمیتوانم فایل', 'نمیتونم فایل بسازم', 'دسترسی مستقیم',
          'لطفاً کد را کپی', 'لطفا کد را کپی', 'کپی کنید',
          'please copy', 'copy this code into', 'save this to a file',
        ];
        const looksLikeRefusal = refusalPhrases.some(p => lower.includes(p));
        const userAskedForFileWork = (() => {
          const recentUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content?.toLowerCase() ?? '';
          return /\b(create|write|save|make|generate|bsaz|بساز|بنویس|ذخیره|فایل|file)\b/.test(recentUserMsg);
        })();
        if (looksLikeRefusal && userAskedForFileWork && tools.length > 0) {
          logger.warn('Model refused file work despite having tools — injecting corrective system turn', {
            model: route.model,
            text: assistantText.slice(0, 200),
          });
          newMessages.push({
            role: 'user',
            content:
              '[SYSTEM CORRECTION] You just told the user you cannot create/modify files. ' +
              'That is FALSE. You have the `write_file`, `edit_text`, `multi_edit`, and `bash` tools available RIGHT NOW. ' +
              'Re-read the user\'s previous request and actually DO the work by calling `write_file`. ' +
              'Do not apologize, do not narrate this correction — just call the tool now. ' +
              'After it runs, summarize what you created in 1-2 sentences.',
          });
          forceToolChoice = true; // next attempt: make the server emit a tool call, not more prose
          continue; // loop back and try again with the corrective message
        }

        // ── Auto-verify gate ──
        // The model thinks it's done. Before we let it finish a coding task, type-check the
        // files it touched. If they don't compile, feed the errors back and force a repair
        // round — capped so an un-fixable error can't loop forever. This is the harness-level
        // quality floor that lifts ANY connected model: no model gets to ship broken code.
        const verifyCfg = (this.config as any).verify ?? {};
        // QODEX_VERIFY=0 forces the gate off regardless of config — used by the eval
        // harness's A/B to measure the gate's contribution. Config is the normal switch.
        const verifyOffEnv = process.env.QODEX_VERIFY === '0';
        const verifyEnabled = !verifyOffEnv && verifyCfg.auto !== false && mode.mode === 'normal';
        const maxRepair = verifyCfg.maxRepairAttempts ?? 2;
        if (verifyEnabled && touchedSourceFiles.size > 0 && !options.signal?.aborted) {
          try {
            const vr = await verifyTouchedFiles({
              cwd: this.cwd,
              touched: [...touchedSourceFiles],
              signal: options.signal,
              timeoutMs: verifyCfg.timeoutMs,
              baseline: verifyBaseline,
            });
            // Record what QodeX actually verified (ground truth for the trust receipt).
            if (vr.ran && vr.checker) this.verifyLedger.push({ command: vr.checker, passed: vr.errorCount === 0 });
            if (vr.ran && vr.errorCount > 0) {
              if (verifyRepairAttempts < maxRepair) {
                verifyRepairAttempts++;
                const repairMsg: Message = {
                  role: 'user',
                  content: buildVerifyRepairMessage(vr.diagnostics, vr.checker ?? 'type-check', verifyRepairAttempts, maxRepair, this.cwd), // (adaptive thinking flag set below)
                };
                newMessages.push(repairMsg);
                this.forceThinkNext = true; // adaptive thinking: diagnose the failures with a THINK pass
                sessionStore.recordTurn(sessionId, [repairMsg], { input: 0, output: 0, costUsd: 0 });
                yield { type: 'notice', data: { message: `⚠ Auto-verify: ${vr.errorCount} ${vr.checker} error(s) in changed files — repairing (${verifyRepairAttempts}/${maxRepair})` } };
                logger.info('Auto-verify gate forcing repair', { checker: vr.checker, errors: vr.errorCount, attempt: verifyRepairAttempts });
                continue; // force the model to fix before it's allowed to finish
              } else if (!verifyGaveUp) {
                // Exhausted repair budget — surface remaining errors once, then let it finish.
                verifyGaveUp = true;
                const giveup: Message = { role: 'user', content: buildVerifyGiveupMessage(vr.errorCount, vr.checker ?? 'type-check') };
                newMessages.push(giveup);
                sessionStore.recordTurn(sessionId, [giveup], { input: 0, output: 0, costUsd: 0 });
                logger.warn('Auto-verify gate gave up', { checker: vr.checker, errors: vr.errorCount });
                continue;
              }
            } else if (vr.ran) {
              // Clean compile — reset so a later edit batch gets a fresh repair budget.
              verifyRepairAttempts = 0;
            }
          } catch (e: any) {
            // The pre-finish safety gate was skipped — a possibly-broken task can
            // now finish as "success". Make that visible, don't bury it in debug.
            logger.warn('Auto-verify gate skipped (error)', { err: e?.message });
            yield { type: 'notice', data: { message: `⚠ Auto-verify gate skipped due to an error (${e?.message ?? 'unknown'}) — changes were not type-checked` } };
          }
        }

        // ── LLM Critic gate (semantic self-review / test-time compute) ──
        // Mechanical verify only catches syntax/type errors. Before finishing a
        // coding task, run ONE peer-review pass: a Senior-QA prompt reviews the
        // touched files for logic bugs and convention/spec mismatches that a
        // type-checker can't see. A blocking verdict sends the worker back to
        // fix (backtracking). Budget-capped so a model that can't satisfy the
        // critic still finishes. Uses the 'planning' role's model if configured
        // (a stronger/cheaper reviewer), else self-reviews with the same model.
        const criticCfg = (this.config as any).critic ?? {};
        const criticEnabled = criticCfg.enabled === true   // opt-in: it costs an extra round-trip
          && mode.mode === 'normal'
          && process.env.QODEX_CRITIC !== '0';
        const maxCriticRounds = criticCfg.maxRounds ?? 1;
        if (criticEnabled && touchedSourceFiles.size > 0 && criticRounds < maxCriticRounds && !options.signal?.aborted) {
          try {
            const { readFile: fsReadFile } = await import('fs/promises');
            const pathMod = await import('path');
            const files: DiffFile[] = [];
            for (const rel of [...touchedSourceFiles].slice(0, criticCfg.maxFiles ?? 6)) {
              try {
                const content = await fsReadFile(pathMod.resolve(this.cwd, rel), 'utf-8');
                files.push({ path: rel, content });
              } catch { /* file may have been deleted; skip */ }
            }
            if (files.length > 0) {
              // Recover the user's task from the message history (this method
              // doesn't carry buildSystemPrompt's locals). Trellis spec is
              // lazily reloaded (its loader caches, so this is cheap).
              const criticUserPrompt = String(
                [...messages].reverse().find(m => m.role === 'user')?.content ?? '',
              );
              let criticSpecBlock: string | null = null;
              try {
                const tctx = await loadTrellisContext(this.cwd);
                criticSpecBlock = tctx?.specBlock ?? null;
              } catch { /* no trellis — fine */ }
              const { system, user } = buildCriticPrompt({
                task: criticUserPrompt,
                files,
                specBlock: criticSpecBlock,
              });
              // Route a reviewer model via the 'reflection' task class (peer review
              // with a possibly-different model catches blind spots); fall back to
              // the current route on any error (self-review).
              let reviewRoute = route;
              try {
                reviewRoute = this.router.route('reflection', 0, {});
              } catch { reviewRoute = route; }
              const criticStream = reviewRoute.provider.complete({
                model: reviewRoute.model,
                messages: [
                  { role: 'system', content: system },
                  { role: 'user', content: user },
                ],
                signal: options.signal,
              });
              let criticText = '';
              for await (const ev of criticStream) {
                if (ev.type === 'text_delta') criticText += ev.delta ?? '';
              }
              const verdict = parseCriticVerdict(criticText);
              if (!verdict.pass) {
                criticRounds++;
                const repairMsg: Message = { role: 'user', content: buildCriticRepairMessage(verdict) };
                newMessages.push(repairMsg);
                sessionStore.recordTurn(sessionId, [repairMsg], { input: 0, output: 0, costUsd: 0 });
                const blockerCount = verdict.findings.filter(f => f.severity === 'blocker').length;
                yield { type: 'notice', data: { message: `⚠ QA review: ${blockerCount} blocking issue(s) — sending back to fix (${criticRounds}/${maxCriticRounds})` } };
                logger.info('LLM critic blocked — forcing repair', { blockers: blockerCount, round: criticRounds });
                continue; // backtrack: let the worker fix the flagged defects
              }
              logger.debug('LLM critic passed', { warnings: verdict.findings.length });
            }
          } catch (e: any) {
            // The QA self-review gate was skipped — surface it so the task isn't
            // silently allowed to finish unreviewed.
            logger.warn('LLM critic skipped (error)', { err: e?.message });
            yield { type: 'notice', data: { message: `⚠ QA review gate skipped due to an error (${e?.message ?? 'unknown'}) — changes were not peer-reviewed` } };
          }
        }

        // ── Completion-claim gate (one-shot) ──
        // Before finalizing, check that the model's success claims ("I fixed it",
        // "tests pass") are backed by evidence this session (a real edit, a real test
        // run). Unsupported claims are bounced back ONCE so the model does the work or
        // retracts the claim — directly targets end-of-task fabrication. Soft + one-shot
        // (never locks). Off-switch: discipline.completionGate: false.
        if (!this.completionGateFired &&
            (this.config as any).discipline?.completionGate !== false) {
          const correction = evaluateCompletion(assistantText, messages.concat(newMessages));
          if (correction) {
            this.completionGateFired = true;
            const repairMsg: Message = { role: 'user', content: correction };
            newMessages.push(repairMsg);
            sessionStore.recordTurn(sessionId, [repairMsg], { input: 0, output: 0, costUsd: 0 });
            yield { type: 'notice', data: { message: '🔍 Completion check: a success claim wasn\u2019t backed by an action this session — sending back to verify' } };
            logger.info('Completion gate bounced an unsupported claim');
            continue; // backtrack: make the model prove or retract the claim
          }
        }

        // ── Visual gate (completion-time Layer 3) ──
        // If this session created/updated an artifact, render + review it before
        // finishing — the agent LOOKS at what it shipped. LOOKS_GOOD passes;
        // NEEDS_WORK/BROKEN is bounced back exactly ONCE with the concrete issues
        // (the model fixes via artifact_update, the next finish attempt reviews
        // again); still failing after that retry passes WITH a warning — bounded by
        // design. No vision backend / no browser degrades to an "unverified" note,
        // exactly like artifact_review itself. Off-switch: ui.visualGate: false.
        if (mode.mode === 'normal' && !options.signal?.aborted) {
          const reviewFn: VisualReviewFn = this.visualReviewFn
            ?? ((id) => this.reviewArtifactForVisualGate(id, sessionId, options));
          let vgDecision: VisualGateDecision;
          try {
            vgDecision = await runVisualGate({
              messages: messages.concat(newMessages),
              enabled: (this.config as any).ui?.visualGate !== false,
              retriedAlready: this.visualGateRetried,
              reviewFn,
            });
          } catch (e: any) {
            // runVisualGate already degrades internally; this is the never-block backstop.
            logger.warn('Visual gate skipped (error)', { err: e?.message });
            vgDecision = { action: 'skip' };
          }
          if (vgDecision.action === 'retry') {
            this.visualGateRetried = true;
            const repairMsg: Message = { role: 'user', content: vgDecision.correction! };
            newMessages.push(repairMsg);
            sessionStore.recordTurn(sessionId, [repairMsg], { input: 0, output: 0, costUsd: 0 });
            yield { type: 'notice', data: { message: `👁 Visual check: "${vgDecision.artifactId}" needs work — sending back to fix (1 retry)` } };
            logger.info('Visual gate bounced the artifact for one fix round', { artifact: vgDecision.artifactId });
            continue; // backtrack: let the model artifact_update, then re-review
          }
          if (vgDecision.action === 'pass' && vgDecision.verdictLine) {
            // Stamp the verdict on the final message the user reads.
            assistantText = assistantText ? `${assistantText}\n\n${vgDecision.verdictLine}` : vgDecision.verdictLine;
          }
        }

        yield { type: 'final', data: { content: assistantText, usage: budget.getUsage() } };
        return;
      }

      // ── Stuck-loop detection ──
      // Sliding window (detectStuckLoop) catches tight loops. The cumulative tally below
      // catches the "restart" loop: a sweep re-reading many files is longer than the window,
      // but a file re-read across several sweeps shows up in its run-wide count.
      let maxReadRepeat = 0;
      for (const tc of toolCalls) {
        const argsHash = crypto.createHash('md5').update(tc.function.arguments).digest('hex').slice(0, 8);
        const key = `${tc.function.name}|${argsHash}`;
        recentCalls.push({ name: tc.function.name, argsHash });
        if (recentCalls.length > 10) recentCalls.shift();
        const n = (callCounts.get(key) ?? 0) + 1;
        callCounts.set(key, n);
        if (this.registry.isReadOnly(tc.function.name) && n > maxReadRepeat) maxReadRepeat = n;
      }

      const readAction = readLoopAction(maxReadRepeat);

      // Hard cap: re-read the same file 5+ times and ignored the nudge — its context can't
      // hold the codebase, so it restarts forever. End cleanly with a message the user can
      // act on, instead of spinning until the iteration budget (or the model server) gives out.
      if (readAction === 'abort') {
        const ctx = route.modelInfo.contextWindow.toLocaleString();
        const msg =
          `I got stuck re-reading the same files. This codebase is larger than the model's context ` +
          `window (${ctx} tokens), so I keep losing my place and starting over. To finish this, either ` +
          `narrow the task (e.g. “find bugs in src/pages/CartPage.jsx”) or use a model with a larger ` +
          `context window (~/.qodex/config.yaml → providers.*.extraModels[].contextWindow).`;
        const m: Message = { role: 'assistant', content: msg };
        newMessages.push(m);
        sessionStore.recordTurn(sessionId, [m], { input: 0, output: 0, costUsd: 0 });
        logger.warn('Aborting run: read-loop hard cap hit', { maxReadRepeat, model: route.model });
        yield { type: 'final', data: { content: msg, usage: budget.getUsage() } };
        return;
      }

      // Re-read the same file 3+ times → the model restarted instead of continuing. Force it
      // to stop and report: disable tools next turn so it must summarize in plain text.
      if (readAction === 'summarize') {
        const stopMsg: Message = {
          role: 'user',
          content:
            `[SYSTEM] You have re-read the same file ${maxReadRepeat} times — a sign your context was ` +
            `compacted and you restarted instead of continuing. STOP calling tools. In your NEXT message, ` +
            `list the bugs/issues you have ALREADY found, in plain text. Tools are disabled for that message.`,
        };
        newMessages.push(stopMsg);
        sessionStore.recordTurn(sessionId, [stopMsg], { input: 0, output: 0, costUsd: 0 });
        forceTextOnly = true;
        recentCalls.length = 0;
        continue;
      }

      if (detectStuckLoop(recentCalls)) {
        // What were they stuck on? Inspect the repeated call to give targeted advice.
        const last = recentCalls[recentCalls.length - 1]!;
        let advice = '';
        if (last.name === 'read_file') {
          advice = ' You are re-reading files you already examined — a sign your context was compacted and you restarted the task instead of continuing it. Do NOT start over. Based on what you have ALREADY read, report your findings now (e.g. the bugs you found) in your reply. If you need more detail on ONE specific thing, use grep with a precise pattern rather than re-reading whole files.';
        } else if (last.name === 'edit_symbol') {
          advice = ' edit_symbol is failing repeatedly. Switch to edit_text or write_file for the same change. Don\'t retry edit_symbol on this file.';
        } else if (last.name === 'project_overview') {
          advice = ' project_overview failed. SKIP it for now and use ls + read_file on specific files instead.';
        } else {
          advice = ' Try a fundamentally different approach (different tool, different file, different angle).';
        }
        const stuckMsg: Message = {
          role: 'user',
          content: `[SYSTEM] You've called \`${last.name}\` with the same arguments 3+ times in a row. This isn't working.${advice} If you genuinely can't proceed, explain to the user IN ONE SENTENCE what's blocking you and stop. Do not apologize repeatedly. Do not loop.`,
        };
        newMessages.push(stuckMsg);
        sessionStore.recordTurn(sessionId, [stuckMsg], { input: 0, output: 0, costUsd: 0 });
        // CRITICAL: also clear recentCalls so the model gets one clean shot after the advice
        recentCalls.length = 0;
        continue;
      }

      // Error-guessing loop: same tool, same error kind, different args each time (e.g. reading
      // Header.tsx / App.tsx / Navbar.jsx — all FILE_NOT_FOUND — on a .jsx project). detectStuckLoop
      // misses this because the args differ. Nudge the model to STOP guessing and learn the real paths.
      // Scope guard: if the user never asked to run/install/test and the model is now starting a
      // dev server or installing packages on its own, nudge it once to finish the edits and ask
      // first. Advisory only (doesn't skip execution); the soft-failure loop detector is the real
      // circuit-breaker if the model ignores this and starts thrashing.
      if (!userAskedExecution && !scopeNudged) {
        const wandering = toolCalls.find(tc =>
          isExecutionAction(tc.function.name, tc.function.arguments ?? ''),
        );
        if (wandering) {
          scopeNudged = true;
          const smsg: Message = {
            role: 'user',
            content:
              '[SYSTEM] The user asked you to write/redesign code, not to run a dev server or install ' +
              'packages. Finish and save the file changes, then report what you changed in a short ' +
              'summary. Do NOT start dev servers, install dependencies, or debug the environment unless ' +
              'the user explicitly asks — those steps are out of scope and waste time.',
          };
          newMessages.push(smsg);
          sessionStore.recordTurn(sessionId, [smsg], { input: 0, output: 0, costUsd: 0 });
        }
      }

      const errLoop = detectErrorLoop(recentErrors);
      if (errLoop) {
        let advice = ' Change approach instead of repeating the same kind of call.';
        if (errLoop.code === 'FILE_NOT_FOUND') {
          advice =
            ' STOP guessing file paths. The "did you mean …" suggestions in the errors show the REAL ' +
            'names — this project likely uses different extensions than you assume (e.g. .jsx, not .tsx). ' +
            'Run `glob` or `ls` to get exact paths, then read those. Do not keep trying filename variations.';
        }
        const msg: Message = {
          role: 'user',
          content:
            `[SYSTEM] \`${errLoop.name}\` has returned ${errLoop.code} ${errLoop.count} times with different ` +
            `arguments.${advice} If you genuinely can't proceed, say so in ONE sentence and stop. Do not loop.`,
        };
        newMessages.push(msg);
        sessionStore.recordTurn(sessionId, [msg], { input: 0, output: 0, costUsd: 0 });
        recentErrors.length = 0;
        continue;
      }

      // Execute tools — read-only in parallel, mutating sequentially
      this.totalToolCalls += toolCalls.length; // task-complexity signal for skill capture
      const txn = await journal.begin(sessionId);
      const toolMessages: Message[] = [];

      const readOnlyCalls: ToolCall[] = [];
      const mutatingCalls: ToolCall[] = [];
      for (const tc of toolCalls) {
        if (this.registry.isReadOnly(tc.function.name)) readOnlyCalls.push(tc);
        else mutatingCalls.push(tc);
      }

      // Parallel read-only execution
      if (readOnlyCalls.length > 0) {
        const results = await Promise.all(
          readOnlyCalls.map(tc => this.executeToolCall(tc, txn, sessionId, options)),
        );
        budget.noteProgress();
        for (let i = 0; i < readOnlyCalls.length; i++) {
          const tc = readOnlyCalls[i]!;
          const r = results[i]!;
          yield { type: 'tool_result', data: { id: tc.id, name: tc.function.name, result: r.content, isError: r.isError, metadata: r.metadata } };
          if (r.isError) this.recordToolFailure(tc.function.name, r.content);
          noteResult(tc.function.name, r);
          // Emit any UI events captured during execution
          for (const ev of r.uiEvents) {
            yield { type: 'tool_ui', data: ev };
          }
          toolMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            name: tc.function.name,
            content: r.content,
          });
        }
      }

      // Mutating execution — opportunistically parallel when calls touch
      // disjoint file paths. Otherwise sequential to preserve consistency.
      const { groupMutatingForParallel } = await import('./parallel-mutating.js');
      const mutatingBatches = groupMutatingForParallel(mutatingCalls);
      for (const batch of mutatingBatches) {
        if (options.signal?.aborted) {
          await txn.rollback();
          yield { type: 'error', data: { message: 'Cancelled — pending changes rolled back' } };
          return;
        }
        if (batch.length === 1) {
          // Single → execute as before
          const tc = batch[0]!;
          const r = await this.executeToolCall(tc, txn, sessionId, options);
          budget.noteProgress();
          yield { type: 'tool_result', data: { id: tc.id, name: tc.function.name, result: r.content, isError: r.isError, metadata: r.metadata } };
          if (r.isError) this.recordToolFailure(tc.function.name, r.content);
          noteResult(tc.function.name, r);
          for (const ev of r.uiEvents) {
            yield { type: 'tool_ui', data: ev };
          }
          toolMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            name: tc.function.name,
            content: r.content,
          });
        } else {
          // Multiple disjoint-path mutations → parallel
          logger.info('Mutating tools running in parallel (disjoint paths)', { count: batch.length, tools: batch.map(b => b.function.name) });
          const results = await Promise.all(
            batch.map(tc => this.executeToolCall(tc, txn, sessionId, options)),
          );
          budget.noteProgress();
          for (let i = 0; i < batch.length; i++) {
            const tc = batch[i]!;
            const r = results[i]!;
            yield { type: 'tool_result', data: { id: tc.id, name: tc.function.name, result: r.content, isError: r.isError, metadata: r.metadata } };
          if (r.isError) this.recordToolFailure(tc.function.name, r.content);
            noteResult(tc.function.name, r);
            for (const ev of r.uiEvents) yield { type: 'tool_ui', data: ev };
            toolMessages.push({
              role: 'tool',
              tool_call_id: tc.id,
              name: tc.function.name,
              content: r.content,
            });
          }
        }
      }

      // Commit transaction
      try {
        await txn.commit();
        // Surface git status whenever something wasn't fully tracked
        if (txn.gitFailReason && txn.gitStatus !== 'skipped-not-a-repo') {
          yield {
            type: 'tool_ui',
            data: {
              type: 'progress',
              message: `git: ${txn.gitFailReason} — files in transaction journal, /undo still works`,
            },
          };
        }
        // Live code-graph update for any source files we just touched
        const { getIndexer } = await import('../codegraph/tools.js');
        const indexer = getIndexer();
        if (indexer && txn.operations.length > 0) {
          for (const op of txn.operations) {
            if (op.operation === 'delete') continue;
            // Fire-and-forget: don't block the agent loop on indexing
            indexer.indexFile(op.path).catch(e => logger.debug('Live indexFile failed', { err: e.message }));
          }
        }
        // Record touched (non-deleted) files so the auto-verify gate can type-check
        // exactly what this run changed when the model tries to finish.
        for (const op of txn.operations) {
          if (op.operation !== 'delete') touchedSourceFiles.add(op.path);
        }
      } catch (e: any) {
        logger.warn('Transaction commit failed', { err: e.message });
        // Edits are already on disk but the journal/commit didn't finalize, so
        // /undo and verify-baseline won't cover this turn. Surface it the same
        // way we surface git-tracking issues above (don't let it pass silently).
        yield {
          type: 'tool_ui',
          data: {
            type: 'progress',
            message: `journal: commit failed (${e.message}) — /undo may not cover this turn`,
          },
        };
      }

      // Add tool results to message history
      for (const m of toolMessages) newMessages.push(m);
      sessionStore.recordTurn(sessionId, toolMessages, { input: 0, output: 0, costUsd: 0 });

      // Consecutive-failure detection — same tool returning empty / error multiple
      // times in a row, even if args differ each time. This catches the pattern of
      // a model retrying web_search with rephrased queries when the underlying
      // backend is just unreachable / blocked / has no data.
      const FAILURE_MARKERS = ['[NO_RESULTS]', '[WEB_SEARCH_ERROR]', '[ERROR]', '[FAILED]'];
      const allFailedSameTool = toolMessages.length > 0 && toolMessages.every(m => {
        const c = typeof m.content === 'string' ? m.content : '';
        return FAILURE_MARKERS.some(marker => c.includes(marker));
      });
      const sameToolThisTurn = toolMessages.length > 0 &&
        toolMessages.every(m => m.name === toolMessages[0]!.name);
      if (allFailedSameTool && sameToolThisTurn) {
        const thisTool = toolMessages[0]!.name!;
        if (consecutiveFailures.tool === thisTool) {
          consecutiveFailures.count++;
        } else {
          consecutiveFailures.tool = thisTool;
          consecutiveFailures.count = 1;
        }
        if (consecutiveFailures.count >= 3) {
          const note: Message = {
            role: 'user',
            content:
              `[SYSTEM] The \`${thisTool}\` tool has returned empty results / errors ` +
              `${consecutiveFailures.count} times in a row this turn. The underlying service ` +
              `is unavailable or has no data for the query. STOP retrying. Either: ` +
              `(1) tell the user the tool can't reach the data and ask what to do, or ` +
              `(2) answer from your own knowledge if you can. Do not call ${thisTool} again ` +
              `for this user request.`,
          };
          newMessages.push(note);
          sessionStore.recordTurn(sessionId, [note], { input: 0, output: 0, costUsd: 0 });
          logger.warn('Consecutive-failure circuit-breaker tripped', {
            tool: thisTool,
            consecutiveFailures: consecutiveFailures.count,
          });
          // Reset so we don't keep injecting the same note every turn.
          consecutiveFailures.tool = null;
          consecutiveFailures.count = 0;
        }
      } else {
        // Any success / different tool resets the streak.
        consecutiveFailures.tool = null;
        consecutiveFailures.count = 0;
      }

      yield { type: 'iteration_done', data: { iteration: budget.getUsage().iterations } };
    }
  }

  private async executeToolCall(
    tc: ToolCall,
    transaction: Transaction,
    sessionId: string,
    options: AgentOptions,
  ): Promise<{ content: string; isError?: boolean; uiEvents: ToolUIEvent[]; metadata?: Record<string, unknown> }> {
    const uiEvents: ToolUIEvent[] = [];
    let args: any;
    try {
      args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
    } catch (e: any) {
      return {
        content: transformError(e, tc),
        isError: true,
        uiEvents,
      };
    }

    // Per-tool abort controller. We compose two sources of abort:
    //   1. Outer agent signal (user pressed Ctrl+C) → cascades to inner
    //   2. Per-tool timeout → also triggers inner abort
    // The inner signal is passed to the tool's spawn()/fetch() so child processes are actually killed.
    const toolAbort = new AbortController();
    const cascadeAbort = (): void => {
      if (!toolAbort.signal.aborted) toolAbort.abort('outer-cancel');
    };
    if (options.signal) {
      if (options.signal.aborted) {
        toolAbort.abort('outer-cancel');
      } else {
        options.signal.addEventListener('abort', cascadeAbort, { once: true });
      }
    }

    const timeoutSec = this.config.budget.toolTimeoutSeconds ?? 300;
    const timeoutMs = timeoutSec * 1000;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        // CRITICAL: abort the tool's inner signal so spawn'd processes actually die.
        toolAbort.abort('TOOL_TIMEOUT');
        const err: any = new Error(`Tool '${tc.function.name}' exceeded ${timeoutSec}s timeout`);
        err.code = 'TOOL_TIMEOUT';
        reject(err);
      }, timeoutMs);
    });

    const ctx: ToolContext = {
      cwd: this.effectiveCwd ?? this.cwd,
      sessionId,
      transaction,
      permissions: this.permissions,
      askUser: options.askUser,
      emit: (ev) => {
        uiEvents.push(ev);
        if (options.onToolUI) options.onToolUI(ev);
      },
      signal: toolAbort.signal,
      // The snapshot service (if any) is plumbed in from the agent loop's instance.
      // bash and other destructive tools use it to git-stash before risky commands.
      snapshotService: this.snapshotService,
      // Git sandbox handle (only when runSandboxed is active) — lets a tool or the
      // model request a checkpoint or an autonomous backtrack.
      sandbox: this.activeSandbox ? {
        isActive: () => this.activeSandbox?.isActive() ?? false,
        checkpoint: (label: string) => this.activeSandbox?.checkpoint(label) ?? Promise.resolve(null),
        backtrack: () => this.activeSandbox?.backtrack() ?? Promise.resolve(null),
      } : undefined,
      currentTurn: this.currentTurn,
    };

    // ─── Hooks: PreToolUse ─────────────────────────────────────────────────────
    // Run blocking hooks BEFORE tool execution. If any vetoes, return early with the
    // veto message as the tool's result so the model sees the refusal and can adapt.
    const hooks = getHooksManager();
    if (hooks?.hasAny('PreToolUse')) {
      const filePaths = extractFilePathsFromArgs(args);
      const hookResult = await hooks.dispatch('PreToolUse', {
        event: 'PreToolUse',
        sessionId,
        cwd: this.cwd,
        toolName: tc.function.name,
        toolArgsJson: tc.function.arguments,
        filePaths,
      });
      if (hookResult.vetoMessage !== undefined) {
        logger.info('PreToolUse hook vetoed tool call', { tool: tc.function.name });
        return {
          content: `[HOOK_BLOCKED] PreToolUse refused execution of '${tc.function.name}':\n${hookResult.vetoMessage}\n\n` +
            `(This refusal came from a user-configured lifecycle hook, not the model. ` +
            `Adapt your approach — do NOT retry the same call.)`,
          isError: true,
          uiEvents,
        };
      }
      // Non-blocking outputs are surfaced as informational UI events
      for (const out of hookResult.outputs) {
        uiEvents.push({ type: 'log', data: { source: 'PreToolUse', message: out } } as any);
      }
    }

    try {
      // ─── Within-turn read-only cache: short-circuit if we have the result ───
      const tool = this.registry.get(tc.function.name);
      if (this.toolCache && tool && tool.isReadOnly) {
        const cached = this.toolCache.get(tc.function.name, args);
        if (cached) {
          logger.info('Tool result cache hit', { tool: tc.function.name });
          return { content: cached, isError: false, uiEvents };
        }
      }

      // ─── Pre-flight architecture gate (model-agnostic discipline floor) ───
      // On a build/refactor task, require a plan BEFORE the first code change. Soft +
      // one-shot: if the model hasn't planned, return a corrective result it can adapt to;
      // we then let it proceed (never blocks twice → can't lock the agent). A planning call
      // (present_plan / todo_write / writing a DESIGN doc) satisfies the gate instead of tripping it.
      if (this.planGateComplex && tool && !tool.isReadOnly) {
        if (isPlanningToolCall(tc.function.name, args)) {
          this.planGateSatisfied = true; // good — the model is planning; let it through
        } else if (tc.function.name.startsWith('artifact_')) {
          // Artifact tools produce a standalone deliverable (a page/component the user keeps),
          // not a refactor of the project codebase — the architecture-plan discipline doesn't
          // apply, and gating them just derails the create→preview→review flow. Let them through.
        } else if (!this.planGateSatisfied && !this.planGateFired) {
          this.planGateFired = true; // fire at most once per run
          logger.info('Pre-flight gate: requiring a plan before the first build action', { tool: tc.function.name });
          uiEvents.push({ type: 'progress', message: '🧭 Architecture gate: plan first, then build' } as any);
          return { content: PREFLIGHT_MESSAGE, isError: true, uiEvents };
        }
      }

      // ─── Read-before-write gate (stateful tool gating) ───
      // The system prompt's "Read before write" rule, enforced in code instead of prose.
      // A mutating filesystem tool on an EXISTING file is refused unless the file was
      // successfully read this session — and refused if it changed on disk since the
      // last read (stale knowledge). The refusal is a normal tool-result observation,
      // so the model self-corrects by calling read_file. New-file creation always passes.
      // Off-switch: discipline.readBeforeWrite: false
      if (isGatedMutationTool(tc.function.name) &&
          (this.config as any)?.discipline?.readBeforeWrite !== false) {
        for (const p of extractMutationPaths(tc.function.name, args)) {
          const absP = path.isAbsolute(p) ? p : path.resolve(this.effectiveCwd ?? this.cwd, p);
          let st: fsSync.Stats | null = null;
          try { st = fsSync.statSync(absP); } catch { st = null; }
          if (!st || !st.isFile()) continue; // new file (or non-file): creation is allowed
          const verdict = this.readLedger.check(absP, st.mtimeMs);
          if (!verdict.ok) {
            const rel = path.relative(this.effectiveCwd ?? this.cwd, absP) || p;
            logger.info('Read-before-write gate refused mutation', {
              tool: tc.function.name, path: rel, kind: verdict.kind,
            });
            uiEvents.push({
              type: 'progress',
              message: `🔒 Read-before-write: ${rel} ${verdict.kind === 'unread' ? 'not read yet' : 'changed since last read'} — asking model to read it first`,
            } as any);
            return { content: buildGateMessage(rel, verdict.kind), isError: true, uiEvents };
          }
        }
      }

      // ─── Auto-snapshot: take ONE snapshot per turn, before the first mutating tool ───
      // Why per-turn instead of per-tool: a single user request often triggers many
      // edits (read → edit_text × 3 → bash test → edit_text × 2). One snapshot at
      // the start of the work captures the pre-change state. /undo rolls back the
      // whole turn — exactly what the user wants if "make the change" went sideways.
      //
      // This is the safety net Hamed asked for: every mutation has a back button.
      if (this.snapshotService && !this.turnSnapshotTaken) {
        const isMutating = tool && !tool.isReadOnly;
        if (isMutating) {
          try {
            const rec = this.snapshotService.takeSnapshot(
              `turn-${this.currentTurn}: before ${tc.function.name}`,
              this.currentTurn,
            );
            if (rec) {
              this.turnSnapshotTaken = true;
              logger.info('Auto-snapshot taken before mutating tool', {
                tool: tc.function.name,
                turn: this.currentTurn,
              });
              uiEvents.push({
                type: 'progress',
                message: `🔖 Auto-snapshot taken (use /undo to roll back)`,
              } as any);
            }
          } catch (e: any) {
            logger.warn('Auto-snapshot failed (non-fatal)', { err: e?.message });
          }
        }
      }

      let result = await Promise.race([
        this.registry.execute(tc.function.name, args, ctx),
        timeoutPromise,
      ]);

      // ─── Universal spill guard (THE choke point for oversized results) ───
      // Every tool result passes through here before it can become message
      // content, so one check covers http_request, web_fetch, shell, grep,
      // browser_*, MCP tools — everything. Oversized content is written in
      // full to ~/.qodex/tool-spill/<sessionId>/ and replaced by
      // head + "[N chars spilled — full output: <path>]" + tail, so the model
      // keeps status lines and tail errors AND knows how to read the rest
      // (read_file with offset/limit). isError and metadata pass through
      // untouched. Runs BEFORE the read-only cache store so a cache hit can
      // never resurrect the full-size copy. Best-effort: a failed spill must
      // never eat the result.
      const spillMax = this.config.tools?.maxResultChars ?? 16_000;
      if (spillMax > 0 && typeof result.content === 'string' && result.content.length > spillMax) {
        try {
          const spill = await applySpillGuard(tc.function.name, sessionId, result.content, {
            maxResultChars: spillMax,
          });
          if (spill.spilled) {
            logger.info('Tool result spilled to disk', {
              tool: tc.function.name,
              chars: result.content.length,
              spillPath: spill.spillPath,
            });
            uiEvents.push({
              type: 'progress',
              message: `💾 Large ${tc.function.name} output (${result.content.length.toLocaleString()} chars) spilled to disk — context keeps head+tail+path`,
            } as any);
            result = { ...result, content: spill.content };
          }
        } catch (e: any) {
          logger.warn('Spill guard failed (result kept in full, non-fatal)', { err: e?.message });
        }
      }

      // Store successful read-only results in cache
      if (this.toolCache && tool && tool.isReadOnly && !result.isError && typeof result.content === 'string') {
        this.toolCache.set(tc.function.name, args, result.content);
      }

      // ─── Read-before-write ledger updates ───
      // (a) A successful read_file marks the file as seen at its current mtime.
      // (b) A successful gated mutation also marks it: the model authored the new
      //     content, so it knows the file — and recording the post-write mtime keeps
      //     the model's own edit from tripping the staleness check on the next edit.
      if (!result.isError) {
        const readP = extractReadPath(tc.function.name, args);
        const ledgerPaths = readP !== null ? [readP] : extractMutationPaths(tc.function.name, args);
        for (const p of ledgerPaths) {
          const absP = path.isAbsolute(p) ? p : path.resolve(this.effectiveCwd ?? this.cwd, p);
          try {
            const st = fsSync.statSync(absP);
            if (st.isFile()) this.readLedger.mark(absP, st.mtimeMs);
          } catch { /* file gone or unreadable — nothing to record */ }
        }
      }

      // ─── Blast-radius impact note (warn-only) ───
      // After a successful code edit, ask the code graph what the edit touches and
      // append a compact [impact] note to the tool result: top-level symbols in the
      // file, reference/caller counts + files, covering tests — plus a ⚠ line when
      // caller files were never read this session (cross-checked with the read-ledger).
      // Advisory only, never blocks; silently skipped when the graph is absent, stale,
      // or doesn't know the file. Off-switch: discipline.impactNotes: false
      if (!result.isError && IMPACT_EDIT_TOOLS.has(tc.function.name) &&
          (this.config as any)?.discipline?.impactNotes !== false) {
        try {
          const { getCodeGraphDB } = await import('../codegraph/tools.js');
          const graph = getCodeGraphDB();
          if (graph) {
            const cwd0 = this.effectiveCwd ?? this.cwd;
            for (const p of extractMutationPaths(tc.function.name, args)) {
              const absP = path.isAbsolute(p) ? p : path.resolve(cwd0, p);
              if (!isCodeFile(absP)) continue;
              const impact = await computeBlastRadius(graph, absP, {
                cwd: cwd0,
                wasRead: (fp) => this.readLedger.has(fp),
                signal: toolAbort.signal,
              });
              if (impact.note) {
                const base = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
                result = { ...result, content: `${base}\n\n${impact.note}` };
                if (impact.unreadCallerFiles.length > 0) {
                  uiEvents.push({
                    type: 'progress',
                    message: `⚠ Impact: ${impact.unreadCallerFiles.length} caller file(s) of ${path.basename(absP)} not read this session`,
                  } as any);
                }
              }
            }
          }
        } catch (e: any) {
          logger.debug('Blast-radius impact note skipped', { err: e?.message });
        }
      }

      // ─── Hooks: PostToolUse ───────────────────────────────────────────────────
      // Append any hook stdout to the result text so the model can see linter warnings,
      // formatter notices, etc. Hook exit code is informational only here.
      let finalContent = result.content;
      if (hooks?.hasAny('PostToolUse')) {
        const filePaths = extractFilePathsFromArgs(args);
        const postResult = await hooks.dispatch('PostToolUse', {
          event: 'PostToolUse',
          sessionId,
          cwd: this.cwd,
          toolName: tc.function.name,
          toolArgsJson: tc.function.arguments,
          toolResult: typeof finalContent === 'string' ? finalContent : JSON.stringify(finalContent),
          filePaths,
        });
        if (postResult.outputs.length > 0) {
          const hookOutput = postResult.outputs.join('\n');
          finalContent = (typeof finalContent === 'string' ? finalContent : JSON.stringify(finalContent)) +
            `\n\n[POST_TOOL_USE_HOOKS]\n${hookOutput}`;
        }
      }

      return { content: finalContent, isError: result.isError, uiEvents, metadata: result.metadata as Record<string, unknown> | undefined };
    } catch (e: any) {
      // Timeout or outer cancel → both surfaced as user-friendly observations.
      const timedOut = e.code === 'TOOL_TIMEOUT' || toolAbort.signal.reason === 'TOOL_TIMEOUT';
      if (timedOut) {
        return {
          content: `[TOOL_TIMEOUT] '${tc.function.name}' exceeded ${timeoutSec}s and was killed. ` +
            `If you ran a shell command, the child process has been sent SIGTERM/SIGKILL. ` +
            `Try a smaller scope, a shorter timeout_seconds, or a different approach.`,
          isError: true,
          uiEvents,
        };
      }
      if (toolAbort.signal.aborted) {
        return { content: `[CANCELLED] Tool '${tc.function.name}' was cancelled by user.`, isError: true, uiEvents };
      }
      return { content: transformError(e, tc), isError: true, uiEvents };
    } finally {
      clearTimeout(timeoutHandle);
      if (options.signal && !options.signal.aborted) {
        options.signal.removeEventListener('abort', cascadeAbort);
      }
    }
  }

  /**
   * Default Layer-3 reviewer for the completion-time visual gate: run the registered
   * `artifact_review` tool (self-sufficient — it builds the preview, screenshots it in a
   * headless browser, asks the vision model) inside its own journal transaction, then
   * distill the tool's metadata into the gate's outcome shape. Kept as a method so tests
   * inject `visualReviewFn` instead and never touch a browser. Errors propagate — the
   * gate itself degrades them to an "unverified" pass.
   */
  private async reviewArtifactForVisualGate(
    artifactId: string,
    sessionId: string,
    options: AgentOptions,
  ): Promise<VisualReviewOutcome> {
    const txn = await getJournal().begin(sessionId);
    let res;
    try {
      const ctx: ToolContext = {
        cwd: this.effectiveCwd ?? this.cwd,
        sessionId,
        transaction: txn,
        permissions: this.permissions,
        askUser: options.askUser,
        emit: () => { /* gate runs outside a tool turn — progress surfaces via the notice */ },
        signal: options.signal,
        currentTurn: this.currentTurn,
      };
      res = await this.registry.execute('artifact_review', { id: artifactId }, ctx);
      await txn.commit(); // the review writes the preview page — journal it like any tool write
    } catch (e) {
      try { await txn.rollback(); } catch { /* best-effort */ }
      throw e;
    }
    const md: any = res.metadata ?? {};
    const verdict =
      !res.isError && ['looks_good', 'needs_work', 'broken', 'unverified'].includes(md.verdict)
        ? md.verdict as VisualReviewOutcome['verdict']
        : 'unverified';
    return {
      verdict,
      issues: Array.isArray(md.issues) ? md.issues.map(String) : [],
    };
  }

  /**
   * Summarize the combined history (base messages + this run's new messages),
   * collapsing all but the most recent turns into one summary system message.
   *
   * Returns the NEW combined message list, or null if compaction didn't run
   * (below threshold, or summarization failed — caller keeps the originals).
   *
   * Algorithm notes:
   *  - We compact the COMBINED list so the summary spans the whole conversation,
   *    not just this run. compactMessages understands turn-group boundaries and
   *    never severs a tool_call from its tool_result.
   *  - The summarizer runs on the cheapest warm model: we ask the router for the
   *    'general' class at the current token estimate, which on local stacks is
   *    the same model already in VRAM (no swap → no reload stall).
   */
  private async runCompaction(
    combined: Message[],
    ctxWindow: number,
    signal: AbortSignal | undefined,
  ): Promise<Message[] | null> {
    const { compactMessages } = await import('../utils/compaction.js');

    const sumRoute = this.router.route('general', this.estimateTokens(combined), {});

    const summarize = async (msgs: Message[]): Promise<string> => {
      const stream = sumRoute.provider.complete({
        model: sumRoute.model,
        messages: msgs,
        tools: [],
        signal,
      });
      let text = '';
      for await (const ev of stream) {
        if (signal?.aborted) break;
        if (ev.type === 'text_delta') text += ev.delta ?? '';
      }
      return text.trim();
    };

    const result = await compactMessages(combined, { keepLastTurns: 6, summarize });
    if (result.turnsCompacted === 0) return null;
    logger.info('Auto-compaction ran', {
      turnsCompacted: result.turnsCompacted,
      before: result.before,
      after: result.after,
      savedTokens: result.before - result.after,
      ctxWindow,
    });
    return result.messages;
  }

  private classifyTask(initial: Message[], scratch: Message[]): TaskClass {
    const userMsg = initial.find(m => m.role === 'user')?.content ?? '';
    const text = String(userMsg).toLowerCase();

    // If we already have several iterations, treat as code-generation
    if (scratch.length >= 4) return 'code-generation';

    if (text.includes('plan') || text.includes('design') || text.includes('approach') || text.includes('strategy')) {
      return 'planning';
    }
    if (text.includes('refactor') || text.includes('implement') || text.includes('add ') || text.includes('write ') || text.includes('fix ') || text.includes('build ')) {
      return 'code-generation';
    }
    return 'general';
  }

  /**
   * Classify the user's request for the purpose of system-prompt addendum.
   * Different from classifyTask (which is for router model selection); this
   * picks ONE of refactor/debug/feature/review/explain/general based on the
   * user's verbs and structure.
   */
  private classifyForPrompt(initial: Message[]): 'refactor' | 'debug' | 'feature' | 'review' | 'explain' | 'frontend' | 'backend' | 'analysis' | 'general' {
    const userMsg = initial.find(m => m.role === 'user')?.content ?? '';
    const text = String(userMsg).toLowerCase();
    // Backend / Django signals — checked FIRST so "design the Django models" classifies as backend, not frontend.
    // Persian terms are matched WITHOUT \b — JS word boundaries don't fire around non-ASCII letters.
    if (/\b(django|drf|django ?rest|serializer|viewset|queryset|orm|migration|makemigrations|models?\.py|celery|wsgi|asgi|manage\.py|backend|back ?end|api ?endpoint|rest ?api)\b/.test(text)
      || /(جنگو|بک‌?اند|بک ?اند|بکند|سمت ?سرور|پایگاه ?داده|دیتابیس)/.test(text)) {
      return 'backend';
    }
    // Frontend signals — strongest match (overrides feature/refactor when explicit).
    if (/\b(design|redesign|ui|ux|frontend|landing(?: ?page)?|hero(?: section)?|component|style|theme|layout|animation|three\.?js|react three|r3f|page|button|navbar|header|footer|card|modal|dropdown|form ?design|color|palette|tailwind|shadcn|figma|wireframe|prototype|mockup|polish|aesthetic|beautiful|elegant|modern|minimalist|gradient|glassmorphism|neumorphism|skeuomorphic|3d|scene|webgl|shader|seo|json-?ld|structured ?data|schema\.?org|rich ?results|open ?graph|sitemap)\b/.test(text)
      || /(دیزاین|طراحی|زیبا|فرانت|قشنگ|مدرن|گرادیان|ظاهر|رابط ?کاربری|سایت|وب ?سایت)/.test(text)) {
      return 'frontend';
    }
    // Highest-signal first
    if (/\b(refactor|restructure|clean ?up|simplify|extract|inline|rename|move|consolidate|deduplicate|untangle)\b/.test(text)) return 'refactor';
    if (/\b(debug|fix|error|exception|crash|broken|bug|broke|stuck|hang|throwing|undefined|null|fail|regression|نمی‌?کار|نمیکار|خراب|باگ|اشکال|درست(?: نمی| نمی))\b/.test(text)) return 'debug';
    if (/\b(review|critique|audit|inspect|code ?review|smell|improve|quality|بررسی)\b/.test(text)) return 'review';
    if (/\b(explain|describe|what does|how does|walk through|understand|چطور|چگونه|توضیح)\b/.test(text)) return 'explain';
    // Analytical / decision / business tasks — NOT coding. Checked before `feature` so
    // "build a business plan" / "develop a strategy" classify as analysis, not a build task.
    if (/\b(trade-?offs?|business ?plan|pros and cons|cost[- ]benefit|swot|feasibility|go-to-market|value proposition|market analysis|competitive analysis|monetiz|decision matrix|which (?:option |one )?(?:is )?better|compare\b[\s\S]*\b(?:vs|versus)\b|evaluate (?:the )?options|weigh (?:the )?(?:options|pros)|should (?:i|we) (?:use|choose|pick|go with)|strategy|analy[sz]e|analysis)\b/.test(text)
      || /(تحلیل|بیزینس ?پلن|طرح ?کسب|کسب ?و ?کار|استراتژی|مقایسه|مزایا و معایب|سود و زیان|گزینه|ارزیابی|امکان ?سنجی|تصمیم|بازار)/.test(text)) {
      return 'analysis';
    }
    if (/\b(add|build|implement|create|new feature|develop|integrate|بساز|اضافه|پیاده ?سازی|ایجاد)\b/.test(text)) return 'feature';
    return 'general';
  }

  /** Drop oldest turn groups when context exceeds budget. Preserves tool_call/tool_result coupling. */
  private pruneMessages(messages: Message[], maxTokens: number): Message[] {
    const totalEst = this.estimateTokens(messages);
    if (totalEst <= maxTokens) return messages;

    const systemMessages = messages.filter(m => m.role === 'system');
    const nonSystem = messages.filter(m => m.role !== 'system');

    // Group as: each user message starts a new turn-group; assistant+tool messages belong to the previous group
    const groups: Message[][] = [];
    let current: Message[] = [];
    for (const m of nonSystem) {
      if (m.role === 'user' && current.length > 0) {
        groups.push(current);
        current = [m];
      } else {
        current.push(m);
      }
    }
    if (current.length > 0) groups.push(current);

    // ── Phase 1: drop whole oldest turn-groups ──
    let droppedGroups = 0;
    while (groups.length > 2 && this.estimateTokens([...systemMessages, ...groups.flat()]) > maxTokens) {
      groups.shift();
      droppedGroups++;
    }

    let kept = groups.flat();

    // ── Phase 2: compact WITHIN the surviving messages ──
    // An autonomous task is ONE user message followed by many assistant/tool turns — it
    // never splits into >2 groups, so Phase 1 can't touch it and context grows unbounded
    // until the model's window overflows, it loses the plot, and it restarts the task
    // (re-reading the same files in a loop). Keep the anchor (first user message = the
    // task) plus the most recent assistant-led units; drop the oldest middle units.
    let droppedUnits = 0;
    if (kept[0]?.role === 'user' && this.estimateTokens([...systemMessages, ...kept]) > maxTokens) {
      const anchor = kept[0];
      const units: Message[][] = [];
      let cur: Message[] = [];
      for (const m of kept.slice(1)) {
        // A unit begins at an assistant or user message; tool results attach to it. Keeping
        // whole units guarantees no tool result is orphaned from its assistant tool_calls.
        if ((m.role === 'assistant' || m.role === 'user') && cur.length > 0) { units.push(cur); cur = [m]; }
        else cur.push(m);
      }
      if (cur.length > 0) units.push(cur);

      while (units.length > 2 && this.estimateTokens([...systemMessages, anchor, ...units.flat()]) > maxTokens) {
        units.shift();
        droppedUnits++;
      }
      // Never let the tail start with a lone user injection right after the anchor — two
      // consecutive user messages are rejected by strict providers.
      while (units.length > 0 && units[0]!.every(m => m.role === 'user')) { units.shift(); droppedUnits++; }
      kept = [anchor, ...units.flat()];
    }

    if (droppedGroups === 0 && droppedUnits === 0) {
      logger.warn('Context still over budget; nothing further prunable', { totalEst, maxTokens });
      return messages;
    }

    const dropped = droppedGroups + droppedUnits;
    const notice =
      `[CONTEXT_COMPACTED] ${dropped} earlier step${dropped > 1 ? 's' : ''} omitted to fit the model's context window. ` +
      `Do NOT restart the task or re-read files you already examined — continue from where you left off and report what you have found. ` +
      `If you've gathered enough, give the answer now.\n\n---\n\n`;

    // CRITICAL: the first kept message is the user anchor. Prepending a SEPARATE user
    // message for the notice would create two consecutive user messages — which Anthropic
    // strict-rejects and some Ollama/OpenAI deployments fail on. Merge in-place.
    const firstKept = kept[0];
    if (firstKept?.role === 'user' && typeof firstKept.content === 'string') {
      kept[0] = { ...firstKept, content: notice + firstKept.content };
      logger.info('Context compacted', { droppedGroups, droppedUnits, beforeTokens: totalEst });
      return [...systemMessages, ...kept];
    }

    // Defensive fallback — shouldn't normally happen because groups start with user.
    logger.warn('Context compaction fallback path triggered', { firstKeptRole: firstKept?.role });
    return [...systemMessages, { role: 'user', content: notice }, ...kept];
  }

  private estimateTokens(messages: Message[]): number {
    let chars = 0;
    for (const m of messages) {
      chars += (m.content?.length ?? 0);
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          chars += tc.function.name.length + tc.function.arguments.length;
        }
      }
    }
    return Math.ceil(chars / 4);
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// Active-agent singleton.
//
// The TUI creates exactly one AgentLoop per session. Slash commands need to operate
// on its state (toggle subagents on/off, list snapshots, etc.) without taking the
// loop as a parameter — that would require plumbing through every slash command.
// Pattern matches the active-config singleton in config/loader.ts.

let _activeAgent: AgentLoop | null = null;
export function setActiveAgent(agent: AgentLoop | null): void { _activeAgent = agent; }
export function getActiveAgent(): AgentLoop | null { return _activeAgent; }

/**
 * Strip standalone JSON objects from text.
 *
 * Background: local models (notably Qwen 2.5 in Ollama) sometimes emit a tool call as
 * a literal JSON object in their text stream instead of using the structured tool_calls
 * field. The text-tool-recovery layer extracts these into proper ToolCall objects, but
 * if the JSON had a syntax error (e.g. a raw newline inside a string value), the
 * cleanedText still contains the broken JSON. Persisting that to history then causes
 * Ollama to HTTP 400 on the NEXT turn because it tries to re-parse the content.
 *
 * This helper does a final pass: walk the text and excise any top-level `{...}` block
 * that looks like a tool call (heuristic: contains "name" and either "arguments" or
 * "parameters" or "input" within the first 50 characters of the object's content).
 *
 * Conservative — leaves prose intact, only removes objects that *clearly* are leaked
 * tool calls. Returns the remaining text trimmed of resulting whitespace runs.
 */
function stripStandaloneJsonObjects(text: string): string {
  if (!text || !text.includes('{')) return text;
  let result = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '{') {
      result += text[i];
      i++;
      continue;
    }
    // Found an opening brace — walk forward to find the matching close
    let depth = 0;
    let inString = false;
    let escape = false;
    let endIdx = -1;
    for (let j = i; j < text.length; j++) {
      const c = text[j]!;
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) { endIdx = j; break; }
      }
    }
    if (endIdx === -1) {
      // Unbalanced — keep the rest as-is
      result += text.slice(i);
      break;
    }
    const block = text.slice(i, endIdx + 1);
    // Heuristic: does this look like a leaked tool call?
    // Must contain "name" as a key AND one of: "arguments" / "parameters" / "input"
    // within the first 200 chars so we don't accidentally eat code snippets.
    const head = block.slice(0, 200);
    const looksLikeToolCall =
      /"name"\s*:/.test(head) &&
      (/"arguments"\s*:/.test(head) || /"parameters"\s*:/.test(head) || /"input"\s*:/.test(head));
    if (looksLikeToolCall) {
      // Drop the block; continue from after it
      i = endIdx + 1;
    } else {
      // Keep the block intact
      result += block;
      i = endIdx + 1;
    }
  }
  // Collapse runs of 3+ newlines down to 2
  return result.replace(/\n{3,}/g, '\n\n').trim();
}