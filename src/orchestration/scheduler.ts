/**
 * DAG Task Scheduler.
 *
 * Drives a TaskGraph to completion with maximum safe parallelism:
 *   - A node becomes `ready` only when ALL its `dependsOn` are `committed`
 *     (committed, not merely finished — so its sliced context already contains
 *     any new types/symbols upstream produced).
 *   - Up to `maxConcurrency` ready nodes run at once, EXCEPT nodes whose
 *     targetFiles overlap are never run concurrently (write-write hazard) — the
 *     scheduler serializes them even if the DAG would allow parallelism.
 *   - When a worker finishes, its result goes through QA → staging. Only after
 *     a successful dry-run merge does the node flip to `committed`, which may
 *     unblock downstream nodes. The scheduler loops until no node can advance.
 *
 * Failure handling:
 *   - A node that fails QA is retried (up to maxAttempts) with the QA blockers
 *     appended to its instruction. Exhausting retries marks it `failed`.
 *   - A `failed` node marks all transitive dependents `blocked`.
 *
 * The scheduler is transport-agnostic: it takes function hooks for run/review/
 * commit so it can be unit-tested without real models or a filesystem.
 */

import type {
  TaskGraph, TaskNode, TaskId, TaskStatus,
  WorkerResult, QaVerdict, ConflictRecord,
} from './protocol.js';
import { logger } from '../utils/logger.js';

export interface SchedulerHooks {
  /** Run a worker on a node. Returns its (un-committed) result. */
  runNode(node: TaskNode, signal?: AbortSignal): Promise<WorkerResult>;
  /** QA-review a worker result. */
  review(node: TaskNode, result: WorkerResult, signal?: AbortSignal): Promise<QaVerdict>;
  /**
   * Dry-run merge a passed result against current staging. Returns conflicts
   * (empty = clean). The scheduler commits only if clean.
   */
  dryRunMerge(node: TaskNode, result: WorkerResult): Promise<ConflictRecord[]>;
  /** Commit a staged result to the real file system. */
  commit(node: TaskNode, result: WorkerResult): Promise<void>;
  /** Optional progress callback. */
  onEvent?(ev: SchedulerEvent): void;
}

export type SchedulerEvent =
  | { type: 'node-ready'; id: TaskId }
  | { type: 'node-start'; id: TaskId; role?: string }
  | { type: 'node-review'; id: TaskId; passed: boolean }
  | { type: 'node-commit'; id: TaskId }
  | { type: 'node-retry'; id: TaskId; attempt: number; blockers: string[] }
  | { type: 'node-failed'; id: TaskId; error: string }
  | { type: 'node-blocked'; id: TaskId; cause: TaskId }
  | { type: 'conflict'; record: ConflictRecord };

export interface SchedulerOptions {
  maxConcurrency: number;
  maxAttempts: number;
  signal?: AbortSignal;
}

export class DagScheduler {
  private conflicts: ConflictRecord[] = [];

  constructor(
    private graph: TaskGraph,
    private hooks: SchedulerHooks,
    private opts: SchedulerOptions,
  ) {}

  private emit(ev: SchedulerEvent) { this.hooks.onEvent?.(ev); }

  /** A node is runnable when it's ready/pending AND all deps are committed. */
  private depsCommitted(node: TaskNode): boolean {
    return node.dependsOn.every(d => this.graph.nodes.get(d)?.status === 'committed');
  }

  /** Any dependency failed/blocked → this node is blocked. */
  private depsBroken(node: TaskNode): TaskId | null {
    for (const d of node.dependsOn) {
      const st = this.graph.nodes.get(d)?.status;
      if (st === 'failed' || st === 'blocked') return d;
    }
    return null;
  }

  /** Files currently locked by running/staged nodes (write-write hazard guard). */
  private lockedFiles(): Set<string> {
    const locked = new Set<string>();
    for (const n of this.graph.nodes.values()) {
      if (n.status === 'running' || n.status === 'review' || n.status === 'staged') {
        for (const f of n.targetFiles) locked.add(f);
      }
    }
    return locked;
  }

  /** Pick ready nodes that don't collide (by file) with locked or each other. */
  private selectRunnable(slots: number): TaskNode[] {
    const locked = this.lockedFiles();
    const chosen: TaskNode[] = [];
    const willLock = new Set<string>();

    for (const node of this.graph.nodes.values()) {
      if (chosen.length >= slots) break;
      if (node.status !== 'ready') continue;
      // Skip if any target file is locked by an in-flight node or an earlier pick.
      const collides = node.targetFiles.some(f => locked.has(f) || willLock.has(f));
      if (collides) continue;
      chosen.push(node);
      for (const f of node.targetFiles) willLock.add(f);
    }
    return chosen;
  }

  /** Promote pending nodes whose deps are committed → ready; block broken ones. */
  private refreshStatuses() {
    for (const node of this.graph.nodes.values()) {
      if (node.status === 'pending') {
        const broken = this.depsBroken(node);
        if (broken) {
          node.status = 'blocked';
          this.emit({ type: 'node-blocked', id: node.id, cause: broken });
        } else if (this.depsCommitted(node)) {
          node.status = 'ready';
          this.emit({ type: 'node-ready', id: node.id });
        }
      }
    }
  }

  /** True when no node can make further progress. */
  private quiescent(): boolean {
    for (const n of this.graph.nodes.values()) {
      if (n.status === 'ready' || n.status === 'running' || n.status === 'review' || n.status === 'staged' || n.status === 'pending') {
        // pending might still become ready; only truly stuck if no pending can ever resolve
        if (n.status === 'pending' && this.depsBroken(n)) continue;
        return false;
      }
    }
    return true;
  }

  /**
   * Process one node end-to-end: run → review (retry on fail) → dry-merge →
   * commit. Mutates node.status. Returns when the node reaches a terminal
   * state (committed or failed).
   */
  private async processNode(node: TaskNode): Promise<void> {
    node.status = 'running';
    this.emit({ type: 'node-start', id: node.id, role: node.role });

    while (true) {
      // RUN
      let result: WorkerResult;
      try {
        result = await this.hooks.runNode(node, this.opts.signal);
      } catch (e: any) {
        node.status = 'failed';
        this.emit({ type: 'node-failed', id: node.id, error: e?.message ?? String(e) });
        return;
      }
      node.result = result;
      if (!result.ok) {
        if (node.attempts < this.opts.maxAttempts - 1) {
          node.attempts++;
          this.emit({ type: 'node-retry', id: node.id, attempt: node.attempts, blockers: [result.error ?? 'worker failed'] });
          node.instruction += `\n\n[Retry ${node.attempts}] Previous attempt failed: ${result.error ?? 'unknown'}. Fix and complete.`;
          continue;
        }
        node.status = 'failed';
        this.emit({ type: 'node-failed', id: node.id, error: result.error ?? 'worker failed' });
        return;
      }

      // REVIEW
      node.status = 'review';
      const verdict = await this.hooks.review(node, result, this.opts.signal);
      this.emit({ type: 'node-review', id: node.id, passed: verdict.passed });
      if (!verdict.passed) {
        if (node.attempts < this.opts.maxAttempts - 1) {
          node.attempts++;
          this.emit({ type: 'node-retry', id: node.id, attempt: node.attempts, blockers: verdict.blockers });
          node.instruction +=
            `\n\n[Retry ${node.attempts}] QA found blockers:\n` +
            verdict.blockers.map(b => `- ${b}`).join('\n') +
            `\nAddress every blocker. Re-output the complete file(s).`;
          node.status = 'running';
          this.emit({ type: 'node-start', id: node.id, role: node.role });
          continue;
        }
        node.status = 'failed';
        this.emit({ type: 'node-failed', id: node.id, error: `QA blockers: ${verdict.blockers.join('; ')}` });
        return;
      }

      // DRY-RUN MERGE
      node.status = 'staged';
      const conflicts = await this.hooks.dryRunMerge(node, result);
      if (conflicts.length > 0) {
        for (const c of conflicts) { this.conflicts.push(c); this.emit({ type: 'conflict', record: c }); }
        // A logical/unresolvable conflict fails the node; serialized conflicts
        // are handled by the file-lock guard so shouldn't reach here.
        const fatal = conflicts.some(c => c.resolution !== 'serialized');
        if (fatal) {
          node.status = 'failed';
          this.emit({ type: 'node-failed', id: node.id, error: `merge conflict: ${conflicts.map(c => c.file).join(', ')}` });
          return;
        }
      }

      // COMMIT
      await this.hooks.commit(node, result);
      node.status = 'committed';
      this.emit({ type: 'node-commit', id: node.id });
      return;
    }
  }

  /** Run the whole graph. Resolves when quiescent. */
  async run(): Promise<{ conflicts: ConflictRecord[] }> {
    // Initialize: nodes with no deps start ready.
    for (const node of this.graph.nodes.values()) {
      node.status = node.dependsOn.length === 0 ? 'ready' : 'pending';
    }

    const inFlight = new Set<Promise<void>>();

    while (!this.quiescent()) {
      if (this.opts.signal?.aborted) break;
      this.refreshStatuses();

      const slots = this.opts.maxConcurrency - inFlight.size;
      if (slots > 0) {
        const runnable = this.selectRunnable(slots);
        for (const node of runnable) {
          const p = this.processNode(node).finally(() => inFlight.delete(p));
          inFlight.add(p);
        }
      }

      if (inFlight.size === 0) {
        // Nothing running and nothing runnable — either done or deadlocked.
        this.refreshStatuses();
        if (this.selectRunnable(1).length === 0) break;
        continue;
      }

      // Wait for the next node to finish, then re-evaluate.
      await Promise.race(inFlight);
    }

    // Drain any stragglers.
    await Promise.allSettled(inFlight);

    // Final pass: any node still pending whose deps failed/blocked must be
    // marked blocked. We didn't reach these inside the loop because quiescent()
    // treats a pending-with-broken-deps node as non-advancing. Propagate
    // repeatedly so a chain (a fails → b blocked → c blocked) fully resolves.
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of this.graph.nodes.values()) {
        if (node.status !== 'pending') continue;
        const broken = this.depsBroken(node);
        if (broken) {
          node.status = 'blocked';
          this.emit({ type: 'node-blocked', id: node.id, cause: broken });
          changed = true;
        }
      }
    }

    return { conflicts: this.conflicts };
  }

  statusCounts(): Record<TaskStatus, number> {
    const counts = {
      pending: 0, ready: 0, running: 0, review: 0, staged: 0,
      committed: 0, failed: 0, blocked: 0,
    } as Record<TaskStatus, number>;
    for (const n of this.graph.nodes.values()) counts[n.status]++;
    return counts;
  }
}

/** Validate a graph is acyclic via Kahn's algorithm; returns topo order or null. */
export function topoSort(graph: TaskGraph): TaskId[] | null {
  const indeg = new Map<TaskId, number>();
  const adj = new Map<TaskId, TaskId[]>();
  for (const id of graph.nodes.keys()) { indeg.set(id, 0); adj.set(id, []); }
  for (const node of graph.nodes.values()) {
    for (const dep of node.dependsOn) {
      if (!graph.nodes.has(dep)) continue;
      adj.get(dep)!.push(node.id);
      indeg.set(node.id, (indeg.get(node.id) ?? 0) + 1);
    }
  }
  const queue: TaskId[] = [];
  for (const [id, d] of indeg) if (d === 0) queue.push(id);
  const order: TaskId[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of adj.get(id) ?? []) {
      indeg.set(next, indeg.get(next)! - 1);
      if (indeg.get(next) === 0) queue.push(next);
    }
  }
  return order.length === graph.nodes.size ? order : null;
}
