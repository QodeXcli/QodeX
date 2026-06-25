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
export function parseJudgeVerdict(text: string, judgeModel: string): JudgeVerdict {
  const parsed = tryParseJson(text) as any;
  if (parsed && typeof parsed === 'object' && typeof parsed.pass === 'boolean') {
    const reasons = Array.isArray(parsed.reasons) ? parsed.reasons.filter((r: any) => typeof r === 'string') : [];
    return { pass: parsed.pass, judgeModel, reasons };
  }
  return { pass: false, judgeModel, reasons: [`unparseable judge response: ${(text ?? '').slice(0, 200)}`] };
}
