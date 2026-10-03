/**
 * Missions — long-running, detached, resumable agent work.
 *
 * Public surface for the rest of QodeX plus the glue other modules plug into:
 *   - MISSION_TOOL_CLASSES            → tool registry
 *   - buildMissionCommand(boot)       → `qodex mission …` (mount in src/index.ts)
 *   - runMissionWorker(id, boot)      → the detached worker body
 *   - createInlineMissionRunner(boot) → enables mission_start {detach:false}
 *   - createMissionControlActions()   → control center `/api/actions/missions.*`
 *   - createMissionChannelAdapter()   → Telegram (and other channel) bots
 *   - startMissionEventBridge()       → mirrors mission events written by worker
 *                                       processes onto THIS process's bus
 */
import { getBus } from '../control/bus.js';
import {
  getMissionStore, approvalOptions, type MissionStore,
} from './store.js';
import { safeLine } from './runner.js';
import {
  startMission, cancelMission, prepareResume, spawnMissionWorker, steerMission,
  answerMissionApproval, answerApprovalById, summarizeMission, listMissionSummaries,
  type MissionSummary,
} from './daemon.js';
import { formatMissionStatus } from './tools.js';

export * from './store.js';
export * from './planner.js';
export * from './runner.js';
export * from './daemon.js';
export * from './tools.js';
export * from './command.js';

export interface MissionPendingApproval {
  id: string;
  missionId: string;
  prompt: string;
  options: string[];
  category: string | null;
  risk: string | null;
  stepId: string | null;
  createdAt: string;
  goal: string;
}

function pendingApprovals(store: MissionStore): MissionPendingApproval[] {
  return store.listPendingApprovals().map(a => ({
    id: a.id,
    missionId: a.mission_id,
    prompt: a.prompt,
    options: approvalOptions(a),
    category: a.category,
    risk: a.risk,
    stepId: a.step_id,
    createdAt: a.created_at,
    goal: store.get(a.mission_id)?.goal ?? '',
  }));
}

function str(v: unknown, name: string, required = true): string {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (required) throw new Error(`[BAD_REQUEST] "${name}" is required`);
  return '';
}

function body(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

/**
 * Handlers for the control center's pluggable actions (registerControlAction).
 * Each takes the JSON body and resolves to a JSON-safe result; bad input throws
 * an Error starting with [BAD_REQUEST] / [MISSION_*].
 */
export function createMissionControlActions(opts: { store?: MissionStore; defaultCwd?: string } = {}): Record<string, (body: unknown) => Promise<unknown>> {
  const store = () => opts.store ?? getMissionStore();
  return {
    'missions.list': async (b) => {
      const o = body(b);
      return listMissionSummaries({ store: store(), limit: Number(o.limit) || 20, activeOnly: o.active === true });
    },
    'missions.status': async (b) => {
      const id = str(body(b).id, 'id');
      const s = store();
      const m = s.resolve(id);
      if (!m) throw new Error(`[MISSION_NOT_FOUND] No mission matches "${id}"`);
      const summary = summarizeMission(s, m)!;
      return {
        ...summary,
        report: s.get(m.id)?.report ?? null,
        stepsDetail: s.steps(m.id).map(st => ({
          id: st.id, title: st.title, status: st.status, attempts: st.attempts,
          result: st.result ? st.result.slice(0, 2000) : null, error: st.error,
        })),
        events: s.recentEvents(m.id, 50),
        text: formatMissionStatus(s, summary),
      };
    },
    'missions.events': async (b) => {
      const o = body(b);
      const id = str(o.id, 'id');
      const m = store().resolve(id);
      if (!m) throw new Error(`[MISSION_NOT_FOUND] No mission matches "${id}"`);
      return store().events(m.id, Number(o.since) || 0, { limit: Math.min(1000, Number(o.limit) || 200) });
    },
    'missions.start': async (b) => {
      const o = body(b);
      const r = startMission({
        goal: str(o.goal, 'goal'),
        cwd: str(o.cwd, 'cwd', false) || opts.defaultCwd,
        model: str(o.model, 'model', false) || null,
        source: 'control',
      }, { store: store() });
      return { id: r.mission.id, pid: r.pid, logFile: r.logFile, status: r.mission.status };
    },
    'missions.cancel': async (b) => cancelMission(str(body(b).id, 'id'), { store: store(), by: 'control' }),
    'missions.resume': async (b) => {
      const id = str(body(b).id, 'id');
      const prep = prepareResume(id, { store: store() });
      if (!prep.ok || !prep.mission) return prep;
      const { pid } = spawnMissionWorker(prep.mission.id, { cwd: prep.mission.cwd, store: store() });
      return { ok: true, message: `Mission ${prep.mission.id} resumed (worker pid ${pid}).`, pid };
    },
    'missions.approve': async (b) => {
      const o = body(b);
      return answerMissionApproval(str(o.id, 'id'), str(o.approvalId, 'approvalId', false) || undefined,
        str(o.answer, 'answer', false) || 'yes', { store: store(), by: 'control' });
    },
    'missions.deny': async (b) => {
      const o = body(b);
      return answerMissionApproval(str(o.id, 'id'), str(o.approvalId, 'approvalId', false) || undefined, 'no', { store: store(), by: 'control' });
    },
    'missions.steer': async (b) => {
      const o = body(b);
      return steerMission(str(o.id, 'id'), str(o.note, 'note'), { store: store(), by: 'control' });
    },
    'missions.approvals': async () => pendingApprovals(store()),
  };
}

/** What a messaging channel (Telegram, ...) needs to drive missions. */
export interface MissionChannelAdapter {
  list(): Promise<MissionSummary[]>;
  start(goal: string): Promise<{ id: string; pid: number | null; message: string }>;
  cancel(id: string): Promise<{ ok: boolean; message: string }>;
  /** Human-readable status text of one mission. */
  status(id: string): Promise<string>;
  pendingApprovals(): Promise<MissionPendingApproval[]>;
  /** Answer a mission approval by id. True when the answer was accepted. */
  resolveApproval(id: string, answer: string, by: string): Promise<boolean>;
}

export function createMissionChannelAdapter(opts: { store?: MissionStore; defaultCwd?: string; source?: string } = {}): MissionChannelAdapter {
  const store = () => opts.store ?? getMissionStore();
  return {
    async list() {
      return listMissionSummaries({ store: store(), limit: 10 });
    },
    async start(goal: string) {
      const r = startMission({ goal, cwd: opts.defaultCwd, source: opts.source ?? 'telegram' }, { store: store() });
      return { id: r.mission.id, pid: r.pid, message: `Mission ${r.mission.id} started.` };
    },
    async cancel(id: string) {
      const r = cancelMission(id, { store: store(), by: opts.source ?? 'telegram' });
      return { ok: r.ok, message: r.message };
    },
    async status(id: string) {
      const s = store();
      const m = s.resolve(id);
      if (!m) return `[MISSION_NOT_FOUND] No mission matches "${id}".`;
      const summary = summarizeMission(s, m);
      return summary ? formatMissionStatus(s, summary) : `Mission ${id} not found.`;
    },
    async pendingApprovals() {
      return pendingApprovals(store());
    },
    async resolveApproval(id: string, answer: string, by: string) {
      return answerApprovalById(id, answer, { store: store(), by }).ok;
    },
  };
}

const BRIDGED_TERMINAL = new Set(['completed', 'failed', 'cancelled', 'paused']);

/** A stored event's bus payload: a 'status' row gains `status` (and, when it ends a run, the report excerpt). */
function bridgedData(store: MissionStore, ev: { missionId: string; type: string; payload: any }): unknown {
  if (ev.type !== 'status' || !ev.payload || typeof ev.payload !== 'object') return ev.payload;
  const to = ev.payload.to;
  const data: Record<string, unknown> = { ...ev.payload, status: to };
  if (BRIDGED_TERMINAL.has(to)) {
    const report = store.get(ev.missionId)?.report;
    if (report) data.report = safeLine(report, 400);
  }
  return data;
}

/**
 * Mirror mission events written by OTHER processes (detached workers, a CLI
 * cancelling) onto this process's bus as `{kind:'mission'}` events, so the
 * control center / Telegram see milestones, approvals and completions of
 * background missions. Exactly one bus event per stored event: a status
 * transition is published once, as `{type:'status', data:{from, to, status,
 * error, report?}}` — the shape the in-process runner publishes — so a timeline
 * renders it once wherever the mission runs. Events this process already put on
 * its bus (a mission run inline here) are skipped, including the final ones read
 * after the run released the mission. Returns a stop function.
 */
export function startMissionEventBridge(opts: { store?: MissionStore; intervalMs?: number; types?: string[] } = {}): () => void {
  const store = opts.store ?? getMissionStore();
  let last = store.maxEventId();
  const timer = setInterval(() => {
    try {
      for (const ev of store.eventsAfter(last, { limit: 500, types: opts.types })) {
        last = ev.id;
        if (store.takeBusPublished(ev.id)) continue;
        getBus().publish({ kind: 'mission', missionId: ev.missionId, type: ev.type, data: bridgedData(store, ev), ts: Date.parse(ev.ts) || Date.now() });
      }
    } catch { /* DB busy — next tick */ }
  }, Math.max(100, opts.intervalMs ?? 2000));
  timer.unref?.();
  return () => clearInterval(timer);
}
