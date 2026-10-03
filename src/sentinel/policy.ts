/**
 * Sentinel policy — PURE classification of a tool call into an action category
 * and risk level. No I/O, no prompts: the guard (guard.ts) gathers context
 * (active tab URL, the element behind a ref, a workflow's steps) and decides
 * what to do with the classification.
 *
 * What is classified:
 *   - navigation (browser_navigate, browser_tabs new, browser_agent start_url,
 *     computer_use_open URLs): blocked/allowed domains, private network,
 *     dangerous schemes, QodeX's own secret stores (never navigable);
 *   - clicks / Enter / type-with-submit on page elements: the element's name,
 *     text, href, enclosing form action, plus the page URL, matched against
 *     English + Persian keyword lists for purchase, payment, send, delete and
 *     account actions;
 *   - typing (browser_type / browser_fill / browser_fill_form /
 *     computer_use_type): password fields, payment fields, and text that LOOKS
 *     like a secret (Luhn-valid card, Iranian card BINs, IBAN / Sheba, API keys,
 *     private keys, JWTs) → credential;
 *   - page scripts (browser_evaluate, browser_wait_for function predicates,
 *     javascript: URLs): a script that clicks /
 *     submits is judged like a click on what it selects (by selector words and
 *     the described target elements), so `.click()` can't route around the
 *     purchase guard; Space on a focused button is an activation too;
 *   - uploads, downloads, JS dialogs, desktop input, mutating HTTP requests,
 *     workflow replays and MCP tools (by the verb in their name);
 *   - file/shell tools touching the vault key, the vault or browser profiles —
 *     also via a bulk read (tar / rsync / grep -r / s3_sync) of ~/.qodex as a
 *     whole (hard block: those are the agent's credentials);
 *   - QodeX's own integrity (`integrity: true`, never auto-approved): changing
 *     its config / .env / approval stores (sessions.db, Telegram pairing, audit),
 *     CLI commands that change the vault or answer / open approval channels
 *     (`qodex mission approve`, `qodex control`, `qodex telegram pair`), and any
 *     use of the in-process control center (hard block) — the agent must never
 *     be able to approve its own actions.
 *
 * Risk: a category listed in `config.requireApproval` is CRITICAL (an explicit
 * human answer, never auto-approved by `/auto on` or `--yes`), otherwise the
 * category's base risk. Two deliberate exceptions keep the guard useful for a
 * coding agent: actions whose target is the local machine / private network
 * (a dev server on localhost) are never escalated to critical, and a few tools
 * have a FIXED risk because a stronger, specific guard already covers them
 * (browser_fill_secret is origin-bound in the vault tool; http_request is not
 * the user's logged-in browser) — unless the call carries something that looks
 * like a secret, which is escalated as credential exfiltration.
 *
 * Text matching is case-, ZWNJ-, diacritic- and Arabic/Persian-letter-form-
 * insensitive and folds Persian/Arabic digits to ASCII (same idea as
 * normalizeFaToken in src/skills/registry.ts).
 */

import * as os from 'os';
import * as path from 'path';
import { domainToASCII } from 'url';
import type { SentinelCategory, SentinelConfig } from '../config/agent-config.js';
import { QODEX_CONFIG_FILE, QODEX_HOME, QODEX_SESSION_DB } from '../config/defaults.js';
import {
  QODEX_BROWSER_PROFILES_DIR, QODEX_BROWSER_BOT_AUTH_DIR, QODEX_CHANNELS_DIR, QODEX_SENTINEL_DIR, QODEX_VAULT_FILE, QODEX_VAULT_KEY_FILE,
} from '../config/paths.js';
import type { ElementInfo } from '../tools/browser/types.js';
import { QODEX_GRANTS_FILE, QODEX_MAIL_AUTO_DIR } from '../grants/paths.js';
import type { MailSendResolution } from '../grants/mail-scope.js';
import { QODEX_MAIL_ACCOUNTS_FILE, QODEX_MAIL_DIR } from '../mail/paths.js';
import { describeOutgoingMail, formatOutgoingPrompt, summarizeOutgoingMail, type MailSendArgs } from '../mail/outgoing.js';
import { EXPORT_FILE_TEXT_RE, VAULT_KEY_ARTIFACTS, isPasswordExportFile } from '../vault/paths.js';
import type { ActionClassification, RiskLevel } from './types.js';

// ── public types ────────────────────────────────────────────────────────────

/** Minimal shape of a recorded workflow (src/workflows/types.ts) the policy can inspect. */
export interface WorkflowLike {
  name?: string;
  startUrl?: string;
  params?: Array<{ name?: string; secret?: boolean; default?: string; vaultField?: string }>;
  steps?: Array<{
    kind?: string; url?: string; selector?: string; ref?: string; role?: string; name?: string;
    text?: string; value?: string; values?: string[]; files?: string[]; key?: string; newTab?: boolean;
  }>;
}

/**
 * The control center running in THIS process (src/control/server.ts), if any.
 * It holds the approval queue and human takeover, so the agent must never
 * operate it — that would let it approve its own critical actions.
 */
export interface ControlCenterLike {
  port?: number;
  /** Access token (`?k=` / Bearer). */
  token?: string;
  /** Hosts it is reachable on (loopback, LAN IPs, tunnel host). */
  hosts?: string[];
}

export interface ProtectedPaths {
  /** Exact files the agent may never read/write/upload/navigate to. */
  files: string[];
  /** Directories (and everything below) with the same protection. */
  dirs: string[];
  /** Substrings that identify those locations inside free-form commands. */
  markers: string[];
  /**
   * QodeX's own configuration and approval trust stores (config.yaml, .env,
   * sessions.db with the mission approval queue). Reading is fine; CHANGING
   * them needs an explicit human answer, so injected page text can't get the
   * agent to switch Sentinel off or approve its own actions.
   */
  configFiles?: string[];
  /** Directories with the same write protection (Telegram pairing, the audit trail). */
  configDirs?: string[];
}

export interface PolicyContext {
  /** URL of the browser's active tab ('' / undefined when no browser). */
  url?: string;
  /** Element behind the call's ref/selector, if it could be described. */
  element?: ElementInfo | null;
  /** browser_fill_form: element info per field, keyed by the field's ref (or its selector when it has no ref). */
  elements?: Record<string, ElementInfo | null>;
  /** browser_dialog: the JavaScript dialog waiting on the active tab, if known. */
  dialog?: { type?: string; message?: string } | null;
  /** The control center running in this process, if any (never operable by the agent). */
  control?: ControlCenterLike | null;
  /** browser_evaluate / javascript: URLs: the elements the script selects (see scriptSelectors). */
  scriptTargets?: Array<ElementInfo | null>;
  config: SentinelConfig;
  /** Tool working directory, for resolving relative paths. */
  cwd?: string;
  /** workflow_run: the workflow about to be replayed (null = not found). */
  workflow?: WorkflowLike | null;
  /** Override the protected-path set (tests). */
  protectedPaths?: ProtectedPaths;
  /**
   * mail_send: what it would send — the mail core's description of the loaded draft /
   * arguments (resolved by the guard, src/grants/mail-scope.ts resolveMailSend).
   * undefined = not resolved; null = could not be read in time.
   */
  mail?: MailSendResolution | null;
}

export interface PolicyClassification extends ActionClassification {
  /** Hard policy block: the guard denies without asking anyone. */
  block?: boolean;
  /**
   * Guards QodeX's own integrity (its config, vault CLI, approval channels):
   * always a fresh human answer — `sentinel.autoApprove` does not apply.
   */
  integrity?: boolean;
  /** Extra lines for the approval prompt (mail_send: recipients, subject, body preview). */
  details?: string[];
}

// ── text normalization ──────────────────────────────────────────────────────

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** Fold Persian (۰-۹) and Arabic-Indic (٠-٩) digits to ASCII. PURE. */
export function toAsciiDigits(s: string): string {
  return String(s ?? '').replace(/[۰-۹٠-٩]/g, (c) => {
    const i = FA_DIGITS.indexOf(c);
    return String(i >= 0 ? i : AR_DIGITS.indexOf(c));
  });
}

/**
 * Normalize text for keyword matching: ASCII digits, NFKC, lowercase, Persian
 * letter forms (ي/ى→ی, ك→ک, ة/ۀ→ه, أ/إ→ا), no diacritics/tatweel, ZWNJ → space,
 * other invisible/bidi characters removed, whitespace collapsed. PURE.
 */
export function normalizeText(s: string): string {
  return toAsciiDigits(String(s ?? ''))
    .normalize('NFKC')
    .replace(/\u200C/g, ' ')
    .replace(/[\u200B\u200D-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\u00AD]/g, '')
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[ةۀ]/g, 'ه')
    .replace(/[أإ]/g, 'ا')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile one keyword into a boundary-aware regex over normalized text.
 * Latin: word boundary on both sides, words joined by optional separators
 * (so "place order" matches "place_order", "place-order", "placeorder"), and
 * simple English inflections (s/es/ed/ing). Persian: boundary before, attached
 * suffixes allowed after (ها، ی، ش ...) unless the keyword ends with "!".
 */
function compileKeyword(kw: string, flags = ''): RegExp {
  const exact = kw.endsWith('!');
  const norm = normalizeText(exact ? kw.slice(0, -1) : kw);
  if (/^[\x20-\x7e]+$/.test(norm)) {
    const parts = norm.split(/[\s-]+/).filter(Boolean).map(escapeRe);
    return new RegExp(`(?<![a-z0-9])${parts.join('[\\s_\\-./]*')}(?:s|es|ed|ing|d)?(?![a-z0-9])`, flags);
  }
  const parts = norm.split(' ').filter(Boolean).map(escapeRe);
  return new RegExp(`(?<![\\p{L}\\p{N}])${parts.join('\\s*')}${exact ? '(?![\\p{L}\\p{N}])' : ''}`, 'u' + flags);
}

interface CompiledList { source: string; re: RegExp; global: RegExp }
function compileList(list: string[]): CompiledList[] {
  return list.map(source => ({ source: source.replace(/!$/, ''), re: compileKeyword(source), global: compileKeyword(source, 'g') }));
}
function firstMatch(text: string, list: CompiledList[]): string | null {
  for (const k of list) if (k.re.test(text)) return k.source;
  return null;
}
/** Exclusion lists are applied longest phrase first ("افزودن به سبد خرید" before "افزودن به سبد"). */
function compileExcludes(list: string[]): CompiledList[] {
  return compileList(list).sort((a, b) => b.source.length - a.source.length);
}
function stripPhrases(text: string, excludes: CompiledList[]): string {
  let out = text;
  for (const k of excludes) {
    k.global.lastIndex = 0;
    out = out.replace(k.global, ' ');
  }
  return out;
}

// ── keyword tables (EN + FA) ────────────────────────────────────────────────

interface CategoryRule {
  category: SentinelCategory;
  /** Apply to any target (links too) and to element ids/selectors. */
  strong: string[];
  /** Apply only to button-like controls (or when the element is unknown). */
  weak: string[];
  /** Phrases removed before matching this category (false-positive guards). */
  exclude: string[];
  /** Tokens matched against URL paths of form actions (button-like submits). */
  formUrl: string[];
  /** Tokens matched against link hrefs (only clear actions). */
  hrefUrl: string[];
}

const RULES_SRC: CategoryRule[] = [
  {
    category: 'payment',
    strong: [
      'pay now', 'pay with', 'proceed to payment', 'continue to payment', 'make payment', 'make a payment',
      'complete payment', 'confirm payment', 'submit payment', 'add payment method', 'add card', 'add a card',
      'add new card', 'save card', 'add credit card', 'add debit card', 'card number', 'credit card', 'debit card',
      'cvv', 'cvc', 'cvv2', 'security code', 'expiry date', 'expiration date', 'bank transfer', 'wire transfer',
      'transfer money', 'send money', 'transfer funds', 'withdraw', 'withdraw funds', 'iban', 'routing number',
      'پرداخت', 'درگاه پرداخت', 'انتقال وجه', 'کارت به کارت', 'واریز', 'برداشت وجه', 'شماره کارت', 'رمز دوم',
      'رمز اینترنتی', 'کد امنیتی', 'تاریخ انقضا', 'شماره شبا', 'شبا!', 'حساب بانکی', 'انتقال پول',
    ],
    weak: ['pay', 'payment', 'payment method', 'billing', 'bank', 'transfer', 'بانک', 'درگاه', 'انتقال'],
    exclude: [
      'payment history', 'payment methods accepted', 'billing history', 'pay later info',
      'تاریخچه پرداخت', 'سوابق پرداخت', 'راهنمای پرداخت',
    ],
    formUrl: ['pay', 'payment', 'billing', 'charge', 'transfer', 'withdraw', 'gateway', 'ipg'],
    hrefUrl: ['pay now', 'make payment', 'transfer money'],
  },
  {
    category: 'purchase',
    strong: [
      'buy now', 'buy it now', 'buy with 1-click', '1-click', 'one-click buy', 'place order', 'place your order',
      'complete purchase', 'complete order', 'complete checkout', 'confirm order', 'confirm purchase', 'submit order',
      'purchase', 'order now', 'book now', 'confirm booking',
      'confirm reservation', 'reserve now', 'start subscription', 'subscribe now', 'upgrade now', 'start free trial',
      'start trial', 'donate', 'place bid', 'rent now', 'buy subscription',
      'ثبت سفارش', 'ثبت نهایی', 'تکمیل خرید', 'تکمیل سفارش', 'نهایی کردن', 'نهایی کردن خرید',
      'نهایی کردن سفارش', 'تایید سفارش', 'تایید و پرداخت', 'تایید نهایی', 'خرید اشتراک', 'خرید نهایی',
      'همین الان بخرید', 'الان بخر', 'تایید رزرو', 'رزرو نهایی', 'اتمام خرید', 'تسویه حساب',
    ],
    weak: [
      'buy', 'order', 'subscribe', 'upgrade', 'book', 'reserve', 'bid',
      'خرید', 'بخر', 'بخرید', 'خرید کن', 'سفارش', 'سفارش بده', 'اشتراک', 'رزرو', 'رزرو کن', 'عضویت ویژه',
    ],
    exclude: [
      'add to cart', 'add to basket', 'add to bag', 'add to wishlist', 'order history', 'order status', 'track order',
      'track your order', 'my orders', 'sort order', 'order by', 'continue shopping', 'how to buy', 'buying guide',
      // Getting TO the checkout is navigation; the committing step (place order / pay / a confirm
      // button on the checkout page) is what gets guarded.
      'ادامه فرایند خرید', 'ادامه فرآیند خرید', 'book a demo', 'bookmark',
      'purchase history', 'my purchases', 'past purchases', 'previous purchases', 'address book', 'phone book',
      'guest book', 'notebook',
      'افزودن به سبد', 'افزودن به سبد خرید', 'اضافه به سبد', 'سبد خرید', 'سفارش های من', 'سفارشات من',
      'پیگیری سفارش', 'ادامه خرید', 'راهنمای خرید', 'لغو اشتراک', 'اشتراک گذاری', 'مرتب سازی', 'خریدار',
      'تاریخچه خرید', 'سوابق خرید',
    ],
    formUrl: ['checkout', 'place order', 'submit order', 'confirm order', 'complete order', 'purchase', 'buy', 'order', 'subscribe', 'subscription'],
    hrefUrl: ['place order', 'buy now', 'purchase', '1 click', 'one click'],
  },
  {
    category: 'account',
    strong: [
      'change password', 'reset password', 'update password', 'delete account', 'delete my account', 'close account',
      'close my account', 'deactivate account', 'deactivate my account', 'disable two-factor', 'disable 2fa',
      'turn off two-factor', 'two-factor authentication', 'two factor authentication', '2fa', 'two-step verification',
      'security settings', 'change email', 'change email address', 'update email', 'recovery email', 'recovery phone',
      'sign out of all', 'log out of all', 'revoke access', 'revoke', 'generate api key', 'create api key', 'new api key',
      'generate token', 'generate new token', 'create token', 'personal access token', 'transfer ownership',
      'cancel subscription', 'cancel membership',
      'تغییر رمز', 'تغییر رمز عبور', 'تغییر کلمه عبور', 'تغییر گذرواژه', 'بازیابی رمز', 'حذف حساب',
      'حذف حساب کاربری', 'بستن حساب', 'غیرفعال کردن حساب', 'غیر فعال کردن حساب', 'ورود دو مرحله ای',
      'تایید دو مرحله ای', 'احراز هویت دو مرحله ای', 'رمز دو مرحله ای', 'تنظیمات امنیتی', 'تغییر ایمیل',
      'تغییر شماره', 'لغو اشتراک',
    ],
    weak: ['deactivate', 'غیرفعال سازی'],
    exclude: ['forgot password', 'فراموشی رمز'],
    formUrl: ['change password', 'password change', 'password reset', 'password update', 'account delete', 'account close', 'account deactivate', 'two factor', '2fa', 'mfa'],
    hrefUrl: ['account delete', 'delete account', 'close account'],
  },
  {
    category: 'send',
    strong: [
      'send message', 'send email', 'send mail', 'send reply', 'send now', 'submit message', 'post comment',
      'add comment', 'submit comment', 'post reply', 'post now', 'publish', 'publish now', 'tweet', 'retweet', 'repost',
      'send invite', 'send invitation', 'send request', 'submit post', 'share post', 'reply all',
      'ارسال پیام', 'ارسال ایمیل', 'ارسال نظر', 'ارسال دیدگاه', 'ثبت نظر', 'ثبت دیدگاه', 'ارسال پاسخ', 'انتشار',
      'منتشر کن', 'منتشر کردن', 'بفرست', 'ارسال کن', 'توییت', 'ریتوییت', 'ارسال درخواست', 'ارسال دعوت',
    ],
    // "Share" / "Forward" usually only open a dialog; the dialog's Send/Post is what gets guarded.
    weak: ['send', 'post', 'reply', 'ارسال', 'پست!', 'پاسخ', 'فرستادن'],
    exclude: [
      'send code', 'send verification code', 'resend code', 'send me a code', 'post code', 'postcode', 'post office',
      'ارسال کد', 'ارسال مجدد کد', 'ارسال مجدد', 'ارسال رایگان', 'هزینه ارسال', 'روش ارسال', 'نحوه ارسال',
      'شیوه ارسال', 'زمان ارسال', 'ارسال سریع', 'ارسال اکسپرس', 'کد پستی',
    ],
    formUrl: ['send', 'message', 'messages', 'comment', 'comments', 'reply', 'post', 'tweet', 'publish', 'compose', 'mail'],
    hrefUrl: ['send message', 'compose send'],
  },
  {
    category: 'delete',
    strong: [
      'delete', 'delete permanently', 'permanently delete', 'remove account', 'delete forever', 'empty trash',
      'erase', 'destroy', 'wipe',
      'حذف', 'حذف کن', 'حذف دائمی', 'پاک کن', 'پاک کردن', 'پاک شود', 'حذف شود',
    ],
    weak: ['remove', 'discard', 'trash', 'clear all', 'پاک', 'دور انداختن'],
    exclude: ['delete filter', 'clear filters', 'remove filter', 'remove filters', 'حذف فیلتر', 'پاک کردن فیلتر'],
    formUrl: ['delete', 'destroy', 'remove', 'trash', 'erase'],
    hrefUrl: ['delete', 'destroy', 'remove account', 'erase'],
  },
];

interface CompiledRule {
  category: SentinelCategory;
  strong: CompiledList[];
  weak: CompiledList[];
  exclude: CompiledList[];
  formUrl: CompiledList[];
  hrefUrl: CompiledList[];
}

const RULES: CompiledRule[] = RULES_SRC.map(r => ({
  category: r.category,
  strong: compileList(r.strong),
  weak: compileList(r.weak),
  exclude: compileExcludes(r.exclude),
  formUrl: compileList(r.formUrl),
  hrefUrl: compileList(r.hrefUrl),
}));

/** Category priority when several match: the most consequential wins. */
const PRIORITY: SentinelCategory[] = [
  'payment', 'purchase', 'credential', 'account', 'send', 'delete', 'publish', 'upload', 'download', 'desktop', 'navigation', 'other',
];
function prio(c: SentinelCategory): number {
  const i = PRIORITY.indexOf(c);
  return i < 0 ? PRIORITY.length : i;
}

/** Typing into these fields is a credential action. */
const CREDENTIAL_FIELD = compileList([
  'password', 'passcode', 'passphrase', 'pin', 'pin code', 'otp', 'one-time code', 'one time code', 'one-time password',
  'verification code', '2fa code', 'authentication code', 'auth code', 'security answer', 'secret', 'api key',
  'access token', 'token', 'private key', 'seed phrase', 'recovery phrase', 'mnemonic',
  'رمز', 'رمز عبور', 'کلمه عبور', 'گذرواژه', 'پسورد', 'رمز پویا', 'کد یکبار مصرف', 'رمز یکبار مصرف', 'کد تایید',
  'کد ورود', 'کد امنیتی',
]);
const CREDENTIAL_FIELD_EXCLUDE = compileExcludes(['pincode', 'forgot password', 'فراموشی رمز', 'رمز ارز', 'رمزارز', 'رمزنگاری']);

/** Typing into these fields is a payment action. */
const PAYMENT_FIELD = compileList([
  'card number', 'card no', 'credit card', 'debit card', 'cardnumber', 'cc number', 'cvv', 'cvc', 'cvv2', 'csc',
  'security code', 'expiry', 'expiration', 'exp date', 'mm yy', 'name on card', 'cardholder', 'card holder', 'iban',
  'routing number', 'account number', 'bank account',
  'شماره کارت', 'رمز دوم', 'رمز اینترنتی', 'تاریخ انقضا', 'ماه انقضا', 'سال انقضا', 'شماره شبا', 'شبا!',
  'شماره حساب', 'کارت بانکی',
]);

/** Text boxes that send their content when submitted. */
const COMPOSE_FIELD = compileList([
  'message', 'write a message', 'type a message', 'reply', 'comment', 'add a comment', 'write a comment', 'tweet',
  "what's happening", 'what is happening', 'post', 'compose', 'chat', 'email body', 'body',
  'پیام', 'نظر', 'دیدگاه', 'پاسخ', 'کامنت', 'بنویسید', 'متن پیام',
]);
const SEARCH_FIELD = compileList(['search', 'find', 'filter', 'query', 'جستجو', 'جست و جو', 'پیدا کن', 'فیلتر']);

/** Generic "go on" buttons that commit a step inside a checkout flow. */
const CONFIRMISH = compileList([
  'continue', 'next', 'confirm', 'submit', 'ok', 'place', 'complete', 'finish', 'proceed', 'pay', 'done', 'agree',
  'ادامه', 'تایید', 'ثبت', 'پرداخت', 'بعدی', 'مرحله بعد', 'نهایی', 'پایان', 'انجام',
]);
const NOT_CONFIRMISH = compileExcludes(['continue shopping', 'back', 'cancel', 'بازگشت', 'انصراف', 'برگشت', 'ادامه خرید']);

/** Checkout-flow page paths (a confirm-ish button here is a purchase step). */
const CHECKOUT_PATH = compileList(['checkout', 'payment', 'pay', 'billing', 'purchase', 'order confirm', 'order review', 'order place', 'place order', 'cart checkout']);

// ── payment gateways ────────────────────────────────────────────────────────

const PAYMENT_GATEWAYS = [
  // Iran (Shaparak network + PSPs)
  'shaparak.ir', 'zarinpal.com', 'zarinp.al', 'idpay.ir', 'payping.ir', 'pay.ir', 'nextpay.org', 'nextpay.ir',
  'zibal.ir', 'vandar.io', 'sep.ir', 'pec.ir', 'behpardakht.com', 'asanpardakht.ir', 'sadadpsp.ir', 'sadad.co.ir',
  'irankish.com', 'pna.co.ir', 'fanavacard.ir', 'digipay.ir', 'jibit.ir',
  // international
  'paypal.com', 'paypal.me', 'checkout.stripe.com', 'buy.stripe.com', 'billing.stripe.com', 'invoice.stripe.com',
  'pay.google.com', 'payments.google.com', 'pay.amazon.com', 'payments.amazon.com', 'checkout.shopify.com',
  'pay.shopify.com', 'braintreegateway.com', 'venmo.com', 'cash.app', 'klarna.com', 'afterpay.com', 'affirm.com',
  '2checkout.com', '2co.com', 'razorpay.com', 'paystack.com', 'flutterwave.com', 'mollie.com', 'adyen.com',
  'checkout.paddle.com', 'lemonsqueezy.com', 'payoneer.com', 'wise.com', 'skrill.com', 'commerce.coinbase.com',
  'alipay.com', 'paytm.com',
];

/** True when `host` is (a subdomain of) a known payment gateway. PURE. */
export function isPaymentGatewayHost(host: string | undefined): boolean {
  if (!host) return false;
  return PAYMENT_GATEWAYS.some(d => hostMatchesDomain(host, d));
}

// ── hosts, domains, URLs ────────────────────────────────────────────────────

/** Normalize a domain pattern from config ("https://*.Evil.com/x" → "evil.com"). PURE. */
export function normalizeDomainPattern(pattern: string): string {
  let p = String(pattern ?? '').trim().toLowerCase();
  p = p.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  p = p.replace(/[/?#].*$/, '');
  p = p.replace(/^\*\./, '').replace(/^\.+/, '').replace(/\.+$/, '');
  if (p.startsWith('[')) return p.replace(/^\[|\](:\d+)?$/g, '');
  p = p.replace(/:\d+$/, '');
  const ascii = domainToASCII(p);
  return ascii || p;
}

function stripBrackets(h: string): string {
  return h.replace(/^\[/, '').replace(/\]$/, '');
}

/** host === domain or a subdomain of it. PURE. */
export function hostMatchesDomain(host: string, domain: string): boolean {
  const h = stripBrackets(String(host ?? '').toLowerCase().replace(/\.$/, ''));
  const d = normalizeDomainPattern(domain);
  if (!h || !d) return false;
  return h === d || h.endsWith('.' + d);
}

function parseIPv4(h: string): number[] | null {
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every(n => n >= 0 && n <= 255) ? parts : null;
}

function mappedIPv4(h: string): string | null {
  const dotted = h.match(/^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const hex = h.match(/^(?:0*:)*:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const a = parseInt(hex[1], 16);
    const b = parseInt(hex[2], 16);
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return null;
}

/** localhost / 127.0.0.0/8 / ::1 / 0.0.0.0 / *.localhost. PURE. */
export function isLoopbackHost(host: string): boolean {
  const h = stripBrackets(String(host ?? '').toLowerCase().replace(/\.$/, ''));
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1' || h === '::' || h === '0.0.0.0') return true;
  const v4 = parseIPv4(h);
  if (v4) return v4[0] === 127 || (v4[0] === 0 && v4[1] === 0 && v4[2] === 0 && v4[3] === 0);
  const mapped = mappedIPv4(h);
  return mapped ? isLoopbackHost(mapped) : false;
}

/**
 * Loopback, RFC1918, link-local, CGNAT (100.64/10), IPv6 ULA/link-local,
 * single-label intranet names and mDNS/.internal/.lan names. PURE.
 */
export function isPrivateHost(host: string): boolean {
  const h = stripBrackets(String(host ?? '').toLowerCase().replace(/\.$/, ''));
  if (!h) return false;
  if (isLoopbackHost(h)) return true;
  const v4 = parseIPv4(h);
  if (v4) {
    const [a, b] = v4;
    return a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.includes(':')) {
    const mapped = mappedIPv4(h);
    if (mapped) return isPrivateHost(mapped);
    return /^f[cd][0-9a-f]{0,2}:/.test(h) || /^fe[89ab][0-9a-f]?:/.test(h);
  }
  if (/^\d+$/.test(h)) return false;
  if (!h.includes('.')) return true;
  return /\.(local|internal|lan|intranet|home\.arpa|localdomain)$/.test(h);
}

export interface ParsedTarget {
  raw: string;
  scheme: string;
  host: string;
  url?: URL;
}

/** Parse a URL a tool is about to open. Bare domains get https://. PURE. */
export function parseTarget(raw: string): ParsedTarget | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[a-z0-9.-]+:\d+(\/|$)/i.test(s);
  try {
    const u = new URL(hasScheme ? s : `https://${s}`);
    return { raw: s, scheme: u.protocol.replace(/:$/, '').toLowerCase(), host: u.hostname.toLowerCase(), url: u };
  } catch {
    const m = s.match(/^([a-z][a-z0-9+.-]*):/i);
    return m ? { raw: s, scheme: m[1].toLowerCase(), host: '' } : null;
  }
}

function hostOf(url: string | undefined): string {
  if (!url) return '';
  const t = parseTarget(url);
  return t?.host ?? '';
}

/** "/checkout/place-order?step=2" → "checkout place order step 2" (for keyword matching). */
function urlTokens(url: URL | undefined, raw?: string): string {
  if (!url) return normalizeText(String(raw ?? '').replace(/[^\p{L}\p{N}]+/gu, ' '));
  let pathPart = url.pathname + ' ' + url.search;
  try { pathPart = decodeURIComponent(pathPart); } catch { /* keep encoded */ }
  return normalizeText(pathPart.replace(/[^\p{L}\p{N}]+/gu, ' '));
}

// ── secrets ─────────────────────────────────────────────────────────────────

export type SecretKind = 'card' | 'iban' | 'sheba' | 'private-key' | 'api-key' | 'jwt' | 'url-credential';
export interface SecretMatch { kind: SecretKind; index: number; length: number }

/** Luhn checksum over a digit string. PURE. */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** ISO 13616 mod-97 check (input may contain spaces). PURE. */
export function ibanValid(iban: string): boolean {
  const s = String(iban ?? '').replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const v = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const c of v) rem = (rem * 10 + (c.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

/** First 6 digits (BIN) of Iranian bank cards. */
const IRAN_CARD_BINS = new Set([
  '603799', '589210', '627648', '207177', '627961', '603770', '639217', '628023', '627760', '502908', '627412',
  '622106', '627884', '502229', '639347', '627488', '502910', '621986', '639346', '639607', '636214', '502806',
  '504706', '502938', '603769', '610433', '991975', '627353', '585983', '589463', '627381', '505785', '636949',
  '606373', '505416', '507677', '628157', '505801', '606256', '585947', '639370', '504172', '636795',
]);

function plausibleCard(d: string): boolean {
  const n = d.length;
  if (n === 15) return /^3[47]/.test(d);
  if (n === 13) return d.startsWith('4');
  if (n === 14) return /^3(0|6|8)/.test(d);
  if (n === 16) return /^[2-6]/.test(d);
  if (n >= 17 && n <= 19) return /^[456]/.test(d);
  return false;
}

/** A real key mixes digits and upper-case letters; a URL slug ("sk-learn-tutorial-...") does not. */
const mixedCase = (m: string) => /\d/.test(m) && /[A-Z]/.test(m) && /[a-z]/.test(m);

const SECRET_PATTERNS: Array<{ kind: SecretKind; re: RegExp; check?: (m: string) => boolean }> = [
  { kind: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: 'api-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: 'api-key', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { kind: 'api-key', re: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  { kind: 'api-key', re: /\bsk-(?:ant-[a-z0-9]+-|proj-|live-|svcacct-)?[A-Za-z0-9_-]{24,}/, check: mixedCase },
  { kind: 'api-key', re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { kind: 'api-key', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/ },
  { kind: 'api-key', re: /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}\b/ },
  { kind: 'api-key', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { kind: 'url-credential', re: /[?&](?:password|passwd|pwd)=[^&\s#]{4,}/i },
  { kind: 'url-credential', re: /[?&](?:secret|client_secret|api_?key|access_token|auth_token|token)=[^&\s#]{16,}/i },
  { kind: 'url-credential', re: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]{3,}@/i },
];

/** Find secret-looking substrings (cards, IBAN/Sheba, keys, tokens). PURE. */
export function detectSecrets(text: string): SecretMatch[] {
  const s = toAsciiDigits(String(text ?? ''));
  if (!s) return [];
  const out: SecretMatch[] = [];
  for (const p of SECRET_PATTERNS) {
    const m = p.re.exec(s);
    if (m && (!p.check || p.check(m[0]))) out.push({ kind: p.kind, index: m.index, length: m[0].length });
  }
  // Iranian Sheba: IR + 24 digits (spaces allowed), checksum not required.
  const sheba = /\bIR\s?\d{2}(?:\s?\d){22}\b/i.exec(s);
  if (sheba) out.push({ kind: 'sheba', index: sheba.index, length: sheba[0].length });
  // Other IBANs: validated with mod-97 to avoid flagging random codes.
  const ibanRe = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]){11,30}\b/g;
  for (let m = ibanRe.exec(s); m; m = ibanRe.exec(s)) {
    if (/^IR/i.test(m[0])) continue;
    if (ibanValid(m[0])) { out.push({ kind: 'iban', index: m.index, length: m[0].length }); break; }
  }
  // Card numbers: 13-19 digits with optional space/dash groups.
  const cardRe = /(?<![\d])(?:\d[ -]?){12,18}\d(?![\d])/g;
  for (let m = cardRe.exec(s); m; m = cardRe.exec(s)) {
    const digits = m[0].replace(/[ -]/g, '');
    const iranian = digits.length === 16 && IRAN_CARD_BINS.has(digits.slice(0, 6));
    if (iranian || (plausibleCard(digits) && luhnValid(digits))) {
      out.push({ kind: 'card', index: m.index, length: m[0].length });
      break;
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

const SECRET_LABEL: Record<SecretKind, string> = {
  'card': 'a card number',
  'iban': 'an IBAN',
  'sheba': 'a Sheba (IBAN) number',
  'private-key': 'a private key',
  'api-key': 'an API key / token',
  'jwt': 'a session token (JWT)',
  'url-credential': 'a credential in a URL',
};
export function describeSecret(kind: SecretKind): string {
  return SECRET_LABEL[kind];
}

/** Replace secret-looking substrings with `[redacted:<kind>]`. PURE. */
export function maskSecrets(text: string): string {
  let s = toAsciiDigits(String(text ?? ''));
  // Re-scan after each replacement: positions shift.
  for (let guard = 0; guard < 20; guard++) {
    const found = detectSecrets(s);
    if (!found.length) break;
    const f = found[0];
    s = s.slice(0, f.index) + `[redacted:${f.kind}]` + s.slice(f.index + f.length);
  }
  return s;
}

// ── protected paths ─────────────────────────────────────────────────────────

function markerFor(p: string): string {
  return ('.qodex/' + path.relative(QODEX_HOME, p)).replace(/\\/g, '/');
}

export const DEFAULT_PROTECTED_PATHS: ProtectedPaths = {
  // Standing grants, the mail automation state (rules = trusted instructions, the
  // received-mail index that scopes auto-replies), the mail account secrets and the
  // signed drafts (~/.qodex/mail): the agent may neither read nor write them — only the
  // human surfaces and the mail tools themselves change them.
  files: [QODEX_VAULT_KEY_FILE, QODEX_VAULT_FILE, QODEX_GRANTS_FILE, QODEX_MAIL_ACCOUNTS_FILE],
  dirs: [QODEX_BROWSER_PROFILES_DIR, QODEX_BROWSER_BOT_AUTH_DIR, QODEX_MAIL_AUTO_DIR, QODEX_MAIL_DIR],
  markers: [
    markerFor(QODEX_VAULT_KEY_FILE), markerFor(QODEX_VAULT_FILE), markerFor(QODEX_BROWSER_PROFILES_DIR),
    markerFor(QODEX_BROWSER_BOT_AUTH_DIR),
    markerFor(QODEX_GRANTS_FILE), markerFor(QODEX_MAIL_ACCOUNTS_FILE), markerFor(QODEX_MAIL_AUTO_DIR),
    markerFor(QODEX_MAIL_DIR),
  ],
  // .env holds the provider keys + the Telegram bot token; sessions.db holds the
  // mission approval queue; channels/ holds the Telegram pairing (who may approve).
  configFiles: [QODEX_CONFIG_FILE, path.join(QODEX_HOME, '.env'), QODEX_SESSION_DB],
  configDirs: [QODEX_CHANNELS_DIR, QODEX_SENTINEL_DIR],
};
// The vault key's other homes (src/vault/paths.ts): the keystore record decides "fresh install"
// vs "key lost" (editing it could make QodeX mint a second key), and on Windows the DPAPI blob
// IS the key. Same protection as the key file.
DEFAULT_PROTECTED_PATHS.files.push(...VAULT_KEY_ARTIFACTS);
DEFAULT_PROTECTED_PATHS.markers.push(...VAULT_KEY_ARTIFACTS.map(markerFor));

/** A shell command that reads the vault key out of the OS keychain (service "qodex-vault-key"). */
const KEYCHAIN_ITEM_RE = /qodex-vault-key\b/i;

/** Shell fragments that write/move/delete a file (vs. merely reading it). */
const SHELL_WRITE_RE = /(?<![<=-])>>?(?!\s*(?:\/dev\/null|&\d))|\btee\b|\bsed\s+(?:-[a-z]*\s+)*-[a-z]*i|\bperl\s+-[a-z]*i|\b(?:mv|cp|rm|truncate|chmod|chown|ln|install|dd)\b|writeFile|\.write\(|open\([^)]*['"][wa]|Set-Content|Out-File|Remove-Item|Move-Item|Copy-Item/i;
/** SQL that changes a database (`sqlite3 ~/.qodex/sessions.db "UPDATE mission_approvals ..."`). */
const SQL_WRITE_RE = /\b(?:update|insert|delete|replace|drop|alter|create|attach|vacuum)\b/i;

/** The qodex binary (`qodex`, `qx`, `bin/qodex.mjs`, `qodex.cmd`). */
const QODEX_BIN = String.raw`(?:\S*[/\\])?(?:qodex|qx)(?:\.mjs|\.js|\.cmd)?`;
/** QodeX run from a checkout (`node dist/index.js …`, `npx tsx src/index.ts …`, `npm run dev -- …`). */
const QODEX_ENTRY = String.raw`(?:(?:(?:tsx|ts-node|bun)\s+)?(?:\S*[/\\])?(?:index|cli|main)\.[cm]?[jt]s|(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:dev|start))`;
/**
 * Root options before the subcommand (`qodex --json -m x mission approve …`). An option's
 * value never swallows a subcommand word, which also keeps the match linear.
 */
const ROOT_OPTS = String.raw`(?:\s+-\S+(?:\s+(?!(?:missions?|vault|setup|config|control|telegram|browser|grant|mail)\b)[^\s-]\S*)?)*`;
/** `--yes` / `-y` anywhere in the same command (before or after the subcommand). */
const YES_AHEAD = String.raw`(?=[^|;&\n]*\s(?:--yes|-y)(?![\w-]))`;
/** Answering or steering a mission (a steering note carries the user's authority). */
const MISSION_ANSWER = String.raw`missions?\s+(?:approve|deny|steer)\b`;
const MISSION_AUTO = String.raw`missions?\s+(?:start|resume)\b`;

/**
 * CLI invocations that change the vault or QodeX's own setup, or that answer /
 * open the approval channels themselves: approving a mission's pending
 * approvals, steering it, starting a control center (its token approves anything), pairing
 * a Telegram chat (the code would let whoever receives it approve), or giving
 * a mission auto-approval. The agent must never do these on its own. A generic
 * entry point (`node dist/index.js`) only counts for the mission subcommands, so
 * another project's `node cli.js setup` is not mistaken for QodeX.
 */
const QODEX_SELF_CHANGE_RE = new RegExp([
  // Command position only (start, after ; && || | ( $( ` or `sh -c "`, behind sudo/env/npx/node
  // prefixes), so `grep "qodex control" docs/` is not mistaken for running it.
  String.raw`(?:^|[;&|(\x60\n{]|\$\(|-c\s+["'])\s*`,
  String.raw`(?:(?:sudo|nohup|exec|time|command|env(?:\s+(?:(?:-u|--unset)\s+[^\s-]\S*|-\S+))*|npx(?:\s+-\S+)*|node(?:\s+-\S+)*|[A-Za-z_][A-Za-z0-9_]*=\S*)\s+)*`,
  String.raw`(?:${QODEX_BIN}${ROOT_OPTS}\s+(?:`,
  String.raw`vault\s+(?:add|rm|remove|edit|rotate|import|key\s+migrate)`,
  String.raw`|setup`,
  String.raw`|config\s+(?:set|edit|reset)`,
  String.raw`|control\b`,
  String.raw`|telegram\s+(?:setup|pair|unpair)`,
  String.raw`|${MISSION_ANSWER}`,
  String.raw`|browser\s+reset-profile`,
  // Standing grants and mail rules: a grant lets email go out unasked, a rule's task is a trusted instruction.
  String.raw`|grant\s+(?:add|revoke|rm|remove)\b`,
  String.raw`|mail\s+(?:rules?\s+(?:add|rm|remove|delete)\b|reply-all\b)`,
  String.raw`)`,
  String.raw`|${QODEX_BIN}${YES_AHEAD}${ROOT_OPTS}\s+${MISSION_AUTO}`,
  String.raw`|${QODEX_ENTRY}${ROOT_OPTS}\s+${MISSION_ANSWER}`,
  String.raw`|${QODEX_ENTRY}${YES_AHEAD}${ROOT_OPTS}\s+${MISSION_AUTO}`,
  String.raw`)`,
].join(''), 'i');

/** Config files / dirs mentioned in `text` (absolute or ~/.qodex/... form). PURE. */
function mentionedConfig(text: string, pp: ProtectedPaths): string[] {
  const t = String(text ?? '').replace(/\\/g, '/').toLowerCase();
  return [...(pp.configFiles ?? []), ...(pp.configDirs ?? [])]
    .filter(f => t.includes(f.replace(/\\/g, '/').toLowerCase()) || t.includes(markerFor(f).toLowerCase()));
}

/** Does this shell command change one of the config files / trust stores? PURE. */
function commandChangesConfig(cmd: string, pp: ProtectedPaths): boolean {
  const hits = mentionedConfig(cmd, pp);
  if (!hits.length) return false;
  if (SHELL_WRITE_RE.test(cmd)) return true;
  return hits.some(f => /\.(?:db|sqlite3?)$/i.test(f)) && SQL_WRITE_RE.test(cmd);
}

/** Is `abs` one of the config files (incl. SQLite -wal/-shm/-journal companions) or inside a config dir? PURE. */
function isConfigPath(abs: string, pp: ProtectedPaths): boolean {
  const a = normPath(abs);
  if ((pp.configFiles ?? []).some(f => a === normPath(f) || a.startsWith(normPath(f) + '-'))) return true;
  return (pp.configDirs ?? []).some(d => samePathOrInside(abs, d));
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p.replace(/^\$\{?HOME\}?(?=[/\\]|$)/, os.homedir());
}

function normPath(p: string): string {
  const r = path.resolve(p);
  return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r;
}

function samePathOrInside(target: string, base: string): boolean {
  const t = normPath(target);
  const b = normPath(base);
  return t === b || t.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

/** Does this path (absolute, relative to cwd, or ~/...) hit a protected location? PURE. */
export function isProtectedPath(p: string, cwd: string | undefined, pp: ProtectedPaths = DEFAULT_PROTECTED_PATHS): boolean {
  const raw = String(p ?? '').trim();
  if (!raw) return false;
  if (textHitsProtectedMarker(raw, pp)) return true;
  const abs = path.resolve(cwd || process.cwd(), expandHome(raw));
  if (pp.files.some(f => normPath(abs) === normPath(f))) return true;
  return pp.dirs.some(d => samePathOrInside(abs, d));
}

/**
 * Free-form text (a shell command, a code snippet) mentioning a protected
 * location. With `cwd` inside the protected tree's parent (~/.qodex), bare file
 * names count too (`cat .vault-key`). PURE.
 */
export function textHitsProtectedMarker(text: string, pp: ProtectedPaths = DEFAULT_PROTECTED_PATHS, cwd?: string): boolean {
  const t = String(text ?? '').replace(/\\/g, '/').toLowerCase();
  if (!t) return false;
  for (const m of pp.markers) if (m && t.includes(m.toLowerCase())) return true;
  for (const f of [...pp.files, ...pp.dirs]) {
    const a = f.replace(/\\/g, '/').toLowerCase();
    if (a && t.includes(a)) return true;
  }
  // `cd ~/.qodex && cat .vault-key` style: bare names next to a mention of .qodex,
  // or a cwd that already is inside ~/.qodex.
  const nearQodex = t.includes('.qodex') || (!!cwd && pp.files.concat(pp.dirs).some(f => samePathOrInside(cwd, path.dirname(f))));
  if (nearQodex) {
    for (const f of pp.files) if (t.includes(path.basename(f).toLowerCase())) return true;
    for (const d of pp.dirs) {
      const tail = (path.basename(path.dirname(d)) + '/' + path.basename(d)).toLowerCase();
      if (t.includes(tail)) return true;
    }
  }
  return false;
}

/**
 * Is `abs` (inside QodeX's own tree) a directory that CONTAINS a protected
 * location? Archiving, syncing or recursively grepping it reads the vault key
 * and the browser profiles just like opening them one by one. PURE.
 */
function containsProtected(abs: string, pp: ProtectedPaths): boolean {
  if (!abs || !samePathOrInside(abs, QODEX_HOME)) return false;
  return [...pp.files, ...pp.dirs].some(f => samePathOrInside(f, abs));
}

/** Commands that read / copy / ship whole directory trees. */
const BULK_READ_RE = /\b(?:tar|zip|7z|7za|rar|rsync|scp|sftp|rclone|gsutil|azcopy|restic|borg|duplicity)\b|\bcp\s+(?:-\S+\s+)*-[a-zA-Z]*[rRa]|\baws\s+s3\s+(?:sync|cp)\b|\bgrep\s+(?:-\S+\s+)*-[a-zA-Z]*[rR]|\b(?:rg|ag|ack)\s|\bfind\b[^|;&]*-exec|\bxargs\b|\bcat\s+[^|;&]*\*|\bcurl\b[^|;&]*(?:\s-T\b|--upload-file|\s-F\b|--form|--data-binary)|\bshutil\.(?:copytree|make_archive)|\bcpSync\b|\bfs\.cp\b/i;

/** The ~/.qodex directory itself (or its browser/ dir) as a whole, not a file inside it. */
const QODEX_ROOT_RE = new RegExp(
  `(?:^|[\\s'"=:(\x60])(?:(?:~|\\$HOME|\\$\\{HOME\\}|${escapeRe(path.dirname(QODEX_HOME).replace(/\\/g, '/'))})/)?\\.qodex(?:/browser)?/?\\*?(?=$|[\\s'"\x60;|&)<>])`,
  'i',
);

/** Files that hold credentials — uploading one is a credential action. */
const SECRET_FILE_RE = /(?:^|[/\\])(?:\.env(?:\.[\w.-]+)?|id_(?:rsa|dsa|ecdsa|ed25519)|[^/\\]+\.(?:pem|key|p12|pfx|keystore|jks|kdbx|ovpn|ppk)|credentials(?:\.json)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.pgpass|\.htpasswd|wallet\.dat|[^/\\]*keychain[^/\\]*)$/i;
const SECRET_DIR_RE = /(?:^|[/\\])(?:\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.azure|\.config[/\\]gcloud)(?:[/\\]|$)/i;
export function isSecretFile(p: string): boolean {
  const s = String(p ?? '');
  return SECRET_FILE_RE.test(s) || SECRET_DIR_RE.test(s);
}

// ── element helpers ─────────────────────────────────────────────────────────

const BUTTON_ROLES = new Set(['button', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'switch']);
function isButtonLike(el: ElementInfo | null | undefined): boolean {
  if (!el || (!el.role && !el.tag)) return true; // unknown element: be conservative
  const role = (el.role ?? '').toLowerCase();
  const tag = (el.tag ?? '').toLowerCase();
  const type = (el.inputType ?? '').toLowerCase();
  if (BUTTON_ROLES.has(role)) return true;
  if (tag === 'button') return true;
  if (tag === 'input' && ['submit', 'button', 'image', 'reset'].includes(type)) return true;
  return false;
}

/** Enter / Return (also in chords like Control+Enter): submits forms and message boxes. PURE. */
export function isEnterKey(key: string): boolean {
  return /enter|return/i.test(String(key ?? ''));
}

/** Space (" ", "Space", "Spacebar", chords): activates a focused button / checkbox. PURE. */
export function isSpaceKey(key: string): boolean {
  return /^(?:.*\+)?(?:space|spacebar| )$/i.test(String(key ?? ''));
}

function isLink(el: ElementInfo | null | undefined): boolean {
  return !!el && ((el.role ?? '').toLowerCase() === 'link' || ((el.tag ?? '').toLowerCase() === 'a' && !!el.href));
}

/** Identifier-ish part of a selector (#place-order, [data-testid=checkout-btn], [name=...]). */
function selectorWords(sel: string | undefined): string {
  if (!sel) return '';
  const words: string[] = [];
  // #id, .class, [attr=value] (data-testid, name, aria-label, value, title, role name=...)
  for (const m of sel.matchAll(/#([\w-]+)|\.([A-Za-z][\w-]*)|\[(?:data-testid|data-test|data-qa|data-action|name|id|aria-label|value|title|alt)\s*[*^$~|]?=\s*["']?([^"'\]]+)["']?\s*i?\]|\bname\s*=\s*["']([^"']+)["']/g)) {
    words.push(m[1] ?? m[2] ?? m[3] ?? m[4] ?? '');
  }
  // text=Place order / :has-text("Place order") / internal:text="..."
  for (const m of sel.matchAll(/(?:^|\s|>>\s*)(?:internal:)?text\s*=\s*["']?([^"'>]+)["']?|:(?:has-)?text\(\s*["']([^"']+)["']\s*\)/g)) {
    words.push(m[1] ?? m[2] ?? '');
  }
  return words.join(' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
}

function oneLine(s: string, max = 80): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function elementLabel(el: ElementInfo | null | undefined, fallback?: string): string {
  const label = el?.name || el?.text || fallback || el?.selector || el?.ref || 'element';
  return oneLine(maskSecrets(label), 80).replace(/"/g, "'");
}

function roleSuffix(el: ElementInfo | null | undefined): string {
  if (!el) return '';
  if (el.isPassword) return ' (password field)';
  const r = el.role || el.tag;
  return r ? ` (${r})` : '';
}

// ── classification of page interactions ─────────────────────────────────────

interface Hit { category: SentinelCategory; reason: string }

function bestHit(hits: Hit[]): Hit | null {
  if (!hits.length) return null;
  return hits.slice().sort((a, b) => prio(a.category) - prio(b.category))[0];
}

/** Keyword hits over normalized text for each category. */
function keywordHits(text: string, applyWeak: boolean, label: string): Hit[] {
  const hits: Hit[] = [];
  if (!text) return hits;
  for (const r of RULES) {
    const t = stripPhrases(text, r.exclude);
    const strong = firstMatch(t, r.strong);
    if (strong) { hits.push({ category: r.category, reason: `${label} "${strong}" looks like a ${r.category} action` }); continue; }
    if (applyWeak) {
      const weak = firstMatch(t, r.weak);
      if (weak) hits.push({ category: r.category, reason: `${label} "${weak}" looks like a ${r.category} action` });
    }
  }
  return hits;
}

function urlHits(u: string | undefined, which: 'formUrl' | 'hrefUrl', label: string): Hit[] {
  if (!u) return [];
  const t = parseTarget(u);
  const hits: Hit[] = [];
  if (t?.host && isPaymentGatewayHost(t.host)) hits.push({ category: 'payment', reason: `${label} goes to the payment gateway ${t.host}` });
  const tokens = urlTokens(t?.url, u);
  for (const r of RULES) {
    const m = firstMatch(tokens, r[which]);
    if (m) hits.push({ category: r.category, reason: `${label} path contains "${m}"` });
  }
  return hits;
}

/**
 * Classify activating an element (click, Enter, submit). `submit` adds the
 * compose-box rule (Enter / submit in a message box sends the message).
 */
function classifyActivation(el: ElementInfo | null | undefined, description: string | undefined, pageUrl: string | undefined, submit: boolean, argSelector?: string): Hit | null {
  const buttonLike = isButtonLike(el);
  const hits: Hit[] = [];
  const page = parseTarget(pageUrl ?? '');
  const pageHost = page?.host ?? '';

  const visible = normalizeText([el?.name, el?.text, description].filter(Boolean).join(' | '));
  hits.push(...keywordHits(visible, buttonLike || !el, 'button/link'));
  const ids = normalizeText(selectorWords(el?.selector));
  if (ids) hits.push(...keywordHits(ids, buttonLike, 'element id'));
  // The selector the model passed (`#place-order`, `text=Pay now`) still says what it
  // targets when the element could not be described (slow page, describe timeout).
  // Strong phrases only: a bare id like `#post-12` is no evidence of an action.
  const argIds = argSelector && argSelector !== el?.selector ? normalizeText(selectorWords(argSelector)) : '';
  if (argIds) hits.push(...keywordHits(argIds, false, 'element selector'));

  if (isLink(el)) hits.push(...urlHits(el?.href, 'hrefUrl', 'link'));
  if (buttonLike && el?.formAction) hits.push(...urlHits(el.formAction, 'formUrl', 'form'));

  // On a payment gateway every button is a payment step.
  if (pageHost && isPaymentGatewayHost(pageHost) && buttonLike) {
    hits.push({ category: 'payment', reason: `button on the payment gateway ${pageHost}` });
  }
  // Inside a checkout flow, a generic "Continue / Confirm / ادامه / تایید" commits a purchase step.
  if (page?.url && buttonLike && !hits.length) {
    const pathTokens = urlTokens(page.url);
    const inCheckout = firstMatch(pathTokens, CHECKOUT_PATH);
    if (inCheckout) {
      const t = stripPhrases(visible, NOT_CONFIRMISH);
      const c = firstMatch(t, CONFIRMISH);
      if (c) {
        const payPage = /\b(pay|payment|billing)\b/.test(pathTokens) || /پرداخت/.test(pathTokens);
        hits.push({ category: payPage ? 'payment' : 'purchase', reason: `"${c}" on a ${inCheckout} page commits the order` });
      }
    }
  }
  // Submitting a message box sends its content.
  if (submit && el && !hits.length) {
    const field = normalizeText([el.name, el.text, el.autocomplete].filter(Boolean).join(' '));
    const isTextbox = ['textbox', 'searchbox', 'combobox'].includes((el.role ?? '').toLowerCase())
      || (el.tag ?? '').toLowerCase() === 'textarea' || ((el.tag ?? '').toLowerCase() === 'input' && !el.isPassword);
    if (isTextbox && (el.role ?? '').toLowerCase() !== 'searchbox' && !firstMatch(field, SEARCH_FIELD)) {
      const c = firstMatch(field, COMPOSE_FIELD);
      if (c) hits.push({ category: 'send', reason: `submitting the "${c}" box sends its content` });
    }
    if (el.formAction) hits.push(...urlHits(el.formAction, 'formUrl', 'form'));
  }
  return bestHit(hits);
}

/** Classify typing `text` into `el` (no submit). */
function classifyTyping(el: ElementInfo | null | undefined, text: string, pageUrl: string | undefined, description?: string): (Hit & { secret?: SecretKind; mask: boolean }) | null {
  const pageHost = hostOf(pageUrl);
  const ac = (el?.autocomplete ?? '').toLowerCase();
  const fieldText = normalizeText([el?.name, el?.text, description, ac].filter(Boolean).join(' '));
  const credField = stripPhrases(fieldText, CREDENTIAL_FIELD_EXCLUDE);

  if (el?.isPassword || /(?:^|\s)(current|new)-password\b/.test(ac)) {
    return { category: 'credential', reason: 'typing into a password field', mask: true };
  }
  const secrets = detectSecrets(text);
  if (secrets.length) {
    return { category: 'credential', reason: `the text looks like ${describeSecret(secrets[0].kind)}`, secret: secrets[0].kind, mask: true };
  }
  const digitsOnly = toAsciiDigits(text).replace(/\s+/g, '');
  const cvvField = /\b(cvv2?|cvc|csc)\b/.test(fieldText) || /رمز دوم|کد امنیتی/.test(fieldText) || /\bcc-csc\b/.test(ac);
  if (/^\d{3,4}$/.test(digitsOnly) && (cvvField || isPaymentGatewayHost(pageHost))) {
    return { category: 'credential', reason: 'a 3-4 digit code in a card/CVV context', mask: true };
  }
  if (/\bcc-/.test(ac)) return { category: 'payment', reason: `typing into a payment field (${ac})`, mask: true };
  const pay = firstMatch(fieldText, PAYMENT_FIELD);
  if (pay) return { category: 'payment', reason: `typing into a "${pay}" field`, mask: true };
  if (/\bone-time-code\b/.test(ac)) return { category: 'credential', reason: 'typing a one-time code', mask: true };
  const cred = firstMatch(credField, CREDENTIAL_FIELD);
  if (cred) return { category: 'credential', reason: `typing into a "${cred}" field`, mask: true };
  if (pageHost && isPaymentGatewayHost(pageHost)) return { category: 'payment', reason: `typing on the payment gateway ${pageHost}`, mask: true };
  return null;
}

// ── risk ────────────────────────────────────────────────────────────────────

const BASE_RISK: Record<SentinelCategory, RiskLevel> = {
  purchase: 'high', payment: 'high', send: 'high', credential: 'high', delete: 'high', publish: 'high',
  account: 'high', upload: 'high', download: 'low', navigation: 'low', desktop: 'medium', other: 'medium',
};

function riskFor(category: SentinelCategory, config: SentinelConfig, opts: { escalate?: boolean; base?: RiskLevel } = {}): RiskLevel {
  if (opts.escalate !== false && config.requireApproval.includes(category)) return 'critical';
  return opts.base ?? BASE_RISK[category];
}

function make(category: SentinelCategory | null, risk: RiskLevel, summary: string, reason: string, domain?: string, block?: boolean): PolicyClassification {
  const c: PolicyClassification = { category, risk, summary: oneLine(summary, 200), reason: oneLine(reason, 240) };
  if (domain) c.domain = domain;
  if (block) c.block = true;
  return c;
}

function none(summary: string, domain?: string): PolicyClassification {
  return make(null, 'low', summary, 'not a guarded action', domain);
}

// ── page scripts (browser_evaluate, javascript: URLs) ───────────────────────

/** Script fragments that activate page elements — a click/submit that skips the click guard. */
const SCRIPT_ACTIVATION_RE = /\.click\s*\(|\.requestSubmit\s*\(|\.submit\s*\(|\bdispatchEvent\s*\(|\bnew\s+(?:Mouse|Pointer|Submit|Keyboard|Touch)Event\b|\binit(?:Mouse|Keyboard)Event\b/;
/** Script fragments that reach the network, cookies or storage. */
const SCRIPT_NET_RE = /\b(fetch|XMLHttpRequest|sendBeacon|WebSocket|EventSource|document\.cookie|localStorage|sessionStorage|indexedDB|navigator\.credentials|navigator\.clipboard|\.submit\s*\(|window\.open|location\s*(?:\.href)?\s*=|location\.(?:assign|replace)|postMessage|importScripts)\b/;

/** Words of a script for keyword matching ("querySelector('#placeOrder')" → "query selector place order"). */
function scriptWords(script: string): string {
  return normalizeText(String(script ?? '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[^\p{L}\p{N}]+/gu, ' '));
}

/**
 * Selectors a page script picks elements with (`getElementById('place')`,
 * `querySelector('#buy')`, `getElementsByName('confirm')`), so the guard can
 * describe what a scripted click would hit. PURE.
 */
export function scriptSelectors(script: string): string[] {
  const s = String(script ?? '');
  const out: string[] = [];
  const cssString = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  for (const m of s.matchAll(/getElementById\(\s*(['"`])([^'"`\n]{1,200})\1\s*\)/g)) out.push(`[id="${cssString(m[2])}"]`);
  for (const m of s.matchAll(/getElementsByName\(\s*(['"`])([^'"`\n]{1,200})\1\s*\)/g)) out.push(`[name="${cssString(m[2])}"]`);
  for (const m of s.matchAll(/querySelector(?:All)?\(\s*(['"`])((?:(?!\1)[^\n]){1,300})\1\s*\)/g)) out.push(m[2]);
  return [...new Set(out)].slice(0, 6);
}

/**
 * Classify running `script` in the active page. A script that clicks or submits
 * elements is an ACTIVATION like browser_click — so `document.querySelector(
 * '#place-order').click()` is a purchase, not a generic "other" that `/auto on`
 * would wave through. PURE.
 */
function classifyScript(script: string, ctx: PolicyContext, what: string): PolicyClassification {
  const cfg = ctx.config;
  const page = parseTarget(ctx.url ?? '');
  const pageHost = page?.host ?? '';
  const pageLocal = !!pageHost && isPrivateHost(pageHost);
  const onHost = pageHost ? ` on ${pageHost}` : '';
  const net = script.match(SCRIPT_NET_RE);
  const activates = SCRIPT_ACTIVATION_RE.test(script);
  const summary = `${what} (${script.length} chars)${activates ? ' that clicks/submits page elements' : ''}${net ? ` using ${net[1]}` : ''}${onHost}`;
  if (activates) {
    // Strong phrases only: a script is code, and words like `delete` / `post` / `order` are common identifiers.
    const hits = keywordHits(scriptWords(script), false, 'the script targets');
    // The elements the script selects, as described on the live page: clicking them
    // is judged exactly like browser_click on them.
    for (const el of ctx.scriptTargets ?? []) {
      if (!el) continue;
      const h = classifyActivation(el, undefined, ctx.url, false);
      if (h) hits.push({ category: h.category, reason: `the script clicks/submits "${elementLabel(el)}" — ${h.reason}` });
    }
    if (pageHost && isPaymentGatewayHost(pageHost)) {
      hits.push({ category: 'payment', reason: `the script clicks/submits on the payment gateway ${pageHost}` });
    } else if (page?.url) {
      const pathTokens = urlTokens(page.url);
      const inCheckout = firstMatch(pathTokens, CHECKOUT_PATH);
      if (inCheckout) {
        const payPage = /\b(pay|payment|billing)\b/.test(pathTokens) || /پرداخت/.test(pathTokens);
        hits.push({ category: payPage ? 'payment' : 'purchase', reason: `the script clicks/submits on a ${inCheckout} page` });
      }
    }
    const best = bestHit(hits);
    if (best) return make(best.category, riskFor(best.category, cfg, { escalate: !pageLocal }), summary, best.reason, pageHost || undefined);
    return make('other', riskFor('other', cfg, { base: 'high' }), summary, 'the script clicks / submits elements in the page, bypassing the per-click checks', pageHost || undefined);
  }
  if (net) return make('other', riskFor('other', cfg, { base: 'high' }), summary, `the script uses ${net[1]} (network / cookies / storage access)`, pageHost || undefined);
  return make('other', riskFor('other', cfg), summary, 'arbitrary JavaScript in the page', pageHost || undefined);
}

// ── QodeX's own control center ──────────────────────────────────────────────

/** `?k=<token>` — the control center's login link format (16-256 URL-safe chars). */
const K_TOKEN_QUERY_RE = /[?&]k=[A-Za-z0-9_-]{16,256}(?![A-Za-z0-9_-])/;
const K_TOKEN_URL_RE = /(\bhttps?:\/\/([^\s"'<>/?#]+)[^\s"'<>]*?[?&]k=)[A-Za-z0-9_-]{16,256}(?![A-Za-z0-9_-])/gi;
/** Where `qodex control --tunnel` publishes the control center (cloudflared / ngrok / localtunnel). */
const TUNNEL_SUFFIXES = ['trycloudflare.com', 'ngrok.io', 'ngrok.app', 'ngrok-free.app', 'ngrok-free.dev', 'ngrok.dev', 'loca.lt'];

/**
 * Hide control-center access tokens: `?k=<token>` in http(s) URLs on a local /
 * private / tunnel host (where control centers live — public sites' `k=`
 * parameters in source files stay intact), plus the given raw tokens anywhere.
 * A model that saw the token could open the dashboard (or POST /api/approvals)
 * and approve its own actions. PURE.
 */
export function maskControlTokens(text: string, tokens: string[] = []): string {
  let s = String(text ?? '');
  if (s.includes('k=')) {
    s = s.replace(K_TOKEN_URL_RE, (whole, prefix: string, authority: string) => {
      const host = authority.replace(/^[^@]*@/, '').replace(/:\d+$/, '').toLowerCase();
      const controlHost = isPrivateHost(host) || TUNNEL_SUFFIXES.some(d => hostMatchesDomain(host, d));
      return controlHost ? `${prefix}[redacted]` : whole;
    });
  }
  for (const t of tokens) if (t && t.length >= 8 && s.includes(t)) s = s.split(t).join('[redacted]');
  return s;
}

const LOCAL_HOST_SRC = String.raw`(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\]|[\w.-]+\.(?:local|internal|localhost))`;

/** Why opening `t` would operate QodeX's own control center, or null. PURE. */
function controlCenterTarget(t: ParsedTarget | null, raw: string, cc: ControlCenterLike | null | undefined): string | null {
  if (cc?.token && cc.token.length >= 8 && raw.includes(cc.token)) return 'it carries the QodeX control center\'s access token';
  if (!t?.url || (t.scheme !== 'http' && t.scheme !== 'https')) return null;
  const host = t.host;
  const ccHosts = (cc?.hosts ?? []).map(h => h.toLowerCase());
  const known = ccHosts.includes(host);
  if (!known && !isPrivateHost(host)) return null;
  const port = Number(t.url.port || (t.scheme === 'https' ? 443 : 80));
  if (cc?.port && port === cc.port) return `${host}:${port} is QodeX's own control center (approvals, human takeover)`;
  if (known && !isPrivateHost(host)) return `${host} is the tunnel to QodeX's own control center`;
  if (K_TOKEN_QUERY_RE.test(t.url.search)) return 'it is a QodeX control center link (?k= access token)';
  return null;
}

/** Why a shell command would operate the control center, or null. PURE. */
function commandHitsControl(cmd: string, cc: ControlCenterLike | null | undefined): string | null {
  if (cc?.token && cc.token.length >= 8 && cmd.includes(cc.token)) return 'it uses the QodeX control center\'s access token';
  if (cc?.port) {
    const hosts = [LOCAL_HOST_SRC, ...(cc.hosts ?? []).map(escapeRe)].join('|');
    if (new RegExp(`(?:${hosts}):${cc.port}(?!\\d)`, 'i').test(cmd)) return `it talks to QodeX's own control center (port ${cc.port})`;
  }
  if (new RegExp(`${LOCAL_HOST_SRC}(?::\\d+)?\\/?\\?(?:[^\\s'"]*&)?k=[A-Za-z0-9_-]{16,}`, 'i').test(cmd)) return 'it uses a QodeX control center link (?k= access token)';
  return null;
}

function controlBlock(toolName: string, what: string, reason: string, domain?: string): PolicyClassification {
  return {
    ...make('account', 'critical', `${toolName} ${oneLine(maskControlTokens(maskSecrets(what)), 120)}`,
      `${reason} — the agent may never operate it (it could approve its own actions)`, domain, true),
    integrity: true,
  };
}

// ── navigation ──────────────────────────────────────────────────────────────

const HIGH_SCHEMES = new Set(['file', 'javascript', 'vbscript', 'data', 'chrome', 'chrome-extension', 'chrome-untrusted', 'devtools', 'edge', 'brave', 'opera', 'vivaldi', 'view-source', 'blob', 'filesystem']);

/** Classify opening `rawUrl` in the browser. PURE. */
export function classifyNavigation(rawUrl: string, ctx: PolicyContext, verb = 'open'): PolicyClassification {
  const cfg = ctx.config;
  const pp = ctx.protectedPaths ?? DEFAULT_PROTECTED_PATHS;
  const t = parseTarget(rawUrl);
  const shown = oneLine(maskControlTokens(maskSecrets(rawUrl)), 160);
  if (!t) return make('navigation', 'medium', `${verb} ${shown}`, 'the URL could not be parsed');
  const cc = controlCenterTarget(t, rawUrl, ctx.control);
  if (cc) return controlBlock(verb, rawUrl, cc, t.host || undefined);

  let scheme = t.scheme;
  let inner = t;
  if (scheme === 'view-source') {
    const p = parseTarget(rawUrl.replace(/^view-source:/i, ''));
    if (p) { inner = p; scheme = p.scheme; }
  }
  if (scheme === 'file') {
    let filePath = '';
    try { filePath = decodeURIComponent(inner.url?.pathname ?? ''); } catch { filePath = inner.url?.pathname ?? ''; }
    if (process.platform === 'win32') filePath = filePath.replace(/^\/([a-z]:)/i, '$1');
    if (isProtectedPath(filePath, ctx.cwd, pp) || textHitsProtectedMarker(rawUrl, pp)) {
      return make('credential', 'critical', `${verb} ${shown}`, 'that is QodeX\'s own secret store (vault / browser profiles) — never readable by the agent', undefined, true);
    }
    if (isPasswordExportFile(filePath)) return exportBlock(`${verb}`, filePath);
  }
  const host = inner.host;
  if (cfg.allowedDomains.length > 0 && rawUrl.trim().toLowerCase() !== 'about:blank') {
    const web = scheme === 'http' || scheme === 'https';
    if (!web || !host || !cfg.allowedDomains.some(d => hostMatchesDomain(host, d))) {
      return make('navigation', 'high', `${verb} ${shown}`, `${host || scheme + ':'} is not in sentinel.allowedDomains (${cfg.allowedDomains.join(', ')})`, host || undefined, true);
    }
  }
  if (host && cfg.blockedDomains.some(d => hostMatchesDomain(host, d))) {
    return make('navigation', 'high', `${verb} ${shown}`, `${host} is in sentinel.blockedDomains`, host, true);
  }
  if (host && cfg.blockPrivateNetwork && isPrivateHost(host)) {
    return make('navigation', 'high', `${verb} ${shown}`, `${host} is a private/local network address and sentinel.blockPrivateNetwork is on`, host, true);
  }
  // Long numeric ids in URLs often pass Luhn by chance: count a card only next to a card-ish name.
  const secrets = detectSecrets(rawUrl).filter(m => m.kind !== 'card' || /(card|cc|pan|cvv|kart)[^/?&=]{0,12}[=/:]?\s*$/i.test(rawUrl.slice(Math.max(0, m.index - 24), m.index)));
  if (secrets.length) {
    const local = !!host && isPrivateHost(host);
    return make('credential', riskFor('credential', cfg, { escalate: !local }), `${verb} ${shown}`, `the URL carries ${describeSecret(secrets[0].kind)} (possible exfiltration)`, host || undefined);
  }
  if (scheme === 'javascript' || scheme === 'vbscript' || scheme === 'data') {
    // Script-capable URLs. A javascript: URL runs in the CURRENT page, exactly like
    // browser_evaluate (Playwright's goto reports ERR_ABORTED but the script has already
    // run), so its script is classified; data:/vbscript: get the high-risk rule below.
    if (scheme === 'javascript') {
      let body = rawUrl.trim().replace(/^javascript:/i, '');
      try { body = decodeURIComponent(body); } catch { /* keep as is */ }
      const sc = classifyScript(body, ctx, `${verb} a javascript: URL`);
      if (sc.category && sc.category !== 'other') return sc;
    }
  }
  if (HIGH_SCHEMES.has(scheme) || HIGH_SCHEMES.has(t.scheme)) {
    return make('navigation', riskFor('navigation', cfg, { base: 'high' }), `${verb} ${shown}`, `${t.scheme}: URLs can read local files or run code in the page`, host || undefined);
  }
  return make('navigation', riskFor('navigation', cfg), `${verb} ${shown}`, 'opening a web page', host || undefined);
}

// ── tool tables ─────────────────────────────────────────────────────────────

/** Tools whose path / command arguments are checked against protected paths. */
const PATH_TOOLS = new Set([
  'read_file', 'write_file', 'edit_text', 'edit_symbol', 'multi_edit', 'multi_file_edit', 'ls', 'glob', 'grep',
  'pdf_read', 'csv_read', 'csv_write', 'xlsx_read', 'safe_delete_file', 'safe_rename', 'media_transform', 's3_sync',
]);
/** Path tools that read whole trees: a directory CONTAINING the vault / profiles is as protected as they are. */
const TREE_TOOLS = new Set(['grep', 's3_sync']);
const COMMAND_TOOLS = new Set(['shell', 'code_run', 'background_job_start', 'dev_server_start', 'docker_exec']);
const WRITE_TOOLS = new Set(['write_file', 'edit_text', 'edit_symbol', 'multi_edit', 'multi_file_edit', 'csv_write', 'safe_delete_file', 'safe_rename', 'media_transform']);

const BROWSER_GUARDED = new Set([
  'browser_navigate', 'browser_click', 'browser_fill', 'browser_type', 'browser_fill_form', 'browser_press',
  'browser_upload', 'browser_downloads', 'browser_evaluate', 'browser_tabs', 'browser_agent', 'browser_fill_secret',
  'browser_dialog', 'browser_wait_for', 'browser_request_human',
]);
const DESKTOP_GUARDED = new Set([
  'computer_use_click', 'computer_use_type', 'computer_use_key', 'computer_use_move', 'computer_use_drag',
  'computer_use_scroll', 'computer_use_clipboard', 'computer_use_open', 'computer_use_focus_window',
]);
const OTHER_GUARDED = new Set(['http_request', 'workflow_run', 'mail_send', 'vault_request_login']);
// Vault tools that sign in / create credentials (src/vault/login.ts, tools.ts).
for (const t of ['browser_login', 'vault_generate_and_fill']) BROWSER_GUARDED.add(t);

/** Literal name fragments that make any tool (MCP or not) a guarded action. */
const NAME_KEYWORD_RE = /send_email|send_message|post_|create_payment|transfer|purchase|delete/i;
const MCP_PREFIX_RE = /^mcp(?::|__)/i;

/** Fast path: is this tool ever classified? Everything else is low risk, no lookup. PURE. */
export function isGuardedTool(name: string): boolean {
  return BROWSER_GUARDED.has(name) || DESKTOP_GUARDED.has(name) || OTHER_GUARDED.has(name)
    || PATH_TOOLS.has(name) || COMMAND_TOOLS.has(name)
    || MCP_PREFIX_RE.test(name) || NAME_KEYWORD_RE.test(name);
}

// ── MCP / generic tools by name ─────────────────────────────────────────────

const READ_VERBS = new Set(['list', 'get', 'search', 'read', 'fetch', 'find', 'query', 'describe', 'show', 'view', 'retrieve', 'lookup', 'count', 'check', 'status', 'preview', 'inspect', 'download', 'export', 'explain', 'analyze', 'summarize', 'validate', 'whoami', 'resolve']);
const NAME_VERBS: Array<{ category: SentinelCategory; tokens: string[] }> = [
  { category: 'payment', tokens: ['pay', 'payment', 'payments', 'charge', 'transfer', 'refund', 'payout', 'withdraw', 'withdrawal', 'deposit', 'wire'] },
  { category: 'purchase', tokens: ['purchase', 'buy', 'order', 'checkout', 'subscribe', 'book', 'reserve'] },
  { category: 'credential', tokens: ['password', 'credential', 'credentials', 'secret', 'secrets', 'apikey'] },
  { category: 'account', tokens: ['revoke', '2fa', 'mfa'] },
  { category: 'send', tokens: ['send', 'post', 'publish', 'tweet', 'reply', 'comment', 'share', 'forward', 'email', 'mail', 'message', 'notify', 'broadcast', 'dm', 'repost', 'retweet', 'invite'] },
  { category: 'delete', tokens: ['delete', 'remove', 'destroy', 'drop', 'purge', 'erase', 'trash', 'wipe', 'truncate', 'uninstall'] },
  { category: 'publish', tokens: ['push', 'deploy', 'release', 'merge'] },
];

function nameTokens(name: string): string[] {
  let n = name;
  if (/^mcp:/i.test(n)) n = n.split(':').slice(2).join('_') || n.split(':').pop() || n;
  else if (/^mcp__/i.test(n)) n = n.split('__').slice(2).join('_') || n;
  return n.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function classifyByName(toolName: string, args: Record<string, unknown>, cfg: SentinelConfig): PolicyClassification {
  const tokens = nameTokens(toolName);
  const argSummary = Object.keys(args ?? {}).slice(0, 4).join(', ');
  const summary = `call ${toolName}${argSummary ? ` (${argSummary})` : ''}`;
  if (!tokens.length || READ_VERBS.has(tokens[0])) return none(summary);
  let hit: { category: SentinelCategory; token: string } | null = null;
  for (const v of NAME_VERBS) {
    const tok = tokens.find(t => v.tokens.includes(t));
    if (tok && (!hit || prio(v.category) < prio(hit.category))) hit = { category: v.category, token: tok };
  }
  if (!hit) return none(summary);
  const blob = JSON.stringify(args ?? {});
  const secrets = detectSecrets(blob);
  if (secrets.length && hit.category !== 'credential') {
    return make('credential', riskFor('credential', cfg), summary, `${toolName} would send ${describeSecret(secrets[0].kind)}`);
  }
  return make(hit.category, riskFor(hit.category, cfg), summary, `the tool name contains "${hit.token}" (${hit.category})`);
}

// ── helpers for args ────────────────────────────────────────────────────────

function str(v: unknown): string {
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
}

function collectPathArgs(toolName: string, args: Record<string, unknown>): string[] {
  const out: string[] = [];
  const keys = ['path', 'file_path', 'filepath', 'file', 'target', 'dir', 'directory', 'cwd', 'from', 'to', 'old_path', 'new_path', 'input', 'output', 'source', 'dest'];
  // glob's pattern IS a path; grep's pattern is a regex over contents (its file filter is `glob`).
  if (toolName === 'glob' && typeof args?.pattern === 'string') {
    out.push(path.join(typeof args.path === 'string' ? args.path : '.', args.pattern));
  }
  if (toolName === 'grep' && typeof args?.glob === 'string') out.push(args.glob);
  for (const k of keys) {
    const v = args?.[k];
    if (typeof v === 'string') out.push(v);
  }
  for (const k of ['paths', 'files', 'targets', 'inputs']) {
    const v = args?.[k];
    if (Array.isArray(v)) for (const x of v) if (typeof x === 'string') out.push(x);
  }
  const edits = args?.edits;
  if (Array.isArray(edits)) for (const e of edits) if (e && typeof e === 'object' && typeof (e as any).path === 'string') out.push((e as any).path);
  return out;
}

/** Changing QodeX's own configuration: always an explicit human answer (fixed critical). */
function configChange(toolName: string, what: string): PolicyClassification {
  return {
    ...make('account', 'critical', `${toolName} changes QodeX's configuration (${oneLine(maskControlTokens(maskSecrets(what)), 100)})`,
      'it can change Sentinel, the approval channels and other safety settings for every future run'),
    integrity: true,
  };
}

function protectedBlock(toolName: string, what: string): PolicyClassification {
  return make('credential', 'critical', `${toolName} ${oneLine(what, 120)}`,
    'that path is QodeX\'s own secret store (vault key, vault, browser profiles with your logins) — the agent may never read, change or send it',
    undefined, true);
}

/** A password-manager export (plaintext passwords): only the human imports it. */
function exportBlock(toolName: string, what: string): PolicyClassification {
  return make('credential', 'critical', `${toolName} ${oneLine(what, 120)}`,
    'that is a password-manager export with every password in plain text — only the user imports it (qodex vault import), the agent never reads, sends or opens it',
    undefined, true);
}

/** Desktop input that would run a QodeX approval / setup command (typed into a terminal). */
function desktopSelfChange(toolName: string, text: string): PolicyClassification {
  return {
    ...make('account', 'critical', `${toolName}: "${oneLine(maskControlTokens(maskSecrets(text)), 100)}"`,
      'it types a QodeX command that changes its vault, safety settings or approval channels (an agent must never approve its own actions)'),
    integrity: true,
  };
}

/**
 * Opening these with the system handler (Start-Process / open / xdg-open) runs them as programs:
 * Windows executables, installers, scripts and shell-command files (.wsh, .scf, .settingcontent-ms,
 * ClickOnce .application / .appref-ms, .msc snap-ins), macOS Terminal / Automator files
 * (.command, .tool, .terminal, .workflow, .action), Linux launchers and self-running installers.
 */
const PROGRAM_EXT_RE = /\.(?:exe|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|msi|msp|com|scr|pif|cpl|lnk|reg|inf|scf|msc|gadget|application|appref-ms|settingcontent-ms|command|tool|terminal|workflow|action|app|sh|bash|zsh|csh|ksh|fish|run|bin|desktop|jar|py|appimage)$/i;
/** Script / shortcut types Windows also runs on open (Python launcher, Perl / Ruby, .url Internet Shortcuts). */
const WINDOWS_PROGRAM_EXT_RE = /\.(?:pyw|pl|rb|url)$/i;

/** Does opening this local path / name run it as a program? PURE (given the platform). */
function opensProgram(p: string): boolean {
  const s = String(p ?? '').trim().replace(/[\\/]+$/, ''); // "Foo.app/" is the bundle itself
  if (!PROGRAM_EXT_RE.test(s) && !(process.platform === 'win32' && WINDOWS_PROGRAM_EXT_RE.test(s))) return false;
  // "example.com" without a path is a web site, not a DOS program.
  return !/\.com$/i.test(s) || /[\\/]/.test(s);
}

/**
 * Protocol handlers with a history of code execution when a link is merely opened:
 * Follina's ms-msdt, search-ms / search, ms-officecmd, ms-appinstaller, ms-cxh, the CHM
 * viewers (its:, ms-its:, mk:) and Help Center (hcp:).
 */
const CODE_EXEC_SCHEMES = new Set([
  'ms-msdt', 'search-ms', 'search', 'ms-officecmd', 'ms-appinstaller', 'ms-cxh', 'ms-cxh-full', 'its', 'ms-its', 'mk', 'hcp',
]);

/**
 * Commands that power off, log out, kill, wipe or escalate privileges as soon as they are
 * LAUNCHED (`poweroff`, `logoff`, `gnome-session-quit` need no arguments) — what
 * computer_use_open does with an app name. Lower-case, no extension.
 */
const SYSTEM_COMMANDS = new Set([
  'shutdown', 'poweroff', 'reboot', 'halt', 'init', 'telinit', 'systemctl', 'loginctl', 'logoff', 'logout', 'tsdiscon',
  'gnome-session-quit', 'xfce4-session-logout', 'cinnamon-session-quit', 'lxqt-leave',
  'kill', 'killall', 'pkill', 'taskkill', 'xkill', 'rm', 'rmdir', 'del', 'erase', 'format', 'diskpart', 'dd', 'mkfs',
  'shred', 'wipefs', 'sudo', 'su', 'doas', 'pkexec', 'runas', 'rundll32', 'regsvr32', 'mshta', 'wscript', 'cscript',
  'bcdedit', 'vssadmin', 'cipher', 'wmic', 'reg', 'schtasks', 'crontab', 'launchctl', 'osascript',
]);

/** The system command a local path / app name launches, or null. PURE. */
function systemCommand(p: string): string | null {
  const base = (String(p ?? '').trim().replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.exe$/, '');
  return SYSTEM_COMMANDS.has(base) ? base : null;
}

function textPreview(text: string, mask: boolean): string {
  const t = String(text ?? '');
  if (mask) return `${t.length} character${t.length === 1 ? '' : 's'} (hidden)`;
  return `"${oneLine(maskSecrets(t), 100)}"`;
}

// ── main entry ──────────────────────────────────────────────────────────────

/**
 * Classify a tool call. PURE given its inputs: the guard supplies the active
 * tab URL, element descriptions and workflow contents through `ctx`.
 */
export function classifyAction(toolName: string, args: Record<string, unknown>, ctx: PolicyContext): PolicyClassification {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  const cfg = ctx.config;
  const pp = ctx.protectedPaths ?? DEFAULT_PROTECTED_PATHS;
  const pageHost = hostOf(ctx.url);
  const pageLocal = !!pageHost && isPrivateHost(pageHost);
  const onHost = pageHost ? ` on ${pageHost}` : '';

  // Protected locations: file + command tools.
  if (PATH_TOOLS.has(toolName)) {
    const paths = collectPathArgs(toolName, a);
    const hit = paths.find(p => isProtectedPath(p, ctx.cwd, pp));
    if (hit) return protectedBlock(toolName, hit);
    const exported = toolName === 'safe_delete_file' ? undefined : paths.find(p => isPasswordExportFile(p));
    if (exported) return exportBlock(toolName, exported);
    if (TREE_TOOLS.has(toolName)) {
      const tree = paths.find(p => !/^[a-z][a-z0-9+.-]*:\/\//i.test(p) && containsProtected(path.resolve(ctx.cwd || process.cwd(), expandHome(p)), pp));
      if (tree) return protectedBlock(toolName, tree);
    }
    if (WRITE_TOOLS.has(toolName)) {
      const cfgHit = paths.find(p => isConfigPath(path.resolve(ctx.cwd || process.cwd(), expandHome(p)), pp));
      if (cfgHit) return configChange(toolName, cfgHit);
    }
    return none(`${toolName}`);
  }
  if (COMMAND_TOOLS.has(toolName)) {
    const cmd = [a.command, a.cmd, a.code, a.script, Array.isArray(a.args) ? a.args.join(' ') : a.args].map(str).join(' ');
    const cwdArg = str(a.cwd);
    if (cwdArg && isProtectedPath(cwdArg, ctx.cwd, pp)) return protectedBlock(toolName, cwdArg);
    const runDir = cwdArg ? path.resolve(ctx.cwd || process.cwd(), expandHome(cwdArg)) : ctx.cwd;
    if (textHitsProtectedMarker(cmd, pp, runDir)) return protectedBlock(toolName, cmd);
    if (KEYCHAIN_ITEM_RE.test(cmd)) return protectedBlock(toolName, cmd);
    if (EXPORT_FILE_TEXT_RE.test(cmd)) return exportBlock(toolName, cmd);
    // tar / zip / rsync / cp -r / grep -r over ~/.qodex as a whole ships the vault key and profiles too.
    if (BULK_READ_RE.test(cmd) && (QODEX_ROOT_RE.test(cmd) || (!!runDir && containsProtected(runDir, pp)))) return protectedBlock(toolName, cmd);
    const cc = commandHitsControl(cmd, ctx.control);
    if (cc) return controlBlock(`${toolName}:`, cmd, cc);
    if (commandChangesConfig(cmd, pp)) return configChange(toolName, cmd);
    if (QODEX_SELF_CHANGE_RE.test(cmd)) {
      return {
        ...make('account', 'critical', `${toolName}: ${oneLine(maskControlTokens(maskSecrets(cmd)), 120)}`,
          'it changes QodeX\'s credential vault, safety settings or approval channels via the CLI (an agent must never approve its own actions)'),
        integrity: true,
      };
    }
    return none(toolName);
  }

  switch (toolName) {
    case 'browser_navigate': {
      const url = str(a.url);
      return classifyNavigation(url, ctx, a.new_tab ? 'open in a new tab' : 'navigate to');
    }
    case 'browser_tabs': {
      const action = str(a.action);
      if (action === 'new' && str(a.url)) return classifyNavigation(str(a.url), ctx, 'open in a new tab');
      return none(`tabs ${action}`);
    }
    case 'browser_agent': {
      const start = str(a.start_url);
      if (start) {
        const nav = classifyNavigation(start, ctx, 'start a browser agent at');
        if (nav.block || nav.risk !== 'low') return nav;
      }
      return none(`browser agent: ${oneLine(str(a.task), 80)}`);
    }

    case 'browser_click': {
      const hit = classifyActivation(ctx.element, str(a.element) || undefined, ctx.url, false, str(a.selector) || undefined);
      const summary = `click "${elementLabel(ctx.element, str(a.element) || str(a.ref) || str(a.selector))}"${roleSuffix(ctx.element)}${onHost}`;
      if (!hit) return none(summary, pageHost || undefined);
      return make(hit.category, riskFor(hit.category, cfg, { escalate: !pageLocal }), summary, hit.reason, pageHost || undefined);
    }
    case 'browser_press': {
      const key = str(a.key);
      const enter = isEnterKey(key);
      // Space activates a focused button / checkbox / switch just like a click.
      const space = !enter && isSpaceKey(key) && !!ctx.element && isButtonLike(ctx.element);
      if (!enter && !space) return none(`press ${key}`, pageHost || undefined);
      const hit = classifyActivation(ctx.element, undefined, ctx.url, enter, str(a.selector) || undefined);
      const summary = `press ${key} in "${elementLabel(ctx.element, str(a.ref) || str(a.selector) || 'the focused element')}"${roleSuffix(ctx.element)}${onHost}`;
      if (!hit) return none(summary, pageHost || undefined);
      return make(hit.category, riskFor(hit.category, cfg, { escalate: !pageLocal }), summary, hit.reason, pageHost || undefined);
    }
    case 'browser_fill':
    case 'browser_type': {
      const text = str(a.text ?? a.value);
      const submit = toolName === 'browser_type' && a.submit === true;
      const described = [str(a.element), selectorWords(str(a.selector))].filter(Boolean).join(' ') || undefined;
      const typing = classifyTyping(ctx.element, text, ctx.url, described);
      const mask = typing?.mask ?? false;
      const where = `"${elementLabel(ctx.element, str(a.element) || str(a.ref) || str(a.selector))}"${roleSuffix(ctx.element)}`;
      const summary = `type ${textPreview(text, mask)} into ${where}${submit ? ' and submit' : ''}${onHost}`;
      const activation = submit ? classifyActivation(ctx.element, str(a.element) || undefined, ctx.url, true, str(a.selector) || undefined) : null;
      const hit = bestHit([typing, activation].filter((h): h is Hit => !!h));
      if (!hit) return none(summary, pageHost || undefined);
      return make(hit.category, riskFor(hit.category, cfg, { escalate: !pageLocal }), summary, hit.reason, pageHost || undefined);
    }
    case 'browser_fill_form': {
      const fields = Array.isArray(a.fields) ? (a.fields as Array<Record<string, unknown>>) : [];
      const hits: Array<Hit & { label: string }> = [];
      for (const f of fields.slice(0, 50)) {
        // A field is addressed by its ref, or by a selector when it has none.
        const ref = str(f?.ref);
        const selector = str(f?.selector);
        const key = ref || selector;
        const el = (key && ctx.elements?.[key]) || null;
        const value = typeof f?.value === 'boolean' ? '' : str(f?.value);
        const h = classifyTyping(el, value, ctx.url, selector ? selectorWords(selector) || undefined : undefined);
        if (h) hits.push({ ...h, label: elementLabel(el, key) });
      }
      const top = bestHit(hits) as (Hit & { label: string }) | null;
      const summary = `fill ${fields.length} form field${fields.length === 1 ? '' : 's'}${top ? ` incl. "${top.label}"` : ''}${onHost}`;
      if (!top) return none(summary, pageHost || undefined);
      return make(top.category, riskFor(top.category, cfg, { escalate: !pageLocal }), summary, top.reason, pageHost || undefined);
    }
    case 'browser_upload': {
      const paths = (Array.isArray(a.paths) ? a.paths : [a.paths]).map(str).filter(Boolean);
      const names = paths.map(p => path.basename(p)).join(', ');
      const summary = `upload ${paths.length} file${paths.length === 1 ? '' : 's'} (${oneLine(names, 100)})${onHost}`;
      if (paths.some(p => isProtectedPath(p, ctx.cwd, pp))) return protectedBlock(toolName, names);
      if (paths.some(p => isPasswordExportFile(p))) return exportBlock(toolName, names);
      const secret = paths.find(p => isSecretFile(p));
      if (secret) {
        return make('credential', riskFor('credential', cfg, { escalate: !pageLocal }), summary, `${path.basename(secret)} looks like a credentials file`, pageHost || undefined);
      }
      return make('upload', riskFor('upload', cfg, { escalate: !pageLocal }), summary, 'sending local files to a website', pageHost || undefined);
    }
    case 'browser_downloads': {
      const action = str(a.action) || 'list';
      return make('download', riskFor('download', cfg), `downloads ${action}${onHost}`, 'browser downloads', pageHost || undefined);
    }
    case 'browser_dialog': {
      const action = str(a.action);
      const text = str(a.text);
      if (action === 'accept' && text && detectSecrets(text).length) {
        const k = detectSecrets(text)[0].kind;
        return make('credential', riskFor('credential', cfg, { escalate: !pageLocal }), `answer a page dialog with ${textPreview(text, true)}${onHost}`, `the text looks like ${describeSecret(k)}`, pageHost || undefined);
      }
      // Accepting a confirm()/prompt() commits what it asks ("Place this order?", "Delete your account?").
      const d = ctx.dialog;
      if (action === 'accept' && d?.message && !/^(?:alert|beforeunload)$/i.test(d.type ?? '')) {
        const hit = bestHit(keywordHits(normalizeText(d.message), true, 'the dialog says'));
        if (hit) {
          const summary = `accept the page dialog "${oneLine(maskSecrets(d.message), 100)}"${onHost}`;
          return make(hit.category, riskFor(hit.category, cfg, { escalate: !pageLocal }), summary, hit.reason, pageHost || undefined);
        }
      }
      return none(`dialog ${action}`, pageHost || undefined);
    }
    case 'browser_evaluate':
      return classifyScript(str(a.script ?? a.expression ?? a.code), ctx, 'run a page script');
    case 'browser_request_human':
      // Low risk: it only waits for the human (who acts in the browser themselves) and
      // never acts on the page. The human's own step is the consent, in every mode.
      return none(`hand the browser to the human: ${oneLine(str(a.reason), 80)}`, pageHost || undefined);
    case 'browser_wait_for':
      // A "function" wait polls its predicate IN the page: page JS like browser_evaluate.
      if (str(a.kind) === 'function') return classifyScript(str(a.value), ctx, 'wait on a page script');
      return none(`wait for ${str(a.kind) || 'the page'}`, pageHost || undefined);
    case 'browser_fill_secret': {
      const field = str(a.field) || 'secret';
      const summary = `fill the ${field} of vault entry "${oneLine(str(a.secret), 60)}" into "${elementLabel(ctx.element, str(a.ref) || str(a.selector) || 'the login form')}"${onHost}`;
      // Fixed risk: the vault tool itself enforces the entry's origins and the field type.
      return make('credential', 'high', summary, 'filling a stored credential (origin-checked by the vault)', pageHost || undefined);
    }
    case 'browser_login': {
      // Same fixed risk as browser_fill_secret: the vault checks the origin before every fill,
      // refuses a submit button that reads like a purchase / send / delete, and stops after one
      // failed attempt. A given url is still judged as a navigation (blocked / allowed domains).
      const raw = str(a.url).trim();
      const url = raw && !/^[a-z][a-z0-9+.-]*:/i.test(raw) ? `https://${raw}` : raw;
      if (url) {
        const nav = classifyNavigation(url, ctx, 'sign in at');
        if (nav.block) return nav;
      }
      const host = (url ? hostOf(url) : '') || pageHost;
      const summary = `sign in with vault entry "${oneLine(str(a.secret), 60)}"${host ? ` on ${host}` : ''}${a.submit === false ? ' (fill only)' : ''}`;
      return make('credential', 'high', summary, 'signing in with a stored credential (origin-checked by the vault, one attempt)', host || undefined);
    }
    case 'vault_generate_and_fill': {
      const entry = str(a.name) ? ` for vault entry "${oneLine(str(a.name), 60)}"` : '';
      const summary = `create and save a new password${entry} and fill it into "${elementLabel(ctx.element, str(a.ref) || str(a.selector) || 'the new-password field')}"${onHost}`;
      return make('credential', 'high', summary, 'a generated password, saved to the vault for this site before it is filled', pageHost || undefined);
    }

    // ── desktop ────────────────────────────────────────────────────────────
    case 'computer_use_type': {
      const text = str(a.text);
      // Typing `qodex mission approve ...` into a terminal is the agent approving itself.
      if (QODEX_SELF_CHANGE_RE.test(text) || commandHitsControl(text, ctx.control)) return desktopSelfChange(toolName, text);
      if (KEYCHAIN_ITEM_RE.test(text) || textHitsProtectedMarker(text, pp)) return protectedBlock(toolName, 'a command that reads the vault key');
      if (EXPORT_FILE_TEXT_RE.test(text)) return exportBlock(toolName, 'a password export');
      const enter = a.submit ? ' + Enter' : '';
      const secrets = detectSecrets(text);
      if (secrets.length) {
        return make('credential', riskFor('credential', cfg), `type ${textPreview(text, true)}${enter} on the desktop`, `the text looks like ${describeSecret(secrets[0].kind)}`);
      }
      const summary = `type ${textPreview(text, false)}${enter} on the desktop`;
      // submit presses Enter: judged like browser_type's submit (Enter in a message box sends it).
      // Without a known focused element there is nothing to match and it stays desktop input.
      const hit = a.submit ? classifyActivation(ctx.element, str(a.element) || undefined, ctx.url, true) : null;
      if (hit) return make(hit.category, riskFor(hit.category, cfg), summary, hit.reason);
      return make('desktop', riskFor('desktop', cfg), summary, a.submit ? 'keyboard input on your computer, then Enter (submits what has focus)' : 'keyboard input on your computer');
    }
    case 'computer_use_clipboard': {
      const action = str(a.action);
      const text = str(a.text);
      if (action === 'set' && (QODEX_SELF_CHANGE_RE.test(text) || commandHitsControl(text, ctx.control))) return desktopSelfChange(toolName, text);
      if (action === 'set' && detectSecrets(text).length) {
        return make('credential', riskFor('credential', cfg), `put ${textPreview(text, true)} on the clipboard`, `the text looks like ${describeSecret(detectSecrets(text)[0].kind)}`);
      }
      if (action === 'set') return make('desktop', riskFor('desktop', cfg), `set the clipboard to ${textPreview(text, false)}`, 'changing your clipboard');
      return none('read the clipboard');
    }
    case 'computer_use_open': {
      const target = str(a.target).trim().replace(/^(["'])(.+)\1$/, '$2');
      const shown = oneLine(maskControlTokens(maskSecrets(target)), 120);
      // Any scheme is a URL for the system handler (file:, javascript:, ms-settings:), not only
      // "x://"; a Windows drive path (C:\...) is not. host:port reads as http(s) (parseTarget).
      const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target);
      const scheme = hasScheme ? parseTarget(target)?.scheme ?? '' : '';
      if (scheme === 'javascript' || scheme === 'data' || scheme === 'vbscript') {
        return make('desktop', 'high', `open ${shown} on your computer`, `${scheme}: URLs run script / inline content, not a page or a file`, undefined, true);
      }
      let local = hasScheme ? '' : target;
      if (hasScheme || /^(?:www\.)?[\w-]+(?:\.[\w-]+)+(?:\/|$)/i.test(target)) {
        const nav = classifyNavigation(target, ctx, 'open in your default browser');
        if (nav.block || nav.category === 'credential' || nav.risk === 'critical') return nav;
        if (scheme === 'file') {
          // The file it names gets the local checks below.
          local = parseTarget(target)?.url?.pathname ?? target.replace(/^file:/i, '');
          try { local = decodeURIComponent(local); } catch { /* keep */ }
          if (process.platform === 'win32') local = local.replace(/^\/([a-z]:)/i, '$1');
        } else if (hasScheme && CODE_EXEC_SCHEMES.has(scheme)) {
          // Fixed critical, like a program: these handlers have run attacker code from a mere link.
          return make('other', 'critical', `open ${shown} with the app registered for ${scheme}:`,
            `${scheme}: links have been used to run code on this kind of system (protocol-handler exploits such as Follina)`, `${scheme}:`);
        } else if (hasScheme && scheme !== 'http' && scheme !== 'https') {
          return make('desktop', riskFor('desktop', cfg, { base: 'high' }), `open ${shown} with the app registered for ${scheme}:`,
            `${scheme}: links launch whatever app handles them (settings, installers, other protocol handlers)`, nav.domain || `${scheme}:`);
        } else if (hasScheme || !opensProgram(target)) {
          // A web page — unless a bare "setup.exe" only looked like a domain.
          return make('desktop', riskFor('desktop', cfg), nav.summary, 'opens in your own browser (with your logins)', nav.domain);
        }
      }
      if (isProtectedPath(local, ctx.cwd, pp)) return protectedBlock(toolName, shown);
      if (isPasswordExportFile(local)) return exportBlock(toolName, shown);
      if (opensProgram(local)) {
        // Fixed critical: Start-Process / open / xdg-open RUN it — code execution that /auto and
        // --yes never wave through (sentinel.autoApprove: [other] opts out).
        return make('other', 'critical', `run ${shown} on your computer`, 'opening a program or script with its system handler executes it, like a shell command');
      }
      const command = systemCommand(local);
      if (command) {
        // An app name is launched as a command: `poweroff` / `logoff` act without arguments.
        return make('other', 'critical', `run ${shown} on your computer`, `"${command}" is a system command (power, session, kill, delete or privileges) that acts as soon as it is launched`);
      }
      return make('desktop', riskFor('desktop', cfg), `open ${shown} on your computer`, 'launching an app or file on your computer');
    }
    case 'computer_use_click': {
      const where = `at (${str(a.x)}, ${str(a.y)})${a.button === 'right' ? ' (right button)' : ''} on the desktop`;
      const element = str(a.element).trim();
      if (!element) return make('desktop', riskFor('desktop', cfg), `click ${where}`, 'mouse input on your computer');
      const summary = `click "${elementLabel(null, element)}" ${where}`;
      // `element` (auto-filled from computer_use_locate) names what is clicked: judged like
      // browser_click on a button with that name. A right / middle click doesn't press it.
      const hit = a.button === 'right' || a.button === 'middle' ? null : classifyActivation({ role: 'button', name: element }, undefined, undefined, false);
      if (hit) return make(hit.category, riskFor(hit.category, cfg), summary, hit.reason);
      return make('desktop', riskFor('desktop', cfg), summary, 'mouse input on your computer');
    }
    case 'computer_use_drag':
      return make('desktop', riskFor('desktop', cfg), `drag on the desktop`, 'mouse input on your computer');
    case 'computer_use_key':
      return make('desktop', riskFor('desktop', cfg), `press ${oneLine(str(a.combo ?? a.key), 40)} on the desktop`, 'keyboard input on your computer');
    case 'computer_use_move':
    case 'computer_use_scroll':
    case 'computer_use_focus_window':
      // Pointer moves, scrolling and focusing a window change nothing by themselves.
      return make('desktop', 'low', `${toolName.replace('computer_use_', '')} on the desktop`, 'harmless desktop input');

    // ── network / workflows ────────────────────────────────────────────────
    case 'http_request': {
      const method = (str(a.method) || 'GET').toUpperCase();
      const url = str(a.url);
      const t = parseTarget(url);
      const host = t?.host ?? '';
      const local = !!host && isPrivateHost(host);
      const query = a.query && typeof a.query === 'object' ? JSON.stringify(a.query) : '';
      const headers = a.headers && typeof a.headers === 'object' ? JSON.stringify(a.headers) : str(a.headers);
      const cc = controlCenterTarget(t, `${url} ${query} ${headers} ${str(a.body)}`, ctx.control);
      if (cc) return controlBlock(`${method}`, url, cc, host || undefined);
      const summary = `${method} ${oneLine(maskControlTokens(maskSecrets(url)), 160)}`;
      const secrets = detectSecrets(`${url} ${query} ${str(a.body)}`);
      if (secrets.length) {
        return make('credential', riskFor('credential', cfg, { escalate: !local }), summary, `the request carries ${describeSecret(secrets[0].kind)} (possible exfiltration)`, host || undefined);
      }
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
        // Fixed medium: not the user's logged-in browser; the permission flow decides.
        return make('send', 'medium', summary, `${method} changes remote state`, host || undefined);
      }
      return none(summary, host || undefined);
    }
    case 'workflow_run':
      return classifyWorkflow(a, ctx);
    case 'mail_send':
      return classifyMailSend(a, ctx);

    // ── vault: the human types a login into QodeX's secure prompt (src/vault/requests.ts) ──
    case 'vault_request_login': {
      const host = parseTarget(str(a.site))?.host ?? '';
      const summary = `ask you to type the login for ${host || oneLine(str(a.site), 60) || 'a site'} into QodeX's secure prompt${str(a.name) ? ` (vault entry "${oneLine(str(a.name), 60)}")` : ''}`;
      // Fixed risk, like browser_fill_secret: the value never reaches the agent, and the
      // human typing it into the masked prompt / secure form is itself the consent.
      return make('credential', 'high', summary, 'storing a login you type (it goes straight into the vault, never to the agent)', host || undefined);
    }
  }

  if (MCP_PREFIX_RE.test(toolName) || NAME_KEYWORD_RE.test(toolName)) return classifyByName(toolName, a, cfg);
  return none(toolName);
}

// ── email (mail_send) ───────────────────────────────────────────────────────

/**
 * mail_send — sending email is the 'send' category (critical by default: always a
 * human, unless a standing mail-reply grant covers it — decided by the guard). The
 * summary and prompt lines are the mail core's own (src/mail/outgoing.ts): From, To,
 * Cc, Bcc, Subject, the thread it replies to, attachments from disk and a body
 * preview, secret-masked. PURE: the guard loads + verifies the draft into `ctx.mail`.
 *
 * A message the mail core already knows it will refuse (`problems`: a tampered or
 * missing draft, draft + fields, no recipient) needs no approval: the tool refuses it
 * before its own human gate, and nothing marks it approved.
 */
function classifyMailSend(a: Record<string, unknown>, ctx: PolicyContext): PolicyClassification {
  const cfg = ctx.config;
  const clean = (x: string, n: number) => oneLine(maskControlTokens(maskSecrets(String(x ?? ''))), n);
  const resolved = ctx.mail;
  if (resolved && resolved.description.problems.length) {
    return {
      category: null, risk: 'low',
      summary: `mail_send the mail tool will refuse: ${clean(resolved.description.problems.slice(0, 2).join('; '), 200)}`,
      reason: 'the message cannot be sent as given — nothing to approve',
    };
  }
  const draftId = str(a.draft_id ?? a.draftId).trim();
  // Without the guard's resolution a draft's contents are unknown: still a critical send.
  const desc = resolved?.description ?? (draftId ? null : describeOutgoingMail(a as MailSendArgs));
  if (!desc) {
    const summary = `send email draft ${clean(draftId, 60)} (its contents could not be read)`;
    return { ...make('send', riskFor('send', cfg), summary, 'sending an email whose draft could not be read'), details: [] };
  }
  const extras = [
    desc.isReplyTo ? `a reply in the thread of ${clean(desc.isReplyTo.threadSender, 80)}` : 'a NEW email (not a reply)',
    desc.cc.length ? `${desc.cc.length} cc` : '',
    desc.bcc.length ? `${desc.bcc.length} bcc (hidden recipients)` : '',
    desc.extraRecipients.length && desc.isReplyTo ? `${desc.extraRecipients.length} recipient(s) outside the thread` : '',
    desc.attachments.length ? `${desc.attachments.length} attachment(s) from disk` : '',
    desc.isReplyTo?.injectionFlagged ? 'the original email was flagged for prompt injection' : '',
  ].filter(Boolean).join(', ');
  const details = formatOutgoingPrompt(desc).map(l => clean(l, 600));
  const secrets = detectSecrets(`${desc.subject}\n${resolved?.body ?? desc.bodyPreview}`);
  if (secrets.length) details.push(`⚠ The email would send ${describeSecret(secrets[0].kind)}.`);
  const first = desc.to[0] ?? desc.cc[0] ?? desc.bcc[0] ?? '';
  const at = first.lastIndexOf('@');
  const domain = at > 0 ? first.slice(at + 1).toLowerCase() || undefined : undefined;
  return { ...make('send', riskFor('send', cfg), clean(summarizeOutgoingMail(desc), 400), `sending an email: ${extras}`, domain), details };
}

// ── workflows ───────────────────────────────────────────────────────────────

function classifyWorkflow(a: Record<string, unknown>, ctx: PolicyContext): PolicyClassification {
  const cfg = ctx.config;
  const name = str(a.name);
  const wf = ctx.workflow;
  const params = Array.isArray(a.params) ? (a.params as Array<Record<string, unknown>>) : [];
  const paramVals: Record<string, string> = {};
  for (const p of params) if (p && typeof p.name === 'string') paramVals[p.name] = str(p.value);
  if (a.dry_run === true) return none(`dry-run workflow "${name}"`);
  if (!wf) return make('other', riskFor('other', cfg), `replay workflow "${oneLine(name, 60)}"`, 'recorded browser steps (contents unknown)');

  // Replay fills params the caller left out from their defaults (src/workflows/replay.ts resolveParams).
  for (const p of wf.params ?? []) {
    if (p?.name && typeof p.default === 'string' && !(p.name in paramVals)) paramVals[p.name] = p.default;
  }
  const steps = Array.isArray(wf.steps) ? wf.steps : [];
  const secretParams = new Set((wf.params ?? []).filter(p => (p?.secret || p?.vaultField) && p.name).map(p => String(p.name)));
  const subst = (s: string | undefined) => String(s ?? '').replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, k) => paramVals[k] ?? `{{${k}}}`);
  let currentUrl = wf.startUrl ? subst(wf.startUrl) : '';
  let worst: { cls: PolicyClassification; idx: number } | null = null;
  const consider = (cls: PolicyClassification, idx: number) => {
    if (cls.block) { if (!worst?.cls.block) worst = { cls, idx }; return; }
    if (!cls.category || worst?.cls.block) return;
    const rank = (c: PolicyClassification) => ['low', 'medium', 'high', 'critical'].indexOf(c.risk) * 100 - prio(c.category!);
    if (!worst || rank(cls) > rank(worst.cls)) worst = { cls, idx };
  };
  if (currentUrl) consider(classifyNavigation(currentUrl, { ...ctx, url: undefined }, 'open'), -1);

  steps.forEach((s, i) => {
    const kind = str(s?.kind);
    const el: ElementInfo = { role: s?.role, name: s?.name ? subst(s.name) : undefined, text: s?.text && kind === 'click' ? subst(s.text) : undefined, selector: s?.selector };
    const pageCtx: PolicyContext = { ...ctx, url: currentUrl || undefined, element: el };
    const opensUrl = (kind === 'navigate' || (kind === 'tab' && (!s?.value || s.value === 'new'))) && !!s?.url;
    if (opensUrl) {
      const target = subst(s.url);
      // A new tab becomes the active tab, so later steps act on it too.
      currentUrl = target;
      consider(classifyNavigation(target, pageCtx, 'open'), i);
    } else if (kind === 'click') {
      consider(classifyAction('browser_click', {}, pageCtx), i);
    } else if (kind === 'press') {
      consider(classifyAction('browser_press', { key: str(s?.key) || 'Enter' }, pageCtx), i);
    } else if (kind === 'type' || kind === 'fill') {
      const raw = String(s?.value ?? s?.text ?? '');
      const solo = raw.match(/^\s*\{\{\s*([\w.-]+)\s*\}\}\s*$/);
      // "vault:<entry>" for a secret param: replay fills it through browser_fill_secret,
      // which checks the entry's origins itself — same fixed risk as that tool.
      if (solo && secretParams.has(solo[1]) && /^vault:\S+$/.test(paramVals[solo[1]] ?? '')) {
        const host = hostOf(currentUrl);
        consider(make('credential', 'high', `fill vault entry "${oneLine(paramVals[solo[1]].slice(6), 60)}" into "${elementLabel(el)}"${host ? ` on ${host}` : ''}`,
          'filling a stored credential (origin-checked by the vault)', host || undefined), i);
        return;
      }
      const usesSecret = [...raw.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)].some(m => secretParams.has(m[1]));
      const elT: ElementInfo = { ...el, text: undefined, isPassword: usesSecret || undefined };
      consider(classifyAction('browser_type', { text: subst(raw) }, { ...pageCtx, element: elT }), i);
    } else if (kind === 'upload') {
      const files = Array.isArray(s?.files) && s.files.length
        ? s.files.map(f => subst(String(f ?? '')))
        : subst(s?.value ?? s?.text).split(/[,\n]/);
      consider(classifyAction('browser_upload', { paths: files.map(x => x.trim()).filter(Boolean) }, pageCtx), i);
    }
  });

  const total = `${steps.length} step${steps.length === 1 ? '' : 's'}`;
  const w = worst as { cls: PolicyClassification; idx: number } | null;
  if (!w) return make('other', 'low', `replay workflow "${oneLine(name, 60)}" (${total})`, 'recorded browser steps with no guarded actions');
  const at = w.idx >= 0 ? `step ${w.idx + 1}: ` : '';
  return {
    ...w.cls,
    summary: oneLine(`replay workflow "${name}" (${total}) — ${at}${w.cls.summary}`, 200),
    reason: oneLine(`${at}${w.cls.reason}`, 240),
  };
}

/** Exposed for tests / UIs: the keyword categories a label would trigger on a button. PURE. */
export function categoriesForLabel(label: string, opts: { role?: string; href?: string; pageUrl?: string } = {}): SentinelCategory | null {
  const el: ElementInfo = { name: label, role: opts.role ?? 'button', href: opts.href };
  const hit = classifyActivation(el, undefined, opts.pageUrl, false);
  return hit?.category ?? null;
}
