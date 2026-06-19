# QodeX for VS Code

Thin launcher that connects QodeX (local-first agentic coding CLI) to VS Code's editor context.

## What it does

- **Quick launch** — `Cmd+Alt+Q` (or `Ctrl+Alt+Q` on Linux/Windows) opens QodeX in the integrated terminal at the workspace root
- **Selection → QodeX** — `Cmd+Alt+A` with text selected sends it to QodeX along with your question
- **Right-click menus** — On selection: "Ask QodeX". On folders in Explorer: "Open QodeX here"
- **Command palette** — All commands available via `Cmd+Shift+P → QodeX:`
- **Status bar** — Click the rocket icon to launch

## Commands

| Command | Default keybinding | What |
|---|---|---|
| QodeX: Open in Terminal | `Cmd+Alt+Q` | Launch QodeX at workspace root |
| QodeX: Ask about current selection | `Cmd+Alt+A` | Send selection + your question to QodeX |
| QodeX: Edit current file | — | Tell QodeX to make a specific change to the active file |
| QodeX: Plan a change | — | Run QodeX in plan mode for a change description |
| QodeX: Network diagnostic | — | Launch QodeX and run /network immediately |

## Settings

```jsonc
{
  // Path to qodex binary. If 'qodex' isn't on your PATH, use an absolute path.
  "qodex.executablePath": "qodex",
  // Name of the integrated terminal QodeX runs in
  "qodex.terminalName": "QodeX",
  // Use --headless for one-shot commands (faster, no TUI)
  "qodex.openHeadless": false
}
```

## Install

For local development:

```bash
cd /Users/sevengum/qodex/vscode-extension
npm install
npm run compile
# Press F5 in VS Code with this folder open to launch the Extension Development Host
```

For permanent install (after publishing):
```bash
code --install-extension qodex-vscode-0.1.0.vsix
```

## Why thin

QodeX is a CLI-first product. The full TUI with streaming, slash commands,
permission prompts — all of it works in the VS Code integrated terminal
without modification. This extension's job is just to make launching faster
and to bridge editor context (selection, active file) into the first prompt.

If you want a richer in-editor experience, that's deferred to future versions
once the CLI feature set is stable.
