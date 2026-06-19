/**
 * QA / Vision Node — the reviewer in the Triad.
 *
 * Reviews a worker's staged output BEFORE it's committed, producing a QaVerdict
 * with hard blockers (must-fix; trigger a retry) and soft warnings (logged).
 * Three layers, cheapest-first so we fail fast:
 *
 *   1. STATIC — parse each edited file with the AST parser. A file that no
 *      longer parses is an immediate blocker (the worker emitted broken code).
 *      We also check the worker actually wrote the files it was told to.
 *
 *   2. DESIGN-SYSTEM — for component/style nodes, run the existing design_audit
 *      heuristics over the staged content (not the disk file): flag raw hex
 *      colors when tokens exist, missing dark-mode variants, off-grid spacing —
 *      the `taste` skill's rules. These are warnings unless the node explicitly
 *      requires design adherence.
 *
 *   3. VISION — for nodes flagged visualReview, render via the dev server +
 *      Puppeteer screenshot, then hand the image to the vision role for a
 *      written critique. This is the most expensive layer so it runs only when
 *      requested and only after static + design pass.
 *
 * The QA node uses a SEPARATE model (the vision/review role) from the worker —
 * this is the "multi-model peer review" that catches a model's own blind spots.
 */

import type { TaskNode, WorkerResult, QaVerdict } from './protocol.js';
import { getParser, detectLanguage } from '../tools/ast/parser.js';
import { logger } from '../utils/logger.js';

export interface QaHooks {
  /**
   * Run a typecheck over the staged files (the engine wires this to a tsc
   * invocation scoped to touched files, or a no-op when tsc isn't available).
   * Returns error strings (empty = clean).
   */
  typecheck?(files: Array<{ path: string; content: string }>, signal?: AbortSignal): Promise<string[]>;
  /**
   * Run the design audit over staged content. Returns issues. Wired to the
   * existing design_audit logic by the engine.
   */
  designAudit?(files: Array<{ path: string; content: string }>): Promise<Array<{ severity: 'high' | 'medium' | 'low'; message: string }>>;
  /**
   * Render + screenshot a route, then return a vision critique. Wired to
   * dev_server + browser_screenshot + the vision role.
   */
  visualReview?(node: TaskNode, signal?: AbortSignal): Promise<{ screenshotPath: string; notes: string; ok: boolean }>;
}

export class QaNode {
  constructor(private hooks: QaHooks = {}) {}

  async review(node: TaskNode, result: WorkerResult, signal?: AbortSignal): Promise<QaVerdict> {
    const blockers: string[] = [];
    const warnings: string[] = [];

    // 0. Did the worker produce the files it was supposed to?
    const wrote = new Set(result.fileEdits.map(e => e.path));
    for (const expected of node.targetFiles) {
      if (!wrote.has(expected)) {
        blockers.push(`Expected file not produced: ${expected}`);
      }
    }
    // Did it write outside its allowed set?
    for (const e of result.fileEdits) {
      if (node.targetFiles.length > 0 && !node.targetFiles.includes(e.path)) {
        warnings.push(`Wrote file outside assigned scope: ${e.path}`);
      }
    }

    // 1. STATIC parse check.
    for (const edit of result.fileEdits) {
      const parseErr = await this.parseCheck(edit.path, edit.content);
      if (parseErr) blockers.push(parseErr);
    }

    // 1b. Optional typecheck (scoped).
    if (this.hooks.typecheck && blockers.length === 0) {
      try {
        const errs = await this.hooks.typecheck(result.fileEdits.map(e => ({ path: e.path, content: e.content })), signal);
        for (const err of errs) blockers.push(err);
      } catch (e: any) {
        logger.debug('Typecheck hook threw (non-fatal)', { err: e?.message });
      }
    }

    // 2. DESIGN audit for visual kinds.
    if ((node.kind === 'component' || node.kind === 'style') && this.hooks.designAudit && blockers.length === 0) {
      try {
        const issues = await this.hooks.designAudit(result.fileEdits.map(e => ({ path: e.path, content: e.content })));
        for (const issue of issues) {
          if (issue.severity === 'high') blockers.push(`Design: ${issue.message}`);
          else warnings.push(`Design: ${issue.message}`);
        }
      } catch (e: any) {
        logger.debug('Design audit hook threw (non-fatal)', { err: e?.message });
      }
    }

    // 3. VISION review when requested and everything else passed.
    let visual: QaVerdict['visual'];
    if (node.visualReview && this.hooks.visualReview && blockers.length === 0) {
      try {
        const v = await this.hooks.visualReview(node, signal);
        visual = { screenshotPath: v.screenshotPath, notes: v.notes };
        if (!v.ok) blockers.push(`Visual review failed: ${v.notes}`);
      } catch (e: any) {
        logger.debug('Visual review hook threw (non-fatal)', { err: e?.message });
        warnings.push('Visual review could not run');
      }
    }

    return {
      taskId: node.id,
      passed: blockers.length === 0,
      blockers,
      warnings,
      visual,
    };
  }

  /** Parse a file with tree-sitter; return an error string if it fails to parse. */
  private async parseCheck(rel: string, content: string): Promise<string | null> {
    const lang = detectLanguage(rel);
    if (!lang) return null; // unknown language — skip (don't block on e.g. .md)
    let parser;
    try { parser = await getParser(lang); } catch { return null; }
    if (!parser) return null;
    let tree;
    try { tree = parser.parser.parse(content); } catch (e: any) {
      return `${rel}: parser threw — ${e?.message ?? 'unknown'}`;
    }
    if (this.hasError(tree.rootNode)) {
      const loc = this.firstErrorLine(tree.rootNode, content);
      return `${rel}: syntax error${loc ? ` near line ${loc}` : ''} (worker emitted unparseable code)`;
    }
    return null;
  }

  private hasError(node: any): boolean {
    if (node.type === 'ERROR' || node.isMissing?.()) return true;
    for (let i = 0; i < (node.childCount ?? 0); i++) {
      if (this.hasError(node.child(i))) return true;
    }
    return false;
  }

  private firstErrorLine(node: any, _content: string): number | null {
    if (node.type === 'ERROR' || node.isMissing?.()) return (node.startPosition?.row ?? 0) + 1;
    for (let i = 0; i < (node.childCount ?? 0); i++) {
      const l = this.firstErrorLine(node.child(i), _content);
      if (l) return l;
    }
    return null;
  }
}
