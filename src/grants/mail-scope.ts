/**
 * Scope of a standing 'mail-reply' grant — what Sentinel checks before it lets a
 * `mail_send` go out without asking a human.
 *
 * ALL of these must hold (anything else → the normal critical human prompt):
 *   1. the send is a reply: In-Reply-To names a message RECEIVED in the same
 *      account (trusted source: the mail core's resolver, which looks the original
 *      up in the mailbox, or the watcher's received-mail index — never the model's
 *      arguments alone);
 *   2. it goes to that message's original sender only: exactly one To address,
 *      equal to the original From (not its Reply-To), no Cc, no Bcc;
 *   3. it is not a forward and carries no attachments;
 *   4. the original was not flagged as a prompt-injection attempt (index flag,
 *      resolver flag, or a fresh scan of its subject + text here);
 *   5. the reply body carries nothing that looks like a secret (cards, keys, …);
 *   6. an active grant covers it: kind 'mail-reply', account (or '*'), sender
 *      filter, not expired — and its daily cap is not used up (counted by the
 *      guard at the moment it allows the send).
 *
 * The facts about a send come from a resolver the mail core registers
 * (`registerMailSendResolver`): mail_send usually names a stored draft, and only
 * the mail core can read it. Without a resolver, the full-fields form
 * (`to`, `cc`, `bcc`, `subject`, `body`, `in_reply_to`, `attachments`) is read
 * from the arguments and the original is looked up in the received-mail index.
 */

import { scanInjection } from '../sentinel/injection.js';
import { detectSecrets } from '../sentinel/policy.js';
import { bareAddress, isExpired, normalizeAccount, senderAllowed, type StandingGrant } from './store.js';
import { getReceivedIndex, normalizeMessageId, type ReceivedIndex } from './received.js';

/** The tool name Sentinel applies standing mail-reply grants to. */
export const MAIL_SEND_TOOL = 'mail_send';

export interface MailAttachmentFact {
  name: string;
  /** Where it comes from: a file on disk, the original message, or generated. */
  source?: 'disk' | 'original' | 'generated';
}

/** What a mail_send call would actually send (resolved from its draft / arguments). */
export interface MailSendFacts {
  /** Sending account name. */
  account: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject?: string;
  /** Body text (used for a preview in the approval prompt and a secret check — never logged in full). */
  body?: string;
  /** Message-ID of the message this replies to (In-Reply-To). */
  inReplyTo?: string;
  references?: string[];
  /** The send forwards a message. */
  forward?: boolean;
  attachments: MailAttachmentFact[];
  draftId?: string;
}

/** The message being replied to, as known from a TRUSTED source (the mailbox / the watcher). */
export interface MailSourceFacts {
  account: string;
  messageId: string;
  /** Original From header (bare address or `Name <addr>`). */
  from: string;
  subject?: string;
  /** Text of the original (optional — re-scanned for prompt injection). */
  text?: string;
  injectionFlagged?: boolean;
}

export interface MailSendResolution {
  send: MailSendFacts;
  /** The replied-to message, when the resolver could look it up (else the received index is used). */
  source?: MailSourceFacts | null;
}

export type MailSendResolver = (
  args: Record<string, unknown>,
  ctx: { cwd?: string; sessionId?: string },
) => Promise<MailSendResolution | null> | MailSendResolution | null;

let resolver: MailSendResolver | null = null;

/**
 * The mail core registers how to turn mail_send arguments (a draft id, or full
 * fields) into the facts above. Returns an unregister function.
 */
export function registerMailSendResolver(fn: MailSendResolver | null): () => void {
  resolver = fn;
  return () => { if (resolver === fn) resolver = null; };
}

export function hasMailSendResolver(): boolean {
  return resolver !== null;
}

// ── helpers (PURE) ────────────────────────────────────────────────────────────

function strList(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap(x => strList(x));
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.address === 'string') return [o.name ? `${o.name} <${o.address}>` : o.address];
    return [];
  }
  const s = typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
  // "a@x, B <b@y>" — split on commas/semicolons outside angle brackets / quotes.
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  let quoted = false;
  for (const ch of s) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === '<') depth++;
    if (!quoted && ch === '>') depth = Math.max(0, depth - 1);
    if (!quoted && depth === 0 && (ch === ',' || ch === ';')) { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
}

/** Read the full-fields form of mail_send arguments (no draft lookup). PURE. */
export function factsFromArgs(args: Record<string, unknown>): MailSendFacts | null {
  const a = args && typeof args === 'object' ? args : {};
  // A stored draft is what gets sent: only the mail core's resolver can read it.
  if (str(a.draft_id ?? a.draftId).trim()) return null;
  const to = strList(a.to);
  if (!to.length) return null;
  const atts = Array.isArray(a.attachments) ? a.attachments : a.attachments ? [a.attachments] : [];
  return {
    account: str(a.account).trim(),
    to,
    cc: strList(a.cc),
    bcc: strList(a.bcc),
    subject: str(a.subject),
    body: str(a.body ?? a.text),
    inReplyTo: normalizeMessageId(a.in_reply_to ?? a.inReplyTo) || undefined,
    references: strList(a.references).map(normalizeMessageId).filter(Boolean),
    forward: a.forward === true || !!str(a.forward_id ?? a.forwardId),
    attachments: atts.map(x => ({ name: typeof x === 'string' ? x : str((x as any)?.name ?? (x as any)?.path ?? 'attachment'), source: 'disk' as const })),
  };
}

const FORWARD_SUBJECT_RE = /^\s*(?:fwd?|fw|forward(?:ed)?|tr|wg|ارسال\s*مجدد|بازارسال|هدایت)\s*:/i;

export type ScopeVerdict =
  | { ok: true; grant: StandingGrant; recipient: string }
  | {
      ok: false;
      /** Why the grant can't cover this send (human-readable). */
      reasons: string[];
      /** The send is a plain same-thread reply to the original sender (clean source, no extras),
       *  just not covered by a grant — a human may grant "always allow replies like this". */
      replyShaped: boolean;
      /** An active grant already covers it but its daily cap is used up (or it expired). */
      blockedByCap?: boolean;
      recipient?: string;
      source?: MailSourceFacts | null;
    };

/**
 * Is this send inside a mail-reply grant? PURE (the daily cap is counted by the
 * caller, which receives the matching grant). `source` must come from a trusted
 * place (resolver / received index), never from the tool arguments.
 */
export function checkMailReplyScope(
  send: MailSendFacts,
  source: MailSourceFacts | null | undefined,
  grants: StandingGrant[],
  opts: { now?: number; usedToday?: (id: string) => number } = {},
): ScopeVerdict {
  const now = opts.now ?? Date.now();
  const reasons: string[] = [];
  let account = '';
  try { account = normalizeAccount(send.account); } catch { reasons.push('the sending account is not valid'); }
  if (account === '*') reasons.push('the sending account is unknown');

  const inReplyTo = normalizeMessageId(send.inReplyTo);
  if (!inReplyTo) reasons.push('it is not a reply (no In-Reply-To): a new thread always asks');

  let recipient = '';
  const to = [...new Set(send.to.map(bareAddress))];
  if (send.to.length !== 1 || to.length !== 1 || !to[0]) reasons.push(`it goes to ${send.to.length === 1 ? 'an invalid address' : `${send.to.length} recipients`} (a reply goes to the original sender only)`);
  else recipient = to[0];
  if (send.cc.length) reasons.push(`it adds Cc recipients (${send.cc.length})`);
  if (send.bcc.length) reasons.push(`it adds Bcc recipients (${send.bcc.length})`);
  if (send.attachments.length) reasons.push(`it carries ${send.attachments.length} attachment(s)`);
  if (send.forward || FORWARD_SUBJECT_RE.test(send.subject ?? '')) reasons.push('it forwards a message');
  const secrets = detectSecrets(`${send.subject ?? ''}\n${send.body ?? ''}`);
  if (secrets.length) reasons.push('the reply contains something that looks like a secret (card number, key, token)');

  let flagged = false;
  if (!source) {
    if (inReplyTo) reasons.push('the message it replies to was not received in this account (or QodeX has not seen it)');
  } else {
    if (normalizeMessageId(source.messageId) !== inReplyTo) reasons.push('In-Reply-To does not match the original message');
    if (account && source.account.toLowerCase() !== account.toLowerCase()) reasons.push(`the original was received in another account (${source.account})`);
    const original = bareAddress(source.from);
    if (!original) reasons.push('the original sender address is unreadable');
    else if (recipient && recipient !== original) reasons.push(`it goes to ${recipient}, not to the original sender ${original}`);
    flagged = source.injectionFlagged === true || scanInjection(`${source.subject ?? ''}\n${source.text ?? ''}`).length > 0;
    if (flagged) reasons.push('the original email was flagged as a possible prompt-injection attempt (replies to it always need you)');
  }
  const replyShaped = reasons.length === 0;

  if (replyShaped) {
    const covering = grants.filter(g => g.kind === 'mail-reply'
      && (g.account === '*' || g.account.toLowerCase() === account.toLowerCase())
      && senderAllowed(g, recipient));
    const active = covering.filter(g => !isExpired(g, now));
    const usable = active.filter(g => !opts.usedToday || opts.usedToday(g.id) < g.maxPerDay);
    // Prefer the narrowest grant (a sender filter, then a named account), then the most headroom.
    const headroom = (g: StandingGrant) => g.maxPerDay - (opts.usedToday?.(g.id) ?? 0);
    usable.sort((a, b) => (Number(b.from.length > 0) - Number(a.from.length > 0))
      || (Number(a.account === '*') - Number(b.account === '*'))
      || (headroom(b) - headroom(a)));
    if (usable.length) return { ok: true, grant: usable[0], recipient };
    if (active.length) {
      return { ok: false, reasons: [`today's cap of the standing reply grant ${active[0].id} is used up (${active[0].maxPerDay}/day)`], replyShaped, blockedByCap: true, recipient, source };
    }
    if (covering.length) {
      return { ok: false, reasons: [`the standing reply grant ${covering[0].id} expired`], replyShaped, blockedByCap: true, recipient, source };
    }
    return { ok: false, reasons: ['no standing reply grant covers this account and sender'], replyShaped, recipient, source };
  }
  return { ok: false, reasons, replyShaped, recipient: recipient || undefined, source };
}

/**
 * Resolve what a mail_send call would send and the trusted facts about the
 * message it replies to. Never throws; null when it can't be told (→ human prompt).
 */
export async function resolveMailSend(
  args: Record<string, unknown>,
  ctx: { cwd?: string; sessionId?: string },
  opts: { timeoutMs?: number; index?: ReceivedIndex } = {},
): Promise<MailSendResolution | null> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  let res: MailSendResolution | null = null;
  if (resolver) {
    try {
      res = await withTimeout(Promise.resolve().then(() => resolver!(args, ctx)), timeoutMs);
    } catch {
      res = null;
    }
  }
  if (!res || !res.send) {
    const send = factsFromArgs(args);
    if (!send) return null;
    res = { send, source: null };
  }
  const send = sanitizeSend(res.send);
  if (!send) return null;
  let source = res.source && typeof res.source === 'object' ? sanitizeSource(res.source) : null;
  // The received index: the fallback source, and its injection flag always counts.
  const idx = opts.index ?? getReceivedIndex();
  const inReplyTo = normalizeMessageId(send.inReplyTo);
  if (inReplyTo && send.account) {
    try {
      const seen = await withTimeout(idx.lookup(send.account, inReplyTo), timeoutMs);
      if (seen) {
        if (!source) source = { account: seen.account, messageId: seen.messageId, from: seen.from, subject: seen.subject, injectionFlagged: seen.flagged };
        else if (seen.flagged) source = { ...source, injectionFlagged: true };
      }
    } catch { /* no index → resolver facts only */ }
  }
  return { send, source };
}

function sanitizeSend(s: MailSendFacts): MailSendFacts | null {
  if (!s || typeof s !== 'object') return null;
  return {
    account: str(s.account).trim(),
    to: strList(s.to),
    cc: strList(s.cc),
    bcc: strList(s.bcc),
    subject: str(s.subject),
    body: str(s.body),
    inReplyTo: normalizeMessageId(s.inReplyTo) || undefined,
    references: Array.isArray(s.references) ? s.references.map(normalizeMessageId).filter(Boolean) : undefined,
    forward: s.forward === true,
    attachments: Array.isArray(s.attachments) ? s.attachments.map(a => ({ name: str((a as any)?.name ?? a), source: (a as any)?.source })) : [],
    draftId: s.draftId ? str(s.draftId) : undefined,
  };
}

function sanitizeSource(s: MailSourceFacts): MailSourceFacts | null {
  const messageId = normalizeMessageId(s.messageId);
  if (!messageId) return null;
  return {
    account: str(s.account).trim(),
    messageId,
    from: str(s.from),
    subject: str(s.subject),
    text: typeof s.text === 'string' ? s.text.slice(0, 200_000) : undefined,
    injectionFlagged: s.injectionFlagged === true,
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(null), ms);
    t.unref?.();
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

/** Short, secret-masked description of the recipients for prompts / notices. PURE. */
export function describeRecipients(send: MailSendFacts): string {
  const list = (xs: string[]) => xs.map(x => bareAddress(x) || x.replace(/\s+/g, ' ').slice(0, 80)).join(', ');
  const parts = [`to ${list(send.to) || '(none)'}`];
  if (send.cc.length) parts.push(`cc ${list(send.cc)}`);
  if (send.bcc.length) parts.push(`bcc ${list(send.bcc)}`);
  return parts.join(' · ');
}
