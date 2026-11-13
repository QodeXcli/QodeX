/**
 * Desk board — named teammates on your machine.
 *
 * Grok Bot splits work across Bots that share one cloud computer. Muse keeps
 * one agent and an audit of everything it tried to do. This board is both,
 * without leaving the box: up to six desks, handoffs between them, and a
 * hard stop when a goal would send, spend, delete, publish, or touch a secret.
 */
import { randomBytes } from 'crypto';
import {
  MAX_DESKS,
  canHandoff,
  classifySensitive,
  scrubPacket,
  slugDeskName,
  validateRoutine,
  type RoutineStep,
  type SensitiveKind,
} from './policy.js';

export type { RoutineStep };

export type GoalStatus =
  | 'queued'
  | 'needs-approval'
  | 'approved'
  | 'denied'
  | 'handed-off'
  | 'running'
  | 'done'
  | 'failed';

export interface Goal {
  id: string;
  text: string;
  status: GoalStatus;
  sensitive?: { kind: SensitiveKind; reason: string };
  handoffDepth: number;
  fromDeskId?: string;
  /** Status to restore if a run is killed before it settles. */
  resumeAs?: 'queued' | 'approved';
  result?: string;
  /** Tool calls from the run, scrubbed. `desk teach --from-last` turns these into a routine. */
  trace?: RoutineStep[];
  createdAt: string;
}

export interface Routine {
  id: string;
  name: string;
  steps: RoutineStep[];
  createdAt: string;
}

export interface Desk {
  id: string;
  name: string;
  brief: string;
  cwd: string;
  createdAt: string;
  goals: Goal[];
  routines: Routine[];
}

export interface Board {
  version: 1;
  desks: Desk[];
}

export interface AuditEvent {
  ts: string;
  deskId: string;
  kind: string;
  detail: string;
}

export function emptyBoard(): Board {
  return { version: 1, desks: [] };
}

function id(): string {
  return randomBytes(4).toString('hex');
}

export interface BoardResult<T> {
  ok: boolean;
  state: Board;
  value?: T;
  error?: string;
  audit?: AuditEvent;
}

function audit(deskId: string, kind: string, detail: string, now: string): AuditEvent {
  return { ts: now, deskId, kind, detail: detail.slice(0, 400) };
}

export function createDesk(
  state: Board,
  input: { name: string; brief?: string; cwd: string; now?: string },
): BoardResult<Desk> {
  const now = input.now ?? new Date().toISOString();
  const name = input.name.trim();
  if (!name) return { ok: false, state, error: 'a desk needs a name' };
  if (state.desks.length >= MAX_DESKS) {
    return { ok: false, state, error: `desk cap is ${MAX_DESKS} — close one before adding another` };
  }
  const slug = slugDeskName(name);
  if (state.desks.some(d => d.id === slug || d.name.toLowerCase() === name.toLowerCase())) {
    return { ok: false, state, error: `a desk named "${name}" already exists` };
  }
  const desk: Desk = {
    id: slug,
    name,
    brief: (input.brief ?? '').replace(/\s+/g, ' ').trim().slice(0, 240),
    cwd: input.cwd,
    createdAt: now,
    goals: [],
    routines: [],
  };
  return {
    ok: true,
    state: { ...state, desks: [...state.desks, desk] },
    value: desk,
    audit: audit(desk.id, 'create', `desk "${desk.name}" @ ${desk.cwd}`, now),
  };
}

export function postGoal(
  state: Board,
  input: {
    deskId: string;
    text: string;
    now?: string;
    handoffDepth?: number;
    fromDeskId?: string;
    /** Set when the original text was sensitive even if `text` has been scrubbed. */
    hold?: { kind: SensitiveKind; reason: string };
  },
): BoardResult<Goal> {
  const now = input.now ?? new Date().toISOString();
  const desk = state.desks.find(d => d.id === input.deskId);
  if (!desk) return { ok: false, state, error: `no desk "${input.deskId}"` };
  const text = input.text.replace(/\s+/g, ' ').trim();
  if (!text) return { ok: false, state, error: 'a goal needs text' };
  const verdict = classifySensitive(text);
  const hold = input.hold ?? (verdict.sensitive ? { kind: verdict.kind, reason: verdict.reason } : undefined);
  const goal: Goal = {
    id: id(),
    text: text.slice(0, 500),
    status: hold ? 'needs-approval' : 'queued',
    handoffDepth: input.handoffDepth ?? 0,
    fromDeskId: input.fromDeskId,
    createdAt: now,
    ...(hold ? { sensitive: hold } : {}),
  };
  const desks = state.desks.map(d => d.id === desk.id ? { ...d, goals: [...d.goals, goal] } : d);
  return {
    ok: true,
    state: { ...state, desks },
    value: goal,
    audit: audit(desk.id, hold ? 'hold' : 'goal', `${goal.status}: ${goal.text}`, now),
  };
}

export function decideGoal(
  state: Board,
  input: { deskId: string; goalId: string; allow: boolean; now?: string },
): BoardResult<Goal> {
  const now = input.now ?? new Date().toISOString();
  const desk = state.desks.find(d => d.id === input.deskId);
  if (!desk) return { ok: false, state, error: `no desk "${input.deskId}"` };
  const goal = desk.goals.find(g => g.id === input.goalId);
  if (!goal) return { ok: false, state, error: `no goal "${input.goalId}"` };
  if (goal.status !== 'needs-approval') {
    return { ok: false, state, error: `goal is ${goal.status}, not waiting for approval` };
  }
  const next: Goal = { ...goal, status: input.allow ? 'approved' : 'denied' };
  const desks = state.desks.map(d => d.id === desk.id
    ? { ...d, goals: d.goals.map(g => g.id === goal.id ? next : g) }
    : d);
  return {
    ok: true,
    state: { ...state, desks },
    value: next,
    audit: audit(desk.id, input.allow ? 'approve' : 'deny', `${goal.id} ${goal.sensitive?.kind ?? ''} ${goal.text}`, now),
  };
}

export function handoff(
  state: Board,
  input: { fromId: string; toId: string; note: string; now?: string },
): BoardResult<Goal> {
  const now = input.now ?? new Date().toISOString();
  const from = state.desks.find(d => d.id === input.fromId);
  if (!from) return { ok: false, state, error: `no desk "${input.fromId}"` };
  const open = [...from.goals].reverse().find(g => g.status === 'queued' || g.status === 'approved');
  const depth = (open?.handoffDepth ?? 0) + 1;
  const check = canHandoff({
    fromId: input.fromId,
    toId: input.toId,
    depth: open?.handoffDepth ?? 0,
    knownIds: state.desks.map(d => d.id),
  });
  if (!check.ok) return { ok: false, state, error: check.reason };
  const raw = input.note.trim() || open?.text || '';
  const original = classifySensitive(raw);
  const scrubbed = scrubPacket(raw);
  if (!scrubbed.text) return { ok: false, state, error: 'nothing to hand off' };

  let next = state;
  if (open) {
    next = {
      ...state,
      desks: state.desks.map(d => d.id === from.id
        ? { ...d, goals: d.goals.map(g => g.id === open.id ? { ...g, status: 'handed-off' as const } : g) }
        : d),
    };
  }
  const posted = postGoal(next, {
    deskId: input.toId,
    text: scrubbed.text,
    now,
    handoffDepth: depth,
    fromDeskId: from.id,
    hold: original.sensitive ? { kind: original.kind, reason: original.reason } : undefined,
  });
  if (!posted.ok || !posted.value) return posted;
  const redacted = scrubbed.redacted ? ` (${scrubbed.redacted} secret(s) stripped)` : '';
  return {
    ...posted,
    audit: audit(from.id, 'handoff', `→ ${input.toId}: ${posted.value.text}${redacted}`, now),
  };
}

export function teachRoutine(
  state: Board,
  input: { deskId: string; name: string; steps: RoutineStep[]; now?: string },
): BoardResult<Routine> {
  const now = input.now ?? new Date().toISOString();
  const desk = state.desks.find(d => d.id === input.deskId);
  if (!desk) return { ok: false, state, error: `no desk "${input.deskId}"` };
  const name = input.name.trim();
  if (!name) return { ok: false, state, error: 'a routine needs a name' };
  const checked = validateRoutine(input.steps);
  if (!checked.ok) return { ok: false, state, error: checked.reason };
  const routine: Routine = { id: id(), name: name.slice(0, 60), steps: checked.steps, createdAt: now };
  const desks = state.desks.map(d => d.id === desk.id ? { ...d, routines: [...d.routines, routine] } : d);
  return {
    ok: true,
    state: { ...state, desks },
    value: routine,
    audit: audit(desk.id, 'routine', `${routine.name} (${routine.steps.length} steps)`, now),
  };
}

function isRunnable(goal: Goal): boolean {
  if (goal.status !== 'queued' && goal.status !== 'approved') return false;
  // A sensitive goal is runnable only after a person allowed it.
  if (goal.sensitive && goal.status !== 'approved') return false;
  return true;
}

/** Oldest queued or approved goal. Does not mutate. Held goals are invisible here. */
export function peekRunnable(desk: Desk | undefined): Goal | undefined {
  if (!desk) return undefined;
  return desk.goals.find(isRunnable);
}

export function claimGoal(
  state: Board,
  input: { deskId: string; now?: string },
): BoardResult<Goal> {
  const now = input.now ?? new Date().toISOString();
  const desk = state.desks.find(d => d.id === input.deskId);
  if (!desk) return { ok: false, state, error: `no desk "${input.deskId}"` };
  const goal = peekRunnable(desk);
  if (!goal) {
    return { ok: false, state, error: 'nothing runnable — held goals stay held until you allow them' };
  }
  const resumeAs = goal.status === 'approved' ? 'approved' as const : 'queued' as const;
  const next: Goal = { ...goal, status: 'running', resumeAs };
  const desks = state.desks.map(d => d.id === desk.id
    ? { ...d, goals: d.goals.map(g => g.id === goal.id ? next : g) }
    : d);
  return {
    ok: true,
    state: { ...state, desks },
    value: next,
    audit: audit(desk.id, 'claim', `${goal.id} ${goal.text}`, now),
  };
}

export function settleGoal(
  state: Board,
  input: { deskId: string; goalId: string; ok: boolean; summary?: string; trace?: RoutineStep[]; now?: string },
): BoardResult<Goal> {
  const now = input.now ?? new Date().toISOString();
  const desk = state.desks.find(d => d.id === input.deskId);
  if (!desk) return { ok: false, state, error: `no desk "${input.deskId}"` };
  const goal = desk.goals.find(g => g.id === input.goalId);
  if (!goal) return { ok: false, state, error: `no goal "${input.goalId}"` };
  if (goal.status !== 'running') {
    return { ok: false, state, error: `goal is ${goal.status}, not running` };
  }
  const summary = scrubPacket(input.summary ?? (input.ok ? 'done' : 'failed')).text.replace(/\s+/g, ' ').trim().slice(0, 400);
  const trace = cleanTrace(input.trace);
  const next: Goal = {
    ...goal,
    status: input.ok ? 'done' : 'failed',
    result: summary || (input.ok ? 'done' : 'failed'),
    ...(trace ? { trace } : {}),
  };
  delete next.resumeAs;
  const desks = state.desks.map(d => d.id === desk.id
    ? { ...d, goals: d.goals.map(g => g.id === goal.id ? next : g) }
    : d);
  return {
    ok: true,
    state: { ...state, desks },
    value: next,
    audit: audit(desk.id, input.ok ? 'done' : 'fail', `${goal.id} ${next.result}`, now),
  };
}

/** Put a killed run back. An approved goal stays approved — releasing must not drop the gate. */
export function releaseGoal(
  state: Board,
  input: { deskId: string; goalId: string; now?: string },
): BoardResult<Goal> {
  const now = input.now ?? new Date().toISOString();
  const desk = state.desks.find(d => d.id === input.deskId);
  if (!desk) return { ok: false, state, error: `no desk "${input.deskId}"` };
  const goal = desk.goals.find(g => g.id === input.goalId);
  if (!goal) return { ok: false, state, error: `no goal "${input.goalId}"` };
  if (goal.status !== 'running') {
    return { ok: false, state, error: `goal is ${goal.status}, not running` };
  }
  const next: Goal = { ...goal, status: goal.resumeAs ?? (goal.sensitive ? 'approved' : 'queued') };
  delete next.resumeAs;
  const desks = state.desks.map(d => d.id === desk.id
    ? { ...d, goals: d.goals.map(g => g.id === goal.id ? next : g) }
    : d);
  return {
    ok: true,
    state: { ...state, desks },
    value: next,
    audit: audit(desk.id, 'release', `${goal.id} back to ${next.status}`, now),
  };
}

/**
 * The prompt `qodex desk run` hands to the same agent as `qodex -p`.
 * Built before the goal is claimed, so `goal.status` is still queued or approved.
 */
export function buildDeskPrompt(input: {
  desk: Desk;
  goal: Goal;
  teammates: Array<{ name: string; brief: string }>;
  desktop: { gui: string; note: string };
  sharedDir: string;
}): string {
  const others = input.teammates.length
    ? input.teammates.map(t => `- ${t.name}${t.brief ? `: ${t.brief}` : ''}`).join('\n')
    : '- (none)';
  const routines = input.desk.routines.slice(0, 8).map(r =>
    `- ${r.name}: ${r.steps.map(s => `${s.tool} (${s.summary})`).join(' → ')}`,
  ).join('\n') || '- (none)';
  const approved = input.goal.status === 'approved';
  const gate = approved
    ? `The user approved this goal (${input.goal.sensitive?.kind ?? 'reviewed'}). Do it. A call that sends, spends, deletes, publishes, or types a secret still pauses on the sentinel so they can confirm that exact call.`
    : 'This goal was not classified as send, spend, delete, publish, or credential. If a tool call becomes one of those, it pauses on the sentinel instead of running. Do not hide it inside another command. If you should not even try, stop with NEEDS_APPROVAL: <kind> <why>.';
  const lines = [
    `You are the QodeX desk "${input.desk.name}", one teammate on the user's own machine. Desks run in parallel and share this computer. There is no remote VM.`,
    `Your directory: ${input.desk.cwd}`,
    `Shared computer (every desk can read and write here): ${input.sharedDir}`,
    input.desk.brief ? `Brief: ${input.desk.brief}` : '',
    'Other desks on this machine (a handoff is `qodex desk handoff`, which a person runs — do not pretend you already handed off):',
    others,
    'Known routines (follow one only when it matches the goal; do not invent extra steps):',
    routines,
    `Screen control: GUI backend is "${input.desktop.gui}". ${input.desktop.note} Prefer computer_use_tree and computer_use_invoke (one named control, then a second read that says whether it changed). Fill a named field with computer_use_set_value — that sets the control's value and does not type into whatever else is focused. Blind click, type, and key also pause until \`qodex desk allow-call\` (or the local console) and then they run.`,
    gate,
    'Irreversible shell (rm -rf, force-push, format, publish) also pauses on the sentinel. It runs only after that exact call is allowed.',
    `Goal: ${input.goal.text}`,
    'When you finish, the last line must be DESK_RESULT: <one sentence of what changed>.',
  ];
  return lines.filter(Boolean).join('\n');
}

/** Tool steps from the newest finished goal, for `desk teach --from-last`. */
export function lastTrace(desk: Desk | undefined): RoutineStep[] | undefined {
  if (!desk) return undefined;
  const goal = [...desk.goals].reverse().find(g =>
    (g.status === 'done' || g.status === 'failed') && g.trace && g.trace.length >= 2);
  return goal?.trace;
}

function cleanTrace(steps: RoutineStep[] | undefined): RoutineStep[] | undefined {
  if (!steps?.length) return undefined;
  const cleaned = steps.slice(0, 24).map(s => ({
    tool: String(s.tool ?? '').trim(),
    summary: scrubPacket(String(s.summary ?? '')).text.replace(/\s+/g, ' ').trim().slice(0, 180) || 'ran',
  }));
  const checked = validateRoutine(cleaned);
  return checked.ok ? checked.steps : undefined;
}

export function findDesk(state: Board, nameOrId: string): Desk | undefined {
  const key = nameOrId.trim().toLowerCase();
  return state.desks.find(d => d.id === key || d.name.toLowerCase() === key || slugDeskName(d.name) === slugDeskName(nameOrId));
}
