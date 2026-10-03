---
name: hillclimb
description: Improve a system against an existing eval one change at a time — prompt, skills, tool descriptions, model or effort — on a train/holdout split, keeping a change only when holdout does not regress, logging every step in evals/<name>/HILLCLIMB.md.
version: 1.0.0
author: QodeX
triggers:
  - hillclimb
  - hill climb
  - improve the eval score
  - tune the prompt
  - بهبود امتیاز
slash-aliases:
  - hillclimb
allowed-tools:
  - ask_user
  - read_file
  - write_file
  - edit_text
  - multi_edit
  - ls
  - glob
  - grep
  - shell
  - git_status
  - git_diff
  - todo_write
  - background_job_start
  - background_job_status
  - background_job_log
---
# Hillclimb

## 0. Preconditions
- A runnable eval exists in `evals/<name>/` with a baseline. If not, load `build-eval` first.
- Every case has `split: train | holdout`. If not, split about 70/30 stratified by tag, and
  never move a case between splits afterwards.
- The working tree is clean (`git_status`), so every change is one revertible diff.

## 1. Agree on the plan (ask_user)
- Knobs allowed: prompt / QODEX.md, skills, tool descriptions, model, effort. What is off-limits.
- Budget: cost per full run × the number of rounds. Stop condition: a target score, N rounds
  without a kept change, or the budget.

## 2. Loop — one change per round
1. Read the failing **train** cases and their outputs; name the failure pattern in one line.
2. Make ONE change aimed at that pattern. Prefer removing or clarifying text over adding rules;
   no instruction that names or quotes a specific eval case.
3. Run train and holdout.
4. Keep the change only if train improves AND holdout does not regress beyond the run-to-run
   noise measured at baseline. A change that helps train but not holdout is overfitting:
   revert it (`git diff` → undo the edit), even when the train gain is large.
5. Append a row to `evals/<name>/HILLCLIMB.md`:
   `| round | change (one line) | train | holdout | cost | kept/reverted | why |`
6. If three rounds in a row are reverted, stop and group the remaining failures by cause
   (grader wrong? case ambiguous? capability missing?) before trying more changes. Fix a
   wrong grader or case with the user's agreement — never to make a number go up.

## 3. Hand back
Report baseline → final for train and holdout as absolute numbers (pass rate ± interval, cost,
latency), list the kept changes in order with their diffs, and the reverted ones with the reason.
The holdout number is the headline. Leave the final state committed or as a clean diff — the
user decides whether to keep it.
