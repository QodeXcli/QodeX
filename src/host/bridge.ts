/**
 * The bot enqueues here only when this process is the host.
 * A missing function is "the host is not running", not a fake queue.
 */
import type { HostJob } from './jobs.js';

type Enqueue = (prompt: string, project: string) => Promise<HostJob>;

let enqueue: Enqueue | null = null;

export function setHostEnqueue(fn: Enqueue | null): void {
  enqueue = fn;
}

export function hostEnqueue(): Enqueue | null {
  return enqueue;
}
