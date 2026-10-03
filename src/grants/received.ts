/**
 * Received-mail index — the messages QodeX has seen ARRIVE in each account
 * (written by the mail watcher, and by the mail core when it fetches a message).
 *
 * A standing mail-reply grant only covers "a reply to a message received in that
 * account, to its original sender". This index is one of the two trusted places
 * that fact comes from (the other is the mail core's send resolver, which looks
 * the original up in the mailbox itself). It also remembers whether the message
 * was flagged as a prompt-injection attempt: a flagged message never gets an
 * automatic reply.
 *
 * ~/.qodex/mail-auto/received.json (0600, bounded, atomic, cross-process lock).
 * Sentinel hard-protects the directory, so the agent cannot forge an entry.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { writeFileAtomic } from '../utils/atomic-write.js';
import { withLock } from '../utils/file-lock.js';
import { bareAddress } from './store.js';
import { mailAutoPaths } from './paths.js';

export interface ReceivedMessage {
  account: string;
  /** Message-ID header without the angle brackets. */
  messageId: string;
  /** Bare address of the From header (lower-case). */
  from: string;
  subject?: string;
  folder?: string;
  uid?: number;
  /** Prompt-injection findings in the subject/body → never auto-replied to. */
  flagged: boolean;
  findings?: string[];
  /** ISO timestamp (when QodeX saw it). */
  receivedAt: string;
}

const MAX_ENTRIES = 5000;

/** '<Abc@x.y>' → 'Abc@x.y' (trimmed; '' when empty). PURE. */
export function normalizeMessageId(v: unknown): string {
  const s = String(v ?? '').trim();
  const m = /<([^<>\s]+)>/.exec(s);
  const id = (m ? m[1] : s.replace(/^<|>$/g, '')).trim();
  return /^[^\s<>]{1,998}$/.test(id) ? id : '';
}

function key(account: string, messageId: string): string {
  return `${account.toLowerCase()}\u0000${messageId}`;
}

function sanitize(raw: unknown): ReceivedMessage[] {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as any).messages)) return [];
  const out: ReceivedMessage[] = [];
  for (const m of (raw as any).messages as unknown[]) {
    if (!m || typeof m !== 'object') continue;
    const x = m as Record<string, unknown>;
    const messageId = normalizeMessageId(x.messageId);
    const account = typeof x.account === 'string' ? x.account.trim() : '';
    if (!messageId || !account) continue;
    out.push({
      account,
      messageId,
      from: bareAddress(x.from),
      subject: typeof x.subject === 'string' ? x.subject.slice(0, 300) : undefined,
      folder: typeof x.folder === 'string' ? x.folder.slice(0, 200) : undefined,
      uid: Number.isSafeInteger(x.uid) ? (x.uid as number) : undefined,
      // Fail closed: anything but an explicit false counts as flagged.
      flagged: x.flagged !== false,
      findings: Array.isArray(x.findings) ? x.findings.map(String).slice(0, 10) : undefined,
      receivedAt: typeof x.receivedAt === 'string' ? x.receivedAt : new Date(0).toISOString(),
    });
  }
  return out;
}

export class ReceivedIndex {
  readonly file: string;

  constructor(opts: { file?: string } = {}) {
    this.file = opts.file ?? mailAutoPaths().received;
  }

  private async read(): Promise<ReceivedMessage[]> {
    try {
      return sanitize(JSON.parse(await fs.readFile(this.file, 'utf-8')));
    } catch {
      return [];
    }
  }

  /** Record (or update) messages. A message once flagged stays flagged. */
  async record(messages: ReceivedMessage[]): Promise<void> {
    const fresh = sanitize({ messages });
    if (!fresh.length) return;
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await withLock(this.file + '.lock', async () => {
      const all = await this.read();
      const byKey = new Map(all.map(m => [key(m.account, m.messageId), m]));
      for (const m of fresh) {
        const k = key(m.account, m.messageId);
        const prev = byKey.get(k);
        byKey.delete(k); // re-insert at the end (most recent)
        byKey.set(k, prev ? { ...prev, ...m, flagged: prev.flagged || m.flagged, from: prev.from || m.from } : m);
      }
      const list = [...byKey.values()].slice(-MAX_ENTRIES);
      await writeFileAtomic(this.file, JSON.stringify({ version: 1, messages: list }) + '\n', { mode: 0o600 });
    }, { retries: 100, intervalMs: 50, staleMs: 10_000 });
  }

  async lookup(account: string, messageId: string): Promise<ReceivedMessage | null> {
    const id = normalizeMessageId(messageId);
    if (!id || !account) return null;
    const k = key(account, id);
    const all = await this.read();
    for (let i = all.length - 1; i >= 0; i--) if (key(all[i].account, all[i].messageId) === k) return all[i];
    return null;
  }

  async has(account: string, messageId: string): Promise<boolean> {
    return (await this.lookup(account, messageId)) !== null;
  }
}

let instance: ReceivedIndex | null = null;
export function getReceivedIndex(): ReceivedIndex {
  if (!instance) instance = new ReceivedIndex();
  return instance;
}
export function setReceivedIndexForTests(idx: ReceivedIndex | null): void {
  instance = idx;
}
