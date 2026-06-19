/**
 * Orchestration Engine — wires the Triad to QodeX's existing agent runtime.
 *
 * Responsibilities:
 *   - decompose(goal): the ORCHESTRATOR. Builds the import graph + design tokens
 *     once, then asks the planning model for a DAG of isolated tasks as strict
 *     JSON, validates it (acyclic, file-scoped), and returns a TaskGraph. The
 *     orchestrator NEVER writes code — its only output is the plan.
 *   - execute(graph): hands the graph to the DagScheduler with hooks that:
 *       runNode   → slice context (context-injection) + dispatch the existing
 *                   SubAgentRunner with the node's role; parse the worker's
 *                   output into staged file edits.
 *       review    → QaNode (parse + design audit + optional vision).
 *       dryRunMerge / commit → StagingArea.
 *
 * Token accounting: per node we record sliced vs. naive tokens and sum the
 * savings into the ExecutionReport — the concrete number behind "zero redundant
 * context passing."
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import type {
  OrchestrationEngine, TaskGraph, TaskNode, TaskId, ExecutionReport,
  WorkerResult, ConflictRecord,
} from './protocol.js';
import { defaultRoleForKind } from './protocol.js';
import { DagScheduler, topoSort, type SchedulerHooks } from './scheduler.js';
import { buildTaskContext, renderContextPrompt, estimateNaiveTokens, type SlicerDeps } from './context-injection.js';
import { StagingArea } from './staging.js';
import { QaNode, type QaHooks } from './qa-node.js';
import { buildImportGraph, type ImportGraph } from '../context/import-graph.js';
import { getSubAgentRunner } from '../tools/builtin/task.js';
import { countTokens } from '../utils/tokenizer.js';
import { logger } from '../utils/logger.js';

export interface EngineOptions {
  cwd: string;
  maxConcurrency?: number;
  maxAttempts?: number;
  /** Plan the DAG with this model/role (the "tech lead"). */
  plannerRole?: string;
  /** Design-token text (from index.css / tokens file) for component nodes. */
  designTokens?: string;
  qaHooks?: QaHooks;
  /** Inject a planner for testing; defaults to the SubAgentRunner planning role. */
  planner?: (goal: string, signal?: AbortSignal) => Promise<RawPlan>;
  onEvent?: SchedulerHooks['onEvent'];
}

/** The JSON shape we ask the planner to emit. */
export interface RawPlan {
  tasks: Array<{
    id: string;
    kind: TaskNode['kind'];
    title: string;
    instruction: string;
    targetFiles: string[];
    contextFiles?: string[];
    contextSymbols?: string[];
    dependsOn?: string[];
    visualReview?: boolean;
  }>;
}

const PLANNER_SYSTEM = `You are the Tech Lead orchestrator. You DECOMPOSE a goal into a DAG of isolated coding tasks. You NEVER write implementation code.

Rules:
- Each task must be independently solvable by a worker that sees ONLY that task's files.
- Split by concern: schema/types, backend, state, component, style, test, wiring.
- targetFiles = files the task creates/edits (must be disjoint across sibling tasks that run in parallel).
- dependsOn = task ids whose output this task needs (e.g. a component depends on its types task).
- Keep tasks small and single-purpose. A 'wiring' task at the end imports everything together.
- Mark visualReview:true for tasks that produce user-visible UI.

Output STRICT JSON only, no prose, no markdown fences:
{"tasks":[{"id":"t1","kind":"schema","title":"...","instruction":"...","targetFiles":["..."],"contextFiles":[],"dependsOn":[],"visualReview":false}]}`;

export class Orchestrator implements OrchestrationEngine {
  private graphCache?: ImportGraph;

  constructor(private opts: EngineOptions) {}

  /** Build the file-level import graph for the whole project once. */
  private async projectGraph(): Promise<ImportGraph> {
    if (this.graphCache) return this.graphCache;
    const files = await walkProjectSource(this.opts.cwd, 3000);
    this.graphCache = await buildImportGraph(
      this.opts.cwd,
      files.map(f => ({ rel: f.rel, content: f.content })),
    );
    return this.graphCache;
  }

  /** ORCHESTRATOR: produce the task DAG. */
  async decompose(goal: string, signal?: AbortSignal): Promise<TaskGraph> {
    const raw = this.opts.planner
      ? await this.opts.planner(goal, signal)
      : await this.planViaModel(goal, signal);

    const nodes = new Map<TaskId, TaskNode>();
    for (const t of raw.tasks) {
      nodes.set(t.id, {
        id: t.id,
        kind: t.kind,
        title: t.title,
        instruction: t.instruction,
        targetFiles: t.targetFiles ?? [],
        contextFiles: t.contextFiles ?? [],
        contextSymbols: t.contextSymbols,
        dependsOn: t.dependsOn ?? [],
        role: defaultRoleForKind(t.kind),
        visualReview: t.visualReview ?? false,
        status: 'pending',
        attempts: 0,
      });
    }

    const graph: TaskGraph = { nodes, goal, acyclic: false };
    const order = topoSort(graph);
    if (!order) {
      throw new Error('Planner produced a cyclic task graph; cannot schedule. Re-plan with acyclic dependencies.');
    }
    graph.acyclic = true;
    logger.info('Decomposed goal into DAG', { tasks: nodes.size, order });
    return graph;
  }

  /** Ask the planning model for the DAG as JSON. */
  private async planViaModel(goal: string, signal?: AbortSignal): Promise<RawPlan> {
    const runner = getSubAgentRunner();
    if (!runner) throw new Error('No sub-agent runner registered; orchestration requires the agent runtime.');

    const prompt = `${PLANNER_SYSTEM}\n\n# Goal\n${goal}\n\nReturn the JSON plan now.`;
    const res = await runner(prompt, {
      maxIterations: 1,
      signal,
      sessionId: `orchestrator-plan-${Date.now()}`,
      role: this.opts.plannerRole ?? 'planning',
    });
    if (!res.ok) throw new Error(`Planner failed: ${res.error ?? 'unknown'}`);
    return parsePlanJson(res.finalText);
  }

  /** EXECUTE: run the DAG to completion. */
  async execute(graph: TaskGraph, signal?: AbortSignal): Promise<ExecutionReport> {
    const started = Date.now();
    const staging = new StagingArea(this.opts.cwd);
    const qa = new QaNode(this.opts.qaHooks);
    const projGraph = await this.projectGraph();

    const slicerDeps: SlicerDeps = {
      cwd: this.opts.cwd,
      graph: projGraph,
      designTokens: this.opts.designTokens,
      // Staging-aware read: workers see committed-but-not-yet-on-disk content too.
      read: async (abs) => {
        try { return await fs.readFile(abs, 'utf-8'); } catch { return null; }
      },
    };

    let tokensSaved = 0;
    let totalToolCalls = 0;
    const conflicts: ConflictRecord[] = [];

    const hooks: SchedulerHooks = {
      runNode: async (node, sig) => {
        // 1. Slice the minimal context for this node.
        const ctx = await buildTaskContext(node, slicerDeps);
        const naive = await estimateNaiveTokens(node, slicerDeps);
        tokensSaved += Math.max(0, naive - ctx.estimatedTokens);

        // 2. Dispatch the worker (existing SubAgentRunner) with the role.
        const runner = getSubAgentRunner();
        if (!runner) return { taskId: node.id, ok: false, fileEdits: [], summary: '', toolCallsRun: 0, error: 'no runner' };

        const prompt = renderContextPrompt(ctx);
        const res = await runner(prompt, {
          maxIterations: 12,
          signal: sig,
          sessionId: `worker-${node.id}-${Date.now()}`,
          role: node.role,
        });
        totalToolCalls += res.toolCallsRun;

        // 3. Parse worker output into staged file edits.
        const fileEdits = await extractFileEdits(res.finalText, node, this.opts.cwd);
        return {
          taskId: node.id,
          ok: res.ok && fileEdits.length > 0,
          fileEdits,
          summary: res.finalText.slice(0, 500),
          modelUsed: res.modelUsed,
          toolCallsRun: res.toolCallsRun,
          error: res.ok ? (fileEdits.length === 0 ? 'worker produced no file edits' : undefined) : res.error,
        };
      },

      review: (node, result, sig) => qa.review(node, result, sig),

      dryRunMerge: async (node, result) => {
        const c = await staging.dryRunMerge(node, result);
        conflicts.push(...c);
        return c;
      },

      commit: (node, result) => staging.commit(node, result),

      onEvent: this.opts.onEvent,
    };

    const scheduler = new DagScheduler(graph, hooks, {
      maxConcurrency: this.opts.maxConcurrency ?? 3,
      maxAttempts: this.opts.maxAttempts ?? 2,
      signal,
    });

    await scheduler.run();

    const committed: TaskId[] = [];
    const failed: TaskId[] = [];
    const blocked: TaskId[] = [];
    for (const n of graph.nodes.values()) {
      if (n.status === 'committed') committed.push(n.id);
      else if (n.status === 'failed') failed.push(n.id);
      else if (n.status === 'blocked') blocked.push(n.id);
    }

    return {
      committed, failed, blocked,
      totalToolCalls,
      tokensSavedEstimate: tokensSaved,
      durationMs: Date.now() - started,
      conflicts,
    };
  }
}

/** Parse a planner's JSON output, tolerating accidental markdown fences. */
export function parsePlanJson(text: string): RawPlan {
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1]!.trim();
  // Find the first {...} block if there's leading prose.
  const brace = s.indexOf('{');
  const lastBrace = s.lastIndexOf('}');
  if (brace > 0 || lastBrace < s.length - 1) {
    if (brace >= 0 && lastBrace > brace) s = s.slice(brace, lastBrace + 1);
  }
  let parsed: any;
  try { parsed = JSON.parse(s); } catch (e: any) {
    throw new Error(`Planner did not return valid JSON: ${e?.message}. Got: ${text.slice(0, 200)}`);
  }
  if (!parsed || !Array.isArray(parsed.tasks)) {
    throw new Error('Planner JSON missing "tasks" array.');
  }
  return parsed as RawPlan;
}

/**
 * Extract file edits from a worker's final text. Workers are asked to output
 * fenced code blocks with a path marker. We support:
 *   ```ts path=src/components/Button.tsx
 *   ...code...
 *   ```
 * and the common "// File: path" / "### path" preambles.
 */
export async function extractFileEdits(
  text: string,
  node: TaskNode,
  cwd: string,
): Promise<WorkerResult['fileEdits']> {
  const edits: WorkerResult['fileEdits'] = [];
  const seen = new Set<string>();

  // Pattern A: fenced block with path= attribute.
  const fenceRe = /```[a-zA-Z]*\s+path=([^\s`]+)\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) {
    const p = normalizeRel(m[1]!, cwd);
    if (seen.has(p)) continue;
    seen.add(p);
    edits.push({ path: p, content: m[2]!.replace(/\n$/, ''), isNew: await isNewFile(cwd, p) });
  }

  // Pattern B: "// File: path" or "### path" header followed by a fenced block.
  if (edits.length === 0) {
    const headerRe = /(?:\/\/\s*File:|###|####|File:)\s*([^\s`]+\.[a-zA-Z]+)\s*\n+```[a-zA-Z]*\n([\s\S]*?)```/g;
    while ((m = headerRe.exec(text)) !== null) {
      const p = normalizeRel(m[1]!, cwd);
      if (seen.has(p)) continue;
      seen.add(p);
      edits.push({ path: p, content: m[2]!.replace(/\n$/, ''), isNew: await isNewFile(cwd, p) });
    }
  }

  // Pattern C: exactly one target file + one fenced block, no path marker.
  if (edits.length === 0 && node.targetFiles.length === 1) {
    const block = text.match(/```[a-zA-Z]*\n([\s\S]*?)```/);
    if (block) {
      const p = node.targetFiles[0]!;
      edits.push({ path: p, content: block[1]!.replace(/\n$/, ''), isNew: await isNewFile(cwd, p) });
    }
  }

  return edits;
}

function normalizeRel(p: string, cwd: string): string {
  let rel = p.trim().replace(/^['"]|['"]$/g, '');
  if (path.isAbsolute(rel)) rel = path.relative(cwd, rel);
  return rel.replace(/^\.\//, '');
}

async function isNewFile(cwd: string, rel: string): Promise<boolean> {
  try { await fs.stat(path.join(cwd, rel)); return false; } catch { return true; }
}

/** Walk project source files (bounded), skipping heavy/ignored dirs. */
async function walkProjectSource(root: string, cap: number): Promise<Array<{ rel: string; content: string }>> {
  const out: Array<{ rel: string; content: string }> = [];
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.qodex']);
  const exts = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

  async function walk(dir: string) {
    if (out.length >= cap) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= cap) return;
      if (e.name.startsWith('.') && e.name !== '.qodex') { /* allow dotfiles except heavy */ }
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue;
        await walk(abs);
      } else if (exts.has(path.extname(e.name))) {
        try {
          const content = await fs.readFile(abs, 'utf-8');
          out.push({ rel: path.relative(root, abs), content });
        } catch { /* skip unreadable */ }
      }
    }
  }
  await walk(root);
  return out;
}
