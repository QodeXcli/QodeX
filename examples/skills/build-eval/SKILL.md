---
name: build-eval
description: Build an eval for an LLM app or agent setup — interview, sample real cases, pick the cheapest grader that measures the right thing, write evals/<name>/ (cases, grader, run script), run a baseline after the user signs off. Load before changing a prompt, model, skill or tool description you want to measure.
version: 1.0.0
author: QodeX
triggers:
  - build an eval
  - eval set
  - evals
  - measure my prompt
  - did my change help
  - ارزیابی
slash-aliases:
  - build-eval
allowed-tools:
  - ask_user
  - read_file
  - write_file
  - edit_text
  - ls
  - glob
  - grep
  - shell
  - git_log
  - git_diff
  - todo_write
  - background_job_start
  - background_job_status
  - background_job_log
---
# Build an eval

An eval is three things: inputs the user agrees are the cases that matter, a way to run the
system on each one, and a grade they would have given themselves. Fit it into the repo's own
language and layout; do not bring a framework.

## 1. Interview (ask_user, one question at a time, your recommendation first)
- What is under test: their app (a prompt + model call, an agent, a pipeline) or this QodeX
  setup (QODEX.md, skills, tool descriptions, model, effort)?
- What change is coming that this eval must judge? What would make them roll it back?
- Name: short, kebab-case — everything goes in `evals/<name>/`.

## 2. Sample real cases
Pull inputs from what already happened before inventing any: logs and traces, support tickets
or issues, failing tests, `git_log` for bug fixes, fixtures in the code. Aim for 20–50 at first.
Cover the common path, the known failures, and the cases that must NOT trigger (negatives).
Strip secrets and personal data. Show the list and get an explicit "yes, these are the cases".

## 3. Pick the cheapest grader that measures the right thing
Try in this order and stop at the first that fits the output's shape:
1. Exact match or a label from a closed set.
2. Regex / contains / JSON-schema check.
3. Code check: the tests pass, the file compiles, the end state of a scratch workspace is right
   (for agents, grade the end state, not the transcript).
4. LLM judge — last, for open-ended text only: a short rubric, a reason before the score, and a
   cheap fast model (`haiku`) unless the user picks another.
Grade five pilot cases, show outputs next to grades, and ask "would you have graded any of
these differently?" Iterate until the answer is no. With positives and negatives, report
precision and recall, not only accuracy.

## 4. Write `evals/<name>/`
- `cases.jsonl` — one object per line: `{"id","input","expected","split","tags"}`; `split` is
  `train` or `holdout` (about 70/30, stratified by tag) so `hillclimb` can use it as is.
- the grader (`grade.mjs` / `grade.py`, matching the repo) — pure: (case, output) → `{pass, score, why}`.
- the run script (`run.mjs` / `run.py` / `run.sh`) — runs every case, writes
  `results/<label>/results.jsonl` row by row (resume-safe), and prints the pass rate with a 95%
  interval, cost and latency. For this QodeX setup the system under test is
  `qodex -p "<input>" --json -m <model>` in a disposable copy of the repo.
- `README.md` — how to run it, what each grade means, what it costs per run.

## 5. Baseline
State the cost of one full run and get the user's go before any paid call. Run the baseline,
save it as `results/baseline/`, and report the absolute numbers (pass rate ± interval, cost,
latency). Run it twice if the spread is unknown: a change smaller than the run-to-run noise is
not a result. Next step: the `hillclimb` skill.
