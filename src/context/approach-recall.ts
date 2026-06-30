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
  kind: 'episode' | 'worklog' | 'fact';
  /** The searchable text (prompt + summary, or the worklog entry). */
  text: string;
  when: string;
  /** ISO timestamp — for recency-aware ranking (a recent relevant approach beats a stale one). */
  at?: string;
  /** Files the episode touched (the "where"). */
  files?: string[];
  /** A short human label (the summary, or the worklog kind). */
  detail?: string;
}

export interface ApproachMatch extends ApproachSource { score: number }

/** A mild recency boost (0..0.06): a relevant approach from last week should edge out an equally
 *  relevant one from last year. PURE; decays to 0 over ~180 days. */
function recencyBoost(at: string | undefined, nowMs: number | undefined): number {
  if (!at || !nowMs) return 0;
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return 0;
  const ageDays = (nowMs - t) / 86_400_000;
  return Math.max(0, 0.06 * (1 - ageDays / 180));
}

/**
 * Rank past approaches against a query by lexical similarity, with a mild recency tilt so the most
 * RECENT relevant approach surfaces first on close calls. PURE. Returns top-K ≥ minScore.
 *
 * `diversity` (0..1) applies Maximal-Marginal-Relevance: each pick after the first is penalised by
 * how similar it is to already-selected approaches, so five near-identical "removed unused imports"
 * episodes don't fill every slot — you get a spread of distinct prior approaches instead. The TOP
 * result is unchanged (the first pick has nothing to be similar to). Default 0 = pure relevance.
 */
export function rankApproaches(
  query: string,
  sources: ApproachSource[],
  opts: { topK?: number; minScore?: number; nowMs?: number; diversity?: number } = {},
): ApproachMatch[] {
  const topK = opts.topK ?? 5;
  const minScore = opts.minScore ?? 0.12;
  const lambda = Math.max(0, Math.min(1, opts.diversity ?? 0));
  const qv = termFreq(tokenize(query));
  if (qv.size === 0) return [];
  const scored: { m: ApproachMatch; eff: number; tf: Map<string, number> }[] = [];
  for (const s of sources) {
    const tf = termFreq(tokenize(s.text));
    const score = cosineSim(qv, tf);
    if (score >= minScore) scored.push({ m: { ...s, score }, eff: score + recencyBoost(s.at, opts.nowMs), tf });
  }
  scored.sort((a, b) => b.eff - a.eff);
  if (lambda === 0 || scored.length <= 1) return scored.slice(0, topK).map(x => x.m);

  // Greedy MMR: repeatedly take the candidate maximising (eff − λ·maxSimToSelected).
  const pool = scored.slice();
  const picked: typeof scored = [];
  while (picked.length < topK && pool.length > 0) {
    let bestIdx = 0;
    let bestMmr = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i]!;
      let maxSim = 0;
      for (const p of picked) maxSim = Math.max(maxSim, cosineSim(c.tf, p.tf));
      const mmr = c.eff - lambda * maxSim;
      if (mmr > bestMmr) { bestMmr = mmr; bestIdx = i; }
    }
    picked.push(pool.splice(bestIdx, 1)[0]!);
  }
  return picked.map(x => x.m);
}

/** Render matches into a concise, agent-readable block. PURE. Empty when none. */
export function formatApproaches(query: string, matches: ApproachMatch[]): string {
  if (matches.length === 0) return `No past work on this project resembles "${query}".`;
  const lines = [`How you approached similar work before — "${query}":`, ''];
  for (const m of matches) {
    const tag = m.kind === 'episode' ? '🎯 task' : m.kind === 'fact' ? '🧠 fact' : `📝 ${m.detail ?? 'worklog'}`;
    const head = m.text.replace(/\s+/g, ' ').trim().slice(0, 140);
    const files = m.files?.length ? `  (touched: ${m.files.slice(0, 4).join(', ')})` : '';
    lines.push(`- [${tag} · ${m.when}] ${head}${files}`);
  }
  return lines.join('\n');
}
