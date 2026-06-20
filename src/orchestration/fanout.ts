/**
 * Parallel fan-out executor — run many independent sub-agent jobs concurrently
 * with a bounded worker pool, and collect every result for aggregation.
 *
 * This is the map/reduce primitive behind the `fanout` tool. It reuses the
 * existing SubAgentRunner (one fresh AgentLoop per job, isolated context) — the
 * same runner the DAG Orchestrator drives — so we don't reinvent sub-agent
 * spawning. The concurrency pattern mirrors scheduler.ts: keep `maxConcurrency`
 * jobs in flight, fill a slot the instant one frees up (Promise.race), never
 * block on the slowest when faster jobs could be starting.
 *
 * Isolation contract: a job that throws or whose sub-agent dies is captured as
 * an `ok: false` result — it NEVER rejects the pool. The caller always gets one
 * result per job, in input order.
 */

import { getSubAgentRunner } from '../tools/builtin/task.js';
import { logger } from '../utils/logger.js';

export interface FanoutJob {
  /** Short label for logs/UI (e.g. "audit: tools/web"). */
  label: string;
  /** Complete, self-contained prompt — the sub-agent has no prior context. */
  prompt: string;
  /** Distinct session id for this job's sub-agent. */
  sessionId: string;
  role?: string;
  model?: string;
  maxIterations?: number;
}

export interface FanoutJobResult {
  label: string;
  ok: boolean;
  finalText: string;
  toolCallsRun: number;
  error?: string;
  modelUsed?: string;
  elapsedMs: number;
}

export type FanoutEvent =
  | { type: 'job-start'; label: string; index: number; total: number }
  | { type: 'job-done'; label: string; index: number; ok: boolean; elapsedMs: number; toolCallsRun: number };

export interface FanoutOptions {
  maxConcurrency: number;
  signal?: AbortSignal;
  onEvent?: (ev: FanoutEvent) => void;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
}

/**
 * Run all jobs through the SubAgentRunner with at most `maxConcurrency` in
 * flight. Returns one result per job, in input order. Throws only if the
 * sub-agent runner isn't enabled at all (a programming/config error the caller
 * should have checked).
 */
export async function runFanout(jobs: FanoutJob[], opts: FanoutOptions): Promise<FanoutJobResult[]> {
  const runner = getSubAgentRunner();
  if (!runner) {
    throw new Error('fanout requires sub-agents to be enabled (getSubAgentRunner() returned null)');
  }
  const now = opts.now ?? Date.now;
  const cap = Math.max(1, Math.floor(opts.maxConcurrency));
  const results = new Array<FanoutJobResult>(jobs.length);

  const runOne = async (job: FanoutJob, index: number): Promise<void> => {
    const start = now();
    opts.onEvent?.({ type: 'job-start', label: job.label, index, total: jobs.length });
    try {
      const r = await runner(job.prompt, {
        maxIterations: job.maxIterations ?? 8,
        signal: opts.signal,
        sessionId: job.sessionId,
        modelOverride: job.model,
        role: job.role,
      });
      results[index] = {
        label: job.label,
        ok: r.ok,
        finalText: r.finalText ?? '',
        toolCallsRun: r.toolCallsRun ?? 0,
        error: r.error,
        modelUsed: r.modelUsed,
        elapsedMs: now() - start,
      };
    } catch (err: any) {
      // A runner that throws (rather than returning ok:false) must not kill the pool.
      logger.warn('fanout job threw', { label: job.label, err: err?.message ?? String(err) });
      results[index] = {
        label: job.label,
        ok: false,
        finalText: '',
        toolCallsRun: 0,
        error: err?.message ?? String(err),
        elapsedMs: now() - start,
      };
    } finally {
      const res = results[index]!;
      opts.onEvent?.({ type: 'job-done', label: job.label, index, ok: res.ok, elapsedMs: res.elapsedMs, toolCallsRun: res.toolCallsRun });
    }
  };

  let next = 0;
  const inFlight = new Set<Promise<void>>();
  while (next < jobs.length || inFlight.size > 0) {
    // Fill open slots (unless aborted — then drain what's running and stop).
    while (next < jobs.length && inFlight.size < cap && !opts.signal?.aborted) {
      const index = next++;
      const p = runOne(jobs[index]!, index).finally(() => inFlight.delete(p));
      inFlight.add(p);
    }
    if (inFlight.size === 0) break; // aborted with nothing left to drain
    await Promise.race(inFlight);
  }
  await Promise.allSettled(inFlight);

  // Any jobs never launched (aborted mid-run) get an explicit aborted result.
  for (let i = 0; i < jobs.length; i++) {
    if (!results[i]) {
      results[i] = {
        label: jobs[i]!.label,
        ok: false,
        finalText: '',
        toolCallsRun: 0,
        error: 'aborted before start',
        elapsedMs: 0,
      };
    }
  }
  return results;
}
