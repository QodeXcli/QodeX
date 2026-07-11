/**
 * Candidate store — the quarantine for machine-captured skills.
 *
 * Candidates live OUTSIDE the two dirs `loadSkills()` scans (~/.qodex/skills and
 * <cwd>/.qodex/skills), so they are invisible to the model until promoted. Promotion
 * physically moves the candidate into the active user-skills dir, but only after
 * `decidePromotion` (independent judge + human-protection) has approved it AND a final
 * `canMachineWrite` check confirms no protected skill occupies the name. Two guards,
 * because overwriting a human's skill is the failure we most want to prevent.
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../../utils/logger.js';
import { loadSkillByName, userSkillsDir } from '../loader.js';
import { canMachineWrite } from '../provenance.js';
import type { CandidateSkill } from './types.js';

export function candidatesDir(): string {
  return path.join(os.homedir(), '.qodex', 'skills-candidates');
}

export interface CandidateInfo {
  name: string;
  description: string;
  dir: string;
  capturedAt?: string;
  confidence?: number;
  /** Distilled DRAFTS (flywheel phase 1) also carry a step-outline + evidence count. */
  steps?: number;
  evidence?: number;
}

/** Write (or replace) a candidate. Candidates are always machine-owned, so replacing a
 *  prior candidate of the same name is fine — they never collide with active skills. */
export async function writeCandidate(c: CandidateSkill): Promise<string> {
  const dir = path.join(candidatesDir(), c.name);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  await fs.writeFile(file, c.skillMd, 'utf-8');
  logger.info('Skill candidate captured (quarantined)', { name: c.name, dir });
  return file;
}

export async function listCandidates(): Promise<CandidateInfo[]> {
  let entries;
  try {
    entries = await fs.readdir(candidatesDir(), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: CandidateInfo[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(candidatesDir(), ent.name);
    try {
      const raw = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf-8');
      const desc = raw.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? '';
      const at = raw.match(/^captured-at:\s*(.+)$/m)?.[1]?.trim();
      const conf = raw.match(/^confidence:\s*(\d+)/m)?.[1];
      const steps = raw.match(/^steps:\s*(\d+)/m)?.[1];
      const evidence = raw.match(/^evidence:\s*(\d+)/m)?.[1];
      out.push({ name: ent.name, description: desc, dir, capturedAt: at, confidence: conf ? Number(conf) : undefined, steps: steps ? Number(steps) : undefined, evidence: evidence ? Number(evidence) : undefined });
    } catch { /* skip unreadable */ }
  }
  return out;
}

export async function readCandidate(name: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(candidatesDir(), name, 'SKILL.md'), 'utf-8');
  } catch {
    return null;
  }
}

export interface PromoteResult {
  promoted: boolean;
  reason: string;
  dest?: string;
}

/**
 * Physically promote a candidate into the active user-skills dir. This is the LAST line
 * of defense and re-checks provenance independently of `decidePromotion` (defense in
 * depth): if an active skill of the same name is human-protected, it refuses — even if a
 * caller somehow approved it. On promotion, the candidate's frontmatter is flipped to
 * `status: active`.
 */
export async function promoteCandidate(name: string, cwd: string): Promise<PromoteResult> {
  const raw = await readCandidate(name);
  if (!raw) return { promoted: false, reason: `no candidate named "${name}"` };

  const existing = await loadSkillByName(name, cwd);
  const guard = canMachineWrite(name, existing);
  if (!guard.allowed) return { promoted: false, reason: guard.reason };

  const destDir = path.join(userSkillsDir(), name);
  await fs.mkdir(destDir, { recursive: true });
  const activated = raw.replace(/^status:\s*candidate\s*$/m, 'status: active');
  await fs.writeFile(path.join(destDir, 'SKILL.md'), activated, 'utf-8');
  await fs.rm(path.join(candidatesDir(), name), { recursive: true, force: true });
  logger.info('Skill candidate promoted to active', { name, dest: destDir });
  return { promoted: true, reason: guard.reason, dest: destDir };
}

/** Discard a candidate (judge rejected it, or it's stale). */
export async function archiveCandidate(name: string): Promise<boolean> {
  try {
    await fs.rm(path.join(candidatesDir(), name), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
