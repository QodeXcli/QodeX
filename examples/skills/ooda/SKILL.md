---
name: ooda
description: OODA (Observe / Orient / Decide / Act) loop for ambiguous, unfamiliar, or high-stakes tasks. Forces explicit observation and orientation before action. Load when the user asks for debugging across systems, incident response, or "figure out what's going on".
version: 0.1.0
author: QodeX
triggers:
  - debug
  - investigate
  - incident
  - root cause
  - what is going on
  - چی شده
slash-aliases:
  - ooda
allowed-tools:
  - read_file
  - ls
  - glob
  - grep
  - bash
  - code_graph_find_symbol
  - code_graph_find_callers
  - code_graph_find_references
  - project_overview
  - analyze_impact
  - smart_diff
  - git_status
  - git_diff
  - git_log
  - web_search
  - web_fetch
  - http_request
---
# OODA Loop — Observe / Orient / Decide / Act

For ambiguous or high-stakes work. Each cycle is a single response (or one
batch of parallel tool calls), explicit and short.

## OBSERVE
What is actually true RIGHT NOW? Stick to facts the tools surface; no inferences yet.
- What does the user actually see? (Quote their words.)
- What does the repo state say? (`git_status`, `ls`, recent `git_log`.)
- What does the code say? (`read_file` the suspect modules.)
- What do logs/console/test output say?
- What does the network say? (HTTP status, console errors.)

End this step with a 3-7 line **OBSERVATIONS** block. No conclusions yet.

## ORIENT
Now connect the dots — generate at least **two competing hypotheses** before picking one.
- H1: …
- H2: …
- (optional) H3: …
- Evidence for / against each.
- What single test would falsify the most likely one?

Premature commitment is the OODA failure mode. If both hypotheses still survive,
loop back to OBSERVE with a more targeted query.

## DECIDE
- Which hypothesis are you acting on?
- What is the smallest experiment that proves it?
- What's the rollback plan if you're wrong?
- Blast radius? (Use `analyze_impact` if multi-file.)

If the experiment would mutate state non-reversibly, **stop and ask the user
to confirm** before proceeding.

## ACT
Run the experiment. Capture the result. State whether it confirmed or
falsified the hypothesis. If falsified, **loop to OBSERVE** — do NOT iterate
on the same hypothesis with more tweaks.

## Loop discipline
- One OBSERVE → ORIENT → DECIDE → ACT per response (or per tool batch).
- After ACT, summarize and explicitly start the next OBSERVE.
- Stop the loop when: the user's problem is solved, OR three loops haven't converged (then summarize what you know and ask the user).
