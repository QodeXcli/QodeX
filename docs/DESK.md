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

`computer_use_tree` and `computer_use_invoke` press a **named** control. Hermes clicks a pixel or drives a browser. This reads the OS accessibility tree:

- macOS — Accessibility (System Events). One matching element is clicked. Zero or two is a refusal.
- Windows — UI Automation. Invoke or Toggle. If the control has neither, the click is the center of **that control's** bounds, not a coordinate the model guessed.
- Linux — AT-SPI when `python3-gi` and `gir1.2-atspi-2.0` import. If they do not, the tool errors. It does not invent a tree. Blind clicks still need xdotool.

After the press the tree is read again. The control leaving, or its bounds / value / enabled bit changing, is verified. If it looks the same, the result is unverified and the tool errors. Do not treat that as success.

`computer_use_screenshot`, `computer_use_click`, `computer_use_type`, and `computer_use_key` remain for pixels the tree does not name:

- macOS — screencapture, System Events, optional cliclick
- Linux — xdotool, plus scrot or ImageMagick `import` or gnome-screenshot. If xdotool is missing, the tool says so. It does not pretend it clicked.
- Windows — PowerShell and Win32. `cmd` is sent as Ctrl. The Windows key is not sent.

Every press, click, type, and key still waits for the sentinel. So do `browser_click`, `browser_fill`, and `browser_evaluate`: those change a page, not the desktop, and a standing yes does not cover them. Loading a URL and taking a screenshot stay quiet.

`qodex desktop` is the window for the person at this machine. Loopback only. Chrome, Chromium, Edge, or Brave opens it with `--app` when one of those is installed; otherwise it is a browser tab and the command says so. A press from that page is you, so it does not pause on the sentinel. The agent's own invoke still does.

A cloud browser is separate: `qodex mcp add browserbase` points at Browserbase's hosted server with your API key. `start` and `act` pause on the sentinel as spend, even if the desk is in always-yes. If the key is missing, the call errors. There is no browser QodeX rents on its own.

Click, type, and key ask every time, including under always-yes. Screenshot and window listing stay read-only.

## Teach from a real run

A finished goal is `done` only when the agent exits 0. If the type-check of files it changed still has errors after the repair rounds, the exit is 1 and the goal is `failed`. No checker, or a clean checker, is not a failure.

```bash
qodex desk teach research morning --from-last
```

That is the routine. It is not a screen recording.

## What is still local

- A desk run starts the MCP servers you already configured, then stops them when the goal exits. Disabled servers and an empty list start nothing. `qodex up` uses the same `desk run`. Spend, send, delete, and a cloud-browser act still wait.
- If this directory already has `.qodex/codegraph.db`, the desk opens it and closes it when the goal exits. A missing file is not created, and the graph tools still say to run the index. The prompt mentions the graph only when it contains symbols.
- The board is `~/.qodex/desks/board.json`. The trail is `~/.qodex/desks/audit.jsonl`. Paused calls are `~/.qodex/desks/sentinel.json`.

If a run is killed while a goal is `running`:

```bash
qodex desk release research <goalId>
```

An approved goal stays approved.
