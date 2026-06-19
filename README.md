# QodeX

> **Local-first agentic coding CLI.** Runs on local models (Qwen3-Coder via Ollama / LM Studio) by default, with Claude / GPT / Gemini / DeepSeek as optional cloud fallbacks. A local-first take on the agentic coding assistant — built so a model running on *your* machine can do real, multi-step engineering work, fully offline if you want.

**Version 2.2.0** · 100+ built-in tools · English & Persian · Apache-2.0

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
- **Vision** — `vision_analyze` sends a screenshot to a local vision model (Qwen-VL) or Claude / GPT.
- **Verify its own work** — `auto_fix` runs your test command in a fix→test loop with an iteration cap and same-failure-twice detection.
- **Git** — status, diff, log, branch, commit, create-pr, release-notes.
- **Skills** — install from a curated registry or any GitHub repo (single / multi / catalog), security-scanned on the way in; `search_skills` to find them.
- **Sub-agents & orchestration** — `task` delegates to a separate model/window; `orchestrate` runs a DAG of sub-agents; `gather` fans out reads in parallel.
- **MCP** — connect any MCP-compatible server; its tools join the same registry as built-ins.
- **Domain tools** — Docker, databases, WordPress (`php -l` linting), media (ffmpeg), frontend/print, OpenAPI digest, and more.

## Install

> Requires **Node 20+**. `dist/` is built locally (not committed) — the `npm run build` step is **required**.

```bash
git clone https://github.com/QodeXcli/QodeX.git qodex && cd qodex
npm install
npm run build
npm link   # makes `qodex` and `qx` available on PATH
```

Optional but recommended (browser automation, ~200 MB one-time):

```bash
npm install playwright
npx playwright install chromium
```

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
