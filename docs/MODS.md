# Mods — change QodeX itself

A **mod** is a small JavaScript (or TypeScript) module that hooks into QodeX's own events.
It can hold or rewrite a tool call, rewrite a prompt, draw above or under the prompt, add a
slash command or a tool, call a model, run work on a timer, or leave a heads-up in the
transcript. Skills tell the model *how to work*; MCP servers give the model *tools*; mods
change *QodeX* — the harness around the model.

The shape follows [Claude Code mods](https://code.claude.com/docs/en/plugins/mods/overview)
(`register(on, options)`, middleware hooks `($, e, next)`, the `$` mods API), so a simple
Claude Code mod runs in QodeX unchanged. [Differences](#claude-code-compatibility) are listed
at the end.

## Quick start

```text
/mod new show how full the context is and the time under the prompt
```

QodeX writes the mod to `~/.qodex/mods/<name>/` with its mod-writing playbook (the
`modsmith` skill), validates it with `qodex mod validate`, and reloads mods. The write asks
you first — in every approval mode, auto included — and that answer is your consent to
install code that runs with your permissions.

Or write one yourself:

```text
~/.qodex/mods/hello/mod.json      { "name": "hello", "description": "Say hello", "version": "0.1.0" }
~/.qodex/mods/hello/register.js
```

```js
export function register(on, options) {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'hello', description: 'Say hello' })
    return next(e)
  })
  on('command.run', { command: 'hello' }, async ($) => {
    $.ui.toast('Hello from a mod!')
    return {} // nothing in the transcript; { text } prints a line
  })
}
```

Then `qodex mod validate ~/.qodex/mods/hello` and `/reload-mods` (user mods also reload when
their files change).

## Layout and where mods live

Either layout loads:

| Layout | Files |
| --- | --- |
| QodeX | `mod.json` (`name`, `description`, `version`, optional `main`, `userConfig`) + `register.js` / `.mjs` / `.ts` / `.mts` |
| Claude Code | `.claude-plugin/plugin.json` + `hooks/hooks.json` (`{ "modules": ["./register.js"] }`) |

`userConfig` (`{ key: { type, default, description } }`) values arrive as `register`'s
`options`. TypeScript entries need Node ≥ 22.13 (types are stripped); otherwise use `.js`.

| Scope | Directory | Loads when |
| --- | --- | --- |
| built-in | shipped with QodeX (`qodex mod path`) | by its manifest's `defaultEnabled`, until you enable/disable it |
| user | `~/.qodex/mods/<name>/` | enabled (the default) |
| project | `<project>/.qodex/mods/<name>/` | only after `qodex mod trust <name>` / `/mods trust <name>` — and again after its entry file changes |
| session | `--mod-dir <dir>` (repeatable), `QODEX_MOD_DIRS` | always, with hot reload |

Enabled / disabled / trusted state and per-mod config live in `~/.qodex/mods.json`. Mods
load in a fixed order (scope, then name) with the built-ins last, so your mod can wrap a
built-in one.

## Hooks

```js
on(event, [matcher], async ($, e, next) => { … })
```

A hook is middleware. `return next(e)` passes the event on (later mods, then QodeX's own
step); `next({ ...e, field })` passes a changed copy; returning an object answers the event
without the rest of the chain. `e` is deeply frozen. A matcher filters on payload fields by
equality or list membership — `{ tool: 'bash' }`, `{ component: ['Pane', 'AbovePrompt'] }`;
`'*'` hooks every event. `next.signal` aborts when the event is abandoned (Esc, `/stop`),
`next.origin` says who fired it, `next.budget` is the hook's time limit.

A hook that throws or runs over its own 10 s is **skipped** — the chain continues with the
event as it was — and logged; `.catch(handler)` on the registration runs instead (1 s). One
bad mod never breaks QodeX.

| Event | `e` | A hook may return |
| --- | --- | --- |
| `session.start` | sessionId, cwd, surface | — (once per mod before the first prompt, and after its reload) |
| `session.end` | sessionId, reason | — |
| `session.compact` | sessionId, tokens | `{ skip: reason }` |
| `prompt.submit` | text, context, source | `next({ ...e, text })`, `next({ ...e, context })`, `{ drop: reason }` |
| `prompt.section` | name, text | `{ text }`, `{ text: null }` to omit it |
| `tool.call` | tool, args, callId, cwd | `{ deny: reason }`, `{ result, isError? }`, `next({ ...e, args })` |
| `tool.check` | tool, operation, decision | `{ decision: 'allow' \| 'ask' \| 'deny' }` (see [Security](#security-and-trust)) |
| `tool.result` | tool, args, callId, result, isError, durationMs | `{ result }` |
| `tool.describe` | tool, description | `{ description }` |
| `turn.start` | turn, prompt | — |
| `turn.step` | turn, step, model | `next({ ...e, model })` |
| `turn.complete` | turn, answer, aborted, toolCalls, usage | `{ text }` — a dim line under the answer |
| `agent.spawn` | role, task, model | `{ deny }`, `{ model }` |
| `command.run` | command, args | `{ text }`, `{}` |
| `ui.render` | component, requestId, surface, props, viewport | an element tree, or `next(e)` |
| `ui.press` | key, requestId | — |

## The `$` mods API

| Namespace | Methods |
| --- | --- |
| `$.plugin` | `name`, `root` |
| `$.command` | `register({ name, description, argumentHint?, immediate? })` (built-in names refused; `immediate` runs during a turn), `list()` |
| `$.tool` | `register({ name, description, inputSchema, readOnly? })` → the model sees `mod__<mod>__<name>`; answer it in a `tool.call` hook. `list()` |
| `$.model` | `complete({ prompt, system?, model: 'fast' \| 'default' \| id, maxTokens? = 1024, timeoutMs? })` → `{ isAnswered: true, text }` or `{ isAnswered: false, reason }`; never rejects on API errors |
| `$.prompt` | `submit({ text, asUser? })` — a turn once the session is idle; the model is told which mod sent it unless `asUser` |
| `$.turn` | `abort(reason?)` |
| `$.session` | `id()`, `cwd()`, `model()`, `messages()` (newest 4,096), `usage()` (context tokens/window/percent and by category, cost, budget limits) |
| `$.ui` | `resolve(e)`, `invalidate()`, `open({ id, title?, rows?, focus?, closeOnEscape? })`, `close({ id })`, `status(text \| null)`, `toast(text, { timeoutMs? })`, `log(text)`, `notice(text)` |
| `$.fs` | `read`, `write`, `exists`, `list` — relative to the session cwd, 4 MiB per file |
| `$.process` | `run(argv, { cwd?, timeoutMs?, stdin? })` — an argument list, no shell; 30 s default, 10 min max |
| `$.http` | `fetch(url, { method?, headers?, body?, timeoutMs? })` |
| `$.store` | `get`, `set`, `delete`, `keys` — JSON kept between sessions in `~/.qodex/mods-store/<name>.json` (4 MiB, atomic writes) |
| `$.clock` | `now`, `sleep`, `after`, `every` — timers are cancelled when the mod reloads or unloads |
| `$.env` | `get(name)` |
| `$.settings` | `read()` — QodeX's effective config, secrets redacted |

## Drawing in the terminal

`ui.render` runs for each **render site**; filter on `{ component }`:

| Site | Where | `e.props` |
| --- | --- | --- |
| `AbovePrompt` | the band directly above the prompt box; every mod's tree is stacked, in load order | isWorking, maxRows, bodyColumns |
| `Pane` | a framed region above the prompt, opened with `$.ui.open({ id })`; `e.requestId` is that id. Several panes show as tabs | title, isFocused, bodyColumns, placement (`inline`) |
| `Spinner` | the "crafting…" word while a turn runs: `next({ ...e, props: { ...e.props, suffix } })` adds text after it, a tree replaces it (`await next(e)` inside the tree keeps QodeX's word) | word, message, suffix, mode |

Elements come from `const { Box, Text, Button, Link, Markdown, Bar } = $.ui.resolve(e)`:

| Element | Props |
| --- | --- |
| `Box` | `flexDirection`, `gap` / `columnGap` / `rowGap`, `padding*`, `margin*`, `width`, `height`, `borderStyle`, `borderColor`, `justifyContent`, `alignItems`, `flexGrow`… |
| `Text` | `color`, `backgroundColor`, `bold`, `italic`, `underline`, `strikethrough`, `dimColor`, `inverse`, `wrap`; children are strings, `Text` or `Link` |
| `Button` | `key`, `label`, `onPress`, `hotkey` (one digit or lowercase letter), `plain` (`1: One` instead of `[ One ]`), `dimColor`, `autoFocus` |
| `Link` | `href`, `label` |
| `Markdown` | `text` (≤ 10,000 chars), `dimColor` |
| `Bar` | `segments: [{ label, value, color }]`, `total`, `width`, `showLegend` — a stacked bar with a legend (QodeX addition) |

Colors: named terminal colors, `#rgb` / `#rrggbb`, `rgb(r,g,b)`, `ansi256(n)`, or a theme key
(`success`, `error`, `warning`, `info`, `accent`, `subtle`…). Every tree is validated before
it is drawn: an unknown element or prop, a misplaced child or an oversized tree refuses
that mod's tree, nothing is drawn for it, and the transcript shows
`● <mod>: ui.render (<Site>) refused: <reason>` once. Terminal control characters (escape
sequences, carriage returns) are removed from every string a mod draws.

A drawing is a snapshot: keep state in module variables (or `$.store`) and call
`$.ui.invalidate()` after changing it. Redraws are throttled to 10 a second and repaint only
when the drawing changed.

**Keyboard.** `Ctrl+X` then `Tab` moves the keyboard to the first pane, the next pane, the
band (when it has buttons) and back to the prompt. While a pane or the band has it: `Tab` /
arrows move between buttons, `Enter` or a button's hotkey presses it, `Esc` gives the
keyboard back (and closes a `closeOnEscape` pane), `Ctrl+X X` closes the pane. Other keys
never reach the prompt meanwhile; `Ctrl+C`, `Shift+Tab` and `Ctrl+B` keep working.
`$.ui.open({ id, focus: true })` takes the keyboard only while the prompt is empty.

**Lines outside the drawing.** `$.ui.status(text)` — one line per mod under the prompt,
`⚠ <mod>: text`, until replaced or cleared with `null`. `$.ui.toast(text)` — a short notice
at the top of the prompt area for 4 s. `$.ui.log(text)` — a dim `● <mod>: …` transcript line.
`$.ui.notice(text)` — a highlighted `💡 <mod>: …` transcript line. The model never reads
status, toast, log or notice lines. Without a terminal (headless `--print`), log and notice
go to stderr and drawing is skipped.

## Limits

| Limit | Value |
| --- | --- |
| A hook's own time per event (time inside `next` and `$` calls excluded, except `clock.sleep`) | 10 s |
| A `.catch` handler | 1 s |
| All `session.end` hooks together | 1.5 s |
| `$.process.run` | 30 s default, 10 min max |
| `$.model.complete` `maxTokens` | 1024 by default |
| `$.fs.read` / `write`, `$.store` | 4 MiB |
| One `Text` string child, `Markdown` text | 10,000 characters |
| A tree | 2,000 elements, 32 levels |
| Redraws | 10 a second |
| Toasts | 4 s unless `timeoutMs` (0.5–60 s); the newest 3 show |
| Command, tool and pane names | letters, digits, `_`, `-`; up to 64 |

## Security and trust

- **Mods are code that runs with your permissions** — like a shell script you install.
  Install only mods you trust; read a mod before enabling it.
- Writes into `~/.qodex/mods/**`, `~/.qodex/mods.json` and `<project>/.qodex/**` are agent
  instruction-file writes: QodeX **asks you in every approval mode**, auto included, so a
  prompt-injected page cannot install a mod.
- **Project mods never load until you trust them**; trust records the directory and a hash of
  the entry, and a changed entry needs trusting again.
- `tool.check` can tighten a decision freely, but can never turn into *allow*: a hard deny
  rule or deny pattern, a Sentinel-critical action (purchase, payment, credential, send,
  integrity), an instruction-file write, or an auto-mode "still asks" decision. Those always
  reach you.
- `$.prompt.submit` can queue a turn but never a slash command — a mod cannot type `/auto`
  for you. A mod never answers a permission prompt.
- `$.settings.read()` redacts secrets. Status, toast, log and notice lines are never sent to
  the model.

## Built-in mods

| Mod | Default | What it does |
| --- | --- | --- |
| `context-bar` | on (bar hidden) | `/context-bar [on\|off]` toggles a stacked bar above the prompt: one color per kind of context (system, tools, rules, memory, messages, tool results, free), a legend and `<pct>% of <window>`. The choice is kept in its store. |
| `you-should-know` | off — `/mods enable you-should-know` | After each turn (and at most every 3 minutes during a long one) a fast model reads the recent transcript and answers: did the user or the agent miss something — an ignored failing test or command, an unverified claim, the wrong file edited, a secret printed, an instruction not followed, a TODO left? `NONE`, or one `💡` line. Never starts a turn, 120 output tokens per look, repeats dropped, silent after `/stop`. |
| `sample-hello` | off (docs only) | `/hello-tabs` opens a pane with two tabs and a counter kept in `$.store` — Claude Code's hello-tabs example, unchanged. |

Their source (`qodex mod path`) uses the public API only — copy them.

## Commands

| Command | |
| --- | --- |
| `/mod new <description>` | QodeX writes a mod for you |
| `/mods` · `/mods enable\|disable\|trust <name>` | list mods, turn them on or off, trust a project mod |
| `/reload-mods` | reload every mod |
| `qodex mod list` · `new <name>` · `validate <dir>` · `test <dir>` | list, scaffold, check (events, commands, tools and `$` calls used; errors), run `<dir>/*.test.(js\|mjs\|ts)` against a fake `$` |
| `qodex mod enable\|disable\|trust\|untrust <name>` · `qodex mod path` | state, and where mods live |
| `--mod-dir <dir>` | load a mod directory for this session (repeatable, hot reload) |

## Claude Code compatibility

Runs unchanged: `register(on, options)` from `hooks/hooks.json` modules, middleware hooks
and matchers, `.catch`, `next.signal` / `origin` / `budget`, the events and `$` methods in
the tables above, `Box` / `Text` / `Button` / `Link` / `Markdown`, panes with `focus` and
`closeOnEscape`, hotkeys and `autoFocus`, `$.store`, the limits.

Differences:

- **Render sites**: `AbovePrompt`, `Pane` and `Spinner` only. Panes are always the framed
  region above the prompt (no sidebar dock, no resize keys, no scroll keys, no mouse).
- **The band stacks** every mod's tree; a tree does not hide the trees of later mods, so
  `await next(e)` inside your band tree is not needed (it is harmless).
- **Elements**: no `Input`, `Select`, `Code`, `Svg`, `Client`, `Raster` or `Image` — a tree
  using one is refused with a readable reason. `Bar` is QodeX's own.
- **A refused tree draws nothing** for that mod (Claude Code draws its own version of the site).
- **Not available**: `$.state` and its helpers (use module variables + `$.store`), `$.mcp`,
  `$.audio`, `$.config`, `$.agent`, `$.telemetry`, `$.ui.ask` / `copy` / `blit` / `focus` /
  `scroll` / `panes`, `$.model.fork` / `classify`, `$.process.spawn`; events `classic.*`,
  `prompt.compose` / `fill` / `suggest` / `edit` / `context` / `attachment`, `session.receive` /
  `send` / `append` / `measure`, `agent.offer`, `ui.input` / `select` / `focus` / `scroll` /
  `close` / `message`, `plugin.register`, `engine.create`, `telemetry.*`.
- **Additions**: the `mod.json` layout, `Bar`, `$.ui.notice`, `$.session.usage()` with context
  by category, cost and budget limits, `turn.complete` usage, trust-gated project mods.
- **Tools**: `qodex mod validate` / `test` play the part of `claude plugin validate` / `test`;
  the store lives in `~/.qodex/mods-store/`.

## خلاصه فارسی

**مود (mod)** یک ماژول کوچک جاوااسکریپت/تایپ‌اسکریپت است که به رویدادهای خودِ QodeX وصل می‌شود: می‌تواند فراخوانی ابزار را نگه دارد یا تغییر دهد، پرامپت را بازنویسی کند، بالای کادر پرامپت یا زیر آن چیزی نشان دهد (نوار، پنل، خط وضعیت، اعلان کوتاه)، فرمان اسلش یا ابزار جدید اضافه کند، از یک مدل سریع سؤال کند یا کاری را زمان‌بندی کند. ساختار آن با مودهای Claude Code یکی است و مودهای ساده‌ی Claude Code بدون تغییر اجرا می‌شوند.

- **ساختن مود**: `/mod new <توضیح>` — QodeX مود را در `~/.qodex/mods/<نام>/` می‌نویسد (نوشتن در این پوشه در **همهٔ** حالت‌ها، حتی auto، از شما اجازه می‌گیرد و همین تأیید یعنی رضایت شما به نصب کد)، با `qodex mod validate` بررسی و با `/reload-mods` بارگذاری می‌کند.
- **محل مودها**: کاربر `~/.qodex/mods`، پروژه `.qodex/mods` (فقط پس از `qodex mod trust <نام>`؛ با تغییر فایل دوباره اعتماد لازم است)، و پوشه‌ی موقت با `--mod-dir`.
- **صفحه**: نوار بالای پرامپت (همهٔ مودها روی هم)، پنل قاب‌دار بالای پرامپت (چند پنل = زبانه)، خط وضعیت زیر پرامپت، اعلان ۴ ثانیه‌ای، و خطوط `●` و `💡` در تاریخچه که مدل هرگز نمی‌خواند. `Ctrl+X` سپس `Tab` کیبورد را به پنل می‌دهد، کلیدهای میان‌بر دکمه‌ها را می‌زنند و `Esc` کیبورد را برمی‌گرداند.
- **امنیت**: مود کدی است با دسترسی شما — فقط مود مورد اعتماد نصب کنید. مود هرگز نمی‌تواند ممنوعیت قطعی، اقدام حساس Sentinel (خرید، پرداخت، رمز، ارسال)، نوشتن در فایل‌های دستورالعمل یا پرسش‌های حالت auto را به «مجاز» تبدیل کند و نمی‌تواند به‌جای شما فرمان اسلش اجرا کند.
- **مودهای داخلی**: `context-bar` (با `/context-bar` نوار مصرف پنجرهٔ کانتکست به تفکیک دسته)، `you-should-know` (خاموش؛ بعد از هر نوبت یک مدل سریع نکته‌ی جاافتاده — تست شکست‌خورده، ادعای بررسی‌نشده، TODO — را در یک خط `💡` می‌گوید)، و `sample-hello` (نمونه‌ی آموزشی).
