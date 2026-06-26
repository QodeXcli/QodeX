/**
 * Flat, OS-agnostic versioned-skill storage (Phase 4 I/O).
 *
 * Thin disk layer over the pure bandit in skill-versioning.ts. A skill dir is EITHER:
 *   - legacy: a single SKILL.md (unchanged — everything still works), OR
 *   - versioned: manifest.json + SKILL.v1.md / SKILL.v2.md / …
 *
 * `routedSkillBody` returns the body to inject this turn: the UCB1-routed version when
 * versioned, else the legacy SKILL.md. No symlinks, no admin rights, identical on
 * Windows/macOS/Linux. Best-effort + atomic manifest writes.
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import {
  type SkillManifest, type ChampionDecision, type RouteOptions,
  initManifest, createNextVersion, routeSkillVersion, recordVersionExecution, decideChampion, versionFileName,
} from './skill-versioning.js';

function manifestPath(skillDir: string): string { return path.join(skillDir, 'manifest.json'); }

export async function readManifest(skillDir: string): Promise<SkillManifest | null> {
  try { return JSON.parse(await fs.readFile(manifestPath(skillDir), 'utf-8')) as SkillManifest; }
  catch { return null; }
}

async function writeManifest(skillDir: string, m: SkillManifest): Promise<void> {
  const tmp = manifestPath(skillDir) + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(m, null, 2), 'utf-8');
  await fs.rename(tmp, manifestPath(skillDir)); // atomic
}

/** The skill body to inject this turn + which version it is. Falls back to legacy SKILL.md.
 *  `opts` carries the configurable UCB knobs (exploration factor, min trials, weights). */
export async function routedSkillBody(skillDir: string, opts: RouteOptions = {}): Promise<{ version: string; body: string } | null> {
  const m = await readManifest(skillDir);
  if (m) {
    const version = routeSkillVersion(m, opts);
    try { return { version, body: await fs.readFile(path.join(skillDir, versionFileName(version)), 'utf-8') }; }
    catch { /* fall through to legacy */ }
  }
  try { return { version: 'legacy', body: await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf-8') }; }
  catch { return null; }
}

/** Turn a legacy single-file skill into a versioned one (v1), or no-op if already versioned. */
export async function ensureVersioned(skillDir: string, skillId: string, author: 'human' | 'machine', confidence = 50): Promise<SkillManifest> {
  const existing = await readManifest(skillDir);
  if (existing) return existing;
  const { manifest, fileName } = initManifest(skillId, author, confidence, new Date().toISOString());
  // Seed v1 from the existing SKILL.md if present.
  try {
    const legacy = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf-8');
    await fs.writeFile(path.join(skillDir, fileName), legacy, 'utf-8');
  } catch { /* no legacy body — caller will write the version file */ }
  await writeManifest(skillDir, manifest);
  return manifest;
}

/** Add a new CHALLENGER version (writes SKILL.v{N}.md + updates the manifest). */
export async function addChallenger(skillDir: string, skillId: string, body: string, author: 'human' | 'machine', confidence = 50): Promise<SkillManifest> {
  const base = (await readManifest(skillDir)) ?? (await ensureVersioned(skillDir, skillId, author, confidence));
  const { updatedManifest, nextVersionFileName } = createNextVersion(base, author, { confidence, nowIso: new Date().toISOString() });
  await fs.writeFile(path.join(skillDir, nextVersionFileName), body, 'utf-8');
  await writeManifest(skillDir, updatedManifest);
  return updatedManifest;
}

/** Record one execution outcome (success + tokens + duration) for the routed version, then
 *  try to converge the A/B test on the composite reward. */
export async function recordOutcomeAndConverge(
  skillDir: string,
  version: string,
  outcome: { success: boolean; tokens?: number; durationMs?: number },
  opts: { minExecutions?: number; margin?: number } = {},
): Promise<ChampionDecision | null> {
  const m = await readManifest(skillDir);
  if (!m) return null;
  const afterStats = recordVersionExecution(m, version, outcome);
  const decision = decideChampion(afterStats, opts);
  await writeManifest(skillDir, decision.manifest);
  return decision;
}
