/**
 * Skill capture — turn a successful task into a CANDIDATE skill.
 *
 * Pure logic (no I/O) so the two anti-self-congratulation guarantees are unit-tested:
 *   - `captureEligible` gates on OBJECTIVE signal only. The worker model's opinion of
 *     its own success is never an input. A task qualifies only if it was genuinely
 *     verified (clean types/tests), honest (completion-claim gate passed), and
 *     non-trivial (≥ minToolCalls). This is the single biggest departure from a
 *     self-grading loop.
 *   - `buildCandidateSkill` stamps `provenance: machine` and `status: candidate`, so
 *     the result is quarantined by construction — it cannot be loaded or overwrite a
 *     human skill until an independent judge promotes it.
 */
import type { CaptureSignal, TrajectorySlice, CandidateSkill } from './types.js';

export interface CapturePolicy {
  /** Minimum tool calls for a task to be worth capturing (default 5). */
  minToolCalls: number;
  /** Require objective verification to have run AND passed (default true). Turning this
   *  off re-introduces self-congratulation risk, so it's loud and opt-in. */
  requireObjectiveSuccess: boolean;
}

export const DEFAULT_CAPTURE_POLICY: CapturePolicy = {
  minToolCalls: 5,
  requireObjectiveSuccess: true,
};

export interface EligibilityResult {
  eligible: boolean;
  reason: string;
}

/**
 * Is this finished task eligible to become a candidate skill? OBJECTIVE gate only.
 * Returns a reason either way (logged, so a near-miss is visible).
 */
export function captureEligible(signal: CaptureSignal, policy: CapturePolicy = DEFAULT_CAPTURE_POLICY): EligibilityResult {
  if (signal.toolCalls < policy.minToolCalls) {
    return { eligible: false, reason: `only ${signal.toolCalls} tool calls (< ${policy.minToolCalls}) — too trivial to be a reusable skill` };
  }
  if (policy.requireObjectiveSuccess) {
    if (!signal.verifyClean) return { eligible: false, reason: 'objective verification did not pass (new errors in touched files) — not a success worth learning' };
    if (!signal.completionHonest) return { eligible: false, reason: 'completion-claim gate did not pass (claims not backed by evidence) — refusing to learn a self-reported success' };
  }
  return { eligible: true, reason: `objectively-verified task with ${signal.toolCalls} tool calls — eligible` };
}

/** kebab-case id from the task prompt; bounded, ascii-safe, never empty. */
export function skillIdFromPrompt(prompt: string): string {
  const base = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')   // drop punctuation / non-ascii (Persian etc.)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .join('-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return base || 'captured-skill';
}

function yamlList(items: string[]): string {
  return items.length ? '\n' + items.map(i => `  - ${i}`).join('\n') : ' []';
}

/**
 * Build a candidate SKILL.md from a successful trajectory. PURE — string in, string out.
 * The body is a structured "playbook": what the task was, the approach that worked, the
 * tools it needed, and the files it touched. (An optional LLM "distill" pass can enrich
 * the body later; the frontmatter + structure here are deterministic and always valid.)
 */
export function buildCandidateSkill(traj: TrajectorySlice, opts: { name?: string; nowIso: string } = { nowIso: '' }): CandidateSkill {
  const name = (opts.name && /^[a-z][a-z0-9-]*$/.test(opts.name)) ? opts.name : skillIdFromPrompt(traj.prompt);
  const description = (traj.finalSummary || traj.prompt).replace(/\s+/g, ' ').trim().slice(0, 120) || 'Captured procedure';
  const tools = [...new Set(traj.toolsUsed)].sort();

  const skillMd = `---
name: ${name}
description: ${description}
provenance: machine
status: candidate
allowed-tools:${yamlList(tools)}
captured-at: ${opts.nowIso}
---

# ${name}

> Auto-captured from a successfully-verified task. **Candidate** — not active until an
> independent judge promotes it. Review and edit freely; a human edit protects it from
> being overwritten by a later capture.

## When to use
${description}

## Original request
${traj.prompt.trim()}

## Approach that worked
${traj.finalSummary.trim() || '(summary unavailable)'}

## Tools this procedure used
${tools.length ? tools.map(t => `- \`${t}\``).join('\n') : '- (none recorded)'}

## Files touched (reference)
${traj.filesChanged.length ? traj.filesChanged.map(f => `- ${f}`).join('\n') : '- (none recorded)'}
`;

  return { name, description, skillMd };
}
