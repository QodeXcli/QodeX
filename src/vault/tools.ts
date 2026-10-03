/**
 * Vault tools — let the agent log in without ever seeing a password.
 *
 *   vault_list {site?}                       names + sites + which fields exist
 *   browser_fill_secret {secret, field,      fills username / password / current
 *     ref? | selector?}                      TOTP code straight into a page field
 *   browser_login {secret, url?, submit?}    whole sign-in in one step (login.ts)
 *   vault_generate_and_fill {ref?, ...}      new random password → saved for this
 *                                            site → filled into password + confirm
 *
 * These are the ONLY consumers of secret values, and they never put them in a tool
 * result, an error, a progress event or the action record (the recorder sees "***").
 * Before filling (src/vault/fill.ts) they check, on the live page:
 *   - the active tab's origin is one of the entry's origins (exact host or
 *     subdomain, https unless localhost) — anti-phishing;
 *   - the target element's own document is on an allowed ORIGIN too (a
 *     cross-origin iframe on a legit page can't receive the secret — nor an
 *     about:blank / srcdoc child it creates, which inherits its origin, nor a
 *     sandboxed frame with an opaque origin);
 *   - the element is the right kind of field: a password goes only into
 *     <input type=password>, a username / code only into a text-like <input>
 *     (never a textarea or rich editor that would publish it).
 * Sentinel additionally classifies every call as `credential` (high risk).
 */

import { randomInt } from 'crypto';
import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../tools/base.js';
import { getBrowserManager, peekBrowserManager, type BrowserManager } from '../tools/browser/types.js';
import { formatOrigin, getVault, matchOrigin, normalizeOrigin, validateEntryName, type Vault, type VaultEntry } from './vault.js';
import {
  ASK_FOR_LOGIN, commitFill, currentTotp, hostOf, inspectField, isPrepared, prepareField, recordFill, scrub, visibleAll,
  type FillTarget, type PreparedField,
} from './fill.js';
import { BrowserLoginTool } from './login.js';
import {
  getSecretRequestBroker, vaultFindByOrigin, deriveEntryName, displayHost, originUrl, scrubSecretError,
} from './requests.js';

const FillSecretArgs = z.object({
  secret: z.string().min(1).describe('Vault entry name (from vault_list) — never the value.'),
  field: z.enum(['username', 'password', 'totp']).describe('username, password, or totp (the current one-time code).'),
  ref: z.string().describe('Field ref from browser_snapshot (e.g. "e12"). Preferred.').optional(),
  selector: z.string().describe('Playwright selector if there is no ref. Omit both to auto-detect.').optional(),
});
type FillSecretArgsT = z.infer<typeof FillSecretArgs>;

/** Get the browser, refuse when it is closed, wait out a human takeover. */
async function readyBrowser(tool: string, ctx: ToolContext): Promise<BrowserManager | ToolResult> {
  let mgr: BrowserManager;
  try {
    mgr = await getBrowserManager();
  } catch (e: any) {
    return { content: `[BROWSER_ERROR] ${e?.message ?? e}`, isError: true };
  }
  if (!mgr.isRunning()) {
    return { content: `[BROWSER_ERROR] The browser is not open. Open the page first with browser_navigate, then call ${tool}.`, isError: true };
  }
  if (mgr.isTakeover()) ctx.emit?.({ type: 'progress', message: 'Waiting for the human to hand the browser back…' });
  await mgr.waitForTakeoverEnd(ctx.signal);
  if (ctx.signal?.aborted) return { content: `[CANCELLED] ${tool} was cancelled.`, isError: true };
  return mgr;
}

function isManager(x: BrowserManager | ToolResult): x is BrowserManager {
  return typeof (x as BrowserManager).activeUrl === 'function';
}

export class BrowserFillSecretTool extends Tool<FillSecretArgsT> {
  name = 'browser_fill_secret';
  description = 'Fill ONE login field from the encrypted vault — username, password or the current 2FA (TOTP) code — without the value ever entering the conversation. Works only on the entry\'s own sites and only into the right kind of field. For a whole sign-in prefer browser_login; entry names come from vault_list.';
  argsSchema = FillSecretArgs;
  isReadOnly = false;
  isDestructive = false;

  async execute(args: FillSecretArgsT, ctx: ToolContext): Promise<ToolResult> {
    const vault = getVault();
    let entry: VaultEntry | null;
    try {
      entry = await vault.get(args.secret);
    } catch (e: any) {
      return { content: `[VAULT_ERROR] ${e?.message ?? e}`, isError: true };
    }
    if (!entry) {
      let names: string[] = [];
      try { names = await vault.names(); } catch { /* ignore */ }
      return {
        content: `[VAULT_NOT_FOUND] No vault entry named "${args.secret}".${names.length ? ` Available: ${names.join(', ')}.` : ' The vault is empty.'} ${ASK_FOR_LOGIN}`,
        isError: true,
      };
    }

    const stored = { username: entry.username, password: entry.secret, totp: entry.totp }[args.field];
    if (!stored) {
      return { content: `[VAULT_FIELD_MISSING] Vault entry "${entry.name}" has no ${args.field}. Ask the user to add it (qodex vault edit ${entry.name} --username … / qodex vault rotate ${entry.name} --totp).`, isError: true };
    }

    const ready = await readyBrowser(this.name, ctx);
    if (!isManager(ready)) return ready;
    const mgr = ready;

    const pageUrl = mgr.activeUrl();
    const pageMatch = matchOrigin(pageUrl, entry.origins);
    if (!pageMatch.ok) {
      return {
        content: `[VAULT_ORIGIN_MISMATCH] Refusing to fill "${entry.name}": ${pageMatch.reason}. This protects against phishing — only fill a credential on its own site. If this really is the right site, ask the user to add it (qodex vault edit ${entry.name} --add-origin <site>).`,
        isError: true,
      };
    }
    const secrets = [entry.secret, entry.totp ?? '', entry.previousSecret ?? ''];
    const fillOpts = { origins: entry.origins, entryName: entry.name, pageUrl, secrets };
    const prepared = await prepareField(mgr, args.field, { ref: args.ref, selector: args.selector }, fillOpts);
    if (!isPrepared(prepared)) return prepared;

    // The TOTP code is computed right before typing; the others are filled as stored.
    let value = stored;
    if (args.field === 'totp') {
      try {
        value = await currentTotp(entry, ctx.signal);
      } catch (e: any) {
        prepared.release();
        return { content: `[VAULT_ERROR] The stored TOTP seed for "${entry.name}" is invalid: ${scrub(e?.message ?? String(e), entry.totp)}`, isError: true };
      }
      if (ctx.signal?.aborted) { prepared.release(); return { content: '[CANCELLED] browser_fill_secret was cancelled.', isError: true }; }
    }
    const err = await commitFill(mgr, prepared, value, { ...fillOpts, secrets: [...secrets, value] });
    if (err) return err;
    recordFill(mgr, prepared, { ref: args.ref, selector: args.selector, secret: entry.name, field: args.field }, pageUrl);
    await vault.touch(entry.name).catch(() => {});

    const label = args.field === 'totp' ? 'current one-time code' : args.field;
    const target = args.ref || args.selector ? prepared.target : `the ${args.field} field`;
    return {
      content: `✓ Filled the ${label} from vault entry "${entry.name}" into ${target} on ${hostOf(pageUrl)} (value hidden — it never enters this conversation).`,
      metadata: { vault: { entry: entry.name, field: args.field, origin: pageMatch.origin } },
    };
  }
}

// ── vault_generate_and_fill ─────────────────────────────────────────────────

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
/** Symbols nearly every password policy accepts (no quotes, spaces, backslash, < >). */
const SYMBOLS = '!@#$%&*-_+=?';

/**
 * A random password (crypto RNG) with at least one lower-case letter, upper-case letter,
 * digit and symbol, starting with a letter, no character three times in a row — the
 * rules common sign-up forms check. `length` is clamped to 8-64.
 */
export function generatePassword(length = 20): string {
  const n = Math.max(8, Math.min(64, Math.floor(length)));
  const all = LOWER + UPPER + DIGITS + SYMBOLS;
  const pick = (set: string) => set[randomInt(set.length)];
  for (;;) {
    const chars = [pick(LOWER), pick(UPPER), pick(DIGITS), pick(SYMBOLS)];
    while (chars.length < n) chars.push(pick(all));
    for (let i = chars.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    const firstLetter = chars.findIndex(c => /[A-Za-z]/.test(c));
    [chars[0], chars[firstLetter]] = [chars[firstLetter], chars[0]];
    const pw = chars.join('');
    if (!/(.)\1\1/.test(pw)) return pw;
  }
}

const GenerateArgs = z.object({
  ref: z.string().describe('New-password field ref from browser_snapshot. Omit ref and selector to auto-detect.').optional(),
  selector: z.string().describe('Selector of that field if there is no ref.').optional(),
  confirm_ref: z.string().describe('Ref of the "confirm password" field, if any.').optional(),
  name: z.string().describe('Existing vault entry to rotate; omit to create one named after the site.').optional(),
  username: z.string().describe('Username / email of the account, stored with it.').optional(),
  length: z.number().int().min(12).max(64).describe('Password length (default 20).').optional(),
});
type GenerateArgsT = z.infer<typeof GenerateArgs>;

/** A free entry name derived from the site's host ("example.com", "example.com-2"). */
async function nameForHost(vault: Vault, host: string): Promise<string> {
  const base = host.replace(/[^\p{L}\p{N}._@+-]+/gu, '-').replace(/^[^\p{L}\p{N}]+/u, '').slice(0, 64) || 'site';
  const taken = new Set((await vault.names()).map(n => n.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; i < 1000; i++) {
    const cand = `${base.slice(0, 60)}-${i}`;
    if (!taken.has(cand.toLowerCase())) return cand;
  }
  return `${base.slice(0, 50)}-${Date.now().toString(36)}`;
}

export class VaultGenerateAndFillTool extends Tool<GenerateArgsT> {
  name = 'vault_generate_and_fill';
  description = 'For sign-up or password-change forms: create a strong random password, save it in the vault for this site (a new entry, or rotate `name`) and type it into the new-password and confirm fields. The value never enters the conversation. Submit the form yourself afterwards.';
  argsSchema = GenerateArgs;
  isReadOnly = false;
  isDestructive = false;

  async execute(args: GenerateArgsT, ctx: ToolContext): Promise<ToolResult> {
    const ready = await readyBrowser(this.name, ctx);
    if (!isManager(ready)) return ready;
    const mgr = ready;
    const vault = getVault();

    const pageUrl = mgr.activeUrl();
    let siteOrigin: string | null = null;
    try {
      const n = normalizeOrigin(new URL(pageUrl).origin);
      if (n) siteOrigin = formatOrigin(n);
    } catch { siteOrigin = null; }
    const pageOk = siteOrigin ? matchOrigin(pageUrl, [siteOrigin]) : matchOrigin(pageUrl, []);
    if (!siteOrigin || !pageOk.ok) {
      return { content: `[VAULT_ORIGIN_MISMATCH] Refusing to create a password here: ${pageOk.ok ? 'the page has no web origin' : pageOk.reason}. A vault password is only bound to an https site (or http on localhost).`, isError: true };
    }

    let existing: VaultEntry | null = null;
    let entryName: string;
    try {
      if (args.name) {
        existing = await vault.get(args.name);
        if (existing) {
          const m = matchOrigin(pageUrl, existing.origins);
          if (!m.ok) return { content: `[VAULT_ORIGIN_MISMATCH] Refusing to rotate "${existing.name}" here: ${m.reason}.`, isError: true };
        }
        entryName = existing?.name ?? validateEntryName(args.name);
      } else {
        entryName = await nameForHost(vault, normalizeOrigin(siteOrigin)!.host);
      }
    } catch (e: any) {
      return { content: `[VAULT_ERROR] ${String(e?.message ?? e).split('\n')[0].slice(0, 300)}`, isError: true };
    }
    const origins = existing ? existing.origins : [siteOrigin];
    const secrets = existing ? [existing.secret, existing.previousSecret ?? ''] : [];
    const fillOpts = { origins, entryName, pageUrl, secrets };

    const targets = await this.targets(mgr, args, pageUrl);
    if ('content' in targets) return targets;
    const pw = await prepareField(mgr, 'new-password', targets.pw, fillOpts);
    if (!isPrepared(pw)) return pw;
    let confirm: PreparedField | null = null;
    if (targets.confirm) {
      const c = await prepareField(mgr, 'new-password', targets.confirm, fillOpts);
      if (!isPrepared(c)) { pw.release(); return c; }
      confirm = c;
    }
    const releaseAll = () => { pw.release(); confirm?.release(); };

    // Respect the field's own limits (a 20-char password typed into maxlength=16 is cut).
    let length = args.length ?? 20;
    const max = pw.info.maxLength ?? -1;
    const min = pw.info.minLength ?? 0;
    if (max > 0 && max < length) length = max;
    if (min > length) length = Math.min(64, min);
    if (length < 8) {
      releaseAll();
      return { content: `[VAULT_FIELD_MISMATCH] The password field accepts at most ${max} characters — too short for a safe generated password. Ask the user how to proceed.`, isError: true };
    }
    const password = generatePassword(length);
    const allSecrets = [...secrets, password];

    // Save BEFORE typing: a password that reaches the site is always in the vault.
    let mode: 'new' | 'rotated';
    try {
      if (existing) {
        await vault.update(existing.name, { secret: password, ...(args.username?.trim() ? { username: args.username } : {}) });
        mode = 'rotated';
      } else {
        await vault.add({ name: entryName, origins, username: args.username, secret: password });
        mode = 'new';
      }
    } catch (e: any) {
      releaseAll();
      return { content: `[VAULT_ERROR] ${scrub(e?.message ?? String(e), ...allSecrets)} — nothing was filled.`, isError: true };
    }

    let err = await commitFill(mgr, pw, password, { ...fillOpts, secrets: allSecrets });
    if (!err && confirm) err = await commitFill(mgr, confirm, password, { ...fillOpts, secrets: allSecrets });
    else confirm?.release();
    if (err) {
      let undo: string;
      try {
        if (mode === 'new') await vault.remove(entryName);
        else await vault.update(entryName, { restorePrevious: true });
        undo = mode === 'new' ? ' The new vault entry was removed again.' : ' The vault entry is back on its previous password.';
      } catch (e: any) {
        undo = ` Undoing the vault change failed (${scrub(e?.message ?? String(e), ...allSecrets)}) — tell the user to check "${entryName}" (qodex vault list).`;
      }
      return { content: err.content + undo, isError: true };
    }
    recordFill(mgr, pw, { ref: args.ref, selector: args.selector, secret: entryName, field: 'password' }, pageUrl);
    if (confirm) recordFill(mgr, confirm, { ref: args.confirm_ref, secret: entryName, field: 'password' }, pageUrl);

    const saved = mode === 'new'
      ? `saved it as the new vault entry "${entryName}" (site: ${origins.join(', ')})`
      : `rotated vault entry "${entryName}" (the old password is kept — the user can undo with: qodex vault rotate ${entryName} --undo)`;
    return {
      content: `✓ Generated a ${length}-character password, ${saved}, and filled it into ${pw.target}${confirm ? ` and ${confirm.target}` : ''} on ${hostOf(pageUrl)} (value hidden — it never enters this conversation). Submit the form now; if the site rejects the password, tell the user.`,
      metadata: { vault: { entry: entryName, field: 'password', origin: origins[0], generated: true, mode } },
    };
  }

  /** The new-password field (+ confirm): explicit refs, or auto-detected. */
  private async targets(mgr: BrowserManager, args: GenerateArgsT, pageUrl: string): Promise<{ pw: FillTarget; confirm?: FillTarget } | ToolResult> {
    if (args.ref || args.selector) {
      return { pw: { ref: args.ref, selector: args.selector }, confirm: args.confirm_ref ? { ref: args.confirm_ref } : undefined };
    }
    let found: any[];
    try {
      found = await visibleAll(mgr, 'input[type="password"]');
    } catch (e: any) {
      return { content: `[BROWSER_ERROR] ${String(e?.message ?? e).split('\n')[0].slice(0, 200)}`, isError: true };
    }
    if (!found.length) {
      return { content: `[BROWSER_ERROR] No visible password field on ${hostOf(pageUrl)}. Call browser_snapshot and pass the new-password field's ref.`, isError: true };
    }
    const ac: string[] = [];
    for (const loc of found) ac.push(String((await loc.evaluate(inspectField).catch(() => null))?.autocomplete ?? ''));
    const fresh = found.filter((_, i) => /\bnew-password\b/.test(ac[i]));
    if (!fresh.length && found.length === 1 && /\bcurrent-password\b/.test(ac[0])) {
      return { content: '[VAULT_FIELD_MISMATCH] The only password field here is a login field (autocomplete=current-password). vault_generate_and_fill is for sign-up and change-password forms; to log in use browser_login.', isError: true };
    }
    // A change-password form has current + new + confirm: the new pair is the last two.
    const pick = fresh.length ? fresh : found.length >= 3 ? found.slice(-2) : found;
    return {
      pw: { loc: pick[0], label: 'the new-password field' },
      confirm: args.confirm_ref ? { ref: args.confirm_ref } : pick[1] ? { loc: pick[1], label: 'the confirm-password field' } : undefined,
    };
  }
}

const VaultListArgs = z.object({
  site: z.string().describe('Only entries usable on this site or URL. Omit for all; entries for the active tab are marked.').optional(),
});

/** "github.com" / "https://github.com/login" → a URL to match origins against. */
function siteUrl(site: string): string {
  const s = String(site ?? '').trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}/`;
}

export class VaultListTool extends Tool<z.infer<typeof VaultListArgs>> {
  name = 'vault_list';
  description = 'List the credentials stored in the user\'s encrypted vault: entry names, the sites each one may be used on, and which fields exist (username / password / totp). Never shows values. Fill them with browser_fill_secret.';
  argsSchema = VaultListArgs;
  isReadOnly = true;
  isDestructive = false;

  async execute(args: z.infer<typeof VaultListArgs>, _ctx: ToolContext): Promise<ToolResult> {
    let entries;
    try {
      entries = await getVault().list();
    } catch (e: any) {
      return { content: `[VAULT_ERROR] ${e?.message ?? e}`, isError: true };
    }
    if (!entries.length) {
      return { content: `The vault is empty. ${ASK_FOR_LOGIN}` };
    }
    // Never launches the browser: only an already-open tab is matched.
    let activeUrl = '';
    try { activeUrl = peekBrowserManager()?.isRunning() ? peekBrowserManager()!.activeUrl() : ''; } catch { activeUrl = ''; }
    const all = entries.length;
    if (args.site?.trim()) {
      const url = siteUrl(args.site);
      entries = entries.filter(e => matchOrigin(url, e.origins).ok);
      if (!entries.length) {
        return { content: `No vault entry may be used on ${hostOf(url)} (${all} entr${all === 1 ? 'y' : 'ies'} for other sites). ${ASK_FOR_LOGIN}` };
      }
    }
    const lines = entries.map(e => {
      const fields = [e.hasUsername && 'username', e.hasSecret && 'password', e.hasTotp && 'totp'].filter(Boolean).join(', ');
      const here = activeUrl && matchOrigin(activeUrl, e.origins).ok ? ' — ✓ matches the active tab' : '';
      return `- ${e.name} — sites: ${e.origins.join(', ')} — fields: ${fields}${here}`;
    });
    return {
      content: `${entries.length} vault entr${entries.length === 1 ? 'y' : 'ies'}:\n${lines.join('\n')}\nLog in with browser_login {secret: "<name>"}, or fill one field with browser_fill_secret {secret, field, ref} while the active tab is on one of the entry's sites.`,
    };
  }
}

// Kept terse: every tool schema is re-sent on each request (tool-token budget).
const RequestLoginArgs = z.object({
  site: z.string().min(1),
  reason: z.string().min(1),
  name: z.string().optional(),
  username_hint: z.string().optional(),
  want_totp: z.boolean().optional(),
});
type RequestLoginArgsT = z.infer<typeof RequestLoginArgs>;

/**
 * vault_request_login — the human types a login into QodeX's own secure input (the
 * TUI's masked prompt or the control center's secret form, src/vault/requests.ts);
 * it goes straight into the vault. The agent only learns the entry name.
 */
export class VaultRequestLoginTool extends Tool<RequestLoginArgsT> {
  name = 'vault_request_login';
  description = 'User types a site login into QodeX\'s secure prompt; saved to the vault, never shown to you. Then browser_fill_secret.';
  argsSchema = RequestLoginArgs;
  isReadOnly = false;
  isDestructive = false;
  /** Waits for a human (the broker has its own 10-minute limit; ctx.signal stops it). */
  timeoutSeconds = 0;

  async execute(args: RequestLoginArgsT, ctx: ToolContext): Promise<ToolResult> {
    const o = normalizeOrigin(args.site);
    if (!o) {
      return { content: `[VAULT_INVALID] "${String(args.site).slice(0, 80)}" is not a usable site — use a host like github.com (https; http only for localhost).`, isError: true };
    }
    const origin = formatOrigin(o);
    const shown = displayHost(o.host);
    const vault = getVault();
    let name = args.name?.trim();
    try {
      if (!name) {
        const same = await vaultFindByOrigin(vault, originUrl(origin));
        const hint = args.username_hint?.trim().toLowerCase();
        name = (same.find(e => hint && e.username?.toLowerCase() === hint) ?? same[0])?.name
          ?? deriveEntryName(o.host, args.username_hint, await vault.names());
      }
    } catch (e: any) {
      return { content: `[VAULT_ERROR] ${scrubSecretError(e, [])}`, isError: true };
    }
    // A page that talks the agent into asking for ANOTHER site's login shows up here.
    let warning: string | undefined;
    try {
      const mgr = peekBrowserManager();
      const url = mgr?.isRunning() ? mgr.activeUrl() : '';
      if (/^https?:/i.test(url) && !matchOrigin(url, [origin]).ok) warning = `The agent's browser is on ${displayHost(hostOf(url))}, not ${shown}.`;
    } catch { /* no browser */ }

    ctx.emit?.({ type: 'progress', message: `Waiting for the user to type the login for ${shown} into the secure prompt…` });
    const r = await getSecretRequestBroker().request({
      entryName: name,
      origins: [origin],
      fields: args.want_totp ? ['password', 'totp'] : ['password'],
      reason: args.reason,
      usernameHint: args.username_hint,
      warning,
      signal: ctx.signal,
    });
    const add = `qodex vault add ${/\s/.test(name) ? `"${name}"` : name} --origin ${origin} [--username <u>] [--totp]`;
    switch (r.code) {
      case 'saved': {
        const s = r.summary!;
        return {
          content: `✓ The user ${s.updated ? 'updated' : 'saved'} the login for ${shown} as vault entry "${s.name}" (fields: ${s.fields.join(', ')}). The values never enter this conversation — fill them with browser_fill_secret {secret: "${s.name}", field, ref}.`,
          metadata: { vault: { entry: s.name, origins: s.origins, fields: s.fields, by: r.by } },
        };
      }
      case 'cancelled':
        return { content: `[SECRET_REQUEST_CANCELLED] The user declined to enter the login for ${shown}. Don't ask again unless they ask; continue without it or tell them what is blocked.`, isError: true };
      case 'timeout':
        return { content: `[SECRET_REQUEST_TIMEOUT] Nobody entered the login for ${shown} in time. Tell the user; they can add it later with: ${add}`, isError: true };
      case 'aborted':
        return { content: '[CANCELLED] vault_request_login was cancelled.', isError: true };
      case 'no-surface':
        return { content: `[NO_SECURE_INPUT] There is no terminal UI or control center to type a password into. Ask the user to run: ${add}  (never ask for the password in chat).`, isError: true };
      default:
        return { content: `[SECRET_REQUEST_${r.code.toUpperCase().replace(/-/g, '_')}] ${r.message ?? 'The request could not be made.'}`, isError: true };
    }
  }
}

/** Every vault tool class, for the registry. */
export const VAULT_TOOL_CLASSES = [BrowserFillSecretTool, VaultListTool, BrowserLoginTool, VaultGenerateAndFillTool, VaultRequestLoginTool] as const;
