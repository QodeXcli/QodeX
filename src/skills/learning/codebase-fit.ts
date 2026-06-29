/**
 * Codebase-fit signal for skill judgment — QodeX's differentiator (Code Graph in the loop).
 *
 * A captured candidate skill is a playbook. Beyond "is it well-written?" (the judge rubric), QodeX
 * can ask something no file-only agent can: **does this skill actually fit THIS codebase?** A skill
 * that names symbols which really exist in the project's code graph is grounded and applicable; one
 * full of symbols absent from the graph is generic boilerplate or hallucinated. We measure that as a
 * fraction and feed it to the judge so it weighs specificity against reality.
 *
 * Pure + dependency-free: `extractSymbolHints` and `codebaseFitScore` take plain inputs (the
 * existence check is injected), so the scoring is unit-tested without a real code graph.
 */

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'use', 'run', 'add', 'get', 'set', 'new', 'true', 'false',
  'null', 'const', 'let', 'var', 'function', 'return', 'import', 'export', 'async', 'await', 'class',
  'string', 'number', 'boolean', 'void', 'type', 'interface', 'npm', 'yarn', 'pnpm', 'git', 'http', 'https',
  'json', 'yaml', 'env', 'src', 'lib', 'test', 'README', 'TODO', 'API', 'URL', 'ID', 'cwd',
]);

/**
 * Pull plausible CODE IDENTIFIERS a candidate skill mentions: from inline `code` spans and fenced
 * ```code``` blocks first (highest signal), then CamelCase / snake_case tokens in prose. Deduped,
 * stop-words and trivial tokens removed. PURE.
 */
export function extractSymbolHints(skillMd: string): string[] {
  const hints = new Set<string>();
  const add = (raw: string) => {
    for (const m of raw.matchAll(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g)) {
      const t = m[0];
      if (STOPWORDS.has(t) || STOPWORDS.has(t.toLowerCase())) continue;
      // Keep things that look like identifiers, not plain English: has a case mix, an underscore/$,
      // or a camelCase/PascalCase hump.
      if (/[_$]/.test(t) || /[a-z][A-Z]/.test(t) || /^[A-Z][a-z]+[A-Z]/.test(t)) hints.add(t);
    }
  };
  // Inline code + fenced blocks carry the real symbol names.
  for (const m of skillMd.matchAll(/`([^`]+)`/g)) add(m[1]!);
  for (const m of skillMd.matchAll(/```[\s\S]*?```/g)) add(m[0]);
  return [...hints];
}

export interface CodebaseFit {
  /** matched / total, in [0,1]. */
  score: number;
  matched: string[];
  total: number;
  /** True when there were no identifier hints to judge against (score is then not meaningful). */
  noSignal: boolean;
}

/**
 * Score how many of a skill's identifier hints exist in the codebase. `exists` is injected
 * (e.g. name => codeGraph.findSymbolsByName(name).length > 0). PURE. */
export function codebaseFitScore(hints: string[], exists: (name: string) => boolean): CodebaseFit {
  if (hints.length === 0) return { score: 0, matched: [], total: 0, noSignal: true };
  const matched = hints.filter(h => { try { return exists(h); } catch { return false; } });
  return { score: matched.length / hints.length, matched, total: hints.length, noSignal: false };
}

/** A one-line note for the judge prompt / candidate metadata. Empty when there's no signal. */
export function fitNote(fit: CodebaseFit): string {
  if (fit.noSignal) return '';
  const pct = Math.round(fit.score * 100);
  return `Codebase fit: ${fit.matched.length}/${fit.total} referenced symbols exist in this project's code graph (${pct}%). ` +
    `A skill grounded in real codebase symbols is more applicable here; weigh its specificity accordingly.`;
}
