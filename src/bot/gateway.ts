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
import type { Transport, Incoming, AgentRunner, TurnSink, ArtifactCard, Button } from './types.js';
import { StreamPump } from './stream-pump.js';
import { isAuthorized, type AllowConfig } from './auth.js';
import { findCommand, menuDescriptors, type GatewayControls } from './commands.js';

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
  private pendingEdit = new Map<string, string>();    // key → artifactId awaiting an "/edit" instruction
  private now: () => number;

  constructor(private opts: GatewayOptions) {
    this.now = opts.now ?? (() => Date.now());
  }

  async start(): Promise<void> {
    for (const t of this.opts.transports) {
      await t.start(m => void this.onMessage(t, m));
      await t.setCommands?.(menuDescriptors()).catch(() => {}); // native `/` menu — best-effort
    }
  }
  async stop(): Promise<void> {
    for (const ac of this.busy.values()) ac.abort();
    for (const t of this.opts.transports) await t.stop();
  }

  private key(t: Transport, m: Incoming): string { return `${t.platform}:${m.chatId}`; }

  /** The small control surface a command may drive for this conversation. */
  private controlsFor(t: Transport, chatId: string, key: string): GatewayControls {
    return {
      isBusy: () => this.busy.has(key),
      queueDepth: () => this.queue.get(key)?.length ?? 0,
      abort: () => { const ac = this.busy.get(key); if (!ac) return false; ac.abort(); return true; },
      reset: async () => { this.busy.get(key)?.abort(); this.queue.delete(key); await this.opts.agent.reset?.(key); },
      runTask: (txt) => this.runAndDrain(t, chatId, key, txt),
    };
  }

  /** Run `text` as a turn, serialized per chat: if busy, queue it; else run + drain the queue. */
  private async runAndDrain(t: Transport, chatId: string, key: string, text: string): Promise<void> {
    if (this.busy.has(key)) {
      const q = this.queue.get(key) ?? [];
      q.push(text); this.queue.set(key, q);
      await t.send(chatId, `⏳ Busy — queued (#${q.length}). \`/stop\` to cancel the current task.`);
      return;
    }
    await this.runOne(t, chatId, key, text);
    let next: string | undefined;
    while ((next = this.queue.get(key)?.shift())) await this.runOne(t, chatId, key, next);
    this.queue.delete(key);
  }

  /** Single entry point for every inbound event from any adapter. */
  async onMessage(t: Transport, m: Incoming): Promise<void> {
    const key = this.key(t, m);

    // 1) Auth — closed by default. A coding agent must never run for an unlisted user.
    if (!isAuthorized(t.platform, m.userId, this.opts.allow)) {
      await t.send(m.chatId, '⛔ You are not on this QodeX bot’s allowlist.');
      return;
    }

    // 2) Living-artifact card actions (Approve / Edit / Reject) — handled before permission asks.
    if (m.callbackData?.startsWith('art:')) {
      if (m.callbackId && t.ackCallback) await t.ackCallback(m.callbackId);
      await this.handleCardAction(t, m.chatId, key, m.callbackData);
      return;
    }

    // 3) A pending permission prompt swallows the next tap/reply (not a new turn).
    if (this.asks.has(key)) {
      const answer = m.callbackData ? this.stripAsk(m.callbackData) : m.text.trim();
      if (m.callbackId && t.ackCallback) await t.ackCallback(m.callbackId);
      if (answer) { this.resolveAsk(key, answer); return; }
    }
    if (m.callbackData) { if (m.callbackId && t.ackCallback) await t.ackCallback(m.callbackId); return; }

    let text = m.text.trim();
    if (!text) return;

    // 4) An "Edit" tap left this chat awaiting the change instruction → fold it into an update turn.
    const editId = this.pendingEdit.get(key);
    if (editId && !text.startsWith('/')) {
      this.pendingEdit.delete(key);
      text = `Update the "${editId}" artifact and keep it live: ${text}`;
    }

    // 5) Commands — dispatched through the declarative registry (drives the native `/` menu + /help).
    if (text.startsWith('/')) {
      const hit = findCommand(text);
      if (!hit) { await t.send(m.chatId, `Unknown command \`${text.split(/\s/)[0]}\`. Try /help.`); return; }
      await hit.cmd.run({
        args: hit.args, key, agent: this.opts.agent,
        gateway: this.controlsFor(t, m.chatId, key),
        reply: async (s, b) => { await t.send(m.chatId, s, b); },
      });
      return;
    }

    // 6) Run it as a turn (serialized per chat; queued if one is already running).
    await this.runAndDrain(t, m.chatId, key, text);
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

    let turnCard: ArtifactCard | undefined;
    const sink: TurnSink = {
      onDelta: s => pump.push(s),
      onStatus: () => {},                          // tool/status lines stay quiet to avoid noise
      ask: (prompt, options) => this.askUser(t, chatId, key, prompt, options),
      artifact: card => { turnCard = card; },      // held until the stream finishes, then rendered below
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
    if (turnCard) await this.presentCard(t, chatId, turnCard).catch(() => {});
  }

  /** Render a finished living-artifact: the screenshot (if any) + verdict + the live link, with
   *  Approve / Edit / Reject buttons. Falls back to text when the adapter can't send a photo. */
  private async presentCard(t: Transport, chatId: string, card: ArtifactCard): Promise<void> {
    const mark = { looks_good: '✅ Looks good', needs_work: '🛠 Needs work', broken: '❌ Broken', unverified: '👁 Unverified' };
    const lines = [`*${card.title ?? card.artifactId}*${card.type ? ` _(${card.type})_` : ''}`];
    if (card.verdict) lines.push(`Vision review: ${mark[card.verdict]}`);
    if (card.verdict !== 'looks_good' && card.issues?.length) lines.push('• ' + card.issues.slice(0, 4).join('\n• '));
    if (card.liveUrl) lines.push(`🔗 Live (hot-reload): ${card.liveUrl}`);
    const caption = lines.join('\n');
    const buttons: Button[][] = [[
      { label: '✅ Approve', data: `art:approve:${card.artifactId}` },
      { label: '✏️ Edit', data: `art:edit:${card.artifactId}` },
      { label: '🗑 Reject', data: `art:reject:${card.artifactId}` },
    ]];
    if (card.screenshotPath && t.sendPhoto) {
      try { await t.sendPhoto(chatId, card.screenshotPath, caption, buttons); return; }
      catch { /* fall through to text */ }
    }
    await t.send(chatId, caption, buttons);
  }

  /** Resolve an Approve/Edit/Reject tap on a presented artifact card. */
  private async handleCardAction(t: Transport, chatId: string, key: string, data: string): Promise<void> {
    const [, action, id = ''] = data.split(':');
    if (action === 'approve') { await t.send(chatId, `✅ Approved “${id}” — keeping it live.`); return; }
    if (action === 'reject') { this.pendingEdit.delete(key); await t.send(chatId, `🗑 Rejected “${id}”. Send a new task whenever you like.`); return; }
    if (action === 'edit') { this.pendingEdit.set(key, id); await t.send(chatId, `✏️ What should I change about “${id}”? Send the tweak and I’ll update it live.`); return; }
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
