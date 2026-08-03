# Measuring the harness — `qodex eval`

QodeX's agent harness (system prompt, ~129 tools and their gating, context assembly,
compaction, cache layout, verification gates, loop detectors) is what determines how well
the model actually performs. Before this existed, every harness change was a guess: there
was no way to answer *"did that make the agent better or worse?"*

`qodex eval` answers it.

## The two layers

**(a) Deterministic — free, offline, seconds.** Assertions about the real harness that need
no model at all. This is the default and where most of the durable value is: it runs in CI,
costs nothing, and catches regressions the moment they land.

**(b) End-to-end — model-driven, opt-in.** Real coding tasks against fixture repos with
mechanical pass criteria. Slower, noisier, run occasionally. *Not built yet — see Limits.*

## Use it

```bash
qodex eval                     # run the free deterministic suite
qodex eval --list              # what suites exist
qodex eval --json              # machine-readable
qodex eval --filter prompt     # one category (or comma-separated task ids)
qodex eval --repeat 3          # run each task N times; reports variance, flags flaky tasks
```

Exit code is **1 if any task failed**, so it gates CI directly.

## A/B a harness change — the whole point

```bash
qodex eval --out /tmp/before.json     # 1. measure
#   ... make your harness change ...
qodex eval --compare /tmp/before.json # 2. diff against a fresh run
```

The diff reports the score delta and — the part that matters — **which tasks flipped**:
`pass→fail` is a regression, `fail→pass` is the improvement you were aiming for. Exit code
is **1 if there are any regressions**.

`eval/baseline.json` is a checked-in run of the deterministic suite on the current harness.
Regenerate it deliberately, only when a change is intended and reviewed:

```bash
qodex eval --label baseline --out eval/baseline.json
```

## What the deterministic suite measures

| Category | Asserts |
|---|---|
| `tool-surface` | total token cost of all tool definitions is within budget; gating still keeps the tools a task provably needs; no two tools have near-identical descriptions; every tool has a description and a valid schema |
| `prompt` | assembled system prompt is within budget (both capability tiers); contains no known self-contradiction; **references no unregistered tool** (the `edit_file` phantom bug class this repo hit twice) |
| `cache` | the message prefix is byte-stable across two identical builds (local KV-cache and prompt caching both depend on it); volatile sections come *after* the stable prefix; cache breakpoints follow the documented layout |
| `history` | every assistant `tool_calls` id still has a matching tool result after dedup + aging + compaction + spill (the orphaned-tool_call 400 fixed in `bd62ab4`); compaction preserves the user's goal; dedup rewrites content but never removes a message |
| `recovery` | the stuck-loop, error-loop and read-loop detectors fire on broken histories **and stay quiet on healthy ones** — a detector that always fires is as broken as one that never does |

Every probe is proven **failable**: the test suite runs each one against a deliberately
broken harness stand-in and asserts it fails with a specific measured reason. An assertion
that cannot fail is worthless, and this is how they are kept out.

## Adding a task

Add it to `src/eval/suites/harness.ts` (or a new suite in `src/eval/suites/`, registered in
`suites/index.ts`). A task returns `pass` / `fail` / `skip` with a `detail` string carrying
the **measured value vs the budget** — the detail is what makes a failure actionable.

Then add a test in `test/eval-harness-suite.test.ts` proving the new probe fails on a broken
input. Do not add a probe without that proof.

## Limits — what this does NOT measure

Being honest about the boundary matters more than the score:

- **No end-to-end task suite yet.** Layer (b) is not built. The deterministic layer measures
  harness *properties*, not whether the agent actually solves a coding task well. A green
  suite means "nothing structurally regressed", not "the agent got smarter".
- **Skips never count as passes.** A suite where everything skipped scores 0, not 100. If a
  probe cannot run, it says so.
- **No judgement calls.** Nothing here measures whether the prompt's *advice* is good — only
  that it is internally consistent, within budget, and references real tools. Whether the
  agent over-uses todos, plans well, or picks the right tool is a layer-(b) question.
- **Single machine, single point in time.** Token budgets are calibrated against the current
  harness; they need re-baselining when the tool surface changes on purpose.
