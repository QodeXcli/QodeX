/**
 * Bot front-end — the transport contract.
 *
 * The whole design rests on this seam: ALL behaviour (streaming, chunking, per-chat turn
 * serialization, auth, permission prompts) lives in the transport-agnostic core (gateway.ts +
 * stream-pump.ts + …). A platform "adapter" (Telegram, Discord) implements ONLY this thin
 * interface — receive a message, send/edit a message, optionally show buttons. No agent logic
 * ever leaks into an adapter, so the two platforms can never drift in behaviour or bugs.
 */

export type Platform = 'telegram' | 'discord';

/** A normalized inbound event from any platform. */
export interface Incoming {
  platform: Platform;
  /** Conversation id (Telegram chat id / Discord channel id) — the unit of session + serialization. */
  chatId: string;
  /** Author id, used for the allowlist. */
  userId: string;
  userName?: string;
  /** Free text the user sent (empty for a pure button tap). */
  text: string;
  /** Set when the user tapped an inline button: the button's `data` payload. */
  callbackData?: string;
  /** Opaque id the adapter needs to acknowledge a button tap (answerCallbackQuery / defer). */
  callbackId?: string;
}

/** Handle to a sent message, so the core can edit it as the stream grows. */
export interface MessageRef { id: string }

/** An inline button (approve/deny prompts). */
export interface Button { label: string; data: string }

/**
 * What every platform adapter must provide. `maxLen` and `minEditIntervalMs` let the core
 * tune chunking + edit-throttling per platform without knowing which platform it is.
 */
export interface Transport {
  readonly platform: Platform;
  /** Hard per-message character cap (Telegram 4096, Discord 2000). */
  readonly maxLen: number;
  /** Floor between two edits of the SAME message, ms (Telegram ~1/s, Discord ~5/5s ⇒ ~1.2s). */
  readonly minEditIntervalMs: number;

  /** Begin receiving; `onMessage` is called for every inbound event. Resolves once connected. */
  start(onMessage: (m: Incoming) => void): Promise<void>;
  stop(): Promise<void>;

  send(chatId: string, text: string, buttons?: Button[][]): Promise<MessageRef>;
  edit(chatId: string, ref: MessageRef, text: string, buttons?: Button[][]): Promise<void>;

  /** Best-effort: acknowledge a button tap so the client stops its spinner. */
  ackCallback?(callbackId: string): Promise<void>;
  /** Best-effort: show a "typing…" indicator. */
  typing?(chatId: string): Promise<void>;
}

/** Injected agent runner — the gateway stays decoupled from AgentLoop for testability. */
export interface TurnSink {
  /** Called for each chunk of assistant text as it streams. */
  onDelta(text: string): void | Promise<void>;
  /** Called when the agent needs a yes/no (permission). Returns the chosen option. */
  ask(prompt: string, options: string[]): Promise<string>;
  /** Called for a short status line (tool start, notice). */
  onStatus(text: string): void | Promise<void>;
}

export interface AgentRunner {
  /**
   * Run one turn for `chatId`'s session with `userText`, driving `sink` for output/approvals.
   * Returns the final assistant text. Must reject only on fatal errors.
   */
  runTurn(convKey: string, userText: string, sink: TurnSink, signal: AbortSignal): Promise<string>;
  /** Forget the conversation's session so the next turn starts fresh. */
  reset?(convKey: string): Promise<void>;
}
