/**
 * LLM Critic / Verifier — test-time-compute self-review.
 *
 * The mechanical auto-verify gate (verification.ts) catches syntax and type
 * errors but is blind to *logic* bugs and *spec* mismatches: code that compiles
 * cleanly but does the wrong thing, ignores a project convention, or contradicts
 * a Trellis `.trellis/spec`. This module adds the missing reflection layer from
 * the spec: after the worker thinks it's done AND the code type-checks, a Critic
 * prompt reviews the actual diff with the explicit intent of finding defects,
 * and — if it finds blocking ones — sends the worker back to fix them
 * (backtracking), spending tokens at test-time to raise quality.
 *
 * Design (Separation of Concerns):
 *   - This module is PURE: it builds the critic prompt and parses the verdict.
 *     It does not call the model or touch disk — the agent loop owns I/O and
 *     decides which model runs the critique (a cheaper/faster role if configured,
 *     else the same model — "self-review").
 *   - The verdict is a small strict-JSON object so parsing is deterministic; we
 *     reuse the existing tolerant JSON parser for robustness against local-model
 *     formatting slips.
 *
 * Cost control: the loop runs the critic at most `maxCriticRounds` times per
 * task (default 1). Like the verify gate, a model that can't satisfy the critic
 * doesn't get to loop forever — after the budget is spent the work proceeds.
 */

import { tryParseJson } from '../llm/constrained.js';

export interface CriticFinding {
  severity: 'blocker' | 'warning';
  /** Where (file:line or symbol) — free-form, model-supplied. */
  location?: string;
  /** What's wrong. */
  issue: string;
}

export interface CriticVerdict {
  /** true when there are no blocking findings. */
  pass: boolean;
  findings: CriticFinding[];
  /** Raw text fallback when JSON parsing failed but we still want to show something. */
  raw?: string;
}

export interface DiffFile {
  path: string;
  /** The post-edit content (or a unified diff if that's what the caller has). */
  content: string;
}

/**
 * Build the critic system+user prompt. `specBlock` is the binding project
 * conventions (from Trellis/CLAUDE.md) so the critic can check adherence, not
 * just generic correctness.
 */
export function buildCriticPrompt(opts: {
  task: string;
  files: DiffFile[];
  specBlock?: string | null;
  maxBytesPerFile?: number;
}): { system: string; user: string } {
  const maxBytes = opts.maxBytesPerFile ?? 8_000;

  const system =
    'You are a Senior QA Engineer reviewing a teammate\'s code change with the ' +
    'explicit intent of finding defects BEFORE it ships. Look for: logic bugs, ' +
    'off-by-one and boundary errors, unhandled error/null cases, race conditions, ' +
    'security issues, and — critically — any mismatch with the project conventions ' +
    'given below. Do NOT rewrite the code. Do NOT praise it. Report only real, ' +
    'specific defects you can point to.\n\n' +
    'Respond with STRICT JSON only, no prose, in exactly this shape:\n' +
    '{"pass": boolean, "findings": [{"severity": "blocker"|"warning", "location": "file:line", "issue": "..."}]}\n' +
    'Set "pass": true with an empty findings array if the change is correct. ' +
    'Use "blocker" only for defects that would cause wrong behavior or break ' +
    'conventions; use "warning" for style/minor concerns.';

  const specSection = opts.specBlock
    ? `\n\n## Project conventions (adherence is required)\n${opts.specBlock}`
    : '';

  const fileSections = opts.files.map(f => {
    const body = f.content.length > maxBytes
      ? f.content.slice(0, maxBytes) + '\n… (truncated for review)'
      : f.content;
    return `### ${f.path}\n\`\`\`\n${body}\n\`\`\``;
  }).join('\n\n');

  const user =
    `## Task the change was supposed to accomplish\n${opts.task}` +
    specSection +
    `\n\n## Changed files to review\n${fileSections}\n\n` +
    `Review the above. Return the strict-JSON verdict now.`;

  return { system, user };
}

/** Parse the critic's response into a verdict. Tolerant of fenced/loose JSON. */
export function parseCriticVerdict(text: string): CriticVerdict {
  const parsed = tryParseJson(text) as any;
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.findings)) {
    const findings: CriticFinding[] = parsed.findings
      .filter((f: any) => f && typeof f.issue === 'string')
      .map((f: any) => ({
        severity: f.severity === 'blocker' ? 'blocker' : 'warning',
        location: typeof f.location === 'string' ? f.location : undefined,
        issue: f.issue,
      }));
    const hasBlocker = findings.some(f => f.severity === 'blocker');
    // Honor an explicit pass:false even if the model forgot to mark a blocker.
    const pass = parsed.pass === false ? false : !hasBlocker;
    return { pass, findings };
  }
  // Couldn't parse — fail OPEN (don't block shipping on a critic we can't read),
  // but surface the raw text so the loop can log it.
  return { pass: true, findings: [], raw: (text ?? '').slice(0, 500) };
}

/** Build the corrective message sent back to the worker when the critic blocks. */
export function buildCriticRepairMessage(verdict: CriticVerdict): string {
  // Prefer blockers, but if the critic set pass:false while marking only warnings, fall
  // back to ALL findings — otherwise the worker gets an empty list and no idea what to fix.
  const blockers = verdict.findings.filter(f => f.severity === 'blocker');
  const shown = blockers.length > 0 ? blockers : verdict.findings;
  const lines = shown.map(f => `  - ${f.location ? `[${f.location}] ` : ''}${f.issue}`);
  return (
    '[QA REVIEW] A senior-QA review of your change found defect(s) to fix:\n' +
    lines.join('\n') +
    '\n\nFix these specific issues by editing the files (use your edit tools). ' +
    'Do not apologize or explain — just make the corrections, then continue.'
  );
}
