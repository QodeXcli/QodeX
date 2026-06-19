/**
 * Multi-Agent Orchestration Engine — Core Protocol.
 *
 * The Triad:
 *   - ORCHESTRATOR  (this layer): decomposes a goal into a DAG of isolated tasks
 *     using the AST + import-graph. Never writes implementation code.
 *   - WORKER NODES  (sub-agents): each solves ONE DAG node with a minimal,
 *     RAG-sliced context — only the types/tokens that node needs.
 *   - QA / VISION NODE: reviews worker output (typecheck, design-system
 *     adherence, visual inspection) before changes are committed.
 *
 * This file defines the contracts only. The scheduler (scheduler.ts), the
 * context slicer (context-injection.ts), and the staging/merge layer
 * (staging.ts) implement them. The engine itself (engine.ts) wires them to the
 * existing SubAgentRunner + role system so we reuse, not reinvent, the agent
 * loop.
 *
 * Design invariants:
 *   - A worker NEVER receives the full project. It receives a TaskContext built
 *     by the slicer (the exact AST chunks + type files + tokens for its node).
 *   - A worker's output is staged, never written directly. The orchestrator
 *     dry-run merges all staged outputs and only commits a conflict-free set.
 *   - Every edge in the DAG is a hard dependency: a node cannot start until all
 *     its upstream nodes have COMMITTED (not just finished) — so a worker that
 *     depends on a new type sees that type in its sliced context.
 */

export type TaskId = string;

/** What kind of work a node represents — drives role/model selection. */
export type TaskKind =
  | 'schema'        // DB schema / migration / types at the data layer
  | 'backend'       // server logic, API handlers, services
  | 'state'         // client state (stores, slices, contexts)
  | 'component'     // a UI component
  | 'style'         // styling / design tokens
  | 'test'          // tests for another node's output
  | 'wiring'        // glue: imports, routing, integration
  | 'generic';

export type TaskStatus =
  | 'pending'       // waiting on dependencies
  | 'ready'         // dependencies committed; eligible to run
  | 'running'       // a worker is executing it
  | 'review'        // worker done; awaiting QA
  | 'staged'        // QA passed; output in staging, awaiting merge
  | 'committed'     // merged to the file system
  | 'failed'        // worker or QA failed terminally
  | 'blocked';      // an upstream node failed; can't proceed

/**
 * A single node in the task DAG. The orchestrator produces these; it never
 * fills `result` — workers do.
 */
export interface TaskNode {
  id: TaskId;
  kind: TaskKind;
  /** One-line imperative description handed to the worker. */
  title: string;
  /** The full instruction for the worker (what to build, acceptance criteria). */
  instruction: string;
  /** Files this task is expected to CREATE or MODIFY. Used for conflict detection. */
  targetFiles: string[];
  /** Files whose CONTENT the worker needs to read (resolved by the slicer to chunks). */
  contextFiles: string[];
  /** Specific symbols (types, functions) the worker needs, if known. */
  contextSymbols?: string[];
  /** IDs of tasks that must be COMMITTED before this one can start. */
  dependsOn: TaskId[];
  /** Role used to run this node (selects model/tools). Defaults by kind. */
  role?: string;
  /** Whether this node produces UI that the Vision/QA node should screenshot. */
  visualReview?: boolean;
  status: TaskStatus;
  result?: WorkerResult;
  /** How many times this node has been retried after a QA failure. */
  attempts: number;
}

/** The minimal, token-optimized context a worker receives for ONE node. */
export interface TaskContext {
  taskId: TaskId;
  /** The instruction, verbatim. */
  instruction: string;
  /** Sliced source: only the chunks/files this node needs, each with a path + text. */
  slices: ContextSlice[];
  /** Type/interface definitions the node depends on (pulled across the import graph). */
  typeDefs: ContextSlice[];
  /** Design tokens / style constants (for component & style nodes). */
  designTokens?: string;
  /** Target files the worker is permitted to write. Enforced at staging. */
  allowedWrites: string[];
  /** Estimated token count of this context (for budgeting / telemetry). */
  estimatedTokens: number;
}

export interface ContextSlice {
  file: string;
  /** The sliced text (a function/class/type, not the whole file). */
  text: string;
  /** Why this slice was included — for the worker's understanding + debugging. */
  reason: 'target' | 'type-dependency' | 'import-neighbor' | 'design-token' | 'signature';
  startLine?: number;
  endLine?: number;
  symbol?: string;
}

/** What a worker returns. The orchestrator stages this; it does not write it. */
export interface WorkerResult {
  taskId: TaskId;
  ok: boolean;
  /** File path → new full content. Staged, not yet written. */
  fileEdits: Array<{ path: string; content: string; isNew: boolean }>;
  /** Worker's natural-language summary of what it did. */
  summary: string;
  modelUsed?: string;
  toolCallsRun: number;
  error?: string;
}

/** QA verdict for a worker result. */
export interface QaVerdict {
  taskId: TaskId;
  passed: boolean;
  /** Hard failures that must be fixed (typecheck errors, broken imports). */
  blockers: string[];
  /** Soft issues (design-system deviations, a11y) — logged, may not block. */
  warnings: string[];
  /** If a visual review ran, the screenshot path + notes. */
  visual?: { screenshotPath: string; notes: string };
}

/**
 * The contract the engine fulfills. The orchestrator implements `decompose`;
 * the scheduler drives `runNode`; the QA node implements `review`; the staging
 * layer implements `dryRunMerge` + `commit`.
 */
export interface OrchestrationEngine {
  /** Build the task DAG from a user goal + the current codebase graph. */
  decompose(goal: string, signal?: AbortSignal): Promise<TaskGraph>;
  /** Run the whole graph to completion (or terminal failure). */
  execute(graph: TaskGraph, signal?: AbortSignal): Promise<ExecutionReport>;
}

export interface TaskGraph {
  nodes: Map<TaskId, TaskNode>;
  goal: string;
  /** Topologically-valid? Cached after construction. */
  acyclic: boolean;
}

export interface ExecutionReport {
  committed: TaskId[];
  failed: TaskId[];
  blocked: TaskId[];
  totalToolCalls: number;
  /** Tokens saved vs. naive full-context-per-worker, estimated. */
  tokensSavedEstimate: number;
  durationMs: number;
  conflicts: ConflictRecord[];
}

export interface ConflictRecord {
  taskA: TaskId;
  taskB: TaskId;
  file: string;
  kind: 'same-file-write' | 'logical' | 'import-broken';
  resolution: 'serialized' | 'rejected-b' | 'manual-required';
}

/** Default role per task kind. Overridable per-node or via config. */
export function defaultRoleForKind(kind: TaskKind): string {
  switch (kind) {
    case 'schema':
    case 'backend':
      return 'subagent';      // capable model; logic-heavy
    case 'component':
    case 'style':
      return 'subagent';      // frontend-tuned via task-class prompt
    case 'test':
      return 'subagent';
    case 'wiring':
      return 'subagent';
    default:
      return 'subagent';
  }
}
