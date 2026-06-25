/**
 * Curator — drives candidate skills through the INDEPENDENT judge to promotion.
 *
 * Order of operations is the safety story:
 *   1. Snapshot the whole skills dir (tar.gz) → a rollback point exists before any change.
 *   2. For each candidate, run an independent judge (the 'reflection'-role model). If it
 *      resolves to the SAME model that authors captures (config.defaults.model), there is
 *      NO independent judge available → the candidate is left quarantined, never promoted
 *      on a self-grade.
 *   3. `decidePromotion` (pure) makes the final call: independent + passing judge AND no
 *      human-authored skill of the same name. Only then `promoteCandidate` moves it, and
 *      that function re-checks the human-protection guard itself (defense in depth).
 *
 * Nothing here can overwrite a human skill, and nothing is promoted on the worker's own
 * say-so — the two halves of the anti-self-congratulation design.
 */
import { loadConfig } from '../../config/loader.js';
import { ModelRouter } from '../../llm/router.js';
import { logger } from '../../utils/logger.js';
import { loadSkillByName } from '../loader.js';
import { listCandidates, readCandidate, promoteCandidate, writeCandidate, archiveCandidate } from './candidate-store.js';
import { buildJudgePrompt, parseJudgeVerdict, buildMergePrompt, parseMergeResult } from './judge.js';
import { decidePromotion } from './promotion.js';
import { snapshotSkills } from './snapshot.js';
import { findSimilarPairs, skillSimilarityText } from './similarity.js';

export interface CurateResult {
  snapshot: string | null;
  merged: Array<{ from: string[]; into: string }>;
  promoted: string[];
  rejected: Array<{ name: string; reason: string }>;
  skipped: Array<{ name: string; reason: string }>;
}

/** Pull name + description + body out of a candidate's SKILL.md for similarity scoring. */
function candidateSimText(md: string, name: string): string {
  const desc = md.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? '';
  const body = md.replace(/^---[\s\S]*?---\s*/m, '');
  return skillSimilarityText(name, desc, body);
}

async function drainText(stream: AsyncGenerator<any>): Promise<string> {
  let text = '';
  for await (const ev of stream) {
    if (ev?.type === 'text_delta') text += ev.delta ?? '';
  }
  return text;
}

export async function curateCandidates(
  cwd: string,
  opts: { onProgress?: (m: string) => void; similarityThreshold?: number } = {},
): Promise<CurateResult> {
  const log = opts.onProgress ?? (() => {});
  const candidates = await listCandidates();
  const result: CurateResult = { snapshot: null, merged: [], promoted: [], rejected: [], skipped: [] };
  if (candidates.length === 0) { log('No candidates to curate.'); return result; }

  // 1) Rollback point BEFORE any change.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  result.snapshot = await snapshotSkills(stamp).catch(e => { logger.warn('Skills snapshot failed', { err: e?.message }); return null; });

  // Independent judge: the 'reflection' role; author = the capture/default model.
  // Load ~/.qodex/.env first — this runs outside the main `bootstrap()` (which loads it),
  // so without this the router sees no cloud API keys and the judge resolves to nothing.
  try {
    const { loadEnvFileIntoProcess } = await import('../../setup/env-writer.js');
    await loadEnvFileIntoProcess();
  } catch { /* best-effort */ }
  const config = await loadConfig(cwd);
  const authorModel = String((config as any).defaults?.model ?? '');
  const router = new ModelRouter(config);
  await router.initialize();

  let judgeRoute;
  try {
    judgeRoute = router.route('reflection', 2000, {});
  } catch (e: any) {
    log(`No judge model available (${e?.message}); leaving all candidates quarantined.`);
    for (const c of candidates) result.skipped.push({ name: c.name, reason: 'no judge model' });
    return result;
  }

  const independent = !!judgeRoute.model && judgeRoute.model !== authorModel;

  // ── Merge pass: collapse near-duplicate candidates before promoting them ──
  // Semantic dedup so the library doesn't accumulate ten variants of one capability.
  // Lexical cosine finds the suspects (no model, always works); the INDEPENDENT judge
  // decides whether to actually merge and writes the unified SKILL.md. Skipped entirely
  // if there's no independent judge (we never merge on a self-grade).
  const mergedAway = new Set<string>();
  if (independent) {
    const threshold = (opts.similarityThreshold ?? 0.6);
    const texts = await Promise.all(candidates.map(async c => ({ name: c.name, text: candidateSimText((await readCandidate(c.name)) ?? '', c.name) })));
    const pairs = findSimilarPairs(texts, threshold);
    for (const pair of pairs) {
      if (mergedAway.has(pair.a) || mergedAway.has(pair.b)) continue; // each candidate merges once
      const aMd = await readCandidate(pair.a); const bMd = await readCandidate(pair.b);
      if (!aMd || !bMd) continue;
      log(`Similar candidates "${pair.a}" ~ "${pair.b}" (${pair.score.toFixed(2)}) — asking judge to merge …`);
      try {
        const { system, user } = buildMergePrompt({ name: pair.a, md: aMd }, { name: pair.b, md: bMd });
        const text = await drainText(judgeRoute.provider.complete({ model: judgeRoute.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0 } as any));
        const merge = parseMergeResult(text);
        if (merge.merge && !mergedAway.has(merge.name)) {
          await writeCandidate({ name: merge.name, description: '', skillMd: merge.skillMd });
          // Remove the originals UNLESS one of them is the merge target name itself.
          for (const orig of [pair.a, pair.b]) if (orig !== merge.name) { await archiveCandidate(orig); mergedAway.add(orig); }
          result.merged.push({ from: [pair.a, pair.b], into: merge.name });
          log(`  ⤳ merged into "${merge.name}"`);
        }
      } catch (e: any) {
        log(`  merge skipped: ${e?.message}`);
      }
    }
  }

  // Re-list after the merge pass so promotion sees the collapsed set.
  const liveCandidates = (await listCandidates()).filter(c => !mergedAway.has(c.name));
  const existingNames = liveCandidates.map(c => c.name);
  for (const c of liveCandidates) {
    const md = await readCandidate(c.name);
    if (!md) { result.skipped.push({ name: c.name, reason: 'unreadable' }); continue; }

    // Enforce independence up front: a judge model equal to the author model is a self-grade.
    if (!judgeRoute.model || judgeRoute.model === authorModel) {
      result.skipped.push({ name: c.name, reason: `judge model equals author model (${authorModel}) — configure a separate routing.reflection model` });
      continue;
    }

    log(`Judging "${c.name}" with ${judgeRoute.model} …`);
    let verdict;
    try {
      const { system, user } = buildJudgePrompt(md, existingNames.filter(n => n !== c.name));
      const text = await drainText(judgeRoute.provider.complete({
        model: judgeRoute.model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature: 0,
      } as any));
      verdict = parseJudgeVerdict(text, judgeRoute.model);
    } catch (e: any) {
      result.skipped.push({ name: c.name, reason: `judge call failed: ${e?.message}` });
      continue;
    }

    const activeSameName = await loadSkillByName(c.name, cwd);
    const decision = decidePromotion({ authorModel, verdict, activeSameName });
    if (!decision.promote) {
      result.rejected.push({ name: c.name, reason: decision.reason });
      log(`  ✗ ${c.name}: ${decision.reason}`);
      continue;
    }
    const promo = await promoteCandidate(c.name, cwd);
    if (promo.promoted) { result.promoted.push(c.name); log(`  ✓ promoted ${c.name}`); }
    else { result.rejected.push({ name: c.name, reason: promo.reason }); log(`  ✗ ${c.name}: ${promo.reason}`); }
  }

  return result;
}
