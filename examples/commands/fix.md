---
description: Run linter and fix issues in the given file
argument-hint: <file-path>
allowed-tools: [read_file, edit_file, multi_edit, bash, code_graph_find_symbol]
---
Please fix any lint errors in `{{ARGUMENTS}}`.

Steps:
1. Read the file to understand its structure
2. Run the project's linter on this file (detect from package.json / pyproject.toml etc.)
3. Make minimal, focused edits to fix each issue
4. After fixing, re-run the linter to confirm it's clean
5. Report what you changed

Do not refactor anything that isn't a lint issue.
