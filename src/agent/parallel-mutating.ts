/**
 * Group mutating tool calls into batches where it's SAFE to run in parallel.
 *
 * Two mutations are parallel-safe iff:
 *   1. They touch disjoint file paths, AND
 *   2. Neither is a "global" tool (bash, code_run — these may have any side
 *      effect, never parallelize), AND
 *   3. Neither is a "broad" tool (multi_file_edit, safe_rename, safe_delete
 *      — these touch many files we can't enumerate cheaply).
 *
 * The path-extraction heuristic looks at common arg keys: `path`, `file`,
 * `file_path`, `paths`, `files`. If a tool call doesn't expose path args,
 * we conservatively treat it as conflicting with everything.
 *
 * Output: list of batches. Each batch can be executed with Promise.all.
 * Batches must be executed in ORDER (you can't reorder batches without
 * breaking causality).
 *
 * Example:
 *   inputs:
 *     [edit src/a.ts, edit src/b.ts, bash "npm test", edit src/c.ts]
 *   output:
 *     [[edit src/a.ts, edit src/b.ts], [bash "npm test"], [edit src/c.ts]]
 *   reasoning:
 *     a and b touch different files → batch 1 (parallel)
 *     bash is global → solo batch 2
 *     edit c.ts comes after → solo batch 3
 */

import type { ToolCall } from '../llm/types.js';

const GLOBAL_TOOLS = new Set(['bash', 'code_run', 'auto_fix', 'computer_use_screenshot', 'computer_use_click', 'computer_use_type', 'computer_use_key', 'http_request', 'db_query', 'browser_navigate', 'browser_click', 'browser_fill', 'browser_evaluate', 'dev_server_start', 'dev_server_stop', 'dev_server_restart']);
const BROAD_TOOLS = new Set(['multi_file_edit', 'safe_rename', 'safe_delete_file']);

function extractPaths(args: any): string[] | null {
  if (!args || typeof args !== 'object') return null;
  const out: string[] = [];
  for (const key of ['path', 'file', 'file_path', 'filepath', 'target']) {
    if (typeof args[key] === 'string') out.push(args[key]);
  }
  for (const key of ['paths', 'files', 'targets']) {
    if (Array.isArray(args[key])) {
      for (const v of args[key]) if (typeof v === 'string') out.push(v);
    }
  }
  // multi_edit-style: edits[].path
  if (Array.isArray(args.edits)) {
    for (const e of args.edits) if (e && typeof e.path === 'string') out.push(e.path);
  }
  return out.length > 0 ? out : null;
}

function pathsConflict(a: string[], b: string[]): boolean {
  const sa = new Set(a);
  for (const p of b) if (sa.has(p)) return true;
  return false;
}

export function groupMutatingForParallel(calls: ToolCall[]): ToolCall[][] {
  if (calls.length <= 1) return calls.map(c => [c]);

  const batches: ToolCall[][] = [];
  let currentBatch: ToolCall[] = [];
  let currentPaths: string[] = [];

  for (const tc of calls) {
    const name = tc.function.name;
    // Globals and broad always solo
    if (GLOBAL_TOOLS.has(name) || BROAD_TOOLS.has(name)) {
      if (currentBatch.length > 0) {
        batches.push(currentBatch);
        currentBatch = [];
        currentPaths = [];
      }
      batches.push([tc]);
      continue;
    }
    let args: any;
    try { args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; } catch { args = null; }
    const paths = extractPaths(args);
    if (!paths) {
      // Unknown path → conservatively solo
      if (currentBatch.length > 0) {
        batches.push(currentBatch);
        currentBatch = [];
        currentPaths = [];
      }
      batches.push([tc]);
      continue;
    }
    if (pathsConflict(currentPaths, paths)) {
      // Flush current batch, start a new one
      batches.push(currentBatch);
      currentBatch = [tc];
      currentPaths = paths.slice();
    } else {
      currentBatch.push(tc);
      currentPaths.push(...paths);
    }
  }
  if (currentBatch.length > 0) batches.push(currentBatch);
  return batches;
}
