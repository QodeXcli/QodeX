/**
 * Process-wide event bus for the agent platform.
 *
 * Producers (agent runs, missions, the browser manager, the approval broker,
 * Sentinel) publish small JSON-safe events here; consumers (the control center's
 * SSE stream, the Telegram channel, `mission attach`) subscribe. Publishing is
 * cheap and synchronous, and a no-op when nobody listens, so producers never
 * need to know whether a control center is running.
 *
 * High-volume data (screencast frames) does NOT go through the bus — consumers
 * pull frames from the browser manager directly.
 */

import { EventEmitter } from 'events';

export type BusEvent =
  | { kind: 'agent'; source: string; type: string; data?: unknown; ts: number }
  | { kind: 'approval.requested'; id: string; prompt: string; options: string[]; source?: string; category?: string; risk?: string; meta?: Record<string, unknown>; ts: number }
  | { kind: 'approval.resolved'; id: string; answer: string; by: string; ts: number }
  | { kind: 'mission'; missionId: string; type: string; data?: unknown; ts: number }
  | { kind: 'browser'; type: string; data?: unknown; ts: number }
  | { kind: 'sentinel'; type: string; data?: unknown; ts: number }
  /** Mail automation (src/grants/mail-events.ts): new mail, auto-replies, rule runs, grants. Data is clipped + secret-masked. */
  | { kind: 'mail'; type: string; data?: unknown; ts: number }
  | { kind: 'notice'; level: 'info' | 'warn' | 'error'; message: string; ts: number };

/** Event shapes without the timestamp — `publish` stamps them. */
export type BusEventInput = BusEvent extends infer E ? (E extends BusEvent ? Omit<E, 'ts'> & { ts?: number } : never) : never;

export type BusListener = (ev: BusEvent) => void;

class AgentBus {
  private emitter = new EventEmitter();
  /** Small ring buffer so a viewer that connects late still sees recent history. */
  private history: BusEvent[] = [];
  private readonly historyMax = 300;

  constructor() {
    // Many SSE viewers + channels may subscribe; don't warn at 10.
    this.emitter.setMaxListeners(0);
  }

  publish(ev: BusEventInput): BusEvent {
    const stamped = { ...ev, ts: ev.ts ?? Date.now() } as BusEvent;
    this.history.push(stamped);
    if (this.history.length > this.historyMax) this.history.splice(0, this.history.length - this.historyMax);
    // A throwing listener must never break the producer (often the agent loop).
    for (const l of this.emitter.listeners('event') as BusListener[]) {
      try { l(stamped); } catch { /* isolate listener failures */ }
    }
    return stamped;
  }

  subscribe(listener: BusListener): () => void {
    this.emitter.on('event', listener);
    return () => { this.emitter.off('event', listener); };
  }

  listenerCount(): number {
    return this.emitter.listenerCount('event');
  }

  /** Recent events, oldest first (optionally filtered). */
  recent(limit = 100, filter?: (ev: BusEvent) => boolean): BusEvent[] {
    const src = filter ? this.history.filter(filter) : this.history;
    return src.slice(-Math.max(0, limit));
  }

  /** Test helper. */
  reset(): void {
    this.history = [];
    this.emitter.removeAllListeners('event');
  }
}

let bus: AgentBus | null = null;

export function getBus(): AgentBus {
  if (!bus) bus = new AgentBus();
  return bus;
}

export type { AgentBus };
