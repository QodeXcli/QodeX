/**
 * Curator — drives candidate skills through the INDEPENDENT judge to promotion.
 *
 * Order of operations is the safety story:
 *   1. Snapshot the whole skills dir (tar.gz) → a rollback point exists before any change.
 *   2. For each candidate, run an independent judge (the 'reflection'-role model). If it
 *      resolves to the SAME model that authors captures (config.defaults.model), there is
 *      NO independent judge available. The candidate is NOT self-graded. Instead, when
 *      `learning.witnessFallback` is on (the default), the curator replays the skill's
 *      witness diff in a clean worktree and promotes only if the real verifier is clean.
 *   3. `decidePromotion` (pure) makes the final call: independent + passing judge, OR a
 *      passing witness when no independent judge exists, AND no human-authored skill of
 *      the same name. Only then `promoteCandidate` moves it, and that function re-checks
 *      the human-protection guard itself (defense in depth).
 *
 * Nothing here can overwrite a human skill, and nothing is promoted on the worker's own
 * say-so — the two halves of the anti-self-congratulation design.
 */
import { loadConfig } from '../../config/loader.js';
import { ModelRouter } from '../../llm/router.js';
import { logger } from '../../utils/logger.js';
import { loadSkillByName } from '../loader.js';
import { listCandidates, readCandidate, promoteCandidate, writeCandidate, archiveCandidate } from './candidate-store.js';
import { buildMergePrompt, parseMergeResult } from './judge.js';
import {
  buildRubricPrompt, parseRubricScores, shouldEscalate, rubricToVerdict,
  alignmentDrift, buildCalibrationBlock, type DriftRecord, type RubricScores,
} from './judge-cascade.js';
import { decidePromotion } from './promotion.js';
import { snapshotSkills } from './snapshot.js';
import { findSimilarPairs, skillSimilarityText } from './similarity.js';
import { recordLearningEvent } from './ledger.js';
import { promises as fsp } from 'fs';
import * as os from 'os';
import * as nodePath from 'path';

const driftPath = () => nodePath.join(os.homedir(), '.qodex', 'judge-drift.jsonl');
async function readDrift(): Promise<DriftRecord[]> {
  try { return (await fsp.readFile(driftPath(), 'utf-8')).split('\n').filter(Boolean).map(l => JSON.parse(l) as DriftRecord); }
  catch { return []; }
}
async function appendDrift(r: DriftRecord): Promise<void> {
  try { await fsp.mkdir(nodePath.dirname(driftPath()), { recursive: true }); await fsp.appendFile(driftPath(), JSON.stringify(r) + '\n', 'utf-8'); }
  catch { /* best-effort */ }
}

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

  // Explicit judge model (learning.judgeModel) wins; else the 'reflection' role.
  const explicitJudge = String((config as any).learning?.judgeModel ?? '').trim();
  let judgeRoute: ReturnType<ModelRouter['route']> | null = null;
  try {
    judgeRoute = router.route('reflection', 2000, explicitJudge ? { explicitModel: explicitJudge } : {});
  } catch (e: any) {
    log(`No judge model available (${e?.message}).`);
  }

  const witnessFallback = (config as any).learning?.witnessFallback !== false;
  const independent = !!judgeRoute?.model && judgeRoute.model !== authorModel;
  if (!independent && !witnessFallback) {
    log('No independent judge and witness fallback is off; leaving all candidates quarantined.');
    for (const c of candidates) result.skipped.push({ name: c.name, reason: 'no independent judge' });
    return result;
  }
  if (!independent) {
    log('No independent judge — only a witnessed diff that replays cleanly under the real verifier can promote.');
  }

  // ── Merge pass: collapse near-duplicate candidates before promoting them ──
  // Semantic dedup so the library doesn't accumulate ten variants of one capability.
  // Lexical cosine finds the suspects (no model, always works); the INDEPENDENT judge
  // decides whether to actually merge and writes the unified SKILL.md. Skipped entirely
  // if there's no independent judge (we never merge on a self-grade).
  const mergedAway = new Set<string>();
  if (independent && judgeRoute) {
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
          await recordLearningEvent({ event: 'merge', name: merge.name, from: [pair.a, pair.b], judge: judgeRoute.model });
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

  // ── Escalating cascade setup ── Tier 1 is judgeRoute (the light/local judge). Tier 2 is an
  // optional heavy model (learning.judgeModelTier2) we escalate to only when Tier 1 is unsure.
  const tier2Model = String((config as any).learning?.judgeModelTier2 ?? '').trim();
  let tier2Route: ReturnType<typeof router.route> | null = null;
  if (tier2Model && tier2Model !== authorModel && tier2Model !== judgeRoute?.model) {
    try { tier2Route = router.route('reflection', 2000, { explicitModel: tier2Model }); } catch { tier2Route = null; }
  }
  // Calibration: if Tier 1 has been drifting from Tier 2, feed it the worst past corrections.
  const driftRecords = await readDrift();
  const calibration = buildCalibrationBlock(driftRecords, 3);

  // Code Graph in the judge (QodeX's differentiator): give the reviewer a grounding signal — how many
  // of the candidate's referenced symbols actually exist in this project's code graph. Best-effort.
  const fitNoteFor = async (md: string): Promise<string> => {
    try {
      const { getCodeGraphDB } = await import('../../codegraph/tools.js');
      const db = getCodeGraphDB();
      if (!db) return '';
      const { extractSymbolHints, codebaseFitScore, fitNote } = await import('./codebase-fit.js');
      return fitNote(codebaseFitScore(extractSymbolHints(md), n => db.findSymbolsByName(n, undefined, 1).length > 0));
    } catch { return ''; }
  };

  const scoreWith = async (route: NonNullable<typeof tier2Route>, md: string, calib: string): Promise<RubricScores | null> => {
    const { system, user } = buildRubricPrompt(md, calib, await fitNoteFor(md));
    const text = await drainText(route.provider.complete({ model: route.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0 } as any));
    return parseRubricScores(text);
  };

  for (const c of liveCandidates) {
    const md = await readCandidate(c.name);
    if (!md) { result.skipped.push({ name: c.name, reason: 'unreadable' }); continue; }

    // No independent judge: do not self-grade. Replay the witness diff instead.
    if (!independent) {
      log(`No independent judge for "${c.name}" — replaying witness patch …`);
      const { replayWitness } = await import('./witness.js');
      const witness = await replayWitness(cwd, md);
      const activeSameName = await loadSkillByName(c.name, cwd);
      const decision = decidePromotion({ authorModel, verdict: null, activeSameName, witness });
      if (!decision.promote) {
        const soft = witness.replay === 'absent' || witness.replay === 'rejected';
        (soft ? result.skipped : result.rejected).push({ name: c.name, reason: decision.reason });
        if (!soft) await recordLearningEvent({ event: 'reject', name: c.name, judge: 'witness' });
        log(`  ${soft ? '↷' : '✗'} ${c.name}: ${decision.reason}`);
        continue;
      }
      const promo = await promoteCandidate(c.name, cwd);
      if (promo.promoted) {
        result.promoted.push(c.name);
        await recordLearningEvent({ event: 'promote', name: c.name, judge: `witness:${witness.checker ?? 'verifier'}` });
        log(`  ✓ promoted ${c.name} by witnessed replay`);
      } else {
        result.rejected.push({ name: c.name, reason: promo.reason });
        await recordLearningEvent({ event: 'reject', name: c.name, judge: 'witness' });
        log(`  ✗ ${c.name}: ${promo.reason}`);
      }
      continue;
    }

    // Independent judge exists (narrowed): it is a different model than the author.
    const judge = judgeRoute!;

    // ── Escalating cascade: Tier 1 (light) scores; escalate to Tier 2 (heavy) only when unsure ──
    let verdict;
    try {
      log(`Judging "${c.name}" with ${judge.model} (Tier 1) …`);
      const t1 = await scoreWith(judge, md, calibration);
      let finalScores = t1, finalModel = judge.model, reasons: string[] = [];
      // Escalate when Tier 1 couldn't score (null) or is in the grey/confused zone, and a Tier 2 exists.
      if (tier2Route && (!t1 || shouldEscalate(t1))) {
        log(`  ↑ escalating "${c.name}" to ${tier2Route.model} (Tier 2)${t1 ? ` — avg/variance unclear` : ' — Tier 1 unparseable'} …`);
        const t2 = await scoreWith(tier2Route, md, '');
        if (t2) {
          finalScores = t2; finalModel = tier2Route.model; reasons = [t2.justification].filter(Boolean);
          if (t1) await appendDrift({ ts: new Date().toISOString(), tier1: t1, tier2: t2, drift: alignmentDrift(t1, t2) });
        }
      } else if (t1) {
        reasons = [t1.justification].filter(Boolean);
      }
      if (!finalScores) { result.skipped.push({ name: c.name, reason: 'judge produced no parseable scores (Tier 1 + Tier 2)' }); continue; }
      verdict = { pass: rubricToVerdict(finalScores), judgeModel: finalModel, reasons };
    } catch (e: any) {
      result.skipped.push({ name: c.name, reason: `judge call failed: ${e?.message}` });
      continue;
    }

    const activeSameName = await loadSkillByName(c.name, cwd);
    const decision = decidePromotion({ authorModel, verdict, activeSameName });
    if (!decision.promote) {
      result.rejected.push({ name: c.name, reason: decision.reason });
      await recordLearningEvent({ event: 'reject', name: c.name, judge: judge.model });
      log(`  ✗ ${c.name}: ${decision.reason}`);
      continue;
    }
    // Confidence floor (learning.autoPromoteMinConfidence): the judge passed, but a
    // low-confidence capture can be held back for human review rather than auto-promoted.
    const minConf = Number((config as any).learning?.autoPromoteMinConfidence ?? 0);
    const conf = Number(md.match(/^confidence:\s*(\d+)/m)?.[1] ?? NaN);
    if (minConf > 0 && Number.isFinite(conf) && conf < minConf) {
      result.rejected.push({ name: c.name, reason: `judge passed but confidence ${conf} < ${minConf} — kept for human review` });
      log(`  ⏸ ${c.name}: confidence ${conf} < ${minConf}, kept as candidate`);
      continue;
    }
    const promo = await promoteCandidate(c.name, cwd);
    if (promo.promoted) {
      result.promoted.push(c.name);
      await recordLearningEvent({ event: 'promote', name: c.name, judge: judge.model });
      log(`  ✓ promoted ${c.name}`);
    } else {
      result.rejected.push({ name: c.name, reason: promo.reason });
      await recordLearningEvent({ event: 'reject', name: c.name, judge: judge.model });
      log(`  ✗ ${c.name}: ${promo.reason}`);
    }
  }

  return result;
}
