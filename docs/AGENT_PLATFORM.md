# QodeX Agent Platform — your agent's own computer

QodeX 3.0 turns the coding CLI into a general autonomous agent that does real work
on the web and on your desktop, keeps working in the background, and asks you before
anything consequential — while staying local-first and model-agnostic (it works with
local Qwen/Llama models as well as Claude, GPT, Gemini and DeepSeek).

It is built in the spirit of personal agents like Meta Muse and xAI Grok Bot: an agent with
its **own computer** that plans, browses, fills forms, keeps working in the background and
checks in only when it needs you. Unlike them, QodeX runs on **your** machine, with **your**
choice of model, and also controls your desktop.

| Capability | QodeX 3.0 |
|---|---|
| Own browser with persistent logins | local persistent profiles, or attach to your Chrome over CDP |
| Desktop control | macOS, Linux (X11 + Wayland), Windows |
| Keeps working after you close the app | detached, resumable missions with milestones and a final report |
| Guard for purchases / payments / sending / credentials | Sentinel — cannot be bypassed by auto mode or `--yes` |
| Credentials the model never sees | encrypted vault, origin-bound (anti-phishing), TOTP |
| Prompt-injection defense for web content | English + Persian detection, page text fenced as data |
| Live view + human takeover | token-protected web control center |
| Approve from your phone | Telegram channel (or the control center over LAN/tunnel) |
| Learn a task from a demonstration | record → self-healing replay → reusable skill |
| Scheduled routines | `qodex schedule add --mission` |

---

## 1. The dedicated QodeX Browser

A persistent Chromium profile that belongs to the agent (`~/.qodex/browser/profiles/<name>`):
cookies and logins survive restarts, so you sign in once and the agent stays signed in.

```bash
qodex browser open https://mail.example.com   # visible window — log in once yourself
qodex browser status                           # executable, profile, tabs
qodex browser profiles                         # list profiles (work / personal / ...)
qodex browser close
```

Inside a session: `/browser`, `/browser open <url>`, `/browser headless`, `/browser profile work`.

**How the agent sees pages.** `browser_snapshot` returns the page's accessibility tree with
stable element refs (`button "Add to cart" [ref=e12]`); actions target refs, not guessed CSS.
Every action returns what changed (URL, new tabs, dialogs, downloads) plus a fresh compact
snapshot, so a model needs one call per step.

**Tools (28):** `browser_navigate, browser_snapshot, browser_click, browser_type, browser_fill,
browser_fill_form, browser_select, browser_hover, browser_press, browser_scroll, browser_drag,
browser_upload, browser_history, browser_tabs, browser_extract (markdown/text/links/tables/
metadata), browser_screenshot (set-of-marks overlay + optional vision analysis), browser_pdf,
browser_downloads, browser_dialog, browser_console, browser_network, browser_evaluate,
browser_get_text, browser_wait_for, browser_status, browser_close, browser_fill_secret,
browser_agent` (an autonomous browser sub-agent for long multi-page jobs).

**Finding a browser.** QodeX discovers a usable Chromium on its own (Playwright caches, system
Chrome / Chromium / Edge / Brave) — even when the installed Playwright expects a different
revision. Override with `browser.executablePath` or `QODEX_BROWSER_EXECUTABLE`.

**Use your own Chrome instead:** start Chrome with `--remote-debugging-port=9222` and set
`browser.cdpUrl: http://127.0.0.1:9222` (or `QODEX_BROWSER_CDP_URL`). QodeX opens its own tab
and only disconnects on close — it never quits your browser.

```yaml
# ~/.qodex/config.yaml
browser:
  headless: true          # QODEX_BROWSER_HEADED=1 to watch
  profile: default
  viewport: { width: 1280, height: 800 }
  stealth: true
  dialogPolicy: accept    # accept | dismiss | ask
  snapshotAfterAction: true
  agentMaxSteps: 40
```

## 2. Desktop control — macOS, Linux, Windows

`computer_use_*` tools drive the real desktop: screenshot, click, double-click, drag, scroll,
type (Unicode / Persian via clipboard paste), key combos, clipboard, open apps/files/URLs, list
and focus windows, and `computer_use_locate` (describe an element → vision model returns its
coordinates). `computer_use_agent` runs an autonomous desktop sub-agent.

Coordinates are **screenshot pixels**; QodeX maps them to the screen (Retina/HiDPI scaling and
window-only captures included) and rejects coordinates outside the last screenshot.

| Platform | Needs |
|---|---|
| macOS | Accessibility + Screen Recording permission for your terminal; `cliclick` optional |
| Linux X11 | `xdotool`, `scrot` (or ImageMagick `import`), `xclip`, `wmctrl` |
| Linux Wayland | `ydotool` ≥ 1.0 with `ydotoold`, `grim`, `wl-clipboard` |
| Windows | nothing extra (PowerShell) |

`/desktop` prints the detected backend and the exact install command for anything missing.

## 3. Missions — work that continues in the background

```bash
qodex mission start "Every listing under 30M toman on divar for a used MacBook Air M2 — compare and shortlist 5"
qodex mission list
qodex mission attach m1a2b3c4d     # follow live; type to steer or answer approvals
qodex mission status m1a2b3c4d     # steps, milestones, cost, live-view link
qodex mission approve m1a2b3c4d    # or deny / cancel / resume / steer <note>
```

A mission is planned into steps (with dependencies), each step runs on a fresh agent with its
own session, milestones are reported as it goes, failed steps retry with the error fed back,
and a final report is written. The worker is a **detached process**: close QodeX, close the
terminal — it keeps going. Cancel is graceful; a reboot pauses the mission and `resume` picks
it up from the last finished step. Each worker starts its own private **live view** (see §5),
shown in `mission status`.

From a session: `/mission <goal>`, `/missions`, or let the agent call `mission_start` itself
for long jobs. Routines: `qodex schedule add --name news --cron "0 8 * * *" --mission --prompt "..."`.
`qodex mission start "…" --auto` (or `--yes`, `--approval-mode auto`) runs the mission in auto
mode — see [Auto mode](#auto-mode--what-still-asks); a mission started from an auto session
inherits it.

```yaml
missions:
  maxConcurrency: 2
  stepMaxIterations: 60
  stepMaxWallSeconds: 1800
  maxCostUsd: 0        # pause and ask once a mission has spent this much (0 = no cap)
  maxAttempts: 2
```

## 4. Sentinel — nothing consequential without you

Every tool call — from the main agent, sub-agents, missions or the MCP server — passes
through Sentinel at a single choke point. It classifies the action (English **and** Persian
labels, page URL, form action, payment gateways like Shaparak/Zarinpal/Stripe, secrets such as
card numbers via Luhn, Sheba/IBAN, API keys):

| Category | Default |
|---|---|
| **purchase, payment, credential, send** | **critical** — always needs an explicit human answer. Auto mode (`/auto on`, `--auto`, `--yes`) can't approve these. With no human reachable the action is refused (`[SENTINEL_BLOCKED]`). |
| delete, account, upload, publish, desktop | asks through the normal permission flow ("always for this site" remembered per session). In auto mode these run without asking, except deleting data / changing an account / publishing on a non-local site and uploading a file from outside the project |
| navigation | blocked/allowed domains, optional private-network block |

### Auto mode — what still asks

QodeX has three approval modes (Shift+Tab cycles them; the status bar shows the current one):
`manual` asks before edits and shell, `edits` lets file edits through, and **`auto`** works
without asking. In auto mode everything inside the project is automatic — edits, shell,
installs, commits, ordinary pushes, deleting project files, browser and desktop work that
Sentinel rates non-critical. Only these still stop for a human:

- **purchases, payments, passwords / credentials, sending messages** (and QodeX's own safety
  settings) — Sentinel-critical, as in every mode;
- **destructive actions outside the project** — deleting or overwriting paths outside the
  workspace roots, force-push / remote branch deletes, deleting remote data (cloud, Kubernetes,
  `terraform destroy`, other hosts' databases, package unpublish), publishing (`npm publish`,
  `docker push`, production deploys), system-level commands (`sudo`, `shutdown`, disks), and on
  the web deleting data or changing an account on a non-local site;
- **writes to the agent's own instruction files** — `AGENTS.md`, `QODEX.md`, `CLAUDE.md`,
  `GEMINI.md`, `AI.md`, `.cursorrules`, `.windsurfrules`, `.github/copilot-instructions.md`,
  anything under the project's `.qodex/` or `.cursor/rules/`, and `~/.qodex/skills|rules|hooks|memory`.
  A prompt-injected page that got the agent to rewrite one would persist into every later
  session, so these ask in **every** mode, by edit tool or by shell (`>>`, `tee`, `cp`, `sed -i`,
  `rm`…). No allow rule or "always yes" covers them; your "yes for this session" on that exact
  write does.

With no human at the terminal (`-p`, schedules, detached missions) those questions go to the
control center, Telegram or the mission's approval queue, and are refused when none is
connected — never answered "yes" automatically. The agent's own questions (`ask_user`, plan
approval) are not asked in auto mode: it decides, continues and lists its assumptions at the end.
Sub-agents, side runs and missions started from an auto session follow the same policy.

Turn it on with Shift+Tab, `/auto on` (or `/mode auto`), `qodex --auto` /
`qodex --approval-mode auto` (`-y` means the same for `-p` runs and `mission start`), or as the
default in **your user config** (a project's `.qodex/config.yaml` cannot switch you into auto):

```yaml
# ~/.qodex/config.yaml
approval:
  defaultMode: auto        # manual | edits | auto
  extraRoots: [~/code/shared-libs]   # also "the project" for auto mode (cwd + temp dir always are)
```

`security.denyRules`, the hard-deny patterns and budgets still apply in auto mode.

Web and window text is **untrusted data**: it is wrapped in `<untrusted_content>` and scanned
for prompt injection (English and Persian, hidden Unicode); detections are flagged to the model
and on the bus. Every decision goes to `~/.qodex/sentinel/audit.jsonl` (secrets redacted).

```yaml
sentinel:
  requireApproval: [purchase, payment, credential, send]
  autoApprove: []                 # e.g. [download]
  blockedDomains: [bank.example]
  allowedDomains: []              # non-empty = allow-list
  blockPrivateNetwork: false
  remoteApprovalTimeoutSec: 600
```

`/sentinel` shows status and recent decisions; `/sentinel reset` clears session approvals.
Local dev targets (localhost / LAN) are never escalated to critical, so testing your own
checkout flow stays smooth.

### The vault — logins the model never sees

```bash
qodex vault add github --origin github.com --username me@example.com --totp   # secret read hidden
qodex vault list
```

The agent fills credentials with `browser_fill_secret` — the value never enters the
conversation, logs or the audit trail. Fills only happen on the entry's own origin (https
only, except localhost), only into the right kind of field, and the origin is re-checked right
before typing — a phishing clone gets `[VAULT_ORIGIN_MISMATCH]`. TOTP codes (RFC 6238) are
generated on the fly. Encrypted with AES-256-GCM; the key lives in a separate 0600 file.

## 5. Control center — watch, take over, approve

```bash
qodex control                 # local; prints a private link with a token
qodex control --lan           # reachable from your phone on the same Wi-Fi
qodex control --tunnel        # public https link via cloudflared/ngrok (still token-protected)
```

or `/control` inside a session. The page shows the agent's browser **live**, lets you
**take over** (your clicks/keys go to the page; the agent waits — also `/takeover`), answer
**approvals** with one tap, follow an **activity timeline**, **steer** the running task, and
see/cancel **missions**. English and Persian UI. Always token-gated (HttpOnly SameSite=Strict
cookie, constant-time comparison, origin checks on writes).

## 6. Workflows — learn by demonstration

```bash
qodex workflow record invoice --url https://billing.example.com   # a window opens; do the task once, press Enter
qodex workflow run invoice --param month=2026-09
qodex workflow list
```

or ask the agent ("record this as a workflow"). Recording captures the agent's or your actions
with robust selectors (id → data-testid → name → role+name → css), turns typed values into
`{{params}}` and password/CVV/OTP fields into secret params (never stored). Replay heals broken
selectors (role/name → text → label), asks Sentinel before consequential steps, can fill
secrets from the vault (`vault:<entry>`), and costs zero model tokens per step. Each workflow
is also saved as a skill so the agent rediscovers it. `record --browser-profile <name>` records
in a named browser profile (`--profile` is QodeX's config overlay).

## 7. Your agent in your pocket — Telegram, Discord, Slack, WhatsApp, Signal

**Chat with the agent** through the bot gateway (`qodex bot`, see the README): send tasks,
watch them stream, and answer approvals with inline buttons. It now also drives the agent
platform:

| Command | What it does |
|---|---|
| `/mission <goal>` | start a background mission (keeps going after you close the chat) |
| `/missions` | missions, progress, and approvals waiting for you |
| `/approve <id>` · `/deny <id>` | answer a mission's approval (e.g. a purchase Sentinel paused) |

Sentinel's critical prompts in a bot conversation arrive as buttons in that chat.

**Approvals-only notifier.** `qodex telegram` is a lightweight, pairing-based Telegram bot
for people who don't run the chat gateway: it delivers approvals (with buttons) and
milestones from detached missions and other QodeX processes, `/mission`, `/missions`,
`/cancel <id>`, `/status` and `/screen` (a screenshot of the agent's browser).

```bash
qodex telegram setup     # paste the BotFather token (stored in ~/.qodex/.env)
qodex telegram pair      # prints a one-time code; send /pair <code> to your bot
qodex telegram start     # runs the notifier (or /telegram start inside a session)
```

Private chats only, pairing codes expire, brute-force lockout; Persian and English.
Telegram allows **one** poller per bot token — if you also run `qodex bot`, give the notifier
its own bot and point `telegram.botTokenEnv` at that token's variable.

## 8. Goals, emergency stop, /learn and monitors

**Standing goals — keep going until it is actually done.** `/goal <what done looks like>`
starts a task and keeps QodeX working on it across turns until the goal is proven, not merely
claimed:

```
/goal all tests pass and the build is green --check "npm test && npm run build" --max 10
/goal the README documents every CLI flag          # no check: the model must cite evidence
/goal            # show the goal and its rounds      /goal clear   # drop it
```

After each run QodeX checks: with `--check`, the command must exit 0; without one, the final
answer must cite evidence on a `GOAL_MET: …` line. If not met, it starts another round with the
check's output (up to `--max`, default 8, max 50) and then stops and says what is missing.

**Emergency stop.** `/stop` halts everything this QodeX process is doing — the running task,
side runs, background jobs and dev servers — and clears the standing goal. It works mid-task
(it is not queued as a steering note). `/stop all` also cancels every active mission. The same
stop is on the control center (the red **⏹ Stop** button, missions included) and in Telegram
(`/stop`, `/stop all`).

**`/learn [name]` — keep what just worked.** Turns the task you just finished (its request, the
ordered tool steps, the files it changed, the outcome) into an active skill under
`~/.qodex/skills/<name>/`, with the same deterministic distiller the automatic flywheel uses. A
skill you wrote yourself with that name is never overwritten. Use it with `/<name>`.

**Monitors — schedules that remember.** `qodex schedule add … --continuity` hands each run the
previous run's answer so it reports what changed; `--notify-on-change` skips the notification /
chat delivery when the answer is the same as last time (the run is still logged):

```bash
qodex schedule add --name gpu-price --cron "@hourly" \
  --prompt "check the price of the RTX 5090 at shop.example" \
  --continuity --notify-on-change --deliver telegram:<chat-id>
```

---

### For weaker local models

The platform is built to *protect* small models: refs instead of selectors, compact
snapshots after every action, loop guards that understand changing page state, a completion
gate that only accepts "I ordered it" when an action actually succeeded, and dedicated
browser/desktop operator roles with tight prompts. Sub-agents run on fresh agent instances
with their own session and budget.

### Where things live

```
~/.qodex/browser/profiles/<name>   persistent browser profiles
~/.qodex/browser/downloads         files the agent downloaded
~/.qodex/screenshots               browser + desktop screenshots
~/.qodex/missions/<id>.log         mission worker logs (state is in sessions.db)
~/.qodex/workflows/<name>.json     recorded workflows
~/.qodex/sentinel/audit.jsonl      Sentinel decisions
~/.qodex/vault.json + .vault-key   encrypted credentials (0600)
~/.qodex/channels/telegram.json    paired chats
```

---

## خلاصه فارسی

**QodeX حالا یک ایجنت خودمختار کامل است، نه فقط یک ابزار کدنویسی:**

- **مرورگر اختصاصی** با پروفایل دائمی — یک بار لاگین کنید، ایجنت لاگین می‌ماند. `qodex browser open`
- **کنترل دسکتاپ** روی مک، لینوکس و ویندوز (اسکرین‌شات، کلیک، تایپ فارسی، کلیپ‌بورد، باز کردن برنامه).
- **مأموریت‌های پس‌زمینه** که بعد از بستن برنامه هم ادامه می‌دهند: `qodex mission start "..."`
- **Sentinel**: خرید، پرداخت، ارسال پیام و ورود اطلاعات حساس بدون تأیید شما انجام نمی‌شود — حتی با `/auto on` یا `--yes`. محتوای صفحات وب «داده» حساب می‌شود و تزریق دستور (فارسی و انگلیسی) شناسایی می‌شود.
- **حالت خودکار (auto)**: سه حالت تأیید داریم — `manual` (پیش‌فرض)، `edits` و `auto`؛ با Shift+Tab عوض می‌شوند و نوار وضعیت حالت فعلی را نشان می‌دهد. در حالت auto هر کاری داخل پروژه (ویرایش، شل، نصب پکیج، کامیت و push معمولی، حذف فایل‌های پروژه) بدون پرسش انجام می‌شود و ایجنت سؤال‌های خودش را هم نمی‌پرسد: خودش تصمیم می‌گیرد و فرض‌هایش را در پایان می‌گوید. فقط این‌ها هنوز تأیید شما را لازم دارند: خرید، پرداخت، رمز عبور، ارسال پیام، و کارهای مخرب بیرون از پروژه (حذف فایل بیرون از پروژه، force-push، حذف داده‌ی راه‌دور، انتشار پکیج، sudo). اگر کسی پای ترمینال نباشد این موارد به مرکز کنترل / تلگرام می‌روند یا رد می‌شوند. روشن کردن: Shift+Tab، `/auto on`، `qodex --auto`، یا `approval.defaultMode: auto` فقط در `~/.qodex/config.yaml` (تنظیمات پروژه نمی‌تواند شما را به auto ببرد). `approval.extraRoots` پوشه‌های دیگری را جزو پروژه حساب می‌کند. قوانین deny و بودجه‌ها همچنان اعمال می‌شوند.
- **فایل‌های دستورالعمل ایجنت** (`AGENTS.md`، `QODEX.md`، `CLAUDE.md`، پوشهٔ `.qodex/`، `~/.qodex/skills` و …) در **همهٔ** حالت‌ها، حتی auto، فقط با تأیید شما تغییر می‌کنند — تا صفحه‌ای که تزریق دستور دارد نتواند قوانین دائمی ایجنت را بازنویسی کند.
- **هدف ماندگار** (`/goal`): ایجنت تا وقتی هدف واقعاً ثابت نشده ادامه می‌دهد — یا دستور بررسی (`--check "npm test"`) موفق شود، یا با سطر `GOAL_MET:` مدرک بیاورد؛ حداکثر تعداد دور با `--max`.
- **توقف اضطراری** (`/stop`): کار در حال اجرا، اجراهای جانبی و سرورهای توسعه را فوراً متوقف می‌کند؛ `/stop all` مأموریت‌ها را هم لغو می‌کند. همین دکمه در مرکز کنترل و دستور `/stop` در تلگرام هم هست.
- **یادگیری فوری** (`/learn`): کاری که همین الان انجام شد را به یک مهارت قابل استفادهٔ دوباره تبدیل می‌کند.
- **پایش زمان‌بندی‌شده**: `qodex schedule add … --continuity --notify-on-change` — هر اجرا جواب اجرای قبلی را می‌بیند و فقط وقتی چیزی عوض شده خبر می‌دهد.
- **گاوصندوق رمزها**: ایجنت رمز را هرگز نمی‌بیند و فقط روی سایت اصلی پر می‌کند (ضد فیشینگ)، با پشتیبانی از کد دومرحله‌ای.
- **مرکز کنترل وب**: تماشای زنده‌ی مرورگر ایجنت، در دست گرفتن کنترل، تأیید با یک کلیک — حتی از گوشی. `qodex control --lan`
- **یادگیری از نمایش**: یک بار کار را انجام دهید، QodeX ضبط و بعداً تکرار می‌کند. `qodex workflow record`
- **تلگرام / دیسکورد / اسلک / واتس‌اپ / سیگنال**: گفتگو با ایجنت، شروع مأموریت (`/mission`) و تأیید اقدامات از گوشی (`qodex bot` یا `qodex telegram`).
