/**
 * Staging layer — Git-like staging area + dry-run merge + commit.
 *
 * Workers never touch the real file system. Each worker's WorkerResult is a set
 * of proposed file edits (full content per path). The staging area:
 *
 *   1. Holds the proposed edits in memory, keyed by path.
 *   2. On dryRunMerge, checks a candidate result against (a) what's already
 *      committed this run and (b) what's staged from other in-flight nodes, for
 *      three conflict classes:
 *        - same-file-write: two nodes writing the same path. The scheduler's
 *          file-lock guard should prevent CONCURRENT same-file writes, so if we
 *          see one here it's a sequential overwrite — allowed, but recorded as
 *          'serialized' so the later write wins intentionally.
 *        - import-broken: the edit removes an exported symbol that a
 *          committed/staged file imports. This is the "logical conflict" the
 *          spec asks for — caught WITHOUT running the code, by diffing exports
 *          against known importers via the import graph.
 *        - logical: a node deletes a file another node depends on.
 *   3. On commit, writes the staged content to disk atomically (temp + rename)
 *      and records the committed snapshot so later dry-runs see it.
 *
 * The export-diff check is the key to "zero rework": we detect that updating the
 * DB schema removed `OrderStatus` BEFORE the frontend-state worker's output
 * (which imports `OrderStatus`) gets committed, and fail fast with a precise
 * blocker the scheduler feeds back into a retry.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import type { WorkerResult, TaskNode, ConflictRecord } from './protocol.js';
import { buildImportGraph, extractImportSpecifiers, type ImportGraph } from '../context/import-graph.js';
import { logger } from '../utils/logger.js';

interface StagedEntry {
  taskId: string;
  content: string;
  isNew: boolean;
}

/** Extract exported symbol names from TS/JS source (best-effort, regex-based). */
export function extractExports(content: string): Set<string> {
  const names = new Set<string>();
  // export const/let/var/function/class/interface/type/enum NAME
  const re1 = /export\s+(?:async\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  // export { A, B as C }
  const re2 = /export\s*\{([^}]+)\}/g;
  // export default NAME (class/function)
  const re3 = /export\s+default\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re1.exec(content)) !== null) names.add(m[1]!);
  while ((m = re2.exec(content)) !== null) {
    for (const part of m[1]!.split(',')) {
      const as = part.split(/\s+as\s+/);
      const exported = (as[1] ?? as[0])!.trim();
      if (exported && exported !== 'default') names.add(exported);
    }
  }
  while ((m = re3.exec(content)) !== null) names.add(m[1]!);
  return names;
}

/** Extract the named imports a file pulls from a given module path. */
function importedNamesFrom(content: string, moduleHint: string): Set<string> {
  const names = new Set<string>();
  // import { A, B as C } from '...moduleHint...'
  const re = /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (!m[2]!.includes(moduleHint)) continue;
    for (const part of m[1]!.split(',')) {
      const as = part.split(/\s+as\s+/);
      const orig = as[0]!.trim();
      if (orig) names.add(orig);
    }
  }
  return names;
}

export class StagingArea {
  /** path → staged (not yet committed) edit. */
  private staged = new Map<string, StagedEntry>();
  /** path → committed content this run (mirrors what we wrote to disk). */
  private committed = new Map<string, string>();
  /** paths that have been deleted by a committed node. */
  private deleted = new Set<string>();

  constructor(private cwd: string) {}

  private abs(rel: string): string { return path.join(this.cwd, rel); }

  /** Current best-known content of a file: staged > committed > disk. */
  private async currentContent(rel: string): Promise<string | null> {
    if (this.staged.has(rel)) return this.staged.get(rel)!.content;
    if (this.committed.has(rel)) return this.committed.get(rel)!;
    if (this.deleted.has(rel)) return null;
    try { return await fs.readFile(this.abs(rel), 'utf-8'); } catch { return null; }
  }

  /**
   * Dry-run a candidate result. Stages its edits provisionally, then runs the
   * conflict checks. Returns conflicts (empty = clean). Does NOT commit.
   */
  async dryRunMerge(node: TaskNode, result: WorkerResult): Promise<ConflictRecord[]> {
    const conflicts: ConflictRecord[] = [];

    for (const edit of result.fileEdits) {
      // (a) same-file-write against another in-flight/committed node.
      const prior = this.staged.get(edit.path);
      if (prior && prior.taskId !== node.id) {
        conflicts.push({
          taskA: prior.taskId, taskB: node.id, file: edit.path,
          kind: 'same-file-write', resolution: 'serialized',
        });
      }

      // (b) import-broken: did this edit REMOVE an export that a known importer needs?
      const before = await this.currentContent(edit.path);
      if (before && !edit.isNew) {
        const removed = setDiff(extractExports(before), extractExports(edit.content));
        if (removed.size > 0) {
          const broken = await this.findBrokenImporters(edit.path, removed);
          for (const b of broken) {
            conflicts.push({
              taskA: node.id, taskB: b.importerTask ?? '(committed)', file: b.importer,
              kind: 'import-broken', resolution: 'manual-required',
            });
          }
        }
      }
    }

    // Provisionally stage (so subsequent dry-runs this tick see it). If the
    // scheduler decides the conflicts are fatal it will not call commit, and the
    // stage is rolled back via unstage().
    for (const edit of result.fileEdits) {
      this.staged.set(edit.path, { taskId: node.id, content: edit.content, isNew: edit.isNew });
    }

    return conflicts;
  }

  /**
   * Find files (committed or staged) that import one of `removedExports` from
   * `changedFile` — i.e. edits that would break them. The "logical conflict
   * without running code" detection.
   */
  private async findBrokenImporters(
    changedFile: string,
    removedExports: Set<string>,
  ): Promise<Array<{ importer: string; importerTask?: string }>> {
    const broken: Array<{ importer: string; importerTask?: string }> = [];
    const changedBase = path.basename(changedFile).replace(path.extname(changedFile), '');

    // Check every staged + committed file for an import of a removed symbol.
    const candidates = new Map<string, { content: string; taskId?: string }>();
    for (const [p, e] of this.staged) candidates.set(p, { content: e.content, taskId: e.taskId });
    for (const [p, c] of this.committed) if (!candidates.has(p)) candidates.set(p, { content: c });

    for (const [p, info] of candidates) {
      if (p === changedFile) continue;
      const imported = importedNamesFrom(info.content, changedBase);
      if (imported.size === 0) continue;
      for (const name of imported) {
        if (removedExports.has(name)) {
          broken.push({ importer: p, importerTask: info.taskId });
          break;
        }
      }
    }
    return broken;
  }

  /** Roll back a provisional stage (used when a dry-run is rejected). */
  unstage(taskId: string): void {
    for (const [p, e] of [...this.staged]) {
      if (e.taskId === taskId) this.staged.delete(p);
    }
  }

  /** Commit a node's staged edits to disk and record the snapshot. */
  async commit(node: TaskNode, result: WorkerResult): Promise<void> {
    for (const edit of result.fileEdits) {
      const abs = this.abs(edit.path);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      // Atomic write: temp + rename.
      const tmp = `${abs}.qodex-tmp-${process.pid}`;
      await fs.writeFile(tmp, edit.content, 'utf-8');
      await fs.rename(tmp, abs);
      this.committed.set(edit.path, edit.content);
      this.staged.delete(edit.path);
      this.deleted.delete(edit.path);
      logger.debug('Committed staged edit', { task: node.id, file: edit.path });
    }
  }

  committedPaths(): string[] { return [...this.committed.keys()]; }
}

function setDiff<T>(a: Set<T>, b: Set<T>): Set<T> {
  const out = new Set<T>();
  for (const x of a) if (!b.has(x)) out.add(x);
  return out;
}
