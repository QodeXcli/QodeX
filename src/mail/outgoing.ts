/**
 * What would mail_send send? A PURE description of the outgoing message for Sentinel's
 * classification (src/sentinel/policy.ts, owned by the mail-auto work), standing-grant
 * checks and the approval prompt:
 *
 *   describeOutgoingMail(args, draft?) → { to, cc, bcc, subject, isReplyTo?, attachments, … }
 *
 * `args` are mail_send's parsed tool args. With `draft_id` the message is the (signed,
 * immutable) draft, which the caller loads first — `resolveOutgoingMail` does that.
 * Passing both a draft_id and message fields is a problem (refused), so what was
 * classified is always exactly what is sent.
 */

import * as path from 'path';
import { isEmailAddress } from './accounts.js';
import { getDraftStore, type DraftStore, type MailDraft } from './drafts.js';

/** mail_send's arguments (the tool's zod schema mirrors this). */
export interface MailSendArgs {
  draft_id?: string;
  account?: string;
  /** Comma-separated addresses. */
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  /** Files from disk to attach (paths). */
  attachments?: string[];
}

export interface OutgoingMailDescription {
  /** Account name (undefined = the default account). */
  account?: string;
  /** From address, when known (drafts). */
  from?: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  /** One-line preview of the body (first 300 characters). */
  bodyPreview: string;
  bodyChars: number;
  /** A reply in an existing thread (only drafts made with reply_to_id). */
  isReplyTo?: {
    account: string;
    /** Message-ID of the replied-to email (In-Reply-To). */
    messageId: string;
    /** From address of the replied-to email. */
    threadSender: string;
    /** Its Reply-To, when different from From. */
    threadReplyTo?: string;
    /** The replied-to email was flagged for prompt injection. */
    injectionFlagged: boolean;
  };
  /** Files from disk that would be attached. */
  attachments: Array<{ name: string; path: string; fromDisk: true }>;
  draftId?: string;
  /**
   * Recipients other than the thread's original sender (to + cc + bcc). Empty for a
   * plain same-thread reply to the sender; everything for a new message.
   */
  extraRecipients: string[];
  /** Why this can't be sent as given (empty = sendable). */
  problems: string[];
}

/** Split "a@x.com, B <b@y.com>; c@z.com" into bare addresses (lower-cased domain kept as typed). PURE. */
export function parseAddressList(input: string | string[] | undefined | null): string[] {
  const parts = (Array.isArray(input) ? input : [input ?? ''])
    .flatMap(s => String(s ?? '').split(/[,;\n]+/))
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => {
      const m = /<([^<>]+)>\s*$/.exec(s);
      return (m ? m[1] : s).trim();
    });
  return [...new Set(parts)];
}

function oneLine(s: string, max: number): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

const lc = (s: string) => s.trim().toLowerCase();

/** PURE: describe the message mail_send would send for `args` (and its loaded draft). */
export function describeOutgoingMail(args: MailSendArgs, draft?: MailDraft | null): OutgoingMailDescription {
  const a = args ?? {};
  const problems: string[] = [];
  const fieldKeys = (['to', 'cc', 'bcc', 'subject', 'body', 'attachments'] as const)
    .filter(k => a[k] !== undefined && !(Array.isArray(a[k]) && (a[k] as unknown[]).length === 0) && a[k] !== '');

  let to: string[]; let cc: string[]; let bcc: string[];
  let subject: string; let body: string; let files: string[]; let account: string | undefined;
  let from: string | undefined;
  let isReplyTo: OutgoingMailDescription['isReplyTo'];

  if (a.draft_id) {
    if (fieldKeys.length) problems.push(`pass either draft_id or the message fields (${fieldKeys.join(', ')}), not both`);
    if (!draft) {
      problems.push(`draft ${a.draft_id} is not loaded`);
      return { account: a.account, to: [], cc: [], bcc: [], subject: '', bodyPreview: '', bodyChars: 0, attachments: [], draftId: a.draft_id, extraRecipients: [], problems };
    }
    if (draft.id !== a.draft_id) problems.push('the loaded draft is not the requested one');
    if (a.account && lc(a.account) !== lc(draft.account)) problems.push(`draft ${draft.id} belongs to account "${draft.account}", not "${a.account}"`);
    account = draft.account;
    from = draft.from;
    to = [...draft.to]; cc = [...draft.cc]; bcc = [...draft.bcc];
    subject = draft.subject; body = draft.body; files = [...draft.attachments];
    if (draft.reply) {
      isReplyTo = {
        account: draft.account, messageId: draft.reply.messageId, threadSender: draft.reply.threadSender,
        ...(draft.reply.threadReplyTo ? { threadReplyTo: draft.reply.threadReplyTo } : {}),
        injectionFlagged: !!draft.reply.injectionFlagged,
      };
    }
  } else {
    account = a.account;
    to = parseAddressList(a.to); cc = parseAddressList(a.cc); bcc = parseAddressList(a.bcc);
    subject = String(a.subject ?? ''); body = String(a.body ?? ''); files = [...(a.attachments ?? [])];
  }

  const all = [...to, ...cc, ...bcc];
  if (!all.length) problems.push('no recipient');
  const bad = all.filter(x => !isEmailAddress(x));
  if (bad.length) problems.push(`not an email address: ${bad.slice(0, 3).map(x => JSON.stringify(oneLine(x, 60))).join(', ')}`);
  if (/[\r\n]/.test(subject)) problems.push('the subject contains a line break');
  if (!a.draft_id && !subject.trim() && !body.trim()) problems.push('empty message (no subject and no body)');

  const sender = isReplyTo ? lc(isReplyTo.threadSender) : null;
  const extraRecipients = sender ? all.filter(x => lc(x) !== sender) : [...all];

  return {
    account, ...(from ? { from } : {}),
    to, cc, bcc, subject,
    bodyPreview: oneLine(body, 300), bodyChars: body.length,
    ...(isReplyTo ? { isReplyTo } : {}),
    attachments: files.map(p => ({ name: path.basename(String(p)), path: String(p), fromDisk: true as const })),
    ...(a.draft_id ? { draftId: a.draft_id } : {}),
    extraRecipients,
    problems,
  };
}

/** One line for Sentinel's summary / the audit trail. PURE. */
export function summarizeOutgoingMail(d: OutgoingMailDescription): string {
  const parts = [`send email${d.account ? ` from ${d.account}` : ''} to ${d.to.join(', ') || '(nobody)'}`];
  if (d.cc.length) parts.push(`cc ${d.cc.join(', ')}`);
  if (d.bcc.length) parts.push(`bcc ${d.bcc.join(', ')}`);
  parts.push(`subject "${oneLine(d.subject, 80)}"`);
  if (d.isReplyTo) parts.push(`reply in the thread of ${d.isReplyTo.threadSender}${d.isReplyTo.injectionFlagged ? ' (that email was flagged for prompt injection)' : ''}`);
  else parts.push('new message');
  if (d.attachments.length) parts.push(`${d.attachments.length} attachment${d.attachments.length === 1 ? '' : 's'} from disk (${d.attachments.slice(0, 3).map(x => x.name).join(', ')})`);
  return parts.join(' · ');
}

/** The multi-line block an approval prompt shows (recipients, subject, body preview). PURE. */
export function formatOutgoingPrompt(d: OutgoingMailDescription): string[] {
  const lines = [
    `From: ${d.from ?? d.account ?? '(default account)'}`,
    `To: ${d.to.join(', ') || '—'}`,
  ];
  if (d.cc.length) lines.push(`Cc: ${d.cc.join(', ')}`);
  if (d.bcc.length) lines.push(`Bcc: ${d.bcc.join(', ')}`);
  lines.push(`Subject: ${oneLine(d.subject, 160) || '(none)'}`);
  if (d.isReplyTo) {
    lines.push(`Reply to: ${d.isReplyTo.threadSender} (same thread)${d.isReplyTo.injectionFlagged ? ' ⚠ that email contained instructions aimed at the AI' : ''}`);
    if (d.extraRecipients.length) lines.push(`⚠ Also to people outside the thread: ${d.extraRecipients.join(', ')}`);
  }
  if (d.attachments.length) lines.push(`Attachments (from disk): ${d.attachments.map(x => x.path).join(', ')}`);
  lines.push(`Body (${d.bodyChars} chars): ${d.bodyPreview || '(empty)'}`);
  return lines;
}

/** Load the draft (when args name one) and describe. Draft-store errors become problems. */
export async function resolveOutgoingMail(
  args: MailSendArgs,
  deps: { drafts?: DraftStore } = {},
): Promise<{ description: OutgoingMailDescription; draft: MailDraft | null }> {
  let draft: MailDraft | null = null;
  let loadError: string | null = null;
  if (args?.draft_id) {
    try {
      draft = await (deps.drafts ?? getDraftStore()).get(args.draft_id);
      if (!draft) loadError = `[MAIL_DRAFT_NOT_FOUND] no draft ${args.draft_id}`;
    } catch (e: any) {
      loadError = String(e?.message ?? e);
    }
  }
  const description = describeOutgoingMail(args, draft);
  if (loadError) description.problems = [loadError, ...description.problems.filter(p => !p.endsWith('is not loaded'))];
  return { description, draft };
}
