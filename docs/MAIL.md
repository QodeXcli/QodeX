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
