# QodeX — the local-first LLM agent & coding CLI agent

> **QodeX is an open-source LLM agent for your terminal — a local-first, agentic coding CLI.** It runs on local models (Qwen3-Coder via Ollama / LM Studio) by default, with Claude / GPT / Gemini / DeepSeek as optional cloud fallbacks. A privacy-first AI coding agent built so a model on *your* machine does real, multi-step engineering work — fully offline if you want.

> If you're looking for an **LLM agent**, a **CLI agent**, an **AI coding agent**, or an **autonomous terminal agent** that doesn't ship your code to someone else's cloud — that's QodeX.

**Version 2.4.0** · 100+ built-in tools · English & Persian · Apache-2.0

[![CI](https://github.com/QodeXcli/QodeX/actions/workflows/ci.yml/badge.svg)](https://github.com/QodeXcli/QodeX/actions/workflows/ci.yml)

---

## Highlights

- **Local-first & private** — runs entirely on *your* models (Qwen-Coder via Ollama / LM Studio); your code never leaves the machine. Claude / GPT / Gemini / DeepSeek are opt-in cloud fallbacks.
- **Guardrails around the model, not just prompts** — a syntax gate, completion gate, and per-language auto-verification run *around* the agent loop, so even a weak local model can't ship broken or unverified code.
- **Self-learning skills (safe by design)** — QodeX captures the winning approach from an *objectively-successful* task as a quarantined skill; only an **independent judge model** can promote it, and it **never overwrites a human-written skill**.
- **Live, shareable artifacts** — build a page / React app / dashboard that **hot-reloads on every edit and auto-opens in your browser**; share it over your LAN or a private, token-protected https tunnel.
- **Design integrations** — drive **Figma** (3 ways) and **Canva** straight from the terminal over MCP.
- **100+ built-in tools** — Tree-sitter code-graph, real Playwright browser automation, dev-servers, web search, vision, Docker / DB / WordPress, and any MCP server.
- **Persian-first** — prompts, skill matching, *and* generated artifact copy follow your chat language, not a fixed default.
- **Token-efficient** — sub-agent delegation, result-aging, compaction, and tool-gating keep the working context small on long sessions.

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
- **Domain tools** — Docker, databases, WordPress (`php -l` linting), media (ffmpeg), frontend/print, OpenAPI digest, and more.

## Self-learning skills

QodeX can **learn reusable playbooks from your successful tasks** — without the usual failure mode of an agent rubber-stamping its own work and overwriting your hand-tuned skills. The whole loop is **off by default** and gated on *objective* signals, not the model's self-grade.

**How it works:**

1. **Capture** — when a task finishes in the git sandbox and *objectively* succeeds (it compiled / type-checked, the completion-claim gate passed, and it took at least a few tool calls and changed a file), QodeX distills the winning approach into a `SKILL.md` and assigns it a **confidence score (0–100)** from those objective signals.
2. **Quarantine** — the new skill is written to `~/.qodex/skills-candidates/` (a dir QodeX never auto-loads), stamped `provenance: machine`, `status: candidate`. It can't affect the model until promoted.
3. **Independent review** — `qodex skill curate` runs an **independent judge model** (a *different* model from the one that did the work — a self-grade is refused) against a fixed rubric (reusable / correct / specific / non-redundant). Near-duplicate candidates are **merged** into one. It **never overwrites a human-authored skill**, and snapshots the skills dir (`tar.gz`) before any change so you can roll back.
4. **Auto-evaluation** — `qodex skill eval <name>` (or `learning.autoEval` to run it right after capture) **replays the skill's original task in a throwaway git worktree** and runs the **real** verifier (`tsc`/`ruff`/…) on the code it produces, recording **pass / fail / inconclusive** into the skill. It tests whether the skill actually *works*, not just whether a judge likes it. Content-hash cached.
5. **Learning from failures** — with `learning.failureLessons.enabled`, QodeX records tool failures and, once a mistake **recurs across tasks**, injects a deterministic "learned caution" into the prompt (e.g. *"verify a symbol exists before `edit_symbol`"*) so it stops repeating it. One-offs never teach; see `qodex skill lessons`.

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

## Install

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
/sessions  /resume <id>  /clear  /exit
```

Plus any custom commands you drop in `.qodex/commands/` as markdown.

## End-to-end example

```
> add a logout button to the navbar in src/Header.tsx and verify it works
```

QodeX will: read `Header.tsx` → add the button (shown as an approvable diff) → `dev_server_start npm run dev` → `browser_navigate` localhost → click the button → check the console for errors → screenshot → `vision_analyze` to confirm it looks right → run the type-checker on the touched file → stop the server and report. One agent loop, with the guardrails above running throughout.

## Architecture notes

- **One agent loop** with per-task budget caps (tokens / cost / wall-clock / iterations), a consecutive-failure circuit breaker, and auto-recovery.
- **Capability-tiered system prompt** — frontier models get a compressed prompt; weak/local models keep the full guidance they depend on (cache-safe per session).
- **Per-tool permissions** — read-only tools auto-approved; mutating tools ask once; "allow once / session / pattern / always" picker.
- **Code-graph index** — Tree-sitter-backed, persists to `.qodex/codegraph.db`, incremental.
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
