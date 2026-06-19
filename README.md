# QodeX

> **Local-first agentic coding CLI.** Built on Qwen3-Coder + Ollama by default, with Claude/GPT/DeepSeek as optional cloud fallbacks. Designed to match Claude Code's capabilities while running fully offline if you want.

**Current version: 2.1.1** · 100+ built-in tools · Apache-2.0

## What it can do

QodeX drives a real agent loop. Give it a task in natural language (English or Persian), and it can:

- **Read and edit code** — read_file, write_file, edit_text, edit_symbol (AST-aware), multi_edit (single-file sequential), multi_file_edit (atomic across up to 50 files)
- **Search the codebase** — ls, glob, grep, and a code-graph index for symbols / callers / references
- **Run commands** — bash, plus `code_run` for sandboxed Python/Node/TS/PHP/Ruby execution (macOS sandbox-exec where available)
- **Drive a real browser** — Playwright-backed Chromium: navigate, click, fill, screenshot, evaluate JS, read console + page errors. Use to verify your own UI changes.
- **Manage background processes** — `dev_server_start npm run dev`, then `browser_navigate http://localhost:5173`. All in one session.
- **Long-running tasks** — `background_job_start` for async work that shouldn't block the agent loop.
- **Search the web** — DuckDuckGo by default; auto-fallback to Brave / Tavily if you set keys. `web_fetch` for one-shot URL scrape.
- **Vision** — `vision_analyze` sends a screenshot to Claude Haiku / GPT-4o-mini / a local vision model (Qwen-VL via LM Studio).
- **Verify its own work** — `auto_fix` runs your test command, reports pass/fail, tracks iterations, detects same-failure-twice, gives up after N tries.
- **Git** — status, diff, log, branch, commit, create-pr
- **MCP servers** — connect any MCP-compatible tool server
- **Snapshot + restore** — auto git-stash before destructive operations; `/snapshot restore` to roll back
- **Sub-agents** — `task` tool dispatches work to a separate (often smaller/faster) model
- **Custom slash commands** — drop a markdown file in `.qodex/commands/` and `/yourcommand` is wired up

## Install

```bash
git clone https://github.com/batisexpress/QodeX.git qodex && cd qodex
npm install
npm run build
npm link   # makes `qx` and `qodex` available on PATH
```

Optional but recommended:

```bash
# Browser automation (~200MB Chromium download, one-time)
npm install playwright
npx playwright install chromium
```

## Quick start

```bash
# Run the setup wizard (detects local models, writes ~/.qodex/config.yaml)
qodex setup

# Or just start it
qodex
> read package.json and summarize what this project does
```

## Configuration

Lives in `~/.qodex/config.yaml`. Minimum useful config:

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
    model: qwen3-coder      # smaller/faster model for delegated tasks

subagents:
  mode: parallel             # off | sequential | parallel
```

## Built-in tools

| Category | Tools |
|---|---|
| **Filesystem** (9) | read_file, write_file, edit_text, edit_symbol, multi_edit, multi_file_edit, ls, glob, grep |
| **Shell & code** (2) | bash, code_run |
| **Code graph** (7) | find_symbol, search_symbols, list_symbols, find_callers, find_references, explain_symbol, stats |
| **Git** (6) | status, diff, log, branch, commit, create_pr |
| **Web** (4) | web_search, web_fetch, network_check, plus auto-fallback chain |
| **Browser** (9) | navigate, click, fill, screenshot, console, evaluate, get_text, wait_for, close |
| **Dev server** (4) | start, log, stop, list |
| **Background jobs** (6) | start, status, log, wait, list, cancel |
| **Vision** (1) | vision_analyze |
| **Sub-agents** (4) | task, present_plan, todo_read, todo_write, auto_fix |

Run `/tools` inside QodeX to see the full list with descriptions.

## Slash commands

```
/help                          Show this overview
/network                       Diagnose internet + Ollama + LM Studio connectivity
/tools [--all]                 List all registered tools by category
/plan                          Plan mode (read-only)
/normal                        Back to normal mode
/auto on|off                   Auto-approve all permissions
/model <id>                    Override model for this conversation
/subagents off|sequential|parallel  Configure sub-agent dispatch
/subagent-model <id>|clear     Pin a different model for sub-agents
/roles                         Show role → model assignments
/snapshot list|on|off|take|restore  Manage auto-snapshots
/caching on|off                Toggle Anthropic prompt caching
/cost                          Token / cost usage
/tokens                        Per-turn breakdown
/todos                         Current todo list
/index [--force]               Build/refresh code graph
/mcp                           List connected MCP servers
/sessions                      Past sessions
/resume <id>                   Resume a session
/clear                         Clear conversation
/exit                          Quit
```

Plus any custom slash commands you've added in `.qodex/commands/`.

## End-to-end example

```
> add a logout button to the navbar in src/Header.tsx and verify it works
```

QodeX will:
1. `read_file` Header.tsx — understand structure
2. `edit_text` — add the button + onClick handler
3. `dev_server_start name=app command="npm run dev"`
4. `browser_navigate http://localhost:5173`
5. `browser_click selector="button.logout"`
6. `browser_console` — check for JS errors
7. `browser_screenshot` — save PNG
8. `vision_analyze` — confirm the button looks right
9. Stop the dev server, report back

All in one agent loop, no human-in-the-loop needed (unless permission system asks).

## Architecture notes

- **ESM strict mode** throughout — no `require()`, all imports static or `await import()`
- **One agent loop** with budget tracking, consecutive-failure circuit breaker, auto-recovery
- **Per-tool permissions** — read-only tools auto-approved; mutating tools ask the first time; gradient picker for "allow once / session / pattern / always for this tool"
- **Snapshot service** — git stash before any destructive operation; one command to restore
- **Code graph index** — Tree-sitter-backed, persists to `.qodex/codegraph.db`, incremental updates
- **Multi-provider model router** — Ollama, LM Studio, Anthropic, OpenAI, DeepSeek all first-class
- **MCP integration** — connect to any MCP server; tools appear in the same registry as built-ins
- **Hooks** — pre/post tool hooks for guardrails or instrumentation (defined in YAML)

## Why local-first

- **No data leaves your machine** when running Ollama / LM Studio. Useful for proprietary codebases.
- **Faster iteration** — no network latency per tool call.
- **Works offline** — `/network` will warn you what's reachable.
- **Costs $0** to run if you have the hardware. Cloud providers are opt-in for specific roles (e.g. sub-agents on Claude, vision on GPT-4o).

## Status

Pre-1.0. APIs may change. Built-in tool set is stable; expect new MCP integrations + better permission UX in v1.0.

## License

Apache-2.0


---

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

Copyright 2026 7 SEVEN.
