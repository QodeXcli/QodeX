/**
 * Independent judge for candidate skills — PURE prompt builder + verdict parser.
 *
 * Mirrors critic.ts's separation: this module never calls a model. The curate driver
 * owns I/O and — crucially — must run this on a model DIFFERENT from the one that
 * authored the candidate (the loop enforces that via decidePromotion, which rejects a
 * verdict whose judgeModel equals the author model). The prompt is deliberately
 * ADVERSARIAL: the judge is told to look for reasons to REJECT (redundant, overfit to
 * one task, wrong, or low-value), so a weak candidate doesn't sail through on politeness.
 */
import { tryParseJson } from '../../llm/constrained.js';
import type { JudgeVerdict } from './types.js';

export function buildJudgePrompt(candidateMd: string, existingSkillNames: string[] = []): { system: string; user: string } {
  const system =
    'You are an independent reviewer deciding whether to ADD a machine-captured "skill" ' +
    '(a reusable playbook) to a shared library. Your default is to REJECT. Approve ONLY if ' +
    'the skill is genuinely reusable across future tasks, correct, specific enough to be ' +
    'useful, and NOT redundant with an existing skill. Reject if it is: a one-off with no ' +
    'reuse value, vague/generic, likely wrong, or duplicates something already present. ' +
    'You did NOT write this; have no loyalty to it.\n\n' +
    'Respond with STRICT JSON only, no prose:\n' +
    '{"pass": boolean, "reasons": ["..."]}\n' +
    'Give concrete reasons either way.';

  const existing = existingSkillNames.length
    ? `\n\n## Skills already in the library (reject if this duplicates one)\n${existingSkillNames.map(n => `- ${n}`).join('\n')}`
    : '';

  const user =
    `## Candidate skill under review\n\`\`\`\n${candidateMd.slice(0, 8000)}\n\`\`\`` +
    existing +
    `\n\nDecide. Return the strict-JSON verdict now.`;

  return { system, user };
}

/**
 * Parse the judge's response. `judgeModel` is stamped onto the verdict so the promotion
 * step can verify independence (judgeModel !== authorModel). Fails CLOSED: an unparseable
 * verdict is a REJECT — unlike the critic (which fails open to avoid blocking shipping),
 * a skill we can't confirm is good must NOT enter the library.
 */
/**
 * Build the MERGE prompt for two near-duplicate machine skills. The independent judge
 * decides whether they should be one skill and, if so, returns a single comprehensive
 * SKILL.md that subsumes both. Asked to keep frontmatter `provenance: machine` and
 * `status: candidate` so the merged result re-enters the same quarantine → independent
 * promotion pipeline (a merge never auto-activates).
 */
export function buildMergePrompt(a: { name: string; md: string }, b: { name: string; md: string }): { system: string; user: string } {
  const system =
    'You are an independent curator merging two machine-captured skills that look like ' +
    'near-duplicates. If they are genuinely the same capability, produce ONE comprehensive ' +
    'SKILL.md that covers both cases — broader "When to use", a superset of tools, the ' +
    'clearer instructions. If they are actually DISTINCT and should stay separate, do not ' +
    'force a merge.\n\n' +
    'Respond with STRICT JSON only:\n' +
    '{"merge": boolean, "name": "kebab-id", "skillMd": "<full SKILL.md if merge=true, else empty>"}\n' +
    'The skillMd MUST keep frontmatter `provenance: machine` and `status: candidate`.';
  const user =
    `## Skill A: ${a.name}\n\`\`\`\n${a.md.slice(0, 6000)}\n\`\`\`\n\n` +
    `## Skill B: ${b.name}\n\`\`\`\n${b.md.slice(0, 6000)}\n\`\`\`\n\n` +
    `Decide and return the strict-JSON now.`;
  return { system, user };
}

export interface MergeResult { merge: boolean; name: string; skillMd: string }

/** Parse the merge judge's response. Fails CLOSED: anything unparseable ⇒ no merge. */
export function parseMergeResult(text: string): MergeResult {
  const parsed = tryParseJson(text) as any;
  if (parsed && typeof parsed === 'object' && parsed.merge === true
      && typeof parsed.name === 'string' && /^[a-z][a-z0-9-]*$/.test(parsed.name)
      && typeof parsed.skillMd === 'string' && parsed.skillMd.includes('provenance: machine')) {
    return { merge: true, name: parsed.name, skillMd: parsed.skillMd };
  }
  return { merge: false, name: '', skillMd: '' };
}

export function parseJudgeVerdict(text: string, judgeModel: string): JudgeVerdict {
  const parsed = tryParseJson(text) as any;
  if (parsed && typeof parsed === 'object' && typeof parsed.pass === 'boolean') {
    const reasons = Array.isArray(parsed.reasons) ? parsed.reasons.filter((r: any) => typeof r === 'string') : [];
    return { pass: parsed.pass, judgeModel, reasons };
  }
  return { pass: false, judgeModel, reasons: [`unparseable judge response: ${(text ?? '').slice(0, 200)}`] };
}
