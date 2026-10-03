/**
 * Local drafts store: one JSON file per draft in QODEX_MAIL_DRAFTS_DIR (0600).
 *
 * Drafts are IMMUTABLE and SIGNED. mail_send {draft_id} sends exactly the draft the
 * human approved, and Sentinel / standing grants judge a reply by what the draft says
 * about its thread (the replied-to Message-ID, the original sender, whether that email
 * was flagged for prompt injection). So:
 *   - a draft is written once ('wx'); a changed reply is a NEW draft id;
 *   - each file carries an HMAC (key derived from the vault key, which the agent can
 *     never read) over the whole draft — a draft forged or edited with write_file /
 *     shell fails verification and is refused;
 *   - "sent" is a separate marker file, so a draft is never sent twice by accident.
 */

import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { QODEX_MAIL_DRAFTS_DIR } from './paths.js';
import { deriveKey, hmac, loadVaultKey, sameMac } from './secrets.js';

export interface DraftReplyInfo {
  /** Tool id of the replied-to message ("<folder>#<uid>"). */
  id: string;
  /** Its Message-ID (In-Reply-To of the reply). */
  messageId: string;
  /** Its From address — the "original sender" of the thread. */
  threadSender: string;
  /** Its Reply-To address, when it had one that differs from From. */
  threadReplyTo?: string;
  /** References chain for the reply (original's references + its Message-ID). */
  references: string[];
  /** Original subject. */
  subject: string;
  /** Sentinel's injection scan found instructions in the original email. */
  injectionFlagged: boolean;
  findings?: string[];
}

export interface MailDraft {
  id: string;
  /** Account name. */
  account: string;
  /** From address (the account's). */
  from: string;
  fromName?: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  /** Absolute paths of files from disk to attach. */
  attachments: string[];
  reply?: DraftReplyInfo;
  /** Pre-assigned Message-ID for the outgoing mail. */
  messageId: string;
  createdAt: string;
  /** Where the IMAP copy went (Drafts folder), if the server took one. */
  remote?: { folder: string; uid?: number };
}

export type DraftInput = Omit<MailDraft, 'id' | 'createdAt' | 'messageId'> & { messageId?: string };

interface DraftFile {
  format: 'qodex-mail-draft';
  version: 1;
  draft: MailDraft;
  mac: string;
}

export interface SentMarker {
  sentAt: string;
  messageId: string;
  accepted: string[];
}

const ID_RE = /^d_[A-Za-z0-9_-]{6,40}$/;

export function isDraftId(id: string): boolean {
  return ID_RE.test(String(id ?? ''));
}

/** Deterministic JSON (sorted keys) so the MAC doesn't depend on key order. PURE. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/** A Message-ID in the sender's domain. PURE (random). */
export function newMessageId(fromAddress: string): string {
  const domain = (String(fromAddress ?? '').split('@')[1] || 'qodex.local').replace(/[^A-Za-z0-9.-]/g, '') || 'qodex.local';
  return `<qodex.${Date.now().toString(36)}.${randomBytes(8).toString('hex')}@${domain}>`;
}

export class DraftStore {
  readonly dir: string;
  private readonly keyFile?: string;
  private readonly vaultFile?: string;
  private macKey: Buffer | null = null;

  constructor(opts: { dir?: string; keyFile?: string; vaultFile?: string } = {}) {
    this.dir = opts.dir ?? QODEX_MAIL_DRAFTS_DIR;
    this.keyFile = opts.keyFile;
    this.vaultFile = opts.vaultFile;
  }

  private async key(): Promise<Buffer> {
    if (this.macKey) return this.macKey;
    const k = await loadVaultKey({ keyFile: this.keyFile, vaultFile: this.vaultFile, create: true });
    if (!k) throw new Error('[MAIL_KEY_MISSING] could not load the vault key');
    this.macKey = deriveKey(k, 'qodex-mail-drafts:v1');
    return this.macKey;
  }

  private file(id: string): string {
    if (!isDraftId(id)) throw new Error(`[MAIL_DRAFT_NOT_FOUND] "${String(id).slice(0, 60)}" is not a draft id (d_…)`);
    return path.join(this.dir, `${id}.json`);
  }

  private sentFile(id: string): string {
    return this.file(id).replace(/\.json$/, '.sent.json');
  }

  /** Write a new draft (never overwrites). */
  async create(input: DraftInput): Promise<MailDraft> {
    const key = await this.key();
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const draft: MailDraft = JSON.parse(JSON.stringify({
      ...input,
      id: 'd_' + randomBytes(9).toString('base64url'),
      messageId: input.messageId ?? newMessageId(input.from),
      createdAt: new Date().toISOString(),
    }));
    const doc: DraftFile = { format: 'qodex-mail-draft', version: 1, draft, mac: hmac(key, canonicalJson(draft)) };
    const fh = await fs.open(this.file(draft.id), 'wx', 0o600);
    try { await fh.writeFile(JSON.stringify(doc, null, 2) + '\n'); } finally { await fh.close(); }
    return draft;
  }

  /** A verified draft, or null when there is none. Throws `[MAIL_DRAFT_TAMPERED]` on a bad signature. */
  async get(id: string): Promise<MailDraft | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file(id), 'utf-8');
    } catch (e: any) {
      if (e?.code === 'ENOENT') return null;
      throw e;
    }
    let doc: Partial<DraftFile>;
    try { doc = JSON.parse(raw); } catch { throw new Error(`[MAIL_DRAFT_TAMPERED] draft ${id} is not valid JSON`); }
    const key = await this.key();
    if (doc?.format !== 'qodex-mail-draft' || !doc.draft || typeof doc.mac !== 'string' || !sameMac(doc.mac, hmac(key, canonicalJson(doc.draft)))) {
      throw new Error(`[MAIL_DRAFT_TAMPERED] draft ${id} was not written by mail_draft (bad signature) — refusing to use it`);
    }
    if (doc.draft.id !== id) throw new Error(`[MAIL_DRAFT_TAMPERED] draft ${id} holds another draft's content`);
    return doc.draft;
  }

  /** Verified drafts, newest first (tampered files are skipped). */
  async list(account?: string): Promise<MailDraft[]> {
    let names: string[];
    try { names = await fs.readdir(this.dir); } catch { return []; }
    const out: MailDraft[] = [];
    for (const n of names) {
      const m = /^(d_[A-Za-z0-9_-]+)\.json$/.exec(n);
      if (!m) continue;
      try {
        const d = await this.get(m[1]);
        if (d && (!account || d.account.toLowerCase() === account.toLowerCase())) out.push(d);
      } catch { /* skip tampered */ }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Record that a draft was sent. False when it already was. */
  async markSent(id: string, info: Omit<SentMarker, 'sentAt'>): Promise<boolean> {
    try {
      const fh = await fs.open(this.sentFile(id), 'wx', 0o600);
      try { await fh.writeFile(JSON.stringify({ sentAt: new Date().toISOString(), ...info }) + '\n'); } finally { await fh.close(); }
      return true;
    } catch (e: any) {
      if (e?.code === 'EEXIST') return false;
      throw e;
    }
  }

  async sentInfo(id: string): Promise<SentMarker | null> {
    try { return JSON.parse(await fs.readFile(this.sentFile(id), 'utf-8')) as SentMarker; } catch { return null; }
  }

  async remove(id: string): Promise<boolean> {
    try { await fs.unlink(this.file(id)); } catch { return false; }
    try { await fs.unlink(this.sentFile(id)); } catch { /* none */ }
    return true;
  }
}

let instance: DraftStore | null = null;

export function getDraftStore(): DraftStore {
  if (!instance) instance = new DraftStore();
  return instance;
}

/** Test hook. */
export function setDraftStoreForTests(s: DraftStore | null): void {
  instance = s;
}
