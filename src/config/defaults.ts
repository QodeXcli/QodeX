import * as os from 'os';
import * as path from 'path';

/**
 * Resolve the user's home directory robustly.
 *
 * Why this exists: `os.homedir()` reads `$HOME` first on POSIX and falls back
 * to `getpwuid(uid)` if HOME is unset. But if HOME is set to a wrong value
 * (e.g. '/' when VS Code is launched from Spotlight and a child process
 * inherits a broken env), Node returns the wrong value silently.
 *
 * The downstream bug — `mkdir '/.qodex'` failing with ENOENT/EACCES — is
 * hostile to diagnose. So we sanity-check and fall back to /Users/$USER on
 * macOS, /home/$USER on Linux, when the result looks bogus.
 */
function resolveHomedir(): string {
  const reported = os.homedir();
  // A real home is at least 2 chars (e.g. `/X`) AND not just `/`.
  if (reported && reported !== '/' && reported !== '' && reported.length > 1) {
    return reported;
  }
  // Fallback: derive from username
  const user = process.env.USER || process.env.LOGNAME || process.env.USERNAME;
  if (user) {
    if (process.platform === 'darwin') return `/Users/${user}`;
    if (process.platform === 'linux') return `/home/${user}`;
    if (process.platform === 'win32') return `C:\\Users\\${user}`;
  }
  // Last resort: use the reported value even if it looks weird, so we don't
  // silently throw away the user's actual setting if it happens to be
  // intentional (rare; basically only matters in containers).
  return reported || '/tmp';
}

export const QODEX_HOME = path.join(resolveHomedir(), '.qodex');
export const QODEX_LOG_FILE = path.join(QODEX_HOME, 'qodex.log');
export const QODEX_CONFIG_FILE = path.join(QODEX_HOME, 'config.yaml');
export const QODEX_TXN_DB = path.join(QODEX_HOME, 'transactions.db');
export const QODEX_SESSION_DB = path.join(QODEX_HOME, 'sessions.db');
export const QODEX_TELEMETRY_DB = path.join(QODEX_HOME, 'telemetry.db');
export const QODEX_BLOBS_DIR = path.join(QODEX_HOME, 'blobs');

/**
 * Per-role model assignment. A role is a named slot the parent agent can target
 * via the `task` tool (e.g. `task({ role: "vision", prompt: "..." })`) — the
 * dispatcher then runs that work with the configured provider/model and an
 * optional role-specific system prompt.
 *
 * Built-in roles: see comment on `QodexConfig.roles`.
 */
export interface RoleConfig {
  /** Provider + model. Optional: when omitted (e.g. an imported Claude Code agent that
   *  inherits), the role inherits roles.subagent → parent default. */
  // A built-in provider, OR a custom gateway name from providers.custom[].name.
  // `(string & {})` keeps editor autocomplete for the built-ins while allowing any name.
  provider?: 'ollama' | 'anthropic' | 'openai' | 'deepseek' | (string & {});
  model?: string;
  /** Per-sub-agent iteration cap. Defaults to subagents.budgetPerSubagent.maxIterations. */
  maxIterations?: number;
  /** Override system prompt for this role. If unset, role-specific default is used. */
  systemPrompt?: string;
  /** Which tools this role can call. If unset, all tools (minus task itself) are available. */
  allowedTools?: string[];
  /** One-line description (used for listings / model awareness). */
  description?: string;
  /** Where this role came from. 'plugin' = imported from a Claude Code agent. */
  origin?: 'config' | 'plugin';
}

export interface QodexConfig {
  defaults: {
    // A built-in provider, OR a custom gateway name from providers.custom[].name.
    provider: 'ollama' | 'anthropic' | 'openai' | 'deepseek' | (string & {});
    model: string;
    preferLocal: boolean;
    /** Preload the local default model at startup so the first prompt isn't a cold load.
     *  Local backends only; no effect on cloud models. Default true. */
    warmOnStart?: boolean;
    maxIterations: number;
    /** Web search backend. 'duckduckgo' (default, no auth), 'tavily' (TAVILY_API_KEY),
     *  'brave' (BRAVE_SEARCH_API_KEY), or 'firecrawl' (FIRECRAWL_API_KEY; set
     *  FIRECRAWL_SCRAPE_CONTENT=1 to return full page markdown inline and skip follow-up
     *  fetches). web_search auto-falls-back to any other backend whose key is present. */
    web_search_backend?: 'duckduckgo' | 'tavily' | 'brave' | 'firecrawl';
  };
  providers: {
    ollama: {
      baseUrl: string;
      /** Ollama `keep_alive` — how long the model stays resident after a request.
       *  Longer avoids a cold reload (and full prefill) between turns. Default '30m'. */
      keepAlive?: string;
      /** Extra Ollama runtime `options` merged verbatim into every request. Numbers, strings,
       *  and bools all pass through, so any llama.cpp/Ollama runtime flag works — including the
       *  ones that matter for large MoE coders on limited VRAM:
       *    - `num_gpu`: layers to keep on the GPU (the rest run on CPU). Lower it to fit a big
       *      MoE model in VRAM. See src/llm/offload.ts `suggestGpuLayers` for a sensible value.
       *    - `num_ctx`: defaults to the routed model's context window so long sessions aren't
       *      silently truncated by the server's 2k/4k default. Bigger num_ctx ⇒ bigger KV cache.
       *  `keep_alive` (above) keeps the model + its KV cache warm between turns — the local
       *  "turbo cache" that, with QodeX's byte-stable prompt prefix, avoids a full re-prefill. */
      options?: Record<string, number | string | boolean>;
      /** Draft model for speculative decoding, if the local server supports it. Passed
       *  through verbatim; servers that don't read it ignore it. */
      draftModel?: string;
    };
    anthropic: {
      apiKeyEnv: string;
      /** Enable prompt caching via cache_control headers. Free to enable; first call full price, subsequent calls within 5 min get ~90% discount on cached portion. */
      useCaching?: boolean;
    };
    openai: {
      apiKeyEnv: string;
      baseUrl?: string;
      /** Additional model ids the gateway exposes that aren't in the built-in catalog. */
      extraModels?: Array<{
        id: string;
        contextWindow: number;
        maxOutput: number;
        inputCostPerMillion: number;
        outputCostPerMillion: number;
        supportsToolCalls?: boolean;
        supportsStreaming?: boolean;
      }>;
      /** Extra HTTP headers, e.g. for gateways needing non-Bearer auth schemes. */
      defaultHeaders?: Record<string, string>;
      /** Draft model for speculative decoding on an OpenAI-compatible local server
       *  (LM Studio). Sent as an extra `draft_model` body field; vanilla OpenAI and
       *  servers that don't support speculation ignore the unknown field. On an
       *  M3 Ultra a 0.5–1.5B draft against a large primary commonly yields 2–4× tok/s. */
      draftModel?: string;
      /** Sampling overrides for local-server backends (LM Studio, llama.cpp).
       *  Useful to combat repetition collapse on quantized models during long generation.
       *  Defaults (when unset): temperature=0.3, top_p=1.0, frequency_penalty=0, presence_penalty=0.
       *  For prose generation on quantized models, try:
       *    temperature: 0.7, top_p: 0.9, frequency_penalty: 0.5, presence_penalty: 0.3
       */
      samplingOptions?: {
        temperature?: number;
        top_p?: number;
        frequency_penalty?: number;
        presence_penalty?: number;
      };
    };
    deepseek: {
      apiKeyEnv: string;
      baseUrl: string;
      extraModels?: Array<{
        id: string;
        contextWindow: number;
        maxOutput: number;
        inputCostPerMillion: number;
        outputCostPerMillion: number;
        supportsToolCalls?: boolean;
        supportsStreaming?: boolean;
      }>;
      defaultHeaders?: Record<string, string>;
    };
    /** User-defined OpenAI-compatible providers. Each needs a unique name (not one
     *  of the built-ins), an env var holding the key, and a baseUrl. `models` is
     *  optional: omit it and QodeX discovers the catalog from GET {baseUrl}/models. */
    custom?: Array<{
      name: string;
      apiKeyEnv: string;
      baseUrl: string;
      models?: Array<{
        id: string;
        contextWindow?: number;
        maxOutput?: number;
        inputCostPerMillion?: number;
        outputCostPerMillion?: number;
        supportsToolCalls?: boolean;
        supportsStreaming?: boolean;
      }>;
      defaultHeaders?: Record<string, string>;
      samplingOptions?: Record<string, number>;
      /** Extra guidance appended to the full system prompt for this provider's models.
       *  Tunes behavior (e.g. "you have 1M context, read whole files freely"); it does
       *  not raise the model's reasoning ceiling. */
      systemPromptAppend?: string;
      /** Full replacement of the system-prompt body for this provider (power-user).
       *  QodeX still re-states identity + the available tool list around it. */
      systemPromptOverride?: string;
    }>;
  };
  routing: {
    planning: string;
    toolDecision: string;
    codeGeneration: string;
    reflection: string;
  };
  budget: {
    dailyLimitUsd: number;
    perTaskLimitUsd: number;
    perTaskMaxTokens: number;
    perTaskMaxWallSeconds: number;
    toolTimeoutSeconds: number;
  };
  security: {
    autoApprove: string[];
    autoReject: string[];
    /**
     * Commands that ALWAYS require explicit user consent — even when session
     * auto-approve (`/auto on`) is active and even if an autoApprove pattern
     * would otherwise match. For system-mutating commands (changing global OS
     * settings, package installs, ownership/permission changes) where silent
     * execution risks destabilizing the user's machine. Unlike autoReject these
     * are not blocked outright — the user is asked and may approve. Optional for
     * back-compat; defaults applied at load.
     */
    alwaysAsk?: string[];
    sandboxShell: boolean;
  };
  ui: {
    theme: 'dark' | 'light';
    showThinking: boolean;
    showTokenCount: boolean;
    showCost: boolean;
  };
  /**
   * Telegram/Discord bot front-end (`qodex bot`). Tokens are NOT here — they're secrets read
   * from ~/.qodex/.env (TELEGRAM_BOT_TOKEN / DISCORD_TOKEN). Only the (non-secret) allowlists
   * live in config. `allowedUsers` is DENY-by-default: an empty list lets nobody in; the
   * literal '*' opts a platform into public access (a deliberate foot-gun — a coding agent
   * runs shell on your host). Optional for back-compat; defaults applied at load.
   */
  bot?: {
    telegram?: { enabled?: boolean; allowedUsers?: string[] };
    discord?: { enabled?: boolean; allowedUsers?: string[] };
    /** Slack via Socket Mode. Tokens (SLACK_APP_TOKEN + SLACK_BOT_TOKEN) live in ~/.qodex/.env;
     *  needs `npm i @slack/socket-mode @slack/web-api`. allowedUsers holds Slack user ids. */
    slack?: { enabled?: boolean; allowedUsers?: string[] };
  };
  mcp: {
    servers: Record<string, {
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      url?: string;
      headers?: Record<string, string>;
      enabled?: boolean;
      destructive?: boolean;
      startupTimeoutSeconds?: number;
    }>;
  };
  /**
   * Auto-compaction tuning. When the conversation exceeds `threshold` of the
   * context window, older turns are summarized into a single system message and
   * recent turns are kept verbatim. All optional — sane defaults apply.
   */
  compaction?: {
    /** Master switch. Default true. */
    enabled?: boolean;
    /** Fraction of the context window that triggers compaction. Default 0.75. */
    threshold?: number;
    /**
     * Context window in tokens for the threshold math. When unset, QodeX uses
     * the routed model's actual context window (falling back to 32768 only if
     * the model doesn't report one). Set this to override — e.g. if your local
     * model serves a larger window than it advertises.
     */
    contextWindow?: number;
  };
  /**
   * Sub-agent dispatcher settings.
   *
   * mode = 'off'       : `task` tool unavailable, no sub-agents ever spawn.
   * mode = 'sequential' (default for local): sub-agents run one at a time, each with
   *                      its own isolated context. Parent only sees the final summary.
   *                      Same wall-clock cost as inline, but context stays clean.
   * mode = 'parallel'  : sub-agents run concurrently. Only meaningful on cloud providers
   *                      (Anthropic / OpenAI), since local single-GPU stacks serialise
   *                      anyway. Falls back to sequential when the active provider is
   *                      local (Ollama).
   *
   * maxConcurrent caps parallel mode. budgetPerSubagent limits how much each can spend
   * before being killed (anti-runaway).
   */
  subagents?: {
    mode: 'off' | 'sequential' | 'parallel';
    maxConcurrent?: number;
    budgetPerSubagent?: { maxTokens?: number; maxIterations?: number };
    /**
     * Concurrency policy. 'auto' is recommended: parallel only when sub-agents run on
     * a different provider than the parent (e.g. parent local, sub-agent cloud). Two
     * local models on a single GPU serialize anyway, so we fall back to sequential.
     * 'force' lets the user override the check (useful for benchmarking).
     */
    concurrencyMode?: 'auto' | 'force';
  };
  /**
   * Per-role model selection. Lets the user pick a different model for sub-agents than
   * for the parent — the common patterns are:
   *   - parent qwen2.5-coder:32b + sub-agent qwen2.5-coder:7b  (heavy reasoning, light workers)
   *   - parent local + sub-agent cloud (orchestrate locally, delegate to Claude when needed)
   *   - parent cloud + sub-agent local (Claude decides; workers run free)
   *
   * Sub-agents inherit parent model when this is undefined (current behaviour preserved).
   * Per-call `task` invocations can ALSO override via the tool's `model` argument.
   *
   * As of v1.1.0, `roles` is an open Record — define any named role with its own
   * provider+model. Built-in roles understood by QodeX:
   *   - `subagent`   — dispatched by the `task` tool when no explicit role given
   *   - `vision`     — used by `task` when caller passes `role: "vision"`; runs
   *                    with a vision-tuned system prompt; expects a vision-capable model
   *   - `summarization` — used by /compact (when implemented)
   *   - `planning`   — used in plan mode (when implemented)
   *
   * Custom roles are also allowed — callers can pass any role name to `task` and
   * if a config entry exists, that provider/model is used. Otherwise it falls back
   * to `subagent` then to parent.
   */
  roles?: Record<string, RoleConfig | undefined>;
  /**
   * Context-assembly settings. The auto-retrieval pre-pass embeds the user's request and
   * injects the most semantically-relevant files into the first turn — so the model
   * starts pointed at the right code instead of grepping blind. Best-effort: a no-op when
   * Ollama / an embedding index isn't available, never blocks startup.
   */
  context?: {
    /** Auto-infer the project's code style (indentation, quotes, semicolons, naming) from
     *  its source + .editorconfig and inject it so generated code matches — no explicit
     *  `remember` needed. Deterministic, computed once per session. Default true. */
    styleProfile?: boolean;
    /** Enable the auto-retrieval pre-pass. Default true (silently skips when unavailable). */
    autoRetrieve?: boolean;
    /** How many files to surface. Default 6. */
    retrieveTopFiles?: number;
    /** Ollama embedding model. Default 'nomic-embed-text'. */
    embeddingModel?: string;
    /** Build the embedding index on the fly if none is cached. Default false (use the
     *  index `semantic_search` / `/index` built; building inline adds first-run latency). */
    buildIndexIfMissing?: boolean;
    /** Stage-2 cross-encoder reranking of retrieval hits. Default false (opt-in;
     *  needs a local reranker model served via Ollama /api/rerank or /v1/rerank). */
    rerank?: boolean;
    /** Reranker model name, e.g. 'bge-reranker-v2-m3'. */
    rerankModel?: string;
    /** Reranker base URL. Defaults to QODEX_RERANK_URL / OLLAMA_BASE_URL. */
    rerankBaseUrl?: string;
    /** Candidate pool size fed to the reranker before narrowing to retrieveTopFiles. Default 40. */
    rerankCandidates?: number;
    /** Inject upstream/downstream dependency meta-context for retrieved files
     *  (symbol-graph daemon ripple-effect awareness). Default true. */
    dependencyMap?: boolean;
    /** Stale large tool results are stubbed after they age. Set false to disable. */
    resultAging?: boolean;
    /** Age tool results after this many assistant turns. Default 3 (1 when efficient). */
    resultAgingMinTurns?: number;
    /** Only age results larger than this many chars. Default 6000 (2000 when efficient). */
    resultAgingMaxChars?: number;
    /** Efficiency profile — opt-in "sliding token window" for long sessions on weak/local
     *  models (the volatile tier where prompt-caching doesn't apply): ages large results the
     *  very next turn (minTurns 1, maxChars 2000) and compacts earlier (threshold 0.55).
     *  Default false. Explicit values above/in `compaction` always override the profile.
     *  Trade-off: the model may occasionally re-read an aged-out file. */
    efficient?: boolean;
  };
  /**
   * LLM Critic gate — semantic peer review after the mechanical verify gate. A
   * Senior-QA prompt reviews the touched files for logic bugs and spec/convention
   * mismatches a type-checker can't see; a blocking verdict sends the worker back
   * to fix (test-time-compute backtracking). Opt-in — it costs an extra round-trip.
   */
  critic?: {
    /** Enable the critic gate. Default false. */
    enabled?: boolean;
    /** Max critic→repair rounds per task. Default 1. */
    maxRounds?: number;
    /** Max files sent for review. Default 6. */
    maxFiles?: number;
  };
  /**
   * Git-backed sandbox — run complex tasks on a hidden `qodex/sandbox-<id>` branch,
   * then squash-merge the result onto the user's branch only if it passes. Lets the
   * agent experiment and hard-reset dead ends backstage. Opt-in; needs a git repo.
   */
  sandbox?: {
    /** Enable git-backed isolation for normal-mode tasks. Default false. */
    enabled?: boolean;
  };
  /**
   * MCP SERVER mode — when QodeX runs as an MCP server (`qodex mcp serve`),
   * exposing its tools to editors. Controls which tools are visible and how
   * tool calls are authorized in this non-interactive context.
   */
  mcpServer?: {
    /**
     * Tool exposure scope. Which registry tools external clients can see/call.
     *   - 'safe'      : read-only + the qodex_* specials (default — no host edits)
     *   - 'all'       : every registered tool (full power; trust the client)
     *   - string[]    : an explicit allowlist of tool names
     * The qodex_* special tools are always exposed regardless.
     */
    expose?: 'safe' | 'all' | string[];
    /**
     * Rule-based auto-approval for the non-interactive server. Since a server
     * can't prompt a human, a tool needing confirmation is declined by default.
     * These rules grant automatic approval without a prompt:
     */
    autoApprove?: {
      /** Glob-ish path prefixes under which file edits are auto-approved (e.g. ["src/", "test/"]). */
      paths?: string[];
      /** Tool names always auto-approved (e.g. ["read_file", "grep"]). */
      tools?: string[];
      /** If true, ALL tool calls are auto-approved. Dangerous — only on a fully trusted machine. */
      all?: boolean;
    };
  };
  /**
   * Browser tooling. By default the `browser_*` tools launch a fresh headless Chromium.
   * Set `cdpUrl` to ATTACH to an already-running browser over the Chrome DevTools Protocol
   * instead — drive your OWN logged-in Chrome / Brave / Arc / Edge (started with
   * `--remote-debugging-port=9222`), or any Chromium-based browser, with your real cookies
   * and sessions. The `QODEX_BROWSER_CDP_URL` env var overrides this.
   */
  browser?: {
    /** CDP/DevTools endpoint to attach to, e.g. "http://127.0.0.1:9222". */
    cdpUrl?: string;
  };
  /**
   * Local data flywheel — record successful sandbox trajectories (prompt +
   * reasoning + final code) to ~/.qodex/trajectories/<project>.jsonl for a later
   * local QLoRA fine-tune. Strictly local, opt-in, only successful tasks.
   */
  flywheel?: {
    /** Record successful trajectories. Default false. Requires sandbox.enabled. */
    enabled?: boolean;
    /** Also export each successful task as a ShareGPT JSONL record to
     *  ~/.qodex/dataset/<project>.jsonl — a ready-to-use corpus for a future
     *  zero-cost local fine-tune. Default false. Strictly local. */
    datasetExport?: boolean;
  };
  /**
   * Skill-learning loop — capture reusable methodology from OBJECTIVELY-successful tasks
   * into quarantined candidate skills, promoted only by an INDEPENDENT judge and never
   * over a human-authored skill. Off by default (it writes files + costs a judge call).
   * See src/skills/learning/. Designed to avoid the "self-congratulation" failure mode:
   * eligibility is gated on verify/completion signals, not the worker's self-grade.
   */
  /** Memory injection. 'full' (default) injects every learned fact into the prompt; 'lightweight'
   *  injects only `!important`-tagged facts + as many recent facts as fit `injectMaxTokens`, leaving
   *  the rest to load on demand via recall / `/memory`; 'auto' picks lightweight on a small context
   *  window and full on a roomy one. The DB + markdown mirror are unaffected. */
  memory?: {
    mode?: 'full' | 'lightweight' | 'auto';
    injectMaxTokens?: number;
  };
  learning?: {
    /** Capture candidate skills after eligible tasks. Default false. */
    enabled?: boolean;
    /** When `enabled` is OFF, still SUGGEST capturing a skill after a successful task that looks
     *  like a reusable pattern (judged from the code graph). Default true; set false to silence. */
    suggestSkills?: boolean;
    /** Auto-run `skill eval` immediately after a capture (replay in a clean worktree +
     *  objective verify, recorded into the candidate). Costs a model call + worktree per
     *  capture, so it's opt-in. Default false; otherwise run `qodex skill eval` on demand. */
    autoEval?: boolean;
    /** Minimum tool calls for a task to be capture-worthy. Default 5. */
    minToolCalls?: number;
    /** Require objective verification to have passed before capturing. Default true.
     *  Turning this off re-introduces self-grade risk — deliberately loud. */
    requireObjectiveSuccess?: boolean;
    /** Auto-promote candidates whose independent judge passes (vs. leaving them for
     *  a human to review with `qodex skill promote`). Default false. */
    autoPromote?: boolean;
    /** Explicit model id for the independent judge. Must differ from defaults.model
     *  (self-grade is rejected). Falls back to the 'reflection' routing role when unset. */
    judgeModel?: string;
    /** Tier-2 (heavy/cloud) judge for the escalating cascade — used ONLY when the Tier-1
     *  judge is unsure (grey-zone average or high cross-dimension variance). Must differ from
     *  defaults.model and judgeModel. Unset ⇒ no escalation (Tier-1 verdict stands). */
    judgeModelTier2?: string;
    /** Skill versioning + UCB1 adaptive-bandit routing knobs. */
    versioning?: {
      /** UCB1 exploration factor `c` — higher explores challengers more. Default √2 (~1.41). */
      ucbExplorationFactor?: number;
      /** Force-route a challenger at least this many times before UCB1 can starve it, so a
       *  decision is never made on too little signal. Default 5. */
      minChallengerTrials?: number;
      /** Composite-reward weights (success + token-efficiency + time-efficiency). Defaults
       *  { success: 0.7, token: 0.15, time: 0.15 }. */
      rewardWeights?: { success?: number; token?: number; time?: number };
      /** Routing strategy when a manifest doesn't pin one: 'ucb1' (default), 'static', or
       *  'champion-only' (UCB OFF — always the stable version, for sensitive skills). */
      strategy?: 'ucb1' | 'static' | 'champion-only';
    };
    /** When auto-promoting, require at least this confidence (0–100). Default 0 (the
     *  judge's pass is sufficient); raise it to gate low-confidence captures. */
    autoPromoteMinConfidence?: number;
    /** `qodex skill eval` cache TTL in hours — skip re-evaluating an unchanged skill
     *  within this window. Default 24. */
    evalCacheTtlHours?: number;
    /**
     * Episodic memory — record a lean episode after each successful task and, at the start
     * of a new one, inject the most SIMILAR past episode(s) so the agent reuses its own
     * proven approach. Smart retrieval (top-K above a threshold), concise injection.
     */
    episodicMemory?: {
      enabled?: boolean;
      /** How many past episodes to inject. Default 2. */
      topK?: number;
      /** Min lexical similarity (0–1) to inject — below this, nothing. Default 0.18. */
      minSimilarity?: number;
      /** Diversity weight (0–1) for MMR selection — keeps the injected top-K distinct rather
       *  than K near-duplicates of one recurring task. 0 = pure relevance. Default 0.3. */
      diversity?: number;
    };
    /**
     * Failure-driven learning — record tool failures and, once a pattern RECURS across
     * tasks, inject a deterministic "learned caution" into the system prompt so the agent
     * stops repeating it. Off by default. See src/skills/learning/failures.ts.
     */
    failureLessons?: {
      enabled?: boolean;
      /** Min total occurrences before a pattern is learned. Default 3. */
      minOccurrences?: number;
      /** Min DISTINCT tasks the pattern must span (a one-off never teaches). Default 2. */
      minDistinctTasks?: number;
      /** Max cautions injected into the prompt. Default 5. */
      maxInjected?: number;
    };
  };
  /**
   * Auto-verify gate — the model-agnostic quality floor. After the model thinks it has
   * finished a coding task, QodeX type-checks the files it touched and, if they don't
   * compile, feeds the errors back and forces a repair round. Whatever model is connected,
   * it can't ship code that fails to type-check. Best-effort: no-ops when no checker is
   * available for the project.
   */
  verify?: {
    /** Enable the gate. Default true. */
    auto?: boolean;
    /** Consecutive auto-repair rounds before giving up and letting the model finish. Default 2. */
    maxRepairAttempts?: number;
    /** Per-run checker timeout (ms). Default 120000. */
    timeoutMs?: number;
  };
  /** Safety net: auto-snapshot before potentially destructive shell commands. */
  safety?: {
    /** Whether to git-stash before destructive bash commands. Requires a git repo. */
    autoSnapshot: boolean;
    /** Auto-drop stashes older than this many turns (snapshots stay only this long). */
    snapshotRetentionTurns?: number;
  };
  /**
   * Detected hardware profile, cached in config so we don't redetect every startup.
   * Re-run `qx setup` to refresh.
   */
  hardware?: {
    tier: 'small' | 'medium' | 'large' | 'xl';
    ramGb: number;
    appleSilicon: boolean;
    detectedAt: string;
  };
  /**
   * Lifecycle hooks — shell commands triggered at PreToolUse / PostToolUse / SessionStart /
   * SessionEnd / PreCompact. See src/hooks/types.ts for full semantics.
   */
  hooks?: {
    PreToolUse?: Array<{
      matcher?: string;
      command: string;
      timeout?: number;
      cwd?: string;
      blocking?: boolean;
      name?: string;
    }>;
    PostToolUse?: Array<{
      matcher?: string;
      command: string;
      timeout?: number;
      cwd?: string;
      name?: string;
    }>;
    SessionStart?: Array<{
      command: string;
      timeout?: number;
      cwd?: string;
      name?: string;
    }>;
    SessionEnd?: Array<{
      command: string;
      timeout?: number;
      cwd?: string;
      name?: string;
    }>;
    PreCompact?: Array<{
      command: string;
      timeout?: number;
      cwd?: string;
      name?: string;
    }>;
  };
}

export const DEFAULT_CONFIG: QodexConfig = {
  defaults: {
    provider: 'ollama',
    model: 'qwen2.5-coder:32b',
    preferLocal: true,
    warmOnStart: true,
    // Headroom for larger multi-file / creative tasks. Local models in particular
    // spend iterations re-reading + self-correcting; 25 was too tight and tasks hit
    // the cap mid-flight. The loop now also warns at ~80% before the hard stop.
    // Set to 0 for NO iteration limit (token/cost/time budgets still apply). You can
    // also lift it per-session at runtime with /unlimited or /iterations <n>.
    maxIterations: 50,
    web_search_backend: 'duckduckgo',
  },
  providers: {
    ollama: { baseUrl: 'http://localhost:11434' },
    anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },
    openai: { apiKeyEnv: 'OPENAI_API_KEY' },
    deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseUrl: 'https://api.deepseek.com' },
  },
  routing: {
    planning: 'qwen2.5-coder:7b',
    toolDecision: 'qwen2.5-coder:7b',
    codeGeneration: 'qwen2.5-coder:32b',
    reflection: 'qwen2.5-coder:7b',
  },
  budget: {
    dailyLimitUsd: 10.0,
    perTaskLimitUsd: 1.0,
    perTaskMaxTokens: 200_000,
    // Ceiling, not pace-setter: since the stall-aware checkpoint (budget.ts) it only fires
    // when the task ALSO stopped progressing. 600s was calibrated for cloud latency; a local
    // model legitimately spends that on a handful of long generations.
    perTaskMaxWallSeconds: 3600,
    toolTimeoutSeconds: 300,
  },
  security: {
    autoApprove: [
      '^ls( |$)',
      '^pwd$',
      '^echo ',
      '^cat ',
      '^head ',
      '^tail ',
      '^wc ',
      '^which ',
      '^node --version',
      '^npm --version',
      '^git (status|diff|log|show|branch)( |$)',
      '^npm (test|run lint|run typecheck|run test|run build)',
      '^npx tsc',
      '^pytest',
      '^cargo (check|test|build)',
    ],
    autoReject: [
      'rm -rf /',
      'rm -rf /\\*',
      'mkfs',
      'dd if=',
      ':\\(\\)\\{',
      'curl .* \\| (bash|sh)',
      'wget .* \\| (bash|sh)',
      '> /dev/sda',
      'chmod -R 777 /',
    ],
    alwaysAsk: [
      // macOS global preference / system settings mutation
      '\\bdefaults\\s+(write|delete|rename)\\b',
      '\\bpmset\\b',
      '\\bscutil\\b',
      '\\bnvram\\b',
      '\\bsystemsetup\\b',
      '\\bspctl\\b',
      '\\bcsrutil\\b',
      '\\blaunchctl\\s+(load|unload|enable|disable|bootstrap|bootout)\\b',
      // Privilege escalation
      '\\bsudo\\b',
      '\\bsu\\b\\s',
      // Ownership / permission changes (broad)
      '\\bchown\\b',
      '\\bchmod\\s+-R\\b',
      // Package / global installs that mutate the machine
      '\\bbrew\\s+(install|uninstall|reinstall|upgrade)\\b',
      '\\bnpm\\s+(install|uninstall)\\s+-g\\b',
      '\\bpip\\s+install\\b',
      // Disk / partition / mount
      '\\bdiskutil\\b',
      '\\bmount\\b',
      '\\bumount\\b',
      // Firewall / network config
      '\\bifconfig\\b',
      '\\bnetworksetup\\b',
      '\\bpfctl\\b',
    ],
    sandboxShell: false,
  },
  ui: {
    theme: 'dark',
    showThinking: true,
    showTokenCount: true,
    showCost: true,
  },
  bot: {
    telegram: { enabled: false, allowedUsers: [] },
    discord: { enabled: false, allowedUsers: [] },
    slack: { enabled: false, allowedUsers: [] },
  },
  mcp: {
    servers: {},
  },
};
