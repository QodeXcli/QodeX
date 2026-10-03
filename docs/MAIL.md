# Mail (IMAP / SMTP)

QodeX can read your mailboxes, write drafts and — with your approval — send mail.

## Add an account

```sh
qodex mail add personal --email you@gmail.com          # preset detected from the address
qodex mail add work --email you@corp.example --imap mail.corp.example:993 --smtp mail.corp.example:465
qodex mail test personal                               # signs in to IMAP and SMTP, changes nothing
qodex mail list | qodex mail default work | qodex mail remove work | qodex mail presets
```

The password is typed with echo off, or read from the first line of stdin
(`printf '%s\n' "$APP_PW" | qodex mail add personal --email you@gmail.com`). It is never a
command-line argument. `--oauth-token` stores an OAuth2 access token (XOAUTH2) instead.

### App passwords — گذرواژهٔ برنامه

Most providers refuse your normal password over IMAP/SMTP once two-step sign-in is on. Create
an **app password** (a separate password only mail apps can use) and enter that.

| Provider | Preset | Where to get an app password |
|---|---|---|
| Gmail / Google Workspace | `gmail` | 2-Step Verification on → https://myaccount.google.com/apppasswords (enable IMAP in Gmail settings) |
| Outlook.com / Hotmail | `outlook` | OAuth2 token (`--oauth-token`) or https://account.live.com/proofs/AppPassword while offered |
| Microsoft 365 | `office365` | admin must allow IMAP + SMTP AUTH; usually OAuth2 |
| Yahoo | `yahoo` | Account security → Generate app password |
| iCloud | `icloud` | account.apple.com → Sign-In and Security → App-Specific Passwords |
| Yandex | `yandex` | enable IMAP in Mail settings → id.yandex.com/security/app-passwords |
| Zoho | `zoho` | enable IMAP; with 2FA: accounts.zoho.com → Security → App Passwords (EU: use custom) |
| Fastmail | `fastmail` | Settings → Privacy & Security → App passwords (IMAP + SMTP) |
| AOL | `aol` | Account Security → Generate app password |
| GMX | `gmx` | enable POP3/IMAP in settings (gmx.net/.de: use custom) |
| Proton Mail | `proton-bridge` | install Proton Mail Bridge; use the user + BRIDGE password it shows (127.0.0.1, plain is allowed only there) |
| anything else | `custom` | `--imap host[:port] --smtp host[:port]` (993/465 = TLS, 143/587 = STARTTLS, required) |

برای Gmail، Yahoo، iCloud و بیشتر سرویس‌ها با تأیید دومرحله‌ای باید «App Password» بسازید و همان را وارد کنید، نه رمز اصلی حساب.

## What the agent can do

| Tool | What it does | Approval |
|---|---|---|
| `mail_list` | newest first: id, from, subject, date, read/unread, snippet | none (output fenced as untrusted) |
| `mail_read` | headers, text body (HTML → text), attachment names | none (output fenced, injection-scanned) |
| `mail_draft` | saves a signed local draft (+ a copy in the server's Drafts); `reply_to_id` keeps the thread | none |
| `mail_send` | sends a draft (or to/subject/body) | **a human, every time** (Sentinel `send`, critical) |
| `mail_mark` / `mail_move` | read/unread/flag; archive/trash/junk/folder | none in auto mode |
| `mail_download_attachment` | saves an attachment into the project, never overwrites | the normal edit policy |

## Security

- Accounts and their passwords / tokens live in `~/.qodex/mail-accounts.enc` (0600), encrypted
  with the vault key (`~/.qodex/.vault-key`). It is not the credential vault:
  `browser_fill_secret` can never type a mail password into a web page.
- Passwords never appear in tool output, errors, logs, the event bus or the audit trail (every
  encoding is scrubbed, including base64 AUTH blobs).
- Email content is data, not instructions: Sentinel fences it and flags prompt injection. A
  reply to a flagged email is marked in its draft and always needs an explicit human approval.
- Sending always shows the recipients (To / Cc / Bcc), subject, body preview and attachments and
  waits for a human — in manual, edits and auto mode. With nobody to ask (headless, a detached
  mission) the send is refused. Drafts are immutable and signed, so what was approved is what is
  sent, and a draft is never sent twice.
- Attachments from disk: QodeX's own state (`~/.qodex`) and credential files (`.env`, SSH keys,
  `.npmrc`, …) are refused.

### Standing grants, the mail watcher and mail rules

**Auto-replies (standing grants).** A send always needs your approval, with one exception: a *standing reply grant* that you create yourself. Only these human surfaces can create one:
- TUI `/allow mail-replies [--account work] [--from boss@acme.com,@acme.com] [--max-per-day 50] [--expires 7d]`
- terminal `qodex grant add mail-replies …`
- a paired Telegram chat's `/allow …`
- clicking **"always allow replies like this"** on a mail_send approval prompt

List grants with `/allow list` or `qodex grant list`. Revoke with `/allow revoke <id|all>` or `qodex grant revoke <id>`.

No tool lets the model create, widen or read a grant. Sentinel blocks the agent from reading or writing `~/.qodex/grants.json`, `~/.qodex/mail-auto/` and `~/.qodex/mail/`. If the agent runs `qodex grant …` or `qodex mail rule add …`, Sentinel treats it as a change to QodeX's own safety settings, which always needs a human.

A grant covers a send only when all of these hold:
- It is a draft made with `mail_draft reply_to_id` (a signed draft).
- It goes in the same thread to the original sender only. A Reply-To redirect does not count, and there are no cc, bcc or other recipients.
- It has no attachments from disk.
- The original email was not flagged as prompt injection.
- The reply contains no secret.
- The account and sender filter match, the grant has not expired, and the daily cap (default 50) is not used up.

A covered send needs no prompt, including in a detached run. It is audited (via `grant`), and you are told "Auto-replied to X: subject" in the TUI, the control center, Telegram and a desktop notification. Anything else gets the normal critical prompt, and with no human available it is refused.

**Watcher.** Commands:
- `qodex mail watch` runs in the foreground; `qodex mail watch --daemon` runs in the background.
- `qodex mail watch --status` and `qodex mail watch --stop`.
- `/mail watch start|stop|status|recent`.

The watcher uses IMAP IDLE per account, with polling as a fallback. Config: `mail.watch: true` or `{ enabled, accounts, folder, pollIntervalSec, idle }`. With `mail.watch` on, `qodex telegram start` and the control center start it.

New mail is announced once per message, with sender, subject and a short snippet. Messages are deduplicated by Message-ID, and the last-seen UID is kept per account and folder. Existing mail is never replayed.

**Rules (standing tasks).** Add one with `qodex mail rule add "<when>" "<task>" [--cwd dir] [--auto]` or `/mail rule add …`. Conditions:
- `from:<addr|@domain>`
- `to:`
- `subject:"…"`
- `body:"…"`
- `has:attachment`
- `account:<name>`
- `*` for any mail

Manage rules with `/mail rule list|remove|enable|disable`. On a match, the watcher starts a background run (a mission) in the rule's directory. Its instruction is your task; the email is attached as fenced data, never as instructions. An email flagged as prompt injection gets a draft-only run, and you are notified.

`qodex mail reply-all [--account a] [--from @acme.com] [--max-per-day N] [--expires 7d]` (or `/mail reply-all`) turns auto-reply on: it creates a reply grant plus a rule "draft a reply and send it". `/mail rule remove <id>` turns it off and revokes the grant. Auto-reply never answers mail from your own address, mailing lists, bulk mail, autoresponders or bounces. See `/mail status` for an overview.

**خلاصهٔ فارسی:** ارسال ایمیل همیشه تأیید شما را می‌خواهد. تنها استثنا «مجوز دائمی پاسخ» است که فقط خودتان می‌سازید: با `/allow mail-replies`، با `qodex grant add`، در تلگرام، یا با گزینهٔ «always allow replies like this». این مجوز فقط پاسخ در همان رشته به فرستندهٔ اصلی را پوشش می‌دهد؛ بدون گیرندهٔ اضافه، بدون پیوست، و تنها اگر ایمیل اصلی مشکوک به تزریق دستور نباشد. هر پاسخ خودکار ثبت می‌شود و به شما خبر داده می‌شود. `qodex mail watch --daemon` ایمیل‌های تازه را اعلام می‌کند. `qodex mail rule add` برای ایمیل‌های منطبق یک کار پس‌زمینه شروع می‌کند؛ متن ایمیل فقط داده است و دستور به حساب نمی‌آید. `qodex mail reply-all` پاسخ خودکار را روشن می‌کند.
