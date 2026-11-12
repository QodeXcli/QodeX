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
| Always-on | `qodex up` fires schedules, drains desk goals, and attaches the chat adapters you configured. Each desk child starts the MCP servers already in your config and stops them when the goal exits. Hermes still reaches more channels. |
| Model-written skill evolution | Hermes rewrites a skill and keeps the version it prefers. `qodex skill rewrite` only stores a candidate. The active file is not replaced, and a model liking the prose is not a promotion. |

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

## What 2.13 adds (the process, not another tool)

Hermes is something you leave running. QodeX was a CLI you invoked, plus a
crontab, plus `qodex bot`, plus `qodex desk run`. That was the real distance.

```
qodex up
```

One process, on this machine. Each pass, default every 60 seconds:

1. Fires due schedules, in the same isolated children `qodex schedule tick` already used.
2. Drains runnable desk goals. Different directories at once. The same directory is sequential.
3. Seals candidates when `learning.enabled` is on (or you pass `--seal`). A seal replays the witness patch and promotes only if the checker is clean. No model. A patch that already failed is not replayed until the skill file changes. A human-authored skill is still immutable. `qodex skill seal` is the same function, once.
4. Attaches the chat platforms you already configured (token and allowlist). `--no-bots` skips them. `--once` does not stay up, so it does not open bots.

`qodex up status` reads `~/.qodex/resident.json` and checks the pid. The file is not a claim that a dead process is alive.

## Where that leaves the comparison

Ahead of Hermes on the thing QodeX is for: a weak local model cannot talk a skill into the library, and the always-on loop is one command that still stops for send, spend, delete, screen, and ssh.

Ahead on the desktop too, in one specific way Hermes does not do: `computer_use_invoke` presses a control by its accessibility name (macOS AX, Windows UI Automation, Linux AT-SPI), refuses ambiguous matches, and reads the tree again. A control that still looks the same is unverified. Hermes clicks a pixel or a browser.

Not ahead, and not claimed: Hermes still has the broader gateway. `qodex skill rewrite` can ask a configured model to clarify skill prose. The result is a quarantined candidate. The active skill is not replaced, and promotion still needs a witness or an independent judge. A missing model writes nothing. `qodex desktop` is a local loopback window (Chrome, Chromium, Edge, or Brave `--app` when one is installed; otherwise a tab, and it says so). The page reads the tree and presses one name; that submit is the human. The agent's own press still waits on the sentinel. The same pause covers the headless browser: `browser_click`, `browser_fill`, and `browser_evaluate` ask every time, and a desk labels that ask as a page change (or as spend, if the call itself is a purchase). Navigate and screenshot do not ask. A rejected call is an error, not a claimed click.

The cloud browser is `qodex mcp add browserbase`. It is Browserbase's hosted server (`https://mcp.browserbase.com/mcp`) with the user's own API key, bridged through mcp-remote because this client does not speak streamable HTTP. The key is an environment variable, not a command-line argument. `start` and `act` ask every time, including under always-yes, and a desk parks that ask as spend. A missing or rejected key is an error. QodeX does not run a browser of its own in someone else's cloud. `qodex up` does not call a model of its own. A desk run starts only the MCP servers already in your config, and stops them when the goal exits. None configured means nothing extra starts.
