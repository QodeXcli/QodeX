/**
 * Telegram message formatting for QodeX: HTML escaping, EN/FA localization,
 * approval cards + inline keyboards, mission/status summaries, notifications.
 *
 * Everything here is PURE (no I/O) so it is unit-testable and the bot stays
 * thin. Messages use Telegram's HTML parse mode; EVERY dynamic string (page
 * titles, prompts, mission goals, URLs) goes through `escapeHtml` — page text
 * is attacker-controlled and must not be able to inject markup or links.
 * Text that originates on this machine (approval prompts like `Run: <cmd>`,
 * mission reports, tab URLs) also goes through `maskOutbound` first: it leaves
 * the machine via Telegram's servers, so card numbers, API keys, tokens and
 * `KEY=value` secrets are replaced with `[redacted:…]`.
 *
 * Language: Persian when the chat's `language_code` starts with 'fa' (or the
 * user chose it with /lang), else English.
 */

import { createHash } from 'crypto';
import type { InlineKeyboardMarkup } from './api.js';
import { detectSecrets } from '../../sentinel/policy.js';

export type Lang = 'en' | 'fa';

/** Telegram hard limits. */
export const MAX_MESSAGE_CHARS = 4096;
export const MAX_CAPTION_CHARS = 1024;
export const MAX_CALLBACK_BYTES = 64;

/** 'fa', 'fa-IR' → 'fa'; anything else → 'en'. */
export function langOf(code?: string | null): Lang {
  return typeof code === 'string' && code.trim().toLowerCase().startsWith('fa') ? 'fa' : 'en';
}

/** A UTF-16 surrogate without its partner. Telegram rejects such text ("must be encoded in UTF-8"). */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** Replace lone surrogates (broken page titles, cut emoji) with U+FFFD. PURE. */
export function wellFormed(s: string): string {
  return s.replace(LONE_SURROGATE, '�');
}

/** Escape text for Telegram HTML parse mode (& < > and " for attribute safety). */
export function escapeHtml(s: unknown): string {
  return wellFormed(String(s ?? ''))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Truncate to `max` chars with an ellipsis (counts UTF-16 units, like
 * Telegram). Never splits a surrogate pair: half an emoji is invalid UTF-8 and
 * Telegram would reject the WHOLE message — for an approval card that means the
 * human never sees it.
 */
export function truncate(s: unknown, max: number): string {
  const t = String(s ?? '');
  if (t.length <= max) return t;
  let cut = Math.max(0, max - 1);
  const c = t.charCodeAt(cut - 1);
  if (cut > 0 && c >= 0xd800 && c <= 0xdbff) cut--;
  return t.slice(0, cut).trimEnd() + '…';
}

/** Escape + truncate in one step (truncate first so we never cut an entity). */
export function esc(s: unknown, max = 500): string {
  return escapeHtml(truncate(s, max));
}

/** Convert our HTML back to plain text (fallback when Telegram rejects the markup). */
export function htmlToPlain(html: string): string {
  let text = String(html ?? '').replace(/<br\s*\/?>/gi, '\n');
  // Repeat until stable: removing one tag must not splice a new one together ("<<b>b>").
  for (let prev = ''; prev !== text;) { prev = text; text = text.replace(/<[^<>]*>/g, ''); }
  // Our markup escapes every literal < and >, so any left over is a stray tag fragment.
  return text
    .replace(/[<>]/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/** `Authorization: Bearer <token>` and friends. */
const AUTH_HEADER_SECRET = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{12,}/g;
/** `OPENAI_API_KEY=...`, `--password=...`, `"token": "..."` (key names that hold secrets). */
const ASSIGNED_SECRET = /\b([A-Za-z0-9_-]*(?:api[_-]?key|access[_-]?key|token|secret|passw(?:or)?d|pwd|authorization|credentials?)["']?)(\s*[=:]\s*)(["']?)([^\s"'&;|,]{6,})/gi;

/**
 * Mask secrets in text that is about to leave this machine through Telegram's
 * servers (approval prompts such as `Run: <shell command>`, mission reports,
 * URLs): card numbers, IBAN/Sheba, API keys, JWTs, credentials in URLs (the
 * Sentinel detector), bearer tokens and `KEY=value` style assignments. PURE.
 * Persian digits elsewhere in the text are left as they are.
 */
export function maskOutbound(text: unknown): string {
  let s = String(text ?? '');
  if (!s) return s;
  for (let guard = 0; guard < 20; guard++) {
    // Indices refer to a digit-normalized copy of the same length (1:1 mapping).
    const f = detectSecrets(s)[0];
    if (!f) break;
    s = s.slice(0, f.index) + `[redacted:${f.kind}]` + s.slice(f.index + f.length);
  }
  return s
    .replace(AUTH_HEADER_SECRET, (_m, scheme: string) => `${scheme} [redacted]`)
    .replace(ASSIGNED_SECRET, (m, key: string, sep: string, quote: string, value: string) =>
      value.startsWith('[redacted') ? m : `${key}${sep}${quote}[redacted]`);
}

/** Query parameters that carry access keys (the control center's `?k=` link, OAuth...). */
const SECRET_URL_PARAMS = /^(k|key|token|access_token|id_token|auth|apikey|api_key|password|secret|sig|signature)$/i;

/**
 * Drop credentials from a URL before it leaves the machine: userinfo and
 * key-like query parameters (a mission's live view is
 * `http://127.0.0.1:<port>/?k=<control-center token>`). PURE.
 */
export function redactUrlSecrets(url: string): string {
  const raw = String(url ?? '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    for (const name of [...u.searchParams.keys()]) {
      if (SECRET_URL_PARAMS.test(name)) u.searchParams.delete(name);
    }
    return u.toString();
  } catch {
    return raw.replace(/[?#].*$/s, '');
  }
}

/** Persian digits for display in FA messages. */
export function faDigits(s: string | number): string {
  return String(s).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
}

function num(lang: Lang, n: number | string): string {
  return lang === 'fa' ? faDigits(n) : String(n);
}

// ── string catalog ───────────────────────────────────────────────────────────

const EN = {
  startUnpaired:
    '👋 This is a private <b>QodeX</b> bot.\n' +
    'To connect this chat, run <code>qodex telegram pair</code> on your computer, then send ' +
    '<code>/pair 123456</code> here with the code it prints.',
  pairUsage: 'Send <code>/pair &lt;code&gt;</code> with the 6-digit code printed by <code>qodex telegram pair</code>.',
  pairOk: '✅ <b>Paired!</b> This chat will receive approval requests and mission updates.\nSend /help to see what I can do.',
  pairAlready: 'ℹ️ This chat is already paired. Send /help.',
  pairInvalid: '❌ That code is invalid or expired. Run <code>qodex telegram pair</code> to get a new one.',
  pairLocked: '⛔ Too many wrong codes from this chat. Wait an hour, then generate a new code.',
  privateOnly: '🔒 For safety I only pair with private chats. Message me directly.',
  notPaired:
    '🔒 This chat is not paired. Run <code>qodex telegram pair</code> on your computer and send ' +
    '<code>/pair &lt;code&gt;</code> here.',
  help:
    '<b>QodeX remote control</b>\n' +
    '/status — browser + active missions (or <code>/status &lt;id&gt;</code>)\n' +
    '/missions — recent missions\n' +
    '/mission &lt;goal&gt; — start a background mission\n' +
    '/cancel &lt;id&gt; — cancel a mission\n' +
    '/screen — screenshot of the agent\'s browser\n' +
    '/approvals — pending approvals\n' +
    '/lang fa|en — switch language\n' +
    '/unpair — disconnect this chat\n' +
    '/help — this message\n\n' +
    'Approval requests arrive here with buttons; you can also reply <i>yes</i> / <i>no</i> to them.',
  unknownCommand: 'Unknown command. Send /help.',
  plainText: 'I only understand commands here. Send /help.',
  unpaired: '👋 This chat is disconnected from QodeX. Run <code>qodex telegram pair</code> to connect again.',
  langSet: '✅ Language set to English.',
  langUsage: 'Usage: <code>/lang fa</code> or <code>/lang en</code>',
  missionsUnavailable: 'Missions are not available in this QodeX process.',
  missionUsage: 'Usage: <code>/mission &lt;goal&gt;</code> — e.g. <code>/mission compare prices for a 27" monitor and report the best 3</code>',
  missionStarted: (id: string, goal: string) =>
    `🚀 Mission <code>${esc(id, 80)}</code> started:\n<i>${esc(goal, 600)}</i>\n\nI'll message you on milestones and when it finishes. Cancel: <code>/cancel ${esc(id, 80)}</code>`,
  missionStartFailed: (err: string) => `❌ Could not start the mission: ${esc(err, 600)}`,
  cancelUsage: 'Usage: <code>/cancel &lt;mission id&gt;</code>',
  cancelOk: (id: string) => `⛔ Cancellation requested for <code>${esc(id, 80)}</code>.`,
  cancelFailed: (id: string) => `Could not cancel <code>${esc(id, 80)}</code> (unknown or already finished).`,
  missionNotFound: (id: string) => `No mission matches <code>${esc(id, 80)}</code>.`,
  missionAmbiguous: (id: string) => `<code>${esc(id, 80)}</code> matches several missions — use more characters.`,
  noMissions: 'No missions yet. Start one with <code>/mission &lt;goal&gt;</code>.',
  missionsHeader: '<b>Recent missions</b>',
  activeMissions: (n: number) => `🎯 Missions: <b>${n}</b> active`,
  noActiveMissions: '🎯 No active missions.',
  browserNone: '🌐 Browser: not running in this process.',
  browserRunning: (mode: string, headless: boolean, profile: string, tabs: number) =>
    `🌐 Browser: running (${esc(mode, 20)}, ${headless ? 'headless' : 'visible'}, profile <code>${esc(profile, 60)}</code>) — ${tabs} tab(s)`,
  takeover: (by: string) => `🖐 A human has taken over the browser (${esc(by, 40)}).`,
  approvalsPending: (n: number) => `⏳ Approvals pending: <b>${n}</b>`,
  noApprovals: '✅ No pending approvals.',
  screenNone: '🌐 No browser is running in this QodeX process.',
  screenFailed: (err: string) => `❌ Screenshot failed: ${esc(err, 400)}`,
  approvalTitle: 'Approval needed',
  approvalFrom: 'From',
  approvalMission: 'Mission',
  approvalRisk: 'risk',
  approvalHint: 'Tap a button, or reply to this message with <i>yes</i> / <i>no</i>.',
  approvalAnswerHint: (opts: string[]) => `Please answer with one of: ${opts.map((o) => `<code>${esc(o, 40)}</code>`).join(' / ')}`,
  approvalExpired: 'This approval is no longer pending.',
  approvalRetry: 'Could not record your answer — please try again.',
  approvalRecorded: (opt: string) => `✓ ${truncate(optionLabelText(opt, 'en'), 60)}`,
  notAuthorized: 'Not authorized.',
  newChatPaired: (who: string, chatId: number) =>
    `🔔 A new chat was just paired with this QodeX: <b>${esc(who, 80)}</b>.\n` +
    `If that wasn't you, run <code>qodex telegram unpair ${chatId}</code> on your computer now.`,
  outcomeApproved: 'Approved',
  outcomeDenied: 'Denied',
  outcomeAnswered: 'Answered',
  outcomeTimeout: 'Timed out — denied automatically',
  outcomeCancelled: 'Cancelled — denied automatically',
  outcomeElsewhere: 'No longer pending (answered elsewhere)',
  via: 'via',
  suppressed: (n: number) => `(${n} earlier notification(s) were skipped to avoid flooding.)`,
  milestone: 'Milestone',
  missionCompleted: 'Mission completed',
  missionFailed: 'Mission failed',
  missionCancelled: 'Mission cancelled',
  missionPaused: 'Mission paused',
  sentinelBlocked: 'Sentinel blocked an action',
  stepsHeader: 'Steps',
  lastMilestones: 'Latest',
  report: 'Report',
  error: 'Error',
  cost: 'Cost',
  live: 'Live view',
} as const;

type Catalog = { [K in keyof typeof EN]: (typeof EN)[K] extends (...a: infer A) => string ? (...a: A) => string : string };

const FA: Catalog = {
  startUnpaired:
    '👋 این ربات خصوصیِ <b>QodeX</b> است.\n' +
    'برای اتصال این گفتگو، روی کامپیوترتان <code>qodex telegram pair</code> را اجرا کنید و کدی را که نشان می‌دهد ' +
    'این‌جا به شکل <code>/pair 123456</code> بفرستید.',
  pairUsage: 'کد ۶ رقمی‌ای را که <code>qodex telegram pair</code> نشان می‌دهد به شکل <code>/pair &lt;کد&gt;</code> بفرستید.',
  pairOk: '✅ <b>اتصال برقرار شد!</b> درخواست‌های تأیید و گزارش مأموریت‌ها به این گفتگو فرستاده می‌شود.\nبرای دیدن دستورها /help را بفرستید.',
  pairAlready: 'ℹ️ این گفتگو از قبل متصل است. /help را بفرستید.',
  pairInvalid: '❌ این کد نامعتبر است یا منقضی شده. با <code>qodex telegram pair</code> یک کد تازه بگیرید.',
  pairLocked: '⛔ تعداد کدهای اشتباه از این گفتگو زیاد است. یک ساعت صبر کنید و بعد کد تازه‌ای بسازید.',
  privateOnly: '🔒 برای امنیت فقط با گفتگوی خصوصی متصل می‌شوم. مستقیم به من پیام بدهید.',
  notPaired:
    '🔒 این گفتگو متصل نیست. روی کامپیوترتان <code>qodex telegram pair</code> را اجرا کنید و این‌جا ' +
    '<code>/pair &lt;کد&gt;</code> را بفرستید.',
  help:
    '<b>کنترل از راه دور QodeX</b>\n' +
    '/status — وضعیت مرورگر و مأموریت‌های فعال (یا <code>/status &lt;شناسه&gt;</code>)\n' +
    '/missions — مأموریت‌های اخیر\n' +
    '/mission &lt;هدف&gt; — شروع یک مأموریت در پس‌زمینه\n' +
    '/cancel &lt;شناسه&gt; — لغو مأموریت\n' +
    '/screen — تصویر صفحهٔ مرورگرِ عامل\n' +
    '/approvals — درخواست‌های تأیید در انتظار\n' +
    '/lang fa|en — تغییر زبان\n' +
    '/unpair — قطع اتصال این گفتگو\n' +
    '/help — همین راهنما\n\n' +
    'درخواست‌های تأیید با دکمه این‌جا می‌آیند؛ می‌توانید به آن‌ها با <i>بله</i> یا <i>خیر</i> هم پاسخ بدهید.',
  unknownCommand: 'دستور ناشناخته است. /help را بفرستید.',
  plainText: 'این‌جا فقط دستورها را می‌فهمم. /help را بفرستید.',
  unpaired: '👋 اتصال این گفتگو به QodeX قطع شد. برای اتصال دوباره <code>qodex telegram pair</code> را اجرا کنید.',
  langSet: '✅ زبان روی فارسی تنظیم شد.',
  langUsage: 'نحوهٔ استفاده: <code>/lang fa</code> یا <code>/lang en</code>',
  missionsUnavailable: 'مأموریت‌ها در این پردازشِ QodeX در دسترس نیستند.',
  missionUsage: 'نحوهٔ استفاده: <code>/mission &lt;هدف&gt;</code> — مثلاً <code>/mission قیمت سه مانیتور ۲۷ اینچ را مقایسه کن</code>',
  missionStarted: (id: string, goal: string) =>
    `🚀 مأموریت <code>${esc(id, 80)}</code> شروع شد:\n<i>${esc(goal, 600)}</i>\n\nدر نقاط مهم و پایان کار به شما خبر می‌دهم. برای لغو: <code>/cancel ${esc(id, 80)}</code>`,
  missionStartFailed: (err: string) => `❌ شروع مأموریت ممکن نشد: ${esc(err, 600)}`,
  cancelUsage: 'نحوهٔ استفاده: <code>/cancel &lt;شناسهٔ مأموریت&gt;</code>',
  cancelOk: (id: string) => `⛔ درخواست لغو برای <code>${esc(id, 80)}</code> ثبت شد.`,
  cancelFailed: (id: string) => `لغو <code>${esc(id, 80)}</code> ممکن نشد (ناشناخته است یا تمام شده).`,
  missionNotFound: (id: string) => `مأموریتی با شناسهٔ <code>${esc(id, 80)}</code> پیدا نشد.`,
  missionAmbiguous: (id: string) => `<code>${esc(id, 80)}</code> با چند مأموریت جور درمی‌آید — حروف بیشتری بنویسید.`,
  noMissions: 'هنوز مأموریتی نیست. با <code>/mission &lt;هدف&gt;</code> یکی شروع کنید.',
  missionsHeader: '<b>مأموریت‌های اخیر</b>',
  activeMissions: (n: number) => `🎯 مأموریت‌های فعال: <b>${faDigits(n)}</b>`,
  noActiveMissions: '🎯 مأموریت فعالی نیست.',
  browserNone: '🌐 مرورگر: در این پردازش اجرا نمی‌شود.',
  browserRunning: (mode: string, headless: boolean, profile: string, tabs: number) =>
    `🌐 مرورگر: در حال اجرا (${esc(mode, 20)}، ${headless ? 'بی‌نما' : 'قابل مشاهده'}، پروفایل <code>${esc(profile, 60)}</code>) — ${faDigits(tabs)} زبانه`,
  takeover: (by: string) => `🖐 کنترل مرورگر دست انسان است (${esc(by, 40)}).`,
  approvalsPending: (n: number) => `⏳ تأییدهای در انتظار: <b>${faDigits(n)}</b>`,
  noApprovals: '✅ تأییدی در انتظار نیست.',
  screenNone: '🌐 هیچ مرورگری در این پردازشِ QodeX اجرا نمی‌شود.',
  screenFailed: (err: string) => `❌ گرفتن تصویر ممکن نشد: ${esc(err, 400)}`,
  approvalTitle: 'نیاز به تأیید',
  approvalFrom: 'از طرف',
  approvalMission: 'مأموریت',
  approvalRisk: 'ریسک',
  approvalHint: 'یکی از دکمه‌ها را بزنید یا به همین پیام با <i>بله</i> یا <i>خیر</i> پاسخ بدهید.',
  approvalAnswerHint: (opts: string[]) => `لطفاً یکی از این‌ها را بفرستید: ${opts.map((o) => `<code>${esc(o, 40)}</code>`).join(' / ')}`,
  approvalExpired: 'این درخواست دیگر در انتظار نیست.',
  approvalRetry: 'ثبت پاسخ شما ممکن نشد — لطفاً دوباره امتحان کنید.',
  approvalRecorded: (opt: string) => `✓ ${truncate(optionLabelText(opt, 'fa'), 60)}`,
  notAuthorized: 'اجازهٔ دسترسی ندارید.',
  newChatPaired: (who: string, chatId: number) =>
    `🔔 یک گفتگوی تازه همین حالا به این QodeX متصل شد: <b>${esc(who, 80)}</b>.\n` +
    `اگر کار شما نبود، همین الان روی کامپیوترتان <code>qodex telegram unpair ${chatId}</code> را اجرا کنید.`,
  outcomeApproved: 'تأیید شد',
  outcomeDenied: 'رد شد',
  outcomeAnswered: 'پاسخ داده شد',
  outcomeTimeout: 'مهلت تمام شد — خودکار رد شد',
  outcomeCancelled: 'لغو شد — خودکار رد شد',
  outcomeElsewhere: 'دیگر در انتظار نیست (جای دیگری پاسخ داده شد)',
  via: 'از طریق',
  suppressed: (n: number) => `(${faDigits(n)} اعلان قبلی برای جلوگیری از شلوغی فرستاده نشد.)`,
  milestone: 'پیشرفت',
  missionCompleted: 'مأموریت تمام شد',
  missionFailed: 'مأموریت شکست خورد',
  missionCancelled: 'مأموریت لغو شد',
  missionPaused: 'مأموریت متوقف شد',
  sentinelBlocked: 'نگهبان (Sentinel) جلوی یک کار را گرفت',
  stepsHeader: 'مراحل',
  lastMilestones: 'آخرین پیشرفت‌ها',
  report: 'گزارش',
  error: 'خطا',
  cost: 'هزینه',
  live: 'نمای زنده',
};

const CATALOGS: Record<Lang, Catalog> = { en: EN as unknown as Catalog, fa: FA };

/** Localized string table for `lang`. */
export function strings(lang: Lang): Catalog {
  return CATALOGS[lang] ?? CATALOGS.en;
}

// ── categories, risks, statuses ──────────────────────────────────────────────

const CATEGORY_FA: Record<string, string> = {
  purchase: 'خرید', payment: 'پرداخت', send: 'ارسال', credential: 'اطلاعات ورود', delete: 'حذف',
  publish: 'انتشار', account: 'حساب کاربری', download: 'دانلود', upload: 'آپلود', navigation: 'باز کردن سایت',
  desktop: 'کنترل دسکتاپ', other: 'سایر',
};
const RISK_FA: Record<string, string> = { low: 'کم', medium: 'متوسط', high: 'زیاد', critical: 'بحرانی' };
const STATUS_FA: Record<string, string> = {
  planning: 'برنامه‌ریزی', running: 'در حال اجرا', paused: 'متوقف', awaiting_approval: 'منتظر تأیید',
  completed: 'تمام شد', failed: 'شکست خورد', cancelled: 'لغو شد', pending: 'در صف', done: 'انجام شد', skipped: 'رد شد',
};
const STATUS_ICON: Record<string, string> = {
  planning: '🧭', running: '▶️', paused: '⏸', awaiting_approval: '⏳', completed: '✅', failed: '❌',
  cancelled: '⛔', pending: '•', done: '✅', skipped: '↷',
};

export function categoryLabel(category: string | undefined, lang: Lang): string {
  if (!category) return '';
  return lang === 'fa' ? (CATEGORY_FA[category] ?? category) : category;
}
export function riskLabel(risk: string | undefined, lang: Lang): string {
  if (!risk) return '';
  return lang === 'fa' ? (RISK_FA[risk] ?? risk) : risk;
}
export function statusLabel(status: string, lang: Lang): string {
  return lang === 'fa' ? (STATUS_FA[status] ?? status) : status.replace(/_/g, ' ');
}
export function statusIcon(status: string): string {
  return STATUS_ICON[status] ?? '•';
}

/** Statuses that mean "still going" (shown under /status). */
export const ACTIVE_MISSION_STATUSES = new Set(['planning', 'running', 'paused', 'awaiting_approval']);

// ── approvals ────────────────────────────────────────────────────────────────

export interface ApprovalCardInput {
  id: string;
  prompt: string;
  options: string[];
  category?: string;
  risk?: string;
  source?: string;
  missionId?: string;
}

/** Text shown on an approval button. */
export function optionLabelText(option: string, lang: Lang): string {
  const o = option.trim().toLowerCase();
  if (/^(y|yes|approve|allow|accept|confirm)$/.test(o)) return lang === 'fa' ? 'بله' : 'Yes';
  if (/^(n|no|deny|reject|cancel|block)$/.test(o)) return lang === 'fa' ? 'خیر' : 'No';
  if (o === 'always') return lang === 'fa' ? 'همیشه' : 'Always';
  return option;
}

export function optionLabel(option: string, lang: Lang): string {
  const o = option.trim().toLowerCase();
  const text = optionLabelText(option, lang);
  if (/^(y|yes|approve|allow|accept|confirm)/.test(o)) return `✅ ${text}`;
  if (/^(n|no|deny|reject|cancel|block|stop|skip)/.test(o)) return `❌ ${text}`;
  if (o === 'always') return `♾ ${text}`;
  return truncate(text, 40);
}

/** `ap:<id>:<index>`; returns null when it would exceed Telegram's 64-byte limit. */
export function buildCallbackData(id: string, index: number): string | null {
  const data = `ap:${id}:${index}`;
  return Buffer.byteLength(data, 'utf-8') <= MAX_CALLBACK_BYTES ? data : null;
}

/** Loosen a typed reply for answer matching: Arabic ي/ك → Persian ی/ک, no diacritics/ZWNJ, no trailing "." / "!" / "؛". PURE. */
export function normalizeReplyText(text: string): string {
  return String(text ?? '')
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[ً-ٰ‌]/g, '')
    .trim()
    .replace(/[.!؛]+$/u, '')
    .trim();
}

/**
 * Callback alias for approval ids that don't fit `ap:<id>:<i>` in 64 bytes (or
 * contain ':'). Derived from the id itself, NOT a counter: a counter restarts
 * at 1 in a new process, so a button on a card from a previous run (`ap:~1:0`)
 * would silently answer whatever approval got `~1` this time. PURE.
 */
export function approvalAlias(id: string): string {
  return '~' + createHash('sha256').update(id).digest('base64url').slice(0, 20);
}

export function parseCallbackData(data: string | undefined): { id: string; index: number } | null {
  const m = /^ap:([^:]{1,60}):(\d{1,3})$/.exec(String(data ?? ''));
  if (!m) return null;
  return { id: m[1], index: Number(m[2]) };
}

/** Inline keyboard: one button per option (≤3 on one row, else rows of 2). `callbackId` may be an alias. */
export function approvalKeyboard(callbackId: string, options: string[], lang: Lang): InlineKeyboardMarkup {
  const buttons = options.slice(0, 8).map((o, i) => ({
    text: optionLabel(o, lang),
    callback_data: buildCallbackData(callbackId, i) ?? `ap:invalid:${i}`,
  }));
  // Telegram rejects an empty row, which would make the card undeliverable.
  const rows = buttons.length === 0 ? [] : buttons.length <= 3 ? [buttons] : chunk(buttons, 2);
  return { inline_keyboard: rows };
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** The approval card text (without the outcome). */
export function formatApproval(a: ApprovalCardInput, lang: Lang): string {
  const S = strings(lang);
  const head: string[] = [`🔐 <b>${S.approvalTitle}</b>`];
  if (a.category) head.push(`<i>${esc(categoryLabel(a.category, lang), 40)}</i>`);
  if (a.risk) head.push(`${S.approvalRisk}: <b>${esc(riskLabel(a.risk, lang), 20)}</b>`);
  const lines = [head.join(' · ')];
  if (a.missionId) lines.push(`🎯 ${S.approvalMission}: <code>${esc(a.missionId, 80)}</code>`);
  else if (a.source) lines.push(`${S.approvalFrom}: <code>${esc(a.source, 80)}</code>`);
  lines.push('', esc(maskOutbound(a.prompt), 3000));
  return lines.join('\n');
}

export function formatApprovalWithHint(a: ApprovalCardInput, lang: Lang): string {
  return `${formatApproval(a, lang)}\n\n${strings(lang).approvalHint}`;
}

const CHANNEL_NAMES: Record<string, { en: string; fa: string }> = {
  telegram: { en: 'Telegram', fa: 'تلگرام' },
  control: { en: 'control center', fa: 'مرکز کنترل' },
  local: { en: 'terminal', fa: 'ترمینال' },
  'mission-db': { en: 'mission queue', fa: 'صف مأموریت' },
};

function channelName(by: string, lang: Lang): string {
  const base = by.split(':')[0];
  const known = CHANNEL_NAMES[base];
  return known ? known[lang] : by;
}

/**
 * `by` values that mean nobody answered: the run was aborted, the mission ended
 * or its worker died, no channel could ask... (broker + mission-DB reasons).
 */
const AUTO_DENIED_BY = new Set([
  'abort', 'reset', 'cancel', 'cancelled', 'expired', 'worker-exited', 'mission-ended', 'local-error', 'fallback',
]);

/** One line describing how an approval ended. */
export function formatOutcome(result: { answer?: string; by?: string; approved?: boolean } | null, options: string[], lang: Lang): string {
  const S = strings(lang);
  if (!result || !result.by) return `⚪ ${S.outcomeElsewhere}`;
  if (result.by === 'timeout') return `⌛ ${S.outcomeTimeout}`;
  if (AUTO_DENIED_BY.has(result.by)) return `⚪ ${S.outcomeCancelled}`;
  const answer = String(result.answer ?? '');
  const approved = result.approved ?? isApprovingAnswer(answer, options);
  const denied = !approved && isDenyingAnswer(answer);
  const icon = approved ? '✅' : denied ? '⛔' : '☑️';
  const word = approved ? S.outcomeApproved : denied ? S.outcomeDenied : S.outcomeAnswered;
  const shown = esc(optionLabelText(answer, lang), 60);
  const quoted = lang === 'fa' ? `«${shown}»` : `"${shown}"`;
  return `${icon} ${word} — ${quoted} ${S.via} ${esc(channelName(result.by, lang), 60)}`;
}

function isApprovingAnswer(answer: string, _options: string[]): boolean {
  return /^(y|approve|allow|accept|confirm|always)/i.test(answer.trim());
}
function isDenyingAnswer(answer: string): boolean {
  return /^(n|deny|reject|cancel|block|skip|stop)/i.test(answer.trim());
}

/** Approval card + outcome footer (used when editing the message after it is answered). */
export function formatResolvedApproval(a: ApprovalCardInput, outcomeLine: string, lang: Lang): string {
  return `${formatApproval(a, lang)}\n\n${outcomeLine}`;
}

// ── missions ─────────────────────────────────────────────────────────────────

export interface MissionSummaryView {
  id: string;
  goal: string;
  status: string;
  progress?: string;
  liveUrl?: string;
}

export interface MissionStatusView extends MissionSummaryView {
  steps?: Array<{ title: string; status: string }>;
  milestones?: string[];
  pendingApprovals?: number;
  report?: string;
  error?: string;
  costUsd?: number;
}

export function formatMissionLine(m: MissionSummaryView, lang: Lang): string {
  const progress = m.progress ? ` · ${esc(m.progress, 40)}` : '';
  return `${statusIcon(m.status)} <code>${esc(m.id, 40)}</code> ${esc(statusLabel(m.status, lang), 30)}${progress}\n   ${esc(maskOutbound(m.goal), 140)}`;
}

export function formatMissionList(list: MissionSummaryView[], lang: Lang): string {
  const S = strings(lang);
  if (!list.length) return S.noMissions;
  return [S.missionsHeader, ...list.slice(0, 15).map((m) => formatMissionLine(m, lang))].join('\n');
}

/**
 * Full mission status. Every section is capped so that, even with all of them
 * at their maximum, the message stays under Telegram's 4096-char limit (an
 * over-long one would only arrive as unformatted plain text); the report gets
 * whatever room is left.
 */
export function formatMissionStatus(m: MissionStatusView, lang: Lang): string {
  const S = strings(lang);
  const lines = [
    `${statusIcon(m.status)} <b>${esc(statusLabel(m.status, lang), 30)}</b> · <code>${esc(m.id, 60)}</code>`,
    `<i>${esc(maskOutbound(m.goal), 400)}</i>`,
  ];
  if (m.steps?.length) {
    const shown = 12;
    lines.push('', `<b>${S.stepsHeader}</b>`);
    m.steps.slice(0, shown).forEach((s, i) => {
      lines.push(`${statusIcon(s.status)} ${num(lang, i + 1)}. ${esc(maskOutbound(s.title), 80)}`);
    });
    if (m.steps.length > shown) lines.push(`… +${num(lang, m.steps.length - shown)}`);
  }
  if (m.milestones?.length) {
    lines.push('', `<b>${S.lastMilestones}</b>`);
    for (const ms of m.milestones.slice(-5)) lines.push(`🏁 ${esc(maskOutbound(ms), 150)}`);
  }
  if (m.pendingApprovals) lines.push('', S.approvalsPending(m.pendingApprovals));
  if (typeof m.costUsd === 'number' && m.costUsd > 0) lines.push(`${S.cost}: $${m.costUsd.toFixed(m.costUsd < 1 ? 4 : 2)}`);
  // The live-view link carries the control center's access key: never send that to Telegram.
  if (m.liveUrl) lines.push(`${S.live}: ${esc(redactUrlSecrets(m.liveUrl), 200)}`);
  if (m.error) lines.push('', `<b>${S.error}:</b> ${esc(maskOutbound(m.error), 600)}`);
  if (m.report) {
    // The report gets whatever room is left under Telegram's 4096-character limit.
    const used = htmlToPlain(lines.join('\n')).length + S.report.length + 8;
    const room = Math.min(2000, MAX_MESSAGE_CHARS - 96 - used);
    if (room >= 120) lines.push('', `<b>${S.report}</b>`, esc(maskOutbound(m.report), room));
  }
  return lines.join('\n');
}

// ── status ───────────────────────────────────────────────────────────────────

export interface BrowserStatusView {
  running: boolean;
  mode: string;
  headless: boolean;
  profile: string;
  tabs: Array<{ title: string; url: string; active: boolean }>;
  takeover?: boolean;
  takeoverBy?: string;
}

export function formatStatus(input: {
  botUsername?: string;
  browser: BrowserStatusView | null;
  activeMissions: MissionSummaryView[] | null;
  pendingApprovals: number;
}, lang: Lang): string {
  const S = strings(lang);
  const lines = [`🤖 <b>QodeX</b>${input.botUsername ? ` · @${esc(input.botUsername, 64)}` : ''}`];
  const b = input.browser;
  if (!b || !b.running) {
    lines.push(S.browserNone);
  } else {
    lines.push(S.browserRunning(b.mode, b.headless, b.profile, b.tabs.length));
    const active = b.tabs.find((t) => t.active);
    if (active) lines.push(`   ▸ ${esc(maskOutbound(active.title || '(untitled)'), 80)}\n   ${esc(maskOutbound(active.url), 200)}`);
    if (b.takeover) lines.push(S.takeover(b.takeoverBy ?? 'control'));
  }
  if (input.activeMissions === null) {
    lines.push(`🎯 ${S.missionsUnavailable}`);
  } else if (!input.activeMissions.length) {
    lines.push(S.noActiveMissions);
  } else {
    lines.push(S.activeMissions(input.activeMissions.length));
    for (const m of input.activeMissions.slice(0, 10)) lines.push(formatMissionLine(m, lang));
  }
  lines.push(input.pendingApprovals ? S.approvalsPending(input.pendingApprovals) : S.noApprovals);
  return lines.join('\n');
}

/** Caption for a /screen photo: active tab title + URL. Telegram counts the
 *  1024-char caption limit AFTER entity parsing, so truncating the raw parts
 *  (≤ 200 + 1 + 700 chars) keeps it in bounds without cutting an entity. */
export function formatScreenCaption(title: string, url: string): string {
  return `${esc(maskOutbound(title || '(untitled)'), 200)}\n${esc(maskOutbound(url), 700)}`;
}

// ── notifications (bus / mission events) ────────────────────────────────────

export interface NoticeView {
  text: string;
  /** Terminal events (completed/failed/cancelled) bypass the rate limiter. */
  important: boolean;
  /** For state changes: the same mission reaching the same state twice (a 'status' event
   *  plus a bridged 'completed' event) is announced once. */
  dedupeKey?: string;
}

function pickStr(data: unknown, ...keys: string[]): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const d = data as Record<string, unknown>;
  for (const k of keys) {
    const v = d[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

function pickNum(data: unknown, key: string): number | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const v = (data as Record<string, unknown>)[key];
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/**
 * Turn a mission event into a notification, or null for noisy/internal ones
 * (step starts, tool summaries...). Tolerant of payload shapes.
 */
export function formatMissionNotice(missionId: string, type: string, data: unknown, lang: Lang): NoticeView | null {
  const S = strings(lang);
  const t = String(type ?? '').toLowerCase();
  const status = t === 'status' ? (pickStr(data, 'status', 'to') ?? '').toLowerCase() : t;
  const idHtml = `<code>${esc(missionId, 60)}</code>`;

  if (t === 'milestone') {
    const title = pickStr(data, 'title', 'message', 'text') ?? '';
    const detail = pickStr(data, 'detail', 'details');
    const progress = pickNum(data, 'progress');
    const pct = progress !== undefined ? ` (${num(lang, Math.round(progress <= 1 && progress > 0 ? progress * 100 : progress))}%)` : '';
    const body = [`🏁 <b>${S.milestone}</b> · ${idHtml}${pct}`, esc(maskOutbound(title), 400)];
    if (detail) body.push(`<i>${esc(maskOutbound(detail), 600)}</i>`);
    return { text: body.join('\n'), important: false };
  }
  if (status === 'completed' || status === 'done' || status === 'finished' || status === 'success') {
    const report = pickStr(data, 'report', 'summary', 'result', 'message');
    return { text: `✅ <b>${S.missionCompleted}</b> · ${idHtml}${report ? `\n${esc(maskOutbound(report), 2500)}` : ''}`, important: true, dedupeKey: 'completed' };
  }
  if (status === 'failed') {
    const err = pickStr(data, 'error', 'reason', 'message');
    return { text: `❌ <b>${S.missionFailed}</b> · ${idHtml}${err ? `\n${esc(maskOutbound(err), 1500)}` : ''}`, important: true, dedupeKey: 'failed' };
  }
  if (status === 'cancelled' || status === 'canceled') {
    return { text: `⛔ <b>${S.missionCancelled}</b> · ${idHtml}`, important: true, dedupeKey: 'cancelled' };
  }
  if (status === 'paused') {
    const reason = pickStr(data, 'reason', 'message', 'error');
    return { text: `⏸ <b>${S.missionPaused}</b> · ${idHtml}${reason ? `\n${esc(maskOutbound(reason), 600)}` : ''}`, important: true, dedupeKey: 'paused' };
  }
  return null;
}

/** Sentinel decision → notification (only blocks/denials). */
export function formatSentinelNotice(type: string, data: unknown, lang: Lang): NoticeView | null {
  const S = strings(lang);
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, any>;
  // Tolerate both flat payloads ({action, classification}) and a SentinelDecision nested under `decision`.
  const dec = (d.decision && typeof d.decision === 'object' ? d.decision : {}) as Record<string, any>;
  const action = String(d.action ?? dec.action ?? (typeof d.decision === 'string' ? d.decision : '')).toLowerCase();
  const t = String(type ?? '').toLowerCase();
  const blocked = t === 'blocked' || t === 'deny' || t === 'denied'
    || (t === 'decision' && (action === 'deny' || action === 'blocked' || action === 'denied'));
  if (!blocked) return null;
  const classification = d.classification ?? dec.classification;
  const summary = pickStr(d, 'summary', 'message', 'reason')
    ?? pickStr(classification, 'summary', 'reason') ?? pickStr(dec, 'message') ?? '';
  const category = pickStr(d, 'category') ?? pickStr(classification, 'category');
  const tool = pickStr(d, 'tool', 'toolName');
  const head = `🛡 <b>${S.sentinelBlocked}</b>${category ? ` · <i>${esc(categoryLabel(category, lang), 40)}</i>` : ''}`;
  const lines = [head];
  if (summary) lines.push(esc(maskOutbound(summary), 600));
  if (tool) lines.push(`<code>${esc(tool, 60)}</code>`);
  return { text: lines.join('\n'), important: false };
}
