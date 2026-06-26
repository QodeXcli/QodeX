/**
 * Coalescing, throttled streaming pump (the anti-flooding core).
 *
 * Editing a chat message on every token hammers the platform's rate limit (Telegram ~1 edit/s,
 * Discord ~5/5s) → 429s, dropped updates, and the visible "oscillation" of half-rendered text.
 * (Same class of bug as the QodeX TUI streaming jitter.) This buffers deltas and edits the live
 * message at most once per `minIntervalMs`, only when the content actually changed. When the
 * text outgrows one message it finalizes the full one (via the fence-aware splitter), advances a
 * stable offset, and continues streaming into a fresh message — so a long answer flows across
 * several messages without ever re-sending or corrupting a code block.
 *
 * Transport I/O is injected (and the clock too), so the whole thing is deterministic + unit
 * testable with a fake transport and a hand-driven clock — no real timers, no network.
 */
import type { MessageRef } from './types.js';
import { splitForStream } from './chunk.js';

export interface PumpIO {
  maxLen: number;
  minIntervalMs: number;
  now: () => number;
  send: (text: string) => Promise<MessageRef>;
  edit: (ref: MessageRef, text: string) => Promise<void>;
}

export class StreamPump {
  private buf = '';
  private offset = 0;          // chars already committed to finalized (untouchable) messages
  private cur: MessageRef | null = null;
  private curText = '';        // last text written to the live message (edit dedupe)
  private lastFlushAt = -Infinity;
  private flushing = false;
  private dirty = false;       // buffered text awaits a flush that the throttle deferred

  constructor(private io: PumpIO) {}

  /** Append streamed text; flush now if the throttle window elapsed, else mark dirty. */
  async push(delta: string): Promise<void> {
    if (delta) this.buf += delta;
    if (this.io.now() - this.lastFlushAt >= this.io.minIntervalMs) await this.flush(false);
    else this.dirty = true;
  }

  /** Drain any throttle-deferred text — call this on a timer between pushes. */
  async drain(): Promise<void> {
    if (this.dirty && this.io.now() - this.lastFlushAt >= this.io.minIntervalMs) await this.flush(false);
  }

  /** Force the final state out, regardless of throttle. */
  async finish(): Promise<void> { await this.flush(true); }

  private async flush(final: boolean): Promise<void> {
    if (this.flushing) { this.dirty = true; return; } // serialize: one in-flight network op at a time
    this.flushing = true;
    try {
      this.dirty = false;
      const tail = this.buf.slice(this.offset);
      if (tail === '' && !this.cur) return;           // nothing to show yet
      const pieces = splitForStream(tail, this.io.maxLen);
      for (let i = 0; i < pieces.length; i++) {
        const piece = pieces[i]!;
        const last = i === pieces.length - 1;
        const body = piece.display || (last ? '…' : '');
        if (!this.cur) { this.cur = await this.io.send(body); this.curText = body; }
        else if (this.curText !== body) { await this.io.edit(this.cur, body); this.curText = body; }
        if (!last) { this.offset += piece.consumed; this.cur = null; this.curText = ''; } // finalize & move on
      }
      this.lastFlushAt = this.io.now();
    } finally {
      this.flushing = false;
    }
    if (this.dirty && final) await this.flush(true); // re-entrant push happened mid-flight
  }
}
