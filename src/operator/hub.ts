/**
 * Operator hub — one process-wide control plane.
 *
 * Approvals are FIFO *inside a lane*, not across the whole process:
 *   - lane `tui`     main chat + /background  (one operator at the keyboard)
 *   - lane `bot:…`   one conversation         (a remote operator)
 *
 * A parked Telegram ask must not starve [bg1]. Live events stay a dumb
 * tagged broadcast — subscribers decide whether to render them.
 *
 * `origin` is metadata for subscribers (tui vs telegram:chatId). The hub
 * does not know about transports.
 */

import { appendAudit } from '../security/audit-log.js';
import type { AskMeta } from '../agent/ask-meta.js';

export const TUI_LANE = 'tui';
export const TUI_ORIGIN = 'tui';

export function botLane(convKey: string): string {
  return `bot:${convKey}`;
}

export interface ApprovalRequest {
  id: string;
  source: string;
  prompt: string;
  options: string[];
  lane: string;
  origin: string;
  /** What the prompt is about (permission tool + operation, Sentinel, question), when known. */
  meta?: AskMeta;
}

export interface ApprovalOpts {
  /** FIFO isolation key. Default `tui`. */
  lane?: string;
  /** Who should present this ask. Default `tui`. */
  origin?: string;
  /**
   * Withdraw the ask when this aborts (it resolves with 'no'). The ApprovalBroker uses
   * it to dismiss the terminal prompt once another channel (control center, Telegram)
   * answered the same question first.
   */
  signal?: AbortSignal;
  /** What the prompt is about (src/agent/ask-meta.ts) — lets the surface re-check it on a mode switch. */
  meta?: AskMeta;
}

export type LiveStream = 'out' | 'err' | 'progress';

export type HubEvent =
  | ({ kind: 'approval' } & ApprovalRequest)
  | { kind: 'approval-cleared'; id: string }
  | { kind: 'live'; source: string; stream: LiveStream; line: string };

type ApprovalWaiter = ApprovalRequest & { resolve: (answer: string) => void };

interface LaneState {
  queue: ApprovalWaiter[];
  inflight: ApprovalWaiter | null;
}

function snapshot(w: ApprovalWaiter): ApprovalRequest {
  const { id, source, prompt, options, lane, origin, meta } = w;
  return meta ? { id, source, prompt, options, lane, origin, meta } : { id, source, prompt, options, lane, origin };
}

export class OperatorHub {
  private seq = 0;
  private lanes = new Map<string, LaneState>();
  private listeners = new Set<(ev: HubEvent) => void>();

  private laneState(id: string): LaneState {
    let s = this.lanes.get(id);
    if (!s) {
      s = { queue: [], inflight: null };
      this.lanes.set(id, s);
    }
    return s;
  }

  subscribe(fn: (ev: HubEvent) => void): () => void {
    this.listeners.add(fn);
    for (const s of this.lanes.values()) {
      if (!s.inflight) continue;
      try { fn({ kind: 'approval', ...snapshot(s.inflight) }); } catch { /* */ }
    }
    return () => { this.listeners.delete(fn); };
  }

  private emit(ev: HubEvent): void {
    for (const fn of this.listeners) {
      try { fn(ev); } catch { /* a broken subscriber must not stall the hub */ }
    }
  }

  /** Ask the operator. FIFO inside `lane` — other lanes stay free. */
  requestApproval(
    source: string,
    prompt: string,
    options: string[] = ['yes', 'no'],
    opts: ApprovalOpts = {},
  ): Promise<string> {
    const lane = opts.lane ?? TUI_LANE;
    const origin = opts.origin ?? TUI_ORIGIN;
    return new Promise(resolve => {
      this.seq += 1;
      const id = `ap${this.seq}`;
      if (opts.signal) {
        if (opts.signal.aborted) { resolve('no'); return; }
        opts.signal.addEventListener('abort', () => { this.cancel(id, 'no'); }, { once: true });
      }
      this.laneState(lane).queue.push({
        id,
        source,
        prompt,
        options: options.length ? options : ['yes', 'no'],
        lane,
        origin,
        ...(opts.meta ? { meta: opts.meta } : {}),
        resolve,
      });
      this.pump(lane);
    });
  }

  /** The surface calls this when the user answers any inflight prompt. */
  answer(id: string, answer: string): boolean {
    for (const [lane, s] of this.lanes) {
      if (!s.inflight || s.inflight.id !== id) continue;
      const done = s.inflight;
      s.inflight = null;
      this.emit({ kind: 'approval-cleared', id });
      appendAudit({ type: 'approval', id, answer, origin: done.origin, source: done.source, lane: done.lane });
      done.resolve(answer);
      this.pump(lane);
      return true;
    }
    return false;
  }

  /** Drop a queued or inflight ask (abort / /stop). Resolves so the waiter is not leaked. */
  cancel(id: string, answer = 'no'): boolean {
    for (const [lane, s] of this.lanes) {
      if (s.inflight?.id === id) return this.answer(id, answer);
      const i = s.queue.findIndex(w => w.id === id);
      if (i < 0) continue;
      const [w] = s.queue.splice(i, 1);
      w!.resolve(answer);
      return true;
    }
    return false;
  }

  /** Resolve every ask on a lane (conversation aborted). */
  cancelLane(lane: string, answer = 'no'): number {
    const s = this.lanes.get(lane);
    if (!s) return 0;
    const waiters = s.inflight ? [s.inflight, ...s.queue] : s.queue.slice();
    const inflightId = s.inflight?.id;
    s.queue = [];
    s.inflight = null;
    if (inflightId) this.emit({ kind: 'approval-cleared', id: inflightId });
    for (const w of waiters) w.resolve(answer);
    return waiters.length;
  }

  pending(lane: string = TUI_LANE): ApprovalRequest | null {
    const w = this.lanes.get(lane)?.inflight;
    return w ? snapshot(w) : null;
  }

  pendingAll(): ApprovalRequest[] {
    const out: ApprovalRequest[] = [];
    for (const s of this.lanes.values()) {
      if (s.inflight) out.push(snapshot(s.inflight));
    }
    return out;
  }

  emitLive(source: string, stream: LiveStream, line: string): void {
    const text = line.replace(/\s+$/u, '');
    if (!text) return;
    this.emit({ kind: 'live', source, stream, line: text });
  }

  private pump(lane: string): void {
    const s = this.laneState(lane);
    if (s.inflight || s.queue.length === 0) return;
    s.inflight = s.queue.shift()!;
    this.emit({ kind: 'approval', ...snapshot(s.inflight) });
  }
}

let _hub: OperatorHub | null = null;
export function getOperatorHub(): OperatorHub {
  if (!_hub) _hub = new OperatorHub();
  return _hub;
}

/** Tests only — a fresh hub so cases cannot leak into each other. */
export function resetOperatorHub(): OperatorHub {
  _hub = new OperatorHub();
  return _hub;
}
