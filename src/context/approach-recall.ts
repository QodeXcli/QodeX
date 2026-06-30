/**
 * Approach recall — "how did we solve a thing like this before?" answered from QodeX's OWN
 * history on the project: episodes (solved tasks + what worked) AND the project worklog
 * (accomplishments / decisions). A light lexical-semantic search ranks both by relevance to the
 * query; episodes carry the files they touched, so the answer points at WHERE it was done.
 *
 * Reuses the tested TF-cosine primitives. The ranker is PURE so it's unit-tested and an
 * embedding-backed variant can swap in later.
 */
import { tokenize, termFreq, cosineSim } from '../skills/learning/similarity.js';

export interface ApproachSource {
  kind: 'episode' | 'worklog';
  /** The searchable text (prompt + summary, or the worklog entry). */
  text: string;
  when: string;
  /** Files the episode touched (the "where"). */
  files?: string[];
  /** A short human label (the summary, or the worklog kind). */
  detail?: string;
}

export interface ApproachMatch extends ApproachSource { score: number }

/** Rank past approaches against a query by lexical similarity. PURE. Returns top-K ≥ minScore. */
export function rankApproaches(
  query: string,
  sources: ApproachSource[],
  opts: { topK?: number; minScore?: number } = {},
): ApproachMatch[] {
  const topK = opts.topK ?? 5;
  const minScore = opts.minScore ?? 0.12;
  const qv = termFreq(tokenize(query));
  if (qv.size === 0) return [];
  const scored: ApproachMatch[] = [];
  for (const s of sources) {
    const score = cosineSim(qv, termFreq(tokenize(s.text)));
    if (score >= minScore) scored.push({ ...s, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, topK);
}

/** Render matches into a concise, agent-readable block. PURE. Empty when none. */
export function formatApproaches(query: string, matches: ApproachMatch[]): string {
  if (matches.length === 0) return `No past work on this project resembles "${query}".`;
  const lines = [`How you approached similar work before — "${query}":`, ''];
  for (const m of matches) {
    const tag = m.kind === 'episode' ? '🎯 task' : `📝 ${m.detail ?? 'worklog'}`;
    const head = m.text.replace(/\s+/g, ' ').trim().slice(0, 140);
    const files = m.files?.length ? `  (touched: ${m.files.slice(0, 4).join(', ')})` : '';
    lines.push(`- [${tag} · ${m.when}] ${head}${files}`);
  }
  return lines.join('\n');
}
