# QodeX — the local-first LLM agent & coding CLI agent

> **QodeX is an open-source LLM agent for your terminal — a local-first, agentic coding CLI.** It runs on local models (Qwen3-Coder via Ollama / LM Studio) by default, with Claude / GPT / Gemini / DeepSeek as optional cloud fallbacks. A privacy-first AI coding agent built so a model on *your* machine does real, multi-step engineering work — fully offline if you want.

> If you're looking for an **LLM agent**, a **CLI agent**, an **AI coding agent**, or an **autonomous terminal agent** that doesn't ship your code to someone else's cloud — that's QodeX.

**Version 2.5.0** · 100+ built-in tools · self-improving · phone-driveable · English & Persian · Apache-2.0

[![CI](https://github.com/QodeXcli/QodeX/actions/workflows/ci.yml/badge.svg)](https://github.com/QodeXcli/QodeX/actions/workflows/ci.yml)

---

## Highlights

- **Local-first & private** — runs entirely on *your* models (Qwen-Coder via Ollama / LM Studio); your code never leaves the machine. Claude / GPT / Gemini / DeepSeek are opt-in cloud fallbacks.
- **Guardrails around the model, not just prompts** — a syntax gate, completion gate, and per-language auto-verification run *around* the agent loop, so even a weak local model **can't ship broken or unverified code**.
- **It gets sharper the more you use it** — a real self-improvement loop captures the winning approach from *objectively-successful* tasks as quarantined skills, an **independent judge model** promotes them, **UCB1 A/B-tests** champion vs. challenger versions, **episodic memory** recalls how you solved similar tasks before, and it **learns from recurring failures**. Your agent next week is measurably better than today's — and it never overwrites a skill you wrote.
- **Always reachable — drive it from your phone** — run QodeX as a **Telegram / Discord / Slack service** and command the *same* agent from chat: stream tasks, approve diffs as inline buttons, and get **Living Artifacts** back as cards with an AI **vision review** (looks-good / needs-work / broken) and Approve / Edit / Reject.
- **Remembers across sessions** — a layered, **local** memory (curated `QODEX.md` rules · scoped project/user facts · per-project worklog · episodic task-recall · resumable sessions) with a **human-readable Markdown mirror** you can edit and git-commit, and a **budget-aware Light Memory Mode** for small context windows. The agent builds real context about *you* and *this* codebase instead of starting every session cold.
- **Live, shareable artifacts + a project dashboard** — build a page / React app / dashboard that **hot-reloads on every edit and auto-opens in your browser**; share it over your LAN or a private, token-protected https tunnel. `qodex dashboard` renders a live snapshot of providers, sessions, token/cost, memory, and skills.
- **Design integrations** — drive **Figma** (3 ways) and **Canva** straight from the terminal over MCP.
- **100+ built-in tools** — Tree-sitter code-graph, real Playwright browser automation, dev-servers, web search, vision, Docker / DB / WordPress, and any MCP server.
- **Persian-first** — prompts, skill matching, *and* generated artifact copy follow your chat language, not a fixed default.
- **Token-efficient** — sub-agent delegation, result-aging, compaction, and tool-gating keep the working context small on long sessions.

---

## Always-on, and it compounds

An "autonomous 24/7 agent" is easy to *say* and hard to *mean* — most of the time it's a chatbot wrapped in a cron job. QodeX's always-on story is three systems that actually exist, that you can read in this repo, and that each have tests:

- **Reachable any time** — the **transport-agnostic bot gateway** runs as a persistent service, so the agent is one message away from your phone. One turn per chat at a time (no interleaving), permission prompts as inline buttons, **deny-by-default auth**. ([Telegram / Discord / Slack](#telegram--discord--slack-bot))
- **Improves between sessions, on its own** — capture → **independent-judge** promotion → **UCB1** version A/B → **episodic recall** → **failure-lesson** injection. The loop is gated on *objective* success signals, not the model's self-grade, and a new **code-graph "fit" signal** grounds the judge in *your* codebase. ([Self-learning skills](#self-learning-skills))
- **Runs while you sleep — verifiably** — a built-in **cron scheduler** (launchd / crontab) runs tasks unattended and delivers the result to your phone. The headline recipe, **Autonomous Verified PR**, works on a sandbox branch, **verifies**, and opens a PR *only if it passed* — per-task **budget caps**, a **circuit breaker**, the **git sandbox**, and the guardrail gates all run too, so a 3am run **can't quietly ship broken code or melt your token budget**. ([Scheduled & autonomous](#scheduled--autonomous--the-real-247))

We're not going to claim a model thinks for you around the clock. We built the parts that make *unattended, repeated, real* work trustworthy — and we'd rather show the code than the slogan.

---

## What makes it different

Most agentic CLIs *delegate to the model* — they hand the model tools and trust it to use them well. That works with a frontier model and falls apart with a weaker local one (loops, half-finished edits, "done" when nothing was tested).

QodeX takes the opposite stance: **protect the model.** A layer of deterministic guardrails runs *around* the loop so even a smaller local model produces trustworthy output:

- **Syntax gate** — every edit is parsed before it's written; broken syntax is rejected, not saved.
- **Completion gate** — the model can't claim "tests pass" or "I fixed it" unless a test actually ran / an edit actually succeeded. Unsupported claims get bounced back for correction.
- **Auto-verification** — after the model thinks it's done, QodeX detects the project type and runs the real checker (`tsc`, `eslint`, `ruff`, `pyright`, `go vet`, `cargo`, `php -l` …) on touched files and force-feeds any errors back.
- **Interactive edit approval** — see a red/green diff and Accept / Edit / Continue / Reject before anything hits disk (or `/auto on` to skip).
- **Git-backed sandbox** — risky work runs on a hidden branch with checkpoints; auto-snapshot (`git stash`) before destructive commands, one command to roll back.
- **Skill security scanner** — skills installed from GitHub are scanned for prompt injection, secret exfiltration, destructive shell, and hidden-unicode payloads *before* they touch disk.

The result raises the **floor** (what a weak model is allowed to ship) without needing a bigger model.

## Token efficiency

Long agent sessions burn tokens on a growing history, not the (cached) system prompt. QodeX keeps the working context small with four real levers:

- **Delegation** — heavy file-exploration runs in a read-only sub-agent (`task`) with a *separate* context window; only its summary returns, so dozens of reads never pile up in the main window.
- **Result-aging** — stale large tool outputs are stubbed after a few turns (re-read on demand).
- **Compaction** — history is structured-summarized as the window fills.
- **Tool-gating** — only relevant tool schemas are sent each turn (a greeting sees ~20 tools, a real task ~50, out of 100+).
- **Opt-in `context.efficient: true`** tightens all of the above for weak local models.

A live `12.4k/200k ████░░░░░░ 8%` meter in the status bar shows how full the context window is.

## What it can do

Give QodeX a task in natural language (English or Persian) and it drives a real agent loop:

- **Read and edit code** — `read_file`, `write_file`, `edit_text`, `edit_symbol` (AST-aware), `multi_edit` (single-file sequential), `multi_file_edit` (atomic across up to 50 files).
- **Understand a codebase** — `ls`, `glob`, `grep`, plus a Tree-sitter code-graph: `project_overview`, `analyze_impact`, `find_callers`, `find_references`, `find_dead_code`, `safe_rename`.
- **Run commands** — `bash`, plus `code_run` for sandboxed Python / Node / TS / PHP / Ruby (macOS `sandbox-exec` where available).
- **Drive a real browser** — Playwright-backed Chromium: navigate, click, fill, screenshot, evaluate JS, read console + page errors — to verify your own UI changes.
- **Manage dev servers & jobs** — `dev_server_start npm run dev` then `browser_navigate http://localhost:5173`; `background_job_start` for async work, all in one session.
- **Search the web** — DuckDuckGo by default (hardened with a `lite` fallback + retry), or Tavily / Brave / **Firecrawl** (returns full page markdown inline to save round-trips) when you set a key. Auto-fallback chain across whatever keys are present.
- **Smart vision** — `vision_analyze` automatically uses *your own* vision-capable model (Gemini, GPT‑4o, Claude, or a local Qwen‑VL) when your primary or sub‑agent can already see; it only spins up a dedicated vision model when neither can.
- **Shareable live artifacts** — build a web page / React / dashboard and serve it with `artifact_live` that **hot‑reloads on every edit and auto‑opens in your browser** so you watch it change live; `share="network"` opens it to your LAN and `share="tunnel"` gives a **private https link your team can open** (token‑protected) — a live PR walkthrough or project dashboard.
- **Design integrations (Figma + Canva)** — `qodex mcp add figma` (3 ways: your logged‑in desktop Dev Mode, a personal token, or hosted OAuth) and `qodex mcp add canva` (OAuth login) let the model turn a Figma frame into code or build a Canva design — driven from the terminal over MCP.
- **Matches your code style automatically** — QodeX infers the project's conventions (indentation, quotes, semicolons, naming) from its own source + `.editorconfig` and writes new code to match, **without you having to configure or `remember` anything**. Off via `context.styleProfile: false`.
- **Self‑learning skills** — after a task that *objectively* succeeded (verified + honest, ≥ a few tool calls), QodeX can capture the winning approach as a **candidate** skill in quarantine. An **independent judge model** (a *different* model from the one that did the work) reviews it before it’s promoted, and a human‑authored skill is **never** overwritten. Drive it with `qodex skill candidates | curate | promote`. Off by default (`learning.enabled`).
- **Trade‑off & business analysis** — ask it to analyze or plan (not code) and it produces **decision‑grade output**: options × weighted criteria → a scored comparison and one clear recommendation, business‑plan structure, no invented numbers.
- **Persian‑first** — skill auto‑loading and tool selection understand Persian prompts (تحلیل، دیتابیس، آرتیفکت…), not just English keywords.
- **Verify its own work** — `auto_fix` runs your test command in a fix→test loop with an iteration cap and same-failure-twice detection; the auto‑verify gate runs the right checker **per language** in a polyglot repo (TS *and* Python both get checked).
- **Git** — status, diff, log, branch, commit, create-pr, release-notes.
- **Skills** — install from a curated registry or any GitHub repo (single / multi / catalog), security-scanned on the way in; `search_skills` to find them.
- **Sub-agents & orchestration** — `task` delegates to a separate model/window; `orchestrate` runs a DAG of sub-agents; `gather` fans out reads in parallel.
- **MCP** — connect any MCP-compatible server; its tools join the same registry as built-ins.
- **Live project dashboard** — `qodex dashboard` (alias `dash`) renders a single self-contained HTML page — providers & models, recent sessions, token/cost usage, learned memory, and skills — and opens it in your browser. A glanceable health view of *your* QodeX, generated locally.
- **Add a provider by just asking** — tell QodeX *"add Groq with my key"* and the `add_provider` tool wires the gateway into `~/.qodex/config.yaml` (key stays in `~/.qodex/.env`, never the config); or run `qodex provider add` for a guided setup. Unknown providers are refused unless you give a base URL + key-env, so nothing is silently misconfigured.
- **Domain tools** — Docker, databases, WordPress (`php -l` linting), media (ffmpeg), frontend/print, OpenAPI digest, and more.

## Self-learning skills

QodeX can **learn reusable playbooks from your successful tasks** — without the usual failure mode of an agent rubber-stamping its own work and overwriting your hand-tuned skills. The whole loop is **off by default** and gated on *objective* signals, not the model's self-grade.

**How it works:**

1. **Capture** — when a task finishes in the git sandbox and *objectively* succeeds (it compiled / type-checked, the completion-claim gate passed, and it took at least a few tool calls and changed a file), QodeX distills the winning approach into a `SKILL.md` and assigns it a **confidence score (0–100)** from those objective signals.
2. **Quarantine** — the new skill is written to `~/.qodex/skills-candidates/` (a dir QodeX never auto-loads), stamped `provenance: machine`, `status: candidate`. It can't affect the model until promoted.
3. **Independent review** — `qodex skill curate` runs an **independent judge model** (a *different* model from the one that did the work — a self-grade is refused) against a fixed rubric (reusable / correct / specific / non-redundant). The judge is **grounded in your codebase**: a Tree-sitter **code-graph "fit" signal** checks how many of the symbols a candidate references actually exist here, so a skill that name-drops APIs your project doesn't have scores lower (and the capture notice shows it: *"confidence 82/100 · codebase-fit 90%"*). Near-duplicate candidates are **merged** into one. It **never overwrites a human-authored skill**, and snapshots the skills dir (`tar.gz`) before any change so you can roll back.
4. **Auto-evaluation** — `qodex skill eval <name>` (or `learning.autoEval` to run it right after capture) **replays the skill's original task in a throwaway git worktree** and runs the **real** verifier (`tsc`/`ruff`/…) on the code it produces, recording **pass / fail / inconclusive** into the skill. It tests whether the skill actually *works*, not just whether a judge likes it. Content-hash cached.
5. **Learning from failures** — with `learning.failureLessons.enabled`, QodeX records tool failures and, once a mistake **recurs across tasks**, injects a deterministic "learned caution" into the prompt (e.g. *"verify a symbol exists before `edit_symbol`"*) so it stops repeating it. One-offs never teach; see `qodex skill lessons`.
6. **Episodic memory** — with `learning.episodicMemory.enabled`, QodeX records a lean episode after each successful task and, at the start of a new one, recalls **similar past tasks on this project** and injects a one-line reminder of what worked — so it reuses its own approach instead of rediscovering it. Retrieval is **smart, not noisy**: an unrelated task recalls nothing, and the top-K are selected for **relevance *and* diversity** (MMR — so a recurring task doesn't inject K copies of itself), **grounded** against the current tree (episodes pointing at files that no longer exist are demoted, like the skill-judge's codebase-fit), with a **recency tie-break** toward your more recent solution.

QodeX also **auto-matches your code style** (indentation, quotes, semicolons, naming — inferred from the project + `.editorconfig`) so generated code blends in without you having to spell it out. Off via `context.styleProfile: false`.

```yaml
# ~/.qodex/config.yaml — opt in
learning:
  enabled: true                     # capture candidates after successful tasks
  minToolCalls: 5                   # how substantial a task must be to capture
  judgeModel: llama-3.3-70b-versatile   # the INDEPENDENT judge (must differ from defaults.model)
  autoPromoteMinConfidence: 50      # hold lower-confidence captures for human review
  autoEval: false                   # run `skill eval` automatically after each capture
  failureLessons:
    enabled: true                   # learn from RECURRING tool failures
  episodicMemory:
    enabled: true                   # recall similar past tasks and reuse what worked
    topK: 2                         # how many past episodes to inject
    diversity: 0.3                  # 0–1: keep the top-K distinct, not K clones of one task
```

**A worked example.** With `learning.enabled` + an independent `judgeModel`, a typical loop:

```text
> add cursor pagination to the /orders endpoint        # you give a task
… QodeX edits, type-checks, tests, and the sandbox merges (objective success) …
🎓 Captured candidate skill "add-cursor-pagination" (confidence 82/100)
🧪 Auto-eval of "add-cursor-pagination": pass            # (if learning.autoEval)

$ qodex skill candidates        # review the quarantined capture
$ qodex skill curate            # an INDEPENDENT judge promotes/merges the good ones
$ qodex skill stats             # captured 3 · promoted 2 · promotion rate 67%

# next week, a similar task:
> add pagination to the /users endpoint
# → QodeX recalls the past episode + loads the promoted skill automatically.
```

```bash
qodex skill candidates          # list quarantined captures (with confidence)
qodex skill curate              # independent judge merges + promotes the good ones
qodex skill eval <name>         # replay the skill in a clean worktree + real verify → pass/fail
qodex skill promote <name>      # promote one yourself (you are the independent reviewer)
qodex skill reject <name>       # discard a candidate
qodex skill stats               # learning metrics: captured / promoted / merged, promotion rate, avg confidence
qodex skill lessons             # cautions learned from your recurring failures
qodex skill snapshots           # rollback points;  qodex skill restore <archive>  to roll back
```

> Every successful task can also be exported as a **ShareGPT JSONL** corpus (`flywheel.datasetExport: true` → `~/.qodex/dataset/`) — a ready-to-use dataset for a future zero-cost local fine-tune. Strictly local; nothing is uploaded.

### Skill versioning & A/B testing (UCB1)

A skill keeps its whole history in **one flat directory** — `manifest.json` + `SKILL.v1.md`, `SKILL.v2.md`, … — no symlinks, identical on every OS. When a new candidate is captured for an existing skill it becomes a **challenger** to the stable **champion**, and QodeX routes traffic between them with the **UCB1 adaptive bandit** instead of a fixed split: it explores the challenger enough to get signal, then favours whichever has the higher score — and a challenger that turns out worse has its traffic driven to **zero automatically**.

The score is a **composite reward**, not just win-rate: *success* dominates, but *token-* and *time-efficiency* (normalized **relative to the champion**) break ties — so between two equally-correct versions, the **cheaper, faster** one wins.

```yaml
learning:
  versioning:
    strategy: ucb1                 # or 'champion-only' to freeze a sensitive skill (UCB off)
    ucbExplorationFactor: 1.41     # √2 — higher explores challengers more
    minChallengerTrials: 5         # force a challenger ≥5 runs before judging it
    rewardWeights: { success: 0.7, token: 0.15, time: 0.15 }
```

```text
$ qodex skill versions git-commit-expert
Skill "git-commit-expert"  ·  strategy: ucb1  ·  routed this turn → v2

  v1  [human]   ★ champion
      success: 88% over 40  ·  tokens: 60000  ·  1900ms/run  ·  confidence: 75
      UCB: reward 0.838 + bonus 0.214 = 1.052
  v2  [machine] ⚡ challenger
      success: 92% over 12  ·  tokens: 41000  ·  1300ms/run  ·  confidence: 60
      UCB: reward 0.921 + bonus 0.391 = 1.312     ← higher → gets this turn

$ qodex skill rollback git-commit-expert v1     # snap the champion back to v1 anytime
```

## Memory & continuity

Most CLI agents are amnesiac — every session starts from a blank slate and you re-explain the same things. QodeX **remembers**, across five layers that each answer a different question, so a model on *your* machine accumulates real context about you and your codebase over time:

| Layer | Answers | Where it lives | Author |
|---|---|---|---|
| **Curated rules** | "What are the rules here?" | `QODEX.md` in the repo + `~/.qodex/QODEX.md` (global) | **you** — version-controlled, authoritative |
| **Learned facts** | "What did I learn about this codebase / this user?" | `session_facts` in `~/.qodex/sessions.db`, scoped `project` (per-cwd) or `user` (global) | the **agent**, mid-task |
| **Project worklog** | "What's been done here lately?" | `project_worklog` (per-cwd) | the agent + `/project log` |
| **Episodic memory** | "How did I solve a task like this before?" | `~/.qodex/episodes/*.jsonl` | the agent, after a *verified* success |
| **Sessions** | "Pick up exactly where we left off." | `sessions` + `messages` in `sessions.db` | every turn — `/resume <id>` |

The split is **deliberate**: *your* curated rules (`QODEX.md`, git-tracked) stay separate from the *agent's* auto-learned scratchpad (the DB) — no machine write ever touches your authoritative file, and there are no merge conflicts. Facts are **scoped** — a `project` fact (a build command, a gotcha) is auto-injected only when you start in that directory; a `user` fact (*"prefers Persian comments"*, *"always run tests before saying done"*) follows you into **every** project. Recall is smart, not heavy: episodic memory injects only relevant, **de-duplicated** past tasks above a threshold (an unrelated task recalls nothing) — a one-line reminder, never a full transcript.

**A Markdown mirror you can read, edit, and git-commit.** `/memory export` writes the agent's learned facts to a human-readable `MEMORY.md` (project) and `~/.qodex/memory.md` (user). Edit them by hand — fix a wrong fact, add three — and `/memory import` folds your changes back into the DB (additive). The DB stays the source of truth; the Markdown is the window into it.

**Light Memory Mode for small context windows.** On a roomy model, every fact is injected (`memory.mode: full`). On a tight local model, set `memory.mode: lightweight` (or `auto`) — QodeX injects your `!important`-tagged facts plus as many recent ones as fit a token budget, and leaves the rest to load on demand. Your memory doesn't shrink; only what's *pushed into each prompt* does.

**Searchable memory (FTS5).** As facts pile up, dumping the newest N isn't enough — `recall query="deploy key"` does a **relevance-ranked full-text search** (SQLite FTS5) over your facts and pulls out the specific one, so the agent finds an old gotcha instead of rediscovering it. This is the on-demand half of Light Memory Mode: lightweight mode keeps prompts small, and search retrieves anything it left out. The index stays in sync automatically and falls back to a substring scan if a build lacks FTS5.

```text
> the build here is `npm run build:prod`, not `npm run build`
🧠 remembered (project)              # silently re-injected next time you start in this dir

/memory                              # show what's stored for this project
/memory export                       # write the human-readable MEMORY.md mirror
/memory import                       # pull hand-edited facts from the markdown back in
/memory forget <substring>          # drop matching facts
/project        ·  /project log <e>  # this project's worklog (view · append)
/sessions       ·  /resume <id>      # list past sessions · rehydrate one
```

```yaml
# ~/.qodex/config.yaml — tune what gets pushed into each prompt (DB + mirror are unaffected)
memory:
  mode: auto              # full | lightweight | auto (lightweight on small context windows)
  injectMaxTokens: 2000   # budget for facts in lightweight mode (!important always included)
```

It all lives under `~/.qodex/` — **nothing is uploaded**, the same privacy line as your code.

## Install

### One line (macOS · Linux · WSL)

```bash
curl -fsSL https://raw.githubusercontent.com/QodeXcli/QodeX/main/install.sh | bash
```

Checks for **git + Node 20+** (installs Node via your package manager if it's missing or too old), clones QodeX to `~/.qodex-src`, builds it, and puts `qodex` and `qx` on your PATH. **Idempotent** — re-run it to update. Knobs: `QODEX_SRC_DIR`, `QODEX_BRANCH`, `QODEX_NO_LINK=1`; preview without touching anything via `QODEX_DRY_RUN=1`.

> Prefer to read before you pipe to `bash`? The script is [`install.sh`](install.sh) in this repo — or follow the manual steps below.

### Manual

**Prerequisites:** **Node 20+** (Node 22 LTS recommended) and **Git**. `dist/` is built locally (not committed), so the `npm run build` step is **required** on every platform. The build links two commands — `qodex` and the short alias `qx`.

### macOS

```bash
# Node + Git via Homebrew (or use nvm). Check: node -v  →  v20+  
brew install node git

git clone https://github.com/QodeXcli/QodeX.git qodex && cd qodex
npm install
npm run build
npm link            # puts `qodex` and `qx` on your PATH
```

### Linux

```bash
# Debian/Ubuntu — get Node 20+ from NodeSource if your distro ships an older one
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
# (Fedora: sudo dnf install nodejs git    ·    Arch: sudo pacman -S nodejs npm git)

git clone https://github.com/QodeXcli/QodeX.git qodex && cd qodex
npm install
npm run build
sudo npm link       # or plain `npm link` if your npm prefix is user-writable
```

### Windows

Open **PowerShell** and install Node + Git (via [winget](https://learn.microsoft.com/windows/package-manager/), or the installers from [nodejs.org](https://nodejs.org) / [git-scm.com](https://git-scm.com)):

```powershell
winget install OpenJS.NodeJS.LTS Git.Git
# reopen PowerShell so PATH refreshes, then:
git clone https://github.com/QodeXcli/QodeX.git qodex; cd qodex
npm install
npm run build
npm link            # `qodex` and `qx` on PATH
```

> **Windows tip:** if the native `better-sqlite3` module fails to compile, install the C/C++ build tools (`npm install --global windows-build-tools`, run PowerShell as Administrator) — or use **WSL2** and follow the **Linux** steps above (recommended for the smoothest experience).

### Optional — browser automation (all platforms)

Playwright-backed Chromium for the `browser_*` tools (~200 MB, one-time):

```bash
npm install playwright
npx playwright install chromium
```

> Then run `qodex setup` to detect your local models and write `~/.qodex/config.yaml`.

## Quick start

```bash
# Setup wizard — detects local models, writes ~/.qodex/config.yaml
qodex setup

# Or just start it
qodex
> read package.json and summarize what this project does
```

## Configuration

Lives in `~/.qodex/config.yaml`. A minimal local-model setup pointed at LM Studio:

```yaml
defaults:
  provider: openai
  model: qwen/qwen3-coder-next
  preferLocal: true

providers:
  ollama:
    baseUrl: http://localhost:11434
  openai:
    apiKeyEnv: OPENAI_API_KEY
    baseUrl: http://127.0.0.1:1234/v1   # point at LM Studio
    extraModels:
      - id: qwen/qwen3-coder-next
        contextWindow: 32768
        supportsToolCalls: true

roles:
  subagent:
    provider: ollama
    model: qwen3-coder      # smaller/faster model for delegated reads

context:
  efficient: false          # set true on weak local models to save tokens

subagents:
  mode: parallel            # off | sequential | parallel
```

Cloud providers are opt-in. Web-search keys are read from the environment, never the config file:

```bash
export TAVILY_API_KEY=tvly-...
export BRAVE_SEARCH_API_KEY=...
export FIRECRAWL_API_KEY=fc-...          # set FIRECRAWL_SCRAPE_CONTENT=1 for inline markdown
```

## Built-in tools

100+ tools across these areas — run `/tools` inside QodeX for the full list with descriptions:

| Area | Examples |
|---|---|
| **Filesystem** | read_file, write_file, edit_text, edit_symbol, multi_edit, multi_file_edit, ls, glob, grep |
| **Shell & code** | bash, code_run |
| **Code graph** | project_overview, analyze_impact, find_callers, find_references, find_dead_code, safe_rename, semantic_search |
| **Diagnostics** | type/lint checkers (tsc, eslint, ruff, pyright, go vet, cargo, php -l) |
| **Git** | status, diff, log, branch, commit, create_pr, release_notes |
| **Web** | web_search (DuckDuckGo / Tavily / Brave / Firecrawl), web_fetch, network_check |
| **Browser** | navigate, click, fill, screenshot, console, evaluate, get_text, wait_for |
| **Dev server / jobs** | dev_server_start/stop/log, background_job_start/status/wait/cancel |
| **Skills** | use_skill, search_skills, install_skill (security-scanned) |
| **Memory** | remember, recall, forget (project/user-scoped, local) |
| **Sub-agents** | task, orchestrate, gather, present_plan, todo_read/write, auto_fix |
| **Vision** | vision_analyze |
| **Domain** | Docker, database, WordPress, media (ffmpeg), frontend/print, OpenAPI |
| **MCP** | connect any MCP server; its tools join the registry |

## Slash commands

```
/help              Overview
/network           Diagnose internet + Ollama + LM Studio connectivity
/tools [--all]     List registered tools by category
/plan  /normal     Plan mode (read-only)  /  back to normal
/auto on|off       Auto-approve permissions
/model <id>        Override model for this conversation
/subagents off|sequential|parallel
/snapshot list|take|restore        Manage auto-snapshots
/cost  /tokens     Token / cost usage
/index [--force]   Build/refresh the code graph
/mcp               List connected MCP servers
/memory [export|import|forget <s>|clear]   Learned facts — show · mirror to MEMORY.md · import edits · drop · wipe
/project [log <e>] This project's worklog — view, or append an entry
/sessions  /resume <id>  /clear  /exit
```

Plus any custom commands you drop in `.qodex/commands/` as markdown.

## End-to-end example

```
> add a logout button to the navbar in src/Header.tsx and verify it works
```

QodeX will: read `Header.tsx` → add the button (shown as an approvable diff) → `dev_server_start npm run dev` → `browser_navigate` localhost → click the button → check the console for errors → screenshot → `vision_analyze` to confirm it looks right → run the type-checker on the touched file → stop the server and report. One agent loop, with the guardrails above running throughout.

## Telegram / Discord / Slack bot

Drive the same agent from chat — stream tasks to QodeX from your phone:

```bash
# 1. put the token(s) in ~/.qodex/.env (secrets never go in config)
echo 'TELEGRAM_BOT_TOKEN=123:abc' >> ~/.qodex/.env
#   Slack uses Socket Mode (no public URL needed) and TWO tokens:
#   echo 'SLACK_APP_TOKEN=xapp-...' >> ~/.qodex/.env
#   echo 'SLACK_BOT_TOKEN=xoxb-...' >> ~/.qodex/.env

# 2. enable the platform + allowlist your user id (deny-by-default) in config
#    bot:
#      telegram: { enabled: true, allowedUsers: ["<your-telegram-id>"] }
#      discord:  { enabled: true, allowedUsers: ["<your-discord-id>"] }   # needs: npm i discord.js
#      slack:    { enabled: true, allowedUsers: ["<your-slack-user-id>"] } # needs: npm i @slack/socket-mode @slack/web-api

# 3. run it from the project directory you want it to work in
qodex bot                 # all enabled platforms · --telegram / --discord / --slack to pick one
```

One transport-agnostic gateway does all the work; the platform adapters are thin — **Telegram** needs zero installs, **Discord** and **Slack** are optional lazy-loaded deps. Adding a platform is one adapter implementing the same `Transport` seam, so behaviour never drifts between them.

**Talk to it — voice memos.** Send a Telegram voice message and QodeX transcribes it and runs it as your turn (it echoes `🎙️ "…"` so you can see what it heard). Local-first, like web-search and vision: point `QODEX_TRANSCRIBE_CMD` at any local STT (whisper.cpp, faster-whisper, a script — `{file}` is the audio path, STDOUT is the transcript) for a fully-offline path, or set `OPENAI_API_KEY` for the cloud fallback. Neither configured ⇒ a friendly "just type" note, never a crash. The bug-classes that wreck chat-agent UIs are each solved once: **throttled, coalesced streaming** with code-fence-aware spill across messages (no edit-flood / no sheared code blocks), **one turn per chat at a time** (later messages queue — no interleaving), **permission prompts as inline buttons** (tap or reply), and **deny-by-default auth** (a coding agent runs shell on your host, so an empty allowlist admits no one; `"*"` opts into public access deliberately).

**Full agent control from your phone.** Commands live in one declarative registry, so every command is also pushed to the client as a **native `/` menu** (tap-to-pick, with descriptions) — no memorizing:

| Command | What it does |
|---|---|
| `/help` | every command, generated from the registry |
| `/new` | fresh conversation (new session) |
| `/stop` | abort the running task |
| `/status` | running/queued · model · project · session · auto state |
| `/auto on \| off` | auto-approve actions (skip the buttons) — handy on mobile, off by default |
| `/model [id]` | show or switch the model for this conversation |
| `/sessions` · `/resume <id>` | list past sessions and continue one (same store as the CLI) |
| `/episodes` | past tasks solved here, from episodic memory |
| `/impact <symbol>` · `/rename <old> <new>` | code-graph shortcuts — blast-radius of a symbol · AST-safe rename (with approval) |

Adding a command is **one entry** — Telegram, Discord, and Slack all gain the command, its menu item, and its `/help` line. Capabilities a given build doesn't support degrade to a friendly note, never a crash.

**Living Artifacts in chat — with an AI vision review.** Ask for a dashboard, a landing page, or a chart from your phone and QodeX doesn't dump code at you — it builds a **versioned artifact**, renders it, and (for web types) runs a **vision self-review** that actually *looks* at the result and verdicts it **LOOKS_GOOD / NEEDS_WORK / BROKEN**, listing concrete issues. You get back a compact **card**:

```text
📊  Sales dashboard  ·  html · v3
🔎  vision review: NEEDS_WORK
    • legend overlaps the Q4 bars
    • contrast too low on the dark header
[ ✅ Approve ]   [ ✏️ Edit ]   [ ❌ Reject ]   [ 🔗 Open live ]
```

Tap **Edit** and reply with the change in plain language; tap **Open live** for the hot-reloading, token-protected https link. The agent iterates create → preview → review → fix until the vision check passes — the same loop the CLI runs, now driven from chat.

## Scheduled & autonomous — the real "24/7"

Plenty of agents *say* "autonomous 24/7." QodeX has a plain, boring scheduler that actually does it — and, crucially, **runs every unattended job through the same guardrails as an interactive one**, so leaving it running can't quietly ship broken code.

A built-in cron (5-field expressions + `@daily`/`@hourly`/… aliases) installs as a **macOS LaunchAgent** or a **Linux crontab** line, ticks every minute, and runs each due task as an **isolated headless process** (file-locked, 30-min hard cap, per-run logs under `~/.qodex/schedule-logs/`).

```bash
qodex schedule install                       # macOS launchd / Linux crontab — runs the tick every minute
qodex schedule add --name nightly-deps \
  --cron "@daily" \
  --prompt "check for outdated deps and summarize what changed" \
  --deliver telegram:<your-chat-id>          # result lands on your phone, not just a desktop ping
qodex schedule list      ·  runs <id>  ·  enable/disable <id>  ·  rm <id>
```

**Deliver results to chat.** `--deliver telegram:<chatId>` (or `discord:<channelId>` / `slack:<channelId>`) posts each run's outcome to your phone — the scheduler talks to the platform REST API directly, so it needs no running bot. A recipe's verdict line leads the message.

**Autonomous *Verified* PR — the differentiator.** `--recipe verified-pr` doesn't just run a prompt; it wraps your goal in an unattended-safe **protocol**:

> work on a fresh **sandbox branch** → make the change → **run the tests + per-language verifiers** → and **open a PR only if verification actually passed**. If it fails, it opens *nothing*, claims *nothing*, and reports exactly what broke.

```bash
qodex schedule add --name nightly-flaky-fix \
  --cron "0 3 * * *" \
  --recipe verified-pr \
  --prompt "find and fix flaky tests in this repo" \
  --deliver telegram:<your-chat-id>
# 3am: works on a branch, verifies, and either DMs you "VERIFIED-PR: opened <url>"
#      for your morning review — or "VERIFIED-PR: blocked — <reason>". Never a false green.
```

That's the honest version of an always-on agent: it works while you sleep, but the completion gate, auto-verification, and git sandbox run too — so what reaches you is a PR you can trust, not a confident lie.

## Architecture notes

- **One agent loop** with per-task budget caps (tokens / cost / wall-clock / iterations), a consecutive-failure circuit breaker, and auto-recovery.
- **Capability-tiered system prompt** — frontier models get a compressed prompt; weak/local models keep the full guidance they depend on (cache-safe per session).
- **Per-tool permissions** — read-only tools auto-approved; mutating tools ask once; "allow once / session / pattern / always" picker.
- **Code-graph index** — Tree-sitter-backed, persists to `.qodex/codegraph.db`, incremental.
- **Persistent memory** — sessions, messages, scoped (project/user) facts, and a per-project worklog in `~/.qodex/sessions.db`; episodic task-memory in `~/.qodex/episodes/`; curated rules in `QODEX.md`; a human-readable **Markdown mirror** (`/memory export|import`) and a budget-aware **Light Memory Mode** over the same store. All local, all under `~/.qodex/`.
- **Chat gateway** — one transport-agnostic bot core (Telegram / Discord / Slack adapters are thin) with throttled streaming, one-turn-per-chat queueing, inline-button approvals, deny-by-default auth, and **Living Artifact cards** with vision review.
- **Multi-provider router** — Ollama, LM Studio, Anthropic, OpenAI, Gemini, DeepSeek, OpenRouter all first-class.
- **ESM strict** throughout; **hooks** (pre/post-tool) for guardrails or instrumentation.

## Why local-first

- **No data leaves your machine** when running Ollama / LM Studio — useful for proprietary codebases.
- **Faster iteration** — no network latency per tool call.
- **Works offline** — `/network` tells you what's reachable.
- **$0 to run** if you have the hardware; cloud providers are opt-in per role (e.g. sub-agents on Claude, vision on GPT).

## Status

Active development. The built-in tool set and the guardrail layer are stable; expect more MCP integrations and permission-UX polish. Issues and PRs welcome.

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

Copyright 2026 7 SEVEN.
