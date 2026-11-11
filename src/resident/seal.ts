/**
 * Seal — promote a candidate only when its witness patch replays clean.
 * No model is loaded. An independent judge is not consulted here; `qodex skill
 * curate` remains the path that asks a second model. A human-authored skill is
 * still immutable, because decidePromotion is the same gate.
 *
 * A failed patch is remembered by content hash. The resident must not spin a
 * git worktree every minute for a skill that already failed.
 */
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import type { ProvenanceLike } from '../skills/provenance.js';
import { decidePromotion } from '../skills/learning/promotion.js';
import type { WitnessVerdict } from '../skills/learning/witness.js';
import { sealCachePath } from './paths.js';

export function sealContentHash(md: string): string {
  return createHash('sha256').update(md).digest('hex').slice(0, 16);
}

export interface SealCacheEntry {
  hash: string;
  pass: boolean;
  at: string;
}
export type SealCache = Record<string, SealCacheEntry>;

export interface SealResult {
  promoted: string[];
  rejected: Array<{ name: string; reason: string }>;
  skipped: Array<{ name: string; reason: string }>;
  snapshot: string | null;
}

export interface SealDeps {
  list: () => Promise<Array<{ name: string }>>;
  read: (name: string) => Promise<string | null>;
  replay: (cwd: string, md: string) => Promise<WitnessVerdict>;
  active: (name: string, cwd: string) => Promise<ProvenanceLike | null>;
  promote: (name: string, cwd: string) => Promise<{ promoted: boolean; reason: string }>;
  snapshot: (stamp: string) => Promise<string | null>;
  record: (ev: { event: 'promote' | 'reject'; name: string; judge?: string }) => Promise<void>;
  loadCache: () => Promise<SealCache>;
  saveCache: (cache: SealCache) => Promise<void>;
}

async function defaultDeps(): Promise<SealDeps> {
  const store = await import('../skills/learning/candidate-store.js');
  const { replayWitness } = await import('../skills/learning/witness.js');
  const { loadSkillByName } = await import('../skills/loader.js');
  const { snapshotSkills } = await import('../skills/learning/snapshot.js');
  const { recordLearningEvent } = await import('../skills/learning/ledger.js');
  return {
    list: () => store.listCandidates(),
    read: name => store.readCandidate(name),
    replay: (cwd, md) => replayWitness(cwd, md),
    active: async (name, cwd) => {
      const spec = await loadSkillByName(name, cwd);
      return spec ? { provenance: spec.provenance, humanEdited: spec.humanEdited } : null;
    },
    promote: (name, cwd) => store.promoteCandidate(name, cwd),
    snapshot: async stamp => {
      try { return await snapshotSkills(stamp); } catch { return null; }
    },
    record: ev => recordLearningEvent(ev),
    loadCache: async () => {
      try { return JSON.parse(await fs.readFile(sealCachePath(), 'utf-8')) as SealCache; }
      catch { return {}; }
    },
    saveCache: async cache => {
      await fs.mkdir(path.dirname(sealCachePath()), { recursive: true });
      await fs.writeFile(sealCachePath(), JSON.stringify(cache, null, 2));
    },
  };
}

export async function sealCandidates(cwd: string, overrides: Partial<SealDeps> = {}): Promise<SealResult> {
  const keys: (keyof SealDeps)[] = ['list', 'read', 'replay', 'active', 'promote', 'snapshot', 'record', 'loadCache', 'saveCache'];
  const deps: SealDeps = keys.every(k => overrides[k] != null)
    ? overrides as SealDeps
    : { ...(await defaultDeps()), ...overrides };
  const result: SealResult = { promoted: [], rejected: [], skipped: [], snapshot: null };
  const candidates = await deps.list();
  if (candidates.length === 0) return result;

  const cache = await deps.loadCache();
  let snapped = false;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  for (const c of candidates) {
    const md = await deps.read(c.name);
    if (!md) { result.skipped.push({ name: c.name, reason: 'unreadable' }); continue; }
    const hash = sealContentHash(md);
    const prev = cache[c.name];
    if (prev && prev.hash === hash && prev.pass === false) {
      result.skipped.push({ name: c.name, reason: 'this exact skill already failed witness or promotion — edit it to retry' });
      continue;
    }

    if (!snapped) {
      snapped = true;
      result.snapshot = await deps.snapshot(stamp);
    }
    const witness = await deps.replay(cwd, md);
    const activeSameName = await deps.active(c.name, cwd);
    const decision = decidePromotion({ authorModel: 'resident', verdict: null, activeSameName, witness });
    const at = new Date().toISOString();
    if (!decision.promote) {
      const soft = witness.replay === 'absent' || witness.replay === 'rejected';
      (soft ? result.skipped : result.rejected).push({ name: c.name, reason: decision.reason });
      if (!soft) {
        cache[c.name] = { hash, pass: false, at };
        await deps.record({ event: 'reject', name: c.name, judge: 'witness' });
      }
      continue;
    }
    const promo = await deps.promote(c.name, cwd);
    if (promo.promoted) {
      result.promoted.push(c.name);
      cache[c.name] = { hash, pass: true, at };
      await deps.record({ event: 'promote', name: c.name, judge: `witness:${witness.checker ?? 'verifier'}` });
    } else {
      result.rejected.push({ name: c.name, reason: promo.reason });
      cache[c.name] = { hash, pass: false, at };
      await deps.record({ event: 'reject', name: c.name, judge: 'witness' });
    }
  }

  await deps.saveCache(cache);
  return result;
}
