---
description: Generate user-facing release notes from a git range and (optionally) update CHANGELOG.md
argument-hint: [<from>..<to>] [--write] [--bump=patch|minor|major]
allowed-tools: [generate_release_notes, git_log, git_diff, read_file, write_file, bash]
---
You are producing release notes for this repo. Arguments: `{{ARGUMENTS}}`.

Parse the arguments:
- If they look like a git range (`a..b`), pass `from` and `to`.
- If they contain `--write`, set `write_to_changelog: true`.
- If they contain `--bump=<kind>`, set `bump` to that kind.
- Default scope is `user` unless `--all` appears (then `all`).
- Default `to=HEAD`. If `from` is omitted, the tool auto-detects the latest tag.

Steps:
1. Call `generate_release_notes` with the parsed args, `format: "markdown"`.
2. Read the structured output. If anything looks miscategorized (e.g. a `chore:` that is actually user-facing), explain that to me; do not silently re-bucket.
3. Rewrite the bullet points in the model's own voice — keep them short, user-readable, and grouped by category. Preserve the SHA references. Don't invent items that aren't in the commit list.
4. If `--write` was passed, the tool has already prepended to CHANGELOG.md. Show me the final markdown anyway.
5. If a `--bump` was passed, mention the version change in your reply.

If the repo has no commits in range, say so plainly and stop — do not fabricate a changelog.
