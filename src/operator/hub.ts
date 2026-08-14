/**
 * Operator hub — one process-wide control plane.
 *
 * Hermes re-wires the agent at every surface (CLI, gateway, ACP, cron). QodeX
 * keeps a single hub:
 *
 *   - approval  one FIFO queue for EVERY run (main turn, /background, later bot)
 *   - live      tagged stdout/stderr/progress from any run
 *
 * The TUI is a subscriber, not the owner. A side run that needs a yes/no parks
 * here and the same Confirmation widget answers it. Surfaces never talk to
 * each other.
 *
 * PURE queue logic is in this file so it is unit-testable without Ink.
 */

export interface ApprovalRequest {
  id: string;
  source: string;
  prompt: string;
  options: string[];
}

export type LiveStream = 'out' | 'err' | 'progress';

export type HubEvent =
  | ({ kind: 'approval' } & ApprovalRequest)
  | { kind: 'approval-cleared'; id: string }
  | { kind: 'live'; source: string; stream: LiveStream; line: string };

type ApprovalWaiter = ApprovalRequest & { resolve: (answer: string) => void };

export class OperatorHub {
  private seq = 0;
  private queue: ApprovalWaiter[] = [];
  private inflight: ApprovalWaiter | null = null;
  private listeners = new Set<(ev: HubEvent) => void>();

  subscribe(fn: (ev: HubEvent) => void): () => void {
    this.listeners.add(fn);
    if (this.inflight) {
      const { id, source, prompt, options } = this.inflight;
      fn({ kind: 'approval', id, source, prompt, options });
    }
    return () => { this.listeners.delete(fn); };
  }

  private emit(ev: HubEvent): void {
    for (const fn of this.listeners) {
      try { fn(ev); } catch { /* a broken subscriber must not stall the hub */ }
    }
  }

  /** Ask the operator. FIFO — a side-run never jumps the main turn. */
  requestApproval(source: string, prompt: string, options: string[] = ['yes', 'no']): Promise<string> {
    return new Promise(resolve => {
      this.seq += 1;
      this.queue.push({
        id: `ap${this.seq}`,
        source,
        prompt,
        options: options.length ? options : ['yes', 'no'],
        resolve,
      });
      this.pump();
    });
  }

  /** The surface calls this when the user answers the inflight prompt. */
  answer(id: string, answer: string): boolean {
    if (!this.inflight || this.inflight.id !== id) return false;
    const done = this.inflight;
    this.inflight = null;
    this.emit({ kind: 'approval-cleared', id });
    done.resolve(answer);
    this.pump();
    return true;
  }

  pending(): ApprovalRequest | null {
    if (!this.inflight) return null;
    const { id, source, prompt, options } = this.inflight;
    return { id, source, prompt, options };
  }

  emitLive(source: string, stream: LiveStream, line: string): void {
    const text = line.replace(/\s+$/u, '');
    if (!text) return;
    this.emit({ kind: 'live', source, stream, line: text });
  }

  private pump(): void {
    if (this.inflight || this.queue.length === 0) return;
    this.inflight = this.queue.shift()!;
    const { id, source, prompt, options } = this.inflight;
    this.emit({ kind: 'approval', id, source, prompt, options });
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
