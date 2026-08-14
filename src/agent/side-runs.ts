/**
 * Side runs — isolated parallel agents the user starts with /background.
 *
 * Not a second AgentLoop in the TUI thread. We reuse the existing sub-agent
 * runner (own session, own context, bounded tools) so the main conversation
 * stays interactive. Completion is observed via a tiny listener; no polling
 * in the agent loop.
 *
 * Distinct from background_job_start: that is a *tool* the model calls.
 * This is an *operator* control — the user forks work without bloating
 * the parent transcript.
 */

import { getSubAgentRunner } from '../tools/builtin/task.js';
import { getOperatorHub } from '../operator/hub.js';
import { logger } from '../utils/logger.js';

export type SideRunStatus = 'running' | 'done' | 'failed' | 'cancelled';

export interface SideRun {
  id: string;
  prompt: string;
  sessionId: string;
  status: SideRunStatus;
  startedAt: number;
  finishedAt?: number;
  result?: string;
  error?: string;
}

const runs = new Map<string, SideRun>();
const listeners = new Set<(run: SideRun) => void>();
let seq = 0;

function notify(run: SideRun): void {
  for (const fn of listeners) {
    try { fn(run); } catch { /* listener must not break the registry */ }
  }
}

export function onSideRunChange(fn: (run: SideRun) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function listSideRuns(): SideRun[] {
  return [...runs.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export function getSideRun(id: string): SideRun | undefined {
  const exact = runs.get(id);
  if (exact) return exact;
  return [...runs.values()].find(r => r.id.startsWith(id) || r.sessionId.includes(id));
}

export function stopSideRun(id: string): boolean {
  const run = getSideRun(id);
  if (!run || run.status !== 'running') return false;
  const ac = abortById.get(run.id);
  ac?.abort();
  run.status = 'cancelled';
  run.finishedAt = Date.now();
  notify(run);
  return true;
}

const abortById = new Map<string, AbortController>();

export function startSideRun(prompt: string, parentSessionId: string): SideRun | { error: string } {
  const runner = getSubAgentRunner();
  if (!runner) {
    return { error: 'Sub-agents are off. Set subagents.mode: sequential (or parallel) in ~/.qodex/config.yaml.' };
  }
  const trimmed = prompt.trim();
  if (!trimmed) return { error: 'Usage: /background <what to do in parallel>' };

  seq += 1;
  const id = `bg${seq}`;
  const sessionId = `${parentSessionId}/${id}`;
  const ac = new AbortController();
  abortById.set(id, ac);

  const run: SideRun = {
    id,
    prompt: trimmed,
    sessionId,
    status: 'running',
    startedAt: Date.now(),
  };
  runs.set(id, run);
  notify(run);

  const hub = getOperatorHub();

  void (async () => {
    try {
      const result = await runner(trimmed, {
        maxIterations: 0,
        signal: ac.signal,
        sessionId,
        executionMode: 'normal',
        askUser: (prompt, options) => hub.requestApproval(id, prompt, options ?? ['yes', 'no']),
        onToolUI: (ev) => {
          if (ev.type === 'shell-stdout') hub.emitLive(id, 'out', ev.line);
          else if (ev.type === 'shell-stderr') hub.emitLive(id, 'err', ev.line);
          else if (ev.type === 'progress') hub.emitLive(id, 'progress', ev.message);
        },
      });
      if (ac.signal.aborted) {
        run.status = 'cancelled';
      } else if (result.ok) {
        run.status = 'done';
        run.result = result.finalText;
      } else {
        run.status = 'failed';
        run.error = result.error;
        run.result = result.finalText;
      }
    } catch (e: any) {
      run.status = ac.signal.aborted ? 'cancelled' : 'failed';
      run.error = e?.message ?? String(e);
    } finally {
      run.finishedAt = Date.now();
      abortById.delete(id);
      logger.info('Side run finished', { id, status: run.status });
      notify(run);
    }
  })();

  return run;
}
