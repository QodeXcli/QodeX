# Adopting `maintain` on your project

*A field guide: what to run first, what to expect, and real results from a real open-source repo.*

`maintain` is QodeX's self-improving codebase loop: every night it finds **one** provable
improvement, verifies it, and opens a **PR you can trust** — or ships nothing and tells you why
(see [MAINTAIN.md](MAINTAIN.md) for how the protocol works). This guide is about *adopting* it:
the 10-minute setup, the recommended rollout ladder, and what it actually did on a real codebase.

## The 10-minute setup

```bash
# 1. Install QodeX + the scheduler tick (macOS launchd / Linux crontab)
curl -fsSL https://qodexcli.github.io/install.sh | bash
qodex schedule install

# 2. See what maintain WOULD clean — read-only, no model, no edits
qodex dashboard          # → "🔍 Run maintain now (preview)" button
# (or schedule a --dry-run first; it always blocks and just lists candidates)

# 3. Schedule the safest scope, delivered to your phone
qodex schedule add --name nightly-tidy \
  --cron "0 4 * * *" \
  --recipe maintain \
  --prompt "unused-imports" \
  --deliver telegram:<your-chat-id>
```

Every run ends in one of exactly two messages — `VERIFIED-PR: opened <url>` (tests + types
actually passed) or `VERIFIED-PR: blocked — <reason>` (it proved nothing safe to do). Review the
PR over coffee; maintain never merges its own work.

## Case study — a real open-source repo (QodeX itself)

We run maintain on this repository. These are merged PRs and real receipts, not a mockup —
click through and audit them:

| Run | Scope | Outcome |
|---|---|---|
| [PR #62](https://github.com/QodeXcli/QodeX/pull/62) | `unused-imports` | **6 unused imports removed** across the codebase, `tsc` + full test suite green, opened as a verified PR |
| [PR #64](https://github.com/QodeXcli/QodeX/pull/64) | `unused-locals` | **4 unused consts removed** — and, more importantly, **6 candidates BLOCKED** by the side-effect gate (their initializers contained calls/`await`, so deleting them could change behavior). The guardrail declined work no one was watching. |
| full `--dry-run` | all detection | Inventory of **37 unused symbols** (21 imports, 10 locals, 6 params) with the hotspot (`src/tools/`, 16 of them) — used to decide which scopes to schedule |
| `find_similar_helpers` | near-dupe detection | Found a **real 4-copy cluster**: `walkSource`×3 + `walkFiles`, ~94% similar, ~81 collapsible lines — surfaced for review (read-only; merging near-dupes changes call sites) |

The #64 row is the one to internalize: **blocked runs are the product working**, not failing.
A 3am "improvement" that changes behavior is worse than no improvement, so maintain proves
safety or declines — and the receipt records which one happened.

## Recommended rollout ladder

Adopt one rung at a time; each rung is strictly riskier than the previous. Stay on a rung until
you've reviewed a few of its PRs and trust it.

1. **`--dry-run` / dashboard preview** — see the candidate list, change nothing.
2. **`unused-imports`** — the safest edit that exists (zero-reference bindings; never side-effect imports).
3. **`dead-code`** — one provably-unreferenced item per night (code-graph proof or it blocks).
4. **`unused-locals` + `unused-params`** — the side-effect gate and the `_`-prefix rule do the caution for you.
5. **`lint-fix`** — the linter's autofixable rules, bounded to a focus dir (`--prompt "lint-fix src/api"`).
6. **`dep-bump`** — one patch/minor bump, shipped only if your **full test suite** passes. Blocks if you have no tests — a dep bump without tests is unverifiable, and maintain refuses unverifiable work.
7. **`consolidate-dupes`** — merges one *exact*-duplicate helper pair by repointing callers (every caller resolved via the code graph, or it blocks).

Monorepo / big repo? Add a focus path to any scope: `--prompt "unused-imports packages/core/"`.

## Watching it work

- **Dashboard** (`qodex dashboard`) — the *Maintain status* panel: success/block rates, files
  cleaned, per-scope breakdown, 8-week trend, next-week forecast, and a suggested next scope
  with a one-click "Schedule it".
- **CLI report** — `qodex maintain-report` for the same numbers in your terminal.
- **Portable history** — `qodex maintain-export -o history.json` / `maintain-import --merge`
  to archive or move the record between machines.

## For teams: the audit trail

Every run's receipt (what ran, which checks passed, files, PR) chains into a **tamper-evident
audit log** — altering, reordering, or dropping any past entry breaks every downstream hash:

```bash
qodex maintain-audit --sign -o audit.json     # HMAC-signed via QODEX_AUDIT_KEY (env, never stored)
qodex maintain-audit-verify audit.json        # offline verify — exit 1 on tamper → CI-friendly
```

Integrity needs no key at all; the signature adds authenticity (proof a key-holder exported it).

## FAQ

**What if my project has no tests?** Scopes that need a suite (`dep-bump`) block outright.
Detection-based scopes (`unused-imports`, `dead-code`, …) still verify with the language
checkers (`tsc`, `ruff`, `go vet`, …) on every touched file.

**Which languages?** Detection leans on your toolchain (TypeScript/JS via `tsc`/eslint, Python
via ruff, Go via `go vet`/gofmt, …) plus QodeX's Tree-sitter code graph (TS/JS, Python, Rust,
Go, PHP). The verify-or-block protocol is language-agnostic: no checker, no proof → block.

**Can it merge its own PRs?** No. Opening a verified PR is the ceiling of its authority; merging
is yours. (That's also why the morning-review workflow works: everything it did overnight is
sitting in one place, verified, with a receipt.)

**What does it cost?** Detection scopes are mostly toolchain work (fast, cheap even on a local
model). Each run makes one small change, so review time stays near zero.

**How do I show this to my team?** `qodex maintain-demo` (interactive page) ·
`--markdown` (README-ready writeup) · `--pdf` (one-page PDF for the meeting).
