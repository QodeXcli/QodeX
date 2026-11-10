# QodeX Desk

A desk is a named teammate on **this** machine. It is not Grok Bot's shared cloud computer, and it is not Muse's Secure VM. QodeX does not rent you a box, and it does not pretend Linux or Windows can click the screen. On macOS, click, type, and key exist, and each one asks every time — a click can send, pay, or delete, and there is no undo.

Six desks. A goal that would send, spend, delete, publish, or touch a credential waits until you allow it. Handoffs scrub secrets and stop after three hops. The audit is an append-only file you can read.

## Do the work

```bash
qodex desk add research --brief "read and summarize" --cwd "$PWD"
qodex desk goal research "summarize the RFC in docs/"
qodex desk run research          # same agent as `qodex -p`, in that cwd
qodex desk run --dry-run         # print the prompt, call nothing
```

`qodex desk serve` opens a console on `127.0.0.1` with a token in the URL. That page assigns and approves. It does not call a model. `qodex desk run` does.

Held goals:

```bash
qodex desk goal research "pay the invoice"
qodex desk allow research <goalId>    # or: qodex desk deny research <goalId>
```

If a run is killed while a goal is `running`, put it back. An approved goal stays approved:

```bash
qodex desk release research <goalId>
```

## What a run will and will not do

- Ordinary file edits and shell run without a second prompt. You already gave the desk the goal.
- Irreversible shell (`rm -rf`, force-push, format, publish) still asks, and this path denies the ask.
- Screen click, type, and key ask every time, including under always-yes, and this path denies that too. Screenshot and window listing stay read-only.
- The hold looks at the **goal you typed**, not at every tool call. "Remove an unused import" is a coding goal. "Delete the customer table" is held.
- MCP servers are not started for a desk run, so the process can exit when the goal exits. Code-graph tools say the index is cold until you build it. Use `qodex -p` in that directory when you need either.
- Routines are JSON steps you teach (`qodex desk teach`), not a screen recording.

The board is `~/.qodex/desks/board.json`. The trail is `~/.qodex/desks/audit.jsonl`.
