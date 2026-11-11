# QodeX Desk

Named teammates on **this** machine, running at the same time, sharing one directory. Same jobs as a Bot group or Muse — files, shell, browser, and the screen — without a rented VM.

Six desks. A goal that would send, spend, delete, publish, or touch a credential does not start until you allow it. If a run then tries the actual call, it pauses on the sentinel until you allow **that call**, and then it runs. Handoffs scrub secrets and stop after three hops.

## Do the work

```bash
qodex desk add research --brief "read and summarize" --cwd "$PWD"
qodex desk add writer --brief "draft from the shared notes" --cwd "$PWD/notes"
qodex desk goal research "summarize the RFC in docs/"
qodex desk run research
qodex desk run --all            # every desk with a runnable goal
qodex desk run --dry-run        # print the prompt, call nothing
```

Desks with different directories run in parallel. Two desks in the same directory run one after the other so they don't fight over one checkout.

The shared computer is `~/.qodex/desks/computer`. Every desk can read and write it.

## Sentinel

Irreversible shell, a purchase, a send, a publish, and every screen click/type/key pause:

```bash
qodex desk calls
qodex desk allow-call <id>      # the paused tool runs
qodex desk deny-call <id>       # the agent is told no
```

`qodex desk serve` is the same switch on `127.0.0.1`. The page refreshes the waiting list. It does not call a model. A paused call waits up to 10 minutes (`--sentinel-timeout`), then it is denied.

## Screen

`computer_use_screenshot`, `computer_use_click`, `computer_use_type`, and `computer_use_key` are real:

- macOS — screencapture, System Events, optional cliclick
- Linux — xdotool, plus scrot or ImageMagick `import` or gnome-screenshot. If xdotool is missing, the tool says so. It does not pretend it clicked.
- Windows — PowerShell and Win32. `cmd` is sent as Ctrl. The Windows key is not sent.

Click, type, and key ask every time, including under always-yes. Screenshot and window listing stay read-only.

## Teach from a real run

A finished goal stores the tool names it actually called (secrets stripped).

```bash
qodex desk teach research morning --from-last
```

That is the routine. It is not a screen recording.

## What is still local

- MCP servers are not started for a desk run, so the process exits when the goal exits. Use `qodex -p` in that directory when you need them.
- The code graph says the index is cold until you build it.
- The board is `~/.qodex/desks/board.json`. The trail is `~/.qodex/desks/audit.jsonl`. Paused calls are `~/.qodex/desks/sentinel.json`.

If a run is killed while a goal is `running`:

```bash
qodex desk release research <goalId>
```

An approved goal stays approved.
