/**
 * Skill similarity — detect near-duplicate MACHINE skills so the curator can MERGE
 * parallel captures instead of accumulating ten variants of "make a React component".
 *
 * Pure + dependency-free: a term-frequency COSINE over normalized tokens of the skill's
 * (name + description + body). This needs no model and runs on any hardware, so dedup
 * always works. (An embedding-backed variant can be layered on later by feeding vectors
 * into `cosineSim`; the curator falls back to this whenever embeddings aren't available.)
 *
 * Why cosine-over-TF rather than Jaccard: two skills that share the same key verbs/nouns
 * but differ in length should still read as similar; cosine normalizes for length.
 */

const STOP = new Set([
  'the', 'a', 'an', 'to', 'of', 'and', 'or', 'for', 'in', 'on', 'with', 'this', 'that',
  'is', 'are', 'be', 'it', 'as', 'by', 'at', 'from', 'use', 'used', 'using', 'skill',
  'candidate', 'task', 'when', 'how', 'you', 'your', 'machine',
]);

/**
 * Tokenize for lexical recall / skill-dedup.
 *
 * Splits camelCase and path/kebab/snake identifiers so `formatLogLine` and
 * `src/utils/log-format.ts` share `log`/`format` with a prose query. Keeps
 * Unicode letters (Persian/Arabic/…) — the old `/[a-z0-9]+/` regex dropped them
 * and a Farsi prompt could never match an English episode (cosine 0).
 *
 * Then drops 1-char tokens and English stopwords (common noise). PURE.
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const normalized = text
    .replace(/([a-z\u00C0-\u024F])([A-Z])/g, '$1 $2')
    .replace(/[-_./\\]+/g, ' ')
    .toLowerCase();
  const tokens = normalized.match(/[\p{Letter}\p{Number}]+/gu) ?? [];
  return tokens.filter(t => t.length > 1 && !STOP.has(t));
}

/** Term-frequency map for a token list. */
export function termFreq(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

/** Cosine similarity between two term-frequency vectors. Range [0,1]. */
export function cosineSim(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let dot = 0;
  for (const [t, av] of a) { const bv = b.get(t); if (bv) dot += av * bv; }
  let na = 0; for (const v of a.values()) na += v * v;
  let nb = 0; for (const v of b.values()) nb += v * v;
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** The text a skill is compared on. Name is weighted (repeated) — same name verbs are a
 *  strong duplicate signal. */
export function skillSimilarityText(name: string, description: string, body: string): string {
  return `${name} ${name} ${description} ${body}`;
}

export interface SimItem { name: string; text: string }
export interface SimPair { a: string; b: string; score: number }

/**
 * All pairs of items whose similarity ≥ threshold, strongest first. O(n²) over the
 * candidate set, which is tiny (curator runs over a handful of pending captures).
 */
export function findSimilarPairs(items: SimItem[], threshold = 0.6): SimPair[] {
  const tf = items.map(it => termFreq(tokenize(it.text)));
  const pairs: SimPair[] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const score = cosineSim(tf[i]!, tf[j]!);
      if (score >= threshold) pairs.push({ a: items[i]!.name, b: items[j]!.name, score });
    }
  }
  return pairs.sort((x, y) => y.score - x.score);
}
