# Password vault and CAPTCHA hand-off

QodeX keeps your site logins in an encrypted vault the agent can **use** but never **read**, and it
hands CAPTCHAs / bot checks to **you** — it never solves them. See also [AGENT_PLATFORM.md](AGENT_PLATFORM.md).

## The vault key, editing and importing

- **Where the key lives:** `qodex vault key status` shows the backend; `qodex vault key migrate <file|macos|secret-service|windows>`
  moves the vault key into the macOS Keychain, the Secret Service (GNOME Keyring / KWallet via `secret-tool`) or Windows DPAPI
  (the secret is always passed on stdin, never on a command line). The choice is recorded, so a missing key file is never
  mistaken for a fresh install. The vault and the mail account store share the same key.
- **Edit / rotate:** `qodex vault edit <name> [--origin … | --add-origin … | --login-url … | --rename …]`, `qodex vault rotate <name> [--totp | --undo]` (keeps the
  other fields and the previous password for an undo).
- **Import:** `qodex vault import <export.csv> [--format …|auto] [--dry-run] [--on-conflict skip|replace|rename]` reads a
  password-manager / browser export (only counts are printed). Delete the plaintext export afterwards; the agent is not allowed
  to read such files.

### Logging in with the vault

- `browser_login {secret, url?, submit?}` signs in with a vault entry in one step. It opens the entry's login page (or uses the open login form), fills the username and password (including username-first forms where the password page comes second) and the current 2FA code if the entry has a seed. It submits with the form's own button, but only after Sentinel checks the button's label, so a "Sign in and pay" button is refused. It reports where it landed. If a login fails, it does not retry: that entry is held for 15 minutes unless it is changed. A page that redirects to another site is refused, and CAPTCHAs are left for a human.
- `vault_generate_and_fill {ref?, confirm_ref?, name?, username?, length?}` is for sign-up and change-password forms. It creates a strong random password and saves it to the vault before typing it (a new entry for the site, or a rotation of `name`), then fills the new-password and confirm fields. It respects the field's maxlength. If typing fails, the vault change is undone.
- The agent never sees the values. Results, errors, progress events, the action recorder and the approval prompts show `***` or nothing. Both tools are classed as credential actions with high risk, so Sentinel asks in manual mode.
- Requests like "log me in with my saved password", "the 2FA code from my authenticator app", «رمز عبورم», «گاوصندوق» or «کد دو مرحله‌ای» bring in the vault tools without naming a site. A plain coding task that mentions "password" does not.
- Recorded workflows replay a `browser_login` as steps on the fields' autocomplete tokens (username / current-password / one-time-code). The steps read their values from the vault entry.

### Logins typed by you, never by the chat (vault entry + save-login)
- When the agent needs a login it calls `vault_request_login`. You type it into QodeX's masked terminal prompt or the control center's secure form. The value goes straight into the encrypted vault; the agent, chat, logs and Telegram never see it.
- The control-center form works only on this computer (localhost) or through the https tunnel link. Over a tunnel the page encrypts the form itself (ECDH P-256 + AES-256-GCM) before sending it. Plain http on the local network is refused. Only the full control-center link can enter or manage secrets.
- Vault panel (control center): see saved logins (usernames masked, passwords never shown), add one, change a password or 2FA key, edit sites or the login URL, or delete with confirmation.
- Save-login: if you log in to a site yourself during a takeover, QodeX asks "Save the login for <site> (user ab***)?" in the terminal and the control center. Yes saves or updates the vault entry; the question never contains the password. The agent's own typing never triggers it, and a page that still shows the login form (wrong password) waits until you hand back.
- Not included yet: a master passphrase with session unlock (follow-up).

### ورودهایی که خودتان تایپ می‌کنید، نه چت (ورود به گاوصندوق + ذخیرهٔ ورود)
- وقتی عامل به ورود نیاز دارد `vault_request_login` را صدا می‌زند؛ شما آن را در اعلان پنهان ترمینال QodeX یا فرم امن مرکز کنترل تایپ می‌کنید. مقدار مستقیم به گاوصندوق رمزنگاری‌شده می‌رود؛ عامل، چت، لاگ‌ها و تلگرام هرگز آن را نمی‌بینند.
- فرم مرکز کنترل فقط روی همین رایانه (localhost) یا از لینک https تونل کار می‌کند. روی تونل، خود صفحه فرم را پیش از ارسال رمزنگاری می‌کند. http سادهٔ شبکهٔ محلی رد می‌شود. فقط لینک کامل مرکز کنترل اجازهٔ ورود یا مدیریت رمزها را دارد.
- پنل گاوصندوق: فهرست ورودها (نام کاربری پوشیده، رمز هرگز نمایش داده نمی‌شود)، افزودن، تغییر رمز یا کلید دومرحله‌ای، ویرایش سایت‌ها و آدرس صفحهٔ ورود، و حذف با تأیید.
- ذخیرهٔ ورود: اگر هنگام گرفتن کنترل خودتان وارد سایتی شوید، QodeX در ترمینال و مرکز کنترل می‌پرسد «ورود <سایت> (کاربر ab***) ذخیره شود؟». بله ورودی گاوصندوق را می‌سازد یا به‌روز می‌کند و رمز هرگز در پرسش نیست. تایپ خود عامل هرگز این پرسش را ایجاد نمی‌کند، و اگر صفحه هنوز فرم ورود را نشان دهد (رمز اشتباه) تا پس دادن کنترل صبر می‌کند.
- هنوز موجود نیست: گذرواژهٔ اصلی با باز کردن در هر نشست (کار بعدی).

### CAPTCHA / bot checks: hand-off, never solving (browser)
QodeX never solves CAPTCHAs. It uses no solver services, no vision or audio solving, no clicking, typing or dragging into a challenge widget, no synthesized "human" input and no fingerprint spoofing. `browser.stealth` is now **off** by default.
- **Detection** covers:
  - reCAPTCHA (a visible checkbox or challenge only; the v3 badge is ignored) and hCaptcha
  - Cloudflare Turnstile and the "Just a moment…" page
  - Akamai, PerimeterX "Press & Hold", DataDome and AWS WAF
  - Arkose, GeeTest, Kasada, DDoS-Guard, Sucuri and Imperva
  - plain image CAPTCHAs
- **Self-clearing checks are waited out** for up to `browser.challengeAutoWaitSec` (default 20 s), with no model calls.
- **Anything else shows up as `[CHALLENGE]`.** The agent then calls `browser_request_human`:
  - QodeX takes over the browser so the agent waits.
  - It asks you on every channel (terminal, control center live view, Telegram) and you choose `done` or `cancel`.
  - It continues by itself as soon as the check is gone; you don't need to answer.
  - If nobody solves it within `browser.handoffTimeoutSec` (default = `sentinel.remoteApprovalTimeoutSec`, 600 s), the result is `[CHALLENGE_UNSOLVED]`. The agent stops and tells you; it does not retry.
- **The agent can never act on a challenge** (`[CHALLENGE_HUMAN_ONLY]`), and recorded workflows never contain challenge steps.
- **Seeing fewer challenges, legitimately:**
  - `browser.headless: auto` (the default) opens a visible window when you use the TUI on a desktop. `--print`, missions and machines without a display stay headless; `QODEX_BROWSER_HEADLESS=1` opts out.
  - A configured `browser.channel: chrome` is used for the visible window.
  - Agent actions on the same site are paced by `browser.hostPacingMs` (≤ 1 s).
  - A page whose last two loads were bot checks is not reloaded again.
- `browser.challengeHandoff`: `auto` (default) | `report` (only report it; no hand-off) | `off` (no detection).
- New built-in skills: `sign-up` and `manage-site`.

### کپچا و بررسی ربات: سپردن به شما، هیچ‌وقت حل‌کردن خودکار
- QodeX کپچا را هرگز خودش حل نمی‌کند: نه سرویس حل کپچا، نه تشخیص تصویر یا صدا، نه کلیک روی «من ربات نیستم» و نه جعل اثر انگشت مرورگر. stealth حالا به‌طور پیش‌فرض خاموش است.
- بررسی‌هایی که خودشان رد می‌شوند (مثل «Just a moment…» کلودفلر) تا ۲۰ ثانیه صبر می‌شوند.
- اگر کپچا به آدم نیاز داشته باشد، QodeX مرورگر را به شما می‌سپارد: از ترمینال، مرکز کنترل یا تلگرام چند ثانیه وقت می‌گذارید و حلش می‌کنید.
- QodeX به‌محض رفع کپچا خودش ادامه می‌دهد؛ لازم نیست «done» بزنید.
- اگر در زمان تعیین‌شده حل نشود، کار متوقف می‌شود و به شما خبر داده می‌شود. QodeX خودش دوباره امتحان نمی‌کند.
- برای اینکه کمتر کپچا ببینید:
  - در TUI روی دسکتاپ یک مرورگر واقعی و قابل‌دیدن باز می‌شود.
  - Chrome خودتان (`browser.channel: chrome`) به کار می‌رود.
  - بین درخواست‌ها به یک سایت فاصله گذاشته می‌شود.

### Hand-offs: CAPTCHAs and bot checks
QodeX never solves a CAPTCHA. When a check needs a person, QodeX hands the browser to you and continues by itself as soon as the check is gone.
- **Telegram**: you get a card with a screenshot cropped to the check and two buttons, ✅ Done and ✖️ Can't solve it. It also has a 🖐 Open live view button: a one-tap link that opens only this check's live view (no approvals, missions, steering, stop or vault). The link expires after `browser.handoffLinkTtlSec` (default 10 min) or when the hand-off ends. QodeX stores only a hash of the link. Telegram refuses links to this computer or to a local network in buttons; the card then comes without the button. On a LAN control center it names the Wi-Fi address instead, which opens on a phone already logged in with the private `?k=` link. For a one-tap link from anywhere, start the control center with `/control --tunnel`. Or set `control.handoffTunnel: true` so a hand-off opens the control center and a public quick tunnel by itself (off by default). When the check clears, the card changes to "✓ Challenge cleared, continuing".
- **Control center**: `?handoff=<id>` (or the link) opens hand-off mode: the live view comes first on phones, zoomed to the check, with Done / Can't buttons. Your own press-and-hold and drag are relayed as you make them; a hold lasts at most 15 s and is always released. Pinch to zoom; use Keyboard for text CAPTCHAs.
- **Terminal**: the prompt says "Solve it in the browser window or the control center — QodeX continues automatically" and shows the local control-center URL. Press d for done, c for can't, Esc stops the task.
- **Detached missions**: the hand-off reaches Telegram as a text card (Done / Can't) through the mission queue, with no screenshot or link, because the worker's browser runs in another process.

### واگذاری‌ها: کپچا و بررسی‌های ضدربات
QodeX هرگز کپچا را حل نمی‌کند. وقتی یک بررسی به انسان نیاز دارد، مرورگر را به شما می‌سپارد و به محض برطرف شدن آن، خودش ادامه می‌دهد.
- **تلگرام**: یک کارت با تصویرِ برش‌خورده از همان بررسی و دو دکمهٔ «✅ انجام شد» و «✖️ نمی‌توانم حلش کنم» می‌گیرید. دکمهٔ «🖐 باز کردن نمای زنده» هم دارد: یک لینک تک‌لمسی که فقط نمای زندهٔ همین بررسی را باز می‌کند (نه تأییدها، نه مأموریت‌ها، نه هدایت، نه توقف، نه گاوصندوق). این لینک پس از `browser.handoffLinkTtlSec` (پیش‌فرض ۱۰ دقیقه) یا با پایان واگذاری از کار می‌افتد و QodeX فقط هشِ آن را نگه می‌دارد. تلگرام لینکِ همین کامپیوتر یا شبکهٔ محلی را در دکمه نمی‌پذیرد؛ آن‌وقت کارت بدون دکمه می‌آید. اگر مرکز کنترل روی شبکهٔ محلی باشد، نشانیِ Wi-Fi را می‌نویسد که در گوشیِ واردشده با لینک خصوصی `?k=` باز می‌شود. برای لینک تک‌لمسی از هر جا، مرکز کنترل را با `/control --tunnel` اجرا کنید، یا `control.handoffTunnel: true` را تنظیم کنید تا واگذاری خودش مرکز کنترل و یک تونل عمومی موقت را باز کند (پیش‌فرض خاموش). وقتی بررسی برطرف شود، کارت به «✓ بررسی برطرف شد، ادامه می‌دهیم» تغییر می‌کند.
- **مرکز کنترل**: `?handoff=<id>` (یا همان لینک) حالت واگذاری را باز می‌کند: در گوشی نمای زنده اول می‌آید، روی بررسی بزرگ‌نمایی شده و دکمه‌های «انجام شد» و «نمی‌توانم» دارد. نگه‌داشتن و کشیدنِ خودِ شما همان‌طور که انجام می‌دهید منتقل می‌شود؛ هر نگه‌داشتن حداکثر ۱۵ ثانیه است و همیشه رها می‌شود. با دو انگشت بزرگ‌نمایی کنید؛ برای کپچای متنی دکمهٔ «صفحه‌کلید» را بزنید.
- **ترمینال**: پیام می‌گوید «آن را در پنجرهٔ مرورگر یا مرکز کنترل حل کنید — QodeX خودش ادامه می‌دهد» و نشانیِ مرکز کنترل محلی را نشان می‌دهد. d یعنی انجام شد، c یعنی نمی‌توانم، و Esc کار را متوقف می‌کند.
- **مأموریت‌های جدا**: واگذاری از طریق صف مأموریت به‌صورت کارت متنی (انجام شد / نمی‌توانم) به تلگرام می‌رسد، بدون تصویر و لینک، چون مرورگرِ worker در پردازش دیگری اجرا می‌شود.

## Web Bot Auth — an honest agent identity (optional)

QodeX never hides that it is automated. The opposite option is **Web Bot Auth**: QodeX
signs its own requests with an Ed25519 key so a site can *recognise* QodeX — "this is the
agent, acting for its user" — and choose to let it through. It earns fewer bot challenges
by being identifiable, not by evading detection. Off by default.

It implements HTTP Message Signatures (RFC 9421) with the `web-bot-auth` tag (the
Cloudflare / IETF draft). Each signed request carries `Signature-Agent` (the URL where
you publish the public key), `Signature-Input` and `Signature`, covering the target
`@authority` and that directory URL.

Set it up:
1. `qodex browser bot-auth --init` creates the key at `~/.qodex/browser/bot-auth/ed25519.pem`
   (0600). The private key never leaves the machine; Sentinel keeps the agent out of that
   folder, so QodeX itself can never read, copy or change the key.
2. In `~/.qodex/config.yaml`:
   ```yaml
   browser:
     botAuth:
       enabled: true
       directoryUrl: https://your-domain/.well-known/http-message-signatures-directory
   ```
3. `qodex browser bot-auth --directory` prints the public key as a JWK Set — host it at
   that URL. A site (or Cloudflare) fetches it to verify the signature. To get fewer
   challenges on Cloudflare you also register the agent in its verified-bots programme;
   QodeX provides the signature, you do the registration.

What it is and is not:
- It signs only same-site `document`, `xhr` and `fetch` requests on public hosts. Images,
  fonts and third-party subresources are not signed. Loopback / LAN pages (dev servers)
  are never signed, and the user's own Chrome (`cdpUrl`) is never touched.
- `QODEX_BROWSER_BOT_AUTH=1|0` forces it on / off; `browser_status` and
  `qodex browser status` show it.
- It does **not** spoof a fingerprint, hide `navigator.webdriver`, or forge human input.
  A site is free to ignore the signature. Signing requests reduces HTTP caching a little
  (lean mode still saves image/font/media bandwidth).

**خلاصهٔ فارسی.** «Web Bot Auth» هویت صادقانهٔ ایجنت است، نه پنهان‌کاری: QodeX درخواست‌های
خودش را با یک کلید Ed25519 امضا می‌کند تا سایت بفهمد «این QodeX است که از طرف کاربرش کار
می‌کند» و اجازهٔ عبور بدهد. پیش‌فرض خاموش است. با `qodex browser bot-auth --init` کلید ساخته
می‌شود (کلید خصوصی هرگز از دستگاه خارج نمی‌شود و Sentinel ایجنت را از آن پوشه بیرون نگه
می‌دارد)، بعد در config مقدار `browser.botAuth.enabled: true` و `directoryUrl` را بگذارید و
خروجی `qodex browser bot-auth --directory` را روی آن نشانی منتشر کنید. فقط درخواست‌های
هم‌سایتِ صفحه روی میزبان‌های عمومی امضا می‌شوند؛ localhost و Chrome خودتان دست‌نخورده می‌مانند.
این قابلیت اثرانگشت مرورگر را جعل نمی‌کند و رفتار انسانی نمی‌سازد.
