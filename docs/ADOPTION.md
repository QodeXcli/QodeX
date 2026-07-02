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

## External case studies — three popular OSS repos

We pointed the read-only detection (`find_similar_helpers`, zero setup — no install, no config)
at fresh clones of three widely-used projects (2026-07-02, shallow clones at the commits shown).
These are actual tool outputs, reproducible with the commands below:

```bash
git clone --depth 1 https://github.com/colinhacks/zod && cd zod
qodex   # → find_similar_helpers path="packages/zod/src"
```

| Repo (commit) | Scanned | Found |
|---|---|---|
| **zod** `912f0f5` (`packages/zod/src`) | 116 files, 1,103 functions | **38 near-dupe clusters, ~671 collapsible lines.** Headline: a **7-copy family** — `positive`/`negative`/`nonpositive`/`nonnegative` across ZodNumber+ZodBigInt (~94% similar), each differing only in `kind:`/`inclusive:` |
| **hono** `b20d422` (`src`) | 186 files, 255 functions | 2 clusters: `importPublicKey`/`importPrivateKey` (~95%, ~26 lines) and a duplicated `getQueryString` in the aws-lambda handler (~92%, ~21 lines) |
| **axios** `e435384` (`lib`) | 66 files, 152 functions | 1 cluster: `setFormDataHeaders` **byte-near-identical** in `helpers/resolveConfig.js` and `adapters/http.js` (verified by eye: the only difference is a `\|\| {}` guard) — a textbook `consolidate-dupes` candidate |

And because detection now includes the **parameterize proposal** (v2), the zod family comes back
not as "these look similar" but as the concrete consolidation:

```
Proposed shared helper `extractedHelper(kind, inclusive)` — the bodies differ ONLY in these 2 spot(s):
  positive(…)    → extractedHelper("min", false)
  nonpositive(…) → extractedHelper("max", true)
  nonnegative(…) → extractedHelper("min", true)
  (not covered — different structure: the ZodNumber variants, whose value is 0 vs BigInt(0))
```

### Live `extract-helper` (v8) dry-run on QodeX itself — a block worth reading

We ran the v8 scope's selection live against this repo (1,686 functions → 25 near-dupe clusters)
and the verdict was:

```
VERIFIED-PR: blocked — dry-run: 0 candidate(s)
```

Zero qualifying clusters — and hand-inspection confirmed **every decline was correct**:

- `dedupeStr` vs `dedupe` (99% similar) — *behaviorally different*: one filters out empty
  strings, the other keeps them. Merging them mechanically would change behavior.
- the two `isPrivateOrLocal` copies (100% similar) — one merges two `if`s the other keeps
  separate; structurally divergent even though equivalent, so mechanical parameterization
  can't prove itself.
- the famous 4-copy `walkSource` family — genuinely divergent (different result shapes and
  filters); it needs human-judgment consolidation, not a 3am mechanical pass.
- the 5-copy path-helpers cluster — actually *two* families (1-arg and 2-arg) mixed; v8's
  full-coverage rule refuses to half-consolidate a cluster.

The dry-run also caught a real calibration bug — 100%-similar pairs were being declined just
because their *comments* tokenized differently — which is now fixed (comments are stripped
before alignment). That's the loop working end to end: run live → read the receipt → refine the
guardrail → the remaining blocks are all *correct* blocks. On a codebase with textbook
copy-paste-then-tweak-a-literal families (like zod's `positive`/`negative` above), v8 fires;
on a codebase without them, it proves that fact instead of forcing a refactor.

**And one of them became a real upstream PR:** the axios finding was reviewed by hand, refactored
into `lib/helpers/setFormDataHeaders.js` (keeping the more defensive of the two variants), verified
against axios's own suite (lint clean; all 89 form-data tests passing), and submitted —
**[axios/axios#11062](https://github.com/axios/axios/pull/11062)**.

Just as telling is what we *didn't* submit. The two hono clusters looked like duplicates but turned
out behaviorally distinct on inspection — `importPublicKey`/`importPrivateKey` differ in real
crypto branching, and the two `getQueryString`s deliberately differ in URL-encoding (there's a
comment explaining why). The zod family is arguably deliberate API symmetry. Detection said
"similar"; judgment said "leave them." That division of labor — *mechanical evidence, human
judgment* — is the same verify-or-block philosophy the rest of maintain runs on, and it's why the
tool reports rather than auto-refactors.

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
