/**
 * Mail automation events — "new mail from X", "auto-replied to X", "rule started a
 * run", "grant created" — fanned out to every place the user might look:
 *
 *   1. this process's bus as `{kind:'mail'}` (control center timeline, a Telegram
 *      bot running in this process);
 *   2. a small cross-process feed (~/.qodex/mail-auto/events.jsonl) that
 *      `startMailEventBridge()` mirrors onto OTHER processes' buses (a control
 *      center in the TUI sees what the detached watcher daemon saw);
 *   3. a native desktop notification (macOS);
 *   4. paired Telegram chats directly, when no bot runs in this process
 *      (src/channels/telegram/notifier.ts — a running bot covers it via the bus).
 *
 * Every text field is one line, clipped and secret-masked here, before it leaves.
 * A snippet of an email is DATA: consumers escape it (HTML / textContent) and
 * never act on it. Nothing here throws into the caller.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { getBus } from '../control/bus.js';
import { maskControlTokens, maskSecrets } from '../sentinel/policy.js';
import { logger } from '../utils/logger.js';
import { mailAutoPaths } from './paths.js';

export type MailEventType =
  | 'new-mail'
  | 'auto-reply'
  | 'auto-reply-failed'
  | 'rule-run'
  | 'rule-draft-only'
  | 'rule-error'
  | 'watch-started'
  | 'watch-stopped'
  | 'watch-error'
  | 'grant-created'
  | 'grant-revoked';

export interface MailEventData {
  account?: string;
  /** Sender as displayed (`Name <addr>`). */
  from?: string;
  /** Recipient (auto-replies). */
  to?: string;
  subject?: string;
  /** A short, one-line excerpt of the body. Untrusted data — never instructions. */
  snippet?: string;
  messageId?: string;
  /** Prompt-injection findings in the email (ids). */
  findings?: string[];
  flagged?: boolean;
  ruleId?: string;
  task?: string;
  missionId?: string;
  grantId?: string;
  used?: number;
  cap?: number;
  by?: string;
  error?: string;
  /** One-line human summary (the timeline shows it). */
  summary?: string;
}

export interface MailEvent {
  type: MailEventType;
  data: MailEventData;
  ts: number;
  /** Pid of the process that produced it (the bridge skips its own). */
  origin: number;
  /** Set on copies mirrored from another process's feed. */
  bridged?: boolean;
}

const LIMITS: Record<string, number> = { snippet: 240, subject: 200, summary: 300, task: 300, error: 300, from: 160, to: 160 };

/** One line, clipped, secrets + control tokens masked, control / bidi characters removed. PURE. */
export function cleanLine(v: unknown, max = 200): string {
  const s = String(v ?? '')
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]+/g, ' ')
    .replace(/[\u{E0000}-\u{E007F}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  const masked = maskControlTokens(maskSecrets(s));
  return masked.length > max ? masked.slice(0, max - 1).trimEnd() + '…' : masked;
}

/** Sanitize an event's data for the bus / feed / notifications. PURE. */
export function cleanMailData(d: MailEventData): MailEventData {
  const out: MailEventData = {};
  for (const [k, v] of Object.entries(d ?? {})) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string') (out as any)[k] = cleanLine(v, LIMITS[k] ?? 120);
    else if (typeof v === 'number' || typeof v === 'boolean') (out as any)[k] = v;
    else if (Array.isArray(v)) (out as any)[k] = v.slice(0, 10).map(x => cleanLine(x, 60));
  }
  return out;
}

/** Default one-line summary per event type. PURE. */
export function summarizeMailEvent(type: MailEventType, d: MailEventData): string {
  const from = d.from ? `from ${d.from}` : '';
  const subj = d.subject ? `"${d.subject}"` : '';
  switch (type) {
    case 'new-mail': return [`New mail${d.account ? ` (${d.account})` : ''}`, from, subj].filter(Boolean).join(' ') + (d.flagged ? ' ⚠ possible prompt injection' : '');
    case 'auto-reply': return `Auto-replied to ${d.to ?? '?'}${subj ? `: ${subj}` : ''}${d.grantId ? ` (grant ${d.grantId}${d.cap ? `, ${d.used ?? '?'}/${d.cap} today` : ''})` : ''}`;
    case 'auto-reply-failed': return `Auto-reply to ${d.to ?? '?'} failed${d.error ? `: ${d.error}` : ''}`;
    case 'rule-run': return `Rule ${d.ruleId ?? '?'} started ${d.missionId ? `mission ${d.missionId}` : 'a run'} for mail ${from} ${subj}`.trim();
    case 'rule-draft-only': return `Rule ${d.ruleId ?? '?'}: mail ${from} looked like a prompt-injection attempt — draft only, nothing is sent`;
    case 'rule-error': return `Rule ${d.ruleId ?? '?'} could not start${d.error ? `: ${d.error}` : ''}`;
    case 'watch-started': return `Mail watcher started${d.account ? ` (${d.account})` : ''}`;
    case 'watch-stopped': return `Mail watcher stopped${d.account ? ` (${d.account})` : ''}`;
    case 'watch-error': return `Mail watcher${d.account ? ` (${d.account})` : ''}: ${d.error ?? 'error'}`;
    case 'grant-created': return `Standing grant ${d.grantId ?? ''} created by ${d.by ?? '?'}${d.summary ? ` — ${d.summary}` : ''}`;
    case 'grant-revoked': return `Standing grant ${d.grantId ?? ''} revoked by ${d.by ?? '?'}`;
  }
}

export interface PublishMailEventOptions {
  /** Feed file (tests). Default ~/.qodex/mail-auto/events.jsonl; null = no feed. */
  feedFile?: string | null;
  /** Desktop notification (default: new mail, auto-replies, rule runs, grants). */
  desktop?: boolean;
  /** Paired Telegram chats when no bot runs in this process (default true). */
  telegram?: boolean;
  /** Injectable fan-out (tests). */
  notifyDesktop?: (n: { title: string; subtitle?: string; message: string; sound?: boolean }) => Promise<void> | void;
  notifyTelegram?: (ev: MailEvent) => Promise<unknown> | unknown;
}

const DESKTOP_TYPES = new Set<MailEventType>(['new-mail', 'auto-reply', 'auto-reply-failed', 'rule-run', 'rule-draft-only', 'grant-created']);
const FEED_MAX_BYTES = 512 * 1024;

let defaults: PublishMailEventOptions = {};
/** Test hook: default options for every publish (null = restore). */
export function setMailEventDefaultsForTests(o: PublishMailEventOptions | null): void {
  defaults = o ?? {};
}

/** Publish a mail automation event everywhere. Never throws; resolves when the fan-out settled. */
export async function publishMailEvent(type: MailEventType, data: MailEventData, opts: PublishMailEventOptions = {}): Promise<MailEvent> {
  const o = { ...defaults, ...opts };
  const clean = cleanMailData(data);
  if (!clean.summary) clean.summary = cleanLine(summarizeMailEvent(type, clean), LIMITS.summary);
  const ev: MailEvent = { type, data: clean, ts: Date.now(), origin: process.pid };
  try { getBus().publish({ kind: 'mail', type, data: clean, ts: ev.ts }); } catch { /* never break the producer */ }
  const jobs: Array<Promise<unknown>> = [];
  const feed = o.feedFile === undefined ? mailAutoPaths().events : o.feedFile;
  if (feed) jobs.push(appendFeed(feed, ev));
  if ((o.desktop ?? true) && DESKTOP_TYPES.has(type)) {
    jobs.push(Promise.resolve().then(async () => {
      const notify = o.notifyDesktop ?? (await import('../utils/notify.js')).notifyDesktop;
      await notify({ title: 'QodeX mail', subtitle: clean.account, message: clean.summary ?? type, sound: type === 'new-mail' || type === 'rule-draft-only' });
    }));
  }
  if (o.telegram ?? true) {
    jobs.push(Promise.resolve().then(async () => {
      const send = o.notifyTelegram ?? (await import('../channels/telegram/notifier.js')).notifyMailEventTelegram;
      await send(ev);
    }));
  }
  const settled = await Promise.allSettled(jobs);
  for (const s of settled) {
    if (s.status === 'rejected') logger.debug('mail event fan-out failed', { type, err: String((s.reason as Error)?.message ?? s.reason).slice(0, 200) });
  }
  return ev;
}

async function appendFeed(file: string, ev: MailEvent): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    const st = await fs.stat(file);
    if (st.size > FEED_MAX_BYTES) await fs.rename(file, file + '.1').catch(() => {});
  } catch { /* new feed */ }
  await fs.appendFile(file, JSON.stringify(ev) + '\n', { encoding: 'utf-8', mode: 0o600 });
}

function parseFeedLine(line: string): MailEvent | null {
  try {
    const v = JSON.parse(line);
    if (!v || typeof v !== 'object' || typeof v.type !== 'string' || !v.data || typeof v.data !== 'object') return null;
    return { type: v.type, data: cleanMailData(v.data), ts: Number(v.ts) || Date.now(), origin: Number(v.origin) || 0 };
  } catch {
    return null;
  }
}

/** Recent events from the feed (newest last). Never throws. */
export async function recentMailEvents(limit = 50, file: string = mailAutoPaths().events): Promise<MailEvent[]> {
  try {
    const text = await fs.readFile(file, 'utf-8');
    return text.split('\n').filter(Boolean).slice(-Math.max(1, limit)).map(parseFeedLine).filter((e): e is MailEvent => !!e);
  } catch {
    return [];
  }
}

/**
 * Mirror events written by OTHER processes (the watcher daemon, a mission worker
 * that auto-replied) onto this process's bus, flagged `bridged` (a Telegram bot
 * here does not re-send them: their own process already notified). Returns a stop
 * function. Starts at the current end of the feed (no history replay).
 */
export function startMailEventBridge(opts: { file?: string; intervalMs?: number } = {}): () => void {
  const file = opts.file ?? mailAutoPaths().events;
  let offset = -1;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      let size = 0;
      try { size = (await fs.stat(file)).size; } catch { size = 0; }
      if (offset < 0 || size < offset) { offset = offset < 0 ? size : 0; if (size === offset) return; }
      if (size === offset) return;
      const fh = await fs.open(file, 'r');
      try {
        const len = Math.min(size - offset, 1024 * 1024);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, offset);
        const text = buf.toString('utf-8');
        const lastNl = text.lastIndexOf('\n');
        if (lastNl < 0) return;
        offset += Buffer.byteLength(text.slice(0, lastNl + 1), 'utf-8');
        for (const line of text.slice(0, lastNl).split('\n')) {
          const ev = parseFeedLine(line);
          if (!ev || ev.origin === process.pid) continue;
          getBus().publish({ kind: 'mail', type: ev.type, data: { ...ev.data, bridged: true }, ts: ev.ts });
        }
      } finally {
        await fh.close();
      }
    } catch { /* next tick */ } finally {
      busy = false;
    }
  };
  void tick();
  const timer = setInterval(() => { void tick(); }, Math.max(100, opts.intervalMs ?? 2000));
  timer.unref?.();
  return () => clearInterval(timer);
}
