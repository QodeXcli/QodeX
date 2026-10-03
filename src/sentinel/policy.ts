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
 *   - uploads, downloads, page scripts, desktop input, mutating HTTP requests,
 *     workflow replays and MCP tools (by the verb in their name);
 *   - file/shell tools touching the vault key, the vault or browser profiles
 *     (hard block: those are the agent's credentials).
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
import { QODEX_CONFIG_FILE, QODEX_HOME } from '../config/defaults.js';
import { QODEX_BROWSER_PROFILES_DIR, QODEX_VAULT_FILE, QODEX_VAULT_KEY_FILE } from '../config/paths.js';
import type { ElementInfo } from '../tools/browser/types.js';
import type { ActionClassification, RiskLevel } from './types.js';

// ── public types ────────────────────────────────────────────────────────────

/** Minimal shape of a recorded workflow (src/workflows) the policy can inspect. */
export interface WorkflowLike {
  name?: string;
  startUrl?: string;
  params?: Array<{ name?: string; secret?: boolean }>;
  steps?: Array<{
    kind?: string; url?: string; selector?: string; ref?: string; role?: string; name?: string;
    text?: string; value?: string; key?: string;
  }>;
}

export interface ProtectedPaths {
  /** Exact files the agent may never read/write/upload/navigate to. */
  files: string[];
  /** Directories (and everything below) with the same protection. */
  dirs: string[];
  /** Substrings that identify those locations inside free-form commands. */
  markers: string[];
  /**
   * QodeX's own configuration (incl. the Sentinel settings). Reading is fine;
   * CHANGING it needs an explicit human answer, so injected page text can't get
   * the agent to switch Sentinel off for future runs.
   */
  configFiles?: string[];
}

export interface PolicyContext {
  /** URL of the browser's active tab ('' / undefined when no browser). */
  url?: string;
  /** Element behind the call's ref/selector, if it could be described. */
  element?: ElementInfo | null;
  /** browser_fill_form: element info per field ref. */
  elements?: Record<string, ElementInfo | null>;
  config: SentinelConfig;
  /** Tool working directory, for resolving relative paths. */
  cwd?: string;
  /** workflow_run: the workflow about to be replayed (null = not found). */
  workflow?: WorkflowLike | null;
  /** Override the protected-path set (tests). */
  protectedPaths?: ProtectedPaths;
}

export interface PolicyClassification extends ActionClassification {
  /** Hard policy block: the guard denies without asking anyone. */
  block?: boolean;
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
  files: [QODEX_VAULT_KEY_FILE, QODEX_VAULT_FILE],
  dirs: [QODEX_BROWSER_PROFILES_DIR],
  markers: [markerFor(QODEX_VAULT_KEY_FILE), markerFor(QODEX_VAULT_FILE), markerFor(QODEX_BROWSER_PROFILES_DIR)],
  configFiles: [QODEX_CONFIG_FILE],
};

/** Shell fragments that write/move/delete a file (vs. merely reading it). */
const SHELL_WRITE_RE = /(?<![<=-])>>?(?!\s*(?:\/dev\/null|&\d))|\btee\b|\bsed\s+(?:-[a-z]*\s+)*-[a-z]*i|\bperl\s+-[a-z]*i|\b(?:mv|cp|rm|truncate|chmod|chown|ln|install|dd)\b|writeFile|\.write\(|open\([^)]*['"][wa]|Set-Content|Out-File|Remove-Item|Move-Item|Copy-Item/i;

/** CLI invocations that change the vault or QodeX's own setup (`qodex vault rm github`, `qx setup`). */
const QODEX_SELF_CHANGE_RE = /\b(?:qodex|qx)(?:\.mjs)?\s+(?:vault\s+(?:add|rm|remove)|setup|config\s+(?:set|edit|reset))\b/i;

/** Does `text` mention one of the config files? PURE. */
function mentionsConfig(text: string, pp: ProtectedPaths): boolean {
  const t = String(text ?? '').replace(/\\/g, '/').toLowerCase();
  return (pp.configFiles ?? []).some(f => t.includes(f.replace(/\\/g, '/').toLowerCase()) || t.includes(markerFor(f).toLowerCase()));
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
function classifyActivation(el: ElementInfo | null | undefined, description: string | undefined, pageUrl: string | undefined, submit: boolean): Hit | null {
  const buttonLike = isButtonLike(el);
  const hits: Hit[] = [];
  const page = parseTarget(pageUrl ?? '');
  const pageHost = page?.host ?? '';

  const visible = normalizeText([el?.name, el?.text, description].filter(Boolean).join(' | '));
  hits.push(...keywordHits(visible, buttonLike || !el, 'button/link'));
  const ids = normalizeText(selectorWords(el?.selector));
  if (ids) hits.push(...keywordHits(ids, buttonLike, 'element id'));

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

// ── navigation ──────────────────────────────────────────────────────────────

const HIGH_SCHEMES = new Set(['file', 'javascript', 'data', 'chrome', 'chrome-extension', 'chrome-untrusted', 'devtools', 'edge', 'brave', 'opera', 'vivaldi', 'view-source', 'blob', 'filesystem']);

/** Classify opening `rawUrl` in the browser. PURE. */
export function classifyNavigation(rawUrl: string, ctx: PolicyContext, verb = 'open'): PolicyClassification {
  const cfg = ctx.config;
  const pp = ctx.protectedPaths ?? DEFAULT_PROTECTED_PATHS;
  const t = parseTarget(rawUrl);
  const shown = oneLine(maskSecrets(rawUrl), 160);
  if (!t) return make('navigation', 'medium', `${verb} ${shown}`, 'the URL could not be parsed');

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
  if (HIGH_SCHEMES.has(scheme) || HIGH_SCHEMES.has(t.scheme)) {
    return make('navigation', riskFor('navigation', cfg, { base: 'high' }), `${verb} ${shown}`, `${t.scheme}: URLs can read local files or run code in the page`, host || undefined);
  }
  return make('navigation', riskFor('navigation', cfg), `${verb} ${shown}`, 'opening a web page', host || undefined);
}

// ── tool tables ─────────────────────────────────────────────────────────────

/** Tools whose path / command arguments are checked against protected paths. */
const PATH_TOOLS = new Set([
  'read_file', 'write_file', 'edit_text', 'edit_symbol', 'multi_edit', 'multi_file_edit', 'ls', 'glob', 'grep',
  'pdf_read', 'csv_read', 'csv_write', 'xlsx_read', 'safe_delete_file', 'safe_rename', 'media_transform',
]);
const COMMAND_TOOLS = new Set(['shell', 'code_run', 'background_job_start', 'dev_server_start', 'docker_exec']);
const WRITE_TOOLS = new Set(['write_file', 'edit_text', 'edit_symbol', 'multi_edit', 'multi_file_edit', 'csv_write', 'safe_delete_file', 'safe_rename', 'media_transform']);

const BROWSER_GUARDED = new Set([
  'browser_navigate', 'browser_click', 'browser_fill', 'browser_type', 'browser_fill_form', 'browser_press',
  'browser_upload', 'browser_downloads', 'browser_evaluate', 'browser_tabs', 'browser_agent', 'browser_fill_secret',
  'browser_dialog',
]);
const DESKTOP_GUARDED = new Set([
  'computer_use_click', 'computer_use_type', 'computer_use_key', 'computer_use_move', 'computer_use_drag',
  'computer_use_scroll', 'computer_use_clipboard', 'computer_use_open', 'computer_use_focus_window',
]);
const OTHER_GUARDED = new Set(['http_request', 'workflow_run']);

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
  const keys = ['path', 'file_path', 'filepath', 'file', 'target', 'dir', 'directory', 'cwd', 'from', 'to', 'old_path', 'new_path', 'input', 'output'];
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
  return make('account', 'critical', `${toolName} changes QodeX's configuration (${oneLine(maskSecrets(what), 100)})`,
    'it can change Sentinel and other safety settings for every future run');
}

function protectedBlock(toolName: string, what: string): PolicyClassification {
  return make('credential', 'critical', `${toolName} ${oneLine(what, 120)}`,
    'that path is QodeX\'s own secret store (vault key, vault, browser profiles with your logins) — the agent may never read, change or send it',
    undefined, true);
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
    if (WRITE_TOOLS.has(toolName)) {
      const cfgHit = paths.find(p => (pp.configFiles ?? []).some(f => normPath(path.resolve(ctx.cwd || process.cwd(), expandHome(p))) === normPath(f)));
      if (cfgHit) return configChange(toolName, cfgHit);
    }
    return none(`${toolName}`);
  }
  if (COMMAND_TOOLS.has(toolName)) {
    const cmd = [a.command, a.cmd, a.code, a.script, Array.isArray(a.args) ? a.args.join(' ') : a.args].map(str).join(' ');
    const cwdArg = str(a.cwd);
    if (cwdArg && isProtectedPath(cwdArg, ctx.cwd, pp)) return protectedBlock(toolName, cwdArg);
    if (textHitsProtectedMarker(cmd, pp, cwdArg ? path.resolve(ctx.cwd || process.cwd(), expandHome(cwdArg)) : ctx.cwd)) return protectedBlock(toolName, cmd);
    if (mentionsConfig(cmd, pp) && SHELL_WRITE_RE.test(cmd)) return configChange(toolName, cmd);
    if (QODEX_SELF_CHANGE_RE.test(cmd)) {
      return make('account', 'critical', `${toolName}: ${oneLine(maskSecrets(cmd), 120)}`,
        'it changes QodeX\'s credential vault or safety settings via the CLI');
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
      const hit = classifyActivation(ctx.element, str(a.element) || undefined, ctx.url, false);
      const summary = `click "${elementLabel(ctx.element, str(a.element) || str(a.ref) || str(a.selector))}"${roleSuffix(ctx.element)}${onHost}`;
      if (!hit) return none(summary, pageHost || undefined);
      return make(hit.category, riskFor(hit.category, cfg, { escalate: !pageLocal }), summary, hit.reason, pageHost || undefined);
    }
    case 'browser_press': {
      const key = str(a.key);
      if (!/enter|return/i.test(key)) return none(`press ${key}`, pageHost || undefined);
      const hit = classifyActivation(ctx.element, undefined, ctx.url, true);
      const summary = `press ${key} in "${elementLabel(ctx.element, str(a.ref) || 'the focused element')}"${roleSuffix(ctx.element)}${onHost}`;
      if (!hit) return none(summary, pageHost || undefined);
      return make(hit.category, riskFor(hit.category, cfg, { escalate: !pageLocal }), summary, hit.reason, pageHost || undefined);
    }
    case 'browser_fill':
    case 'browser_type': {
      const text = str(a.text ?? a.value);
      const submit = toolName === 'browser_type' && a.submit === true;
      const typing = classifyTyping(ctx.element, text, ctx.url, str(a.element) || undefined);
      const mask = typing?.mask ?? false;
      const where = `"${elementLabel(ctx.element, str(a.element) || str(a.ref) || str(a.selector))}"${roleSuffix(ctx.element)}`;
      const summary = `type ${textPreview(text, mask)} into ${where}${submit ? ' and submit' : ''}${onHost}`;
      const activation = submit ? classifyActivation(ctx.element, str(a.element) || undefined, ctx.url, true) : null;
      const hit = bestHit([typing, activation].filter((h): h is Hit => !!h));
      if (!hit) return none(summary, pageHost || undefined);
      return make(hit.category, riskFor(hit.category, cfg, { escalate: !pageLocal }), summary, hit.reason, pageHost || undefined);
    }
    case 'browser_fill_form': {
      const fields = Array.isArray(a.fields) ? (a.fields as Array<Record<string, unknown>>) : [];
      const hits: Array<Hit & { label: string }> = [];
      for (const f of fields.slice(0, 50)) {
        const ref = str(f?.ref);
        const el = ctx.elements?.[ref] ?? null;
        const value = typeof f?.value === 'boolean' ? '' : str(f?.value);
        const h = classifyTyping(el, value, ctx.url);
        if (h) hits.push({ ...h, label: elementLabel(el, ref) });
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
      return none(`dialog ${action}`, pageHost || undefined);
    }
    case 'browser_evaluate': {
      const script = str(a.script ?? a.expression ?? a.code);
      const touches = script.match(/\b(fetch|XMLHttpRequest|sendBeacon|WebSocket|EventSource|document\.cookie|localStorage|sessionStorage|indexedDB|navigator\.credentials|navigator\.clipboard|\.submit\s*\(|window\.open|location\s*(?:\.href)?\s*=|location\.(?:assign|replace)|postMessage|importScripts)\b/);
      const summary = `run a page script (${script.length} chars)${touches ? ` using ${touches[1]}` : ''}${onHost}`;
      if (touches) return make('other', riskFor('other', cfg, { base: 'high' }), summary, `the script uses ${touches[1]} (network / cookies / storage access)`, pageHost || undefined);
      return make('other', riskFor('other', cfg), summary, 'arbitrary JavaScript in the page', pageHost || undefined);
    }
    case 'browser_fill_secret': {
      const field = str(a.field) || 'secret';
      const summary = `fill the ${field} of vault entry "${oneLine(str(a.secret), 60)}" into "${elementLabel(ctx.element, str(a.ref) || str(a.selector) || 'the login form')}"${onHost}`;
      // Fixed risk: the vault tool itself enforces the entry's origins and the field type.
      return make('credential', 'high', summary, 'filling a stored credential (origin-checked by the vault)', pageHost || undefined);
    }

    // ── desktop ────────────────────────────────────────────────────────────
    case 'computer_use_type': {
      const text = str(a.text);
      const secrets = detectSecrets(text);
      if (secrets.length) {
        return make('credential', riskFor('credential', cfg), `type ${textPreview(text, true)} on the desktop`, `the text looks like ${describeSecret(secrets[0].kind)}`);
      }
      return make('desktop', riskFor('desktop', cfg), `type ${textPreview(text, false)} on the desktop`, 'keyboard input on your computer');
    }
    case 'computer_use_clipboard': {
      const action = str(a.action);
      const text = str(a.text);
      if (action === 'set' && detectSecrets(text).length) {
        return make('credential', riskFor('credential', cfg), `put ${textPreview(text, true)} on the clipboard`, `the text looks like ${describeSecret(detectSecrets(text)[0].kind)}`);
      }
      if (action === 'set') return make('desktop', riskFor('desktop', cfg), `set the clipboard to ${textPreview(text, false)}`, 'changing your clipboard');
      return none('read the clipboard');
    }
    case 'computer_use_open': {
      const target = str(a.target);
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target) || /^(?:www\.)?[\w-]+(?:\.[\w-]+)+(?:\/|$)/i.test(target)) {
        const nav = classifyNavigation(target, ctx, 'open in your default browser');
        if (nav.block || nav.category === 'credential' || nav.risk === 'critical') return nav;
        return make('desktop', riskFor('desktop', cfg), nav.summary, 'opens in your own browser (with your logins)', nav.domain);
      }
      return make('desktop', riskFor('desktop', cfg), `open ${oneLine(target, 120)} on your computer`, 'launching an app or file on your computer');
    }
    case 'computer_use_click':
      return make('desktop', riskFor('desktop', cfg), `click at (${str(a.x)}, ${str(a.y)})${a.button === 'right' ? ' (right button)' : ''} on the desktop`, 'mouse input on your computer');
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
      const summary = `${method} ${oneLine(maskSecrets(url), 160)}`;
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
  }

  if (MCP_PREFIX_RE.test(toolName) || NAME_KEYWORD_RE.test(toolName)) return classifyByName(toolName, a, cfg);
  return none(toolName);
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

  const steps = Array.isArray(wf.steps) ? wf.steps : [];
  const secretParams = new Set((wf.params ?? []).filter(p => p?.secret && p.name).map(p => String(p.name)));
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
    if (kind === 'navigate' && s?.url) {
      currentUrl = subst(s.url);
      consider(classifyNavigation(currentUrl, pageCtx, 'open'), i);
    } else if (kind === 'click') {
      consider(classifyAction('browser_click', {}, pageCtx), i);
    } else if (kind === 'press') {
      consider(classifyAction('browser_press', { key: str(s?.key) || 'Enter' }, pageCtx), i);
    } else if (kind === 'type' || kind === 'fill' || kind === 'select') {
      const raw = String(s?.value ?? s?.text ?? '');
      const usesSecret = [...raw.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)].some(m => secretParams.has(m[1]));
      const elT: ElementInfo = { ...el, text: undefined, isPassword: usesSecret || undefined };
      if (kind !== 'select') consider(classifyAction('browser_type', { text: subst(raw) }, { ...pageCtx, element: elT }), i);
    } else if (kind === 'upload') {
      consider(classifyAction('browser_upload', { paths: subst(s?.value ?? s?.text).split(/[,\n]/).map(x => x.trim()).filter(Boolean) }, pageCtx), i);
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
