/**
 * Pre-commit syntax gate.
 *
 * Before a mutating tool's content reaches the disk (Transaction.write), the
 * NEW content is parsed in-process with the same tree-sitter grammars the AST
 * tools already use. If the edit would introduce a syntax error that the file
 * did not have before, the write is refused and the model receives a
 * [SYNTAX_REJECTED] observation with the line number — the file on disk stays
 * untouched, dev servers keep running, and the model fixes the edit instead of
 * debugging a crashed workspace.
 *
 * Design decisions:
 *  - IN-PROCESS, not shadow files. tree-sitter parses the candidate string
 *    directly: no temp files, no `php -l`/`node --check` spawns, works even
 *    when php/python binaries are absent, and covers TS/TSX (which
 *    `node --check` cannot parse). JSON is validated with JSON.parse.
 *  - BASELINE TOLERANCE (the critical one): the gate only rejects when the
 *    ORIGINAL content parses clean and the NEW content does not — i.e. the
 *    edit itself introduced the breakage. If the file already had errors
 *    (work-in-progress file, grammar gap on exotic syntax, test fixture),
 *    the gate steps aside instead of locking the model out of the file.
 *  - FAIL-OPEN everywhere: unknown extension, missing grammar, parser init
 *    failure, oversized file → the write proceeds unguarded. A guard that can
 *    brick legitimate work is worse than no guard.
 *
 * Honest scope: tree-sitter checks SYNTAX (structure), not types or semantics.
 * A type error, a wrong API call, or a logic bug parses fine and passes this
 * gate — the post-edit verify/diagnostics system remains the layer for those.
 * Shell-driven writes (sed, redirects) bypass this gate entirely.
 *
 * NOTE: this module deliberately has NO static local imports (parser.js is
 * dynamically imported inside the orchestrator) so its pure logic can be unit
 * tested under `node --experimental-strip-types` without node_modules.
 */

export interface SyntaxIssue {
  line: number;        // 1-based
  excerpt: string;     // the offending source line, trimmed
  kind: 'error' | 'missing';
}

/** Minimal structural view of a tree-sitter node — lets tests use plain mocks. */
export interface TSNodeLike {
  type: string;
  childCount: number;
  child(i: number): TSNodeLike | null;
  startPosition: { row: number; column: number };
  hasError?: boolean | (() => boolean);
  isMissing?: boolean | (() => boolean);
}

const MAX_GATED_BYTES = 2 * 1024 * 1024; // beyond this, skip (fail-open)
const MAX_REPORTED_ISSUES = 3;

let gateEnabled = true;
export function setSyntaxGateEnabled(on: boolean): void { gateEnabled = on; }
export function isSyntaxGateEnabled(): boolean { return gateEnabled; }

function boolProp(v: boolean | (() => boolean) | undefined, self: any): boolean {
  if (typeof v === 'function') { try { return !!v.call(self); } catch { return false; } }
  return !!v;
}

/** Pure: walk a (mock or real) tree and collect ERROR / MISSING nodes. */
export function findIssuesInTree(root: TSNodeLike, content: string): SyntaxIssue[] {
  const lines = content.split('\n');
  const issues: SyntaxIssue[] = [];
  const visit = (node: TSNodeLike): void => {
    if (issues.length >= MAX_REPORTED_ISSUES) return;
    // Prune: only descend where an error lives (real tree-sitter sets hasError
    // on every ancestor of an ERROR/MISSING node). Mocks may omit it → descend.
    if (node.hasError !== undefined && !boolProp(node.hasError, node)) return;
    const missing = boolProp(node.isMissing, node);
    if (node.type === 'ERROR' || missing) {
      const line = node.startPosition.row + 1;
      issues.push({
        line,
        excerpt: (lines[node.startPosition.row] ?? '').trim().slice(0, 120),
        kind: missing ? 'missing' : 'error',
      });
      if (node.type === 'ERROR') return; // children of an ERROR node are noise
    }
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c) visit(c);
    }
  };
  visit(root);
  return issues;
}

/** Pure: JSON validation with a line number extracted from the parse error. */
export function checkJsonSyntax(content: string): SyntaxIssue[] {
  try {
    JSON.parse(content);
    return [];
  } catch (e: any) {
    const msg: string = e?.message ?? 'invalid JSON';
    let line = 1;
    const mPos = msg.match(/position (\d+)/i);
    const mLine = msg.match(/line (\d+)/i);
    if (mLine) line = parseInt(mLine[1], 10);
    else if (mPos) line = content.slice(0, parseInt(mPos[1], 10)).split('\n').length;
    const lines = content.split('\n');
    return [{ line, excerpt: (lines[line - 1] ?? '').trim().slice(0, 120), kind: 'error' }];
  }
}

/** Pure: the gate decision. Reject only if the EDIT introduced the breakage. */
export function shouldReject(beforeHadErrors: boolean | null, afterHasErrors: boolean): boolean {
  if (!afterHasErrors) return false;          // new content is clean → write
  if (beforeHadErrors === true) return false; // file was already broken / grammar gap → step aside
  return true;                                // clean (or new) file would become broken → refuse
}

/** Pure: the observation the model receives on refusal. */
export function buildSyntaxRejectMessage(filePath: string, language: string, issues: SyntaxIssue[]): string {
  const head = issues[0];
  const more = issues.length > 1 ? ` (+${issues.length - 1} more)` : '';
  const what = head.kind === 'missing' ? 'missing token' : 'syntax error';
  return (
    `[SYNTAX_REJECTED] This edit would break ${filePath}: ${language} ${what} at line ${head.line}` +
    (head.excerpt ? `: "${head.excerpt}"` : '') + more + '. ' +
    `The file on disk was NOT modified. Re-check your old_string/new_string boundaries ` +
    `(a brace, quote, or tag is likely unbalanced), fix the edit so the full file parses, then retry.`
  );
}

/**
 * Orchestrator used by Transaction.write / multi_file_edit.
 * Returns null when the write should proceed (clean, baseline-broken, or
 * uncheckable), or a ready [SYNTAX_REJECTED] message when it must be refused.
 */
export async function checkSyntaxForWrite(
  absPath: string,
  beforeContent: string | null,
  afterContent: string,
): Promise<string | null> {
  if (!gateEnabled) return null;
  if (afterContent.length > MAX_GATED_BYTES) return null;

  const lower = absPath.toLowerCase();
  if (lower.endsWith('.json')) {
    const after = checkJsonSyntax(afterContent);
    if (after.length === 0) return null;
    const beforeHad = beforeContent === null ? null : checkJsonSyntax(beforeContent).length > 0;
    return shouldReject(beforeHad, true) ? buildSyntaxRejectMessage(absPath, 'JSON', after) : null;
  }

  try {
    const { detectLanguage, getParser } = await import('./parser.js');
    const lang = detectLanguage(absPath);
    if (!lang) return null;                 // unknown extension → fail-open
    const p = await getParser(lang);
    if (!p) return null;                    // grammar unavailable → fail-open

    const parseIssues = (text: string): SyntaxIssue[] | null => {
      let tree: any = null;
      try {
        tree = p.parser.parse(text);
        if (!tree?.rootNode) return null;
        return findIssuesInTree(tree.rootNode as TSNodeLike, text);
      } catch (e: any) {
        // Fail-open (never block the write), but surface that the parser could
        // not run so a silently-broken parser isn't mistaken for "clean file".
        console.warn(`[syntax-check] parser could not run for ${absPath}; skipping syntax gate: ${e?.message ?? String(e)}`);
        return null;                        // parser hiccup → fail-open
      } finally {
        try { tree?.delete?.(); } catch { /* wasm cleanup best-effort */ }
      }
    };

    const after = parseIssues(afterContent);
    if (after === null || after.length === 0) return null;
    // Lazy baseline: only parse the original when the candidate is broken.
    const beforeIssues = beforeContent === null ? null : parseIssues(beforeContent);
    const beforeHad = beforeIssues === null ? (beforeContent === null ? null : true) : beforeIssues.length > 0;
    return shouldReject(beforeHad, true) ? buildSyntaxRejectMessage(absPath, lang, after) : null;
  } catch (e: any) {
    // Fail-open, but log so an unexpectedly-broken gate isn't read as "clean".
    console.warn(`[syntax-check] gate could not run for ${absPath}; skipping syntax check: ${e?.message ?? String(e)}`);
    return null;                            // anything unexpected → fail-open
  }
}
