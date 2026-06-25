/**
 * Provenance & protection — the structural defense against the "self-congratulation"
 * failure mode of an in-agent learning loop.
 *
 * The danger (observed in Hermes-style systems): the agent grades its own work as a
 * success, captures a skill, and on a later pass OVERWRITES a carefully hand-tuned
 * skill with a lower-quality machine-generated one. We make that impossible by rule,
 * not by judgement:
 *
 *   A skill authored or installed by a human (`provenance: 'user'`, or any skill that
 *   a human has since edited) is IMMUTABLE to the machine. The capture/curator loop
 *   may only ever ADD a sibling candidate; it can never replace a protected skill.
 *
 * These are pure predicates so the guarantee is unit-testable and lives in exactly
 * one place. Both the installer (machine path) and the promotion step consult them.
 */
import type { SkillSpec } from './types.js';

/** The provenance/protection fields, as either a full SkillSpec or a bare metadata object. */
export interface ProvenanceLike {
  provenance?: 'user' | 'machine';
  humanEdited?: boolean;
}

/**
 * Is this skill protected from machine overwrite? True when a human authored it
 * (provenance 'user' or absent) OR a human has since edited a captured one.
 * Conservative by design: anything NOT explicitly a pristine machine capture is
 * protected, so an unknown/legacy skill is never clobbered.
 */
export function isProtected(skill: ProvenanceLike | undefined | null): boolean {
  if (!skill) return false;            // nothing there to protect
  if (skill.humanEdited) return true;  // a human touched a captured skill → now protected
  return (skill.provenance ?? 'user') !== 'machine';
}

/** A pristine, machine-captured skill the loop is free to replace/curate. */
export function isMachineOwned(skill: ProvenanceLike | undefined | null): boolean {
  return !!skill && !isProtected(skill);
}

export interface OverwriteDecision {
  allowed: boolean;
  reason: string;
}

/**
 * May the MACHINE (capture/curator) write a skill named `name`, given whatever skill
 * currently occupies that name? The single chokepoint every automated write goes through.
 *
 * - No existing skill            → allowed (fresh capture).
 * - Existing but machine-owned   → allowed (curating its own prior capture).
 * - Existing and human-protected → DENIED. The loop must keep its version as a
 *   candidate instead; the human's skill stands.
 *
 * NOTE: this governs the MACHINE path only. An explicit human `qodex skill install
 * --force` is a human action and is intentionally not gated here.
 */
export function canMachineWrite(name: string, existing: ProvenanceLike | undefined | null): OverwriteDecision {
  if (!existing) return { allowed: true, reason: 'no existing skill' };
  if (isProtected(existing)) {
    return { allowed: false, reason: `"${name}" is human-authored/edited (provenance protected) — machine overwrite refused` };
  }
  return { allowed: true, reason: `"${name}" is a prior machine capture — may be curated` };
}
