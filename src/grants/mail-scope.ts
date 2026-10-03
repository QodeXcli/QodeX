/**
 * Scope of a standing 'mail-reply' grant — what Sentinel checks before it lets a
 * `mail_send` go out without asking a human.
 *
 * What a mail_send would send comes from the mail core (src/mail/outgoing.ts):
 * `resolveOutgoingMail(args)` loads the draft the call names and describes it. A
 * reply only exists as a draft made with `mail_draft {reply_to_id}`; drafts are
 * HMAC-signed with a key derived from the vault key and immutable, so the model
 * can forge neither `isReplyTo` (the thread, its original sender) nor clear its
 * `injectionFlagged`.
 *
 * ALL of these must hold (anything else → the normal critical human prompt):
 *   1. the description has no problems (the tool would refuse it anyway);
 *   2. it is a reply (`isReplyTo`, i.e. In-Reply-To a message in that account's
 *      mailbox) — and not to a message this account sent itself;
 *   3. it goes to that message's original sender only: exactly one To address,
 *      equal to the original From (not its Reply-To), no Cc, no Bcc, no other
 *      recipient at all (`extraRecipients` empty);
 *   4. it is not a forward and carries no attachments from disk;
 *   5. the original was not flagged as a prompt-injection attempt (the draft's flag,
 *      or the mail watcher's received-mail index flag — either one counts);
 *   6. the reply carries nothing that looks like a secret (cards, keys, tokens);
 *   7. an active grant covers it: kind 'mail-reply', account (or '*'), sender
 *      filter, not expired — and its daily cap is not used up (counted by the
 *      guard at the moment it allows the send).
 */

import { scanInjection } from '../sentinel/injection.js';
import { detectSecrets } from '../sentinel/policy.js';
import { resolveOutgoingMail, type MailSendArgs, type OutgoingMailDescription } from '../mail/outgoing.js';
import { getDraftStore, type DraftStore } from '../mail/drafts.js';
import { bareAddress, isExpired, normalizeAccount, senderAllowed, type StandingGrant } from './store.js';
import { getReceivedIndex, normalizeMessageId, type ReceivedIndex, type ReceivedMessage } from './received.js';

/** The tool name Sentinel applies standing mail-reply grants to. */
export const MAIL_SEND_TOOL = 'mail_send';

/** What a mail_send call would send, as Sentinel judges it. */
export interface MailSendResolution {
  /** The mail core's description (recipients, thread, attachments, problems). */
  description: OutgoingMailDescription;
  /** The full body (secret check; never logged). */
  body?: string;
  /** What the received-mail index knows about the replied-to message (its flag always counts). */
  seen?: ReceivedMessage | null;
}

const FORWARD_SUBJECT_RE = /^\s*(?:fwd?|fw|forward(?:ed)?|tr|wg|ارسال\s*مجدد|بازارسال|هدایت)\s*:/i;

export type ScopeVerdict =
  | { ok: true; grant: StandingGrant; recipient: string; account: string }
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
      account?: string;
    };

/**
 * Is this send inside a mail-reply grant? PURE (the daily cap is counted by the
 * caller, which receives the matching grant).
 */
export function checkMailReplyScope(
  mail: MailSendResolution,
  grants: StandingGrant[],
  opts: { now?: number; usedToday?: (id: string) => number } = {},
): ScopeVerdict {
  const now = opts.now ?? Date.now();
  const d = mail.description;
  const reasons: string[] = [];
  if (d.problems.length) reasons.push(`it cannot be sent as given (${d.problems.slice(0, 2).join('; ')})`);
  const r = d.isReplyTo;

  let account = '';
  try { account = normalizeAccount(d.account ?? r?.account ?? ''); } catch { reasons.push('the sending account is not valid'); }
  if (account === '*') reasons.push('the sending account is unknown');

  if (!r) reasons.push('it is not a reply (no In-Reply-To): a new thread always asks');
  else if (!normalizeMessageId(r.messageId)) reasons.push('the original message has no Message-ID (no In-Reply-To)');

  const original = r ? bareAddress(r.threadSender) : '';
  if (r && !original) reasons.push('the original sender address is unreadable');
  if (r && account && r.account.toLowerCase() !== account.toLowerCase()) reasons.push(`the original was received in another account (${r.account})`);
  if (original && d.from && bareAddress(d.from) === original) reasons.push('it replies to a message this account sent itself, not to one it received');

  let recipient = '';
  const to = [...new Set(d.to.map(bareAddress))];
  if (d.to.length !== 1 || to.length !== 1 || !to[0]) reasons.push(`it goes to ${d.to.length === 1 ? 'an invalid address' : `${d.to.length} recipients`} (a reply goes to the original sender only)`);
  else recipient = to[0];
  if (recipient && original && recipient !== original) reasons.push(`it goes to ${recipient}, not to the original sender ${original}`);
  if (d.cc.length) reasons.push(`it adds Cc recipients (${d.cc.length})`);
  if (d.bcc.length) reasons.push(`it adds Bcc recipients (${d.bcc.length})`);
  if (d.extraRecipients.length && !reasons.some(x => /recipient|original sender/.test(x))) {
    reasons.push(`it goes to people outside the thread (${d.extraRecipients.length})`);
  }
  if (d.attachments.length) reasons.push(`it carries ${d.attachments.length} attachment(s) from disk`);
  if (FORWARD_SUBJECT_RE.test(d.subject ?? '')) reasons.push('it forwards a message');
  const secrets = detectSecrets(`${d.subject ?? ''}\n${mail.body ?? d.bodyPreview ?? ''}`);
  if (secrets.length) reasons.push('the reply contains something that looks like a secret (card number, key, token)');

  if (r) {
    const flagged = r.injectionFlagged === true || mail.seen?.flagged === true
      // The original subject is part of the reply's subject: re-scan it too.
      || scanInjection(d.subject ?? '').length > 0;
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
    if (usable.length) return { ok: true, grant: usable[0], recipient, account };
    if (active.length) {
      return { ok: false, reasons: [`today's cap of the standing reply grant ${active[0].id} is used up (${active[0].maxPerDay}/day)`], replyShaped, blockedByCap: true, recipient, account };
    }
    if (covering.length) {
      return { ok: false, reasons: [`the standing reply grant ${covering[0].id} expired`], replyShaped, blockedByCap: true, recipient, account };
    }
    return { ok: false, reasons: ['no standing reply grant covers this account and sender'], replyShaped, recipient, account };
  }
  return { ok: false, reasons, replyShaped, recipient: recipient || undefined, account: account || undefined };
}

/**
 * Resolve what a mail_send call would send (the mail core loads + verifies its draft)
 * and what the received-mail index knows about the message it replies to. Never
 * throws; null when it can't be told in time (→ the human prompt).
 */
export async function resolveMailSend(
  args: Record<string, unknown>,
  opts: { drafts?: DraftStore; index?: ReceivedIndex; timeoutMs?: number } = {},
): Promise<MailSendResolution | null> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  try {
    const drafts = opts.drafts ?? getDraftStore();
    const res = await withTimeout(resolveOutgoingMail((args ?? {}) as MailSendArgs, { drafts }), timeoutMs);
    if (!res) return null;
    const { description, draft } = res;
    // A draft already sent is refused by the tool (MAIL_ALREADY_SENT) before its gate: nothing to approve.
    if (draft && !description.problems.length) {
      try {
        if (await withTimeout(drafts.sentInfo(draft.id), timeoutMs)) {
          description.problems = [`[MAIL_ALREADY_SENT] draft ${draft.id} was already sent`];
        }
      } catch { /* the tool checks again */ }
    }
    let seen: ReceivedMessage | null = null;
    const r = description.isReplyTo;
    if (r && normalizeMessageId(r.messageId)) {
      try {
        seen = await withTimeout((opts.index ?? getReceivedIndex()).lookup(r.account, r.messageId), timeoutMs);
      } catch { seen = null; }
    }
    const body = draft ? draft.body : typeof (args as any)?.body === 'string' ? String((args as any).body) : undefined;
    return { description, ...(body !== undefined ? { body } : {}), seen };
  } catch {
    return null;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(null), ms);
    t.unref?.();
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}
