/**
 * browser_login {secret, url?, submit?} — a whole sign-in from the vault in one step.
 *
 *   1. Where: `url` (must be on one of the entry's sites), else the open tab when it is
 *      on the site and shows a login form, else the entry's loginUrl, else its home page.
 *      A page that lands (redirects) outside the entry's sites is refused.
 *   2. Fills username → password, including identifier-first flows (username, Next,
 *      then the password field appears), then the TOTP code when the site asks for one
 *      and the entry has a seed. Every fill goes through fill.ts: origin of the tab and of
 *      the field's own frame, field kind, last look right before typing.
 *   3. Submits with the form's own button — only after checking its label with Sentinel's
 *      keyword rules (a "Sign in and pay" / "Delete" button is refused) — or Enter.
 *   4. Stops after ONE failed attempt (the form comes back / an error shows) and refuses
 *      to try that entry again for 15 minutes unless it was changed: no account lockouts.
 *   5. A CAPTCHA / bot check is never touched: it is reported for the human.
 *
 * Values never reach the result, an error, a progress event or an action record.
 */

import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../tools/base.js';
import { getBrowserManager, type BrowserManager } from '../tools/browser/types.js';
import { categoriesForLabel } from '../sentinel/policy.js';
import { getVault, matchOrigin, normalizeOrigin, type VaultEntry } from './vault.js';
import {
  ASK_FOR_LOGIN, actionTimeoutMs, autoDetect, commitFill, currentTotp, hostOf, isPrepared, prepareField, recordFill, scrub, sleep,
  type FieldKind,
} from './fill.js';

const LoginArgs = z.object({
  secret: z.string().min(1).describe('Vault entry name (from vault_list).'),
  url: z.string().describe('Login page on one of the entry\'s sites. Default: the open login form, else its saved login URL or home page.').optional(),
  submit: z.boolean().describe('false = fill only, do not submit. Default true.').optional(),
});
type LoginArgsT = z.infer<typeof LoginArgs>;

/** A failed login blocks the same entry for this long (unless it is changed meanwhile). */
const FAILURE_HOLD_MS = 15 * 60_000;
const failures = new Map<string, number>();

/** Test hook. */
export function resetLoginFailuresForTests(): void {
  failures.clear();
}

// ── in-page helpers (strings: tsconfig has no DOM lib) ──────────────────────

const VISIBLE_JS = `var vis = function (e) {
  if (!e || !e.isConnected) return false;
  var r = e.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  var s = e.ownerDocument.defaultView.getComputedStyle(e);
  return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
};`;

/** The control that submits a field's form (its own submit button), or a login-ish button. */
const FIND_SUBMIT = new Function('el', `${VISIBLE_JS}
  var doc = el.ownerDocument;
  var form = el.form || (el.closest ? el.closest('form') : null);
  var cands = [];
  if (form) {
    cands = Array.prototype.slice.call(form.querySelectorAll('button, input[type=submit], input[type=image]'));
    if (form.id) cands = cands.concat(Array.prototype.slice.call(doc.querySelectorAll('[form="' + String(form.id).replace(/["\\\\]/g, '') + '"]')));
    cands = cands.filter(function (b) {
      var t = (b.getAttribute('type') || '').toLowerCase();
      return b.tagName === 'INPUT' || t === '' || t === 'submit';
    });
  } else {
    var re = /^(sign ?in|log ?in|login|next|continue|submit|verify|ورود|بعدی|ادامه|تایید|تأیید)$/i;
    cands = Array.prototype.slice.call(doc.querySelectorAll('button, input[type=submit], [role=button]')).filter(function (b) {
      return re.test(String(b.innerText || b.value || b.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim());
    });
  }
  for (var i = 0; i < cands.length; i++) if (!cands[i].disabled && vis(cands[i])) return cands[i];
  return null;`);

const BUTTON_LABEL = new Function('b', `return String(b.innerText || b.value || b.getAttribute('aria-label') || b.getAttribute('title') || '').replace(/\\s+/g, ' ').trim().slice(0, 80);`);

/** Did the page say the login failed? */
const LOGIN_ERROR_JS = `(() => { ${VISIBLE_JS}
  var alerts = Array.prototype.slice.call(document.querySelectorAll('[role=alert], [aria-live=assertive]'));
  if (alerts.some(function (a) { return vis(a) && String(a.innerText || '').trim().length > 0; })) return true;
  var t = String((document.body && document.body.innerText) || '').slice(0, 20000).toLowerCase();
  return /(incorrect|invalid|wrong)\\s+(password|username|e-?mail|credentials|login|user ?name)|password\\s+(is\\s+)?(incorrect|wrong|invalid)|(couldn.t|could not|unable to)\\s+(sign|log)\\s+you\\s+in|(login|sign[- ]?in|authentication)\\s+failed|رمز\\s*(عبور\\s*)?(اشتباه|نادرست)|نام کاربری یا رمز/.test(t);
})()`;

/** A visible CAPTCHA / bot-check (used when the browser's own challenge detector is absent). */
const CHALLENGE_JS = `(() => { ${VISIBLE_JS}
  var frames = Array.prototype.slice.call(document.querySelectorAll('iframe'));
  for (var i = 0; i < frames.length; i++) {
    var s = String(frames[i].src || '');
    if (/recaptcha\\/(api2|enterprise)\\/(anchor|bframe)|hcaptcha\\.com|challenges\\.cloudflare\\.com|arkoselabs|funcaptcha|geetest|captcha-delivery|px-captcha/i.test(s) && vis(frames[i])) return 'captcha';
  }
  if (/^just a moment/i.test(document.title || '')) return 'interstitial';
  var w = document.querySelector('#px-captcha, .h-captcha, .cf-turnstile');
  return w && vis(w) ? 'captcha' : '';
})()`;

async function importOptional(spec: string): Promise<any | null> {
  try {
    // Computed specifier on purpose: the browser's challenge detector is optional here.
    return await import(/* @vite-ignore */ spec);
  } catch {
    return null;
  }
}

/** A challenge that needs a human, or ''. Self-clearing ones are waited out (≤20 s). */
async function challengeOn(page: any, signal?: AbortSignal): Promise<string> {
  const m = await importOptional('../tools/browser/challenge.js');
  if (typeof m?.detectChallenge === 'function') {
    for (let waited = 0; waited <= 20_000; waited += 1000) {
      let c: any = null;
      try { c = await m.detectChallenge(page); } catch { c = null; }
      if (!c) return '';
      if (c.state !== 'self-clearing') return String(c.vendor ?? 'challenge');
      if (signal?.aborted) return String(c.vendor ?? 'challenge');
      await sleep(1000, signal);
    }
    return 'challenge';
  }
  try { return String(await page.evaluate(CHALLENGE_JS) || ''); } catch { return ''; }
}

async function loginErrorShown(page: any): Promise<boolean> {
  try { return !!(await page.evaluate(LOGIN_ERROR_JS)); } catch { return false; }
}

/** Poll `fn` until it returns something truthy, the time is up or the call is cancelled. */
async function waitFor<T>(fn: () => Promise<T | null | undefined | false | ''>, ms: number, signal?: AbortSignal): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    let v: T | null | undefined | false | '' = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v as T;
    if (Date.now() >= end || signal?.aborted) return null;
    await sleep(250, signal);
  }
}

/** https://host/ (or http://host:port/ for a loopback origin) of the entry's first site. */
function homeUrl(entry: VaultEntry): string {
  for (const o of entry.origins) {
    const n = normalizeOrigin(o);
    if (!n) continue;
    return `${n.scheme === 'http' ? 'http' : 'https'}://${n.host}${n.port ? ':' + n.port : ''}/`;
  }
  return '';
}

/** A URL without its query / fragment (they can carry one-time tokens). */
function shownUrl(url: string): string {
  try { const u = new URL(url); return u.origin + u.pathname; } catch { return hostOf(url); }
}

function err(content: string): ToolResult {
  return { content, isError: true };
}

export class BrowserLoginTool extends Tool<LoginArgsT> {
  name = 'browser_login';
  description = 'Sign in to a site with a vault entry in one step: opens the login page, fills username → password (identifier-first flows too) and the 2FA code, submits, and reports where it landed. Values stay hidden. Stops after one failed attempt and never touches a CAPTCHA.';
  argsSchema = LoginArgs;
  isReadOnly = false;
  isDestructive = false;
  untrustedOutput = true;
  timeoutSeconds = 180;

  async execute(args: LoginArgsT, ctx: ToolContext): Promise<ToolResult> {
    const vault = getVault();
    let entry: VaultEntry | null;
    try {
      entry = await vault.get(args.secret);
    } catch (e: any) {
      return err(`[VAULT_ERROR] ${e?.message ?? e}`);
    }
    if (!entry) {
      let names: string[] = [];
      try { names = await vault.names(); } catch { /* ignore */ }
      return err(`[VAULT_NOT_FOUND] No vault entry named "${args.secret}".${names.length ? ` Available: ${names.join(', ')}.` : ' The vault is empty.'} ${ASK_FOR_LOGIN}`);
    }
    const failedAt = failures.get(entry.id);
    const changedAt = Date.parse(entry.rotatedAt ?? entry.updatedAt ?? '') || 0;
    if (failedAt && Date.now() - failedAt < FAILURE_HOLD_MS && changedAt < failedAt) {
      const mins = Math.max(1, Math.round((Date.now() - failedAt) / 60_000));
      return err(`[LOGIN_HALTED] The last browser_login with "${entry.name}" failed ${mins} min ago; not trying again (repeated failed logins can lock the account). Ask the user to check the saved password (qodex vault rotate ${entry.name}) or to sign in themselves in the browser.`);
    }

    let target = args.url?.trim() || '';
    if (target && !/^[a-z][a-z0-9+.-]*:/i.test(target)) target = 'https://' + target;
    if (target) {
      const m = matchOrigin(target, entry.origins);
      if (!m.ok) return err(`[VAULT_ORIGIN_MISMATCH] Refusing to log in to "${entry.name}" there: ${m.reason}. Nothing was opened or filled.`);
    }

    let mgr: BrowserManager;
    let page: any;
    try {
      mgr = await getBrowserManager();
      if (mgr.isTakeover()) ctx.emit?.({ type: 'progress', message: 'Waiting for the human to hand the browser back…' });
      await mgr.waitForTakeoverEnd(ctx.signal);
      if (ctx.signal?.aborted) return err('[CANCELLED] browser_login was cancelled.');
      page = await mgr.activePage();
    } catch (e: any) {
      return err(`[BROWSER_ERROR] ${scrub(e?.message ?? String(e), entry.secret)}`);
    }

    // Stay on an open login form of this site; otherwise open the login page.
    if (!target) {
      const here = mgr.isRunning() ? mgr.activeUrl() : '';
      const onForm = !!here && matchOrigin(here, entry.origins).ok
        && !!((await autoDetect(mgr, 'password').catch(() => null)) || (await autoDetect(mgr, 'username').catch(() => null)));
      if (!onForm) target = entry.loginUrl || homeUrl(entry);
    }
    if (target) {
      ctx.emit?.({ type: 'progress', message: `Opening ${hostOf(target)} to sign in…` });
      try {
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      } catch (e: any) {
        return err(`[BROWSER_ERROR] Could not open ${shownUrl(target)}: ${scrub(e?.message ?? String(e), entry.secret)}`);
      }
      try { mgr.recordAction({ tool: 'browser_navigate', args: { url: target }, url: mgr.activeUrl(), actor: 'agent' }); } catch { /* best effort */ }
    }
    if (ctx.signal?.aborted) return err('[CANCELLED] browser_login was cancelled.');
    const landed = mgr.activeUrl();
    const site = matchOrigin(landed, entry.origins);
    if (!site.ok) {
      return err(`[VAULT_ORIGIN_MISMATCH] The sign-in page is on ${hostOf(landed)}, which is not one of "${entry.name}"'s sites (${entry.origins.join(', ')}). Nothing was filled. If that is the site's real sign-in service, ask the user to add it: qodex vault edit ${entry.name} --add-origin ${hostOf(landed)}`);
    }
    const host = hostOf(landed);

    const first = await waitFor<string>(async () => {
      if (await autoDetect(mgr, 'password')) return 'password';
      if (await autoDetect(mgr, 'username')) return 'username';
      return (await challengeOn(page)) ? 'challenge' : null;
    }, 10_000, ctx.signal);
    if (ctx.signal?.aborted) return err('[CANCELLED] browser_login was cancelled.');
    if (first === 'challenge') return this.challenge(host, []);
    if (!first) {
      return err(`[LOGIN_FORM_NOT_FOUND] No login form on ${shownUrl(landed)}. Open the sign-in page (e.g. browser_click on "Sign in") and call browser_login again — it continues on the open page.`);
    }

    const steps: string[] = [];
    const pwFirst = await autoDetect(mgr, 'password');
    const userLoc = await autoDetect(mgr, 'username');
    if (userLoc && entry.username) {
      const r = await this.fillField(mgr, entry, 'username', userLoc, ctx);
      if (r) return r;
      steps.push('username');
    } else if (userLoc && !entry.username && !(typeof userLoc.inputValue === 'function' ? String(await userLoc.inputValue().catch(() => '')) : '')) {
      return err(`[VAULT_FIELD_MISSING] The form asks for a username but vault entry "${entry.name}" has none. Ask the user to add it (qodex vault edit ${entry.name} --username <u>).`);
    }

    if (!pwFirst) {
      // Identifier-first: submit the username step, then wait for the password field.
      if (!steps.length) return err(`[LOGIN_FORM_NOT_FOUND] ${host} shows no password field and there is no username to start with.`);
      const s = await this.submit(mgr, userLoc, entry, 'username');
      if (s) return s;
      const next = await waitFor<string>(async () => {
        if (await autoDetect(mgr, 'password')) return 'password';
        if (await challengeOn(page)) return 'challenge';
        return (await loginErrorShown(page)) ? 'error' : null;
      }, 15_000, ctx.signal);
      if (ctx.signal?.aborted) return err('[CANCELLED] browser_login was cancelled.');
      if (next === 'challenge') return this.challenge(hostOf(mgr.activeUrl()), steps);
      if (next === 'error') return this.failed(entry, mgr, 'it rejected the username step');
      if (!next) return err(`[LOGIN_INCOMPLETE] After the username step on ${host} no password field appeared (the site may want another sign-in method). Nothing more was typed; look with browser_snapshot or ask the user.`);
    }

    const pwLoc = await autoDetect(mgr, 'password');
    if (!pwLoc) return err(`[LOGIN_FORM_NOT_FOUND] The password field on ${host} disappeared. Call browser_snapshot to see the page.`);
    const r = await this.fillField(mgr, entry, 'password', pwLoc, ctx);
    if (r) return r;
    steps.push('password');

    if (args.submit === false) {
      return { content: `✓ Filled ${steps.join(' and ')} from vault entry "${entry.name}" on ${host} (values hidden). Not submitted — submit with browser_click when ready.`, metadata: { vault: { entry: entry.name, origin: site.origin, submitted: false } } };
    }

    const sub = await this.submit(mgr, pwLoc, entry, 'password');
    if (sub) return sub;
    let outcome = await this.settle(mgr, page, false, ctx.signal);
    if (outcome === 'otp') {
      if (!entry.totp) {
        return err(`[LOGIN_NEEDS_2FA] ${hostOf(mgr.activeUrl())} asks for a one-time code, and vault entry "${entry.name}" has no TOTP seed. Ask the user to enter the code in the browser (they can take it over), or to add the seed: qodex vault rotate ${entry.name} --totp-only`);
      }
      const otpLoc = await autoDetect(mgr, 'totp');
      if (!otpLoc) return err('[LOGIN_INCOMPLETE] The one-time-code field disappeared. Call browser_snapshot.');
      const t = await this.fillField(mgr, entry, 'totp', otpLoc, ctx);
      if (t) return t;
      steps.push('one-time code');
      const s2 = await this.submit(mgr, otpLoc, entry, 'one-time code');
      if (s2) return s2;
      outcome = await this.settle(mgr, page, true, ctx.signal);
    }
    if (ctx.signal?.aborted) return err('[CANCELLED] browser_login was cancelled after submitting.');
    if (outcome === 'challenge') return this.challenge(hostOf(mgr.activeUrl()), steps);
    if (outcome === 'failed' || outcome === 'otp') return this.failed(entry, mgr, 'it still shows the sign-in form');

    failures.delete(entry.id);
    await vault.touch(entry.name).catch(() => {});
    const now = mgr.activeUrl();
    let title = '';
    try { title = String(await page.title()).replace(/\s+/g, ' ').trim().slice(0, 120); } catch { title = ''; }
    return {
      content: `✓ Signed in to ${host} with vault entry "${entry.name}" (${steps.join(' → ')} filled — values hidden). Now on ${shownUrl(now)}${title ? ` — "${scrub(title, entry.secret, entry.username)}"` : ''}. Call browser_snapshot to continue.`,
      metadata: { vault: { entry: entry.name, origin: site.origin, submitted: true } },
    };
  }

  /** Fill one field of the login through the shared checks. Null on success. */
  private async fillField(mgr: BrowserManager, entry: VaultEntry, kind: FieldKind, loc: any, ctx: ToolContext): Promise<ToolResult | null> {
    const pageUrl = mgr.activeUrl();
    const m = matchOrigin(pageUrl, entry.origins);
    if (!m.ok) return err(`[VAULT_ORIGIN_MISMATCH] Refusing to fill "${entry.name}": ${m.reason}. Nothing more was typed.`);
    const secrets = [entry.secret, entry.totp ?? '', entry.previousSecret ?? ''];
    const opts = { origins: entry.origins, entryName: entry.name, pageUrl, secrets };
    const p = await prepareField(mgr, kind, { loc, label: `the ${kind} field` }, opts);
    if (!isPrepared(p)) return p;
    let value: string;
    try {
      value = kind === 'username' ? entry.username! : kind === 'totp' ? await currentTotp(entry, ctx.signal) : entry.secret;
    } catch (e: any) {
      p.release();
      return err(`[VAULT_ERROR] The stored TOTP seed for "${entry.name}" is invalid: ${scrub(e?.message ?? String(e), entry.totp)}`);
    }
    if (ctx.signal?.aborted) { p.release(); return err('[CANCELLED] browser_login was cancelled.'); }
    const e = await commitFill(mgr, p, value, { ...opts, secrets: [...secrets, value] });
    if (e) return e;
    recordFill(mgr, p, { secret: entry.name, field: kind === 'totp' ? 'totp' : kind }, pageUrl);
    return null;
  }

  /**
   * Submit the form of `field`: click its own submit button after Sentinel's keyword check
   * on the label (refused when it reads like a purchase / payment / send / delete /
   * account change), else press Enter. Null on success.
   */
  private async submit(mgr: BrowserManager, field: any, entry: VaultEntry, step: string): Promise<ToolResult | null> {
    const pageUrl = mgr.activeUrl();
    if (!matchOrigin(pageUrl, entry.origins).ok) {
      return err(`[VAULT_ORIGIN_MISMATCH] The page left "${entry.name}"'s sites before the ${step} step was submitted — nothing was submitted.`);
    }
    const timeout = actionTimeoutMs();
    let btn: any = null;
    try {
      const h = await field.evaluateHandle(FIND_SUBMIT);
      btn = h?.asElement?.() ?? null;
      if (!btn) await h?.dispose?.().catch?.(() => {});
    } catch { btn = null; }
    if (btn) {
      let label = '';
      try { label = String(await btn.evaluate(BUTTON_LABEL) ?? ''); } catch { label = ''; }
      const category = label ? categoriesForLabel(label, { role: 'button', pageUrl }) : null;
      if (category) {
        await btn.dispose?.().catch?.(() => {});
        return err(`[LOGIN_REFUSED] The form's button reads "${scrub(label, entry.secret, entry.username)}" (${category}) — browser_login only signs in. Do this step yourself (browser_click) so Sentinel can ask the user.`);
      }
      try {
        await btn.click({ timeout });
        try { mgr.recordAction({ tool: 'browser_click', args: { element: label || 'submit' }, url: pageUrl, actor: 'agent', element: { role: 'button', name: label || undefined, tag: 'button' } }); } catch { /* best effort */ }
        return null;
      } catch {
        /* fall back to Enter in the field */
      } finally {
        await btn.dispose?.().catch?.(() => {});
      }
    }
    try {
      await field.press('Enter', { timeout });
      try { mgr.recordAction({ tool: 'browser_press', args: { key: 'Enter' }, url: pageUrl, actor: 'agent' }); } catch { /* best effort */ }
      return null;
    } catch (e: any) {
      return err(`[BROWSER_ERROR] Could not submit the ${step} step: ${scrub(e?.message ?? String(e), entry.secret, entry.username)}`);
    }
  }

  /** After a submit: signed in ('done'), a 2FA step ('otp'), a CAPTCHA, or 'failed'. */
  private async settle(mgr: BrowserManager, page: any, otpStep: boolean, signal?: AbortSignal): Promise<'done' | 'otp' | 'challenge' | 'failed'> {
    const deadline = Date.now() + 12_000;
    await sleep(300, signal);
    while (!signal?.aborted) {
      if (await challengeOn(page, signal)) return 'challenge';
      const pw = await autoDetect(mgr, 'password').catch(() => null);
      const otp = otpStep ? await autoDetect(mgr, 'totp').catch(() => null) : null;
      if (!pw && !otp) {
        // The form went away: let the next page load, then look again (a 2FA page, a CAPTCHA).
        await page.waitForLoadState?.('domcontentloaded', { timeout: 10_000 }).catch(() => {});
        await sleep(500, signal);
        if (await challengeOn(page, signal)) return 'challenge';
        if (!otpStep && await autoDetect(mgr, 'totp').catch(() => null)) return 'otp';
        const back = await autoDetect(mgr, 'password').catch(() => null) || (otpStep && await autoDetect(mgr, 'totp').catch(() => null));
        if (!back) return 'done';
      }
      if (await loginErrorShown(page)) return 'failed';
      if (Date.now() >= deadline) return 'failed';
      await sleep(400, signal);
    }
    return 'failed';
  }

  private failed(entry: VaultEntry, mgr: BrowserManager, why: string): ToolResult {
    failures.set(entry.id, Date.now());
    return err(`[LOGIN_FAILED] ${hostOf(mgr.activeUrl())} did not accept the login for vault entry "${entry.name}" (${why}). Not retrying — repeated attempts can lock the account. Tell the user: they can check the saved password (qodex vault rotate ${entry.name}) or sign in themselves in the browser.`);
  }

  private challenge(host: string, steps: string[]): ToolResult {
    return err(`[CHALLENGE] ${host} shows a CAPTCHA / bot check${steps.length ? ` after ${steps.join(' → ')}` : ''}. browser_login never touches it. Hand it to the human (browser_request_human if you have it, or ask the user to take over the browser), then check the page with browser_snapshot.`);
  }
}
