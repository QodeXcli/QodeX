/**
 * Vault tools — let the agent log in without ever seeing a password.
 *
 *   vault_list {}                         names + sites + which fields exist
 *   browser_fill_secret {secret, field,   fills username / password / current
 *     ref? | selector?}                   TOTP code straight into a page field
 *
 * browser_fill_secret is the ONLY consumer of secret values, and it never puts
 * them in a tool result, an error, a progress event or the action record (the
 * recorder sees "***"). Before filling it checks, on the live page:
 *   - the active tab's origin is one of the entry's origins (exact host or
 *     subdomain, https unless localhost) — anti-phishing;
 *   - the target element's own document is on an allowed ORIGIN too (a
 *     cross-origin iframe on a legit page can't receive the secret — nor an
 *     about:blank / srcdoc child it creates, which inherits its origin, nor a
 *     sandboxed frame with an opaque origin);
 *   - the element is the right kind of field: a password goes only into
 *     <input type=password>, a username / code only into a text-like <input>
 *     (never a textarea or rich editor that would publish it).
 * Sentinel additionally classifies the call as `credential` (high risk).
 */

import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../tools/base.js';
import { getBrowserManager, peekBrowserManager, type BrowserManager } from '../tools/browser/types.js';
import { resolveBrowserConfig } from '../config/agent-config.js';
import { getActiveConfig } from '../config/loader.js';
import { getVault, matchOrigin, normalizeOrigin, formatOrigin, type VaultEntry } from './vault.js';
import { totp, totpRemainingSeconds } from './totp.js';
import {
  getSecretRequestBroker, vaultFindByOrigin, deriveEntryName, displayHost, originUrl, scrubSecretError,
} from './requests.js';

const FillSecretArgs = z.object({
  secret: z.string().min(1).describe('Name of the vault entry (from vault_list). Only the NAME — the value never enters the conversation.'),
  field: z.enum(['username', 'password', 'totp']).describe('Which stored value to fill: username, password, or totp (the current one-time code).'),
  ref: z.string().describe('Target field ref from browser_snapshot (e.g. "e12"). Preferred.').optional(),
  selector: z.string().describe('Playwright selector for the field, if there is no ref. Omit both to auto-detect the login field.').optional(),
});
type FillSecretArgsT = z.infer<typeof FillSecretArgs>;

/** Inputs a username or one-time code may go into. */
const TEXTLIKE = new Set(['', 'text', 'email', 'tel', 'number', 'username']);

/** Auto-detection selectors per field (first visible match wins). */
const AUTO_SELECTORS: Record<FillSecretArgsT['field'], string[]> = {
  password: ['input[type="password"]:not([autocomplete="new-password"])', 'input[type="password"]'],
  username: [
    'input[autocomplete="username"]', 'input[type="email"]', 'input[autocomplete="email"]',
    'input[name*="user" i]', 'input[name*="email" i]', 'input[name*="login" i]', 'input[id*="user" i]',
    'input[id*="email" i]', 'input[id*="login" i]',
  ],
  totp: [
    'input[autocomplete="one-time-code"]', 'input[name*="otp" i]', 'input[name*="totp" i]', 'input[id*="otp" i]',
    'input[name*="code" i]', 'input[id*="code" i]', 'input[inputmode="numeric"]',
  ],
};

interface FieldInfo {
  tag: string;
  type: string;
  contentEditable: boolean;
  disabled: boolean;
  readOnly: boolean;
  href: string;
  /** Serialized origin of the field's document ('null' when opaque, '' when unknown). */
  origin: string;
  name: string;
  autocomplete: string;
}

/** Runs in the page. Typed `any` because tsconfig has no DOM lib. */
const inspectField = (el: any): FieldInfo => ({
  tag: String(el?.tagName ?? '').toLowerCase(),
  type: String(el?.getAttribute?.('type') ?? '').toLowerCase(),
  contentEditable: !!el?.isContentEditable,
  disabled: !!el?.disabled,
  readOnly: !!el?.readOnly,
  href: String(el?.ownerDocument?.location?.href ?? ''),
  // window.origin: an about:blank / srcdoc frame INHERITS its creator's origin, which
  // its URL doesn't show ('about:blank'); a sandboxed frame is opaque ('null').
  origin: String(el?.ownerDocument?.defaultView?.origin ?? ''),
  name: String(el?.getAttribute?.('aria-label') || el?.getAttribute?.('name') || el?.getAttribute?.('placeholder') || el?.id || ''),
  autocomplete: String(el?.getAttribute?.('autocomplete') ?? '').toLowerCase(),
});

/**
 * The URL whose origin decides whether the field's document may receive the
 * secret. The document's ORIGIN wins over its URL: an about:blank child of an ad
 * iframe has URL "about:blank" but the ad's origin. Unknown origins of about:
 * documents are refused rather than guessed from the tab URL.
 */
function fieldDocumentUrl(info: FieldInfo, pageUrl: string): { url: string } | { refuse: string } {
  const origin = info.origin.trim();
  if (origin === 'null') return { refuse: 'the field is in a sandboxed frame with an opaque origin' };
  if (origin) {
    return /^https?:\/\/[^/]+$/i.test(origin) ? { url: origin + '/' } : { refuse: `the field's document has the origin "${origin.slice(0, 80)}"` };
  }
  if (!info.href) return { url: pageUrl };
  if (info.href.startsWith('about:')) return { refuse: `the field is in an ${info.href.slice(0, 20)} frame of unknown origin` };
  return { url: info.href };
}

function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return url || '(no page)'; }
}

function scrub(message: string, secret: string): string {
  let m = String(message ?? '');
  if (secret && secret.length >= 3) m = m.split(secret).join('***');
  return m.split('\n')[0].slice(0, 300);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

export class BrowserFillSecretTool extends Tool<FillSecretArgsT> {
  name = 'browser_fill_secret';
  description = 'Fill a login field from the encrypted credential vault — username, password or the current 2FA (TOTP) code — WITHOUT the value ever entering the conversation. Use this instead of asking the user for passwords. Works only when the active tab is one of the entry\'s sites (anti-phishing) and only into the right kind of field (password → password input). Call vault_list to see entry names. Typical login: browser_navigate to the login page → browser_snapshot → browser_fill_secret {secret, field:"username", ref} → {field:"password", ref} → click Sign in → if asked, {field:"totp"}.';
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
        content: `[VAULT_NOT_FOUND] No vault entry named "${args.secret}".${names.length ? ` Available: ${names.join(', ')}.` : ' The vault is empty.'} Ask the user to add it with: qodex vault add <name> --origin <site> [--username <u>] [--totp]`,
        isError: true,
      };
    }

    const stored = { username: entry.username, password: entry.secret, totp: entry.totp }[args.field];
    if (!stored) {
      return { content: `[VAULT_FIELD_MISSING] Vault entry "${entry.name}" has no ${args.field}. Ask the user to add it (qodex vault add ${entry.name} --force ...).`, isError: true };
    }
    // The TOTP code is computed right before typing (below); the others are filled as stored.
    let value: string | undefined = args.field === 'totp' ? undefined : stored;
    const clean = (m: string) => scrub(scrub(m, stored), value ?? '');

    let mgr: BrowserManager;
    try {
      mgr = await getBrowserManager();
    } catch (e: any) {
      return { content: `[BROWSER_ERROR] ${e?.message ?? e}`, isError: true };
    }
    if (!mgr.isRunning()) {
      return { content: '[BROWSER_ERROR] The browser is not open. Open the login page first with browser_navigate, then call browser_fill_secret.', isError: true };
    }
    if (mgr.isTakeover()) ctx.emit?.({ type: 'progress', message: 'Waiting for the human to hand the browser back…' });
    await mgr.waitForTakeoverEnd(ctx.signal);
    if (ctx.signal?.aborted) return { content: '[CANCELLED] browser_fill_secret was cancelled.', isError: true };

    const pageUrl = mgr.activeUrl();
    const pageMatch = matchOrigin(pageUrl, entry.origins);
    if (!pageMatch.ok) {
      return {
        content: `[VAULT_ORIGIN_MISMATCH] Refusing to fill "${entry.name}": ${pageMatch.reason}. This protects against phishing — only fill a credential on its own site. If this really is the right site, ask the user to add the origin (qodex vault add ${entry.name} --origin <site> --force).`,
        isError: true,
      };
    }

    const timeout = resolveBrowserConfig(getActiveConfig()).actionTimeoutMs;
    let loc: any;
    let target: string;
    try {
      if (args.ref || args.selector) {
        loc = await mgr.locator({ ref: args.ref, selector: args.selector });
        target = args.ref ? `ref ${args.ref}` : `"${args.selector}"`;
      } else {
        const found = await this.autoDetect(mgr, args.field);
        if (!found) {
          return { content: `[BROWSER_ERROR] Could not find a visible ${args.field} field on ${hostOf(pageUrl)}. Call browser_snapshot and pass the field's ref.`, isError: true };
        }
        loc = found.loc;
        target = `the ${args.field} field`;
      }
    } catch (e: any) {
      const msg = clean(e?.message ?? String(e));
      return { content: msg.startsWith('[') ? msg : `[BROWSER_ERROR] ${msg}`, isError: true };
    }

    // Pin the exact DOM element: a Locator re-resolves on every call, so a redirect
    // between the checks below and fill() could otherwise land the secret on another
    // page. An ElementHandle detaches instead (fill then fails safely).
    let el: any = loc;
    let info: FieldInfo;
    try {
      if (typeof loc.elementHandle === 'function') {
        el = await loc.elementHandle({ timeout });
        if (!el) return { content: `[BROWSER_ERROR] ${target} is not on the page any more. Call browser_snapshot again.`, isError: true };
      }
      info = await el.evaluate(inspectField);
    } catch (e: any) {
      return { content: `[BROWSER_ERROR] Could not inspect the target field: ${clean(e?.message ?? String(e))}`, isError: true };
    }
    const release = () => { if (el !== loc) void Promise.resolve(el.dispose?.()).catch(() => {}); };
    const frame = fieldDocumentUrl(info, pageUrl);
    const frameMatch = 'refuse' in frame ? { ok: false as const, reason: frame.refuse } : matchOrigin(frame.url, entry.origins);
    if (!frameMatch.ok) {
      release();
      return { content: `[VAULT_ORIGIN_MISMATCH] Refusing to fill "${entry.name}": the field is inside a frame from another site (${frameMatch.reason}).`, isError: true };
    }
    const fieldError = this.checkField(args.field, info);
    if (fieldError) {
      release();
      return { content: `[VAULT_FIELD_MISMATCH] ${fieldError} Pick the right field from browser_snapshot.`, isError: true };
    }

    if (args.field === 'totp') {
      const period = entry.totpPeriod ?? 30;
      // Don't type a code that expires before the form is submitted.
      if (totpRemainingSeconds(period) < 3) await sleep(Math.ceil(totpRemainingSeconds(period) * 1000) + 250, ctx.signal);
      if (ctx.signal?.aborted) { release(); return { content: '[CANCELLED] browser_fill_secret was cancelled.', isError: true }; }
      try {
        value = totp(entry.totp!, { period, digits: entry.totpDigits ?? 6, algorithm: entry.totpAlgorithm ?? 'sha1' });
      } catch (e: any) {
        release();
        return { content: `[VAULT_ERROR] The stored TOTP seed for "${entry.name}" is invalid: ${e?.message ?? e}`, isError: true };
      }
    }

    // Last look right before typing: the tab must still be on an allowed site.
    if (!matchOrigin(mgr.activeUrl(), entry.origins).ok) {
      release();
      return { content: `[VAULT_ORIGIN_MISMATCH] The page navigated away from ${hostOf(pageUrl)} before "${entry.name}" could be filled — nothing was typed.`, isError: true };
    }
    try {
      await el.fill(value!, { timeout });
    } catch (e: any) {
      return { content: `[BROWSER_ERROR] Could not fill ${target}: ${clean(e?.message ?? String(e))}`, isError: true };
    } finally {
      release();
    }

    try {
      mgr.recordAction({
        tool: 'browser_fill_secret',
        args: { ref: args.ref, selector: args.selector, secret: entry.name, field: args.field, value: '***' },
        url: pageUrl,
        actor: 'agent',
        element: { ref: args.ref, tag: info.tag, inputType: info.type, isPassword: info.type === 'password', name: info.name || undefined, autocomplete: info.autocomplete || undefined, selector: args.selector },
      });
    } catch { /* recording is best-effort */ }

    const label = args.field === 'totp' ? 'current one-time code' : args.field;
    return {
      content: `✓ Filled the ${label} from vault entry "${entry.name}" into ${target} on ${hostOf(pageUrl)} (value hidden — it never enters this conversation).`,
      metadata: { vault: { entry: entry.name, field: args.field, origin: pageMatch.origin } },
    };
  }

  private checkField(field: FillSecretArgsT['field'], info: FieldInfo): string | null {
    if (info.disabled || info.readOnly) return 'The target field is disabled or read-only.';
    if (info.tag !== 'input' || info.contentEditable) {
      return `The target is a <${info.tag || '?'}>${info.contentEditable ? ' (rich editor)' : ''}, not an input field — a secret is only filled into a login input.`;
    }
    if (field === 'password' && info.type !== 'password') {
      return `A password is only filled into a password input; the target is <input type="${info.type || 'text'}">.`;
    }
    if (field === 'username' && !TEXTLIKE.has(info.type)) {
      return `A username goes into a text/email input; the target is <input type="${info.type}">.`;
    }
    if (field === 'totp' && !TEXTLIKE.has(info.type) && info.type !== 'password') {
      return `A one-time code goes into a text/number input; the target is <input type="${info.type}">.`;
    }
    return null;
  }

  private async autoDetect(mgr: BrowserManager, field: FillSecretArgsT['field']): Promise<{ loc: any } | null> {
    const page = await mgr.activePage();
    for (const sel of AUTO_SELECTORS[field]) {
      const all = page.locator(sel);
      const n = Math.min(await all.count().catch(() => 0), 10);
      for (let i = 0; i < n; i++) {
        const loc = all.nth(i);
        if (await loc.isVisible().catch(() => false)) return { loc };
      }
    }
    return null;
  }
}

const VaultListArgs = z.object({});

export class VaultListTool extends Tool<z.infer<typeof VaultListArgs>> {
  name = 'vault_list';
  description = 'List the credentials stored in the user\'s encrypted vault: entry names, the sites each one may be used on, and which fields exist (username / password / totp). Never shows values. Fill them with browser_fill_secret.';
  argsSchema = VaultListArgs;
  isReadOnly = true;
  isDestructive = false;

  async execute(_args: z.infer<typeof VaultListArgs>, _ctx: ToolContext): Promise<ToolResult> {
    let entries;
    try {
      entries = await getVault().list();
    } catch (e: any) {
      return { content: `[VAULT_ERROR] ${e?.message ?? e}`, isError: true };
    }
    if (!entries.length) {
      return { content: 'The vault is empty. The user can add a login with: qodex vault add <name> --origin <site> [--username <u>] [--totp]   (the secret is typed hidden, never through the chat).' };
    }
    const lines = entries.map(e => {
      const fields = [e.hasUsername && 'username', e.hasSecret && 'password', e.hasTotp && 'totp'].filter(Boolean).join(', ');
      return `- ${e.name} — sites: ${e.origins.join(', ')} — fields: ${fields}`;
    });
    return {
      content: `${entries.length} vault entr${entries.length === 1 ? 'y' : 'ies'}:\n${lines.join('\n')}\nUse browser_fill_secret {secret: "<name>", field: "username"|"password"|"totp", ref} while the active tab is on one of the entry's sites.`,
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
export const VAULT_TOOL_CLASSES = [BrowserFillSecretTool, VaultListTool, VaultRequestLoginTool] as const;
