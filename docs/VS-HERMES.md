# QodeX vs Hermes Agent

Honest gap, not a feature checklist. Hermes Agent (Nous Research) is a general
autonomous operator: many chat platforms, a daemon, and a learning loop that
asks a model to rewrite its own skills. QodeX is a local-first coding CLI.
Most of the surface area already overlaps (tools, memory, FTS session search,
cron, Telegram/Discord/Slack/WhatsApp/Signal, skills, sub-agents, Docker
shell). The distance that still mattered is below.

## Where Hermes is ahead

| Gap | Why it matters |
| --- | --- |
| Messaging breadth | Hermes reaches more channels (email, Matrix, and others). QodeX's gateway is the five transports above, on purpose: each one is a real adapter, not a logo. |
| Always-on daemon as the product | Hermes is built to live on a VPS and wake from cron or a phone. QodeX can schedule, but the primary surface is still the repo you are in. |
| Model-written skill evolution | Hermes (GEPA-style) rewrites skills with a model. That compounds when you have a strong second model and you trust its taste. |

## Where QodeX was stuck

On one local model — the setup QodeX is for — Hermes-style promotion does not
transfer. QodeX already refuses to let a model grade its own capture. With no
second model, every candidate stayed quarantined forever. `evalCandidate` was
an explicit stub. Self-improvement was a cloud feature wearing a local badge.

Captures on the sandboxed path also only saw the changed-file list when the
flywheel flag was on, so learning often had nothing to encode.

## What 2.8 adds (the wedge, not a clone)

**Witnessed replay.** A verified session stores the exact unified diff inside
the quarantined skill (size-capped, path-checked, secret-rejected). 

```
qodex skill witness <name>
```

re-applies that diff in a detached git worktree and runs the same objective
checker the agent already trusts (tsc, ruff, …). No model call.

`qodex skill curate` uses that result only when there is no independent judge
(`learning.witnessFallback`, default on). Rules that did not move:

- An independent judge that says no is final. A patch cannot overrule it.
- A human-authored skill is never overwritten.
- A patch that applies but has no checker is not a pass. Silence is not success.
- The author model is never the judge.

Hermes asks "does a model like this skill?" QodeX asks "does this diff still
apply, and does the compiler still agree?" That is the added value on a
machine that only runs Qwen.

## What this is not

Not a claim that QodeX matches Hermes as a personal life-operator, and not a
SWE-bench number. Coding-agent quality is still the model plus the guardrails
you already have. 2.8 closes the hole that made the learning loop dishonest
on the default local setup.
