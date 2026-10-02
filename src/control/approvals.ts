/**
 * ApprovalBroker — one place where "the agent needs a human decision" is routed
 * to every place a human might answer it: the terminal UI, the web control
 * center, Telegram, or a detached mission's DB queue. The first answer wins and
 * the other channels are told to retract their prompt.
 *
 * Why this exists:
 *   - The TUI's askUser has a single pending-prompt slot; concurrent prompts
 *     (parallel tools, sub-agents, missions) clobbered each other. The broker
 *     serializes LOCAL prompts through a FIFO.
 *   - Unattended runs (`--yes`, schedules, missions) used to auto-answer every
 *     prompt. Sentinel-critical actions must instead wait for a real human on a
 *     remote channel, or be refused.
 *
 * Answers are normalized against the request's options (exact, then
 * case-insensitive, then yes/no synonyms, then unique first letter), so a
 * Telegram button "✅ yes" or a web POST {answer:"approve"} resolve correctly.
 */

import { randomBytes } from 'crypto';
import { getBus } from './bus.js';

export interface ApprovalRequest {
  prompt: string;
  /** Options shown to the human. Convention: include one 'y*' and one 'n*' option. */
  options: string[];
  /** Who is asking (tool name, mission id, ...). */
  source?: string;
  /** Sentinel category (purchase, send, credential, ...). */
  category?: string;
  risk?: 'low' | 'medium' | 'high' | 'critical';
  meta?: Record<string, unknown>;
  /** Give up after this long and answer with the safe (deny) option. 0/undefined = wait forever. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface PendingApproval extends ApprovalRequest {
  id: string;
  createdAt: number;
}

export interface ApprovalResult {
  answer: string;
  /** Channel that answered: 'local', 'control', 'telegram', 'timeout', 'abort', 'fallback', ... */
  by: string;
}

export interface ApprovalChannel {
  name: string;
  /** Show the prompt to a human. Must not throw for transport errors (log instead). */
  deliver(p: PendingApproval): void | Promise<void>;
  /** The approval was answered elsewhere / timed out — remove it from this channel's UI. */
  retract?(id: string, result: ApprovalResult): void | Promise<void>;
}

/** A local (in-process, e.g. terminal) asker. It gets an AbortSignal so it can
 *  dismiss its prompt when another channel answers first. */
export type LocalAsker = (prompt: string, options: string[], signal: AbortSignal) => Promise<string>;

const YES_WORDS = ['yes', 'y', 'approve', 'approved', 'allow', 'ok', 'accept', 'confirm', 'بله', 'آره', 'تایید', 'تأیید', 'باشه', 'اوکی'];
const NO_WORDS = ['no', 'n', 'deny', 'denied', 'reject', 'cancel', 'block', 'stop', 'نه', 'خیر', 'رد', 'لغو'];

/** Map a free-form answer onto one of `options`. Returns null if it can't. PURE. */
export function normalizeAnswer(answer: string, options: string[]): string | null {
  if (!options.length) return answer;
  const raw = String(answer ?? '').trim();
  if (!raw) return null;
  if (options.includes(raw)) return raw;
  const lower = raw.toLowerCase().replace(/^[^\p{L}\p{N}]+/u, '').trim();
  const ci = options.find(o => o.toLowerCase() === lower);
  if (ci) return ci;
  if (YES_WORDS.includes(lower)) {
    const y = options.find(o => /^(y|approve|allow|accept|confirm)/i.test(o));
    if (y) return y;
  }
  if (NO_WORDS.includes(lower)) {
    const n = safeOption(options);
    if (n) return n;
  }
  const byLetter = options.filter(o => o.toLowerCase().startsWith(lower[0] ?? '\u0000'));
  if (lower.length === 1 && byLetter.length === 1) return byLetter[0];
  const prefix = options.filter(o => o.toLowerCase().startsWith(lower));
  if (prefix.length === 1) return prefix[0];
  return null;
}

/** The option that means "don't do it": first 'n*'/deny/reject/cancel option, else null. PURE. */
export function safeOption(options: string[]): string | null {
  return options.find(o => /^(n|deny|reject|cancel|block|skip|stop)/i.test(o.trim())) ?? null;
}

/** True when `answer` is an approving answer for `options`. PURE. */
export function isApproval(answer: string, options: string[]): boolean {
  const n = normalizeAnswer(answer, options) ?? answer;
  if (n === safeOption(options)) return false;
  return /^(y|approve|allow|accept|confirm|always|a\b)/i.test(n.trim()) || YES_WORDS.includes(n.trim().toLowerCase());
}

function newId(): string {
  return 'ap_' + randomBytes(6).toString('base64url');
}

interface Entry {
  p: PendingApproval;
  resolve: (r: ApprovalResult) => void;
  done: boolean;
  localAbort?: AbortController;
  timer?: NodeJS.Timeout;
}

export class ApprovalBroker {
  private channels = new Map<string, ApprovalChannel>();
  private entries = new Map<string, Entry>();
  /** FIFO for local prompts so only one terminal prompt is shown at a time. */
  private localChain: Promise<unknown> = Promise.resolve();

  registerChannel(ch: ApprovalChannel): () => void {
    this.channels.set(ch.name, ch);
    // Late-joining channel sees what is already pending.
    for (const e of this.entries.values()) {
      if (!e.done) void Promise.resolve().then(() => ch.deliver(e.p)).catch(() => {});
    }
    return () => { if (this.channels.get(ch.name) === ch) this.channels.delete(ch.name); };
  }

  channelNames(): string[] {
    return [...this.channels.keys()];
  }

  /** A remote human channel (control center, Telegram, mission queue) is attached. */
  hasRemoteChannel(): boolean {
    return this.channels.size > 0;
  }

  pending(): PendingApproval[] {
    return [...this.entries.values()].filter(e => !e.done).map(e => e.p);
  }

  get(id: string): PendingApproval | undefined {
    const e = this.entries.get(id);
    return e && !e.done ? e.p : undefined;
  }

  /**
   * Ask a human. Delivered to every registered channel and (if given) the local
   * asker; first valid answer wins. Never rejects: timeouts/aborts resolve with
   * the safe option (or 'no').
   */
  request(req: ApprovalRequest, local?: LocalAsker): Promise<ApprovalResult> {
    const p: PendingApproval = { ...req, options: req.options?.length ? req.options : ['yes', 'no'], id: newId(), createdAt: Date.now() };
    const fallbackAnswer = safeOption(p.options) ?? 'no';

    return new Promise<ApprovalResult>((resolve) => {
      const entry: Entry = { p, resolve, done: false };
      this.entries.set(p.id, entry);

      getBus().publish({
        kind: 'approval.requested', id: p.id, prompt: p.prompt, options: p.options,
        source: p.source, category: p.category, risk: p.risk, meta: p.meta,
      });

      for (const ch of this.channels.values()) {
        void Promise.resolve().then(() => ch.deliver(p)).catch(() => {});
      }

      if (req.timeoutMs && req.timeoutMs > 0) {
        entry.timer = setTimeout(() => this.finish(p.id, { answer: fallbackAnswer, by: 'timeout' }), req.timeoutMs);
        entry.timer.unref?.();
      }
      if (req.signal) {
        if (req.signal.aborted) { this.finish(p.id, { answer: fallbackAnswer, by: 'abort' }); return; }
        req.signal.addEventListener('abort', () => this.finish(p.id, { answer: fallbackAnswer, by: 'abort' }), { once: true });
      }

      if (local) {
        const ac = new AbortController();
        entry.localAbort = ac;
        this.localChain = this.localChain.then(async () => {
          if (entry.done) return;
          try {
            const a = await local(p.prompt, p.options, ac.signal);
            if (!ac.signal.aborted) this.resolve(p.id, a, 'local');
          } catch {
            if (!ac.signal.aborted) this.finish(p.id, { answer: fallbackAnswer, by: 'local-error' });
          }
        });
      } else if (this.channels.size === 0 && !(req.timeoutMs && req.timeoutMs > 0)) {
        // Nobody can ever answer: fail safe immediately instead of hanging forever.
        this.finish(p.id, { answer: fallbackAnswer, by: 'fallback' });
      }
    });
  }

  /** Answer a pending approval from any channel. Returns false if unknown/already answered
   *  or the answer can't be mapped to an option. */
  resolve(id: string, answer: string, by: string): boolean {
    const e = this.entries.get(id);
    if (!e || e.done) return false;
    const norm = normalizeAnswer(answer, e.p.options);
    if (norm === null) return false;
    this.finish(id, { answer: norm, by });
    return true;
  }

  private finish(id: string, result: ApprovalResult): void {
    const e = this.entries.get(id);
    if (!e || e.done) return;
    e.done = true;
    if (e.timer) clearTimeout(e.timer);
    e.localAbort?.abort();
    this.entries.delete(id);
    getBus().publish({ kind: 'approval.resolved', id, answer: result.answer, by: result.by });
    for (const ch of this.channels.values()) {
      void Promise.resolve().then(() => ch.retract?.(id, result)).catch(() => {});
    }
    e.resolve(result);
  }

  /** Test helper. */
  reset(): void {
    for (const id of [...this.entries.keys()]) this.finish(id, { answer: 'no', by: 'reset' });
    this.channels.clear();
    this.localChain = Promise.resolve();
  }
}

let broker: ApprovalBroker | null = null;

/**
 * Whether a human is sitting at THIS process's local asker (the interactive TUI).
 * Headless `--print`, scheduled runs and detached missions leave it false: their
 * askUser auto-answers, so Sentinel-critical actions must go to a remote channel
 * (control center / Telegram) or be refused.
 */
let interactiveHuman = false;
export function setInteractiveHuman(v: boolean): void { interactiveHuman = v; }
export function isInteractiveHuman(): boolean { return interactiveHuman; }

export function getApprovalBroker(): ApprovalBroker {
  if (!broker) broker = new ApprovalBroker();
  return broker;
}

/**
 * Wrap an existing askUser(prompt, options) so it goes through the broker.
 * `local` is the original asker (terminal prompt) or undefined for unattended runs.
 * The returned function has the exact ToolContext.askUser signature.
 */
export function brokeredAskUser(
  local: ((prompt: string, options?: string[]) => Promise<string>) | undefined,
  defaults: Partial<ApprovalRequest> = {},
): (prompt: string, options?: string[]) => Promise<string> {
  const b = getApprovalBroker();
  const localAsker: LocalAsker | undefined = local
    ? (prompt, options) => local(prompt, options)
    : undefined;
  return async (prompt: string, options: string[] = ['yes', 'no']) => {
    const r = await b.request({ ...defaults, prompt, options }, localAsker);
    return r.answer;
  };
}
