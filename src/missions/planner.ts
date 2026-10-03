/**
 * Mission planner — turns a free-form goal into a small DAG of executable steps.
 *
 * The LLM call is injected (`complete(prompt)`), so this module is pure logic:
 * prompt construction + a tolerant parser + validation. Weak local models often
 * wrap JSON in fences or prose, use different key names, emit numeric deps, or
 * produce cycles; the parser normalizes what it can and falls back to a single
 * "do the whole goal" step for anything it can't trust, so a mission always has a
 * runnable plan.
 *
 * Validation:
 *   - ids normalized to [A-Za-z0-9_-], unique (missing/duplicate → s1, s2, ...)
 *   - deps referencing unknown steps or themselves are dropped; numeric deps map
 *     to the n-th step (1-based)
 *   - a dependency cycle → fallback plan (reuses topoSort from the orchestrator)
 *   - at most MAX_PLAN_STEPS steps; extra steps are folded into the last kept one
 */
import { topoSort } from '../orchestration/scheduler.js';
import type { TaskGraph } from '../orchestration/protocol.js';
import { extractThinking } from '../llm/thinking.js';

export const MAX_PLAN_STEPS = 12;

export interface PlanStep {
  id: string;
  title: string;
  instruction: string;
  depends_on: string[];
}

export interface MissionPlan {
  steps: PlanStep[];
  success_criteria: string;
  /** True when the plan is the single-step fallback. */
  fallback?: boolean;
  /** Why the fallback was used (parse error, cycle, planner failure). */
  fallbackReason?: string;
}

export interface PlannerDeps {
  /** One-shot LLM completion (no tools). */
  complete: (prompt: string, signal?: AbortSignal) => Promise<string>;
  signal?: AbortSignal;
  /** Extra context for the planner (cwd, constraints, user notes). */
  context?: string;
  maxSteps?: number;
}

const DEFAULT_CRITERIA = 'The goal is fully achieved and verified, with concrete evidence (files, URLs, values, command output).';

export function buildPlannerPrompt(goal: string, opts: { context?: string; maxSteps?: number } = {}): string {
  const max = clampSteps(opts.maxSteps);
  return [
    'You are the PLANNER for an autonomous agent mission. Break the GOAL into a short list of concrete steps.',
    'Each step is executed later, one at a time, by an AI agent that has tools: shell, file editing, code tools,',
    'web search/fetch, its own persistent web browser, desktop control and long-term memory.',
    '',
    'GOAL:',
    goal.trim(),
    ...(opts.context ? ['', 'CONTEXT:', opts.context.trim()] : []),
    '',
    'Rules:',
    `- 1 to ${max} steps. Prefer the FEWEST steps that keep progress verifiable (most goals need 2-6).`,
    '- Every instruction must be self-contained: the executor only sees the goal, this plan, and the',
    '  results of the steps it depends on. Say exactly what to do and what to report back.',
    '- depends_on lists the ids of steps whose RESULTS this step needs. Steps without a real dependency',
    '  may run in parallel — but steps that use the web browser or the desktop must be chained with',
    '  depends_on (there is only one browser and one screen).',
    '- No cycles. Use short ids: s1, s2, ...',
    '- Every step must act or verify (no "think about" / "plan" steps). The last step verifies the outcome',
    '  against the success criteria and summarizes the evidence.',
    '- Write titles and instructions in the same language as the goal.',
    '',
    'Reply with ONLY one JSON object, no prose, no markdown:',
    '{"steps":[{"id":"s1","title":"short title","instruction":"what to do and report","depends_on":[]}],',
    ' "success_criteria":"how to tell the goal is achieved"}',
  ].join('\n');
}

/** A plan that just runs the whole goal as one step. */
export function fallbackPlan(goal: string, reason?: string): MissionPlan {
  const title = goal.trim().replace(/\s+/g, ' ');
  return {
    steps: [{
      id: 's1',
      title: title.length > 80 ? title.slice(0, 77) + '...' : title,
      instruction: goal.trim(),
      depends_on: [],
    }],
    success_criteria: DEFAULT_CRITERIA,
    fallback: true,
    fallbackReason: reason,
  };
}

/** Ask the planner model for a plan; never throws (falls back to one step). */
export async function planMission(goal: string, deps: PlannerDeps): Promise<MissionPlan> {
  let raw: string;
  try {
    raw = await deps.complete(buildPlannerPrompt(goal, { context: deps.context, maxSteps: deps.maxSteps }), deps.signal);
  } catch (e: any) {
    if (deps.signal?.aborted) throw e;
    return fallbackPlan(goal, `planner failed: ${e?.message ?? String(e)}`);
  }
  try {
    return parseMissionPlan(raw, { maxSteps: deps.maxSteps });
  } catch (e: any) {
    return fallbackPlan(goal, e?.message ?? String(e));
  }
}

function clampSteps(n: number | undefined): number {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v >= 1 ? Math.min(v, MAX_PLAN_STEPS) : MAX_PLAN_STEPS;
}

/** Pull the JSON object (or array) out of a model reply. Throws [PLAN_PARSE]. */
export function extractJson(text: string): unknown {
  let s = extractThinking(String(text ?? '')).visibleText.trim();
  if (!s) throw new Error('[PLAN_PARSE] empty planner reply');
  // Prefer a fenced block that contains JSON.
  const fences = [...s.matchAll(/```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)```/g)].map(m => m[1]!.trim());
  const fenced = fences.find(f => /^[[{]/.test(f));
  if (fenced) s = fenced;
  const candidates: string[] = [];
  const firstObj = s.indexOf('{');
  const lastObj = s.lastIndexOf('}');
  const firstArr = s.indexOf('[');
  const lastArr = s.lastIndexOf(']');
  const objFirst = firstObj >= 0 && (firstArr < 0 || firstObj < firstArr);
  if (objFirst && lastObj > firstObj) candidates.push(s.slice(firstObj, lastObj + 1));
  if (firstArr >= 0 && lastArr > firstArr) candidates.push(s.slice(firstArr, lastArr + 1));
  if (!objFirst && firstObj >= 0 && lastObj > firstObj) candidates.push(s.slice(firstObj, lastObj + 1));
  let lastErr = 'no JSON object found';
  for (const c of candidates) {
    for (const variant of [c, repairJson(c)]) {
      try { return JSON.parse(variant); } catch (e: any) { lastErr = e?.message ?? String(e); }
    }
  }
  throw new Error(`[PLAN_PARSE] planner reply is not valid JSON (${lastErr}): ${s.slice(0, 160)}`);
}

/** Cheap fixes for common model JSON slips: trailing commas, smart quotes. */
function repairJson(s: string): string {
  return s
    .replace(/[“”]/g, '"')
    .replace(/,\s*([}\]])/g, '$1');
}

function asText(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.map(asText).filter(Boolean).join('\n');
  return '';
}

function sanitizeId(v: unknown): string {
  const s = typeof v === 'number' ? `s${v}` : typeof v === 'string' ? v.trim() : '';
  return s.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
}

/**
 * Parse + validate a planner reply. Throws [PLAN_PARSE] / [PLAN_INVALID] /
 * [PLAN_CYCLE] when the plan can't be trusted (callers fall back).
 */
export function parseMissionPlan(text: string, opts: { maxSteps?: number } = {}): MissionPlan {
  const max = clampSteps(opts.maxSteps);
  const parsed = extractJson(text);
  let rawSteps: unknown;
  let criteria: unknown;
  if (Array.isArray(parsed)) {
    rawSteps = parsed;
  } else if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    const nested = o.plan && typeof o.plan === 'object' && !Array.isArray(o.plan) ? o.plan as Record<string, unknown> : undefined;
    rawSteps = o.steps ?? o.tasks ?? (Array.isArray(o.plan) ? o.plan : undefined) ?? nested?.steps ?? nested?.tasks;
    criteria = o.success_criteria ?? o.successCriteria ?? o.criteria ?? o.done_when
      ?? nested?.success_criteria ?? nested?.successCriteria;
  }
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    throw new Error('[PLAN_INVALID] planner JSON has no "steps" array');
  }

  // 1) Normalize each step.
  interface Draft { rawId: string; id: string; title: string; instruction: string; rawDeps: unknown[] }
  const drafts: Draft[] = [];
  for (const item of rawSteps) {
    if (typeof item === 'string') {
      const t = item.trim();
      if (t) drafts.push({ rawId: '', id: '', title: t, instruction: t, rawDeps: [] });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const instruction = asText(o.instruction ?? o.instructions ?? o.description ?? o.prompt ?? o.details ?? o.task);
    const title = asText(o.title ?? o.name ?? o.summary) || instruction.split('\n')[0]!.slice(0, 80);
    if (!title && !instruction) continue;
    const depsRaw = o.depends_on ?? o.dependsOn ?? o.deps ?? o.dependencies ?? o.after ?? [];
    drafts.push({
      rawId: typeof o.id === 'string' || typeof o.id === 'number' ? String(o.id).trim() : '',
      id: sanitizeId(o.id ?? o.key),
      title: title.replace(/\s+/g, ' ').slice(0, 160),
      instruction: instruction || title,
      rawDeps: Array.isArray(depsRaw) ? depsRaw : (typeof depsRaw === 'string' || typeof depsRaw === 'number') ? [depsRaw] : [],
    });
  }
  if (drafts.length === 0) throw new Error('[PLAN_INVALID] planner returned no usable steps');

  // 2) Unique ids.
  const used = new Set<string>();
  const rawToId = new Map<string, string>();
  drafts.forEach((d, i) => {
    let id = d.id;
    if (!id || used.has(id)) {
      let n = i + 1;
      id = `s${n}`;
      while (used.has(id)) id = `s${++n}`;
    }
    used.add(id);
    if (d.rawId && !rawToId.has(d.rawId)) rawToId.set(d.rawId, id);
    if (d.id && !rawToId.has(d.id)) rawToId.set(d.id, id);
    d.id = id;
  });

  // 3) Resolve deps (by id, then 1-based position for numbers).
  const steps: PlanStep[] = drafts.map((d) => {
    const deps: string[] = [];
    for (const r of d.rawDeps) {
      let target: string | undefined;
      if (typeof r === 'number' && Number.isInteger(r)) {
        target = rawToId.get(String(r)) ?? drafts[r - 1]?.id;
      } else if (typeof r === 'string') {
        const key = r.trim();
        target = rawToId.get(key) ?? rawToId.get(sanitizeId(key))
          ?? (/^\d+$/.test(key) ? drafts[Number(key) - 1]?.id : undefined);
      }
      if (target && target !== d.id && !deps.includes(target)) deps.push(target);
    }
    return { id: d.id, title: d.title, instruction: d.instruction, depends_on: deps };
  });

  // 4) Reject cycles (before capping, so a cycle is never silently "fixed").
  if (hasCycle(steps)) throw new Error('[PLAN_CYCLE] planner produced a dependency cycle');

  // 5) Cap the number of steps; fold the overflow into the last kept step.
  let finalSteps = steps;
  if (steps.length > max) {
    const kept = steps.slice(0, max);
    const keptIds = new Set(kept.map(s => s.id));
    const dropped = steps.slice(max);
    const droppedIds = new Set(dropped.map(s => s.id));
    const last = kept[kept.length - 1]!;
    // The overflow now runs inside `last`, so it must keep the overflow's ordering:
    // `last` waits for what the dropped steps needed, and kept steps that needed a
    // dropped step wait for `last` — unless that would close a cycle.
    const tryAddDep = (s: PlanStep, dep: string) => {
      if (dep === s.id || s.depends_on.includes(dep)) return;
      s.depends_on.push(dep);
      if (hasCycle(kept)) s.depends_on.pop();
    };
    const needsLast = kept.filter(s => s !== last && s.depends_on.some(d => droppedIds.has(d)));
    for (const s of kept) s.depends_on = s.depends_on.filter(d => keptIds.has(d));
    for (const d of dropped) for (const dep of d.depends_on) if (keptIds.has(dep)) tryAddDep(last, dep);
    for (const s of needsLast) tryAddDep(s, last.id);
    last.instruction += '\n\nAlso complete these remaining parts of the plan:\n' +
      dropped.map(s => `- ${s.title}: ${s.instruction.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n');
    finalSteps = kept;
  }

  const sc = asText(criteria);
  return { steps: finalSteps, success_criteria: sc || DEFAULT_CRITERIA, fallback: false };
}

/** True when the steps' depends_on graph has a cycle. */
export function hasCycle(steps: Array<Pick<PlanStep, 'id' | 'depends_on'>>): boolean {
  // topoSort only reads node.id / node.dependsOn, so a minimal node shape suffices.
  const graph = {
    goal: '',
    acyclic: false,
    nodes: new Map(steps.map(s => [s.id, { id: s.id, dependsOn: s.depends_on }])),
  } as unknown as TaskGraph;
  return topoSort(graph) === null;
}
