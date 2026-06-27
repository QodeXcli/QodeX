/**
 * Transport-agnostic bot gateway — the one place all behaviour lives.
 *
 * Adapters (Telegram/Discord) are dumb pipes; everything that could be buggy is solved here,
 * once, for both platforms:
 *   - allowlist auth (deny by default) before anything runs;
 *   - ONE agent turn per conversation at a time (serialized), later messages queued — no
 *     interleaved tool calls or racing turns;
 *   - streaming via StreamPump (throttled, coalesced, fence-aware spill);
 *   - permission prompts surfaced as inline buttons, resolved by a tap OR a typed reply;
 *   - /new (fresh session), /stop (abort the running turn), /help.
 *
 * The agent itself is injected (`AgentRunner`) so the gateway is fully unit-testable with a
 * fake transport + fake agent — no LLM, no network.
 */
import type { Transport, Incoming, AgentRunner, TurnSink } from './types.js';
import { StreamPump } from './stream-pump.js';
import { isAuthorized, type AllowConfig } from './auth.js';

interface PendingAsk { resolve: (v: string) => void; options: string[] }

export interface GatewayOptions {
  transports: Transport[];
  agent: AgentRunner;
  allow: AllowConfig;
  now?: () => number;
}

export class BotGateway {
  private busy = new Map<string, AbortController>();  // key → running turn
  private queue = new Map<string, string[]>();        // key → pending user texts
  private asks = new Map<string, PendingAsk>();       // key → awaiting permission answer
  private now: () => number;

  constructor(private opts: GatewayOptions) {
    this.now = opts.now ?? (() => Date.now());
  }

  async start(): Promise<void> {
    for (const t of this.opts.transports) await t.start(m => void this.onMessage(t, m));
  }
  async stop(): Promise<void> {
    for (const ac of this.busy.values()) ac.abort();
    for (const t of this.opts.transports) await t.stop();
  }

  private key(t: Transport, m: Incoming): string { return `${t.platform}:${m.chatId}`; }

  /** Single entry point for every inbound event from any adapter. */
  async onMessage(t: Transport, m: Incoming): Promise<void> {
    const key = this.key(t, m);

    // 1) Auth — closed by default. A coding agent must never run for an unlisted user.
    if (!isAuthorized(t.platform, m.userId, this.opts.allow)) {
      await t.send(m.chatId, '⛔ You are not on this QodeX bot’s allowlist.');
      return;
    }

    // 2) A pending permission prompt swallows the next tap/reply (not a new turn).
    if (this.asks.has(key)) {
      const answer = m.callbackData ? this.stripAsk(m.callbackData) : m.text.trim();
      if (m.callbackId && t.ackCallback) await t.ackCallback(m.callbackId);
      if (answer) { this.resolveAsk(key, answer); return; }
    }
    if (m.callbackData) { if (m.callbackId && t.ackCallback) await t.ackCallback(m.callbackId); return; }

    const text = m.text.trim();
    if (!text) return;

    // 3) Commands.
    if (text === '/help' || text === '/start') {
      await t.send(m.chatId, HELP);
      return;
    }
    if (text === '/stop') {
      const ac = this.busy.get(key);
      if (ac) { ac.abort(); await t.send(m.chatId, '🛑 Stopped.'); }
      else await t.send(m.chatId, 'Nothing is running.');
      return;
    }
    if (text === '/new') {
      this.busy.get(key)?.abort();
      this.queue.delete(key);
      await this.opts.agent.reset?.(key);
      await t.send(m.chatId, '🆕 Started a fresh conversation.');
      return;
    }

    // 4) One turn at a time per chat; otherwise queue.
    if (this.busy.has(key)) {
      const q = this.queue.get(key) ?? [];
      q.push(text); this.queue.set(key, q);
      await t.send(m.chatId, `⏳ Busy — queued (#${q.length}). \`/stop\` to cancel the current task.`);
      return;
    }

    await this.runOne(t, m.chatId, key, text);
    // Drain anything queued while we were busy.
    let next: string | undefined;
    while ((next = this.queue.get(key)?.shift())) await this.runOne(t, m.chatId, key, next);
    this.queue.delete(key);
  }

  private async runOne(t: Transport, chatId: string, key: string, text: string): Promise<void> {
    const ac = new AbortController();
    this.busy.set(key, ac);
    const pump = new StreamPump({
      maxLen: t.maxLen,
      minIntervalMs: t.minEditIntervalMs,
      now: this.now,
      send: s => t.send(chatId, s),
      edit: (ref, s) => t.edit(chatId, ref, s),
    });
    const drainTimer = setInterval(() => void pump.drain(), t.minEditIntervalMs);
    if (typeof (drainTimer as any).unref === 'function') (drainTimer as any).unref();

    const sink: TurnSink = {
      onDelta: s => pump.push(s),
      onStatus: () => {},                          // tool/status lines stay quiet to avoid noise
      ask: (prompt, options) => this.askUser(t, chatId, key, prompt, options),
    };

    try {
      if (t.typing) await t.typing(chatId).catch(() => {});
      await this.opts.agent.runTurn(key, text, sink, ac.signal);
    } catch (e: any) {
      const msg = ac.signal.aborted ? '🛑 Stopped.' : `⚠️ ${e?.message ?? String(e)}`;
      await pump.finish().catch(() => {});
      await t.send(chatId, msg).catch(() => {});
      clearInterval(drainTimer);
      this.busy.delete(key);
      this.asks.delete(key);
      return;
    }
    clearInterval(drainTimer);
    await pump.finish().catch(() => {});
    this.busy.delete(key);
    this.asks.delete(key);
  }

  private askUser(t: Transport, chatId: string, key: string, prompt: string, options: string[]): Promise<string> {
    return new Promise<string>(resolve => {
      this.asks.set(key, { resolve, options });
      const row = options.map(o => ({ label: o, data: `ask:${o}` }));
      void t.send(chatId, `🔐 ${prompt}`, [row]);
    });
  }

  private stripAsk(data: string): string { return data.startsWith('ask:') ? data.slice(4) : data; }

  private resolveAsk(key: string, value: string): void {
    const ask = this.asks.get(key);
    if (!ask) return;
    this.asks.delete(key);
    // Snap free-text to the closest offered option; default to the first (usually the safe "no").
    const match = ask.options.find(o => o.toLowerCase() === value.toLowerCase()) ?? ask.options[0]!;
    ask.resolve(match);
  }
}

const HELP = [
  '🤖 *QodeX bot*',
  'Just send a coding task and I’ll work in the project, streaming as I go.',
  '',
  '`/new`  — start a fresh conversation (new session)',
  '`/stop` — abort the current task',
  '`/help` — this message',
  '',
  'When I need approval to run something, I’ll show buttons — tap one (or reply yes/no).',
].join('\n');
