/**
 * Skill distillation — flywheel phase 1 (distill → draft → approve).
 *
 * Turns a finished, objectively-successful session into a reviewable DRAFT skill that is
 * richer than the minimal capture: a trigger description, a collapsed step outline built
 * from the ordered tool sequence, and concrete evidence (files changed + tools used).
 *
 * PURE — deterministic templating over signals the loop already has (prompt, changed
 * files, tool sequence, final summary). No LLM call: the draft must be reproducible and
 * auditable, and an LLM narrating its own success would re-open the self-congratulation
 * hole `capture.ts` exists to close. Drafts land in the same quarantined candidate store
 * (`provenance: machine`, `status: candidate`) and await the existing promote/reject
 * review flow — nothing here auto-promotes.
 *
 * Follow-up (phase 2): `evalCandidate` below is an honest stub — eval-gated promotion
 * (replay the draft in a clean worktree, score it, gate `skill.promote` on the score)
 * lands there. See ~/.qodex plans / the dashboard promotion UI, which displays the note.
 */
import { skillIdFromPrompt } from './capture.js';
import type { CandidateSkill } from './types.js';

/** The session signals distillation needs — same family `captureEligible` already sees,
 *  plus the ORDERED tool sequence (not just distinct names) so steps keep their shape. */
export interface SessionDigest {
  prompt: string;
  finalSummary: string;
  /** Tool names in execution order (consecutive repeats expected — they get collapsed). */
  toolSequence: string[];
  filesChanged: string[];
}

export interface DistillPolicy {
  /** Minimum COLLAPSED steps for a session to be worth a step outline (default 3).
   *  Below this there is no procedure to teach — skip and let the minimal capture run. */
  minSteps: number;
  /** Cap on outlined steps; longer sequences get truncated with an explicit marker. */
  maxSteps: number;
}

export const DEFAULT_DISTILL_POLICY: DistillPolicy = { minSteps: 3, maxSteps: 12 };

/** One collapsed step: a run of consecutive calls to the same tool. */
export interface DraftStep {
  tool: string;
  count: number;
}

/** A distilled draft skill. Structurally a `CandidateSkill` (so it round-trips through
 *  the existing candidate store untouched) plus the structured fields the dashboard and
 *  the phase-2 eval need without re-parsing markdown. */
export interface DraftSkill extends CandidateSkill {
  trigger: string;
  steps: DraftStep[];
  evidence: { files: string[]; tools: string[] };
}

/** Collapse consecutive runs of the same tool into ordered steps.
 *  ['glob','read_file','read_file','shell'] → [glob×1, read_file×2, shell×1]. */
export function collapseToolSequence(seq: string[]): DraftStep[] {
  const steps: DraftStep[] = [];
  for (const tool of seq) {
    const last = steps[steps.length - 1];
    if (last && last.tool === tool) last.count++;
    else steps.push({ tool, count: 1 });
  }
  return steps;
}

/** Human phrasing for the common builtin tools; unknown tools fall back to their name. */
const STEP_HINTS: Record<string, string> = {
  ls: 'List directory contents to orient',
  glob: 'Locate files by pattern',
  grep: 'Search the codebase for the relevant symbols',
  semantic_search: 'Search the codebase semantically',
  read_file: 'Read the relevant source files',
  write_file: 'Create the new files',
  edit_text: 'Edit existing code in place',
  multi_edit: 'Apply multiple edits to one file',
  multi_file_edit: 'Apply coordinated edits across files',
  shell: 'Run commands (build / test / inspect)',
};

function stepLine(s: DraftStep, i: number): string {
  const hint = STEP_HINTS[s.tool] ?? `Use \`${s.tool}\``;
  const times = s.count > 1 ? ` (\`${s.tool}\` ×${s.count})` : ` (\`${s.tool}\`)`;
  return `${i + 1}. ${hint}${times}`;
}

function yamlList(items: string[]): string {
  return items.length ? '\n' + items.map(i => `  - ${i}`).join('\n') : ' []';
}

/** One-line trigger: when should a future session reach for this skill? Derived from the
 *  first line of the prompt — the request IS the trigger for a captured procedure. */
export function triggerFromPrompt(prompt: string): string {
  const firstLine = prompt.trim().split('\n')[0]!.replace(/\s+/g, ' ').trim();
  const clipped = firstLine.length > 140 ? firstLine.slice(0, 137) + '…' : firstLine;
  return `Use when the task resembles: ${clipped || '(no prompt recorded)'}`;
}

/**
 * Distill a finished successful session into a DRAFT skill, or return null when the
 * session is too thin to outline (the caller falls back to the minimal capture).
 * Deterministic: same digest in, same draft out.
 */
export function distillDraft(
  digest: SessionDigest,
  opts: { nowIso: string; confidence?: number; policy?: Partial<DistillPolicy> } = { nowIso: '' },
): DraftSkill | null {
  const policy: DistillPolicy = { ...DEFAULT_DISTILL_POLICY, ...opts.policy };
  const allSteps = collapseToolSequence(digest.toolSequence);
  // Triviality gate — mirrors captureEligible's spirit but on the DISTILLED shape:
  // a one-or-two-move session has no step outline worth reviewing, and a session that
  // changed no files has no evidence to anchor the draft.
  if (allSteps.length < policy.minSteps) return null;
  if (digest.filesChanged.length === 0) return null;

  const truncated = allSteps.length > policy.maxSteps;
  const steps = truncated ? allSteps.slice(0, policy.maxSteps) : allSteps;
  const name = skillIdFromPrompt(digest.prompt);
  const trigger = triggerFromPrompt(digest.prompt);
  const description = (digest.finalSummary || digest.prompt).replace(/\s+/g, ' ').trim().slice(0, 120) || 'Distilled procedure';
  const tools = [...new Set(digest.toolSequence)].sort();
  const evidence = { files: [...digest.filesChanged], tools };
  const confidenceLine = typeof opts.confidence === 'number' ? `\nconfidence: ${opts.confidence}` : '';

  const skillMd = `---
name: ${name}
description: ${description}
provenance: machine
status: candidate
draft: flywheel-v1
steps: ${steps.length}
evidence: ${evidence.files.length + evidence.tools.length}${confidenceLine}
allowed-tools:${yamlList(tools)}
captured-at: ${opts.nowIso}
---

# ${name}

> Draft skill distilled from a successfully-verified session (flywheel phase 1).
> **Candidate** — quarantined until promoted via the dashboard or \`qodex skill promote\`.
> Review the step outline below; a human edit protects it from later overwrites.

## When to use
${trigger}

## Original request
${digest.prompt.trim()}

## Step outline
${steps.map(stepLine).join('\n')}${truncated ? `\n${policy.maxSteps + 1}. … plus ${allSteps.length - policy.maxSteps} more steps (sequence truncated)` : ''}

## Approach that worked
${digest.finalSummary.trim() || '(summary unavailable)'}

## Evidence

Files changed:
${evidence.files.map(f => `- ${f}`).join('\n')}

Tools used:
${evidence.tools.map(t => `- \`${t}\``).join('\n')}
`;

  return { name, description, skillMd, trigger, steps, evidence };
}

/** Phase-2 stub: eval-gated promotion. Honest — no fake score, just the labeled note the
 *  promotion UI can show next to a draft. Phase 2 replaces this with a real replay-eval
 *  (see src/skills/learning/eval.ts, which already knows how to replay a SKILL.md). */
export function evalCandidate(_draft: DraftSkill): { score: null; note: string } {
  return { score: null, note: 'eval-gated promotion lands in phase 2' };
}
