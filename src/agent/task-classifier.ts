/**
 * Prompt task-class detection (which "## Task profile" addendum the system prompt gets).
 *
 * Extracted from AgentLoop.classifyForPrompt so it is PURE and table-testable. It is a
 * regex cascade over the user's request, English + Persian. Order matters:
 *
 *   strong web → backend → web → desktop → frontend → refactor → debug → review →
 *   explain → analysis → feature → general
 *
 * 'web' and 'desktop' are jobs to DO on a site / on the user's computer (book a table,
 * fill a form on a site, open the Notes app), not code to WRITE. They are detected
 * before 'frontend' because the frontend regex is broad ("page", "form", "site", سایت)
 * and would otherwise swallow "fill the form on example.com" / "برو تو سایت دیجی‌کالا".
 * Coding requests that merely mention a site ("build a landing page", "fix the login
 * form component", "یه سایت فروشگاهی بساز") must stay frontend/debug, so every web /
 * desktop rule is guarded by a coding-intent check.
 *
 * Persian notes: JS `\b` does not fire around non-ASCII letters, so Persian patterns
 * are written without it. New web/desktop rules run on a normalized copy of the text
 * (ZWNJ → space, Arabic ي/ك → Persian ی/ک); the legacy rules run on the raw lowercase
 * text exactly as before so their behavior is unchanged.
 */

import type { TaskClass } from '../llm/prompts/task-addenda.js';

export type { TaskClass as PromptTaskClass };

// ── URL / domain detection (shared idea with tool-relevance.ts, which keeps its own
//    copy so that standalone scripts can import it without runtime .js imports) ──

const TLDS = 'com|ir|org|net|io|dev|app|co|ai|me|info|xyz|edu|gov|uk|de|shop|store';
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/i;
const URL_RE_G = /\bhttps?:\/\/[^\s<>"'`]+/gi;
/** Bare domain: `digikala.com`, `www.example.co`, `shop.example.io` — but not
 *  `this.app.use()` (followed by `.word`), not an e-mail (`a@b.com`), not a file. */
const DOMAIN_RE = new RegExp(`(?<![@\\w.-])(?:[a-z0-9][a-z0-9-]*\\.)+(?:${TLDS})(?![\\w(-])(?!\\.[a-z0-9])`, 'i');
const LOCAL_URL_RE = /\b(?:localhost|127\.0\.0\.1):\d{2,5}\b/i;

/** True when the text contains an http(s) URL, a bare domain, or a localhost:port address. PURE. */
export function containsUrlOrDomain(text: string): boolean {
  const t = String(text ?? '');
  return URL_RE.test(t) || DOMAIN_RE.test(t) || LOCAL_URL_RE.test(t);
}

/** Lowercase + Persian normalization (ZWNJ → space, ي→ی, ك→ک, collapse spaces). PURE. */
export function normalizeForClassify(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .replace(/\u200c/g, ' ')
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[\u064B-\u0652]/g, '') // Arabic diacritics
    .replace(/\s+/g, ' ')
    .trim();
}

// ── signal vocabularies ─────────────────────────────────────────────────────────

/** Popular sites people name without a TLD. github/gitlab are deliberately absent:
 *  "open a PR on github" is usually a coding request. */
const KNOWN_SITES_EN = 'amazon|ebay|aliexpress|etsy|walmart|bestbuy|youtube|twitter|linkedin|facebook|instagram|reddit|gmail|booking\\.com|airbnb|expedia|tripadvisor|skyscanner|kayak|craigslist|netflix|spotify|opentable|uber eats|doordash';
const KNOWN_SITES_FA = 'دیجی ?کالا|دیجیکالا|دیوار|اسنپ ?فود|اسنپ ?تریپ|اسنپ|تپسی|علی ?بابا|ترب|باسلام|شیپور|آپارات|فیلیمو|نماوا|کافه ?بازار|جاباما|اینستاگرام|توییتر|لینکدین|یوتیوب|گوگل|آمازون|جیمیل';

/** Navigation intent ("go to", "visit", "log in to", ...). */
const NAV_VERB_RE = /\b(go to|goto|navigate to|visit|browse to|head (?:over )?to|open|load|log ?in(?:to)?|sign ?in(?:to)?|sign ?up|register (?:on|at))\b/;
const KNOWN_SITE_EN_RE = new RegExp(`\\b(${KNOWN_SITES_EN})\\b`);
const KNOWN_SITE_FA_RE = new RegExp(`(${KNOWN_SITES_FA})`);

/** Code/file markers: a request that names source files or a codebase is a coding job
 *  even when it also mentions a URL (URLs are stripped before this test). */
const CODE_MARKER_RE = /(\b[\w-]+\.(?:tsx?|jsx?|mjs|cjs|py|php|rb|go|rs|java|kt|swift|vue|svelte|css|scss|less|html?|json|ya?ml|toml|md|sql|sh)\b|\bsrc\/|\bcodebase\b|\bpull request\b|\bstack ?trace\b|\bunit tests?\b|\btest suite\b)/;

/** Coding intent (English). Either a plainly technical word, or a build verb aimed at a UI/code noun. */
const CODING_WORD_RE = /\b(implement|refactor|debug|fix|bug|bugs|scaffold|redesign|deploy|compile|lint|coding|code|function|component|class|module|endpoint|api|exception|crash|stack ?trace|repo|repository|codebase|landing ?page|css|html|jsx|tsx|react|vue|svelte|angular|next\.?js|tailwind|typescript|javascript|python|django|laravel|php|wordpress (?:theme|plugin)|readme|changelog|docstring|regex|schema|migration|unit tests?)\b/;
const CODING_BUILD_RE = /\b(build|create|make|add|write|design|develop|style|generate|update|change|edit)\b[^.!?\n]{0,60}\b(sites?|website|web ?app|apps?|pages?|form|forms|button|component|layout|navbar|header|footer|modal|ui|ux|frontend|backend|dashboard|feature|flow|template|widget|section|hero|logo|link|links|route|handler|validation|script|bot|scraper|crawler|extension|toggle|dark mode|theme|animation|icon|menu)\b/;
/** Persian coding intent: technical words, or a build verb whose object is a site/UI/code
 *  noun ("یه سایت فروشگاهی بساز"). The object must precede the verb without an ' و '
 *  (and) in between, so "برو تو سایت و یه اکانت بساز" (go to the site and make an
 *  account) is NOT a coding request. */
const FA_CODING_RE = new RegExp(
  // Whole words only: Persian letters must not continue the word on either side
  // ("کد" must not hit "کدام", "اپ" must not hit "دسکتاپ").
  '(?<![\\u0600-\\u06FF])(کد|کدها|کدنویسی|برنامه ?نویسی|پیاده ?سازی|کامپوننت|ریفکتور|دیباگ|باگ|فرانت|بک ?اند|ری ?اکت|لندینگ|اسکریپت بنویس|طراحی سایت)(?![\\u0600-\\u06FF])'
  + '|(?<![\\u0600-\\u06FF])(سایت|وبسایت|وب سایت|صفحه|کامپوننت|فرم|دکمه|اپ|اپلیکیشن|لندینگ|ربات|اسکریپت|قالب|منو)(?![\\u0600-\\u06FF])'
  + '(?:(?!\\sو\\s)[^.!؟?\\n]){0,30}?(بساز|بسازی|بسازید|طراحی کن|طراحی کنید|درست کن|اصلاح کن)',
);

/** Site actions that don't need a URL. */
const SITE_ACTION_RES: RegExp[] = [
  /\b(log ?in|sign ?in)\s+(to|into|on|at)\b/,
  /\blogin\s+(to|into|on|at)\b/,
  /\b(sign ?up|register|create an account)\s+(on|at|for|with)\b/,
  /\b(buy|purchase)\s+(me\s+|us\s+)?(a|an|the|some|\d+|this|that|it|one|two|cheap|cheapest|new|tickets?)\b/,
  /\b(place|submit) (an|the|my|this) order\b/,
  /\border\s+(online|from|on|via)\b/,
  /\border me\b/,
  /\b(book|reserve)\s+(me\s+|us\s+)?(a|an|the|my|two|2)?\s*(flights?|tables?|rooms?|hotels?|tickets?|appointments?|rides?|taxis?|cabs?|seats?|cars?|stays?|trips?|spots?|reservations?)\b/,
  /\b(add|put)\b[^.!?\n]{1,60}\b(to|in|into) (my |the )?(shopping )?(cart|basket)\b/,
  /\bcheck ?out\b[^.!?\n]{0,30}\b(cart|basket|order)\b/,
  /\bfill (in|out)\b[^.!?\n]{0,40}\b(form|application|survey|questionnaire)\b/,
  /\bfill\b[^.!?\n]{0,30}\bform\b[^.!?\n]{0,30}\b(on|at)\b/,
  /\bsearch (on|in) (google|bing|amazon|youtube|the web|the site|duckduckgo)\b/,
  new RegExp(`\\b(on|at|from|via) (${KNOWN_SITES_EN})\\b`),
  /\b(post|tweet|publish|share)\b[^.!?\n]{0,40}\b(on|to) (twitter|x|linkedin|facebook|instagram|reddit|mastodon|threads)\b/,
  /\b(cheapest|lowest price|best price|compare prices|price comparison)\b/,
  /\b(open|visit|go to|check|read)\s+(the |this |that |their |a )?(website|web ?page|web ?site)\b/,
];

/** Persian site actions ("برو تو سایت", "وارد سایت", "از دیجی‌کالا", "خرید کن", ...). Run on normalized text. */
const FA_SITE_ACTION_RES: RegExp[] = [
  /(برو|بره|برید|بریم)\s+(تو|به|توی|داخل)\s+(سایت|وبسایت|وب سایت|صفحه|لینک)/,
  /وارد\s+(سایت|وبسایت|وب سایت|حساب|اکانت)/,
  /(سایت|وبسایت|وب سایت|لینک|صفحه)\s+.{0,40}?(رو|را)\s+باز\s+کن/,
  new RegExp(`(از|تو|توی|در|روی)\\s+(${KNOWN_SITES_FA})`),
  new RegExp(`(${KNOWN_SITES_FA})\\s+(رو|را)\\s+(باز|چک)\\s+کن`),
  /خرید\s+کن/,
  /(^|\s)بخر(\s|$|[.!؟?،])/,
  /سفارش\s+(بده|بدید|ثبت\s+کن)/,
  /ثبت ?نام\s+کن/,
  /رزرو\s+کن/,
  /فرم\s+.{0,40}?(رو|را)?\s*پر\s+کن/,
  /(لاگین|لاگ ?این)\s+کن/,
  /سبد\s+خرید/,
  // Price lookups ("کدوم سایت ارزون‌تره؟", "قیمت دلار امروز") — but not pricing strategy.
  /^(?!.*(تحلیل|استراتژی|بیزینس|کسب ?و ?کار)).*((ارزان|ارزون) ?(تر|ترین)|قیمت(?!\s?گذاری))/,
  /(سرچ|جستجو)\s+کن\s+(تو|توی|در)\s+(گوگل|سایت)/,
  /(تو|توی|در)\s+گوگل\s+(سرچ|جستجو)/,
];

/** Desktop intents (English). */
const DESKTOP_RES: RegExp[] = [
  /\bon my (desktop|screen|computer|mac|macbook|pc|laptop)\b/,
  /\bmy (desktop|screen)\b/,
  /\bdesktop app(lication)?s?\b/,
  /\b(open|launch|start|switch to|close|quit|focus) (the |my )?[\w.-]+(?: [\w.-]+)? (app|application|window)\b/,
  /\bfinder\b/,
  /\bsystem (settings|preferences)\b/,
  /\bcontrol panel\b/,
  /\b(file|windows) explorer\b/,
  /\bopen (the )?(system )?settings\b(?! (page|screen|tab|panel|component|view|menu|modal|route|file))/,
  /\btask manager\b/,
  /\bstart menu\b/,
  /\bmenu bar\b/,
  /\btaskbar\b/,
  /\bthe dock\b/,
  /\bclick on\b/,
  /\bscreenshot of (my|the) (screen|desktop)\b/,
  /\bwhat'?s on my screen\b/,
];

/** Desktop intents (Persian). Run on normalized text. */
const FA_DESKTOP_RES: RegExp[] = [
  /(روی|رو|تو|توی|از)\s+(دسکتاپ|صفحه نمایش|صفحه نمایشم|مانیتور)/,
  /دسکتاپ\s*(من|م)(\s|$)/,
  /(برنامه|اپ|اپلیکیشن|نرم ?افزار)\s+.{1,30}?\s*(رو|را)\s+(باز|ببند)\s+کن/,
  /فایندر/,
  /تنظیمات\s+(سیستم|ویندوز|مک)/,
  /کنترل\s+پنل/,
  /(روی|رو)\s+.{1,30}?\s*کلیک\s+کن/,
  /کلیک\s+کن\s+روی/,
];

function stripUrls(text: string): string {
  return text.replace(URL_RE_G, ' ');
}

/** Coding intent on a URL-stripped text (EN + FA). PURE. */
function hasCodingIntent(textNoUrls: string): boolean {
  return CODING_WORD_RE.test(textNoUrls) || CODING_BUILD_RE.test(textNoUrls) || FA_CODING_RE.test(textNoUrls) || CODE_MARKER_RE.test(textNoUrls);
}

/** Verbs that make even a URL-bearing request a coding job ("open <github url> and fix it"). */
const STRONG_CODING_RE = /\b(fix|debug|refactor|implement|bug|bugs|scaffold|deploy|compile|lint|crash|exception|stack ?trace|pull request|commit|merge|rewrite)\b/;

/** A request to DO something on a website with an unambiguous target (navigation verb +
 *  URL/domain/known site, no source files named, no fix/debug intent). Checked before
 *  backend. PURE. */
function isStrongWeb(n: string): boolean {
  const noUrls = stripUrls(n);
  if (CODE_MARKER_RE.test(noUrls) || STRONG_CODING_RE.test(noUrls) || FA_CODING_RE.test(noUrls)) return false;
  const hasTarget = containsUrlOrDomain(n) || KNOWN_SITE_EN_RE.test(n) || KNOWN_SITE_FA_RE.test(n);
  if (!hasTarget) return false;
  if (NAV_VERB_RE.test(noUrls)) return true;
  // Persian navigation with a concrete target ("دیجی‌کالا رو باز کن", "برو تو digikala.com").
  return /(برو|بره|برید|وارد|باز\s+کن)/.test(noUrls);
}

/** A job on the web (weaker signals), guarded by coding intent. PURE. */
function isWeb(n: string): boolean {
  const noUrls = stripUrls(n);
  if (hasCodingIntent(noUrls)) return false;
  if (containsUrlOrDomain(n)) return true;
  if (SITE_ACTION_RES.some(r => r.test(noUrls))) return true;
  return FA_SITE_ACTION_RES.some(r => r.test(noUrls));
}

/** A job on the user's desktop, guarded by coding intent and URLs (a URL means web). PURE. */
function isDesktop(n: string): boolean {
  if (containsUrlOrDomain(n)) return false;
  if (hasCodingIntent(n)) return false;
  return DESKTOP_RES.some(r => r.test(n)) || FA_DESKTOP_RES.some(r => r.test(n));
}

/**
 * Classify a user request for the system-prompt task addendum. PURE.
 * Returns one of the prompt TaskClass values ('general' when nothing specific fits).
 */
export function classifyTaskForPrompt(input: string): TaskClass {
  const text = String(input ?? '').toLowerCase();
  const n = normalizeForClassify(input);

  // Unambiguous "do this on <site>" wins even over backend words ("go to
  // https://api.example.com/docs and summarize the REST API").
  if (isStrongWeb(n)) return 'web';

  // Backend / Django signals — checked FIRST among the coding classes so "design the Django
  // models" classifies as backend, not frontend. Persian terms are matched WITHOUT \b — JS
  // word boundaries don't fire around non-ASCII letters.
  if (/\b(django|drf|django ?rest|serializer|viewset|queryset|orm|migration|makemigrations|models?\.py|celery|wsgi|asgi|manage\.py|backend|back ?end|api ?endpoint|rest ?api)\b/.test(text)
    || /(جنگو|بک‌?اند|بک ?اند|بکند|سمت ?سرور|پایگاه ?داده|دیتابیس)/.test(text)) {
    return 'backend';
  }

  // Jobs on a website / on the desktop — before frontend, whose regex is broad.
  if (isWeb(n)) return 'web';
  if (isDesktop(n)) return 'desktop';

  // Frontend signals — strongest match (overrides feature/refactor when explicit).
  if (/\b(design|redesign|ui|ux|frontend|landing(?: ?page)?|hero(?: section)?|component|style|theme|layout|animation|three\.?js|react three|r3f|page|button|navbar|header|footer|card|modal|dropdown|form ?design|color|palette|tailwind|shadcn|figma|wireframe|prototype|mockup|polish|aesthetic|beautiful|elegant|modern|minimalist|gradient|glassmorphism|neumorphism|skeuomorphic|3d|scene|webgl|shader|seo|json-?ld|structured ?data|schema\.?org|rich ?results|open ?graph|sitemap)\b/.test(text)
    || /(دیزاین|طراحی|زیبا|فرانت|قشنگ|مدرن|گرادیان|ظاهر|رابط ?کاربری|سایت|وب ?سایت)/.test(text)) {
    return 'frontend';
  }
  // Highest-signal first
  if (/\b(refactor|restructure|clean ?up|simplify|extract|inline|rename|move|consolidate|deduplicate|untangle)\b/.test(text)) return 'refactor';
  if (/\b(debug|fix|error|exception|crash|broken|bug|broke|stuck|hang|throwing|undefined|null|fail|regression|نمی‌?کار|نمیکار|خراب|باگ|اشکال|درست(?: نمی| نمی))\b/.test(text)) return 'debug';
  if (/\b(review|critique|audit|inspect|code ?review|smell|improve|quality|بررسی)\b/.test(text)) return 'review';
  if (/\b(explain|describe|what does|how does|walk through|understand|چطور|چگونه|توضیح)\b/.test(text)) return 'explain';
  // Analytical / decision / business tasks — NOT coding. Checked before `feature` so
  // "build a business plan" / "develop a strategy" classify as analysis, not a build task.
  if (/\b(trade-?offs?|business ?plan|pros and cons|cost[- ]benefit|swot|feasibility|go-to-market|value proposition|market analysis|competitive analysis|monetiz|decision matrix|which (?:option |one )?(?:is )?better|compare\b[\s\S]*\b(?:vs|versus)\b|evaluate (?:the )?options|weigh (?:the )?(?:options|pros)|should (?:i|we) (?:use|choose|pick|go with)|strategy|analy[sz]e|analysis)\b/.test(text)
    || /(تحلیل|بیزینس ?پلن|طرح ?کسب|کسب ?و ?کار|استراتژی|مقایسه|مزایا و معایب|سود و زیان|گزینه|ارزیابی|امکان ?سنجی|تصمیم|بازار)/.test(text)) {
    return 'analysis';
  }
  if (/\b(add|build|implement|create|new feature|develop|integrate|بساز|اضافه|پیاده ?سازی|ایجاد)\b/.test(text)) return 'feature';
  return 'general';
}
