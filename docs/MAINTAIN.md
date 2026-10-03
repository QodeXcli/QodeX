# The `maintain` recipe — QodeX's self-improving codebase loop

`maintain` is the recipe that lets QodeX improve **its own** (or your) codebase while you sleep,
without ever quietly shipping a risky change. It is the headline expression of QodeX's edge:
*deterministic guardrails around the model*. This doc explains how it works and how to add a new
**scope** — read it before touching `src/schedule/recipes.ts`.

> Adopting it on your project (setup, rollout ladder, real results)? Start with
> **[ADOPTION.md](ADOPTION.md)** — this doc is for contributors extending the recipe.

## What it is

A scheduled `maintain` run is a normal headless agent run whose prompt has been wrapped in an
**unattended-safe protocol**. The agent does not get a free-form "improve the code" instruction.
It gets:

1. An **unattended header** — "no human is watching, follow this protocol EXACTLY".
2. A **conservative role** — doing nothing beats a risky 3am change; no refactors, renames,
   reformatting, behavior changes, or public-API edits.
3. A single **scope** (see below) describing the *one* narrow, provable improvement to make.
4. The shared **Verified-PR protocol** — sandbox branch → make the change → verify (tests +
   language checkers) → open a PR **only if verification actually passed**, else report `blocked`.
5. A machine-readable **receipt** (` ```qodex-receipt ` JSON) so every run is auditable.

The receipt is ground truth: `filesChanged` comes from git, `verification` from checkers that
actually ran. The dashboard's **Maintain status** panel and `qodex maintain-report` are built
entirely from receipts — never from the model's prose.

## Scopes

A scope is one *kind* of provably-safe cleanup. They are ordered by how conservative they are.
All scopes live in `src/schedule/recipes.ts` as `*_SELECTION` constants.

| Scope            | What it does                                              | Hard safety gate |
|------------------|----------------------------------------------------------|------------------|
| `dead-code` (v1) | Remove ONE provably-unused function/file/export          | Zero references anywhere (incl. tests, re-exports, dynamic imports), proven via `find_references` / `analyze_impact` |
| `unused-imports` (v2) | Drop import bindings referenced zero times          | Never removes side-effect imports (`import "x"`) |
| `unused-locals` (v3)  | Remove `const`/`let` referenced zero times          | Excludes params; **side-effect gate** — RHS must be a literal/pure expression, never a call/`await`/`new` |
| `unused-params` (v4)  | Silence unused params by **prefixing `_`**          | Never *removes* a param (arity change); excludes destructured props |
| `lint-fix` (v5)       | Apply the linter's **autofixable** rules only       | No behavior-changing fixers; bounded to a focus area, never `--fix` the whole repo |
| `dep-bump` (v6)       | Bump ONE dependency a patch/minor and prove tests pass | Requires a real test suite; never a major version |
| `consolidate-dupes` (v7) | Merge ONE exact-duplicate helper pair, repointing callers | Bodies must be *exactly* equivalent (near-dupes out); every caller resolved via the code graph or it blocks — a missed caller breaks the build |
| `extract-helper` (v8) | Collapse ONE near-duplicate cluster into a parameterized shared helper; originals become thin delegating wrappers | Only clusters with a *mechanical* parameterize proposal (`find_similar_helpers`); **zero call-site edits** — signatures/exports unchanged; a wrapper that can't be pure delegation blocks |

**Beyond exact duplicates:** the `find_similar_helpers` tool (`src/codegraph/helper-extract.ts`)
detects *near*-duplicate helpers — copy-pasted-then-tweaked functions (same structure, a different
constant or name) that `consolidate-dupes` can't catch. It normalizes bodies (strip comments,
abstract literals + the function's own name), ranks functions with **TF-IDF-weighted** structural
cosine (so ubiquitous punctuation/keywords don't make everything look alike), and clusters
**seed-based** (no single-linkage chaining). Read-only — it surfaces clusters ranked by lines
saved for a human to extract, since merging near-dupes changes call sites.

The guiding rule: **every scope must be able to PROVE its change is safe — or `block`.** A scope
that can't prove safety in a given case must choose `blocked` with the reason, not guess.

## How a prompt maps to a scope

The schedule's `prompt` field carries the scope (no schema change). `parseMaintainScope(prompt)`
(PURE, unit-tested) extracts `{ scope, focus, dryRun }`:

```
""                       → dead-code (the default)
"unused-imports src/"    → unused-imports, focus "src/"
"locals --dry-run"       → unused-locals, dry-run (preview only, always blocks)
"dep-bump"               → dep-bump
"src/utils"              → dead-code, focus "src/utils"
```

`--dry-run` makes the agent identify candidates without editing anything and end with
`blocked — dry-run: <n> candidate(s)` — used for the dashboard's **Run maintain now (preview)**
button (which itself runs a read-only `tsc` detection, no model needed — see
`src/cli/maintain-preview.ts`).

## Adding a new scope

1. **Add the scope name** to `MaintainScope` and `MAINTAIN_SCOPES` in `recipes.ts`.
2. **Teach `parseMaintainScope`** to recognise it — add an alternative to the regex and a branch
   in the `scope = …` chain. Keep aliases generous (`deps`/`dependency`/`dep-bump` all map to one).
3. **Write a `*_SELECTION` constant** — a short, numbered protocol. It MUST:
   - State the scope and that it is conservative.
   - Tell the agent how to **prove** the change is safe with the code graph or toolchain
     (`find_references`, `analyze_impact`, `tsc --noUnusedLocals`, the linter…), not by guessing.
   - Name the **exclusions / hard gates** explicitly (what it must never touch, when to `block`).
   - End with "this single change IS your GOAL — touch nothing else."
4. **Wire it** into the `selection = …` ternary in `maintainPrompt`.
5. **Test it** in `test/schedule-recipes-delivery.test.ts`: assert `parseMaintainScope` maps the
   new aliases, and that `buildRecipePrompt('maintain', '<scope>')` includes your selection text
   AND still carries the shared `VERIFIED_PR_PROTOCOL` (the verify-or-block gate is non-negotiable).
6. **Surface it** — `src/cli/maintain-stats.ts` (`suggestNextScopes` / `recommendNextScope`)
   automatically picks up new scopes from `MAINTAIN_SCOPES`, so the dashboard's "Suggested next"
   and `qodex maintain-report` will start recommending it once it's in the list.

### Design rules for a scope (so it fits the moat)

- **Provable, not plausible.** If the agent can't mechanically prove the change is safe, the scope
  must `block`. Conservative-by-default is the whole point.
- **One change per run.** Small, reviewable diffs. Reviewers (and the verifier) trust a one-line
  removal far more than a sweeping edit.
- **No behavior change, ever.** A scope that could alter runtime behavior (reorder, reformat used
  code, change a public signature) is out of scope by construction.
- **Lean on the shared protocol.** Don't reimplement verification or PR-opening — every scope flows
  through the same `VERIFIED_PR_PROTOCOL`, so the verify-or-block guarantee holds uniformly.

## Where to look

| Concern | File |
|---|---|
| Recipe + scopes + scope parsing | `src/schedule/recipes.ts` |
| Receipt-driven analytics (rates, trends, projection, next-scope) | `src/cli/maintain-stats.ts` |
| Read-only "preview what it would clean" | `src/cli/maintain-preview.ts` |
| Portable history export/import | `src/cli/maintain-history.ts` |
| Signed audit log | `src/cli/maintain-audit.ts` |
| Dashboard Maintain panel | `src/cli/dashboard.ts` (+ `dashboard-control.ts` for `maintain.preview`) |
| CLI report | `qodex maintain-report` (`src/index.ts`) |
| Live demo page | `qodex maintain-demo` (`src/cli/maintain-demo.ts`) |
| Tests | `test/schedule-recipes-delivery.test.ts`, `test/maintain-stats.test.ts`, `test/maintain-preview.test.ts` |

## Signed audit log (enterprise-ready auditability)

Because every run carries a trust receipt, the sequence of runs can be turned into a
**tamper-evident hash chain** — a mini transparency log. Each entry commits to the previous one's
hash, so altering, reordering, inserting, or dropping any past entry breaks every downstream hash.
That is detectable **offline, with no secret at all**.

```
qodex maintain-audit -o audit.json            # export the hash chain (unsigned)
qodex maintain-audit --sign -o audit.json     # + HMAC-SHA256 over the chain head (authenticity)
qodex maintain-audit-verify audit.json        # verify chain integrity (+ signature if a key is set)
```

- **Integrity** needs no key — `verifyAuditChain` recomputes the chain and reports the first broken
  index. **Authenticity** is the optional HMAC signature over the chain head.
- The signing key comes from the **`QODEX_AUDIT_KEY` environment variable** and is **never stored**
  (consistent with the project rule: secrets live in env, not config). The exported log records only
  a non-secret `keyId` (a short hash prefix) so a verifier knows *which* key signed it.
- All of `src/cli/maintain-audit.ts` is PURE (deterministic hashing), so the chain build, tamper
  detection, and signature checks are fully unit-tested (`test/maintain-audit.test.ts`).
