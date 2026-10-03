/**
 * Emergency stop — one command that halts everything QodeX is doing in this process:
 * the running agent turn, side runs (/background), background jobs, dev servers and other
 * managed processes, and (with `missions: true`) every active mission.
 *
 * Surfaces: `/stop` (and `/stop all` for missions too) in the TUI, the control center's
 * Stop button, Telegram `/stop`. Anything that owns cancellable work registers a handler
 * (registerStopHandler) so this module stays free of import cycles; the built-in steps
 * below use public APIs only. Every step is best-effort: one failure never prevents the
 * others, and the report says what was stopped.
 */
import { getBus } from './bus.js';
import { logger } from '../utils/logger.js';

export interface StopReport {
  /** One line per thing that was stopped (empty when nothing was running). */
  stopped: string[];
  /** Steps that failed (best-effort; the rest still ran). */
  errors: string[];
}

/** A registered stopper returns a short description of what it stopped, or null if idle. */
export type StopHandler = (reason: string) => string | null | Promise<string | null>;

const handlers = new Map<string, StopHandler>();

/** Register a stopper (e.g. the TUI's current-run abort). Returns an unregister function. */
export function registerStopHandler(name: string, fn: StopHandler): () => void {
  handlers.set(name, fn);
  return () => { if (handlers.get(name) === fn) handlers.delete(name); };
}

export interface EmergencyStopOptions {
  /** Also cancel active missions (they are not resumable after a cancel). */
  missions?: boolean;
  reason?: string;
  /** Who pressed stop (shown in mission events and the bus notice). */
  by?: string;
  /** Test seams. */
  deps?: Partial<StopDeps>;
}

export interface StopDeps {
  listSideRuns: () => Array<{ id: string; status: string; prompt?: string }>;
  stopSideRun: (id: string) => boolean;
  stopManagedProcesses: () => Promise<number>;
  listActiveMissions: () => Array<{ id: string; goal?: string }>;
  cancelMission: (id: string, by: string) => { ok: boolean; message: string };
}

async function defaultDeps(): Promise<StopDeps> {
  return {
    listSideRuns: () => [],
    stopSideRun: () => false,
    stopManagedProcesses: async () => 0,
    listActiveMissions: () => [],
    cancelMission: () => ({ ok: false, message: 'missions unavailable' }),
    ...(await import('../agent/side-runs.js').then(m => ({
      listSideRuns: () => m.listSideRuns() as Array<{ id: string; status: string; prompt?: string }>,
      stopSideRun: (id: string) => m.stopSideRun(id),
    })).catch(() => ({}))),
    ...(await import('../tools/browser/process-registry.js').then(m => ({
      stopManagedProcesses: async () => {
        const running = m.list().filter(p => p.alive).length;
        await m.stopAll();
        return running;
      },
    })).catch(() => ({}))),
    ...(await import('../missions/daemon.js').then(m => ({
      listActiveMissions: () => m.listMissionSummaries({ activeOnly: true, limit: 100 }).map(s => ({ id: s.id, goal: s.goal })),
      cancelMission: (id: string, by: string) => { const r = m.cancelMission(id, { by }); return { ok: r.ok, message: r.message }; },
    })).catch(() => ({}))),
  };
}

/** Stop everything. Never throws. */
export async function emergencyStop(opts: EmergencyStopOptions = {}): Promise<StopReport> {
  const reason = opts.reason ?? 'emergency stop';
  const by = opts.by ?? 'user';
  const deps: StopDeps = { ...(await defaultDeps()), ...(opts.deps ?? {}) };
  const report: StopReport = { stopped: [], errors: [] };
  const step = async (name: string, fn: () => Promise<void> | void) => {
    try { await fn(); } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      report.errors.push(`${name}: ${msg}`);
      logger.warn('emergency stop step failed', { step: name, err: msg });
    }
  };

  for (const [name, fn] of [...handlers]) {
    await step(name, async () => { const r = await fn(reason); if (r) report.stopped.push(r); });
  }
  await step('side runs', () => {
    for (const r of deps.listSideRuns()) {
      if (r.status === 'running' && deps.stopSideRun(r.id)) report.stopped.push(`side run ${r.id}`);
    }
  });
  await step('processes', async () => {
    const n = await deps.stopManagedProcesses();
    if (n > 0) report.stopped.push(`${n} managed process${n === 1 ? '' : 'es'} (dev servers)`);
  });
  if (opts.missions) {
    await step('missions', () => {
      for (const m of deps.listActiveMissions()) {
        const r = deps.cancelMission(m.id, by);
        if (r.ok) report.stopped.push(`mission ${m.id}${m.goal ? ` (${m.goal.slice(0, 60)})` : ''}`);
        else report.errors.push(`mission ${m.id}: ${r.message}`);
      }
    });
  }

  try {
    getBus().publish({
      kind: 'notice', level: 'warn',
      message: report.stopped.length ? `Emergency stop by ${by}: ${report.stopped.join('; ')}` : `Emergency stop by ${by}: nothing was running`,
    });
  } catch { /* bus is best-effort */ }
  return report;
}

/** Human-readable summary for /stop and channels. PURE. */
export function formatStopReport(r: StopReport, missionsIncluded: boolean): string {
  const lines = r.stopped.length ? ['⏹ Stopped:', ...r.stopped.map(s => `  • ${s}`)] : ['⏹ Nothing was running.'];
  if (r.errors.length) lines.push('Could not stop:', ...r.errors.map(e => `  • ${e}`));
  if (!missionsIncluded) lines.push('Background missions keep running — use /stop all to cancel them too.');
  return lines.join('\n');
}
