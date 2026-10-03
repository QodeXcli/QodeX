/**
 * CAPTCHA / bot-check ("challenge") detection for the QodeX browser.
 *
 * QodeX never solves challenges: no solver services, no vision/audio solving, no
 * clicking / typing / dragging into a challenge widget by the agent, no synthesized
 * human-like input, no fingerprint spoofing. This module only RECOGNISES them so the
 * browser can (a) wait out the ones that clear by themselves (Cloudflare's "Just a
 * moment…", Akamai / DataDome / AWS WAF interstitials, proof-of-work widgets),
 * (b) hand the rest to the human (browser_request_human) and resume when they are
 * gone, and (c) refuse agent actions inside a challenge ([CHALLENGE_HUMAN_ONLY]).
 *
 *   classifyChallenge  PURE: {mainUrl, title, status, headers, frames, domMarkers} →
 *                      {vendor, state, host, frameUrl?, frameBox?, hint} | null
 *   CHALLENGE_PROBE_FN in-page probe (built from a string — tsconfig has no DOM lib)
 *                      returning booleans / lengths / one box only: it never reads a
 *                      response token's VALUE (those are bearer tokens), only its length.
 *   detectChallenge    read-only probe of a Playwright page: a capped number of
 *                      round-trips, errors → 'unknown' (a self-reloading interstitial
 *                      destroys the execution context mid-probe).
 *   waitForChallengeChange  poll until a condition holds, a timeout, or ctx.signal.
 *
 * A challenge frame URL is reported as origin + path only — never its query string
 * (site keys, `__cf_chl_*` tokens).
 */

import type { ElementInfo } from './types.js';

export type ChallengeVendor =
  | 'recaptcha' | 'hcaptcha' | 'turnstile' | 'cloudflare' | 'akamai' | 'perimeterx' | 'datadome'
  | 'aws-waf' | 'arkose' | 'geetest' | 'kasada' | 'ddos-guard' | 'sucuri' | 'imperva'
  | 'friendly-captcha' | 'altcha' | 'yandex' | 'captcha';

/** self-clearing: passes by itself in a normal browser within seconds; needs-human: only a person can pass it; blocked: nobody can (an access-denied page). */
export type ChallengeState = 'self-clearing' | 'needs-human' | 'blocked';

export interface ChallengeBox { x: number; y: number; w: number; h: number }

/** One child frame of the page as seen from Node (url is sync state; the box is one round-trip). */
export interface ChallengeFrameInfo {
  url: string;
  visible: boolean;
  w: number;
  h: number;
  x?: number;
  y?: number;
  /** Inside reCAPTCHA's v3 / invisible badge (`.grecaptcha-badge`) — never a challenge. */
  badge?: boolean;
}

/** What the in-page probe reports: booleans, lengths and one box — never a token value. */
export interface ChallengeMarkers {
  bodyTextLen: number;
  recaptcha: boolean;
  recaptchaResponseLen: number;
  recaptchaBadge: boolean;
  hcaptcha: boolean;
  hcaptchaResponseLen: number;
  turnstile: boolean;
  turnstileResponseLen: number;
  cfInterstitial: boolean;
  cfBlocked: boolean;
  checkingText: boolean;
  akamaiInterstitial: boolean;
  accessDeniedRef: boolean;
  perimeterx: boolean;
  datadome: boolean;
  awsCaptcha: boolean;
  arkose: boolean;
  geetest: boolean;
  friendly: boolean;
  altcha: boolean;
  yandex: boolean;
  imperva: boolean;
  impervaBlocked: boolean;
  sucuriChallenge: boolean;
  sucuriBlocked: boolean;
  ddosGuard: boolean;
  ddosGuardCaptcha: boolean;
  genericCaptcha: boolean;
  /** Box (viewport CSS px) of the most relevant visible in-page challenge element. */
  box?: ChallengeBox | null;
}

export interface ChallengeInput {
  mainUrl: string;
  title: string;
  status?: number;
  /** Main-document response headers (lower-case names; only the whitelisted ones matter). */
  headers?: Record<string, string>;
  frames: ChallengeFrameInfo[];
  /** null = the in-page probe could not run (navigation in flight, page busy). */
  domMarkers: ChallengeMarkers | null;
}

export interface ChallengeInfo {
  vendor: ChallengeVendor;
  state: ChallengeState;
  /** Host of the page that shows the challenge (no path, no query). */
  host: string;
  /** origin + path of the challenge frame — never its query string. */
  frameUrl?: string;
  /** Where the challenge is on screen (viewport CSS px), for zooming / clipping the hand-off view. */
  frameBox?: ChallengeBox;
  /** One line for the model: what it is and what to do. */
  hint: string;
}

/** Response headers worth keeping for detection (everything else is dropped). */
export const CHALLENGE_HEADER_NAMES = [
  'server', 'cf-mitigated', 'cf-ray', 'x-datadome', 'x-dd-b', 'x-amzn-waf-action',
  'x-kpsdk-ct', 'x-kpsdk-r', 'x-kpsdk-c', 'x-sucuri-id', 'x-sucuri-block', 'x-cdn', 'x-iinfo',
] as const;

/** Keep only the detection headers, lower-cased and length-capped. PURE. */
export function pickChallengeHeaders(all: Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!all || typeof all !== 'object') return out;
  for (const [k, v] of Object.entries(all)) {
    const name = k.toLowerCase();
    if ((CHALLENGE_HEADER_NAMES as readonly string[]).includes(name) && typeof v === 'string') out[name] = v.slice(0, 200);
  }
  return out;
}

const LABELS: Record<ChallengeVendor, string> = {
  recaptcha: 'reCAPTCHA',
  hcaptcha: 'hCaptcha',
  turnstile: 'Cloudflare Turnstile',
  cloudflare: 'Cloudflare check',
  akamai: 'Akamai bot check',
  perimeterx: 'PerimeterX "Press & Hold"',
  datadome: 'DataDome CAPTCHA',
  'aws-waf': 'AWS WAF CAPTCHA',
  arkose: 'Arkose/FunCaptcha',
  geetest: 'GeeTest CAPTCHA',
  kasada: 'Kasada check',
  'ddos-guard': 'DDoS-Guard check',
  sucuri: 'Sucuri check',
  imperva: 'Imperva check',
  'friendly-captcha': 'Friendly Captcha',
  altcha: 'ALTCHA',
  yandex: 'Yandex SmartCaptcha',
  captcha: 'CAPTCHA',
};

/** Human-readable vendor name ("reCAPTCHA", "Cloudflare check"). PURE. */
export function challengeLabel(vendor: ChallengeVendor): string {
  return LABELS[vendor] ?? 'CAPTCHA';
}

/** Host of a URL ('' when it is not one). PURE. */
export function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return ''; }
}

/** origin + path of a URL (no query, no fragment); '' when it is not a URL. PURE. */
export function stripQuery(url: string): string {
  try {
    const u = new URL(url);
    return u.origin !== 'null' ? `${u.origin}${u.pathname}` : `${u.protocol}${u.pathname}`;
  } catch {
    return String(url ?? '').split(/[?#]/)[0] ?? '';
  }
}

/**
 * Any frame URL that belongs to a challenge vendor (one regex, also embedded in the
 * in-page element describer so an element inside such a frame is marked `challenge`).
 * Path signatures match too, so a self-hosted / proxied widget is still recognised.
 */
export const CHALLENGE_FRAME_URL_RE =
  /\/recaptcha\/(?:api2|enterprise)\/(?:anchor|bframe|fallback)|(?:^|[./])hcaptcha\.com\/|\/hcaptcha(?:-challenge)?\.html|\/\/challenges\.cloudflare\.com\/|\/cdn-cgi\/challenge-platform\/|captcha-delivery\.com\/|(?:arkoselabs|funcaptcha|octocaptcha)\.com\/|\/_sec\/cp_challenge\/|smartcaptcha\.yandexcloud\.net\/|captcha-api\.yandex\.ru\/|captcha\.(?:px-cdn\.net|perimeterx\.net)\/|captcha(?:-sdk)?\.awswaf\.com\/|(?:^|[./])geetest\.com\/|\/_Incapsula_Resource/i;

/** Vendor (and kind) of a challenge frame URL, else null. PURE. */
export function challengeFrameVendor(rawUrl: string): { vendor: ChallengeVendor; kind: string } | null {
  const url = String(rawUrl ?? '');
  if (!CHALLENGE_FRAME_URL_RE.test(url)) return null;
  let u: URL | null = null;
  try { u = new URL(url); } catch { u = null; }
  const host = u?.hostname.toLowerCase() ?? '';
  const pathName = u?.pathname ?? url;
  const query = u?.search ?? '';
  const hash = u?.hash ?? '';
  const rc = /\/recaptcha\/(?:api2|enterprise)\/(anchor|bframe|fallback)/i.exec(pathName);
  if (rc) {
    const kind = rc[1]!.toLowerCase();
    // The invisible / v3 widget's anchor sits in the corner badge: never a challenge.
    if (kind === 'anchor' && /[?&]size=invisible(?:&|$)/i.test(query)) return { vendor: 'recaptcha', kind: 'invisible' };
    return { vendor: 'recaptcha', kind };
  }
  if (/(?:^|\.)hcaptcha\.com$/.test(host) || /\/hcaptcha(?:-challenge)?\.html/i.test(pathName)) {
    return { vendor: 'hcaptcha', kind: /frame=challenge/i.test(hash + query) ? 'challenge' : 'checkbox' };
  }
  if (host === 'challenges.cloudflare.com' || /\/cdn-cgi\/challenge-platform\//i.test(pathName)) return { vendor: 'turnstile', kind: 'turnstile' };
  if (/(?:^|\.)captcha-delivery\.com$/.test(host)) {
    if (/\/interstitial\//i.test(pathName)) return { vendor: 'datadome', kind: 'interstitial' };
    if (/[?&]t=bv(?:&|$)/i.test(query)) return { vendor: 'datadome', kind: 'block' };
    return { vendor: 'datadome', kind: 'captcha' };
  }
  if (/(?:^|\.)(?:arkoselabs|funcaptcha|octocaptcha)\.com$/.test(host)) return { vendor: 'arkose', kind: 'captcha' };
  if (/\/_sec\/cp_challenge\//i.test(pathName)) return { vendor: 'akamai', kind: 'interstitial' };
  if (host === 'smartcaptcha.yandexcloud.net' || host === 'captcha-api.yandex.ru') return { vendor: 'yandex', kind: 'captcha' };
  if (/^captcha\.(?:px-cdn\.net|perimeterx\.net)$/.test(host)) return { vendor: 'perimeterx', kind: 'captcha' };
  if (/(?:^|\.)captcha(?:-sdk)?\.awswaf\.com$/.test(host)) return { vendor: 'aws-waf', kind: 'captcha' };
  if (/(?:^|\.)geetest\.com$/.test(host)) return { vendor: 'geetest', kind: 'captcha' };
  if (/\/_Incapsula_Resource/i.test(pathName)) return { vendor: 'imperva', kind: 'captcha' };
  return null;
}

/** True for a frame URL of a challenge vendor (the frame the agent must never act in). PURE. */
export function isChallengeFrameUrl(url: string): boolean {
  return challengeFrameVendor(url) !== null;
}

/**
 * Containers of known challenge widgets in the HOST page. An element inside one is
 * part of the challenge (the agent may not act on it). Deliberately specific: a
 * generic `[class*=captcha]` ancestor would flag a whole login form ("has-captcha").
 */
export const CHALLENGE_CONTAINER_SELECTOR = [
  '.g-recaptcha', '.h-captcha', '.cf-turnstile', '#px-captcha', '#px-captcha-wrapper',
  '.geetest_holder', '.geetest_panel', '.geetest_widget', '.geetest_box', '[class^="geetest_"]',
  '#captcha-container', '#FunCaptcha', '#arkose', '#arkose-container', '.frc-captcha', 'altcha-widget',
  '.smart-captcha', '#sec-if-cpt-container', '#challenge-stage', '#challenge-form', '#cf-challenge-running',
  '#ddg-captcha', '.grecaptcha-badge',
].join(', ');

/** Own attributes (id / class / name / placeholder / aria-label / img src+alt) that make an element a CAPTCHA part. */
export const CHALLENGE_ATTR_RE = /captcha|کپچا|کد امنیتی|حروف (?:داخل )?تصویر/i;

/**
 * Element-describer fragment (in-page, ES5): `true` when `el` is part of a challenge —
 * inside a challenge frame, inside a known widget container, or a CAPTCHA field/image
 * itself. Expects `el`, `doc`, `tag` and `attr` in scope (snapshot.ts DESCRIBE_ELEMENT_JS).
 */
export const CHALLENGE_ELEMENT_JS = `(function () {
  try {
    var href = '';
    try { href = String((doc.defaultView || window).location.href); } catch (e) { href = ''; }
    if (${CHALLENGE_FRAME_URL_RE.toString()}.test(href)) return true;
    if (el.closest && el.closest(${JSON.stringify(CHALLENGE_CONTAINER_SELECTOR)})) return true;
    var own = [el.id || '', typeof el.className === 'string' ? el.className : '', attr('name') || '', attr('placeholder') || '', attr('aria-label') || ''];
    if (tag === 'img') { own.push(attr('src') || ''); own.push(attr('alt') || ''); }
    return ${CHALLENGE_ATTR_RE.toString()}.test(own.join(' '));
  } catch (e) { return false; }
})()`;

const CHALLENGE_SELECTOR_WORD_RE = /captcha|geetest_|cf-turnstile|g-recaptcha|h-captcha|px-captcha|funcaptcha|arkose|frc-captcha|altcha|smart-captcha|challenge-(?:form|stage|running)|کپچا|کد امنیتی/i;

/**
 * Is this described element part of a challenge? `el.challenge` comes from the
 * in-page describer; the selector / name heuristic covers records that were described
 * elsewhere (the workflow recorder's capture script). PURE.
 */
export function isChallengeElement(el: ElementInfo | null | undefined): boolean {
  if (!el) return false;
  if (el.challenge === true) return true;
  return CHALLENGE_SELECTOR_WORD_RE.test(`${el.selector ?? ''} ${el.name ?? ''}`);
}

// ── classification (PURE) ───────────────────────────────────────────────────

const MIN_FRAME_PX = 20;

function frameShown(f: ChallengeFrameInfo): boolean {
  return f.visible && !f.badge && f.w >= MIN_FRAME_PX && f.h >= MIN_FRAME_PX;
}

function boxOf(f: ChallengeFrameInfo): ChallengeBox | undefined {
  if (typeof f.x !== 'number' || typeof f.y !== 'number') return undefined;
  return { x: Math.round(f.x), y: Math.round(f.y), w: Math.round(f.w), h: Math.round(f.h) };
}

/** The model-facing hint for a challenge (`report`: the hand-off is off — tell the user instead). PURE. */
export function challengeHint(vendor: ChallengeVendor, state: ChallengeState, host: string, mode: 'auto' | 'report' = 'auto'): string {
  const what = `${challengeLabel(vendor)}${host ? ` on ${host}` : ''}`;
  if (state === 'blocked') return `${host || 'The site'} blocked this browser (${challengeLabel(vendor)}). A human cannot solve this here — stop and tell the user; do not retry or reload.`;
  const next = mode === 'report'
    ? 'Stop and tell the user (they can take over the live browser).'
    : 'Call browser_request_human — it hands the browser to the user and resumes by itself when the check is gone.';
  const lead = state === 'self-clearing' ? `${what} did not clear by itself.` : `${what} needs a human.`;
  return `${lead} Never click, type into, drag or screenshot-analyze it yourself, and do not reload. ${next}`;
}

/**
 * Classify the current state of a page. PURE. Returns null when nothing blocks the
 * page (including reCAPTCHA v3's corner badge, a solved widget — its response field is
 * non-empty — and Cloudflare's passive jsd script on normal pages).
 *
 * Headers are supporting evidence: they belong to the last DOCUMENT response and go
 * stale when a page swaps its content in place, so a header alone counts only while
 * the in-page probe could not run.
 */
export function classifyChallenge(input: ChallengeInput): ChallengeInfo | null {
  const mainUrl = String(input?.mainUrl ?? '');
  const host = hostOf(mainUrl);
  const title = String(input?.title ?? '');
  const h = input?.headers ?? {};
  const m = input?.domMarkers ?? null;
  const frames = Array.isArray(input?.frames) ? input.frames : [];
  const status = typeof input?.status === 'number' ? input.status : undefined;

  const mk = (vendor: ChallengeVendor, state: ChallengeState, frame?: ChallengeFrameInfo, box?: ChallengeBox | null): ChallengeInfo => {
    const info: ChallengeInfo = { vendor, state, host, hint: challengeHint(vendor, state, host) };
    if (frame) {
      info.frameUrl = stripQuery(frame.url);
      const b = boxOf(frame);
      if (b) info.frameBox = b;
    } else if (box && box.w > 0 && box.h > 0) {
      info.frameBox = { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) };
    }
    return info;
  };

  const server = (h['server'] ?? '').toLowerCase();
  const titleLc = title.toLowerCase();

  // 1. Hard blocks — a human cannot solve these here.
  if (m?.cfBlocked) return mk('cloudflare', 'blocked');
  if (m?.accessDeniedRef && (/access denied/.test(titleLc) || server.includes('akamaighost'))) return mk('akamai', 'blocked');
  if (m?.sucuriBlocked) return mk('sucuri', 'blocked');
  if (m?.impervaBlocked) return mk('imperva', 'blocked');

  // 2. Challenge frames that are actually on screen.
  const parsed = frames
    .map(f => ({ f, v: challengeFrameVendor(f.url) }))
    .filter((x): x is { f: ChallengeFrameInfo; v: { vendor: ChallengeVendor; kind: string } } => x.v !== null);
  const shown = parsed.filter(x => frameShown(x.f));
  const pick = (pred: (x: (typeof shown)[number]) => boolean) => shown.find(pred);

  const ddBlock = parsed.find(x => x.v.vendor === 'datadome' && x.v.kind === 'block');
  if (ddBlock) return mk('datadome', 'blocked', ddBlock.f);

  const bframe = pick(x => x.v.vendor === 'recaptcha' && x.v.kind === 'bframe');
  if (bframe) return mk('recaptcha', 'needs-human', bframe.f);
  const anchor = pick(x => x.v.vendor === 'recaptcha' && (x.v.kind === 'anchor' || x.v.kind === 'fallback'));
  if (anchor && !(m && m.recaptchaResponseLen > 0)) return mk('recaptcha', 'needs-human', anchor.f);

  const hc = pick(x => x.v.vendor === 'hcaptcha' && x.v.kind === 'challenge') ?? pick(x => x.v.vendor === 'hcaptcha');
  if (hc && !(m && m.hcaptchaResponseLen > 0)) return mk('hcaptcha', 'needs-human', hc.f);

  const dd = pick(x => x.v.vendor === 'datadome');
  if (dd) return mk('datadome', dd.v.kind === 'interstitial' ? 'self-clearing' : 'needs-human', dd.f);

  const ark = pick(x => x.v.vendor === 'arkose');
  if (ark) return mk('arkose', 'needs-human', ark.f);
  const ya = pick(x => x.v.vendor === 'yandex');
  if (ya) return mk('yandex', 'needs-human', ya.f);
  const pxf = pick(x => x.v.vendor === 'perimeterx');
  if (pxf) return mk('perimeterx', 'needs-human', pxf.f);
  const awsf = pick(x => x.v.vendor === 'aws-waf');
  if (awsf) return mk('aws-waf', 'needs-human', awsf.f);
  const gtf = pick(x => x.v.vendor === 'geetest');
  if (gtf) return mk('geetest', 'needs-human', gtf.f);
  const impf = pick(x => x.v.vendor === 'imperva');
  if (impf) return mk('imperva', 'needs-human', impf.f);
  const ak = pick(x => x.v.vendor === 'akamai');
  if (ak) return mk('akamai', 'self-clearing', ak.f);

  // Turnstile usually passes by itself (non-interactive / managed); if it escalates to a
  // checkbox, the auto-wait times out and it is reported as needing a human.
  const ts = pick(x => x.v.vendor === 'turnstile');
  const cfPage = !!m && (m.cfInterstitial || /^just a moment/.test(titleLc) || (m.checkingText && m.bodyTextLen < 2000 && (h['cf-ray'] !== undefined || server.includes('cloudflare'))));
  if (ts && !(m && m.turnstileResponseLen > 0)) return mk(cfPage ? 'cloudflare' : 'turnstile', 'self-clearing', ts.f);

  // 3. In-page challenges (no vendor frame on screen).
  if (m) {
    if (m.perimeterx) return mk('perimeterx', 'needs-human', undefined, m.box);
    if (m.geetest) return mk('geetest', 'needs-human', undefined, m.box);
    if (m.awsCaptcha) return mk('aws-waf', 'needs-human', undefined, m.box);
    if (m.ddosGuardCaptcha) return mk('ddos-guard', 'needs-human', undefined, m.box);
    if (cfPage) return mk('cloudflare', 'self-clearing', undefined, m.box);
    if (m.akamaiInterstitial) return mk('akamai', 'self-clearing', undefined, m.box);
    if (m.imperva) return mk('imperva', 'needs-human', undefined, m.box);
    // DataDome's page is up but its frame is not on screen yet: give it a moment.
    if (m.datadome && (status === 403 || h['x-datadome'] !== undefined) && m.bodyTextLen < 500) return mk('datadome', 'self-clearing');
    if (m.ddosGuard) return mk('ddos-guard', 'self-clearing');
    if (m.sucuriChallenge) return mk('sucuri', 'self-clearing');
    const kasada = (h['x-kpsdk-ct'] !== undefined || h['x-kpsdk-c'] !== undefined) && status === 429 && m.bodyTextLen < 200;
    if (kasada) return mk('kasada', 'self-clearing');
    const amz = (h['x-amzn-waf-action'] ?? '').toLowerCase();
    if (amz === 'challenge' && m.bodyTextLen < 200) return mk('aws-waf', 'self-clearing');
    if (m.friendly && !m.genericCaptcha) return mk('friendly-captcha', 'self-clearing', undefined, m.box);
    if (m.altcha && !m.genericCaptcha) return mk('altcha', 'self-clearing', undefined, m.box);
    if (/^(?:www\.)?google\.[a-z.]+$/.test(host) && /^\/sorry\//.test(pathOf(mainUrl))) return mk('recaptcha', 'needs-human', undefined, m.box);
    if (m.genericCaptcha) return mk('captcha', 'needs-human', undefined, m.box);
    return null;
  }

  // 4. Probe unavailable (navigation in flight): headers and the title are all we have.
  if (/^just a moment/.test(titleLc) || (h['cf-mitigated'] ?? '').toLowerCase() === 'challenge') return mk('cloudflare', 'self-clearing');
  const amz = (h['x-amzn-waf-action'] ?? '').toLowerCase();
  if (amz === 'captcha') return mk('aws-waf', 'needs-human');
  if (amz === 'challenge') return mk('aws-waf', 'self-clearing');
  if ((h['x-kpsdk-ct'] !== undefined || h['x-kpsdk-c'] !== undefined) && status === 429) return mk('kasada', 'self-clearing');
  if (/ddos-guard/.test(titleLc)) return mk('ddos-guard', 'self-clearing');
  return null;
}

function pathOf(url: string): string {
  try { return new URL(url).pathname; } catch { return ''; }
}

// ── in-page sources ─────────────────────────────────────────────────────────

/**
 * In-page, on an <iframe> element: its box (viewport CSS px) and whether it is really
 * shown — not display/visibility/opacity-hidden and not parked far off the page (the
 * idle reCAPTCHA challenge frame sits at top:-10000px) — and whether it lives in the
 * reCAPTCHA v3 badge.
 */
export const FRAME_BOX_FN: (...args: unknown[]) => unknown = new Function('el', `
  var r = el.getBoundingClientRect();
  var visible = r.width >= 1 && r.height >= 1;
  var n = el;
  for (var depth = 0; visible && n && n.nodeType === 1 && depth < 40; depth++) {
    var cs = getComputedStyle(n);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse' || Number(cs.opacity) === 0) visible = false;
    n = n.parentElement;
  }
  var top = r.top + (window.scrollY || 0);
  var left = r.left + (window.scrollX || 0);
  if (top + r.height <= 0 || left + r.width <= 0) visible = false;
  var badge = false;
  try { badge = !!(el.closest && el.closest('.grecaptcha-badge')); } catch (e) { badge = false; }
  return { x: r.left, y: r.top, w: r.width, h: r.height, visible: visible, badge: badge };
`) as any;

/**
 * In-page, main frame: challenge markers as booleans / lengths (+ the title and one
 * box). Reads response-token fields' LENGTH only — never their value.
 */
export const CHALLENGE_PROBE_FN: (...args: unknown[]) => unknown = new Function(`
  var d = document;
  var w = window;
  function q(sel) { try { return d.querySelector(sel); } catch (e) { return null; } }
  function qa(sel) { try { return d.querySelectorAll(sel); } catch (e) { return []; } }
  function vis(el, minW, minH) {
    if (!el || el.nodeType !== 1) return false;
    var r = el.getBoundingClientRect();
    if (r.width < (minW || 2) || r.height < (minH || 2)) return false;
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    if (r.top + (w.scrollY || 0) + r.height <= 0 || r.left + (w.scrollX || 0) + r.width <= 0) return false;
    return true;
  }
  function firstVis(sel, minW, minH) {
    var l = qa(sel);
    for (var i = 0; i < l.length && i < 60; i++) if (vis(l[i], minW, minH)) return l[i];
    return null;
  }
  function lenOf(sel) {
    var l = qa(sel); var n = 0;
    for (var i = 0; i < l.length && i < 20; i++) { try { n = Math.max(n, String(l[i].value || '').length); } catch (e) {} }
    return n;
  }
  var box = null;
  function setBox(el) {
    if (box || !el) return;
    var r = el.getBoundingClientRect();
    box = { x: r.left, y: r.top, w: r.width, h: r.height };
  }
  var title = String(d.title || '');
  var text = '';
  try {
    var b = d.body;
    if (b) text = (d.getElementsByTagName('*').length < 4000 ? String(b.innerText || '') : String(b.textContent || '')).slice(0, 6000);
  } catch (e) { text = ''; }
  var both = title + '\\n' + text;
  var checkingText = /checking (if the site connection is secure|your browser)|verifying (you are|that you are) (a )?human|verify you are (a )?human|just a moment|one more step|please (stand by|wait)[^\\n]{0,40}(verif|check)|performing security verification/i.test(both);
  var blockedText = /sorry, you have been blocked|you have been blocked|you are unable to access|error 10(0[5-9]|1[0-9]|20)\\b/i.test(both);
  var cfMarker = !!q('#cf-error-details, .cf-error-details, #cf-wrapper, .cf-error-overview') || /cloudflare ray id|ray id:|performance (&|and) security by cloudflare/i.test(text);
  var cfInterstitial = !!q('#challenge-form, #challenge-running, #challenge-stage, #challenge-body-text, #cf-challenge-running, .cf-browser-verification, #cf-please-wait, #challenge-success-text');
  try { if (w._cf_chl_opt) cfInterstitial = true; } catch (e) {}
  var pxEl = firstVis('#px-captcha, #px-captcha-wrapper, #px-captcha-modal');
  var pressHold = /press\\s*(&|and)\\s*hold/i.test(text);
  var perimeterx = !!pxEl || (pressHold && !!q('[id^="px-"], script[src*="px-cdn.net"], script[src*="perimeterx"], script[src*="px-cloud.net"]'));
  if (pxEl) setBox(pxEl);
  var gtEl = firstVis('.geetest_holder, .geetest_panel, .geetest_widget, .geetest_box, .geetest_radar_tip, .geetest_slider_button, [class^="geetest_"]', 20, 10);
  if (gtEl) setBox(gtEl);
  var awsEl = q('#captcha-container');
  var awsLib = false;
  try { awsLib = !!(w.AwsWafIntegration || w.AwsWafCaptcha || w.gokuProps) || !!q('script[src*="awswaf.com"]'); } catch (e) {}
  var awsCaptcha = !!awsEl && awsLib && vis(awsEl);
  if (awsCaptcha) setBox(awsEl);
  var dd = !!q('script[src*="captcha-delivery.com"], iframe[src*="captcha-delivery.com"]');
  var ddgCap = firstVis('#ddg-captcha, .ddg-captcha, #ddg-l-captcha');
  if (ddgCap) setBox(ddgCap);
  var ddosGuard = /ddos-guard/i.test(title) || !!q('script[src*="ddos-guard"]') || String(location.pathname || '').indexOf('/.well-known/ddos-guard/') === 0;
  var sucuriJs = false;
  var scripts = qa('script');
  for (var si = 0; si < scripts.length && si < 30; si++) {
    try { if (String(scripts[si].textContent || '').indexOf('sucuri_cloudproxy_js') >= 0) { sucuriJs = true; break; } } catch (e) {}
  }
  var genImg = firstVis('img[src*="captcha" i], img[alt*="captcha" i], img[id*="captcha" i], img[class*="captcha" i], img[alt*="کد امنیتی"]', 40, 15);
  var genInput = firstVis('input[name*="captcha" i]:not([type="hidden"]), input[id*="captcha" i]:not([type="hidden"]), input[placeholder*="captcha" i], input[placeholder*="کد امنیتی"], input[placeholder*="کپچا"], input[aria-label*="captcha" i]', 20, 10);
  if (genImg) setBox(genImg); else if (genInput) setBox(genInput);
  var widget = firstVis('.g-recaptcha, .h-captcha, .cf-turnstile, .frc-captcha, altcha-widget, .smart-captcha', 20, 20);
  if (widget) setBox(widget);
  return {
    title: title.slice(0, 200),
    bodyTextLen: text.length,
    recaptcha: !!q('.g-recaptcha, textarea[name="g-recaptcha-response"]'),
    recaptchaResponseLen: lenOf('textarea[name="g-recaptcha-response"]'),
    recaptchaBadge: !!q('.grecaptcha-badge'),
    hcaptcha: !!q('.h-captcha, textarea[name="h-captcha-response"], [data-hcaptcha-widget-id]'),
    hcaptchaResponseLen: lenOf('textarea[name="h-captcha-response"]'),
    turnstile: !!q('.cf-turnstile, input[name="cf-turnstile-response"]'),
    turnstileResponseLen: lenOf('input[name="cf-turnstile-response"]'),
    cfInterstitial: cfInterstitial,
    cfBlocked: blockedText && cfMarker,
    checkingText: checkingText,
    akamaiInterstitial: !!q('#sec-if-cpt-container, iframe#sec-cpt-if, #sec-cpt-if'),
    accessDeniedRef: /access denied/i.test(both) && /reference\\s*#\\s*\\d/i.test(text),
    perimeterx: perimeterx,
    datadome: dd,
    awsCaptcha: awsCaptcha,
    arkose: !!q('#FunCaptcha, #arkose, #arkose-container, input[name="fc-token"]'),
    geetest: !!gtEl,
    friendly: !!q('.frc-captcha'),
    altcha: !!q('altcha-widget'),
    yandex: !!q('.smart-captcha'),
    imperva: /pardon our interruption/i.test(both),
    impervaBlocked: /request unsuccessful\\. incapsula incident id/i.test(both),
    sucuriChallenge: sucuriJs,
    sucuriBlocked: /sucuri website firewall/i.test(both) && /access denied/i.test(both),
    ddosGuard: ddosGuard,
    ddosGuardCaptcha: !!ddgCap,
    genericCaptcha: !!(genImg || genInput),
    box: box
  };
`) as any;

// ── page-level detection (read-only) ───────────────────────────────────────

/** `p`'s value, or `fallback` after `ms` / on rejection. Never rejects. */
function withTimeoutValue<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>(resolve => {
    const t = setTimeout(() => resolve(fallback), ms);
    (t as any).unref?.();
    p.then(v => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(fallback); });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => { const t = setTimeout(r, ms); (t as any).unref?.(); });
}

const PROBE_FAILED = Symbol('probe-failed');

async function runProbe(page: any, timeoutMs: number): Promise<(ChallengeMarkers & { title?: string }) | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let main: any;
    try { main = page.mainFrame(); } catch { return null; }
    const r: any = await withTimeoutValue<any>(
      Promise.resolve().then(() => main.evaluate(CHALLENGE_PROBE_FN)).catch((e: any) => ({ [PROBE_FAILED]: String(e?.message ?? e) })),
      timeoutMs,
      { [PROBE_FAILED]: 'timeout' },
    );
    if (r && typeof r === 'object' && !(PROBE_FAILED in r)) return r as ChallengeMarkers & { title?: string };
    const why = r?.[PROBE_FAILED] ?? '';
    // A self-reloading interstitial destroys the context mid-probe: try once more.
    if (attempt === 0 && /context was destroyed|navigat|Execution context/i.test(why)) { await sleep(250); continue; }
    return null;
  }
  return null;
}

export interface DetectOptions {
  /** Main-document response status / headers recorded for the page (session.ts keeps them per tab). */
  status?: number;
  headers?: Record<string, string>;
  /** Per round-trip cap. Default 1500 ms. */
  timeoutMs?: number;
  /** At most this many candidate frames are measured. Default 8. */
  maxFrames?: number;
}

/**
 * Detect a challenge on a Playwright page. READ-ONLY: frame URLs (sync state), one
 * box measurement per candidate challenge frame, one in-page probe. Never clicks,
 * focuses or types. 'unknown' = the page could not be inspected right now (keep the
 * previous verdict).
 */
export async function detectChallenge(page: any, opts: DetectOptions = {}): Promise<ChallengeInfo | null | 'unknown'> {
  const timeoutMs = opts.timeoutMs ?? 1500;
  let mainUrl = '';
  try { mainUrl = String(page.url()); } catch { return 'unknown'; }
  try { if (page.isClosed?.()) return null; } catch { /* keep going */ }
  if (!/^(https?|file):/i.test(mainUrl)) return null; // about:blank, data:, chrome-error://…

  let main: any = null;
  try { main = page.mainFrame(); } catch { main = null; }
  let children: any[] = [];
  try { children = page.frames().filter((f: any) => f !== main); } catch { children = []; }
  const candidates = children.filter((f: any) => {
    try {
      const parent = f.parentFrame?.();
      return (!parent || parent === main) && CHALLENGE_FRAME_URL_RE.test(String(f.url()));
    } catch { return false; }
  }).slice(0, opts.maxFrames ?? 8);

  const [markers, frames] = await Promise.all([
    runProbe(page, timeoutMs),
    Promise.all(candidates.map(async (f: any): Promise<ChallengeFrameInfo> => {
      let url = '';
      try { url = String(f.url()); } catch { url = ''; }
      const handle: any = await withTimeoutValue(Promise.resolve().then(() => f.frameElement()), timeoutMs, null);
      const box: any = handle ? await withTimeoutValue(Promise.resolve().then(() => handle.evaluate(FRAME_BOX_FN)), timeoutMs, null) : null;
      if (handle) void Promise.resolve(handle.dispose?.()).catch(() => {});
      return box && typeof box === 'object'
        ? { url, visible: box.visible === true, w: Number(box.w) || 0, h: Number(box.h) || 0, x: Number(box.x) || 0, y: Number(box.y) || 0, badge: box.badge === true }
        : { url, visible: false, w: 0, h: 0 };
    })),
  ]);

  let title = typeof markers?.title === 'string' ? markers.title : '';
  if (!markers) {
    title = await withTimeoutValue(Promise.resolve().then(() => page.title()).then((t: unknown) => String(t ?? '')), timeoutMs, '');
  }
  const result = classifyChallenge({ mainUrl, title, status: opts.status, headers: opts.headers, frames, domMarkers: markers });
  if (!markers && !result) return 'unknown';
  return result;
}

/** Same challenge (vendor + state + host)? PURE. */
export function sameChallenge(a: ChallengeInfo | null | undefined, b: ChallengeInfo | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.vendor === b.vendor && a.state === b.state && a.host === b.host;
}

export interface WaitForChallengeOptions {
  timeoutMs: number;
  /** Poll interval. Default 1000 ms. */
  intervalMs?: number;
  signal?: AbortSignal;
  /** Stop when this holds for the latest known verdict. Default: no challenge. */
  until?: (c: ChallengeInfo | null) => boolean;
  /** Consecutive verdicts that must satisfy `until`. Default 1. */
  confirmations?: number;
  /** Detector (default detectChallenge(page, {headers, status})). */
  detect?: () => Promise<ChallengeInfo | null | 'unknown'>;
  headers?: Record<string, string>;
  status?: number;
  /** Re-check early when this fires (e.g. a navigation). Returns unsubscribe. */
  wake?: (cb: () => void) => () => void;
  /** Called after every verdict. */
  onCheck?: (c: ChallengeInfo | null | 'unknown') => void;
}

export interface WaitForChallengeResult {
  challenge: ChallengeInfo | null;
  timedOut: boolean;
  waitedMs: number;
}

/**
 * Poll the page until `until` holds (default: the challenge is gone) on `confirmations`
 * consecutive checks, the timeout passes, or `signal` aborts (rejects `[ABORTED]`).
 * 'unknown' verdicts neither confirm nor reset.
 */
export async function waitForChallengeChange(page: any, opts: WaitForChallengeOptions): Promise<WaitForChallengeResult> {
  const started = Date.now();
  const deadline = started + Math.max(0, opts.timeoutMs);
  const interval = Math.max(50, opts.intervalMs ?? 1000);
  const until = opts.until ?? ((c: ChallengeInfo | null) => c === null);
  const need = Math.max(1, opts.confirmations ?? 1);
  const detect = opts.detect ?? (() => detectChallenge(page, { headers: opts.headers, status: opts.status }));
  let known: ChallengeInfo | null = null;
  let streak = 0;
  for (;;) {
    if (opts.signal?.aborted) throw new Error('[ABORTED] The run was cancelled.');
    const v = await detect();
    try { opts.onCheck?.(v); } catch { /* observer only */ }
    if (v !== 'unknown') {
      known = v;
      streak = until(v) ? streak + 1 : 0;
      if (streak >= need) return { challenge: v, timedOut: false, waitedMs: Date.now() - started };
    }
    const left = deadline - Date.now();
    if (left <= 0) return { challenge: known, timedOut: true, waitedMs: Date.now() - started };
    await pause(Math.min(interval, left), opts.signal, opts.wake);
  }
}

/** Sleep `ms`, waking early on `wake`; rejects `[ABORTED]` on `signal`. */
export function pause(ms: number, signal?: AbortSignal, wake?: (cb: () => void) => () => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let unsub: (() => void) | null = null;
    const done = (err?: Error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      try { unsub?.(); } catch { /* ignore */ }
      if (err) reject(err); else resolve();
    };
    const onAbort = () => done(new Error('[ABORTED] The run was cancelled.'));
    const timer = setTimeout(() => done(), Math.max(0, ms));
    (timer as any).unref?.();
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    if (wake) {
      try { unsub = wake(() => done()); } catch { unsub = null; }
    }
  });
}
