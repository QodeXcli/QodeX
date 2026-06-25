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

/**
 * Rank episodes against a query by lexical similarity (prompt + summary). PURE.
 * Excludes near-identical re-runs of the exact same prompt (score ≥ 0.98) so "similar past
 * work" doesn't just echo the current task back. Returns top-K with score ≥ minScore.
 */
export function rankEpisodes(query: string, episodes: Episode[], opts: { topK?: number; minScore?: number } = {}): EpisodeMatch[] {
  const topK = opts.topK ?? 2;
  const minScore = opts.minScore ?? 0.18;
  const qv = termFreq(tokenize(query));
  if (qv.size === 0) return [];
  const scored: EpisodeMatch[] = [];
  for (const e of episodes) {
    const score = cosineSim(qv, termFreq(tokenize(`${e.prompt} ${e.summary}`)));
    if (score >= minScore && score < 0.98) scored.push({ ...e, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, topK);
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

/** Convenience: read → rank → build the injectable block for a query. Used by the loop. */
export async function loadEpisodeBlock(projectRoot: string, query: string, opts: { topK?: number; minScore?: number } = {}): Promise<string> {
  return buildEpisodeBlock(rankEpisodes(query, await readEpisodes(projectRoot), opts));
}
