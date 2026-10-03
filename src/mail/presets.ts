/**
 * Mail provider presets: IMAP / SMTP endpoints plus the sign-in advice a user needs.
 *
 * Most big providers refuse the normal account password over IMAP/SMTP once two-factor
 * sign-in is on: they want an APP PASSWORD (a 16-character password generated in the
 * account's security settings, usable only by mail clients). `appPassword` says whether
 * the preset needs one and `help` says where to make it. Users who already hold an
 * OAuth2 access token can use it instead (XOAUTH2).
 */

export interface MailEndpoint {
  host: string;
  port: number;
  /** Implicit TLS (993 / 465). false = STARTTLS upgrade (587 / 143) or plain on localhost. */
  secure: boolean;
}

export interface MailPreset {
  id: string;
  label: string;
  /** Email domains this preset is detected from. */
  domains: string[];
  imap: MailEndpoint;
  smtp: MailEndpoint;
  /** 'required' with 2FA (Gmail, Yahoo, iCloud, …), 'recommended', or 'no'. */
  appPassword: 'required' | 'recommended' | 'no';
  /** Where / how to create the app password (English). */
  help: string;
  /** The provider files sent mail into Sent by itself (no IMAP append needed). */
  savesSent: boolean;
  /** Plain (non-TLS) connections allowed: only a local bridge. */
  allowInsecure?: boolean;
}

export const MAIL_PRESETS: readonly MailPreset[] = [
  {
    id: 'gmail', label: 'Gmail / Google Workspace', domains: ['gmail.com', 'googlemail.com'],
    imap: { host: 'imap.gmail.com', port: 993, secure: true }, smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    appPassword: 'required', savesSent: true,
    help: 'Turn on 2-Step Verification, then create an app password at https://myaccount.google.com/apppasswords (IMAP must be enabled in Gmail settings → Forwarding and POP/IMAP).',
  },
  {
    id: 'outlook', label: 'Outlook.com / Hotmail / Live', domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'],
    imap: { host: 'outlook.office365.com', port: 993, secure: true }, smtp: { host: 'smtp-mail.outlook.com', port: 587, secure: false },
    appPassword: 'recommended', savesSent: true,
    help: 'Microsoft is retiring password sign-in for IMAP/SMTP: use an OAuth2 access token (--oauth-token) or, while still offered, an app password from https://account.live.com/proofs/AppPassword (needs 2-step verification).',
  },
  {
    id: 'office365', label: 'Microsoft 365 (work / school)', domains: [],
    imap: { host: 'outlook.office365.com', port: 993, secure: true }, smtp: { host: 'smtp.office365.com', port: 587, secure: false },
    appPassword: 'recommended', savesSent: true,
    help: 'Your admin must allow IMAP and SMTP AUTH for the mailbox. Most tenants require OAuth2 (--oauth-token); some still allow app passwords (https://mysignins.microsoft.com/security-info).',
  },
  {
    id: 'yahoo', label: 'Yahoo Mail', domains: ['yahoo.com', 'ymail.com', 'rocketmail.com'],
    imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true }, smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
    appPassword: 'required', savesSent: false,
    help: 'Create an app password: Account Info → Account security → Generate app password (https://login.yahoo.com/account/security).',
  },
  {
    id: 'icloud', label: 'iCloud Mail', domains: ['icloud.com', 'me.com', 'mac.com'],
    imap: { host: 'imap.mail.me.com', port: 993, secure: true }, smtp: { host: 'smtp.mail.me.com', port: 587, secure: false },
    appPassword: 'required', savesSent: false,
    help: 'Create an app-specific password at https://account.apple.com → Sign-In and Security → App-Specific Passwords. The user name is your full iCloud address.',
  },
  {
    id: 'yandex', label: 'Yandex Mail', domains: ['yandex.com', 'yandex.ru', 'ya.ru'],
    imap: { host: 'imap.yandex.com', port: 993, secure: true }, smtp: { host: 'smtp.yandex.com', port: 465, secure: true },
    appPassword: 'required', savesSent: false,
    help: 'Allow IMAP in Mail settings → Mail clients, then create an app password at https://id.yandex.com/security/app-passwords.',
  },
  {
    id: 'zoho', label: 'Zoho Mail', domains: ['zoho.com', 'zohomail.com'],
    imap: { host: 'imap.zoho.com', port: 993, secure: true }, smtp: { host: 'smtp.zoho.com', port: 465, secure: true },
    appPassword: 'recommended', savesSent: false,
    help: 'Enable IMAP access in Zoho Mail settings; with 2FA create an application-specific password at https://accounts.zoho.com → Security → App Passwords. (EU accounts: imap.zoho.eu / smtp.zoho.eu — use custom.)',
  },
  {
    id: 'fastmail', label: 'Fastmail', domains: ['fastmail.com', 'fastmail.fm'],
    imap: { host: 'imap.fastmail.com', port: 993, secure: true }, smtp: { host: 'smtp.fastmail.com', port: 465, secure: true },
    appPassword: 'required', savesSent: false,
    help: 'Create an app password with IMAP + SMTP access: Settings → Privacy & Security → Connected apps & API tokens → App passwords.',
  },
  {
    id: 'aol', label: 'AOL Mail', domains: ['aol.com'],
    imap: { host: 'imap.aol.com', port: 993, secure: true }, smtp: { host: 'smtp.aol.com', port: 465, secure: true },
    appPassword: 'required', savesSent: false,
    help: 'Create an app password: Account Security → Generate app password (https://login.aol.com/account/security).',
  },
  {
    id: 'gmx', label: 'GMX', domains: ['gmx.com', 'gmx.net', 'gmx.de'],
    imap: { host: 'imap.gmx.com', port: 993, secure: true }, smtp: { host: 'mail.gmx.com', port: 587, secure: false },
    appPassword: 'recommended', savesSent: false,
    help: 'Enable POP3/IMAP access in GMX settings (E-Mail → POP3 & IMAP). With 2FA, create an application-specific password. (gmx.net/.de: imap.gmx.net / mail.gmx.net — use custom.)',
  },
  {
    id: 'proton-bridge', label: 'Proton Mail (via Proton Mail Bridge)', domains: ['proton.me', 'protonmail.com', 'pm.me'],
    imap: { host: '127.0.0.1', port: 1143, secure: false }, smtp: { host: '127.0.0.1', port: 1025, secure: false },
    appPassword: 'required', savesSent: true, allowInsecure: true,
    help: 'Proton has no direct IMAP: install and sign in to Proton Mail Bridge, then use the user name and BRIDGE password it shows (not your Proton password).',
  },
];

/** Every preset id, plus "custom" (enter the hosts yourself). */
export const MAIL_PRESET_IDS: readonly string[] = [...MAIL_PRESETS.map(p => p.id), 'custom'];

/** Aliases people type. */
const ALIASES: Record<string, string> = {
  google: 'gmail', gsuite: 'gmail', workspace: 'gmail', hotmail: 'outlook', live: 'outlook', microsoft: 'outlook',
  'outlook.com': 'outlook', m365: 'office365', o365: 'office365', 'microsoft365': 'office365', 'office-365': 'office365',
  apple: 'icloud', proton: 'proton-bridge', protonmail: 'proton-bridge', 'proton-mail': 'proton-bridge',
};

/** A preset by id or alias (case-insensitive). Null for "custom" / unknown. */
export function getPreset(id: string | undefined | null): MailPreset | null {
  const k = String(id ?? '').trim().toLowerCase();
  if (!k) return null;
  const canonical = ALIASES[k] ?? k;
  return MAIL_PRESETS.find(p => p.id === canonical) ?? null;
}

/** Guess the preset from an email address's domain. PURE. */
export function detectPreset(email: string): MailPreset | null {
  const domain = String(email ?? '').trim().toLowerCase().split('@')[1] ?? '';
  if (!domain) return null;
  return MAIL_PRESETS.find(p => p.domains.includes(domain)) ?? null;
}

/** Short Persian note on app passwords, shown next to the English help. */
export const APP_PASSWORD_NOTE_FA =
  'برای Gmail، Yahoo، iCloud و بیشتر سرویس‌ها با تأیید دومرحله‌ای، باید «App Password» بسازید و همان را وارد کنید (نه رمز اصلی حساب).';
