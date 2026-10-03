/**
 * TelegramBot — QodeX's remote channel: approve Sentinel prompts, start/cancel
 * missions, check status and see the agent's browser from your phone.
 *
 * Moving parts:
 *   - Long-polling loop over `getUpdates` with exponential backoff (+ jitter)
 *     on network/5xx/409/429 errors; a rejected token stops the bot. Stopped by
 *     an AbortSignal or `stop()`.
 *   - Pairing gate: only chats paired via a one-time code (pairing.ts) may use
 *     commands. Unpaired chats can only `/start` (explains pairing) and
 *     `/pair <code>`. Pairing is private-chat only. Replies to unpaired chats
 *     are budgeted (per chat and overall) so strangers can't drive the bot into
 *     Telegram's rate limit and delay the owner's approvals.
 *   - ApprovalChannel 'telegram' on the process-wide ApprovalBroker: deliver →
 *     a card with one inline button per option (`ap:<id>:<index>`) to every
 *     paired chat; retract → the card is edited to show the outcome. The
 *     channel is registered ONLY while at least one chat is paired, so an
 *     unpaired bot never makes unattended runs wait for a human who can't answer.
 *     An approval id is reserved synchronously on delivery (an instant answer
 *     never leaves a dangling card; a broker approval mirrored into the mission
 *     DB under the same id gets one card), cards that could not be sent are
 *     retried on the tick, and a late/double tap shows the real outcome.
 *   - Mission-DB approvals (detached mission workers in other processes) via
 *     the injected `TelegramMissionAdapter`: polled every 3s, delivered the same
 *     way, resolved through the adapter.
 *   - Notifications: mission milestone/completed/failed/cancelled/paused and
 *     Sentinel blocks → paired chats, rate-limited (terminal events bypass the
 *     limit). Source = the adapter's `eventsSince` when provided (covers
 *     detached missions), else the in-process bus.
 *
 * All dynamic text is HTML-escaped (format.ts) and localized (fa/en). The bot
 * token never appears in logs (api.ts redacts every error).
 */

import {
  TelegramApi, TelegramApiError, TelegramAbortError,
  type TgUpdate, type TgMessage, type TgCallbackQuery, type TgUser, type InlineKeyboardMarkup,
} from './api.js';
import { TelegramPairingStore, type PairedChat } from './pairing.js';
import * as F from './format.js';
import {
  getApprovalBroker, normalizeAnswer,
  type ApprovalBroker, type ApprovalChannel, type ApprovalResult, type PendingApproval,
} from '../../control/approvals.js';
import { getBus, type AgentBus, type BusEvent } from '../../control/bus.js';
import { peekBrowserManager, type BrowserManager } from '../../tools/browser/types.js';
import { logger } from '../../utils/logger.js';

// ── mission adapter contract (wired by the integration to the missions module) ──

export interface TelegramMissionSummary {
  id: string;
  goal: string;
  /** planning | running | paused | awaiting_approval | completed | failed | cancelled */
  status: string;
  /** Short progress text, e.g. "2/5 steps". */
  progress?: string;
  liveUrl?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface TelegramMissionStatus extends TelegramMissionSummary {
  steps?: Array<{ title: string; status: string }>;
  /** Latest milestone titles, oldest first. */
  milestones?: string[];
  pendingApprovals?: number;
  report?: string;
  error?: string;
  costUsd?: number;
}

export interface TelegramMissionApproval {
  id: string;
  missionId: string;
  prompt: string;
  options: string[];
  category?: string;
  risk?: string;
}

export interface TelegramMissionEvent {
  /** Monotonic event id (mission_events.id). */
  id: number;
  missionId: string;
  type: string;
  data?: unknown;
  ts?: number;
}

export interface TelegramMissionAdapter {
  /** Recent missions, newest first. */
  list(limit?: number): Promise<TelegramMissionSummary[]>;
  /** Create a mission and start its detached worker. */
  start(goal: string): Promise<{ id: string; status?: string }>;
  /** Request cancellation. False when unknown / already finished. */
  cancel(id: string): Promise<boolean>;
  /** Full status, or null when the id is unknown. */
  status(id: string): Promise<TelegramMissionStatus | null>;
  /** Pending approvals across all missions (mission_approvals rows). */
  pendingApprovals(): Promise<TelegramMissionApproval[]>;
  /** Resolve a mission approval. `by` = 'telegram:@user'. False when no longer pending. */
  resolveApproval(id: string, answer: string, by: string): Promise<boolean>;
  /**
   * OPTIONAL: mission events (all missions) with id > afterId, oldest first, plus
   * the new cursor. `afterId === null` → return no events, only the current
   * cursor (so a fresh bot doesn't replay history). When provided, notifications
   * come from here (covers detached workers) instead of the in-process bus.
   */
  eventsSince?(afterId: number | null): Promise<{ events: TelegramMissionEvent[]; cursor: number }>;
}

// ── options ──────────────────────────────────────────────────────────────────

export interface TelegramBotOptions {
  api: TelegramApi;
  pairing: TelegramPairingStore;
  missions?: TelegramMissionAdapter | null;
  /** Default: the process-wide broker. */
  broker?: ApprovalBroker;
  /** Default: the process-wide bus. */
  bus?: AgentBus;
  /** Browser accessor. Default `peekBrowserManager` (never launches a browser). */
  browser?: () => BrowserManager | null;
  /** Push milestone / Sentinel notifications (config telegram.notify). Default true. */
  notify?: boolean;
  /** getUpdates long-poll timeout (s). Default 25. */
  pollTimeoutSec?: number;
  /** Mission approvals/events + pairing refresh interval (ms). Default 3000. */
  tickMs?: number;
  /** Ignore commands older than this before the bot started (s). Default 120. */
  staleMessageSec?: number;
  /** Notification budget. Default 12 per 60s. */
  notifyRateLimit?: { max: number; windowMs: number };
  /** /screen gives up after this long (a busy page can stall a screenshot). Default 15s. */
  screenshotTimeoutMs?: number;
  backoff?: { initialMs?: number; maxMs?: number; conflictMinMs?: number };
  /** Injectable for tests. Must resolve (not reject) early when the signal aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

interface DeliveredApproval {
  id: string;
  source: 'broker' | 'mission';
  card: F.ApprovalCardInput;
  options: string[];
  messages: Array<{ chatId: number; messageId: number; lang: F.Lang }>;
  ready: Promise<void>;
  createdAt: number;
}

type FoundApproval = { source: 'broker' | 'mission'; options: string[]; card: F.ApprovalCardInput };

/** Parse `/cmd@bot args`. Returns null for non-commands or commands addressed to another bot. PURE. */
export function parseCommand(text: string, botUsername?: string): { cmd: string; args: string } | null {
  const m = /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]{3,64}))?(?:\s+([\s\S]*))?$/.exec(String(text ?? '').trim());
  if (!m) return null;
  if (m[2] && botUsername && m[2].toLowerCase() !== botUsername.toLowerCase()) return null;
  return { cmd: m[1].toLowerCase(), args: (m[3] ?? '').trim() };
}

/** Sliding-window limiter. PURE apart from internal state. */
export class NotificationLimiter {
  private stamps: number[] = [];
  constructor(private readonly max: number, private readonly windowMs: number) {}
  /** Consume a slot if available. */
  take(now: number): boolean {
    this.stamps = this.stamps.filter((t) => now - t < this.windowMs);
    if (this.stamps.length >= this.max) return false;
    this.stamps.push(now);
    return true;
  }
  /** Count an event that bypassed the limit. */
  record(now: number): void {
    this.stamps = this.stamps.filter((t) => now - t < this.windowMs);
    this.stamps.push(now);
  }
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal?.removeEventListener('abort', done); resolve(); }
    signal?.addEventListener('abort', done, { once: true });
  });

const MAX_DELIVERED = 500;
const MAX_HANDLED = 2000;
const MAX_OUTCOMES = 200;
/** Replies to one unpaired chat: at most this many per window (a stranger can't make the bot spam). */
const UNPAIRED_REPLIES_PER_CHAT = 5;
const UNPAIRED_WINDOW_MS = 10 * 60_000;
/** Replies to ALL unpaired chats per minute (a crowd of strangers can't exhaust Telegram's rate limit). */
const UNPAIRED_REPLIES_PER_MINUTE = 20;
/** A repeated state notice for the same mission within this window is a duplicate. */
const NOTICE_DEDUPE_MS = 60_000;

type AnswerOutcome = 'ok' | 'gone' | 'error';

/** Reject with `message` when `p` takes longer than `ms` (p's own outcome is still observed). */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    t.unref?.();
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

export class TelegramBot {
  readonly api: TelegramApi;
  readonly pairing: TelegramPairingStore;
  private readonly missions: TelegramMissionAdapter | null;
  private readonly broker: ApprovalBroker;
  private readonly bus: AgentBus;
  private readonly browserMgr: () => BrowserManager | null;
  private readonly notifyEnabled: boolean;
  private readonly pollTimeoutSec: number;
  private readonly tickMs: number;
  private readonly staleMs: number;
  private readonly limiter: NotificationLimiter;
  private readonly screenshotTimeoutMs: number;
  private readonly backoffInitialMs: number;
  private readonly backoffMaxMs: number;
  private readonly conflictMinMs: number;
  private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly logFn: (level: 'info' | 'warn' | 'error', message: string) => void;

  private me: TgUser | null = null;
  private offset: number | undefined;
  private controller: AbortController | null = null;
  private loopDone: Promise<void> | null = null;
  private startedAt = 0;
  private running = false;
  private tickTimer: NodeJS.Timeout | null = null;
  private ticking = false;
  private busUnsub: (() => void) | null = null;
  private channelUnregister: (() => void) | null = null;

  private delivered = new Map<string, DeliveredApproval>();
  private aliasToId = new Map<string, string>();
  private idToAlias = new Map<string, string>();
  private aliasSeq = 0;
  private handledMission = new Set<string>();
  /** Mission approvals whose answer is being written right now (the tick must not retract them). */
  private answering = new Set<string>();
  private missionCursor: number | null = null;
  private suppressed = 0;
  private lastHint = new Map<number, number>();
  /** Recent reply times per unpaired chat + a global budget for all of them. */
  private unpairedReplies = new Map<number, number[]>();
  private readonly unpairedLimiter = new NotificationLimiter(UNPAIRED_REPLIES_PER_MINUTE, 60_000);
  /** How recently resolved approvals ended — a late/double tap shows this instead of "expired". */
  private outcomes = new Map<string, { card: F.ApprovalCardInput; options: string[]; result: ApprovalResult | null }>();
  /** `${missionId}:${state}` → when it was announced. */
  private recentNotices = new Map<string, number>();
  private lastTickError: { message: string; at: number } | null = null;
  private conflictWarned = false;
  private notifyChain: Promise<void> = Promise.resolve();

  private readonly channel: ApprovalChannel;

  constructor(opts: TelegramBotOptions) {
    this.api = opts.api;
    this.pairing = opts.pairing;
    this.missions = opts.missions ?? null;
    this.broker = opts.broker ?? getApprovalBroker();
    this.bus = opts.bus ?? getBus();
    this.browserMgr = opts.browser ?? peekBrowserManager;
    this.notifyEnabled = opts.notify ?? true;
    this.pollTimeoutSec = opts.pollTimeoutSec ?? 25;
    this.tickMs = opts.tickMs ?? 3000;
    this.staleMs = (opts.staleMessageSec ?? 120) * 1000;
    this.limiter = new NotificationLimiter(opts.notifyRateLimit?.max ?? 12, opts.notifyRateLimit?.windowMs ?? 60_000);
    this.screenshotTimeoutMs = opts.screenshotTimeoutMs ?? 15_000;
    this.backoffInitialMs = opts.backoff?.initialMs ?? 1000;
    this.backoffMaxMs = opts.backoff?.maxMs ?? 60_000;
    this.conflictMinMs = opts.backoff?.conflictMinMs ?? 5000;
    this.sleepFn = opts.sleep ?? defaultSleep;
    this.random = opts.random ?? Math.random;
    this.now = opts.now ?? Date.now;
    this.logFn = opts.log ?? ((level, message) => logger[level](message));

    this.channel = {
      name: 'telegram',
      deliver: (p) => this.deliverBrokerApproval(p),
      retract: (id, result) => this.retractApproval(id, result),
    };
  }

  /** The bot's own account (after start). */
  get botUser(): TgUser | null { return this.me; }
  isRunning(): boolean { return this.running; }

  /**
   * Verify the token (getMe), attach to the broker/bus and start polling in the
   * background. Resolves with the bot account once polling has begun; `done()`
   * settles when polling stops (rejects on a fatal error such as a revoked token).
   */
  async start(signal?: AbortSignal): Promise<TgUser> {
    if (this.running || this.controller) throw new Error('[TELEGRAM_ALREADY_RUNNING] This bot is already running.');
    const ac = new AbortController();
    this.controller = ac;
    if (signal) {
      if (signal.aborted) ac.abort();
      else signal.addEventListener('abort', () => ac.abort(), { once: true });
    }
    try {
      this.me = await this.api.getMe(ac.signal);
    } catch (err) {
      this.controller = null;
      throw err;
    }
    // Message dates are Telegram's clock: measure staleness against it (from the
    // HTTP Date header), so a local clock running ahead doesn't drop fresh commands.
    this.startedAt = this.api.serverNow() ?? this.now();
    this.running = true;
    this.busUnsub = this.bus.subscribe((ev) => this.onBusEvent(ev));
    await this.tick();
    this.tickTimer = setInterval(() => { void this.tick(); }, this.tickMs);
    this.tickTimer.unref?.();
    this.loopDone = this.pollLoop(ac.signal).finally(() => this.cleanup());
    this.loopDone.catch(() => { /* surfaced via done() */ });
    this.log('info', `Telegram bot @${this.me.username ?? this.me.id} started`);
    return this.me;
  }

  /** Settles when polling stops. Rejects on fatal errors (e.g. revoked token). */
  done(): Promise<void> {
    return this.loopDone ?? Promise.resolve();
  }

  /** Start and wait until stopped. */
  async run(signal?: AbortSignal): Promise<void> {
    await this.start(signal);
    return this.done();
  }

  /** Stop polling and detach from the broker/bus. Idempotent. */
  async stop(): Promise<void> {
    this.controller?.abort();
    await this.loopDone?.catch(() => {});
  }

  // ── polling ────────────────────────────────────────────────────────────────

  private async pollLoop(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      let updates: TgUpdate[];
      try {
        updates = await this.api.getUpdates({
          offset: this.offset,
          timeout: this.pollTimeoutSec,
          allowedUpdates: ['message', 'callback_query'],
          signal,
        });
        if (failures > 0) this.log('info', 'Telegram polling recovered');
        failures = 0;
        this.conflictWarned = false;
      } catch (err) {
        if (signal.aborted || err instanceof TelegramAbortError) break;
        if (err instanceof TelegramApiError && err.isUnauthorized) {
          const msg = `[TELEGRAM_UNAUTHORIZED] Telegram rejected the bot token (${err.description}). Run \`qodex telegram setup\` again.`;
          this.bus.publish({ kind: 'notice', level: 'error', message: msg });
          throw new Error(msg);
        }
        failures++;
        const delay = this.backoffDelay(failures, err);
        if (err instanceof TelegramApiError && err.isConflict && !this.conflictWarned) {
          this.conflictWarned = true;
          const msg = 'Telegram: another process is polling this bot (or a webhook is set). Stop the other `qodex telegram start`, or start with --drop-webhook.';
          this.bus.publish({ kind: 'notice', level: 'warn', message: msg });
          this.log('warn', msg);
        }
        this.log('warn', `Telegram polling failed (${failures}): ${this.api.redact(errMsg(err))} — retrying in ${delay}ms`);
        await this.sleepFn(delay, signal);
        continue;
      }
      for (const u of updates) {
        if (typeof u?.update_id === 'number') this.offset = Math.max(this.offset ?? 0, u.update_id + 1);
        try {
          await this.handleUpdate(u);
        } catch (err) {
          this.log('error', `Telegram update ${u?.update_id} failed: ${this.api.redact(errMsg(err))}`);
        }
      }
    }
  }

  /** Exponential backoff with ±20% jitter; honors 429 retry_after; ≥ conflictMinMs on 409. */
  backoffDelay(attempt: number, err: unknown): number {
    if (err instanceof TelegramApiError && err.isRateLimited && err.retryAfterSec) {
      return Math.min(err.retryAfterSec * 1000, 300_000);
    }
    const base = Math.min(this.backoffMaxMs, this.backoffInitialMs * 2 ** Math.max(0, attempt - 1));
    let delay = Math.round(base + base * 0.2 * (this.random() * 2 - 1));
    if (err instanceof TelegramApiError && err.isConflict) delay = Math.max(delay, this.conflictMinMs);
    return Math.max(0, delay);
  }

  private async cleanup(): Promise<void> {
    this.running = false;
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
    this.busUnsub?.(); this.busUnsub = null;
    this.channelUnregister?.(); this.channelUnregister = null;
    // Confirm handled updates so a quick restart doesn't replay e.g. /mission.
    if (this.offset !== undefined) {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 3000);
      t.unref?.();
      try { await this.api.getUpdates({ offset: this.offset, timeout: 0, limit: 1, signal: ac.signal }); } catch { /* best effort */ }
      clearTimeout(t);
    }
    this.controller = null;
    this.log('info', 'Telegram bot stopped');
  }

  // ── updates ────────────────────────────────────────────────────────────────

  /** Process one update (used by the polling loop; public for tests/integration). */
  async handleUpdate(u: TgUpdate): Promise<void> {
    if (u.callback_query) return this.handleCallback(u.callback_query);
    if (u.message) return this.handleMessage(u.message);
  }

  private async handleMessage(msg: TgMessage): Promise<void> {
    const text = typeof msg.text === 'string' ? msg.text : '';
    if (!text || !msg.chat) return;
    if (msg.date && msg.date * 1000 < this.startedAt - this.staleMs) {
      this.log('info', `Telegram: ignored a stale message from chat ${msg.chat.id}`);
      return;
    }
    const chatId = msg.chat.id;
    const from = msg.from;
    const isPrivate = msg.chat.type === 'private' && from?.id === chatId;
    const cmd = parseCommand(text, this.me?.username);
    const chat = await this.pairing.getChat(chatId);
    if (!chat) return this.handleUnpaired(chatId, from, cmd, isPrivate);
    if (!isPrivate) return; // paired chats are private by construction; be defensive

    const lang = await this.refreshChat(chat, from);
    const S = F.strings(lang);

    if (!cmd) {
      const replyTo = msg.reply_to_message?.message_id;
      const entry = replyTo !== undefined ? this.findDeliveredByMessage(chatId, replyTo) : null;
      if (entry) return this.answerByText(entry, text, chat, lang);
      await this.send(chatId, S.plainText);
      return;
    }

    switch (cmd.cmd) {
      case 'start':
      case 'help':
        await this.send(chatId, S.help);
        return;
      case 'pair':
        await this.send(chatId, S.pairAlready);
        return;
      case 'status':
        return cmd.args ? this.cmdMissionStatus(chatId, cmd.args, lang) : this.cmdStatus(chatId, lang);
      case 'missions':
        return this.cmdMissions(chatId, lang);
      case 'mission':
        return this.cmdStartMission(chatId, cmd.args, lang);
      case 'cancel':
        return this.cmdCancel(chatId, cmd.args, lang);
      case 'screen':
      case 'screenshot':
        return this.cmdScreen(chatId, lang);
      case 'approvals':
        return this.cmdApprovals(chat, lang);
      case 'lang':
      case 'language':
        return this.cmdLang(chat, cmd.args, lang);
      case 'unpair':
        await this.pairing.unpair(chatId);
        await this.send(chatId, S.unpaired);
        this.bus.publish({ kind: 'notice', level: 'info', message: `Telegram: chat ${describeChat(chat)} unpaired itself` });
        await this.refreshChannel();
        return;
      default:
        await this.send(chatId, S.unknownCommand);
    }
  }

  private async handleUnpaired(chatId: number, from: TgUser | undefined, cmd: { cmd: string; args: string } | null, isPrivate: boolean): Promise<void> {
    const lang = F.langOf(from?.language_code);
    const S = F.strings(lang);
    if (!cmd) {
      if (isPrivate) await this.hint(chatId, S.notPaired);
      return;
    }
    const isPairing = cmd.cmd === 'pair' || cmd.cmd === 'start';
    if (!isPairing) {
      if (isPrivate) await this.hint(chatId, S.notPaired);
      return;
    }
    if (!isPrivate) {
      await this.hint(chatId, S.privateOnly);
      return;
    }
    // `/start 123456` comes from the t.me/<bot>?start=<code> deep link.
    const code = cmd.args;
    if (cmd.cmd === 'start' && !/^\s*[\d۰-۹٠-٩]{6}\s*$/.test(code)) {
      await this.replyUnpaired(chatId, S.startUnpaired);
      return;
    }
    if (!code) {
      await this.replyUnpaired(chatId, S.pairUsage);
      return;
    }
    const res = await this.pairing.consumeCode(code, {
      chatId,
      username: from?.username,
      firstName: from?.first_name,
      lang: from?.language_code,
    });
    if (res.ok) {
      // Register the approval channel BEFORE confirming: an approval raised right after
      // the user sees "Paired" must already reach this chat.
      await this.refreshChannel();
      await this.send(chatId, `${S.pairOk}\n\n${S.help}`);
      this.bus.publish({ kind: 'notice', level: 'info', message: `Telegram: chat ${describeChat(res.chat)} paired` });
      this.log('info', `Telegram: paired chat ${describeChat(res.chat)}`);
      return;
    }
    if (res.reason === 'locked') await this.hint(chatId, S.pairLocked);
    else if (res.reason === 'malformed') await this.replyUnpaired(chatId, S.pairUsage);
    else await this.replyUnpaired(chatId, S.pairInvalid);
    this.log('warn', `Telegram: rejected pairing attempt from chat ${chatId} (${res.reason})`);
  }

  /** At most one "you're not paired" hint per chat per 10 minutes (no spam amplification). */
  private async hint(chatId: number, text: string): Promise<void> {
    const now = this.now();
    const last = this.lastHint.get(chatId);
    if (last !== undefined && now - last < 10 * 60_000) return;
    this.lastHint.set(chatId, now);
    if (this.lastHint.size > 1000) this.lastHint.delete(this.lastHint.keys().next().value as number);
    await this.replyUnpaired(chatId, text);
  }

  /**
   * Reply to a chat that is NOT paired. Anyone can message a bot, so these
   * replies are budgeted per chat and overall, and never retried: a flood of
   * /start or /pair from strangers must not push the bot into Telegram's rate
   * limit (429 back-off stalls the update loop, delaying the owner's approvals).
   */
  private async replyUnpaired(chatId: number, text: string): Promise<void> {
    const now = this.now();
    const recent = (this.unpairedReplies.get(chatId) ?? []).filter((t) => now - t < UNPAIRED_WINDOW_MS);
    this.unpairedReplies.delete(chatId);
    if (recent.length >= UNPAIRED_REPLIES_PER_CHAT || !this.unpairedLimiter.take(now)) {
      if (recent.length) this.unpairedReplies.set(chatId, recent);
      return;
    }
    recent.push(now);
    this.unpairedReplies.set(chatId, recent);
    if (this.unpairedReplies.size > 1000) this.unpairedReplies.delete(this.unpairedReplies.keys().next().value as number);
    await this.send(chatId, text, { retry: false });
  }

  /** Keep username/language fresh; returns the chat's language. */
  private async refreshChat(chat: PairedChat, from: TgUser | undefined): Promise<F.Lang> {
    const patch: Partial<PairedChat> = {};
    if (from?.username && from.username !== chat.username) patch.username = from.username;
    if (!chat.langPinned && from?.language_code && from.language_code !== chat.lang) patch.lang = from.language_code;
    if (Object.keys(patch).length) {
      await this.pairing.updateChat(chat.chatId, patch).catch(() => {});
      Object.assign(chat, patch);
    }
    return F.langOf(chat.lang);
  }

  // ── commands ───────────────────────────────────────────────────────────────

  private async cmdStatus(chatId: number, lang: F.Lang): Promise<void> {
    const mgr = this.safeBrowser();
    let browser: F.BrowserStatusView | null = null;
    if (mgr && mgr.isRunning()) {
      try {
        const st = mgr.status();
        browser = {
          running: st.running, mode: st.mode, headless: st.headless, profile: st.profile,
          tabs: st.tabs.map((t) => ({ title: t.title, url: t.url, active: t.active })),
          takeover: st.takeover, takeoverBy: st.takeoverBy,
        };
      } catch { browser = null; }
    }
    let active: F.MissionSummaryView[] | null = null;
    // An in-process mission mirrors its broker approval into the DB under the same id: count it once.
    const pendingIds = new Set(this.broker.pending().map((p) => p.id));
    if (this.missions) {
      try {
        const list = await this.missions.list(50);
        active = list.filter((m) => F.ACTIVE_MISSION_STATUSES.has(m.status));
      } catch (err) {
        this.log('warn', `Telegram /status: missions.list failed: ${errMsg(err)}`);
      }
      try { for (const a of await this.missions.pendingApprovals()) pendingIds.add(a.id); } catch { /* ignore */ }
    }
    await this.send(chatId, F.formatStatus({
      botUsername: this.me?.username,
      browser,
      activeMissions: active,
      pendingApprovals: pendingIds.size,
    }, lang));
  }

  private async cmdMissionStatus(chatId: number, arg: string, lang: F.Lang): Promise<void> {
    const S = F.strings(lang);
    if (!this.missions) { await this.send(chatId, S.missionsUnavailable); return; }
    const r = await this.resolveMission(arg);
    if (r.kind === 'none') { await this.send(chatId, S.missionNotFound(arg)); return; }
    if (r.kind === 'ambiguous') { await this.send(chatId, S.missionAmbiguous(arg)); return; }
    const st = r.status ?? await this.missions.status(r.id).catch(() => null);
    if (!st) { await this.send(chatId, S.missionNotFound(arg)); return; }
    await this.send(chatId, F.formatMissionStatus(st, lang));
  }

  private async cmdMissions(chatId: number, lang: F.Lang): Promise<void> {
    const S = F.strings(lang);
    if (!this.missions) { await this.send(chatId, S.missionsUnavailable); return; }
    try {
      const list = await this.missions.list(10);
      await this.send(chatId, F.formatMissionList(list, lang));
    } catch (err) {
      await this.send(chatId, `❌ ${F.esc(errMsg(err), 400)}`);
    }
  }

  private async cmdStartMission(chatId: number, goal: string, lang: F.Lang): Promise<void> {
    const S = F.strings(lang);
    if (!this.missions) { await this.send(chatId, S.missionsUnavailable); return; }
    const g = goal.trim();
    if (!g) { await this.send(chatId, S.missionUsage); return; }
    try {
      const res = await this.missions.start(g);
      await this.send(chatId, S.missionStarted(res.id, g));
      this.log('info', `Telegram: chat ${chatId} started mission ${res.id}`);
    } catch (err) {
      await this.send(chatId, S.missionStartFailed(errMsg(err)));
    }
  }

  private async cmdCancel(chatId: number, arg: string, lang: F.Lang): Promise<void> {
    const S = F.strings(lang);
    if (!this.missions) { await this.send(chatId, S.missionsUnavailable); return; }
    const id = arg.trim().split(/\s+/)[0] ?? '';
    if (!id) {
      let extra = '';
      try {
        const active = (await this.missions.list(50)).filter((m) => F.ACTIVE_MISSION_STATUSES.has(m.status));
        if (active.length) extra = '\n\n' + active.slice(0, 10).map((m) => F.formatMissionLine(m, lang)).join('\n');
      } catch { /* ignore */ }
      await this.send(chatId, S.cancelUsage + extra);
      return;
    }
    const r = await this.resolveMission(id);
    if (r.kind === 'none') { await this.send(chatId, S.missionNotFound(id)); return; }
    if (r.kind === 'ambiguous') { await this.send(chatId, S.missionAmbiguous(id)); return; }
    let ok = false;
    try { ok = await this.missions.cancel(r.id); } catch (err) { this.log('warn', `Telegram /cancel failed: ${errMsg(err)}`); }
    await this.send(chatId, ok ? S.cancelOk(r.id) : S.cancelFailed(r.id));
  }

  /** Exact id, else a unique prefix among recent missions. */
  private async resolveMission(arg: string): Promise<{ kind: 'ok'; id: string; status?: TelegramMissionStatus } | { kind: 'none' } | { kind: 'ambiguous' }> {
    const id = arg.trim();
    if (!this.missions || !id) return { kind: 'none' };
    const exact = await this.missions.status(id).catch(() => null);
    if (exact) return { kind: 'ok', id: exact.id || id, status: exact };
    const list = await this.missions.list(200).catch(() => [] as TelegramMissionSummary[]);
    const matches = list.filter((m) => m.id.startsWith(id));
    if (matches.length === 1) return { kind: 'ok', id: matches[0].id };
    return matches.length > 1 ? { kind: 'ambiguous' } : { kind: 'none' };
  }

  private async cmdScreen(chatId: number, lang: F.Lang): Promise<void> {
    const S = F.strings(lang);
    const mgr = this.safeBrowser();
    if (!mgr || !mgr.isRunning()) { await this.send(chatId, S.screenNone); return; }
    try {
      // A page stuck in a script stalls page.screenshot for Playwright's 30s default,
      // and updates are handled in order — don't hold approval taps hostage that long.
      const secs = Math.round(this.screenshotTimeoutMs / 1000);
      const jpeg = await withTimeout(
        Promise.resolve().then(() => mgr.screenshotJpeg(70)),
        this.screenshotTimeoutMs,
        `[SCREENSHOT_TIMEOUT] The browser did not return a screenshot within ${secs || 1}s (the page may be busy).`,
      );
      let title = '';
      let url = '';
      try {
        const tab = mgr.status().tabs.find((t) => t.active);
        title = tab?.title ?? '';
        url = tab?.url ?? mgr.activeUrl();
      } catch { url = ''; }
      await this.withRetry(() => this.api.sendPhoto(chatId, jpeg, { caption: F.formatScreenCaption(title, url), filename: 'qodex-screen.jpg' }));
    } catch (err) {
      await this.send(chatId, S.screenFailed(this.api.redact(firstLine(errMsg(err)))));
    }
  }

  private async cmdApprovals(chat: PairedChat, lang: F.Lang): Promise<void> {
    const S = F.strings(lang);
    const brokerPending = this.broker.pending();
    let missionPending: TelegramMissionApproval[] = [];
    if (this.missions) {
      try { missionPending = await this.missions.pendingApprovals(); } catch (err) {
        this.log('warn', `Telegram /approvals: ${errMsg(err)}`);
      }
    }
    if (!brokerPending.length && !missionPending.length) { await this.send(chat.chatId, S.noApprovals); return; }
    // An in-process mission's approval is pending in the broker AND mirrored into
    // the mission DB under the same id — one card, answered through the broker.
    const seen = new Set<string>();
    for (const p of brokerPending) {
      seen.add(p.id);
      const entry = this.delivered.get(p.id) ?? this.createEntry(p.id, 'broker', brokerCard(p), p.options);
      await this.deliverTo(entry, [chat]);
    }
    for (const a of missionPending) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      const entry = this.delivered.get(a.id) ?? this.createEntry(a.id, 'mission', missionCard(a), a.options);
      await this.deliverTo(entry, [chat]);
    }
  }

  private async cmdLang(chat: PairedChat, arg: string, lang: F.Lang): Promise<void> {
    const a = arg.trim().toLowerCase();
    let next: F.Lang | null = null;
    if (/^(fa|farsi|persian|فارسی|پارسی)$/.test(a)) next = 'fa';
    else if (/^(en|english|انگلیسی)$/.test(a)) next = 'en';
    if (!next) { await this.send(chat.chatId, F.strings(lang).langUsage); return; }
    await this.pairing.updateChat(chat.chatId, { lang: next, langPinned: true });
    chat.lang = next;
    chat.langPinned = true;
    await this.send(chat.chatId, F.strings(next).langSet);
  }

  // ── approvals ──────────────────────────────────────────────────────────────

  private createEntry(id: string, source: 'broker' | 'mission', card: F.ApprovalCardInput, options: string[]): DeliveredApproval {
    const entry: DeliveredApproval = { id, source, card, options: [...options], messages: [], ready: Promise.resolve(), createdAt: this.now() };
    this.delivered.set(id, entry);
    if (this.delivered.size > MAX_DELIVERED) {
      const oldest = this.delivered.keys().next().value as string;
      this.delivered.delete(oldest);
      this.dropAlias(oldest);
    }
    return entry;
  }

  /** Send the approval card to `chats`; recorded on the entry for later retraction. */
  private deliverTo(entry: DeliveredApproval, chats: PairedChat[]): Promise<void> {
    const run = async () => {
      const cbId = this.callbackIdFor(entry.id);
      for (const chat of chats) {
        const lang = F.langOf(chat.lang);
        const msg = await this.send(chat.chatId, F.formatApprovalWithHint(entry.card, lang), {
          replyMarkup: F.approvalKeyboard(cbId, entry.options, lang),
        });
        if (msg) entry.messages.push({ chatId: chat.chatId, messageId: msg.message_id, lang });
      }
    };
    const prev = entry.ready;
    entry.ready = prev.then(run, run);
    return entry.ready;
  }

  /** ApprovalChannel.deliver — never throws. */
  private async deliverBrokerApproval(p: PendingApproval): Promise<void> {
    if (this.delivered.has(p.id)) return;
    // Reserve the id BEFORE the first await: retract() (an instant local answer,
    // an already-aborted request) and the mission-DB tick (an in-process mission
    // mirrors this approval under the same id) must both see it.
    const entry = this.createEntry(p.id, 'broker', brokerCard(p), p.options);
    try {
      const chats = await this.pairing.listChats();
      if (this.delivered.get(p.id) !== entry) return; // retracted meanwhile — nothing to show
      if (!chats.length || !this.broker.get(p.id)) {
        this.delivered.delete(p.id);
        this.dropAlias(p.id);
        return;
      }
      await this.deliverTo(entry, chats);
      if (!entry.messages.length && this.delivered.get(p.id) === entry) {
        // Nothing went out (Telegram unreachable): forget it so the next tick retries.
        this.delivered.delete(p.id);
        this.dropAlias(p.id);
      }
    } catch (err) {
      this.log('warn', `Telegram: delivering approval ${p.id} failed: ${this.api.redact(errMsg(err))}`);
    }
  }

  /** ApprovalChannel.retract (and mission approvals resolved elsewhere) — edit cards to show the outcome. */
  private async retractApproval(id: string, result: ApprovalResult | null): Promise<void> {
    const entry = this.delivered.get(id);
    if (!entry) return;
    this.delivered.delete(id);
    this.rememberOutcome(id, entry.card, entry.options, result);
    if (entry.source === 'mission') this.markHandled(id);
    try {
      await entry.ready.catch(() => {});
      for (const m of entry.messages) {
        const outcome = F.formatOutcome(result, entry.options, m.lang);
        await this.edit(m.chatId, m.messageId, F.formatResolvedApproval(entry.card, outcome, m.lang));
      }
    } catch (err) {
      this.log('warn', `Telegram: retracting approval ${id} failed: ${this.api.redact(errMsg(err))}`);
    } finally {
      this.dropAlias(id);
    }
  }

  private async findApproval(id: string): Promise<FoundApproval | null> {
    const entry = this.delivered.get(id);
    if (entry) {
      if (entry.source === 'broker' && !this.broker.get(id)) return null;
      return { source: entry.source, options: entry.options, card: entry.card };
    }
    const p = this.broker.get(id);
    if (p) return { source: 'broker', options: p.options, card: brokerCard(p) };
    if (this.missions && !this.handledMission.has(id)) {
      try {
        const a = (await this.missions.pendingApprovals()).find((x) => x.id === id);
        if (a) return { source: 'mission', options: a.options, card: missionCard(a) };
      } catch { /* treat as unknown */ }
    }
    return null;
  }

  /**
   * Apply an answer from a paired chat: 'ok' when it resolved a pending
   * approval, 'gone' when it was no longer pending, 'error' when recording the
   * answer failed (e.g. the mission DB was busy) — the card stays answerable.
   */
  private async applyAnswer(id: string, found: FoundApproval, option: string, chat: PairedChat): Promise<AnswerOutcome> {
    if (found.source === 'broker') {
      // The broker calls our retract() for every channel → cards get the outcome.
      if (!this.broker.resolve(id, option, 'telegram')) return 'gone';
      this.rememberOutcome(id, found.card, found.options, { answer: option, by: 'telegram' });
      return 'ok';
    }
    if (!this.missions) return 'gone';
    let ok = false;
    this.answering.add(id);
    try {
      ok = await this.missions.resolveApproval(id, option, `telegram:${chat.username ? '@' + chat.username : chat.chatId}`);
    } catch (err) {
      this.log('warn', `Telegram: resolving mission approval ${id} failed: ${errMsg(err)}`);
      return 'error';
    } finally {
      this.answering.delete(id);
    }
    if (!ok) return 'gone';
    if (this.delivered.has(id)) {
      await this.retractApproval(id, { answer: option, by: 'telegram' });
    } else {
      this.markHandled(id);
      this.rememberOutcome(id, found.card, found.options, { answer: option, by: 'telegram' });
    }
    return 'ok';
  }

  private rememberOutcome(id: string, card: F.ApprovalCardInput, options: string[], result: ApprovalResult | null): void {
    this.outcomes.delete(id);
    this.outcomes.set(id, { card, options, result });
    if (this.outcomes.size > MAX_OUTCOMES) this.outcomes.delete(this.outcomes.keys().next().value as string);
  }

  private async handleCallback(cq: TgCallbackQuery): Promise<void> {
    const parsed = F.parseCallbackData(cq.data);
    const message = cq.message;
    const chatId = message?.chat?.id;
    if (!parsed || chatId === undefined || !message) { await this.answerCb(cq.id); return; }

    const chat = await this.pairing.getChat(chatId);
    const lang = chat ? F.langOf(chat.lang) : F.langOf(cq.from?.language_code);
    const S = F.strings(lang);
    // Only the paired user, in their private chat, may answer.
    if (!chat || message.chat.type !== 'private' || cq.from?.id !== chatId) {
      this.log('warn', `Telegram: rejected callback from unpaired chat ${chatId}`);
      await this.answerCb(cq.id, S.notAuthorized);
      return;
    }

    const id = this.aliasToId.get(parsed.id) ?? parsed.id;
    const found = await this.findApproval(id);
    const option = found?.options[parsed.index];
    if (!found || option === undefined) {
      await this.answerCb(cq.id, S.approvalExpired);
      await this.showPastOutcome(chatId, message, id, lang);
      return;
    }
    // A card we don't track (e.g. sent before a bot restart) is not edited by
    // retract(), so update it here once the answer lands.
    const tracked = this.findDeliveredByMessage(chatId, message.message_id) !== null;
    const res = await this.applyAnswer(id, found, option, chat);
    if (res === 'ok') {
      await this.answerCb(cq.id, S.approvalRecorded(option));
      this.log('info', `Telegram: approval ${id} answered "${option}" by chat ${chatId}`);
      if (!tracked) {
        const outcome = F.formatOutcome({ answer: option, by: 'telegram' }, found.options, lang);
        await this.edit(chatId, message.message_id, F.formatResolvedApproval(found.card, outcome, lang));
      }
    } else if (res === 'error') {
      await this.answerCb(cq.id, S.approvalRetry); // buttons stay: the approval is still pending
    } else {
      await this.answerCb(cq.id, S.approvalExpired);
      await this.showPastOutcome(chatId, message, id, lang);
    }
  }

  /**
   * A tap on a card whose approval is no longer pending. If we know how it ended
   * (e.g. the second tap of a double tap), show THAT outcome — never overwrite a
   * real "Approved" with "answered elsewhere". Otherwise just drop the buttons.
   */
  private async showPastOutcome(chatId: number, message: TgMessage, id: string, lang: F.Lang): Promise<void> {
    const past = this.outcomes.get(id);
    if (!past) { await this.markCardExpired(chatId, message, lang); return; }
    const outcome = F.formatOutcome(past.result, past.options, lang);
    await this.edit(chatId, message.message_id, F.formatResolvedApproval(past.card, outcome, lang));
  }

  /** A text reply to an approval card ("yes", "بله", "no"...). */
  private async answerByText(entry: DeliveredApproval, text: string, chat: PairedChat, lang: F.Lang): Promise<void> {
    const S = F.strings(lang);
    const option = normalizeAnswer(text, entry.options);
    if (!option) { await this.send(chat.chatId, S.approvalAnswerHint(entry.options)); return; }
    const found = await this.findApproval(entry.id);
    if (!found) { await this.send(chat.chatId, S.approvalExpired); return; }
    const res = await this.applyAnswer(entry.id, found, option, chat);
    if (res === 'error') await this.send(chat.chatId, S.approvalRetry);
    else if (res === 'gone') await this.send(chat.chatId, S.approvalExpired);
  }

  private findDeliveredByMessage(chatId: number, messageId: number): DeliveredApproval | null {
    for (const e of this.delivered.values()) {
      if (e.messages.some((m) => m.chatId === chatId && m.messageId === messageId)) return e;
    }
    return null;
  }

  /** Remove the buttons from a card nobody can answer anymore. */
  private async markCardExpired(chatId: number, message: TgMessage, lang: F.Lang): Promise<void> {
    const original = F.escapeHtml(F.truncate(message.text ?? '', 3500));
    await this.edit(chatId, message.message_id, `${original}\n\n${F.formatOutcome(null, [], lang)}`);
  }

  private callbackIdFor(id: string): string {
    if (!id.startsWith('~') && !id.includes(':') && F.buildCallbackData(id, 999) !== null) return id;
    const existing = this.idToAlias.get(id);
    if (existing) return existing;
    const alias = `~${(++this.aliasSeq).toString(36)}`;
    this.aliasToId.set(alias, id);
    this.idToAlias.set(id, alias);
    return alias;
  }

  private dropAlias(id: string): void {
    const alias = this.idToAlias.get(id);
    if (alias) { this.idToAlias.delete(id); this.aliasToId.delete(alias); }
  }

  private markHandled(id: string): void {
    this.handledMission.add(id);
    if (this.handledMission.size > MAX_HANDLED) {
      this.handledMission.delete(this.handledMission.values().next().value as string);
    }
  }

  // ── periodic work ──────────────────────────────────────────────────────────

  /** Pairing refresh (channel registration), mission approvals, mission events. Never throws. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.refreshChannel();
      if (this.channelUnregister) {
        // Broker approvals whose card could not be sent yet (a Sentinel prompt must not
        // silently wait out its timeout because Telegram was briefly unreachable).
        for (const p of this.broker.pending()) {
          if (!this.delivered.has(p.id)) await this.deliverBrokerApproval(p);
        }
      }
      if (this.missions) {
        await this.pollMissionApprovals();
        if (this.missions.eventsSince && this.notifyEnabled) await this.pollMissionEvents();
      }
      if (this.lastTickError) {
        this.lastTickError = null;
        this.log('info', 'Telegram: periodic checks are working again');
      }
    } catch (err) {
      // Runs every few seconds: report a persistent failure once (and again every
      // 10 minutes), not on every tick.
      const message = this.api.redact(errMsg(err));
      const now = this.now();
      const last = this.lastTickError;
      if (!last || last.message !== message || now - last.at >= 10 * 60_000) {
        this.lastTickError = { message, at: now };
        this.log('warn', `Telegram tick failed: ${message}`);
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Register the broker channel only while someone is paired (else unattended runs would wait for nobody). */
  private async refreshChannel(): Promise<void> {
    if (!this.running) return;
    const chats = await this.pairing.listChats();
    if (chats.length && !this.channelUnregister) {
      this.channelUnregister = this.broker.registerChannel(this.channel);
    } else if (!chats.length && this.channelUnregister) {
      this.channelUnregister();
      this.channelUnregister = null;
    }
  }

  private async pollMissionApprovals(): Promise<void> {
    if (!this.missions) return;
    const list = await this.missions.pendingApprovals();
    const ids = new Set(list.map((a) => a.id));
    const fresh = list.filter((a) => !this.delivered.has(a.id) && !this.handledMission.has(a.id) && !this.answering.has(a.id));
    if (fresh.length) {
      const chats = await this.pairing.listChats();
      if (chats.length) {
        for (const a of fresh) {
          // Re-check after the awaits: the broker may have delivered the same id meanwhile
          // (an in-process mission mirrors its broker approval into the DB).
          if (this.delivered.has(a.id) || this.handledMission.has(a.id) || this.answering.has(a.id)) continue;
          const entry = this.createEntry(a.id, 'mission', missionCard(a), a.options);
          await this.deliverTo(entry, chats);
          if (!entry.messages.length) this.delivered.delete(a.id); // retry next tick
        }
      }
    }
    const gone = [...this.delivered.values()]
      .filter((e) => e.source === 'mission' && !ids.has(e.id) && !this.answering.has(e.id))
      .map((e) => e.id);
    for (const id of gone) await this.retractApproval(id, null);
  }

  private async pollMissionEvents(): Promise<void> {
    const src = this.missions?.eventsSince;
    if (!src || !this.missions) return;
    if (this.missionCursor === null) {
      const r = await src.call(this.missions, null);
      this.missionCursor = Number.isFinite(r?.cursor) ? r.cursor : 0;
      return;
    }
    const r = await src.call(this.missions, this.missionCursor);
    if (Number.isFinite(r?.cursor)) this.missionCursor = Math.max(this.missionCursor, r.cursor);
    for (const ev of r?.events ?? []) {
      await this.notifyMission(ev.missionId, ev.type, ev.data);
    }
  }

  /** Mission event → notification; the same mission reaching the same state twice is announced once. */
  private notifyMission(missionId: string, type: string, data: unknown): Promise<void> {
    const probe = F.formatMissionNotice(missionId, type, data, 'en');
    if (!probe) return Promise.resolve();
    if (probe.dedupeKey) {
      const key = `${missionId}:${probe.dedupeKey}`;
      const now = this.now();
      const last = this.recentNotices.get(key);
      if (last !== undefined && now - last < NOTICE_DEDUPE_MS) return Promise.resolve();
      this.recentNotices.set(key, now);
      if (this.recentNotices.size > 500) this.recentNotices.delete(this.recentNotices.keys().next().value as string);
    }
    return this.broadcast((lang) => F.formatMissionNotice(missionId, type, data, lang));
  }

  private onBusEvent(ev: BusEvent): void {
    if (!this.notifyEnabled || !this.running) return;
    if (ev.kind === 'mission') {
      if (this.missions?.eventsSince) return; // the DB feed already covers these
      void this.notifyMission(ev.missionId, ev.type, ev.data).catch(() => {});
    } else if (ev.kind === 'sentinel') {
      // A denial the user just made by tapping "No" here needs no echo.
      const by = (ev.data as Record<string, unknown> | undefined)?.answeredBy;
      if (typeof by === 'string' && by.split(':')[0] === 'telegram') return;
      void this.broadcast((lang) => F.formatSentinelNotice(ev.type, ev.data, lang)).catch(() => {});
    }
  }

  /**
   * Send a localized notification to every paired chat, rate-limited. The
   * limiter decision is taken synchronously; sends are chained so notices
   * arrive in the order they happened.
   */
  private broadcast(build: (lang: F.Lang) => F.NoticeView | null): Promise<void> {
    const probe = build('en');
    if (!probe) return Promise.resolve();
    const now = this.now();
    if (probe.important) this.limiter.record(now);
    else if (!this.limiter.take(now)) { this.suppressed++; return Promise.resolve(); }
    // Claim the skipped count now so it is attached to the next notice actually sent.
    const skipped = this.suppressed;
    this.suppressed = 0;
    const run = async () => {
      const chats = await this.pairing.listChats();
      if (!chats.length) { this.suppressed += skipped; return; }
      for (const chat of chats) {
        const lang = F.langOf(chat.lang);
        const n = build(lang);
        if (!n) continue;
        await this.send(chat.chatId, skipped ? `${n.text}\n\n<i>${F.strings(lang).suppressed(skipped)}</i>` : n.text);
      }
    };
    this.notifyChain = this.notifyChain.then(run, run).catch((err) => {
      this.log('warn', `Telegram notification failed: ${errMsg(err)}`);
    });
    return this.notifyChain;
  }

  // ── transport helpers ──────────────────────────────────────────────────────

  private safeBrowser(): BrowserManager | null {
    try { return this.browserMgr(); } catch { return null; }
  }

  /** Retry once on 429 (≤30s) or a transport error. */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof TelegramApiError && err.isRateLimited && (err.retryAfterSec ?? 1) <= 30) {
        await this.sleepFn((err.retryAfterSec ?? 1) * 1000, this.controller?.signal);
        return fn();
      }
      if (err instanceof TelegramApiError && err.status === 0) {
        await this.sleepFn(1000, this.controller?.signal);
        return fn();
      }
      throw err;
    }
  }

  /**
   * sendMessage with an HTML → plain-text fallback (markup Telegram rejects, or
   * text over its 4096-character limit, which is counted after entity parsing).
   * Never throws; null on failure.
   */
  private async send(chatId: number, html: string, opts: { replyMarkup?: InlineKeyboardMarkup; retry?: boolean } = {}): Promise<TgMessage | null> {
    const plain = () => this.api.sendMessage(chatId, F.truncate(F.htmlToPlain(html), 4000), { replyMarkup: opts.replyMarkup, parseMode: null });
    const attempt = <T>(fn: () => Promise<T>) => (opts.retry === false ? fn() : this.withRetry(fn));
    try {
      if (F.htmlToPlain(html).length > F.MAX_MESSAGE_CHARS) return await attempt(plain);
      return await attempt(() => this.api.sendMessage(chatId, html, { replyMarkup: opts.replyMarkup }));
    } catch (err) {
      if (err instanceof TelegramApiError && (err.isParseError || err.isTooLong)) {
        try {
          return await plain();
        } catch (err2) {
          this.log('warn', `Telegram send to ${chatId} failed: ${this.api.redact(errMsg(err2))}`);
          return null;
        }
      }
      this.log('warn', `Telegram send to ${chatId} failed: ${this.api.redact(errMsg(err))}`);
      return null;
    }
  }

  /** editMessageText (removes the keyboard). Never throws. */
  private async edit(chatId: number, messageId: number, html: string): Promise<void> {
    const plain = () => this.api.editMessageText(chatId, messageId, F.truncate(F.htmlToPlain(html), 4000), { parseMode: null });
    try {
      if (F.htmlToPlain(html).length > F.MAX_MESSAGE_CHARS) await this.withRetry(plain);
      else await this.withRetry(() => this.api.editMessageText(chatId, messageId, html));
    } catch (err) {
      if (err instanceof TelegramApiError && err.isNotModified) return;
      if (err instanceof TelegramApiError && (err.isParseError || err.isTooLong)) {
        try { await plain(); } catch { /* give up */ }
        return;
      }
      this.log('warn', `Telegram edit ${chatId}/${messageId} failed: ${this.api.redact(errMsg(err))}`);
    }
  }

  private async answerCb(id: string, text?: string): Promise<void> {
    try { await this.api.answerCallbackQuery(id, { text }); } catch (err) {
      this.log('warn', `Telegram answerCallbackQuery failed: ${this.api.redact(errMsg(err))}`);
    }
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    try { this.logFn(level, this.api.redact(message)); } catch { /* logging must never break the bot */ }
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function brokerCard(p: PendingApproval): F.ApprovalCardInput {
  const missionId = typeof p.meta?.missionId === 'string' ? p.meta.missionId : undefined;
  return { id: p.id, prompt: p.prompt, options: p.options, category: p.category, risk: p.risk, source: p.source, missionId };
}

function missionCard(a: TelegramMissionApproval): F.ApprovalCardInput {
  return { id: a.id, prompt: a.prompt, options: a.options, category: a.category, risk: a.risk, missionId: a.missionId };
}

function describeChat(c: Pick<PairedChat, 'chatId' | 'username'>): string {
  return c.username ? `@${c.username} (${c.chatId})` : String(c.chatId);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** First line of an error message without terminal escapes (Playwright appends an ANSI call log). */
function firstLine(text: string): string {
  return String(text ?? '')
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .split(/\r?\n/)[0]
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim();
}
