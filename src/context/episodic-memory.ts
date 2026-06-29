/**
 * Episodic memory — "how did I solve a task like this before?"
 *
 * Companion to user-preference modeling: instead of the user re-explaining a recurring
 * job, QodeX records a lean episode after each objectively-successful task and, at the
 * start of a NEW task, retrieves the most SIMILAR past episode(s) for this project and
 * injects a concise reminder into the prompt — so the agent reuses its own proven
 * approach. Smart, not heavy: it injects only the top-K above a similarity threshold (an
 * unrelated task injects nothing), and only a short summary, never full transcripts.
 *
 * v1 similarity is lexical TF-cosine (reusing the tested primitives from the skill-dedup
 * code) — dependency-free and lightweight. The ranker is a pure function so an
 * embedding-backed variant can be swapped in later without touching the call sites.
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import { logger } from '../utils/logger.js';
import { tokenize, termFreq, cosineSim } from '../skills/learning/similarity.js';

export interface Episode {
  ts: string;
  /** The task prompt. */
  prompt: string;
  /** A short summary of what worked. */
  summary: string;
  filesChanged: string[];
  toolsUsed: string[];
  /** Tool calls it took to finish — a cleanliness signal (fewer = tidier path). Optional
   *  so episodes recorded before this field still load. */
  toolCalls?: number;
}

export interface EpisodeMatch extends Episode { score: number }

function episodesPath(projectRoot: string): string {
  const hash = createHash('sha1').update(projectRoot).digest('hex').slice(0, 16);
  return path.join(os.homedir(), '.qodex', 'episodes', `${hash}.jsonl`);
}

/** Append one episode after an objectively-successful task. Best-effort. */
export async function recordEpisode(projectRoot: string, rec: Omit<Episode, 'ts'>): Promise<void> {
  try {
    if (!rec.prompt.trim()) return;
    const full = episodesPath(projectRoot);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.appendFile(full, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n', 'utf-8');
  } catch (e: any) {
    logger.debug('Episode not recorded', { err: e?.message });
  }
}

/** Read this project's episodes (most recent `limit`). */
export async function readEpisodes(projectRoot: string, limit = 500): Promise<Episode[]> {
  try {
    const raw = await fs.readFile(episodesPath(projectRoot), 'utf-8');
    const lines = raw.split('\n').filter(l => l.trim()).slice(-limit);
    return lines.map(l => { try { return JSON.parse(l) as Episode; } catch { return null; } }).filter(Boolean) as Episode[];
  } catch {
    return [];
  }
}

export interface RankOptions {
  topK?: number;
  minScore?: number;
  /**
   * Diversity weight (0–1) for the MMR selection. Episodic memory exists *because* tasks
   * recur, so the corpus fills with near-duplicate successes — without this, top-K can be
   * K copies of one task. Each pick is penalised by its max similarity to already-picked
   * episodes, so the K injected are relevant AND distinct. 0 = legacy (pure relevance).
   * Default 0.3 (gentle — relevance still dominates).
   */
  diversity?: number;
  /**
   * Optional file-existence predicate (injected; keeps this function PURE). An episode whose
   * recorded `filesChanged` mostly no longer exist is stale guidance — its relevance is
   * scaled down (not dropped: the *approach* may still help). Episodes with no files are
   * unaffected. Mirrors the codebase-fit grounding used in skill judgment.
   */
  fileExists?: (file: string) => boolean;
}

/** Fraction of an episode's touched files that still exist (1 when none recorded — nothing to judge). */
export function fileFreshness(files: string[], exists: (f: string) => boolean): number {
  if (files.length === 0) return 1;
  return files.filter(exists).length / files.length;
}

/**
 * Rank episodes against a query by lexical similarity (prompt + summary), then select a
 * RELEVANT-and-DIVERSE top-K. PURE.
 *
 *  - Excludes near-identical re-runs of the exact same prompt (score ≥ 0.98) so "similar
 *    past work" doesn't just echo the current task back.
 *  - File grounding: episodes pointing at files that no longer exist are scaled down
 *    (`fileExists`), so stale episodes lose to fresh ones.
 *  - MMR diversity (`diversity`): greedily pick highest relevance, penalising each remaining
 *    candidate by its similarity to what's already chosen — kills redundant injection.
 *  - Recency tie-break: episodes arrive oldest→newest, so a later index breaks near-ties
 *    toward the more recent solution (clock-free, stays pure).
 */
export function rankEpisodes(query: string, episodes: Episode[], opts: RankOptions = {}): EpisodeMatch[] {
  const topK = opts.topK ?? 2;
  const minScore = opts.minScore ?? 0.18;
  const lambda = Math.max(0, Math.min(1, opts.diversity ?? 0.3));
  const qv = termFreq(tokenize(query));
  if (qv.size === 0) return [];

  // 1) Relevance pass — keep candidates above the floor, carrying their term vector + order.
  type Cand = { e: Episode; vec: Map<string, number>; score: number; idx: number };
  const cands: Cand[] = [];
  episodes.forEach((e, idx) => {
    const vec = termFreq(tokenize(`${e.prompt} ${e.summary}`));
    let score = cosineSim(qv, vec);
    if (score < minScore || score >= 0.98) return;
    // File grounding: a half-stale episode keeps ~75% of its score; fully stale, ~50%.
    if (opts.fileExists) score *= 0.5 + 0.5 * fileFreshness(e.filesChanged, opts.fileExists);
    cands.push({ e, vec, score, idx });
  });

  // 2) MMR selection — relevant AND distinct; recency (idx) then score break ties.
  const picked: Cand[] = [];
  while (picked.length < topK && cands.length > 0) {
    let best = -1, bestVal = -Infinity, bestIdx = -1, bestScore = -Infinity;
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i]!;
      const maxSimToPicked = picked.length ? Math.max(...picked.map(p => cosineSim(c.vec, p.vec))) : 0;
      const val = lambda === 0 ? c.score : c.score - lambda * maxSimToPicked;
      if (val > bestVal || (val === bestVal && (c.idx > bestIdx || (c.idx === bestIdx && c.score > bestScore)))) {
        best = i; bestVal = val; bestIdx = c.idx; bestScore = c.score;
      }
    }
    if (best < 0) break;
    picked.push(cands.splice(best, 1)[0]!);
  }
  return picked.map(p => ({ ...p.e, score: p.score }));
}

/** Build the concise system-prompt block from matches. Empty when none. */
export function buildEpisodeBlock(matches: EpisodeMatch[]): string {
  if (matches.length === 0) return '';
  const lines = ['# Similar past work (your own, on this project)', '',
    'You have done comparable tasks here before. Reuse what worked — don\'t rediscover it:', ''];
  for (const m of matches) {
    const files = m.filesChanged.slice(0, 4).join(', ');
    lines.push(`- **"${m.prompt.replace(/\s+/g, ' ').trim().slice(0, 80)}"** → ${m.summary.replace(/\s+/g, ' ').trim().slice(0, 160)}${files ? `  (touched: ${files})` : ''}`);
  }
  return lines.join('\n');
}

/** Convenience: read → rank → build the injectable block for a query. Used by the loop.
 *  Builds a one-shot file-existence Set (each touched file checked once) so the pure ranker
 *  can ground episodes against the CURRENT tree without doing I/O itself. */
export async function loadEpisodeBlock(
  projectRoot: string,
  query: string,
  opts: { topK?: number; minScore?: number; diversity?: number } = {},
): Promise<string> {
  const episodes = await readEpisodes(projectRoot);
  // Resolve existence once per distinct file referenced by any episode.
  const referenced = new Set<string>();
  for (const e of episodes) for (const f of e.filesChanged) referenced.add(f);
  const existing = new Set<string>();
  await Promise.all([...referenced].map(async f => {
    try { await fs.access(path.resolve(projectRoot, f)); existing.add(f); } catch { /* gone */ }
  }));
  return buildEpisodeBlock(rankEpisodes(query, episodes, { ...opts, fileExists: f => existing.has(f) }));
}
