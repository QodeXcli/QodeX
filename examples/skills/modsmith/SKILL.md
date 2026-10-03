---
name: modsmith
description: Writes a QodeX mod (the create-mod playbook) — code that runs inside QodeX itself, such as a status line, a bar or pane above the prompt, a toast, a slash command that runs code, a guard or rewrite on tool calls and prompts, a timer. Load when the user asks for a mod; /mod new runs it.
version: 1.0.0
author: QodeX
triggers:
  - mod
  - mods
  - modding
  - مود
---
# Create a QodeX mod

A mod is a small ES module that hooks QodeX's own events. It is not a skill (a playbook
for the model) and not an MCP server (tools for the model): it changes QodeX itself.
For a one-off task, just do the task.

## Steps
1. Pin down the trigger (which event), what it shows or changes, and a name
   (letters, digits, `-`, `_`; at most 64). Ask only if the request is ambiguous.
2. Say in one line what the mod will do, then write `~/.qodex/mods/<name>/mod.json` and
   `~/.qodex/mods/<name>/register.js`. QodeX asks the user before any write under
   `~/.qodex/mods` — in every approval mode. That answer is the user's consent to install
   code that runs with their permissions; never write somewhere else to avoid the prompt.
   Project mods (`<cwd>/.qodex/mods`) only when asked: they also need `qodex mod trust <name>`.
3. Run `qodex mod validate ~/.qodex/mods/<name>` and fix every error it reports.
4. Run `/reload-mods` (user mods also reload when their files change).
5. Tell the user how to use it (command, keys) and how to turn it off: `/mods disable <name>`.

## Layout
`mod.json`: `{ "name": "<name>", "description": "…", "version": "0.1.0" }`, optionally
`"userConfig": { "key": { "type": "string|number|boolean", "default": …, "description": "…" } }`
whose values arrive as `options`. `register.js` (plain JS; `.ts` works on Node ≥ 22.13):

```js
export function register(on, options) {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'hello', description: 'Say hello' })
    return next(e)
  })
  on('command.run', { command: 'hello' }, async ($) => {
    $.ui.toast('Hello!')
    return {} // nothing in the transcript; { text } prints a line
  })
}
```

Claude Code's layout loads too: `.claude-plugin/plugin.json` + `hooks/hooks.json`
(`{ "modules": ["./register.js"] }`).

## Hooks
`on(event, [matcher], async ($, e, next) => …)` is middleware: `return next(e)` passes the
event on, `next({ ...e, field })` changes it, returning an object answers it. `e` is
frozen. A matcher filters on payload fields: `{ tool: 'bash' }`, `{ component: 'Pane' }`.
A hook has 10 s of its own time; one that throws or times out is skipped and logged.

| Event | `e` has | A hook may return |
| --- | --- | --- |
| `session.start` / `session.end` | sessionId, cwd / reason | `next(e)` |
| `session.compact` | tokens | `{ skip: reason }` |
| `prompt.submit` | text, context, source | `next({ ...e, text })`, `{ drop: reason }` |
| `tool.call` | tool, args, callId, cwd | `{ deny: reason }`, `{ result }`, `next({ ...e, args })` |
| `tool.check` | tool, operation, decision | `{ decision }` — never loosens a hard deny, Sentinel-critical or instruction-file ask |
| `tool.result` | tool, args, result, isError | `{ result }` |
| `turn.start` / `turn.complete` | turn, prompt / answer, aborted, toolCalls | `turn.complete`: `{ text }` (a dim line) |
| `command.run` | command, args | `{ text }` or `{}` |
| `ui.render` | component, requestId, props | an element tree, or `next(e)` |

## $ API
- `$.command.register({ name, description, argumentHint?, immediate? })`
- `$.tool.register({ name, description, inputSchema, readOnly? })` — the model sees
  `mod__<mod>__<name>`; answer it in `on('tool.call', { tool: 'mod__<mod>__<name>' }, …)` with `{ result }`
- `$.model.complete({ prompt, system?, model: 'fast' | 'default', maxTokens? })` →
  `{ isAnswered: true, text }` or `{ isAnswered: false, reason }`
- `$.prompt.submit({ text })` queues a turn (never a slash command); `$.turn.abort()`
- `$.session.messages()`, `usage()`, `cwd()`, `model()`
- `$.ui.status(text | null)`, `toast(text)`, `log(text)`, `notice(text)`,
  `open({ id, title?, rows?, focus?, closeOnEscape? })`, `close({ id })`, `invalidate()`, `resolve(e)`
- `$.fs.read/write/exists/list` (relative to the session cwd, 4 MiB), `$.process.run(argv, { cwd, timeoutMs })`
  (no shell), `$.http.fetch(url, init)`
- `$.store.get/set/delete/keys` (kept between sessions), `$.clock.now/sleep/after/every`
  (cancelled on reload), `$.env.get(name)`, `$.settings.read()`

## Drawing
`const { Box, Text, Button, Link, Markdown, Bar } = $.ui.resolve(e)` in a `ui.render` hook:
`Box({ flexDirection: 'row', columnGap: 2, children: [...] })`,
`Text({ color: 'cyan', bold: true, children: ['…'] })` (strings only inside Text),
`Button({ key, label, hotkey: 'a', plain: true, onPress })`,
`Bar({ segments: [{ label, value, color }], total })`.
Sites: `AbovePrompt` (the band; every mod's tree stacks), `Pane` (open it with `$.ui.open`
from a command, draw when `e.requestId` is its id), `Spinner`
(`next({ ...e, props: { ...e.props, suffix } })`). Keep state in module variables and call
`$.ui.invalidate()` after changing it (redraws are capped at 10 a second). An unknown
element or prop refuses the whole tree: the transcript shows `ui.render (<Site>) refused: …`.
Keys: Ctrl+X Tab focuses a pane, its hotkeys press buttons, Esc gives the keyboard back.

## Rules
- Mods are trusted code with the user's permissions: keep them small; no network or
  processes unless the request needs them; never read, log or show secrets.
- Pass on what you do not handle (`next(e)`); never block a turn on slow work — start it
  with `$.clock.after(0, …)` and report through `$.ui.notice`.
- A guard that denies says why and what to do instead.
- Examples: the built-in mods `context-bar`, `you-should-know` and `sample-hello`
  (`qodex mod path` shows where they are). Full reference: docs/MODS.md.
