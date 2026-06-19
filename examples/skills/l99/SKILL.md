---
name: l99
description: L99 — maximum-effort mode. Use ALL available tools, run heavy analysis, verify exhaustively, write tests, run them, screenshot, audit, and self-critique. Slow but thorough. Load when the user says "go all-in", "L99", "best effort", or for production-critical tasks.
version: 0.1.0
author: QodeX
triggers:
  - l99
  - level 99
  - all in
  - max effort
  - best effort
  - تمام عیار
slash-aliases:
  - l99
  - allin
allowed-tools:
  - read_file
  - write_file
  - edit_text
  - edit_symbol
  - multi_edit
  - multi_file_edit
  - ls
  - glob
  - grep
  - bash
  - code_run
  - project_overview
  - analyze_impact
  - find_dead_code
  - safe_rename
  - safe_delete_file
  - review_my_changes
  - smart_diff
  - code_graph_find_symbol
  - code_graph_find_callers
  - code_graph_find_references
  - code_graph_explain_symbol
  - semantic_search
  - explain_codebase
  - suggest_improvements
  - design_audit
  - browser_navigate
  - browser_screenshot
  - browser_console
  - browser_evaluate
  - git_status
  - git_diff
  - git_log
  - auto_fix
  - task
  - todo_write
  - todo_read
  - present_plan
---
# L99 — Level 99 / Max-Effort Mode

The user has authorized maximum-effort work. Trade speed for quality.
Allow yourself 3-5× the usual tool calls. Skip nothing.

## Required phases (do all of them)

### 0. Plan
Use `present_plan` for any work spanning > 2 files. List every file you'll touch.
For multi-step work, also write a `todo_write` list — keeps the agent honest.

### 1. Understand
- `project_overview` — map the codebase.
- `analyze_impact` for every primary target → know the blast radius.
- `code_graph_find_callers` for every function you'll modify.
- `semantic_search` for the concept (catches code you'd miss by name).

### 2. Implement
- Use `edit_symbol` over `edit_text` when the target is a named entity.
- After each batch of edits, run the related tests/lints with `bash`.
- For UI changes, start a dev server (`browser_navigate` + `browser_screenshot`) and verify visually.

### 3. Verify
- `auto_fix` — formatter + linter + typecheck.
- Run the project's tests (`bash npm test` or equivalent). Don't skip flakies — quote them in your summary.
- `design_audit` for any UI change.
- `smart_diff` to review your own changes.
- `review_my_changes` — self-critique.

### 4. Document
- Update the README/CHANGELOG ONLY if the user is shipping (look at conventions).
- Write a clear, single-line commit message ready to paste. Don't commit unless asked.

### 5. Hand off
- Summarize what changed in 5-10 lines.
- List anything you couldn't verify (and why).
- Suggest the next 1-2 follow-ups — at L99 the user wants the full picture.

## Delegation
- Use the `task` tool aggressively. Independent analyses → parallel sub-agents (`background_job_start kind=subagent`).
- For visual checks, spawn a `task({role: "vision"})` sub-agent so your context doesn't fill with screenshot bytes.

## Discipline
- Don't skip verification because it's slow. L99 = "ship-ready, audited, screenshotted".
- If a tool returns a surprising result, OBSERVE then re-plan — don't power through.
- If you can't verify a piece of the change, **say so explicitly**. L99 forbids silent assumptions.
