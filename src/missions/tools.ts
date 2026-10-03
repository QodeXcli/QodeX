/**
 * Mission tools — let the agent start, watch and steer long-running background
 * missions, and let a mission's own steps report progress.
 *
 *   mission_start      create a mission + spawn its detached worker (or run inline)
 *   mission_status     status, steps, milestones, pending approvals, live view
 *   mission_list       recent missions
 *   mission_cancel     stop a mission
 *   mission_milestone  (inside a mission step only) record a progress milestone
 *
 * Approvals are deliberately NOT a tool: a mission's pending approvals must be
 * answered by a human (CLI, control center, Telegram) — never by an agent.
 *
 * The formatters here are shared by the CLI (`qodex mission status|list|attach`).
 */
import { z } from 'zod';
import * as path from 'path';
import { Tool, type ToolContext, type ToolResult } from '../tools/base.js';
import { getBus } from '../control/bus.js';
import { resolveMissionsConfig } from '../config/agent-config.js';
import { getActiveConfig } from '../config/loader.js';
import { notifyDesktop } from '../utils/notify.js';
import { isApproval } from '../control/approvals.js';
import { maskSecrets } from '../sentinel/policy.js';
import { fenceUntrusted, scanInjection } from '../sentinel/injection.js';
import { getMissionStore, type MissionEvent, type MissionStore } from './store.js';
import { getMissionContext, type AskUser, type MissionRunResult } from './runner.js';
import {
  startMission, cancelMission, summarizeMission, listMissionSummaries, type MissionSummary,
} from './daemon.js';

// ── formatting (shared with the CLI) ──────────────────────────────────────────

function oneLine(s: string | null | undefined, max: number): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

export function relTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toTimeString().slice(0, 8);
}

export function statusLabel(s: Pick<MissionSummary, 'status' | 'pendingApprovals'>): string {
  if (s.status === 'awaiting_approval' || s.pendingApprovals.length) return 'awaiting approval';
  return s.status;
}

/** One line per mission for lists. */
export function formatMissionLine(s: MissionSummary, now: number = Date.now()): string {
  const prog = s.steps.total ? `${s.steps.done}/${s.steps.total}` : '—';
  return `${s.id}  ${statusLabel(s).padEnd(17)}  ${prog.padStart(5)}  $${s.costUsd.toFixed(2).padStart(6)}  ${relTime(s.createdAt, now).padStart(8)}  ${oneLine(s.goal, 70)}`;
}

const STEP_MARK: Record<string, string> = { pending: '·', running: '▶', done: '✓', failed: '✗', skipped: '⤼' };

/**
 * A mission's live view URL carries its control center's access token, which
 * grants everything the dashboard can do — including answering approvals. Text
 * an agent can read (tool results, the worker log) gets it without the token, so
 * an agent can never open the dashboard in its own browser and approve its own
 * critical actions.
 */
export function redactLiveUrl(url: string | null | undefined): string {
  const u = String(url ?? '');
  return u.replace(/([?&#](?:k|token|key)=)[^&#\s]+/gi, '$1…');
}

/** Multi-line status report of one mission (the live view's token only with revealLiveUrl). */
export function formatMissionStatus(
  store: MissionStore,
  s: MissionSummary,
  opts: { milestones?: number; now?: number; /** Show the live URL with its token (human-only output). */ revealLiveUrl?: boolean } = {},
): string {
  const now = opts.now ?? Date.now();
  const lines: string[] = [];
  const prog = s.steps.total ? ` (${s.steps.done}/${s.steps.total} steps done)` : '';
  lines.push(`Mission ${s.id} — ${statusLabel(s)}${prog}`);
  lines.push(`Goal: ${s.goal}`);
  lines.push(`Dir: ${s.cwd}${s.model ? ` · Model: ${s.model}` : ''} · Approvals: ${s.approvalMode === 'auto' ? 'auto (critical actions still ask)' : 'ask a human'}`);
  const cap = s.costCapUsd > 0 ? ` (cap $${s.costCapUsd.toFixed(2)})` : '';
  lines.push(`Created ${relTime(s.createdAt, now)}${s.startedAt ? ` · started ${relTime(s.startedAt, now)}` : ''}${s.finishedAt ? ` · finished ${relTime(s.finishedAt, now)}` : ''} · Cost $${s.costUsd.toFixed(4)}${cap} · Tokens ${s.tokensIn} in / ${s.tokensOut} out`);
  if (s.workerPid) lines.push(`Worker: pid ${s.workerPid} (${s.workerAlive ? 'alive' : 'not running'})${s.logFile ? ` · Log: ${s.logFile}` : ''}`);
  if (s.liveUrl) {
    lines.push(opts.revealLiveUrl
      ? `Live view: ${s.liveUrl}`
      : `Live view: ${redactLiveUrl(s.liveUrl)} (the user opens it with: qodex mission status ${s.id})`);
  }

  const steps = store.steps(s.id);
  if (steps.length) {
    lines.push('', 'Steps:');
    for (const st of steps) {
      let deps: string[] = [];
      try { deps = JSON.parse(st.depends_on_json || '[]'); } catch { /* ignore */ }
      const extra: string[] = [];
      if (st.attempts > 1 || (st.attempts === 1 && st.status === 'running')) extra.push(`attempt ${st.attempts}`);
      if (deps.length && st.status === 'pending') extra.push(`after ${deps.join(', ')}`);
      lines.push(`  ${STEP_MARK[st.status] ?? '·'} [${st.id}] ${oneLine(st.title, 80)}${extra.length ? `  (${extra.join('; ')})` : ''}`);
      if (st.status === 'done' && st.result) lines.push(`      → ${oneLine(st.result, 160)}`);
      if ((st.status === 'failed' || st.status === 'skipped' || (st.status === 'pending' && st.attempts > 0)) && st.error) {
        lines.push(`      ! ${oneLine(st.error, 160)}`);
      }
    }
  } else if (s.status === 'planning') {
    lines.push('', 'Planning the steps…');
  }

  if (s.pendingApprovals.length) {
    lines.push('', 'Pending approvals — a HUMAN must answer (the agent cannot):');
    for (const a of s.pendingApprovals) {
      lines.push(`  ${a.id}${a.category ? ` [${a.category}]` : ''}: ${oneLine(a.prompt, 200)}  (options: ${a.options.join(' / ')})`);
      lines.push(`    → qodex mission approve ${s.id} ${a.id}   ·   qodex mission deny ${s.id} ${a.id}`);
    }
  }

  const ms = store.recentEvents(s.id, opts.milestones ?? 5, ['milestone']);
  if (ms.length) {
    lines.push('', 'Recent milestones:');
    for (const e of ms) lines.push(`  ${clock(e.ts)} ★ ${formatMilestone(e.payload)}`);
  }
  if (s.error && s.status !== 'completed') lines.push('', `Note: ${s.error}`);
  const report = store.get(s.id)?.report;
  if (report && (s.status === 'completed' || s.status === 'failed')) {
    lines.push('', 'Report:', report.length > 4000 ? report.slice(0, 4000) + '\n… (truncated)' : report);
  }
  return lines.join('\n');
}

function formatMilestone(p: any): string {
  const title = String(p?.title ?? '').trim();
  const pct = typeof p?.progress === 'number' ? ` (${Math.round(p.progress)}%)` : '';
  const detail = p?.detail ? ` — ${oneLine(String(p.detail), 160)}` : '';
  return `${title}${pct}${detail}`;
}

/** One human-readable line for a mission event (attach / logs / foreground). */
export function formatEventLine(ev: Pick<MissionEvent, 'ts' | 'type' | 'payload'>): string | null {
  const p = ev.payload ?? {};
  const step = p.stepId ? `[${p.stepId}] ` : '';
  let text: string | null;
  switch (ev.type) {
    case 'created': text = `● mission created: ${oneLine(p.goal, 120)}`; break;
    case 'planning': text = '… planning'; break;
    case 'plan': text = `▤ plan: ${(p.steps ?? []).map((s: any) => `[${s.id}] ${oneLine(s.title, 40)}`).join(' → ')}${p.fallback ? ' (single-step fallback)' : ''}`; break;
    case 'status': text = `◆ status: ${p.from ? `${p.from} → ` : ''}${p.to}${p.error ? ` — ${oneLine(p.error, 160)}` : ''}`; break;
    case 'step-start': text = `▶ ${step}${oneLine(p.title, 80)}${p.attempt > 1 ? ` (attempt ${p.attempt})` : ''}`; break;
    case 'step-done': text = `✓ ${step}${oneLine(p.title, 60)} — ${oneLine(p.excerpt, 160)}`; break;
    case 'step-retry': text = `↻ ${step}attempt ${p.attempt} failed, retrying: ${oneLine(p.error, 160)}`; break;
    case 'step-failed': text = `✗ ${step}${oneLine(p.title, 60)} failed: ${oneLine(p.error, 160)}`; break;
    case 'step-skipped': text = `⤼ ${step}skipped (dependency ${p.because} did not complete)`; break;
    case 'step-interrupted': text = `⏸ ${step}interrupted (${p.reason})`; break;
    case 'milestone': text = `★ ${step}${formatMilestone(p)}`; break;
    case 'tool': text = `  · ${step}${p.name} ${p.ok ? '✓' : '✗'}${p.excerpt && !p.ok ? ` ${oneLine(p.excerpt, 100)}` : ''}`; break;
    case 'notice': text = `  ⓘ ${step}${oneLine(p.message, 200)}`; break;
    case 'approval':
    case 'approval-requested': text = `⚠ approval needed ${p.approvalId}${p.category ? ` [${p.category}]` : ''}: ${oneLine(p.prompt, 200)} (${(p.options ?? []).join(' / ')})`; break;
    case 'approval-resolved': text = `✔ approval ${p.approvalId} → ${p.answer} (by ${p.by})`; break;
    case 'approval-expired': text = `⌛ approval ${p.approvalId} expired (${p.reason})`; break;
    case 'cost-cap': text = `$ cost cap reached: $${Number(p.spentUsd ?? 0).toFixed(2)} of $${Number(p.capUsd ?? 0).toFixed(2)}`; break;
    case 'cost-cap-raised': text = `$ cost cap raised to $${Number(p.capUsd ?? 0).toFixed(2)}`; break;
    case 'steer': text = `➜ steering note: ${oneLine(p.note, 200)}`; break;
    case 'steer-applied': text = `➜ steering ${p.queued ? 'queued for the next step' : `applied to ${(p.steps ?? []).join(', ')}`}`; break;
    case 'report': text = `▣ report: ${oneLine(p.excerpt, 300)}`; break;
    case 'worker-spawned': text = `⚙ worker started (pid ${p.pid})`; break;
    case 'cancel-requested': text = `■ cancel requested (by ${p.by ?? '?'})`; break;
    case 'resume-requested': text = `↺ resume requested${p.retriedSteps ? ` (${p.retriedSteps} step(s) to retry)` : ''}`; break;
    case 'resumed': text = `↺ resumed (${p.stepsRequeued} step(s) re-queued)`; break;
    case 'auto-approved': text = `  ✓ auto-approved: ${oneLine(p.prompt, 160)} → ${p.answer}`; break;
    case 'reporting': text = '… writing the final report'; break;
    case 'steer-injected': text = `➜ ${step}steering note reached the agent`; break;
    case 'completed':
    case 'failed':
    case 'cancelled':
    case 'paused': {
      const mark = ev.type === 'completed' ? '■ ✓' : ev.type === 'failed' ? '■ ✗' : '■';
      const steps = typeof p.stepsDone === 'number' ? ` — ${p.stepsDone} step(s) done${p.stepsFailed ? `, ${p.stepsFailed} failed` : ''}` : '';
      const cost = typeof p.costUsd === 'number' && p.costUsd > 0 ? ` · $${p.costUsd.toFixed(4)}` : '';
      text = `${mark} mission ${ev.type}${steps}${cost}${p.error ? ` — ${oneLine(p.error, 200)}` : ''}`;
      break;
    }
    default: text = `${ev.type}${ev.payload ? ` ${oneLine(JSON.stringify(ev.payload), 160)}` : ''}`;
  }
  return text ? `[${clock(ev.ts)}] ${text}` : null;
}

// ── inline (in-process) mission runner, registered by integration ─────────────

export type InlineMissionRunner = (
  missionId: string,
  opts: { signal?: AbortSignal; askUser?: AskUser; onProgress?: (message: string) => void },
) => Promise<MissionRunResult>;

let inlineRunner: InlineMissionRunner | null = null;
/** Enable `mission_start {detach:false}` in this process (see createInlineMissionRunner). */
export function setMissionInlineRunner(r: InlineMissionRunner | null): void {
  inlineRunner = r;
}
export function getMissionInlineRunner(): InlineMissionRunner | null {
  return inlineRunner;
}

function err(content: string): ToolResult {
  return { content, isError: true };
}

/**
 * Starting a mission launches autonomous work that outlives this session and
 * spends model budget, so it goes through the permission flow exactly like the
 * equivalent shell command (`qodex mission start …`) would: allowed by `/auto` or
 * an autoApprove rule, refused by autoReject, otherwise the user is asked. Without
 * this, text planted in a web page could make the agent start detached work the
 * user never sees being created.
 */
async function confirmMissionStart(goal: string, cwd: string, detach: boolean, ctx: ToolContext): Promise<ToolResult | null> {
  const operation = `mission_start ${oneLine(goal, 400)}`;
  const description = detach ? 'start a background mission' : 'run a mission in this session';
  let decision: 'allow' | 'ask' | 'deny' = 'ask';
  try {
    decision = ctx.permissions ? ctx.permissions.evaluate({ tool: 'mission_start', operation, description }) : 'ask';
  } catch {
    decision = 'ask';
  }
  if (decision === 'allow') return null;
  if (decision === 'deny') {
    return err('[PERMISSION_DENIED] Starting this mission was blocked by your security.autoReject rules.');
  }
  try { ctx.emit({ type: 'permission-request', tool: 'mission_start', operation, description }); } catch { /* UI only */ }
  const options = ['yes', 'no'];
  let answer = 'no';
  try {
    answer = await ctx.askUser(
      `Start a ${detach ? 'background ' : ''}mission?\n  Goal: ${oneLine(goal, 400)}\n  Dir: ${cwd}` +
      (detach ? '\n  It keeps working after this session ends; its approvals reach you via qodex mission approve, the control center or Telegram.' : ''),
      options,
    );
  } catch {
    answer = 'no';
  }
  if (isApproval(answer, options)) return null;
  return err('[USER_REJECTED] The user declined to start this mission. Do not retry; ask the user how to proceed.');
}

function errMessage(e: any, code: string): string {
  const m = String(e?.message ?? e);
  return /^\[[A-Z_]+\]/.test(m) ? m : `[${code}] ${m}`;
}

// ── tools ─────────────────────────────────────────────────────────────────────

const StartArgs = z.object({
  goal: z.string().min(1).describe(
    'The complete goal of the mission. It runs WITHOUT this conversation\'s context, so include every detail: ' +
    'what to do, constraints, where to save results and what "done" means.'),
  cwd: z.string().describe('Working directory for the mission (default: the current directory).').optional(),
  detach: z.boolean().describe(
    'true (default): run in a detached background worker that survives this session. ' +
    'false: run inside this session and wait for the final report.').optional(),
});

export class MissionStartTool extends Tool<z.infer<typeof StartArgs>> {
  name = 'mission_start';
  description =
    'Start a long-running autonomous MISSION that keeps working in the background after this session ends ' +
    '(it plans its own steps, runs them with fresh agents, retries failures, reports milestones and writes a final report). ' +
    'Use it for long or multi-hour goals ("monitor X and report", "research and compile...", "migrate the whole project...") — ' +
    'NOT for quick tasks you can do now. Permission prompts and risky actions wait for the user\'s approval ' +
    '(qodex mission approve, the control center, or Telegram). Returns the mission id; check it with mission_status.';
  isReadOnly = false;
  isDestructive = false;
  /** An inline (detach:false) mission can run for hours. */
  timeoutSeconds = 0;
  argsSchema = StartArgs;

  async execute(args: z.infer<typeof StartArgs>, ctx: ToolContext): Promise<ToolResult> {
    const inMission = getMissionContext();
    if (inMission) {
      return err(`[MISSION_NESTED] You are already running inside mission ${inMission.missionId}. Do the work directly in this step ` +
        '(report progress with mission_milestone) instead of starting another mission.');
    }
    const cwd = args.cwd ? path.resolve(ctx.cwd, args.cwd) : ctx.cwd;
    const detach = args.detach ?? true;
    const refused = await confirmMissionStart(args.goal, cwd, detach, ctx);
    if (refused) return refused;
    const store = getMissionStore();

    if (!detach) {
      const runner = inlineRunner;
      if (!runner) {
        return err('[MISSION_INLINE_UNAVAILABLE] Inline missions are not enabled in this QodeX process. Call mission_start with detach: true (the default) to run it in the background.');
      }
      let id: string;
      try {
        id = startMission({ goal: args.goal, cwd, source: 'tool', spawn: false }, { store }).mission.id;
      } catch (e: any) {
        return err(errMessage(e, 'MISSION_START_FAILED'));
      }
      ctx.emit({ type: 'progress', message: `Mission ${id} started (inline)` });
      const r = await runner(id, {
        signal: ctx.signal,
        askUser: ctx.askUser,
        onProgress: (message) => ctx.emit({ type: 'progress', message }),
      });
      const summary = summarizeMission(store, id);
      const body = summary ? formatMissionStatus(store, summary) : `Mission ${id}: ${r.status}`;
      // The status/report relays what the mission's steps read (web pages, emails…):
      // hand it to the model as data, keeping our own first line trusted.
      const data = fenceUntrusted(body, `mission ${id} status and report`, scanInjection(body));
      return {
        content: `[MISSION_${r.status.toUpperCase()}] Mission ${id} finished with status ${r.status}.\n\n${data}`,
        isError: r.status === 'failed',
        metadata: { missionId: id, status: r.status },
      };
    }

    try {
      const { mission, pid, logFile } = startMission({ goal: args.goal, cwd, source: 'tool' }, { store });
      ctx.emit({ type: 'progress', message: `Mission ${mission.id} started in the background (pid ${pid})` });
      return {
        content:
          `[MISSION_STARTED] Mission ${mission.id} is now running in the background (worker pid ${pid}).\n` +
          `Goal: ${oneLine(mission.goal, 300)}\n` +
          `Dir: ${mission.cwd}\n` +
          `It plans its own steps, reports milestones, and keeps going after this session ends.\n` +
          `Watch: \`qodex mission attach ${mission.id}\` · status: mission_status {"id":"${mission.id}"} · log: ${logFile}\n` +
          `Permission prompts wait for the user: \`qodex mission approve ${mission.id}\` (or the control center / Telegram).\n` +
          `Stop: mission_cancel {"id":"${mission.id}"}.`,
        metadata: { missionId: mission.id, pid, logFile },
      };
    } catch (e: any) {
      return err(errMessage(e, 'MISSION_START_FAILED'));
    }
  }
}

const StatusArgs = z.object({
  id: z.string().describe('Mission id (or a unique prefix). Default: the current mission, else the latest one.').optional(),
});

export class MissionStatusTool extends Tool<z.infer<typeof StatusArgs>> {
  name = 'mission_status';
  description =
    'Show a mission\'s status: steps (done/running/pending/failed), recent milestones, pending human approvals, cost, ' +
    'live-view URL and, when finished, the final report. Without an id: the current/latest mission.';
  isReadOnly = true;
  isDestructive = false;
  /** Step results, milestones and the report relay web pages / emails / files. */
  untrustedOutput = true;
  argsSchema = StatusArgs;

  async execute(args: z.infer<typeof StatusArgs>, ctx: ToolContext): Promise<ToolResult> {
    const store = getMissionStore();
    let row;
    if (args.id) {
      row = store.resolve(args.id);
      if (!row) return err(`[MISSION_NOT_FOUND] No mission matches "${args.id}". List them with mission_list.`);
    } else {
      const inMission = getMissionContext();
      row = (inMission ? store.get(inMission.missionId) : undefined) ?? store.latest(ctx.cwd) ?? store.latest();
      if (!row) return { content: 'No missions yet. Start one with mission_start.' };
    }
    const s = summarizeMission(store, row);
    if (!s) return err(`[MISSION_NOT_FOUND] Mission ${row.id} disappeared.`);
    return { content: formatMissionStatus(store, s), metadata: { missionId: s.id, status: s.status } };
  }
}

const ListArgs = z.object({
  limit: z.number().int().min(1).max(100).describe('How many recent missions to list (default 10).').optional(),
});

export class MissionListTool extends Tool<z.infer<typeof ListArgs>> {
  name = 'mission_list';
  description = 'List recent missions (newest first): id, status, steps done, cost, age and goal.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = ListArgs;

  async execute(args: z.infer<typeof ListArgs>): Promise<ToolResult> {
    const list = listMissionSummaries({ limit: args.limit ?? 10 });
    if (!list.length) return { content: 'No missions yet. Start one with mission_start.' };
    const now = Date.now();
    return {
      content: `${list.length} mission(s), newest first:\n` + list.map(s => formatMissionLine(s, now)).join('\n'),
      metadata: { count: list.length },
    };
  }
}

const CancelArgs = z.object({
  id: z.string().min(1).describe('Mission id (or a unique prefix) to cancel.'),
});

export class MissionCancelTool extends Tool<z.infer<typeof CancelArgs>> {
  name = 'mission_cancel';
  description = 'Cancel a running or paused mission. Its worker stops at the next safe point; finished steps keep their results.';
  isReadOnly = false;
  isDestructive = false;
  argsSchema = CancelArgs;

  async execute(args: z.infer<typeof CancelArgs>): Promise<ToolResult> {
    const r = cancelMission(args.id, { by: 'agent' });
    return r.ok ? { content: r.message, metadata: { missionId: r.mission?.id, signalled: r.signalled } } : err(r.message);
  }
}

const MilestoneArgs = z.object({
  title: z.string().min(1).describe('Short milestone, e.g. "Logged in", "Found 12 candidates", "All tests pass".'),
  detail: z.string().describe('Optional details or evidence (URLs, numbers, file paths).').optional(),
  progress: z.number().min(0).max(100).describe('Optional overall progress of this step, 0-100.').optional(),
});

let lastMilestoneNotify = 0;

export class MissionMilestoneTool extends Tool<z.infer<typeof MilestoneArgs>> {
  name = 'mission_milestone';
  description =
    'Record a progress milestone of the mission step you are executing (shown to the user in the mission timeline, ' +
    'control center and Telegram). Only works inside a mission.';
  isReadOnly = false;
  isDestructive = false;
  argsSchema = MilestoneArgs;

  async execute(args: z.infer<typeof MilestoneArgs>): Promise<ToolResult> {
    const mc = getMissionContext();
    if (!mc) {
      return err('[NOT_IN_MISSION] mission_milestone only works inside a running mission step. To run long work in the background, use mission_start.');
    }
    const store = mc.store ?? getMissionStore();
    const mission = store.get(mc.missionId);
    if (!mission) return err(`[NOT_IN_MISSION] Mission ${mc.missionId} was not found.`);
    let stepId = mc.stepId;
    if (!stepId) {
      const running = store.steps(mission.id).filter(s => s.status === 'running');
      if (running.length === 1) stepId = running[0]!.id;
    }
    // Milestones fan out to the timeline, the control center, Telegram and desktop
    // notifications: mask anything secret-looking the agent put in them.
    const title = oneLine(maskSecrets(args.title.slice(0, 2000)), 200);
    const detail = args.detail ? maskSecrets(args.detail.trim().slice(0, 2000)) : undefined;
    const progress = typeof args.progress === 'number' && Number.isFinite(args.progress)
      ? Math.max(0, Math.min(100, args.progress)) : undefined;
    const payload = { stepId: stepId ?? undefined, title, detail, progress };
    store.appendEvent(mission.id, 'milestone', payload);
    getBus().publish({ kind: 'mission', missionId: mission.id, type: 'milestone', data: payload });

    if (resolveMissionsConfig(getActiveConfig()).notify && Date.now() - lastMilestoneNotify > 60_000) {
      lastMilestoneNotify = Date.now();
      void notifyDesktop({
        title: `QodeX mission ${mission.id}`,
        subtitle: oneLine(mission.goal, 60),
        message: `★ ${title}${progress !== undefined ? ` (${Math.round(progress)}%)` : ''}`,
      }).catch(() => {});
    }
    return { content: `✓ Milestone recorded: ${title}${progress !== undefined ? ` (${Math.round(progress)}%)` : ''}` };
  }
}

/** Every mission tool class — the integration step registers `new T()` for each. */
export const MISSION_TOOL_CLASSES = [
  MissionStartTool,
  MissionStatusTool,
  MissionListTool,
  MissionCancelTool,
  MissionMilestoneTool,
] as const;
