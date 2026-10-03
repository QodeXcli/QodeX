/**
 * The mail transport contract. One `MailTransport` per account: IMAP for reading /
 * flagging / moving / storing drafts, SMTP for sending. Implementations:
 *   - ImapSmtpTransport (imap-smtp.ts): imapflow + nodemailer + mailparser
 *   - InMemoryMailTransport (fake.ts): for tests and offline development
 *
 * Message ids are opaque strings "<folder>#<uid>" (see makeMessageId) so a tool can
 * act on a message without the model handling folder + UID pairs. A transport must
 * never put the account's password / token in a return value or an error message.
 */

export interface MailAddress {
  name?: string;
  address: string;
}

export interface MailSummary {
  /** "<folder>#<uid>". */
  id: string;
  folder: string;
  uid: number;
  /** RFC 5322 Message-ID (with angle brackets). */
  messageId?: string;
  from: MailAddress[];
  to: MailAddress[];
  subject: string;
  /** ISO date. */
  date?: string;
  /** IMAP flags (\Seen, \Answered, \Flagged, \Draft, …). */
  flags: string[];
  /** First characters of the text body (may be absent when the server can't cheaply give it). */
  snippet?: string;
  hasAttachments?: boolean;
  size?: number;
}

export interface MailAttachmentInfo {
  index: number;
  filename: string;
  contentType: string;
  size: number;
  inline?: boolean;
}

export interface MailMessage extends MailSummary {
  cc: MailAddress[];
  replyTo: MailAddress[];
  inReplyTo?: string;
  references: string[];
  /** Plain-text body; HTML-only messages are converted to text. */
  text: string;
  attachments: MailAttachmentInfo[];
  /** A few headers worth knowing (auto-submitted, list-id, list-unsubscribe, precedence). */
  headers?: Record<string, string>;
}

export interface MailAttachmentData {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface ListQuery {
  folder?: string;
  unreadOnly?: boolean;
  limit?: number;
  /** Free text matched against from / subject / body (IMAP TEXT search). */
  query?: string;
  /** Only messages with a UID greater than this (watchers). */
  sinceUid?: number;
}

export interface OutgoingAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export interface OutgoingMail {
  from: MailAddress;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string[];
  attachments: OutgoingAttachment[];
  /** Pre-assigned Message-ID, so the draft, the sent copy and the delivered mail agree. */
  messageId?: string;
  date?: Date;
}

export interface SendResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
  /** Server's final reply (secrets scrubbed). */
  response?: string;
}

export interface AppendResult {
  folder: string;
  uid?: number;
}

export type SpecialFolder = 'inbox' | 'drafts' | 'sent' | 'archive' | 'trash' | 'junk';

export interface FolderInfo {
  path: string;
  specialUse?: SpecialFolder;
}

export interface TransportCheck {
  imap: { ok: boolean; error?: string };
  smtp: { ok: boolean; error?: string };
}

/** A folder's counters (watchers persist uidValidity + the last seen UID). */
export interface FolderStatus {
  folder: string;
  messages: number;
  unseen: number;
  uidNext: number;
  /** Changes when the server renumbers the folder: forget the last seen UID then. */
  uidValidity: string;
}

export interface WaitResult {
  /** New mail arrived (EXISTS grew). */
  changed: boolean;
  reason: 'exists' | 'timeout' | 'abort' | 'closed';
}

export interface MailTransport {
  /** Account name this transport serves. */
  readonly account: string;
  list(q: ListQuery): Promise<MailSummary[]>;
  /** Free-text search (same as list with `query`). */
  search(query: string, opts?: Omit<ListQuery, 'query'>): Promise<MailSummary[]>;
  fetch(id: string): Promise<MailMessage | null>;
  fetchAttachment(id: string, which: { index?: number; filename?: string }): Promise<MailAttachmentData | null>;
  flag(id: string, change: { seen?: boolean; flagged?: boolean; answered?: boolean }): Promise<void>;
  /** Move to a folder path or a special folder; returns where it went. */
  move(id: string, dest: string): Promise<{ folder: string; id?: string }>;
  /** Store a draft in the server's Drafts folder; null when the server has none / can't. */
  appendDraft(msg: OutgoingMail): Promise<AppendResult | null>;
  /** File a copy of a sent message into Sent (providers that don't do it themselves). */
  appendSent(msg: OutgoingMail): Promise<AppendResult | null>;
  /** Permanently remove one message (used only for QodeX's own draft copy after sending). */
  deleteMessage(id: string): Promise<void>;
  send(msg: OutgoingMail): Promise<SendResult>;
  folders(): Promise<FolderInfo[]>;
  /** Log in to IMAP and SMTP without changing anything. */
  test(): Promise<TransportCheck>;
  /** Counters for a folder (watchers). Optional: a transport without it is polled with list(). */
  status?(folder: string): Promise<FolderStatus>;
  /**
   * Wait until new mail arrives in `folder` (IMAP IDLE on a dedicated connection, NOOP
   * polling where the server has no IDLE), a timeout, or an abort. Optional.
   */
  /** `sinceUidNext`: resolve at once (changed) when the folder's UIDNEXT is already past it. */
  waitForNew?(folder: string, opts?: { timeoutMs?: number; signal?: AbortSignal; sinceUidNext?: number }): Promise<WaitResult>;
  close(): Promise<void>;
}

/** "<folder>#<uid>". PURE. */
export function makeMessageId(folder: string, uid: number): string {
  return `${folder}#${uid}`;
}

/** Parse "<folder>#<uid>" (folder may itself contain '#'); bare digits mean INBOX. PURE. */
export function parseMessageId(id: string): { folder: string; uid: number } | null {
  const s = String(id ?? '').trim();
  if (/^\d+$/.test(s)) return { folder: 'INBOX', uid: Number(s) };
  const i = s.lastIndexOf('#');
  if (i <= 0) return null;
  const folder = s.slice(0, i);
  const uidText = s.slice(i + 1);
  if (!/^\d+$/.test(uidText) || /[\r\n\0]/.test(folder)) return null;
  const uid = Number(uidText);
  return uid > 0 && Number.isSafeInteger(uid) ? { folder, uid } : null;
}

/** "Name <addr>" or "addr". PURE. */
export function formatAddress(a: MailAddress | undefined): string {
  if (!a?.address) return a?.name ?? '';
  return a.name && a.name !== a.address ? `${a.name} <${a.address}>` : a.address;
}

export function formatAddresses(list: MailAddress[] | undefined): string {
  return (list ?? []).map(formatAddress).filter(Boolean).join(', ');
}

/** Special-folder words the tools accept. */
export const SPECIAL_FOLDERS: readonly SpecialFolder[] = ['inbox', 'drafts', 'sent', 'archive', 'trash', 'junk'];

export function asSpecialFolder(dest: string): SpecialFolder | null {
  const d = String(dest ?? '').trim().toLowerCase();
  if (d === 'spam') return 'junk';
  if (d === 'bin' || d === 'deleted') return 'trash';
  return (SPECIAL_FOLDERS as readonly string[]).includes(d) ? d as SpecialFolder : null;
}
