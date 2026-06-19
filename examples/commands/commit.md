---
description: Stage changes and write a conventional-commits message
argument-hint: <optional-scope>
allowed-tools: [bash]
---
Create a git commit for the currently-staged-and-unstaged changes.

Process:
1. Run `git status --short` and `git diff --stat` to see what's changed
2. Run `git diff` (with --cached if anything is staged) to read the actual change content
3. Pick a Conventional Commits prefix (feat / fix / refactor / docs / chore / test)
4. If `{{ARGUMENTS}}` is provided, use it as the scope: `feat({{ARGUMENTS}}): ...`
5. Write a one-line subject + a body if non-trivial
6. Run `git add -u` if nothing is staged, then `git commit -m '...'`

Do NOT push. Do NOT create branches. If the diff includes secrets or credentials, ABORT
and tell me what you saw instead.
